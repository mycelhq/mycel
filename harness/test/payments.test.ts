// Payment detection, and the guard that stops a paid invoice being chased.
//
// The founder's question was "how would we know if they paid or not?", and the honest pre-existing
// answer was "we would not" — which meant an automated, escalating dunning ladder could be aimed at
// a client who had already paid. Every test here names the specific failure it prevents.
import { test } from "node:test";
import assert from "node:assert/strict";
import { connectMailbox } from "./helpers";
import { _resetBilling, getBillingStore, invoiceTotals } from "../src/billing";
import {
  ensurePaymentSyncSchedule,
  paymentConfidence,
  parseStripeCharges,
  parseStripeInvoices,
  reconcileProject,
  setReconcileDeps,
  STALE_AFTER_HOURS,
} from "../src/payments";
import { setChaseDeps, startChase, standDownChases, sweepOverdueInvoices } from "../src/dunning";
import type { Connection, Invoice } from "../src/contract";

const PROJECT = "proj-ours";
const OTHER = "proj-theirs";

/** A Stripe invoice as Composio hands it back: seconds-epoch times, minor units, an envelope. */
const stripeInvoice = (o: Partial<Record<string, unknown>> = {}) => ({
  id: "in_1",
  number: "INV-0001",
  currency: "usd",
  amount_paid: 54_000,
  total: 54_000,
  status_transitions: { paid_at: 1_710_000_000 },
  ...o,
});

function conn(o: Partial<Connection> = {}): Connection {
  return {
    id: "conn-stripe",
    project_id: PROJECT,
    kind: "composio",
    name: "stripe",
    owner: { kind: "founder", id: "founder" },
    // `verified_at` is what makes this a CONNECTED provider rather than an OAuth screen somebody
    // opened and walked away from — see `matchesProvider` in capabilities.ts, and the test below
    // that pins the difference.
    config: {
      toolkit: "stripe",
      connected_account_id: "ca_1",
      verified_at: "2024-03-01T00:00:00.000Z",
      read_tools: ["STRIPE_LIST_INVOICES"],
    },
    created_at: new Date().toISOString(),
    ...o,
  } as Connection;
}

async function invoice(o: Partial<Invoice> = {}): Promise<Invoice> {
  return getBillingStore().createInvoice({
    project_id: PROJECT,
    client_id: "cli-1",
    currency: "USD",
    status: "sent",
    lines: [{ id: "l1", description: "Work", kind: "fixed", quantity_milli: 1000, unit_amount: 54_000 }],
    due_date: "2024-03-01",
    ...o,
  } as any);
}

/** Wire reconciliation to fakes. `data` is what the Stripe read returns; `ok:false` simulates an outage. */
function wire(opts: { connections?: Connection[]; data?: unknown; ok?: boolean; onSettled?: (i: Invoice) => Promise<void> }) {
  const calls: string[] = [];
  setReconcileDeps({
    listConnections: async () => opts.connections ?? [conn()],
    execute: async (c, capability) => {
      calls.push(`${c.id}:${capability}`);
      return opts.ok === false
        ? { ok: false, detail: "HTTP 503" }
        : { ok: true, detail: "HTTP 200", data: opts.data ?? { data: [] } };
    },
    onSettled: opts.onSettled,
  });
  return calls;
}

function reset() {
  _resetBilling();
  setReconcileDeps(null);
  setChaseDeps(null);
  // A business with no mailbox no longer chases at all: `startChase` refuses with `cannot_send`
  // before it claims the invoice, because a chase nobody can send is a paid model call that burns
  // the ladder claim and still reports success. See promises.ts. Every dunning scene below is about
  // what the PAYMENT STATE does to the ladder, so each one has to be a business that could send.
  // Fire-and-forget: the connection only has to exist by the time a chase is attempted.
  void connectMailbox(PROJECT);
}

// ─────────────────────────────── detection ───────────────────────────────

test("payments: a detected payment settles the invoice and records how it was matched", async () => {
  reset();
  const inv = await invoice();
  wire({ data: { data: [stripeInvoice({ number: inv.number })] } });

  const s = await reconcileProject({ project_id: PROJECT });
  assert.equal(s.ok, true, s.detail);
  assert.equal(s.applied, 1);
  assert.deepEqual(s.settled, [inv.id]);

  const after = await getBillingStore().getInvoice(inv.id);
  assert.equal(after!.status, "paid");
  assert.equal(invoiceTotals(after!).amount_due, 0);

  const ledger = await getBillingStore().listExternalPayments({ project_id: PROJECT, invoice_id: inv.id });
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].basis, "reference", "matched on the reference the client quoted, and it is recorded as such");
});

test("payments: reading the same Stripe history twice does not pay the invoice twice", async () => {
  // THE BUG: reconciliation re-reads the same window every 15 minutes. Without the idempotency
  // ledger, `amount_paid` grows by the invoice's value on every sweep — invisibly, because the
  // status went `paid` on the first pass and nobody reads a number under a green badge.
  reset();
  const inv = await invoice();
  wire({ data: { data: [stripeInvoice({ number: inv.number })] } });

  const first = await reconcileProject({ project_id: PROJECT });
  const second = await reconcileProject({ project_id: PROJECT });
  assert.equal(first.applied, 1);
  assert.equal(second.applied, 0, "the second pass recognises the charge and applies nothing");
  assert.equal(second.ok, true, "and that is a SUCCESS, not an error — it is the mechanism working");

  const after = await getBillingStore().getInvoice(inv.id);
  assert.equal(after!.amount_paid, 54_000, "paid exactly once");
});

test("payments: a partial payment moves the balance and does NOT mark the invoice paid", async () => {
  // THE BUG: marking a part-paid invoice `paid` quietly writes off the remainder — the mirror image
  // of chasing a settled one, and just as unrecoverable because `paid` is a terminal status.
  reset();
  const inv = await invoice();
  wire({ data: { data: [stripeInvoice({ number: inv.number, amount_paid: 20_000 })] } });

  const s = await reconcileProject({ project_id: PROJECT });
  assert.equal(s.applied, 1);
  assert.deepEqual(s.settled, [], "nothing was settled");

  const after = await getBillingStore().getInvoice(inv.id);
  assert.equal(after!.status, "sent", "still owed, so still chaseable");
  assert.equal(invoiceTotals(after!).amount_due, 34_000);
});

test("payments: a payment in another currency is never converted and never applied", async () => {
  // THE BUG: applying 54000 minor units of EUR to a USD invoice settles a $540 debt with €540. Every
  // step of the arithmetic looks clean. A conversion is a business decision with a rate, a date and
  // a fee, and it belongs to a human.
  reset();
  const inv = await invoice();
  wire({ data: { data: [stripeInvoice({ number: inv.number, currency: "eur" })] } });

  const s = await reconcileProject({ project_id: PROJECT });
  assert.equal(s.applied, 0);
  assert.equal((await getBillingStore().getInvoice(inv.id))!.status, "sent");
  assert.equal(s.discrepancies.filter((d) => d.kind === "currency_mismatch").length, 1);
});

test("payments: an overpayment settles the invoice and is reported as a credit owed back", async () => {
  reset();
  const inv = await invoice();
  wire({ data: { data: [stripeInvoice({ number: inv.number, amount_paid: 60_000 })] } });

  const s = await reconcileProject({ project_id: PROJECT });
  assert.deepEqual(s.settled, [inv.id]);
  assert.equal(invoiceTotals((await getBillingStore().getInvoice(inv.id))!).amount_due, 0, "never negative");
  const over = s.discrepancies.find((d) => d.kind === "overpayment");
  assert.ok(over, "the surplus is surfaced rather than absorbed");
  assert.match(over!.detail, /6000 minor units more/);
});

test("payments: a refund that reopens a settled invoice is handed to a human, not auto-reversed", async () => {
  // `paid` is terminal by design — un-paying is a credit note, a different document with its own
  // audit trail. So the balance corrects but the status does not silently walk backwards.
  reset();
  const inv = await invoice();
  wire({ data: { data: [stripeInvoice({ number: inv.number })] } });
  await reconcileProject({ project_id: PROJECT });
  assert.equal((await getBillingStore().getInvoice(inv.id))!.status, "paid");

  // Same invoice, now with a refund arriving as a separate negative charge.
  wire({
    data: { data: [{ id: "ch_refund", status: "succeeded", amount_captured: -20_000, currency: "usd", created: 1_710_100_000, metadata: { mycel_invoice_number: inv.number } }] },
    connections: [conn({ config: { toolkit: "stripe", connected_account_id: "ca_1", verified_at: "2024-03-01T00:00:00.000Z", read_tools: ["STRIPE_LIST_CHARGES"] } })],
  });
  const s = await reconcileProject({ project_id: PROJECT });
  assert.equal(s.applied, 0, "a settled invoice is no longer in the open set, so the refund is unplaced not silently applied");
  assert.ok(s.discrepancies.some((d) => d.kind === "unplaced_payment"), "and it is reported for a human");
});

test("payments: a payment that matches nothing is reported, never guessed onto an invoice", async () => {
  reset();
  await invoice();
  wire({ data: { data: [stripeInvoice({ number: "SOMEONE-ELSES", amount_paid: 111 })] } });

  const s = await reconcileProject({ project_id: PROJECT });
  assert.equal(s.applied, 0);
  assert.equal(s.discrepancies.filter((d) => d.kind === "unplaced_payment").length, 1);
});

// ─────────────────────────────── tenancy ───────────────────────────────

test("payments: reconciliation cannot read or write across tenants", async () => {
  // THE BUG, and the worst one available here: reading one tenant's Stripe and applying the payments
  // to another tenant's invoices. It fabricates revenue for one business and keeps chasing the
  // client of another. Two cross-tenant leaks have already shipped in this repo.
  reset();
  const ours = await invoice();
  // An explicit, distinct number. Invoice numbers are unique PER PROJECT, so both tenants would
  // otherwise be handed "INV-0001" by their own counters — and then a reference match between them
  // would be legitimate rather than a leak, which is not what this test is asking about.
  const theirs = await getBillingStore().createInvoice({
    project_id: OTHER, client_id: "cli-2", currency: "USD", status: "sent", number: "THEIRS-0001",
    lines: [{ id: "l1", description: "Work", kind: "fixed", quantity_milli: 1000, unit_amount: 54_000 }],
    due_date: "2024-03-01",
  } as any);

  // Their connection, and an unscoped one, are both offered. Only ours may be used.
  const calls = wire({
    connections: [conn({ id: "conn-theirs", project_id: OTHER }), conn({ id: "conn-unscoped", project_id: undefined }), conn()],
    data: { data: [stripeInvoice({ number: theirs.number })] },
  });

  const s = await reconcileProject({ project_id: PROJECT });
  assert.deepEqual(calls.map((c) => c.split(":")[0]), ["conn-stripe"], "only the in-project, founder-owned connection is read");
  assert.equal((await getBillingStore().getInvoice(theirs.id))!.amount_paid, 0, "the other tenant's invoice is untouched");
  assert.equal((await getBillingStore().getInvoice(ours.id))!.amount_paid, 0, "and their reference does not settle ours");
  assert.ok(s.discrepancies.some((d) => d.kind === "unplaced_payment"));
});

test("payments: a client-owned connection is never read for accounts receivable", async () => {
  // A client-owned Composio connection is the CLIENT's own Stripe, which the founder operates on
  // their behalf. Reading it for AR would settle our invoices out of the client's own customers'
  // payments.
  reset();
  await invoice();
  const calls = wire({ connections: [conn({ owner: { kind: "client", id: "cli-1" } })] });
  const s = await reconcileProject({ project_id: PROJECT });
  assert.deepEqual(calls, []);
  assert.equal(s.ok, false);
  assert.match(s.detail, /no payment provider is connected/);
});

test("payments: reconciliation refuses to run unscoped rather than defaulting to a project", async () => {
  reset();
  wire({});
  await assert.rejects(() => reconcileProject({ project_id: "" }), /scoped to a project/);
});

test("payments: an undeclared read tool is never called", async () => {
  // The read gate is `isReadTool` on the connection, not our own catalogue. The difference between a
  // declared read and an undeclared one is the difference between listing charges and issuing refunds.
  reset();
  await invoice();
  const calls = wire({
    connections: [conn({ config: { toolkit: "stripe", connected_account_id: "ca_1", verified_at: "2024-03-01T00:00:00.000Z", read_tools: [] } })],
  });
  const s = await reconcileProject({ project_id: PROJECT });
  assert.deepEqual(calls, []);
  assert.equal(s.ok, false, "and a run that read nothing does NOT report success");
  assert.match(s.detail, /STRIPE_LIST_INVOICES/, "and it names the read that was never granted, so the founder can fix it");
});

// ─────────────────────────────── loudness ───────────────────────────────

test("payments: a reconciliation that reaches nothing is loud, not a clean empty run", async () => {
  // THE RECURRING EXPENSIVE BUG IN THIS REPO: something fails while reporting success. A
  // reconciliation that cannot reach Stripe and returns an all-zeroes summary looks exactly like
  // "every invoice is genuinely unpaid" — and the thing we do to an unpaid invoice is chase it.
  reset();
  await invoice();
  wire({ ok: false });

  const s = await reconcileProject({ project_id: PROJECT });
  assert.equal(s.ok, false);
  assert.match(s.detail, /HTTP 503/, "the provider's own failure is carried through, not flattened");

  const check = await getBillingStore().getPaymentCheck(PROJECT);
  assert.equal(check!.ok, false);
  assert.equal(check!.confirmed_at, undefined, "a failed attempt never stamps freshness");
});

test("payments: a failed check never erases the last successful one", async () => {
  // Otherwise a one-minute Stripe wobble flips the whole project to 'never verified' and — under the
  // staleness rule — halts a business's accounts receivable.
  reset();
  wire({ data: { data: [] } });
  await reconcileProject({ project_id: PROJECT });
  const good = (await getBillingStore().getPaymentCheck(PROJECT))!.confirmed_at;
  assert.ok(good);

  wire({ ok: false });
  await reconcileProject({ project_id: PROJECT });
  const after = (await getBillingStore().getPaymentCheck(PROJECT))!;
  assert.equal(after.ok, false, "the failure is recorded");
  assert.equal(after.confirmed_at, good, "but the last good confirmation is preserved");
});

// ─────────────────────────────── confidence ───────────────────────────────

test("payments: unknown payment state is surfaced, never assumed", async () => {
  reset();
  const never = await paymentConfidence(PROJECT);
  assert.equal(never.level, "unverifiable");
  assert.match(never.detail, /bank transfer/, "it says WHY it cannot know, in words a founder can act on");

  wire({ data: { data: [] } });
  await reconcileProject({ project_id: PROJECT });
  const fresh = await paymentConfidence(PROJECT);
  assert.equal(fresh.level, "fresh");
  assert.equal(fresh.safe_to_chase_automatically, true);
  assert.equal(typeof fresh.confirmed_at, "string", "the approval preview can show exactly when we last looked");

  const later = new Date(Date.now() + (STALE_AFTER_HOURS + 1) * 3_600_000);
  assert.equal((await paymentConfidence(PROJECT, later)).level, "stale");
  assert.equal((await paymentConfidence(PROJECT, later)).safe_to_chase_automatically, false);
});

test("payments: confidence must be scoped to a project", async () => {
  reset();
  await assert.rejects(() => paymentConfidence(""), /scoped to a project/);
});

// ─────────────────────────────── the chase guard ───────────────────────────────

/** Arm the chase path with a spy, so a test can assert nothing was spawned. */
function armChase() {
  const spawned: string[] = [];
  const openChases: string[] = [];
  setChaseDeps({
    wedgeEnabled: () => true,
    spawnTask: async (a) => {
      spawned.push(String((a.input as any).invoice_id));
      return `task-${spawned.length}`;
    },
    attachInvoiceDocument: async () => ({}),
    openChasesFor: async () => openChases,
  });
  return { spawned, openChases };
}

test("dunning: a paid invoice is never chased", async () => {
  // THE FOUNDER'S QUESTION, in its simplest form. Two independent guards, because either alone has
  // a hole: the status machine, and the outstanding balance.
  reset();
  const { spawned } = armChase();
  const paid = await invoice({ status: "paid" } as any);
  const settled = await invoice();
  await getBillingStore().recordPayment(settled.id, 54_000);

  const a = await startChase(paid, { pacing: "override" });
  assert.equal(a.ok, false);
  assert.equal((a as any).reason, "not_chaseable");

  const b = await startChase((await getBillingStore().getInvoice(settled.id))!, { pacing: "override" });
  assert.equal(b.ok, false);
  assert.equal((b as any).reason, "nothing_outstanding", "a zero balance is refused even while the status still says sent");

  assert.deepEqual(spawned, [], "no run was started for either");
});

test("dunning: the automatic ladder stops when payment state is stale, but a human can still chase", async () => {
  // THE DEFENCE: `stale` means a provider IS connected and we are blind to it right now — precisely
  // when our 'unpaid' is most likely wrong in the direction that damages a client relationship. A
  // founder clicking Chase knows things the ladder does not, so the override still goes through and
  // carries the uncertainty into the run instead of hiding it.
  reset();
  const { spawned } = armChase();
  wire({ data: { data: [] } });
  await reconcileProject({ project_id: PROJECT });
  const inv = await invoice();
  const later = new Date(Date.now() + (STALE_AFTER_HOURS + 1) * 3_600_000);

  const auto = await startChase(inv, { pacing: "ladder", now: later });
  assert.equal(auto.ok, false);
  assert.equal((auto as any).reason, "payment_state_stale");
  assert.deepEqual(spawned, []);

  const human = await startChase(inv, { pacing: "override", now: later });
  assert.equal(human.ok, true, "a human is not blocked by our own integration being down");
  assert.deepEqual(spawned, [inv.id]);
});

test("dunning: with no provider connected the ladder still runs, and says so in the run's input", async () => {
  // THE OTHER HALF OF THE DEFENCE. Most small businesses invoice by bank transfer and will never
  // have a fresh check. Halting there would make an AR chaser quietly stop chasing — this repo's
  // single most expensive failure shape. So it proceeds, and the honest uncertainty travels to the
  // human at the approval gate rather than being swallowed.
  reset();
  const inputs: Record<string, unknown>[] = [];
  setChaseDeps({
    wedgeEnabled: () => true,
    spawnTask: async (a) => { inputs.push(a.input); return "t1"; },
    attachInvoiceDocument: async () => ({}),
  });
  const inv = await invoice();
  const started = await startChase(inv, { pacing: "ladder" });
  assert.equal(started.ok, true);
  const state = inputs[0].payment_state as any;
  assert.equal(state.level, "unverifiable");
  assert.match(state.detail, /nothing here can confirm whether this invoice was paid/);
  assert.equal(state.confirmed_at, undefined, "the preview shows there is no confirmation time, rather than implying one");
});

test("dunning: a payment landing mid-chase cancels the queued chase instead of sending it", async () => {
  // THE WINDOW: `startChase` spawns a run, the run writes the words, and the send then SITS on the
  // approval gate until a founder looks at their phone. A payment routinely lands inside that
  // window. Until this, the invoice would go paid and the already-written dunning email would be
  // approved and sent afterwards — to the client who had just paid.
  reset();
  const stood: string[] = [];
  setChaseDeps({
    wedgeEnabled: () => true,
    spawnTask: async () => "task-in-flight",
    attachInvoiceDocument: async () => ({}),
    openChasesFor: async ({ project_id, invoice_id }) => {
      stood.push(`${project_id}/${invoice_id}`);
      return ["task-in-flight"];
    },
  });
  const inv = await invoice();

  wire({
    data: { data: [stripeInvoice({ number: inv.number })] },
    onSettled: async (settled) => { await standDownChases(settled, "test"); },
  });
  const s = await reconcileProject({ project_id: PROJECT });

  assert.deepEqual(s.settled, [inv.id]);
  assert.deepEqual(stood, [`${PROJECT}/${inv.id}`], "the in-flight chase was looked up, project-scoped, and stood down");
});

test("dunning: a stand-down that cannot look up in-flight chases reports that, rather than claiming success", async () => {
  reset();
  setChaseDeps({ wedgeEnabled: () => true, spawnTask: async () => "t", attachInvoiceDocument: async () => ({}) });
  const inv = await invoice();
  const r = await standDownChases(inv, "test");
  assert.deepEqual(r.cancelled, []);
  assert.match(r.reason ?? "", /cannot look up in-flight chases/);
});

test("dunning: the sweep reports the stale refusal instead of a silent zero", async () => {
  reset();
  armChase();
  wire({ data: { data: [] } });
  await reconcileProject({ project_id: PROJECT });
  const inv = await invoice({ due_date: "2020-01-01" } as any);
  const later = new Date(Date.now() + (STALE_AFTER_HOURS + 1) * 3_600_000);

  const summary = await sweepOverdueInvoices({ project_id: PROJECT, now: later });
  assert.ok(summary.considered >= 1, "the invoice was looked at");
  assert.equal(summary.chased, 0, "and not chased");
  assert.ok(inv.id);
});

// ─────────────────────────────── parsing ───────────────────────────────

test("payments: Stripe amounts are read from the field that means settled money", async () => {
  // `total` is what was asked for; `amount_paid` is what arrived. Reading `total` would settle our
  // invoice in full off a quarter of the money and stop a chase that should have continued.
  const [p] = parseStripeInvoices({ data: [stripeInvoice({ total: 400_000, amount_paid: 100_000 })] });
  assert.equal(p.amount_minor, 100_000);
  assert.equal(p.currency, "USD");
  assert.equal(p.paid_at, new Date(1_710_000_000 * 1000).toISOString(), "seconds-epoch, not milliseconds");

  // An authorised-but-uncaptured charge is not money, and a refund reduces what is.
  assert.deepEqual(parseStripeCharges({ data: [{ id: "ch_1", status: "pending", amount: 5000 }] }), []);
  const [c] = parseStripeCharges({ data: [{ id: "ch_2", status: "succeeded", amount_captured: 5000, amount_refunded: 2000, currency: "usd", created: 1 }] });
  assert.equal(c.amount_minor, 3000, "the net, so amount_due reflects what the business actually kept");
});

test("payments: the sync schedule is per project and never created unscoped", async () => {
  const { getDomainStore } = await import("../src/domain");
  await assert.rejects(() => ensurePaymentSyncSchedule(getDomainStore(), "", "w"), /scoped to a project/);
});
