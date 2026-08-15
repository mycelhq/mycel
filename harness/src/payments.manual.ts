// The human channel: a person telling us money arrived, and us asking them when we cannot tell.
//
// ═══════════════════════════ WHY THIS FILE IS NOT AN EDGE CASE ═══════════════════════════
//
// `payments.ts` answers "how do we know someone paid" by reading Stripe. That is the right mechanism
// and it covers a minority of the businesses this product is for. Most small service firms are paid
// by BANK TRANSFER, and after that in cash — money that no API we can reach will ever describe. For
// every one of those businesses `paymentConfidence` returns `unverifiable` on the day they sign up
// and returns `unverifiable` for ever, and the only thing in the universe that knows whether invoice
// INV-0007 has been settled is a human being.
//
// So this is not the fallback path for customers who have not got round to connecting Stripe. For the
// median customer it is THE path, and it is built to that standard: the same idempotency ledger, the
// same tenancy boundary, the same stand-down of in-flight chases, the same attribution write. The
// previous state of the art was `POST /v1/invoices/:id/payments` taking a bare `amount_minor` and
// calling `recordPayment`, which is a raw unguarded `amount_paid = amount_paid + n`:
//
//   · A DOUBLE SUBMIT DOUBLE-COUNTED. No idempotency key, so a founder on a flaky train connection
//     tapping "Record it" twice paid the invoice off twice. The invoice went green either way, and
//     nobody reads a number under a green badge — see the note on `ExternalPayment`, which is the
//     same bug the reconciliation loop had and which the external-payment ledger already solved.
//     This path simply did not use it.
//
//   · IT WAS INVISIBLE. `GET /v1/invoices/:id/payments` reads `listExternalPayments`, so a payment a
//     human recorded appeared in NO audit trail at all. `amount_paid` moved and nothing said why,
//     who, when, or how the money arrived.
//
//   · IT WAS STAMPED TODAY. The invoice's `paid_at` came from `new Date()`. Somebody handed cash on
//     Tuesday and keys it in on Friday, and we recorded Friday — which is not pedantry, because the
//     question "should we have chased this on Wednesday" is answered by that date and by nothing
//     else. See `chased_after_payment` below.
//
// Everything here routes through `applyExternalPayment`, so a payment a human records and a payment
// Stripe reports are the same kind of row in the same ledger under the same unique index. That is
// also what makes the two safe to mix: the day a founder connects their bank feed, the transfer it
// reads is reconciled against invoices whose balances already reflect what the founder keyed in.
//
// ═══════════════════════════ AND THE QUESTION ═══════════════════════════
//
// The second half of this file is the other direction: US ASKING THEM. See `askPaymentQuestion`.
import { randomUUID } from "node:crypto";
import type { Invoice, TaskSource } from "./contract";
import { getDomainStore } from "./domain";
import { standDownChases } from "./dunning";
import { noteInvoiceSettled, systemMoveAuthority } from "./moves";
import { paymentConfidence } from "./payments";
import { requireWedgeForRole, wedgeForRole, whyNoWedge } from "./roles";
import {
  canTransition,
  getBillingStore,
  invoiceTotals,
  isPaymentMethod,
  type ExternalPayment,
  type InvoiceTotals,
  type PaymentMethod,
} from "./billing";

/**
 * The reserved slug the question and the payment instructions are filed under.
 *
 * NOT a wedge on disk, exactly like `MOVES_WEDGE` in moves.ts and `NUDGE_WEDGE` in nudges.ts. These
 * are kernel-owned rows that need `Record_`'s tenant-scoped storage without inventing a table, and
 * naming the slug here rather than passing a directory name around is what keeps the roles.ts
 * contract test (no wedge directory names in `src/`) satisfiable.
 */
export const PAYMENTS_WEDGE = "payments";
export const QUESTION_COLLECTION = "payment_question";
export const INSTRUCTIONS_COLLECTION = "payment_instructions";

/**
 * Noon UTC, not midnight, for a date-only payment date.
 *
 * A `YYYY-MM-DD` the founder picked has no timezone, and it has to become an instant to be stored.
 * Midnight UTC is the wrong choice: `2026-03-04T00:00:00Z` renders as March 3rd everywhere west of
 * Greenwich, so a founder in Chicago records Wednesday's cash and the invoice reads Tuesday. That is
 * the whole of the Americas getting the wrong answer.
 *
 * Noon is the hour that survives the widest band — every offset from UTC-11 to UTC+11 renders the
 * intended calendar date. It is NOT universal, and the honest statement of the limit is that a
 * viewer at UTC+12 or beyond (New Zealand, Fiji, Kiribati) formatting this instant in LOCAL time
 * sees the following day. There is no hour that satisfies UTC-12 and UTC+14 simultaneously — the
 * band is 26 hours wide and a day is 24 — so the residual fix is not a better constant: it is that
 * anything displaying a payment date takes the UTC date (`.slice(0, 10)`, which is exact for every
 * viewer), and only a local-time formatter can be wrong here.
 */
export function instantForDate(dateIso: string): string {
  return `${dateIso}T12:00:00.000Z`;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar date, not merely a string of the right shape. `2026-02-31` is not a date. */
export function isCalendarDate(v: unknown): v is string {
  if (typeof v !== "string" || !DATE_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

// ═══════════════════════════ RECORDING A PAYMENT ═══════════════════════════

export interface ManualPaymentInput {
  /** TENANT SCOPE. Required, never defaulted, and checked against the invoice before anything. */
  project_id: string;
  invoice_id: string;
  /**
   * Integer minor units. Negative records a refund, for the same reason `ObservedPayment` allows it:
   * a refund is a payment in the other direction, so `amount_paid` corrects itself through the one
   * atomic add rather than through a second path that has to remember to subtract.
   */
  amount_minor: number;
  method: PaymentMethod;
  /**
   * The date the MONEY ARRIVED, `YYYY-MM-DD`. Not today unless today is the answer.
   *
   * Required, with no default in this function. The route defaults it to today because a form needs
   * a value; this function refuses to guess, because a silently-defaulted payment date is precisely
   * the bug it exists to fix.
   */
  paid_on: string;
  /** What the payer quoted. Free text, recorded, never matched on — see `ExternalPayment.reference`. */
  reference?: string;
  /**
   * THE IDEMPOTENCY KEY, minted by the caller before the first attempt.
   *
   * This is what makes a double submit safe, and it has to come from the client: a key generated
   * here would be new on every request, which is exactly the same as having none. The UI mints one
   * when the dialog opens, so every retry of THAT form submission carries the same key while a
   * genuine second payment on the same invoice — a client paying in two instalments — carries a
   * different one and is correctly counted twice.
   */
  entry_id: string;
  /** Who said so. Goes in `source`, so the audit trail names a person and not "the system". */
  recorded_by: string;
  now?: Date;
}

export type ManualPaymentRefusal =
  | "not_found"
  | "void_invoice"
  | "draft_invoice"
  | "not_an_amount"
  | "unknown_method"
  | "not_a_date"
  | "future_date"
  | "no_entry_id";

/** What the founder is told, and what the UI does next. */
export interface ManualPaymentSuccess {
  ok: true;
  /**
   * FALSE MEANS THE LEDGER REFUSED A DUPLICATE, AND THAT IS A SUCCESS.
   *
   * The second submit of one form is not an error to show a founder — the money is recorded, which
   * is what they asked for. It is surfaced rather than hidden so the UI can say "already recorded"
   * instead of implying it has just added the amount a second time.
   */
  applied: boolean;
  invoice: Invoice;
  totals: InvoiceTotals;
  /** True only when THIS call took the invoice from owing to settled. Never true on a replay. */
  settled: boolean;
  /** Chase runs stood down because of this payment. */
  stood_down: string[];
  /** Present when we could NOT confirm the stand-down. Never silently absent — see `standDownChases`. */
  stand_down_warning?: string;
  /** Minor units received beyond the total. A credit the business owes back; never netted away. */
  overpaid_by?: number;
  /**
   * WE CHASED THIS CLIENT AFTER THEIR MONEY HAD ALREADY ARRIVED.
   *
   * Computable only because `paid_on` is the real date rather than today, and it is the founder's
   * original question turned around: not "will we chase someone who paid" but "did we already". A
   * founder keying in Tuesday's cash on Friday deserves to be told that Wednesday's reminder went
   * out for money that was already in the till, because the next thing they will want to do is
   * apologise — and they cannot do that if we quietly file the payment under today.
   */
  chased_after_payment?: { last_chased_at: string; days_after: number };
  /** Whether a receipt can be offered for this payment, and the honest reason when it cannot. */
  receipt: ReceiptOffer;
}

export type ManualPaymentOutcome =
  | ManualPaymentSuccess
  | { ok: false; reason: ManualPaymentRefusal; message: string };

/**
 * Record a payment a human knows about. THE ENTRY POINT for every non-provider payment.
 *
 * ═══ IT DOES EVERYTHING THE RECONCILIATION PATH DOES ═══
 *
 * The failure this shape guards against is a second, thinner "mark it paid" that skips a step. When
 * `reconcileProject` settles an invoice it stands down in-flight chases, moves the status through the
 * guarded transition, and attributes the outcome. A hand-recorded payment that did four of those five
 * things would be a chase sent to a client the founder had personally just marked as paid — and it
 * would be sent BECAUSE they marked it paid, which is the least forgivable version of this bug. So
 * both paths are the same sequence in the same order, and the order matters: the stand-down happens
 * BEFORE the status write, because doing it afterwards leaves a window in which the invoice is
 * settled and the email is still on its way out.
 *
 * ═══ CURRENCY IS NOT AN ARGUMENT, ON PURPOSE ═══
 *
 * There is no `currency` field on the input. A payment recorded by hand is in the invoice's currency
 * by construction — the founder is looking at the invoice while they type — and offering the field
 * would create the one thing `reconcileProject` refuses outright: a path that applies money in one
 * currency to a debt in another. A client who genuinely paid in a different currency has done a
 * conversion with a rate, a date and a fee, and that is a human's decision recorded as a separate
 * line, not a number this function silently absorbs.
 */
export async function recordManualPayment(input: ManualPaymentInput): Promise<ManualPaymentOutcome> {
  const projectId = input.project_id;
  if (!projectId) throw new Error("recording a payment must be scoped to a project");
  const now = input.now ?? new Date();
  const billing = getBillingStore();

  // ── validation, before anything is written ──
  //
  // Every one of these is a refusal rather than a coercion. Truncating a float, defaulting an
  // unrecognised method to `other` or clamping a future date to today would all produce a recorded
  // payment that differs from what the human said, which is worse than making them fix the form.
  if (!Number.isSafeInteger(input.amount_minor) || input.amount_minor === 0) {
    return {
      ok: false,
      reason: "not_an_amount",
      message: "A payment has to be a whole number of minor units, and not zero — 1250, never 12.50.",
    };
  }
  if (!isPaymentMethod(input.method)) {
    return { ok: false, reason: "unknown_method", message: `"${String(input.method)}" is not a payment method we record.` };
  }
  if (!isCalendarDate(input.paid_on)) {
    return { ok: false, reason: "not_a_date", message: "The date the money arrived has to be a real date, as YYYY-MM-DD." };
  }
  if (!input.entry_id) {
    // Fail rather than mint one here. A generated key is a new key on every retry, which is the same
    // as no key at all — and the caller would have no way to know it had lost its double-submit guard.
    return { ok: false, reason: "no_entry_id", message: "A payment needs an entry id so recording it twice cannot count it twice." };
  }
  const today = now.toISOString().slice(0, 10);
  if (input.paid_on > today) {
    // Money cannot have arrived tomorrow. This is the typo guard — a founder typing 2027 for 2026 —
    // and letting it through would settle an invoice against a payment that has not happened, which
    // stops a chase that should continue.
    return { ok: false, reason: "future_date", message: `${input.paid_on} is in the future — money cannot have arrived yet.` };
  }

  // ── the invoice, tenant-scoped ──
  const inv = await billing.getInvoice(input.invoice_id);
  // A wrong project is indistinguishable from a missing invoice, deliberately: a caller probing ids
  // must not be able to tell another tenant's invoice from one that does not exist. The atomic
  // boundary is `applyExternalPayment`'s own WHERE clause; this is the early, quiet refusal.
  if (!inv || inv.project_id !== projectId) {
    return { ok: false, reason: "not_found", message: "No such invoice." };
  }
  if (inv.status === "void") {
    return { ok: false, reason: "void_invoice", message: "A void invoice cannot take a payment." };
  }
  if (inv.status === "draft") {
    // A draft is the business thinking out loud; the client has never seen it. Money against one
    // means the invoice should have been issued, and issuing it is a decision with its own stamp.
    return { ok: false, reason: "draft_invoice", message: "That invoice has not been issued yet — send it first, then record the payment." };
  }

  const paidAt = instantForDate(input.paid_on);

  // ── apply, at most once, ever ──
  //
  // `manual:` namespaces the key away from any provider's id space. Provider ids are namespaced by
  // connection id (see `reconcileProject`), so a collision was already impossible; the prefix is here
  // so a person reading the ledger can see at a glance which rows a human wrote.
  const record: ExternalPayment = {
    project_id: projectId,
    invoice_id: inv.id,
    external_id: `manual:${input.entry_id}`,
    amount_minor: input.amount_minor,
    currency: inv.currency.toUpperCase(),
    paid_at: paidAt,
    // `human`, the third `basis` the audit route already documents. It is the most trustworthy of the
    // three — a person looked at their bank and said so — and the one a founder most needs to see
    // when they ask why an invoice is green.
    basis: "human",
    source: `recorded by hand (${input.recorded_by || "unknown"})`,
    method: input.method,
    reference: input.reference?.trim() || undefined,
  };
  const { applied, invoice } = await billing.applyExternalPayment(record);
  if (!invoice) {
    // The store refused on tenancy. Unreachable given the check above, so if it fires something is
    // wrong in exactly the way that crosses tenants, and it must be loud rather than a quiet no-op.
    console.error(`[mycel] refused a hand-recorded payment: invoice ${inv.id} is not in project ${projectId}`);
    return { ok: false, reason: "not_found", message: "No such invoice." };
  }

  const totals = invoiceTotals(invoice);
  const answered = await answerPaymentQuestionIfOpen(projectId, invoice.id, "paid", input.recorded_by, now);
  void answered;

  if (!applied) {
    // A REPLAY. The money is already recorded, so this is a success — but nothing else may run
    // again. In practice the guards downstream are all idempotent anyway (`transitionInvoice` has
    // its allowed-from list in the WHERE clause, so a second settle returns undefined), and
    // returning here makes that a property of this function rather than a coincidence of theirs.
    return {
      ok: true,
      applied: false,
      invoice,
      totals,
      settled: false,
      stood_down: [],
      receipt: await receiptOffer(invoice, totals),
    };
  }

  // ── everything the reconciliation path does, in the same order ──
  let settled = false;
  let stoodDown: string[] = [];
  let standDownWarning: string | undefined;

  if (totals.amount_due === 0 && canTransition(invoice.status, "paid")) {
    // BEFORE the transition. A chase queued or parked on the approval gate has to be killed while
    // there is still time to kill it. See `standDownChases` for the window this closes.
    const stand = await standDownChases(invoice, `${input.recorded_by || "a human"} recorded a ${input.method} payment`).catch(
      (e): { cancelled: string[]; reason?: string } => {
        console.error(`[mycel] could not stand down chases for invoice ${invoice.id}:`, e);
        // Reported, never swallowed. A recorded payment that failed to stop a chase while telling
        // the founder it succeeded is this repo's signature bug.
        return { cancelled: [], reason: "the attempt to stand down in-flight chases failed" };
      },
    );
    stoodDown = stand.cancelled;
    standDownWarning = stand.reason;

    /**
     * `paid_at: paidAt` — THE BACK-DATED STAMP, and the reason this whole function takes a date.
     *
     * The invoice records when the money arrived, not when we were told. Every downstream question
     * is asked of this field: how long the client actually took to pay, whether the chase we sent on
     * Wednesday was justified, and which month the revenue belongs to. Stamping `new Date()` here —
     * which is what the old route did — makes all three answers wrong by however many days the
     * founder took to get to their laptop, and makes them wrong in a direction that flatters us.
     */
    const done = await billing.transitionInvoice(invoice.id, "paid", ["sent", "overdue"], { paid_at: paidAt });
    if (done) {
      settled = true;
      /**
       * Attribution, judged on the PAYMENT's date rather than today.
       *
       * `noteInvoiceSettled` refuses to credit a chase more than `PAID_ATTRIBUTION_DAYS` before the
       * settlement, and it computes that gap from the timestamp it is handed. Handing it `now` for a
       * payment that landed six weeks ago would credit a chase that cannot have caused it, and the
       * next-move engine would learn from a coincidence. Best effort: a bookkeeping write must never
       * turn a recorded payment into an error.
       */
      await noteInvoiceSettled(getDomainStore(), systemMoveAuthority(done.project_id), done, paidAt).catch((e) =>
        console.error(`[mycel] could not attribute the settlement of invoice ${done.id}:`, e),
      );
      Object.assign(invoice, done);
    }
  }

  const after = invoiceTotals(invoice);
  return {
    ok: true,
    applied: true,
    invoice,
    totals: after,
    settled,
    stood_down: stoodDown,
    ...(standDownWarning ? { stand_down_warning: standDownWarning } : {}),
    // Surfaced, never netted away and never refused. Refusing an overpayment would leave the founder
    // unable to record money that is genuinely in their account; netting it silently would hide a
    // credit they owe back to their client.
    ...(after.amount_paid > after.total ? { overpaid_by: after.amount_paid - after.total } : {}),
    ...(chasedAfter(inv, paidAt) ?? {}),
    receipt: await receiptOffer(invoice, after),
  };
}

/**
 * Did we chase this client after their money had already arrived?
 *
 * Compares the last chase against the payment's OWN date. Reads the invoice as it was BEFORE this
 * call, because settling it does not change when it was last chased but re-reading afterwards would
 * invite someone to use the post-transition row and quietly compare the payment to itself.
 */
function chasedAfter(before: Invoice, paidAt: string): { chased_after_payment: { last_chased_at: string; days_after: number } } | undefined {
  const chased = before.last_chased_at;
  if (!chased) return undefined;
  const gapMs = Date.parse(chased) - Date.parse(paidAt);
  if (!Number.isFinite(gapMs) || gapMs <= 0) return undefined;
  return { chased_after_payment: { last_chased_at: chased, days_after: Math.floor(gapMs / 86_400_000) } };
}

// ═══════════════════════════ ASKING "WAS THIS PAID?" ═══════════════════════════
//
// ─── WHY THIS IS A DURABLE ROW AND NOT A MOVE ───
//
// `moves.ts` is the product's mechanism for "here is a thing worth your attention", and a question to
// the founder looks like it belongs there. It was tried and it is the wrong shape, for two reasons
// that are worth writing down so it is not re-litigated:
//
//   1. A MOVE IS A PROPOSAL TO ACT, AND TAKING ONE SPAWNS A RUN. `takeMove` resolves a carrier wedge
//      and a task type and enqueues work; there is no shape in it for "record the founder's answer".
//      A question move would need an answer channel parallel to `POST /v1/moves/outcome` — that is a
//      second mechanism grafted inside the move system, not a use of it.
//
//   2. DECISIVELY: MOVES ARE COMPUTED ON READ, AND THIS HAS TO GATE A CLOCK. The dunning sweep runs
//      at 03:00 whether or not anybody has opened the app that week. A proposal that only exists
//      while someone is looking at a screen cannot stop it. Whatever suppresses the ladder must be
//      durable and must be readable by the sweep, which means a stored row — and once the row exists,
//      a move over the top of it would be a second view of the same fact, free to disagree with it.
//
// The structural precedent in this codebase is `ClientRequest`: an unanswered question, addressed to
// somebody, that ages and can be chased. This is that noun with the arrow reversed — addressed to the
// founder rather than to the client — and it is stored the way moves.ts stores its own outcomes.
//
// ─── WHY IT GATES ESCALATION RATHER THAN THE FIRST CHASE ───
//
// Asking before the FIRST reminder would put a question in front of the founder for every invoice
// that goes one day overdue. That is the nagging failure `MAX_NUDGES` exists to avoid, and a founder
// who dismisses ten of these stops reading the eleventh. The first reminder is also cheap: a polite
// note about a three-day-late invoice sent to somebody who paid last week is mildly embarrassing. The
// `final_notice` on day 22 to someone who handed over cash on day 2 is the one that loses the client,
// and it is the one this stops.
//
// ─── AND WHY THE GATE EXPIRES ───
//
// `paymentConfidence` argues at length that `unverifiable` must still chase, because a chaser that
// has quietly stopped chasing is the purest form of this repo's recurring bug: failing while
// reporting success. A question that halted the ladder until someone answered would reintroduce
// exactly that — a founder on holiday would come back to a month of unchased debt and a tidy list of
// questions nobody had read. So the suppression is BOUNDED. After `QUESTION_GRACE_HOURS` the ladder
// proceeds regardless, carrying the fact that we asked and heard nothing into the chase's input and
// its approval preview, where the human at the gate can act on it.

/**
 * How long the ladder waits for an answer before escalating anyway.
 *
 * 48 hours, which is `MIN_CHASE_INTERVAL_DAYS` expressed in the same units. Deliberately the same
 * number: the ladder's own floor is the longest an invoice is ever guaranteed to sit between rungs,
 * so a grace period of exactly that length costs at most one rung of delay and never silently
 * cancels a chase. Long enough to cover a weekend, which is when most of these are asked.
 */
export const QUESTION_GRACE_HOURS = 48;

export type PaymentAnswer = "paid" | "not_paid";

export interface PaymentQuestion {
  project_id: string;
  invoice_id: string;
  invoice_number: string;
  client_id?: string;
  asked_at: string;
  /** What was outstanding when we asked, so the founder sees the sum without another lookup. */
  amount_due_when_asked: number;
  currency: string;
  answer?: PaymentAnswer;
  answered_at?: string;
  answered_by?: string;

  /**
   * ═══ THE CLIENT ANSWERED THE CHASE ═══
   *
   * When an inbound email arrived on the conversation this invoice was chased on. Written by
   * `noteClientReplyOnInvoice`, which the AgentMail inbound webhook calls.
   *
   * This is NOT `answer`. `answer` is the FOUNDER's word and only a founder (or a recorded payment)
   * may write it; this is the DEBTOR's, and the difference is the whole design. A ladder that took
   * "I paid last week" as payment could be talked out of chasing by anyone who can type, and the one
   * thing a dunning system must not be is persuadable by the person who owes the money. So a client
   * reply suppresses and asks; it never settles. The poll in payments.ts, or a human, settles.
   *
   * Stored on the question row rather than in a mechanism of its own for the reason the essay above
   * gives about moves: whatever suppresses the ladder must be durable and readable by the 03:00
   * sweep, and there must be exactly ONE such thing, or two views of "should we escalate?" are free
   * to disagree.
   */
  client_replied_at?: string;
  /** Our thread the reply landed on, so the founder's answer is one click from reading it. */
  client_reply_thread_id?: string;
  /** First line or so of what they said. Enough for a founder to judge without opening anything. */
  client_reply_excerpt?: string;
}

const questionKey = (invoiceId: string) => invoiceId;

function toQuestion(projectId: string, data: Record<string, unknown>): PaymentQuestion | undefined {
  const invoiceId = typeof data.invoice_id === "string" ? data.invoice_id : "";
  const askedAt = typeof data.asked_at === "string" ? data.asked_at : "";
  if (!invoiceId || !askedAt) return undefined;
  const answer = data.answer === "paid" || data.answer === "not_paid" ? data.answer : undefined;
  return {
    project_id: projectId,
    invoice_id: invoiceId,
    invoice_number: typeof data.invoice_number === "string" ? data.invoice_number : "",
    client_id: typeof data.client_id === "string" ? data.client_id : undefined,
    asked_at: askedAt,
    amount_due_when_asked: typeof data.amount_due_when_asked === "number" ? data.amount_due_when_asked : 0,
    currency: typeof data.currency === "string" ? data.currency : "",
    answer,
    answered_at: typeof data.answered_at === "string" ? data.answered_at : undefined,
    answered_by: typeof data.answered_by === "string" ? data.answered_by : undefined,
    client_replied_at: typeof data.client_replied_at === "string" ? data.client_replied_at : undefined,
    client_reply_thread_id: typeof data.client_reply_thread_id === "string" ? data.client_reply_thread_id : undefined,
    client_reply_excerpt: typeof data.client_reply_excerpt === "string" ? data.client_reply_excerpt : undefined,
  };
}

/** Every question ever asked for a project, newest first. Tenant-scoped by the query, not after it. */
export async function listPaymentQuestions(projectId: string, opts: { open_only?: boolean } = {}): Promise<PaymentQuestion[]> {
  if (!projectId) throw new Error("reading payment questions must be scoped to a project");
  const rows = await getDomainStore().queryRecords({
    project_id: projectId,
    wedge: PAYMENTS_WEDGE,
    collection: QUESTION_COLLECTION,
    limit: 500,
  });
  const out = rows
    .map((r) => toQuestion(projectId, r.data))
    .filter((q): q is PaymentQuestion => !!q && (!opts.open_only || !q.answer));
  return out.sort((a, b) => (a.asked_at < b.asked_at ? 1 : -1));
}

/** The question for one invoice, answered or not. */
export async function getPaymentQuestion(projectId: string, invoiceId: string): Promise<PaymentQuestion | undefined> {
  if (!projectId) throw new Error("reading a payment question must be scoped to a project");
  const rows = await getDomainStore().queryRecords({
    project_id: projectId,
    wedge: PAYMENTS_WEDGE,
    collection: QUESTION_COLLECTION,
    where: { invoice_id: invoiceId },
    limit: 2,
  });
  for (const r of rows) {
    const q = toQuestion(projectId, r.data);
    if (q?.invoice_id === invoiceId) return q;
  }
  return undefined;
}

/**
 * Ask, once. Idempotent: a question already on the record is returned untouched.
 *
 * NOT re-asked after it has been answered, ever. A founder who has said "no, they have not paid" has
 * given the ladder its instruction, and asking again next week about the same invoice is the nagging
 * this is supposed to prevent — the same judgement `MAX_NUDGES` makes about a client's patience,
 * applied to the founder's. Returning the existing row rather than overwriting it is also what keeps
 * `asked_at` meaningful: the grace window is measured from when we FIRST asked, so a second sweep
 * touching the row cannot quietly extend the suppression.
 */
export async function askPaymentQuestion(inv: Invoice, now: Date = new Date()): Promise<PaymentQuestion> {
  if (!inv.project_id) throw new Error("asking about a payment must be scoped to a project");
  const existing = await getPaymentQuestion(inv.project_id, inv.id);
  if (existing) return existing;

  const q: PaymentQuestion = {
    project_id: inv.project_id,
    invoice_id: inv.id,
    invoice_number: inv.number,
    client_id: inv.client_id,
    asked_at: now.toISOString(),
    amount_due_when_asked: invoiceTotals(inv).amount_due,
    currency: inv.currency,
  };
  await getDomainStore().upsertRecord({
    project_id: inv.project_id,
    wedge: PAYMENTS_WEDGE,
    collection: QUESTION_COLLECTION,
    key: questionKey(inv.id),
    data: { ...q },
    case_id: inv.case_id,
  });
  return q;
}

/**
 * Record the founder's answer.
 *
 * Returns undefined when there was no question to answer — which is not an error, and is the common
 * case for the path that matters most: a founder who records a payment on an invoice we never got
 * round to asking about has answered a question we never asked.
 */
export async function answerPaymentQuestion(
  projectId: string,
  invoiceId: string,
  answer: PaymentAnswer,
  by: string,
  now: Date = new Date(),
): Promise<PaymentQuestion | undefined> {
  if (!projectId) throw new Error("answering a payment question must be scoped to a project");
  const existing = await getPaymentQuestion(projectId, invoiceId);
  if (!existing) return undefined;
  // First answer wins. A second click must not move `answered_at` forward, because the ladder reads
  // it to decide whether it has been told anything since the last chase.
  if (existing.answer) return existing;
  const answered: PaymentQuestion = { ...existing, answer, answered_at: now.toISOString(), answered_by: by || "founder" };
  await getDomainStore().upsertRecord({
    project_id: projectId,
    wedge: PAYMENTS_WEDGE,
    collection: QUESTION_COLLECTION,
    key: questionKey(invoiceId),
    data: { ...answered },
  });
  return answered;
}

/**
 * Answer the question as "paid" because a payment was just recorded — if one was open.
 *
 * RECORDING THE MONEY IS THE ANSWER. Making a founder record a payment and then separately dismiss a
 * question about that same payment is the kind of double bookkeeping that trains people to ignore the
 * question. Best effort and deliberately swallowed: a failure to close the question must never turn a
 * successfully recorded payment into an error, and the consequence of it failing is one stale
 * question on a screen, not a chase.
 */
async function answerPaymentQuestionIfOpen(
  projectId: string,
  invoiceId: string,
  answer: PaymentAnswer,
  by: string,
  now: Date,
): Promise<PaymentQuestion | undefined> {
  return answerPaymentQuestion(projectId, invoiceId, answer, by, now).catch((e) => {
    console.error(`[mycel] could not close the payment question for invoice ${invoiceId}:`, e);
    return undefined;
  });
}

/**
 * A client answered a chase. Stop chasing them and put it in front of the founder.
 *
 * ═══ THE BUG THIS PREVENTS ═══
 *
 * It is the founder's original question, and until inbound existed it was unanswerable. We email a
 * client demanding money; they reply "I paid on the 3rd, reference X"; nothing in the kernel can see
 * that reply; three days later the ladder sends the next rung, and on day 22 a `final_notice` goes to
 * somebody who settled in full three weeks ago. The client concludes the business does not read its
 * own email — which is worse than the embarrassment of chasing a paid invoice, because it is true.
 *
 * ═══ TWO EFFECTS, AND WHY BOTH ARE NEEDED ═══
 *
 *  1. `standDownChases` — the chase ALREADY IN FLIGHT. A chase is not an instant: a run may be
 *     mid-think or parked on the approval gate with the words already written. This is the same
 *     window `standDownChases` was built to close for a detected payment, reached from the other
 *     direction, and it is the same mechanism — deliberately, because a second cancellation path
 *     would be a second thing to get wrong and only one of them would be tested.
 *  2. The question row — the NEXT rung. Standing down what is in flight does nothing about the sweep
 *     at 03:00 tomorrow, which recomputes from the invoice and would chase again. The suppression has
 *     to be durable and it has to be readable by the sweep, so it lives on the same `PaymentQuestion`
 *     the founder already answers, and `paymentQuestionGate` reads it.
 *
 * ═══ AND WHY IT IS BOUNDED ═══
 *
 * By exactly the same argument as the grace window above, which is worth restating because the
 * temptation here is stronger: it is very tempting to say "a client who replied is never chased
 * again until a human looks". That is a permanent halt triggered by a stranger's email, i.e. anyone
 * who can write to the mailbox can switch off collections for an invoice indefinitely. After
 * `QUESTION_GRACE_HOURS` the ladder proceeds, carrying the fact of the reply into the chase's input
 * and its approval preview, where the human at the gate sees it before anything sends.
 *
 * Best-effort on the stand-down, loud on failure: an inbound must never 500 because a cancellation
 * could not be delivered — the message still has to land — but a stand-down that quietly did nothing
 * is precisely the failing-while-reporting-success shape this repo keeps paying for, so the refusal
 * is returned to the caller AND logged rather than swallowed.
 */
export async function noteClientReplyOnInvoice(
  inv: Invoice,
  reply: { thread_id?: string; body?: string },
  now: Date = new Date(),
): Promise<{ question: PaymentQuestion; stood_down: string[]; stand_down_refusal?: string }> {
  if (!inv.project_id) throw new Error("noting a client reply must be scoped to a project");

  const stand = await standDownChases(inv, "the client replied to the chase").catch((e) => {
    console.error(`[mycel] could not stand down chases for invoice ${inv.id} after a client reply:`, e);
    return { cancelled: [] as string[], reason: String((e as Error)?.message ?? e) };
  });
  if (stand.reason) console.warn(`[mycel] client replied about invoice ${inv.number} but ${stand.reason}`);

  // Ask, if we had not already. `askPaymentQuestion` is idempotent and never moves `asked_at`, so a
  // second reply on the same invoice extends nothing — see its own comment on why that matters.
  const asked = await askPaymentQuestion(inv, now);

  // Record the reply even on an already-answered question. A founder who said "not paid" on Monday
  // and gets a wire reference on Wednesday needs to see the Wednesday message; what the record must
  // NOT do is reopen the suppression, and it does not, because the gate checks `answer` first.
  const excerpt = (reply.body ?? "").replace(/\s+/g, " ").trim().slice(0, 240);
  const updated: PaymentQuestion = {
    ...asked,
    client_replied_at: now.toISOString(),
    ...(reply.thread_id ? { client_reply_thread_id: reply.thread_id } : {}),
    ...(excerpt ? { client_reply_excerpt: excerpt } : {}),
  };
  await getDomainStore().upsertRecord({
    project_id: inv.project_id,
    wedge: PAYMENTS_WEDGE,
    collection: QUESTION_COLLECTION,
    key: questionKey(inv.id),
    data: { ...updated },
  });

  return { question: updated, stood_down: stand.cancelled, ...(stand.reason ? { stand_down_refusal: stand.reason } : {}) };
}

export interface LadderGate {
  /** May the automatic ladder send on this invoice right now? */
  blocked: boolean;
  question?: PaymentQuestion;
  /** Always populated. A sentence for the sweep summary and the refusal message. */
  detail: string;
  /** Present once we have asked and heard nothing past the grace window. Travels into the chase. */
  unanswered_hours?: number;
}

/**
 * Should the ladder hold and ask, escalate anyway, or carry on?
 *
 * Called by `startChase` for `pacing: "ladder"` only. A human clicking Chase has already decided
 * something this cannot know, which is the same judgement every other override in dunning.ts makes.
 */
export async function paymentQuestionGate(inv: Invoice, now: Date = new Date()): Promise<LadderGate> {
  /**
   * ═══ A CLIENT WHO ANSWERED IS NEVER ESCALATED AT — CHECKED FIRST, DELIBERATELY ═══
   *
   * Above the confidence branch below, and that ordering is the whole point. The rest of this gate
   * only engages for `unverifiable` businesses, because asking a founder to compensate for a working
   * Stripe connection is asking them to do the integration's job. A client REPLY is different in
   * kind: it is new information from outside the system, and it is equally true of a business with
   * Stripe connected. Stripe not showing the money is a good reason to keep chasing in general and a
   * bad reason to keep chasing THIS WEEK, when the client has just written to say a bank transfer
   * left on Tuesday — which Stripe would never see at all.
   *
   * Suppresses only while the founder has not spoken and only inside the grace window. An answered
   * question falls straight through to the branches below, so a founder who has read the reply and
   * said "not paid" gets their ladder back immediately rather than waiting out the clock.
   */
  const replied = await getPaymentQuestion(inv.project_id, inv.id);
  if (replied?.client_replied_at && !replied.answer) {
    const since = Math.max(0, Math.floor((now.getTime() - Date.parse(replied.client_replied_at)) / 3_600_000));
    if (since < QUESTION_GRACE_HOURS) {
      return {
        blocked: true,
        question: replied,
        detail:
          `the client replied to us about ${inv.number} ${since}h ago and nobody has said whether it is settled — ` +
          `holding the ladder until then, and going ahead anyway after ${QUESTION_GRACE_HOURS}h`,
        unanswered_hours: since,
      };
    }
  }

  // Only where we are permanently blind. `fresh` means we looked and we know; `stale` and `unknown`
  // already halt the ladder in `startChase` and asking a founder to compensate for a broken Stripe
  // connection would be asking them to do the integration's job.
  const confidence = await paymentConfidence(inv.project_id, now).catch(() => undefined);
  if (confidence?.level !== "unverifiable") return { blocked: false, detail: "payment state is checkable for this business" };

  // Escalation, not the opening reminder. See the note above on why.
  if (!inv.last_chased_at) return { blocked: false, detail: "nothing has been sent about this invoice yet" };

  const existing = await getPaymentQuestion(inv.project_id, inv.id);
  if (existing?.answer) {
    return {
      blocked: false,
      question: existing,
      detail: `the founder was asked whether ${inv.number} had been paid and answered "${existing.answer}"`,
    };
  }

  if (!existing) {
    const asked = await askPaymentQuestion(inv, now);
    return {
      blocked: true,
      question: asked,
      detail: `before escalating ${inv.number}, we have asked whether it has already been paid — this business has no payment provider connected, so a bank transfer or cash would not show up here`,
    };
  }

  const hours = Math.max(0, Math.floor((now.getTime() - Date.parse(existing.asked_at)) / 3_600_000));
  if (hours < QUESTION_GRACE_HOURS) {
    return {
      blocked: true,
      question: existing,
      detail: `we asked ${hours}h ago whether ${inv.number} had been paid and have not heard back; the ladder escalates anyway after ${QUESTION_GRACE_HOURS}h`,
      unanswered_hours: hours,
    };
  }
  // THE GRACE HAS RUN OUT AND WE PROCEED. Never a permanent halt — see the note above.
  return {
    blocked: false,
    question: existing,
    detail: `we asked ${hours}h ago whether ${inv.number} had been paid and heard nothing, so the ladder is going ahead`,
    unanswered_hours: hours,
  };
}

// ═══════════════════════════ PAYMENT INSTRUCTIONS ═══════════════════════════
//
// "How do I pay you?" needs an answer that is not a Stripe link.
//
// `Invoice.payment_link_url` is a URL a founder pasted in by hand, per invoice, and it is the only
// thing the domain has ever been able to say about getting paid. For a business that takes bank
// transfers there is no URL to paste, so the field stays empty and the document says nothing at all —
// the client is left to find an email thread with the sort code in it. That is not a small gap: an
// invoice whose payment details are missing is an invoice that gets paid late, and then chased.
//
// These are configured ONCE for the business and appear on every issued document, which is the right
// cardinality: a sort code does not change per invoice. Free-form lines rather than typed banking
// fields on purpose — IBAN/BIC, sort code/account number, routing/account, PIX key and UPI id are
// genuinely different shapes per country, and a typed schema here would be a form that half the
// world cannot fill in correctly. The founder writes the lines their own clients need to read.

/** Six lines of 120 characters. Enough for the longest IBAN block; short enough to render. */
export const MAX_INSTRUCTION_LINES = 6;
export const MAX_INSTRUCTION_CHARS = 120;

export function normalizeInstructions(input: unknown): string[] {
  const raw = Array.isArray(input)
    ? input
    : typeof input === "string"
      ? input.split(/\r?\n/)
      : [];
  return raw
    .map((l) => String(l ?? "").trim().slice(0, MAX_INSTRUCTION_CHARS))
    .filter(Boolean)
    .slice(0, MAX_INSTRUCTION_LINES);
}

export async function getPaymentInstructions(projectId: string): Promise<string[]> {
  if (!projectId) throw new Error("reading payment instructions must be scoped to a project");
  const rows = await getDomainStore().queryRecords({
    project_id: projectId,
    wedge: PAYMENTS_WEDGE,
    collection: INSTRUCTIONS_COLLECTION,
    limit: 1,
  });
  return normalizeInstructions(rows[0]?.data?.lines);
}

export async function setPaymentInstructions(projectId: string, lines: unknown): Promise<string[]> {
  if (!projectId) throw new Error("setting payment instructions must be scoped to a project");
  const clean = normalizeInstructions(lines);
  // Preserve rails / currency / seller sitting on the same row. Writing `{ lines }` alone was how
  // a founder editing bank details the old way would silently turn Stripe and cash off.
  const rows = await getDomainStore().queryRecords({
    project_id: projectId,
    wedge: PAYMENTS_WEDGE,
    collection: INSTRUCTIONS_COLLECTION,
    limit: 1,
  });
  const prev = (rows[0]?.data ?? {}) as Record<string, unknown>;
  const rails = Array.isArray(prev.rails)
    ? (prev.rails as Record<string, unknown>[]).map((r) =>
        r && r.kind === "bank_transfer" ? { ...r, enabled: clean.length > 0, lines: clean } : r,
      )
    : undefined;
  await getDomainStore().upsertRecord({
    project_id: projectId,
    wedge: PAYMENTS_WEDGE,
    collection: INSTRUCTIONS_COLLECTION,
    key: "default",
    data: {
      ...prev,
      lines: clean,
      ...(rails ? { rails } : {}),
    },
  });
  return clean;
}

// ═══════════════════════════ THE RECEIPT ═══════════════════════════
//
// "When the client flagged as paid, you should send an invoice" — in context, the client should get
// confirmation that their money landed.
//
// TWO RULES, AND THEY ARE THE WHOLE DESIGN.
//
//   · IT IS OFFERED, NEVER AUTOMATIC. `recordManualPayment` returns a `ReceiptOffer`; it does not
//     send anything. A founder who marks an invoice paid has told us about money, not asked us to
//     email their client, and the gap between those two is where an unwanted email to a client of
//     somebody who paid in cash lives.
//
//   · AND IT GOES THROUGH THE ORDINARY APPROVAL PATH. `startReceipt` spawns a run exactly as
//     `startChase` does. The run writes the words and its send suspends on `awaitApproval` like every
//     other consequence in this kernel. Nothing here dispatches; it enqueues.
//
// The carrier is resolved by ROLE (`receipts`), never by directory name — see roles.ts for the seven
// hardcodes that rule exists because of.

/** The role a wedge declares to be able to send a receipt. Resolved through roles.ts, never named. */
export const RECEIPT_ROLE = "receipts" as const;
export const RECEIPT_TASK_TYPE = "send_receipt";

export interface ReceiptOffer {
  /** May a receipt be offered for this invoice right now? */
  available: boolean;
  /** A sentence. Always populated — on refusal it says what is missing and what would fix it. */
  detail: string;
}

/**
 * Can we offer to send a receipt for this invoice?
 *
 * Only for an invoice that is actually settled. A receipt for a part payment is a different document
 * making a different claim ("we have received £1,000 of £4,000"), and issuing the settled one against
 * a partly-paid invoice tells a client they owe nothing when they owe three quarters of it.
 */
export async function receiptOffer(inv: Invoice, totals: InvoiceTotals): Promise<ReceiptOffer> {
  if (totals.amount_due > 0) {
    return { available: false, detail: "a receipt is offered once the invoice is settled in full; this one is still part paid" };
  }
  const wedge = wedgeForRole(RECEIPT_ROLE);
  if (!wedge) return { available: false, detail: whyNoWedge(RECEIPT_ROLE) };
  if (!deps) return { available: false, detail: "receipts are not wired up in this deployment" };
  if (!deps.wedgeEnabled(inv.project_id, wedge)) {
    return { available: false, detail: `the ${wedge} wedge is not enabled for this business, so it cannot send a receipt` };
  }
  return { available: true, detail: "the client can be sent a receipt; it will wait for your approval before it goes" };
}

/**
 * What sending a receipt needs from the rest of the kernel.
 *
 * The same two capabilities `ChaseDeps` needs and for the same reason — spawning a run means clamping
 * constraints against the deployment's ceilings, and rendering a document means the brand kit and the
 * artifact backend, all of which live in server.ts. Registered from `mountInvoiceRoutes` alongside
 * `setChaseDeps` and `setReconcileDeps`, from the same objects, so a receipt run and a chase run
 * differ in nothing but their task type.
 */
export interface ReceiptDeps {
  wedgeEnabled(projectId: string, wedge: string): boolean;
  spawnTask(args: {
    project_id: string;
    wedge: string;
    task_type: string;
    client_id?: string;
    case_id?: string;
    source: TaskSource;
    input: Record<string, unknown>;
  }): Promise<string>;
  attachInvoiceDocument(args: {
    task_id: string;
    invoice: Invoice;
    format: "pdf" | "svg";
    kind?: "invoice" | "receipt";
  }): Promise<unknown>;
}

let deps: ReceiptDeps | null = null;
export function setReceiptDeps(d: ReceiptDeps | null): void {
  deps = d;
}

export type ReceiptRefusal = "not_configured" | "no_receipt_wedge" | "wedge_disabled" | "not_settled" | "spawn_failed";
export type ReceiptStart =
  | { ok: true; task_id: string; invoice_id: string; document: unknown }
  | { ok: false; reason: ReceiptRefusal; message: string };

/**
 * Send the client their receipt. Spawns a run; the send itself waits for approval.
 *
 * Not idempotent by a claim, unlike `startChase` — and that is a deliberate asymmetry, not an
 * oversight. A duplicate dunning email is a client relationship problem, which is why chasing is
 * gated by a compare-and-set on `last_chased_at`. A duplicate receipt is a founder pressing a button
 * twice, and the second one still has to pass a human at the approval gate before it reaches anybody.
 * Adding a claim column for it would be inventing a schema to defend against a harmless mistake that
 * a person is already standing in front of.
 */
export async function startReceipt(inv: Invoice, opts: { requested_by?: string; now?: Date } = {}): Promise<ReceiptStart> {
  const now = opts.now ?? new Date();
  if (!deps) return { ok: false, reason: "not_configured", message: "Receipts are not wired up in this deployment." };

  const wedge = wedgeForRole(RECEIPT_ROLE);
  if (!wedge) return { ok: false, reason: "no_receipt_wedge", message: `Nothing here sends receipts: ${whyNoWedge(RECEIPT_ROLE)}.` };
  if (!deps.wedgeEnabled(inv.project_id, wedge)) {
    return { ok: false, reason: "wedge_disabled", message: `The ${wedge} wedge is not enabled for this business.` };
  }
  const totals = invoiceTotals(inv);
  if (totals.amount_due > 0) {
    return { ok: false, reason: "not_settled", message: `${inv.number} is still part paid, so there is nothing to receipt yet.` };
  }

  const payments = await getBillingStore()
    .listExternalPayments({ project_id: inv.project_id, invoice_id: inv.id })
    .catch(() => [] as ExternalPayment[]);

  try {
    const taskId = await deps.spawnTask({
      project_id: inv.project_id,
      wedge,
      task_type: RECEIPT_TASK_TYPE,
      client_id: inv.client_id,
      case_id: inv.case_id,
      source: "api",
      input: {
        invoice_id: inv.id,
        invoice_number: inv.number,
        currency: inv.currency,
        total: totals.total,
        amount_paid: totals.amount_paid,
        paid_at: inv.paid_at,
        requested_by: opts.requested_by,
        today: now.toISOString().slice(0, 10),
        // How the money actually arrived, so the words can say "thank you for the transfer" rather
        // than something generic — and so the agent cannot invent a method the founder never recorded.
        payments: payments.map((p) => ({ amount_minor: p.amount_minor, paid_at: p.paid_at, method: p.method, reference: p.reference })),
      },
    });
    // A render failure must not lose the run: the thank-you is the point, the PDF is an enclosure.
    // Same trade as `startChase`.
    const document = await deps
      .attachInvoiceDocument({ task_id: taskId, invoice: inv, format: "pdf", kind: "receipt" })
      .catch(() => undefined);
    return { ok: true, task_id: taskId, invoice_id: inv.id, document: document ?? null };
  } catch (e) {
    console.error(`[mycel] failed to start a receipt for invoice ${inv.id}:`, e);
    return { ok: false, reason: "spawn_failed", message: "The receipt could not be started." };
  }
}

/** Throwing counterpart, for a caller that has already established the role exists. */
export const requireReceiptWedge = (): string => requireWedgeForRole(RECEIPT_ROLE);

/** Test seam: a fresh entry id, for callers that legitimately have no client-minted one. */
export const newEntryId = (): string => randomUUID();
