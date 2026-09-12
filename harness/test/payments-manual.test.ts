// The human channel: a founder telling us money arrived, and us asking them when we cannot tell.
//
// The founder's brief was that most of his customers are NOT paid through Stripe — they are paid by
// bank transfer or in cash, and then somebody flags the invoice. So this is the majority path, and
// the bugs it can have are the expensive kind: money counted twice, an invoice settled off a part
// payment, a chase sent to somebody who already paid, or a payment landing on another tenant's books.
//
// Every test below names the specific failure it prevents.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { _resetBilling, getBillingStore, invoiceTotals } from "../src/billing";
import { connectMailbox } from "./helpers";
import { resolveBrandKit } from "../src/brandkit";
import type { Invoice } from "../src/contract";
import { setChaseDeps, startChase, sweepOverdueInvoices } from "../src/dunning";
import { scene } from "../src/render";
import {
  answerPaymentQuestion,
  askPaymentQuestion,
  getPaymentQuestion,
  getPaymentInstructions,
  instantForDate,
  isCalendarDate,
  listPaymentQuestions,
  normalizeInstructions,
  paymentQuestionGate,
  QUESTION_GRACE_HOURS,
  receiptOffer,
  recordManualPayment,
  setPaymentInstructions,
  setReceiptDeps,
  startReceipt,
} from "../src/payments.manual";

const PROJECT = "proj-ours";
const OTHER = "proj-theirs";
const KIT = resolveBrandKit(undefined, "Hartley Bookkeeping");

/** £4,000 owed, issued, due 2026-03-01. Minor units throughout — nothing here divides. */
async function invoice(o: Partial<Invoice> = {}): Promise<Invoice> {
  return getBillingStore().createInvoice({
    project_id: PROJECT,
    client_id: "cli-1",
    currency: "GBP",
    status: "sent",
    lines: [{ id: "l1", description: "March retainer", kind: "fixed", quantity_milli: 1000, unit_amount: 400_000 }],
    issue_date: "2026-02-01",
    due_date: "2026-03-01",
    ...o,
  } as any);
}

/** The minimum wiring `recordManualPayment` needs: something that can be asked for in-flight chases. */
/**
 * `startChase` now refuses before it claims anything when the project has no mailbox — a business
 * that cannot send a reminder must not spawn a run that drafts one, report success, and burn the
 * invoice's ladder claim. See promises.ts for the production run that argument comes from. So every
 * scene in this file that expects a chase to START has to be a business that could actually send it.
 * Fire-and-forget: the connection only has to exist by the time a chase is attempted.
 */
async function wireChases(open: string[] = []): Promise<{ spawned: any[]; document: any[] }> {
  const spawned: any[] = [];
  const document: any[] = [];
  await connectMailbox(PROJECT);
  setChaseDeps({
    wedgeEnabled: () => true,
    spawnTask: async (a) => {
      spawned.push(a);
      return `task-${spawned.length}`;
    },
    attachInvoiceDocument: async (a) => {
      document.push(a);
      return { artifact_id: "art-1" };
    },
    openChasesFor: async () => open,
  });
  return { spawned, document };
}

function wireReceipts(): { spawned: any[]; document: any[] } {
  const spawned: any[] = [];
  const document: any[] = [];
  setReceiptDeps({
    wedgeEnabled: () => true,
    spawnTask: async (a) => {
      spawned.push(a);
      return `receipt-task-${spawned.length}`;
    },
    attachInvoiceDocument: async (a) => {
      document.push(a);
      return { artifact_id: "art-r" };
    },
  });
  return { spawned, document };
}

const pay = (o: Record<string, unknown> = {}) => ({
  project_id: PROJECT,
  amount_minor: 400_000,
  method: "bank_transfer" as const,
  paid_on: "2026-03-04",
  entry_id: randomUUID(),
  recorded_by: "founder-1",
  now: new Date("2026-03-10T09:00:00Z"),
  ...o,
});

// ─────────────────────────── the five that must never regress ───────────────────────────

test("a manually recorded payment stands down a chase already queued for that invoice", async () => {
  // THE BUG: a chase is not an instant. The run is spawned, the model writes the words, and the send
  // then sits on the approval gate for however long it takes a founder to look at their phone. A
  // payment recorded inside that window used to settle the invoice and leave the dunning email to be
  // approved and sent afterwards — to the client who had just paid. This is the founder's question in
  // its most embarrassing form.
  _resetBilling();
  await wireChases(["task-in-flight", "task-on-the-gate"]);
  const inv = await invoice({ last_chased_at: "2026-03-08T09:00:00Z" });

  const out = await recordManualPayment({ ...pay(), invoice_id: inv.id });

  assert.equal(out.ok, true);
  assert.ok(out.ok);
  assert.equal(out.settled, true);
  assert.deepEqual(out.stood_down, ["task-in-flight", "task-on-the-gate"]);
  // And it is not merely reported — nothing is left claiming success while the email is still going.
  assert.equal(out.stand_down_warning, undefined);
});

test("a stand-down that could not run is reported, never reported as done", async () => {
  // THE BUG this repo keeps paying for: something failing while reporting success. An embedder with
  // no way to look up in-flight chases must not produce a payment response that implies it stopped
  // one. `standDownChases` returns a reason; this asserts the reason survives to the caller.
  _resetBilling();
  setChaseDeps({
    wedgeEnabled: () => true,
    spawnTask: async () => "t",
    attachInvoiceDocument: async () => ({}),
    // No `openChasesFor` at all — the degraded deployment.
  });
  const inv = await invoice();
  const out = await recordManualPayment({ ...pay(), invoice_id: inv.id });
  assert.ok(out.ok);
  assert.equal(out.settled, true);
  assert.deepEqual(out.stood_down, []);
  assert.match(String(out.stand_down_warning), /cannot look up in-flight chases/);
});

test("a back-dated payment is judged on its own date, not on the day it was keyed in", async () => {
  // THE BUG: somebody is handed cash on the 4th and gets round to recording it on the 10th. Stamping
  // `new Date()` makes the invoice claim it was paid on the 10th, which is wrong in the direction
  // that flatters us: it hides that our chase on the 8th went to a client who had already paid, and
  // it puts the revenue in the wrong week.
  _resetBilling();
  await wireChases();
  const inv = await invoice({ last_chased_at: "2026-03-08T09:00:00Z" });

  const out = await recordManualPayment({
    ...pay({ paid_on: "2026-03-04", now: new Date("2026-03-10T09:00:00Z") }),
    invoice_id: inv.id,
  });
  assert.ok(out.ok);

  // The invoice records when the money moved.
  assert.equal(out.invoice.paid_at, "2026-03-04T12:00:00.000Z");
  assert.notEqual(out.invoice.paid_at?.slice(0, 10), "2026-03-10");

  // The ledger row agrees with it.
  const ledger = await getBillingStore().listExternalPayments({ project_id: PROJECT, invoice_id: inv.id });
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].paid_at, "2026-03-04T12:00:00.000Z");

  // And the consequence a founder actually needs: we chased them four days AFTER their money arrived.
  assert.equal(out.chased_after_payment?.days_after, 3);
  assert.equal(out.chased_after_payment?.last_chased_at, "2026-03-08T09:00:00Z");
});

test("a payment recorded on the day of the last chase does not claim we chased them after paying", async () => {
  // The mirror of the test above: `chased_after_payment` must not fire on a chase that PRECEDED the
  // money. An accusation the founder cannot act on teaches them to ignore the field.
  _resetBilling();
  await wireChases();
  const inv = await invoice({ last_chased_at: "2026-03-02T09:00:00Z" });
  const out = await recordManualPayment({ ...pay({ paid_on: "2026-03-04" }), invoice_id: inv.id });
  assert.ok(out.ok);
  assert.equal(out.chased_after_payment, undefined);
});

test("a partial payment moves the balance and does NOT mark the invoice paid", async () => {
  // THE BUG: marking a part-paid invoice `paid` quietly writes off the remainder. It is the mirror
  // image of chasing a settled invoice, and it is worse, because nobody ever looks at a number under
  // a green badge. The invoice must stay owed and stay chaseable.
  _resetBilling();
  await wireChases();
  const inv = await invoice();

  const out = await recordManualPayment({ ...pay({ amount_minor: 100_000 }), invoice_id: inv.id });
  assert.ok(out.ok);
  assert.equal(out.settled, false);
  assert.equal(out.invoice.status, "sent");
  assert.equal(out.totals.amount_paid, 100_000);
  assert.equal(out.totals.amount_due, 300_000);
  // And no receipt is offered for a debt that is three quarters outstanding.
  assert.equal(out.receipt.available, false);
  assert.match(out.receipt.detail, /still part paid/);
});

test("recording the same payment twice does not count the money twice", async () => {
  // THE BUG: the old route was a raw `amount_paid = amount_paid + n` with no idempotency key, so a
  // founder on a flaky connection tapping "Record it" twice paid the invoice off twice. The invoice
  // went green either way and the overcount was invisible.
  _resetBilling();
  await wireChases();
  const inv = await invoice();
  const entry = randomUUID();

  const first = await recordManualPayment({ ...pay({ amount_minor: 100_000, entry_id: entry }), invoice_id: inv.id });
  const second = await recordManualPayment({ ...pay({ amount_minor: 100_000, entry_id: entry }), invoice_id: inv.id });

  assert.ok(first.ok && second.ok);
  assert.equal(first.applied, true);
  // A replay is a SUCCESS — the money is recorded, which is what the founder asked for — and it says
  // so rather than pretending it just added the amount again.
  assert.equal(second.applied, false);
  assert.equal(second.totals.amount_paid, 100_000);

  const fresh = await getBillingStore().getInvoice(inv.id);
  assert.equal(invoiceTotals(fresh!).amount_paid, 100_000);
  assert.equal((await getBillingStore().listExternalPayments({ project_id: PROJECT, invoice_id: inv.id })).length, 1);
});

test("two genuine instalments with different entry ids are both counted", async () => {
  // The other side of idempotency: the guard must key on the FORM SUBMISSION, not on the invoice. A
  // client paying a deposit and then the balance is two payments, and a guard that collapsed them
  // would lose half the money — which is the failure that makes people distrust the first guard.
  _resetBilling();
  await wireChases();
  const inv = await invoice();

  await recordManualPayment({ ...pay({ amount_minor: 150_000 }), invoice_id: inv.id });
  const out = await recordManualPayment({ ...pay({ amount_minor: 250_000, paid_on: "2026-03-06" }), invoice_id: inv.id });

  assert.ok(out.ok);
  assert.equal(out.totals.amount_paid, 400_000);
  assert.equal(out.settled, true);
  assert.equal((await getBillingStore().listExternalPayments({ project_id: PROJECT, invoice_id: inv.id })).length, 2);
});

test("a payment cannot be recorded against another tenant's invoice", async () => {
  // THE BUG this codebase has shipped twice: a scope checked one layer up, or defaulted. Recording
  // one tenant's payment onto another tenant's invoice both fabricates revenue for one business and
  // keeps chasing the client of another. A wrong project is indistinguishable from a missing invoice,
  // deliberately — a caller probing ids must not be able to tell them apart.
  _resetBilling();
  await wireChases();
  const ours = await invoice();

  const out = await recordManualPayment({ ...pay({ project_id: OTHER }), invoice_id: ours.id });
  assert.equal(out.ok, false);
  assert.ok(!out.ok);
  assert.equal(out.reason, "not_found");

  // Nothing moved, and nothing was written to the other tenant's ledger either.
  const fresh = await getBillingStore().getInvoice(ours.id);
  assert.equal(invoiceTotals(fresh!).amount_paid, 0);
  assert.equal((await getBillingStore().listExternalPayments({ project_id: OTHER, invoice_id: ours.id })).length, 0);
});

test("an empty project id throws rather than recording a payment against nothing", async () => {
  // Required, never defaulted, and it throws instead of silently scoping to whatever is around. The
  // failure mode of a defaulted tenant scope on a money write is the worst one in the product.
  _resetBilling();
  const inv = await invoice();
  await assert.rejects(() => recordManualPayment({ ...pay({ project_id: "" }), invoice_id: inv.id }), /scoped to a project/);
});

// ─────────────────────────────── the money edge cases ───────────────────────────────

test("an overpayment is applied and surfaced, never netted away", async () => {
  // A surplus is a credit the business owes back. Refusing it would leave the founder unable to
  // record money that is genuinely in their account; hiding it means nobody ever returns it, because
  // `amount_due` floors at zero and the surplus is invisible in every other number.
  _resetBilling();
  await wireChases();
  const inv = await invoice();
  const out = await recordManualPayment({ ...pay({ amount_minor: 450_000 }), invoice_id: inv.id });
  assert.ok(out.ok);
  assert.equal(out.settled, true);
  assert.equal(out.overpaid_by, 50_000);
  assert.equal(out.totals.amount_due, 0);
  assert.equal(out.totals.amount_paid, 450_000);
});

test("a refund is recorded as a negative payment and reopens the balance", async () => {
  // Modelled as a payment in the other direction so `amount_paid` corrects itself through the same
  // atomic add. A separate subtract path is a second place to get a sign wrong.
  _resetBilling();
  await wireChases();
  const inv = await invoice();
  await recordManualPayment({ ...pay(), invoice_id: inv.id });
  const out = await recordManualPayment({ ...pay({ amount_minor: -100_000, paid_on: "2026-03-09", method: "cash" }), invoice_id: inv.id });
  assert.ok(out.ok);
  assert.equal(out.totals.amount_paid, 300_000);
  assert.equal(out.totals.amount_due, 100_000);
  // `paid` is terminal by design: un-paying is a credit note, a different document with its own
  // audit trail, so the status is NOT walked back automatically.
  assert.equal(out.invoice.status, "paid");
});

test("the ledger row carries the invoice's currency, and there is no way to record another", async () => {
  // Currency is never converted. There is deliberately no `currency` field on the input: offering one
  // would create the single path `reconcileProject` refuses outright, applying 400000 minor units of
  // one currency to a debt in another with arithmetic that looks clean at every step.
  _resetBilling();
  await wireChases();
  const inv = await invoice({ currency: "JPY" });
  await recordManualPayment({ ...pay({ amount_minor: 400_000 }), invoice_id: inv.id });
  const [row] = await getBillingStore().listExternalPayments({ project_id: PROJECT, invoice_id: inv.id });
  assert.equal(row.currency, "JPY");
});

test("a fractional amount, a zero and a non-integer are refused rather than truncated", async () => {
  // Silently turning 12.50 into 12 minor units is worse than refusing: it produces a recorded payment
  // that differs from what the human said, and nothing downstream can tell.
  _resetBilling();
  await wireChases();
  const inv = await invoice();
  for (const amount of [1250.5, 0, Number.NaN, Number.POSITIVE_INFINITY]) {
    const out = await recordManualPayment({ ...pay({ amount_minor: amount }), invoice_id: inv.id });
    assert.ok(!out.ok, `${amount} should be refused`);
    assert.equal(out.reason, "not_an_amount");
  }
  assert.equal(invoiceTotals((await getBillingStore().getInvoice(inv.id))!).amount_paid, 0);
});

test("money cannot have arrived tomorrow", async () => {
  // The typo guard — a founder typing 2027 for 2026. Letting it through settles an invoice against a
  // payment that has not happened, which stops a chase that should continue.
  _resetBilling();
  await wireChases();
  const inv = await invoice();
  const out = await recordManualPayment({ ...pay({ paid_on: "2026-03-11", now: new Date("2026-03-10T09:00:00Z") }), invoice_id: inv.id });
  assert.ok(!out.ok);
  assert.equal(out.reason, "future_date");
});

test("a date that is not a real calendar date is refused", async () => {
  _resetBilling();
  await wireChases();
  const inv = await invoice();
  for (const d of ["2026-02-31", "not-a-date", "2026-3-4", ""]) {
    const out = await recordManualPayment({ ...pay({ paid_on: d }), invoice_id: inv.id });
    assert.ok(!out.ok, `${d} should be refused`);
    assert.equal(out.reason, "not_a_date");
  }
  assert.equal(isCalendarDate("2026-02-28"), true);
  assert.equal(isCalendarDate("2026-02-31"), false);
});

test("a date-only payment survives local-time rendering from UTC-11 to UTC+11", async () => {
  // Midnight UTC would render as the previous day everywhere west of Greenwich, so a founder in
  // Chicago recording Wednesday's cash would see an invoice claiming it was paid on Tuesday — the
  // whole of the Americas getting the wrong answer. Noon is the widest band available.
  assert.equal(instantForDate("2026-03-04"), "2026-03-04T12:00:00.000Z");
  for (let tz = -11; tz <= 11; tz++) {
    const shifted = new Date(Date.parse(instantForDate("2026-03-04")) + tz * 3_600_000);
    assert.equal(shifted.toISOString().slice(0, 10), "2026-03-04", `UTC${tz >= 0 ? "+" : ""}${tz}`);
  }
  // And the honest limit, pinned so nobody "fixes" the constant and quietly breaks the Americas
  // instead: no hour satisfies UTC-12 and UTC+14 at once, because the band is 26 hours and a day is
  // 24. Anything displaying a payment date must take the UTC date, which is exact for every viewer.
  assert.equal(instantForDate("2026-03-04").slice(0, 10), "2026-03-04");
});

test("an unrecognised method is refused rather than defaulted to `other`", async () => {
  // Defaulting would forge a fact: "the founder chose other" and "the caller sent nonsense" are
  // different, and the first one is what every count-by-method report would then believe.
  _resetBilling();
  await wireChases();
  const inv = await invoice();
  const out = await recordManualPayment({ ...pay({ method: "crypto" as any }), invoice_id: inv.id });
  assert.ok(!out.ok);
  assert.equal(out.reason, "unknown_method");
});

test("a payment with no entry id is refused, because a generated one is no guard at all", async () => {
  _resetBilling();
  await wireChases();
  const inv = await invoice();
  const out = await recordManualPayment({ ...pay({ entry_id: "" }), invoice_id: inv.id });
  assert.ok(!out.ok);
  assert.equal(out.reason, "no_entry_id");
});

test("a void invoice takes no payment and a draft takes no payment", async () => {
  _resetBilling();
  await wireChases();
  const voided = await invoice({ status: "void" });
  const draft = await invoice({ status: "draft" });
  const a = await recordManualPayment({ ...pay(), invoice_id: voided.id });
  const b = await recordManualPayment({ ...pay(), invoice_id: draft.id });
  assert.ok(!a.ok && a.reason === "void_invoice");
  // A draft is the business thinking out loud; the client has never seen it.
  assert.ok(!b.ok && b.reason === "draft_invoice");
});

test("the payment a human recorded appears in the audit trail, with who, how and what they quoted", async () => {
  // THE BUG: `recordPayment` moved `amount_paid` and wrote nothing anywhere. A client ringing to ask
  // "which payment did you apply to March?" got a number and no answer.
  _resetBilling();
  await wireChases();
  const inv = await invoice();
  await recordManualPayment({
    ...pay({ method: "cheque", reference: "  chq 004821  " }),
    invoice_id: inv.id,
  });
  const [row] = await getBillingStore().listExternalPayments({ project_id: PROJECT, invoice_id: inv.id });
  assert.equal(row.basis, "human");
  assert.equal(row.method, "cheque");
  assert.equal(row.reference, "chq 004821");
  assert.match(row.source, /recorded by hand \(founder-1\)/);
  assert.match(row.external_id, /^manual:/);
});

// ─────────────────────────── asking "was this paid?" ───────────────────────────

test("nothing is asked before the first reminder has even gone out", async () => {
  // Asking on every invoice that goes one day overdue is the nagging failure `MAX_NUDGES` exists to
  // avoid — a founder who dismisses ten of these stops reading the eleventh. The question is about
  // ESCALATION, and an invoice that has never been chased is not escalating.
  _resetBilling();
  await wireChases();
  const inv = await invoice();
  const gate = await paymentQuestionGate(inv, new Date("2026-03-10T09:00:00Z"));
  assert.equal(gate.blocked, false);
  assert.equal(await getPaymentQuestion(PROJECT, inv.id), undefined);
});

test("before escalating an invoice we cannot verify, the ladder asks the founder and holds", async () => {
  // THE POINT OF THE WHOLE MECHANISM. This business has no payment provider, so `amount_due > 0` is a
  // fact about our database and nothing else. Escalating to a firmer rung on that alone is how a
  // final notice reaches somebody who handed over cash three weeks ago.
  _resetBilling();
  await wireChases();
  const inv = await invoice({ last_chased_at: "2026-03-05T09:00:00Z" });
  const now = new Date("2026-03-10T09:00:00Z");

  const gate = await paymentQuestionGate(inv, now);
  assert.equal(gate.blocked, true);
  assert.match(gate.detail, /has already been paid/);

  const q = await getPaymentQuestion(PROJECT, inv.id);
  assert.equal(q?.invoice_number, inv.number);
  assert.equal(q?.amount_due_when_asked, 400_000);
  assert.equal(q?.currency, "GBP");
  assert.equal(q?.answer, undefined);

  // And the ladder itself refuses, with a code a UI can say something true about.
  const started = await startChase(inv, { pacing: "ladder", now });
  assert.equal(started.ok, false);
  assert.ok(!started.ok);
  assert.equal(started.reason, "awaiting_payment_answer");
});

test("asking twice does not restart the clock", async () => {
  // The grace window is measured from when we FIRST asked. A second sweep touching the row must not
  // quietly extend the suppression, or the ladder could be held indefinitely by its own retries.
  _resetBilling();
  await wireChases();
  const inv = await invoice({ last_chased_at: "2026-03-05T09:00:00Z" });
  const first = await askPaymentQuestion(inv, new Date("2026-03-10T09:00:00Z"));
  const second = await askPaymentQuestion(inv, new Date("2026-03-11T09:00:00Z"));
  assert.equal(second.asked_at, first.asked_at);
});

test("the hold expires, and the ladder escalates rather than silently stopping for ever", async () => {
  // A chaser that has quietly stopped chasing is the purest form of this repo's recurring bug:
  // failing while reporting success. A founder on holiday must not come back to a month of unchased
  // debt and a tidy list of questions nobody read. So the suppression is BOUNDED.
  _resetBilling();
  await wireChases();
  const inv = await invoice({ last_chased_at: "2026-03-05T09:00:00Z" });
  const askedAt = new Date("2026-03-10T09:00:00Z");
  await askPaymentQuestion(inv, askedAt);

  const justInside = new Date(askedAt.getTime() + (QUESTION_GRACE_HOURS - 1) * 3_600_000);
  assert.equal((await paymentQuestionGate(inv, justInside)).blocked, true);

  const past = new Date(askedAt.getTime() + (QUESTION_GRACE_HOURS + 1) * 3_600_000);
  const gate = await paymentQuestionGate(inv, past);
  assert.equal(gate.blocked, false);
  assert.equal(gate.unanswered_hours, QUESTION_GRACE_HOURS + 1);
  assert.match(gate.detail, /heard nothing, so the ladder is going ahead/);
});

test("the chase carries what the founder said, so the approver is not guessing either", async () => {
  // Two very different situations reach the agent: a person confirmed the debt, or we asked and heard
  // nothing. Without this they are indistinguishable from each other and from an invoice nobody ever
  // asked about, which would make the question decorative.
  _resetBilling();
  const { spawned } = await wireChases();
  const inv = await invoice({ last_chased_at: "2026-03-01T09:00:00Z" });
  await askPaymentQuestion(inv, new Date("2026-03-08T09:00:00Z"));
  await answerPaymentQuestion(PROJECT, inv.id, "not_paid", "founder-1", new Date("2026-03-09T09:00:00Z"));

  const started = await startChase(inv, { pacing: "ladder", now: new Date("2026-03-10T09:00:00Z") });
  assert.equal(started.ok, true);
  const input = spawned[0].input as any;
  assert.equal(input.payment_question.answer, "not_paid");
  assert.equal(input.payment_question.grace_hours, QUESTION_GRACE_HOURS);
});

test("a human clicking Chase is never held for an answer they are in the middle of giving", async () => {
  // Every override in dunning.ts makes the same judgement: a founder who navigated to this invoice
  // knows things the ladder does not. A button that silently declines is worse than a duplicate email.
  _resetBilling();
  await wireChases();
  const inv = await invoice({ last_chased_at: "2026-03-05T09:00:00Z" });
  const started = await startChase(inv, { pacing: "override", now: new Date("2026-03-10T09:00:00Z") });
  assert.equal(started.ok, true);
});

test("recording the payment answers the question, with no second click", async () => {
  // Making a founder record a payment and then separately dismiss a question about that same payment
  // is the double bookkeeping that trains people to ignore the question.
  _resetBilling();
  await wireChases();
  const inv = await invoice({ last_chased_at: "2026-03-05T09:00:00Z" });
  await askPaymentQuestion(inv, new Date("2026-03-10T09:00:00Z"));
  assert.equal((await getPaymentQuestion(PROJECT, inv.id))?.answer, undefined);

  await recordManualPayment({ ...pay(), invoice_id: inv.id });
  const q = await getPaymentQuestion(PROJECT, inv.id);
  assert.equal(q?.answer, "paid");
  assert.equal(q?.answered_by, "founder-1");
});

test("the first answer wins; a second click does not move the record", async () => {
  _resetBilling();
  await wireChases();
  const inv = await invoice({ last_chased_at: "2026-03-05T09:00:00Z" });
  await askPaymentQuestion(inv, new Date("2026-03-10T09:00:00Z"));
  const first = await answerPaymentQuestion(PROJECT, inv.id, "not_paid", "a", new Date("2026-03-10T10:00:00Z"));
  const second = await answerPaymentQuestion(PROJECT, inv.id, "paid", "b", new Date("2026-03-10T11:00:00Z"));
  assert.equal(second?.answer, "not_paid");
  assert.equal(second?.answered_at, first?.answered_at);
});

test("open questions are listed for the project that asked them, and no other", async () => {
  _resetBilling();
  await wireChases();
  const mine = await invoice({ last_chased_at: "2026-03-05T09:00:00Z" });
  const theirs = await invoice({ project_id: OTHER, last_chased_at: "2026-03-05T09:00:00Z" });
  await askPaymentQuestion(mine, new Date("2026-03-10T09:00:00Z"));
  await askPaymentQuestion(theirs, new Date("2026-03-10T09:00:00Z"));

  const open = await listPaymentQuestions(PROJECT, { open_only: true });
  assert.ok(open.some((q) => q.invoice_id === mine.id));
  assert.ok(!open.some((q) => q.invoice_id === theirs.id));

  await answerPaymentQuestion(PROJECT, mine.id, "not_paid", "founder-1");
  assert.ok(!(await listPaymentQuestions(PROJECT, { open_only: true })).some((q) => q.invoice_id === mine.id));
});

test("the sweep counts invoices it is holding separately from the ones it skipped", async () => {
  // An operator looking at a sweep that chased nothing needs to tell "there was nothing to chase"
  // from "questions are sitting unanswered on somebody's screen". Only the second has an action.
  _resetBilling();
  await wireChases();
  await invoice({ last_chased_at: "2026-02-20T09:00:00Z" });
  const summary = await sweepOverdueInvoices({ project_id: PROJECT, now: new Date("2026-03-10T09:00:00Z") });
  assert.equal(summary.awaiting_answer, 1);
  assert.equal(summary.chased, 0);
});

// ─────────────────────────────── the receipt ───────────────────────────────

test("a receipt is offered once the invoice settles, and is not sent by recording the payment", async () => {
  // "It is OFFERED, never automatic." A founder catching up on a month of cash receipts must not
  // silently mail thirty clients.
  _resetBilling();
  await wireChases();
  const { spawned } = wireReceipts();
  const inv = await invoice();

  const out = await recordManualPayment({ ...pay(), invoice_id: inv.id });
  assert.ok(out.ok);
  assert.equal(out.receipt.available, true);
  // Nothing was spawned. Recording money is bookkeeping; emailing a client is a separate act.
  assert.equal(spawned.length, 0);
});

test("accepting the offer spawns a run that renders the RECEIPT, not the invoice", async () => {
  _resetBilling();
  await wireChases();
  const { spawned, document } = wireReceipts();
  const inv = await invoice();
  await recordManualPayment({ ...pay({ method: "cash" }), invoice_id: inv.id });
  const fresh = (await getBillingStore().getInvoice(inv.id))!;

  const started = await startReceipt(fresh, { requested_by: "founder-1" });
  assert.equal(started.ok, true);
  assert.equal(spawned[0].task_type, "send_receipt");
  assert.equal(document[0].kind, "receipt");
  // The words are the agent's, but the facts are not: the method travels so it cannot invent one.
  assert.equal((spawned[0].input as any).payments[0].method, "cash");
});

test("no receipt is offered or sent for an invoice that is only part paid", async () => {
  // A receipt for a part payment makes a different claim. Issuing the settled one against a partly
  // paid invoice tells a client they owe nothing when they owe three quarters of it.
  _resetBilling();
  await wireChases();
  wireReceipts();
  const inv = await invoice();
  await recordManualPayment({ ...pay({ amount_minor: 100_000 }), invoice_id: inv.id });
  const fresh = (await getBillingStore().getInvoice(inv.id))!;

  assert.equal((await receiptOffer(fresh, invoiceTotals(fresh))).available, false);
  const started = await startReceipt(fresh);
  assert.ok(!started.ok);
  assert.equal(started.reason, "not_settled");
});

test("a business whose wedge is switched off is told so, not silently given no receipt", async () => {
  _resetBilling();
  await wireChases();
  setReceiptDeps({ wedgeEnabled: () => false, spawnTask: async () => "t", attachInvoiceDocument: async () => ({}) });
  const inv = await invoice();
  const out = await recordManualPayment({ ...pay(), invoice_id: inv.id });
  assert.ok(out.ok);
  assert.equal(out.receipt.available, false);
  assert.match(out.receipt.detail, /not enabled for this business/);
});

test("the receipt document shows what arrived, how, and that nothing is left owing", async () => {
  _resetBilling();
  await wireChases();
  const inv = await invoice();
  await recordManualPayment({ ...pay({ method: "bank_transfer", reference: "FT26030412" }), invoice_id: inv.id });
  const fresh = (await getBillingStore().getInvoice(inv.id))!;
  const payments = await getBillingStore().listExternalPayments({ project_id: PROJECT, invoice_id: inv.id });

  const text = scene("receipt", { invoice: fresh, payments }, KIT)
    .nodes.filter((n: any) => n.t === "text")
    .map((n: any) => n.text)
    .join("\n");

  assert.match(text, /RECEIPT/);
  assert.match(text, /PAID IN FULL/);
  assert.match(text, /Bank transfer/);
  assert.match(text, /FT26030412/);
  assert.match(text, /2026-03-04/);
  // The amount, formatted from integer minor units — nothing anywhere divides by 100.
  assert.match(text, /£4,000\.00/);
});

test("a receipt never carries payment instructions, because they invite a second payment", async () => {
  _resetBilling();
  await wireChases();
  await setPaymentInstructions(PROJECT, ["Sort code 04-00-04", "Account 12345678"]);
  const inv = await invoice();
  await recordManualPayment({ ...pay(), invoice_id: inv.id });
  const fresh = (await getBillingStore().getInvoice(inv.id))!;
  const payments = await getBillingStore().listExternalPayments({ project_id: PROJECT, invoice_id: inv.id });

  const text = scene("receipt", { invoice: fresh, payments }, KIT)
    .nodes.filter((n: any) => n.t === "text")
    .map((n: any) => n.text)
    .join("\n");
  assert.doesNotMatch(text, /HOW TO PAY/);
  assert.doesNotMatch(text, /12345678/);
});

// ─────────────────────────── how to pay: the non-Stripe answer ───────────────────────────

test("an invoice that is owed shows the bank details and the reference to quote", async () => {
  // THE GAP THIS CLOSES: for a business paid by bank transfer there was no URL to paste into
  // `payment_link_url`, so the PDF a client received contained no way to pay it at all — and the link
  // was not even rendered when there was one. The client goes hunting for an old email, pays late,
  // and gets chased for the delay we caused.
  const inv = await invoice({ status: "sent" });
  const text = scene(
    "invoice",
    { invoice: inv, payment_instructions: ["Hartley Ltd", "Sort code 04-00-04", "Account 12345678"], today: "2026-03-10" },
    KIT,
  )
    .nodes.filter((n: any) => n.t === "text")
    .map((n: any) => n.text)
    .join("\n");

  assert.match(text, /HOW TO PAY/);
  assert.match(text, /Sort code 04-00-04/);
  // The reference is the single field that decides whether the money can be matched automatically —
  // `match.ts` matches on reference first and refuses to guess.
  assert.match(text, new RegExp(`Please quote ${inv.number}`));
});

test("a settled invoice shows no payment details at all", async () => {
  // Payment details on a settled invoice are an invitation to pay twice, and a duplicate payment is a
  // refund conversation the business did not need to have.
  _resetBilling();
  await wireChases();
  const inv = await invoice();
  await recordManualPayment({ ...pay(), invoice_id: inv.id });
  const fresh = (await getBillingStore().getInvoice(inv.id))!;
  const text = scene("invoice", { invoice: fresh, payment_instructions: ["Sort code 04-00-04"], today: "2026-03-10" }, KIT)
    .nodes.filter((n: any) => n.t === "text")
    .map((n: any) => n.text)
    .join("\n");
  assert.doesNotMatch(text, /HOW TO PAY/);
});

test("a Stripe link and bank details are shown together, not one instead of the other", async () => {
  // A client who wants to pay by card and a finance department that only does transfers are both
  // looking at this page. Picking one for them is how the other gives up.
  const inv = await invoice({ payment_link_url: "https://pay.example/abc" });
  const text = scene("invoice", { invoice: inv, payment_instructions: ["Sort code 04-00-04"], today: "2026-03-10" }, KIT)
    .nodes.filter((n: any) => n.t === "text")
    .map((n: any) => n.text)
    .join("\n");
  assert.match(text, /Sort code 04-00-04/);
  assert.match(text, /pay\.example\/abc/);
});

test("payment instructions are stored per project and never leak to another", async () => {
  await setPaymentInstructions(PROJECT, ["Sort code 04-00-04"]);
  await setPaymentInstructions(OTHER, ["IBAN DE89 3704 0044 0532 0130 00"]);
  assert.deepEqual(await getPaymentInstructions(PROJECT), ["Sort code 04-00-04"]);
  assert.deepEqual(await getPaymentInstructions(OTHER), ["IBAN DE89 3704 0044 0532 0130 00"]);
  await assert.rejects(() => getPaymentInstructions(""), /scoped to a project/);
});

test("instructions are bounded and blank lines are dropped", async () => {
  // Six lines of 120 characters. A document has a fixed amount of room, and an unbounded field here
  // renders off the bottom of a page the client never sees.
  const many = normalizeInstructions(Array.from({ length: 20 }, (_, i) => `line ${i}`));
  assert.equal(many.length, 6);
  assert.deepEqual(normalizeInstructions(["  a  ", "", "   ", "b"]), ["a", "b"]);
  assert.equal(normalizeInstructions(["x".repeat(400)])[0].length, 120);
  // A textarea hands back one string with newlines; a JSON client hands back an array. Both work.
  assert.deepEqual(normalizeInstructions("a\nb"), ["a", "b"]);
  assert.deepEqual(normalizeInstructions(undefined), []);
});
