// The founder's accounts-receivable: invoice arithmetic, the status machine, and the store behind
// both. The contract types live in contract.ts; everything that has an opinion about money lives
// here, in one file, so there is exactly one implementation of "what does this invoice total".
//
// Read the MONEY comment on `Invoice` in contract.ts first. Short version: every amount in this
// file is a whole number of minor units, and nothing here ever produces a float.
import { randomUUID } from "node:crypto";
import { databaseUrl } from "./config";
import type { Invoice, InvoiceLine, InvoiceStatus } from "./contract";

/**
 * ═══════════════════════════ PAYMENT_SEAM ═══════════════════════════
 *
 * Mycel does not collect. Taking money on behalf of a third party is a regulated posture, and
 * `Invoice.payment_link_url` is a URL, not a merchant account.
 *
 * What changed: the URL is no longer something a founder pastes per invoice. `payments.rails.ts`
 * is how this business gets paid (card, bank transfer, cash); `payments.stripe.ts` generates a
 * Checkout Session with inline `price_data` (integer minor units, no Product, no Price) through
 * the founder's own connected Stripe, and a webhook/poll settles the invoice through the same
 * `applyExternalPayment` ledger. Money still lands in the founder's account. The kernel still
 * moves none of it.
 *
 * `paymentLinkFor` remains the single seam for "where does a client pay online". It refuses on
 * drafts and voids. The generated URL is stored on the invoice so every surface — document,
 * portal, chase, issue email — reads the same string.
 */
export function paymentLinkFor(inv: Invoice): string | undefined {
  // Never on a draft — a link to pay something that hasn't been issued is a support ticket.
  return inv.status === "draft" || inv.status === "void" ? undefined : inv.payment_link_url;
}

/**
 * How many minor units make one major unit, by currency.
 *
 * ISO-4217 exponents. Only the exceptions are listed; everything else is 2. This is the ONLY place
 * that knows, and the value is handed to the portal in the invoice payload so a browser can format
 * ¥1250 and $12.50 correctly without shipping a currency table to it.
 */
const ZERO_DECIMAL = new Set(["JPY", "KRW", "VND", "CLP", "ISK", "PYG", "RWF", "UGX", "VUV", "XAF", "XOF", "XPF", "KMF", "DJF", "GNF", "MGA", "BIF"]);
const THREE_DECIMAL = new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]);

export function minorUnitExponent(currency: string): number {
  const c = (currency || "").toUpperCase();
  if (ZERO_DECIMAL.has(c)) return 0;
  if (THREE_DECIMAL.has(c)) return 3;
  return 2;
}

/**
 * Integer division, rounded half-up, away from zero.
 *
 * `Math.round(n / d)` would go through a float, which is the one thing this file promises not to do,
 * and it rounds -0.5 to -0! Credit lines are negative, so that asymmetry is not hypothetical.
 */
function divRoundHalfUp(n: number, d: number): number {
  const neg = n < 0;
  const a = neg ? -n : n;
  const q = Math.trunc(a / d);
  const r = a - q * d;
  const out = r * 2 >= d ? q + 1 : q;
  return neg ? -out : out;
}

/** A line's charge before tax, in minor units. `fixed` lines are quantity 1 by definition. */
export function lineAmount(l: InvoiceLine): number {
  const qty = l.kind === "fixed" ? 1000 : Math.trunc(l.quantity_milli ?? 0);
  return divRoundHalfUp(qty * Math.trunc(l.unit_amount ?? 0), 1000);
}

/** A line's tax, in minor units. Rounded PER LINE, which is what tax authorities and every
 *  accounting package do — rounding the sum instead can differ by a penny on a long invoice. */
export function lineTax(l: InvoiceLine): number {
  return l.tax_bps ? divRoundHalfUp(lineAmount(l) * Math.trunc(l.tax_bps), 10_000) : 0;
}

export interface InvoiceTotals {
  subtotal: number;
  tax_total: number;
  total: number;
  amount_paid: number;
  /** What is actually owed. Never negative — an overpayment is a credit, not a debt of ours. */
  amount_due: number;
}

export function invoiceTotals(inv: Pick<Invoice, "lines" | "amount_paid">): InvoiceTotals {
  let subtotal = 0;
  let tax_total = 0;
  for (const l of inv.lines ?? []) {
    subtotal += lineAmount(l);
    tax_total += lineTax(l);
  }
  const total = subtotal + tax_total;
  const amount_paid = Math.trunc(inv.amount_paid ?? 0);
  return { subtotal, tax_total, total, amount_paid, amount_due: Math.max(0, total - amount_paid) };
}

/**
 * The status machine.
 *
 * An allowlist of legal moves, enforced in the store as part of the UPDATE's WHERE clause rather
 * than read-check-write, so two operators clicking "void" and "mark paid" at the same time cannot
 * both win. `paid` and `void` are terminal on purpose: un-paying an invoice is a credit note, which
 * is a different document with its own audit trail, not an edit to this one.
 */
export const INVOICE_TRANSITIONS: Readonly<Record<InvoiceStatus, readonly InvoiceStatus[]>> = {
  draft: ["sent", "void"],
  sent: ["paid", "overdue", "void"],
  // Back to `sent` is legal: a client who agrees a payment plan is no longer in dunning, and the
  // alternative is an invoice permanently flagged overdue while the business is happy with it.
  overdue: ["paid", "sent", "void"],
  paid: [],
  void: [],
};

export function canTransition(from: InvoiceStatus, to: InvoiceStatus): boolean {
  return (INVOICE_TRANSITIONS[from] ?? []).includes(to);
}

/**
 * The status a human would say out loud.
 *
 * `overdue` is a fact about the clock, not a decision anyone makes, so it is derived on every read
 * as well as being storable. Deriving it means the client portal and the invoice-chaser agree the
 * moment midnight passes, with no sweep job that can be down. Storing it means an operator can also
 * flag something overdue early, and that the chaser has a stable field to filter on.
 */
export function effectiveStatus(inv: Pick<Invoice, "status" | "due_date" | "lines" | "amount_paid">, todayIso?: string): InvoiceStatus {
  if (inv.status !== "sent") return inv.status;
  if (!inv.due_date) return "sent";
  const today = (todayIso ?? new Date().toISOString()).slice(0, 10);
  if (inv.due_date >= today) return "sent";
  return invoiceTotals(inv).amount_due > 0 ? "overdue" : "sent";
}

/** How many days past due, for the dunning ladder. Negative means not due yet. */
export function daysOverdue(inv: Pick<Invoice, "due_date">, nowMs = Date.now()): number {
  if (!inv.due_date) return 0;
  const due = Date.parse(`${inv.due_date}T00:00:00Z`);
  if (Number.isNaN(due)) return 0;
  return Math.floor((nowMs - due) / 86_400_000);
}

/**
 * Whole days between two YYYY-MM-DD dates. Integer arithmetic on UTC midnights, so no DST drift.
 *
 * Signed — the caller clamps deliberately. Lives here beside the rest of the invoice arithmetic
 * rather than in `invoices.routes.ts` (which re-exports it, so its existing callers are unchanged)
 * because the dunning sweep needs the same function, and `days_overdue` computed two ways is
 * `days_overdue` that eventually disagrees between the chase a human started and the chase the
 * sweep started — on the one number the escalation ladder branches on.
 */
export function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(`${fromIso}T00:00:00Z`);
  const b = Date.parse(`${toIso}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

export interface InvoiceFilter {
  /**
   * TENANT SCOPE, REQUIRED, and it still fails closed exactly like `listCases`/`queryRecords`:
   * pass it and you get only rows whose project_id is exactly that string. Callers holding one
   * project (the portal, the action proxy) MUST push it down here rather than filter the result,
   * because a post-filter only protects the rows the query happened to return and leaks the moment
   * a `limit` truncates. Required rather than optional because "the caller will remember" is the
   * assumption that produced the leak in the first place.
   */
  project_id: string;
  client_id?: string;
  case_id?: string;
  status?: InvoiceStatus;
  limit?: number;
}

export type NewInvoice = Omit<Invoice, "id" | "created_at" | "updated_at" | "number" | "amount_paid"> & {
  number?: string;
  amount_paid?: number;
};

/** The mutable half. Status has its own method; money received has its own method. */
export type InvoicePatch = Partial<
  Pick<Invoice, "lines" | "currency" | "due_date" | "issue_date" | "note" | "internal_note" | "payment_link_url" | "case_id">
>;

/**
 * How the money actually arrived.
 *
 * ═══ WHY THIS IS A CLOSED SET AND WHY `bank_transfer` IS FIRST ═══
 *
 * Most small service businesses are not paid through Stripe. They are paid by bank transfer, and
 * after that in cash. Until this existed the kernel could only describe money it had READ FROM A
 * PROVIDER — `ExternalPayment.source` was "the connection it was read from" — so the majority case
 * had no vocabulary at all: a founder who was handed £400 in cash could add 40000 to `amount_paid`
 * and nothing anywhere recorded what had actually happened. That matters later, in two concrete
 * places. A client ringing up to ask "which payment did you apply to March?" gets a number and no
 * answer. And a reconciliation that one day DOES see the bank feed cannot tell that the transfer it
 * just read is the same money a human already keyed in by hand.
 *
 * `other` exists so the list can stay closed. An open string would collect "BACS", "bacs",
 * "Bank Transfer " and "transfer" as four distinct methods within a month, and the first thing anyone
 * wants to do with this column is count by it.
 */
export const PAYMENT_METHODS = ["bank_transfer", "cash", "cheque", "card", "other"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const isPaymentMethod = (v: unknown): v is PaymentMethod =>
  typeof v === "string" && (PAYMENT_METHODS as readonly string[]).includes(v);

/**
 * A payment observed in a payment provider, on its way to becoming `amount_paid`.
 *
 * `external_id` is the provider's own immutable id for the money movement (a Stripe charge or
 * payment-intent id). It is the idempotency key, and it is the reason this type exists rather than
 * reconciliation just calling `recordPayment`: the reconciliation loop runs hourly and re-reads the
 * same window of Stripe history every time, so without a durable record of what has already been
 * applied, a £4,000 invoice is £4,000 paid at 09:00, £8,000 at 10:00 and £96,000 by midnight. The
 * invoice would go `paid` on the first pass and the overcount would never be visible on any screen
 * — it is a number in a column nobody reads once the status is green.
 */
export interface ExternalPayment {
  /** TENANT SCOPE. Part of the idempotency key AND part of the UPDATE's WHERE clause. */
  project_id: string;
  invoice_id: string;
  /** The provider's id for this money movement. Unique per project; the idempotency key. */
  external_id: string;
  /**
   * Integer minor units. NEGATIVE for a refund — a refund is a payment that went the other way, and
   * modelling it as one means `amount_due` corrects itself through the same atomic add rather than
   * through a second code path that has to remember to subtract.
   */
  amount_minor: number;
  /** ISO-4217, upper. Checked against the invoice's currency by the caller; see payments.ts. */
  currency: string;
  /**
   * When the money moved, ISO-8601 — NOT when we were told about it.
   *
   * For a provider read this is the provider's timestamp. For a payment a human records it is the
   * date the human says the money arrived, which is routinely NOT today: somebody is handed cash on
   * Tuesday and gets round to keying it in on Friday. Those three days are not a rounding error,
   * they are the difference between an invoice that was settled before it went overdue and one that
   * we were right to chase. See `recordManualPayment`, which stamps the invoice's `paid_at` from
   * this field for exactly that reason.
   */
  paid_at: string;
  /** How this was tied to the invoice — `reference`, `amount_and_date`, or `human`. */
  basis: string;
  /** The connection it was read from, or who recorded it by hand. For the audit trail. */
  source: string;
  /**
   * How the money arrived, when anyone knows. Undefined on a provider read, where the answer is
   * implicit in the connection, and always set on a payment a human records.
   */
  method?: PaymentMethod;
  /**
   * What the payer quoted, as the human transcribed it: a bank transfer reference, a cheque number.
   *
   * Free text and deliberately not matched on. `match.ts` refuses to guess for good reasons, and a
   * reference somebody typed off a bank statement is precisely the input that would make it start.
   * This is here so a person answering "which payment was that?" has the string in front of them.
   */
  reference?: string;
}

export interface ExternalPaymentResult {
  /** True when this call actually moved money. False means we had already applied it. */
  applied: boolean;
  /** The invoice as it now stands. Undefined when the invoice does not exist in this project. */
  invoice?: Invoice;
}

/**
 * When a project's payment state was last actually checked against the outside world.
 *
 * THE POINT OF THIS ROW: a dunning ladder is a machine that assumes an invoice is unpaid. That
 * assumption is only as good as the last time anybody looked, and until this existed nothing in the
 * kernel could distinguish "we checked ten minutes ago and it is genuinely unpaid" from "no payment
 * provider has ever been connected and we have never once looked". Both presented to the chase as an
 * invoice with `amount_due > 0`. The second is the case where an automated, escalating chase gets
 * sent to a client who paid by bank transfer three weeks ago, and it is the failure this whole
 * mechanism exists to make impossible-to-do-silently.
 */
export interface PaymentCheck {
  project_id: string;
  /** When a reconciliation last COMPLETED. Absent means: nobody has ever successfully looked. */
  confirmed_at?: string;
  /** When one last ran at all, successful or not. Always set. */
  attempted_at: string;
  /** Did the last attempt actually reach the provider and read something? */
  ok: boolean;
  /** A sentence a founder can act on. Never empty — a failure with no reason is the bug this repo keeps having. */
  detail: string;
}

/**
 * ONE PERIOD OF ONE RETAINER, BILLED — the idempotency ledger for recurring revenue.
 *
 * ═══ WHY THIS IS A ROW AND NOT A FIELD ON THE MONEY PLAN ═══
 *
 * The obvious design is an array of billed periods on the retainer line inside `Case.data`. It is
 * wrong, and the way it is wrong is the expensive way. `updateCase` is a read-modify-write with no
 * compare-and-set, so two replicas sweeping in the same second both read a plan with March missing,
 * both draft March, and both write their own array back — one silently overwriting the other. The
 * client gets two March invoices and the database records one. This table cannot do that: the unique
 * index below is checked by Postgres inside the INSERT, so the second writer loses before it has
 * drafted anything.
 *
 * `period_key` is the period's start date and is a PURE FUNCTION of the line's recurrence, so a
 * restart, a replica, a re-run and a founder's button all compute the same key for March. That is
 * the property the whole feature rests on.
 */
export interface RetainerPeriodRow {
  project_id: string;
  case_id: string;
  line_id: string;
  /** Period start, YYYY-MM-DD. Half of the unique key, and never derived from a clock. */
  period_key: string;
  /** Exclusive period end, for the audit trail. Never part of the key. */
  period_end: string;
  amount_minor: number;
  currency: string;
  claimed_at: string;
  /** Set once the draft exists. NULL means a claim whose draft has not landed (or threw). */
  invoice_id?: string;
}

export interface BillingStore {
  createInvoice(i: NewInvoice): Promise<Invoice>;
  getInvoice(id: string): Promise<Invoice | undefined>;
  listInvoices(f: InvoiceFilter): Promise<Invoice[]>;
  updateInvoice(id: string, patch: InvoicePatch): Promise<Invoice | undefined>;
  /**
   * Move an invoice's status, atomically.
   *
   * `allowedFrom` becomes part of the WHERE clause, so an illegal or already-taken transition
   * returns undefined rather than overwriting a decision someone else just made. Returns undefined
   * for "no such invoice" too; the caller distinguishes with a read, which it needs anyway to say
   * something useful.
   */
  transitionInvoice(
    id: string,
    to: InvoiceStatus,
    allowedFrom: readonly InvoiceStatus[],
    stamps?: Partial<Pick<Invoice, "issue_date" | "sent_at" | "paid_at" | "voided_at">>,
  ): Promise<Invoice | undefined>;
  /**
   * Add to `amount_paid`, atomically.
   *
   * THE GUARANTEE, and the reason this isn't `updateInvoice`: concurrent payments never lose one.
   * Read-merge-write means two $500 payments landing together both read 0 and both write 500, and
   * the business has quietly written off $500. On Postgres this is `amount_paid = amount_paid + $2`
   * in a single statement — the same reasoning as `DomainStore.bumpPacing`.
   */
  recordPayment(id: string, amountMinor: number): Promise<Invoice | undefined>;
  /**
   * Apply a payment observed in a payment provider — AT MOST ONCE, ever.
   *
   * THE GUARANTEE, and the only reason this is not `recordPayment` with a check in front of it:
   * remembering the external id and adding the money are ONE statement. A check-then-add has a
   * window, and the two things that fit through it are both real — an hourly reconciliation
   * overlapping its own previous run under a slow Stripe, and a Composio webhook arriving for the
   * same charge the poll is mid-way through applying. On Postgres this is a CTE: the insert's
   * `ON CONFLICT DO NOTHING` either yields a row (and the UPDATE adds the money) or yields nothing
   * (and the UPDATE matches no row). There is no ordering in which money is counted twice, and none
   * in which it is remembered but not counted.
   *
   * `project_id` is in the UPDATE's WHERE clause as well as the key. A reconciliation handed an
   * invoice id belonging to another tenant adds nothing and returns `invoice: undefined` — the
   * caller then reports a failure rather than a quiet no-op. See payments.ts.
   *
   * Returns `{ applied: false }` for a payment already seen. That is a SUCCESS, not an error: it is
   * the mechanism working.
   */
  applyExternalPayment(p: ExternalPayment): Promise<ExternalPaymentResult>;
  /** Every external payment applied to one invoice, newest first. The audit trail behind `amount_paid`. */
  listExternalPayments(args: { project_id: string; invoice_id: string }): Promise<ExternalPayment[]>;
  /** When this project's payment state was last checked. See `PaymentCheck`. */
  getPaymentCheck(projectId: string): Promise<PaymentCheck | undefined>;
  /** Record an attempt to check payment state, successful or not. Both outcomes are written. */
  recordPaymentCheck(check: PaymentCheck): Promise<PaymentCheck>;
  /**
   * Take the right to chase this invoice, atomically. Returns the invoice on success, `undefined`
   * when someone else already holds it.
   *
   * THE GUARANTEE: across N worker replicas, at most one caller wins per pacing window. The test
   * (`last_chased_at IS NULL OR last_chased_at <= $2`) and the write (`last_chased_at = $3`) are one
   * statement, so there is no window between "is this due a chase" and "mark it chased" for a second
   * replica to fit through. This is `transitionInvoice`'s trick — the guard in the WHERE clause, not
   * in an `if` above it — applied to pacing instead of status.
   *
   * `notChasedSince` is the caller's pacing decision: claim only if the last chase was at or before
   * this instant. `dunning.ts` derives it from the wedge's escalation ladder, so an invoice one day
   * overdue and one thirty days overdue get different cadences from the same primitive.
   *
   * A won claim that then fails to SPAWN a run is NOT rolled back. The invoice simply waits out one
   * interval — the failure mode of a claim that releases on error is two replicas racing the
   * release, and a missed chase is cheaper than a duplicate one. A claim whose run was spawned and
   * then FAILED is a different case; see `releaseInvoiceChaseClaim`.
   */
  claimInvoiceForChase(id: string, notChasedSince: string, at: string): Promise<Invoice | undefined>;
  /**
   * Give a chase claim back, because the run it was taken for did nothing.
   *
   * ═══ WHY THIS EXISTS — OBSERVED IN PRODUCTION ═══
   *
   * A chase run completed having created no approval and sent nothing, and the claim it had already
   * won kept a $4,800 unpaid invoice out of the ranked next-move list for three days. A claim is a
   * loan taken to serialise four worker replicas, not a record that a client was contacted, and a
   * loan that is never returned when the work does not happen is how the failure hides itself.
   *
   * ═══ COMPARE-AND-SET, AND WHY IT MUST BE ═══
   *
   * `claimedAt` is the exact stamp this run won, and it is the WHERE guard. It is what makes the
   * release safe against the race that argued against rolling back in the first place: if a later
   * chase (another replica, a founder clicking Chase, the next sweep) has already re-stamped the
   * row, this release finds no row to update and does nothing — it cannot un-chase somebody else's
   * chase, which would be a duplicate dunning email at the next tick.
   *
   * `restoreTo` is the value the row held BEFORE the claim (`undefined` for never chased), so the
   * ladder ends up exactly where it would have been had the run never started. Not `now`, and not
   * null-always: a chase that genuinely went out last Tuesday must keep saying so.
   *
   * Returns whether a row was actually released, so the caller can say something true.
   */
  releaseInvoiceChaseClaim(id: string, claimedAt: string, restoreTo?: string): Promise<boolean>;
  /**
   * Take the right to bill ONE period of ONE retainer — AT MOST ONCE, EVER.
   *
   * THE GUARANTEE, and it is the strongest one in this file because it is the only one whose failure
   * charges a real client twice: the insert carries `ON CONFLICT DO NOTHING` on
   * `(project_id, case_id, line_id, period_key)`, so of N callers presenting the same period exactly
   * one is told `claimed: true`. There is no read-then-write, so there is no window. A restart, a
   * second replica, a re-fired schedule, a founder clicking a button and a retried sweep are all the
   * same case and all lose to the index.
   *
   * `claimed: false` is a SUCCESS, not an error — it is the mechanism working — and the existing row
   * comes back with it so the caller can name the invoice that already covers the period.
   *
   * `project_id` is part of the key rather than only a filter: case ids are ours and unique, but a
   * global key would let one tenant's period suppress another's, and a demand for money that never
   * arrives is as bad as one that arrives twice.
   */
  claimRetainerPeriod(row: Omit<RetainerPeriodRow, "invoice_id">): Promise<{ claimed: boolean; existing?: RetainerPeriodRow }>;
  /** Attach the drafted invoice to a claim we hold. Project-scoped in the WHERE clause. */
  recordRetainerInvoice(args: {
    project_id: string;
    case_id: string;
    line_id: string;
    period_key: string;
    invoice_id: string;
  }): Promise<boolean>;
  /**
   * Give a period claim back, because the draft it was taken for never happened.
   *
   * COMPARE-AND-SET on our own `claimed_at` AND on `invoice_id IS NULL`, for the reason
   * `releaseInvoiceChaseClaim` documents one file over: a release that is not guarded cannot tell
   * "my draft failed" from "somebody else has since billed this period", and the unguarded version
   * un-bills their invoice and lets the next sweep raise a second one.
   */
  releaseRetainerPeriod(args: {
    project_id: string;
    case_id: string;
    line_id: string;
    period_key: string;
    claimed_at: string;
  }): Promise<boolean>;
  /** The billing history of a retainer, newest period first. What the founder's screen reads. */
  listRetainerPeriods(args: {
    project_id: string;
    case_id?: string;
    line_id?: string;
    limit?: number;
  }): Promise<RetainerPeriodRow[]>;
  /** Drafts only — enforced by the route, because deleting an issued invoice is a void, not a delete. */
  deleteInvoice(id: string): Promise<boolean>;
  /** Next reference for a project. Monotonic per project; never reused. */
  nextInvoiceNumber(projectId: string): Promise<string>;
  close?(): Promise<void>;
}

const now = () => new Date().toISOString();

/** Ids on lines are ours, not the caller's — a client-supplied line id is a way to collide two lines. */
export function normalizeLines(lines: unknown): InvoiceLine[] {
  if (!Array.isArray(lines)) return [];
  return lines.map((raw) => {
    const l = (raw ?? {}) as Record<string, unknown>;
    const kind = l.kind === "unit" ? "unit" : "fixed";
    return {
      id: randomUUID(),
      description: String(l.description ?? "").slice(0, 500),
      kind,
      // A `fixed` line is one of something by definition; accepting a quantity there would let an
      // invoice say "1 × retainer" and total three times that.
      quantity_milli: kind === "fixed" ? 1000 : Math.trunc(Number(l.quantity_milli ?? 1000)) || 0,
      unit_amount: Math.trunc(Number(l.unit_amount ?? 0)) || 0,
      tax_bps: l.tax_bps === undefined || l.tax_bps === null ? undefined : Math.trunc(Number(l.tax_bps)) || 0,
      task_ids: Array.isArray(l.task_ids) ? (l.task_ids as unknown[]).map(String).slice(0, 50) : undefined,
    } satisfies InvoiceLine;
  });
}

export class InMemoryBillingStore implements BillingStore {
  private invoices = new Map<string, Invoice>();
  private counters = new Map<string, number>();
  /** Keyed `project_id external_id` — the same composite the Postgres unique index uses. */
  private external = new Map<string, ExternalPayment>();
  private checks = new Map<string, PaymentCheck>();
  /** Keyed exactly like the Postgres unique index — see `retainerKey`. */
  private retainers = new Map<string, RetainerPeriodRow>();

  async nextInvoiceNumber(projectId: string): Promise<string> {
    const n = (this.counters.get(projectId) ?? 0) + 1;
    this.counters.set(projectId, n);
    return `INV-${String(n).padStart(4, "0")}`;
  }

  async createInvoice(i: NewInvoice): Promise<Invoice> {
    const inv: Invoice = {
      ...i,
      id: randomUUID(),
      number: i.number ?? (await this.nextInvoiceNumber(i.project_id)),
      amount_paid: i.amount_paid ?? 0,
      created_at: now(),
      updated_at: now(),
    };
    this.invoices.set(inv.id, inv);
    return inv;
  }

  async getInvoice(id: string): Promise<Invoice | undefined> {
    return this.invoices.get(id);
  }

  async listInvoices(f: InvoiceFilter): Promise<Invoice[]> {
    return [...this.invoices.values()]
      .filter(
        (v) =>
          // Tenant scope first, and strict. An invoice is money; "visible to everyone by accident"
          // is not a failure mode this row type gets to have.
          v.project_id === f.project_id &&
          (!f.client_id || v.client_id === f.client_id) &&
          (!f.case_id || v.case_id === f.case_id) &&
          (!f.status || v.status === f.status),
      )
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
      .slice(0, f.limit ?? 200);
  }

  async updateInvoice(id: string, patch: InvoicePatch): Promise<Invoice | undefined> {
    const v = this.invoices.get(id);
    if (!v) return undefined;
    for (const [k, val] of Object.entries(patch)) {
      if (val !== undefined) (v as unknown as Record<string, unknown>)[k] = val;
    }
    v.updated_at = now();
    return v;
  }

  async transitionInvoice(
    id: string,
    to: InvoiceStatus,
    allowedFrom: readonly InvoiceStatus[],
    stamps: Partial<Pick<Invoice, "issue_date" | "sent_at" | "paid_at" | "voided_at">> = {},
  ): Promise<Invoice | undefined> {
    const v = this.invoices.get(id);
    // No `await` between the read and the write: on a single-threaded event loop that makes this
    // indivisible, which is the memory-store equivalent of the SQL guard.
    if (!v || !allowedFrom.includes(v.status)) return undefined;
    v.status = to;
    for (const [k, val] of Object.entries(stamps)) {
      if (val !== undefined) (v as unknown as Record<string, unknown>)[k] = val;
    }
    v.updated_at = now();
    return v;
  }

  async recordPayment(id: string, amountMinor: number): Promise<Invoice | undefined> {
    const v = this.invoices.get(id);
    if (!v) return undefined;
    v.amount_paid = Math.trunc(v.amount_paid) + Math.trunc(amountMinor);
    v.updated_at = now();
    return v;
  }

  async applyExternalPayment(p: ExternalPayment): Promise<ExternalPaymentResult> {
    // No `await` anywhere between the duplicate check and the add — indivisible on a single-threaded
    // event loop, which is this store's equivalent of the Postgres CTE. Same reasoning as
    // `transitionInvoice`; here getting it wrong counts a client's money twice.
    if (!p.project_id) throw new Error("an external payment must be scoped to a project");
    const key = `${p.project_id} ${p.external_id}`;
    if (this.external.has(key)) return { applied: false, invoice: this.invoices.get(p.invoice_id) };
    const v = this.invoices.get(p.invoice_id);
    // TENANCY, and it fails closed: an invoice in another project is not found, not "found and
    // updated". Mirrors `project_id = $n` in the Postgres UPDATE's WHERE clause.
    if (!v || v.project_id !== p.project_id) return { applied: false, invoice: undefined };
    this.external.set(key, { ...p });
    v.amount_paid = Math.trunc(v.amount_paid) + Math.trunc(p.amount_minor);
    v.updated_at = now();
    return { applied: true, invoice: v };
  }

  async listExternalPayments(args: { project_id: string; invoice_id: string }): Promise<ExternalPayment[]> {
    return [...this.external.values()]
      .filter((p) => p.project_id === args.project_id && p.invoice_id === args.invoice_id)
      .sort((a, b) => (a.paid_at < b.paid_at ? 1 : -1));
  }

  async getPaymentCheck(projectId: string): Promise<PaymentCheck | undefined> {
    return this.checks.get(projectId);
  }

  async recordPaymentCheck(check: PaymentCheck): Promise<PaymentCheck> {
    if (!check.project_id) throw new Error("a payment check must be scoped to a project");
    // `confirmed_at` only ever moves forward, and a failed attempt must not erase the last good one:
    // the chase's staleness rule reads it, and clearing it on a transient Stripe 503 would flip every
    // invoice in the project to "never verified" and stop all chasing. Attempted vs confirmed is
    // exactly that distinction.
    const prev = this.checks.get(check.project_id);
    const next: PaymentCheck = { ...check, confirmed_at: check.confirmed_at ?? prev?.confirmed_at };
    this.checks.set(check.project_id, next);
    return next;
  }

  async claimInvoiceForChase(id: string, notChasedSince: string, at: string): Promise<Invoice | undefined> {
    const v = this.invoices.get(id);
    if (!v) return undefined;
    // No `await` between the read and the write — indivisible on a single-threaded event loop, the
    // memory-store equivalent of the SQL guard. Same reasoning as `transitionInvoice` above.
    if (v.last_chased_at !== undefined && v.last_chased_at > notChasedSince) return undefined;
    v.last_chased_at = at;
    v.updated_at = now();
    return v;
  }

  async releaseInvoiceChaseClaim(id: string, claimedAt: string, restoreTo?: string): Promise<boolean> {
    const v = this.invoices.get(id);
    if (!v) return false;
    // The compare — no `await` between it and the write, exactly as the claim above. A row somebody
    // else has since re-stamped is not ours to release. See the interface doc for why that matters.
    if (v.last_chased_at !== claimedAt) return false;
    v.last_chased_at = restoreTo;
    v.updated_at = now();
    return true;
  }

  /**
   * The memory-store form of the unique index. `set` only if `has` is false, with NO `await` between
   * them, so it is indivisible on a single-threaded event loop for exactly the reason
   * `claimInvoiceForChase` gives — and the key is composed identically to the Postgres index, so a
   * memory-backed test genuinely exercises the guarantee rather than a friendlier approximation.
   */
  async claimRetainerPeriod(
    row: Omit<RetainerPeriodRow, "invoice_id">,
  ): Promise<{ claimed: boolean; existing?: RetainerPeriodRow }> {
    if (!row.project_id) throw new Error("a retainer period must be scoped to a project");
    const key = retainerKey(row);
    const existing = this.retainers.get(key);
    if (existing) return { claimed: false, existing: { ...existing } };
    this.retainers.set(key, { ...row });
    return { claimed: true };
  }

  async recordRetainerInvoice(args: {
    project_id: string;
    case_id: string;
    line_id: string;
    period_key: string;
    invoice_id: string;
  }): Promise<boolean> {
    const row = this.retainers.get(retainerKey(args));
    if (!row || row.project_id !== args.project_id) return false;
    row.invoice_id = args.invoice_id;
    return true;
  }

  async releaseRetainerPeriod(args: {
    project_id: string;
    case_id: string;
    line_id: string;
    period_key: string;
    claimed_at: string;
  }): Promise<boolean> {
    const key = retainerKey(args);
    const row = this.retainers.get(key);
    // Both guards, matching the SQL: not ours to release, or already billed by someone.
    if (!row || row.project_id !== args.project_id) return false;
    if (row.claimed_at !== args.claimed_at || row.invoice_id) return false;
    this.retainers.delete(key);
    return true;
  }

  async listRetainerPeriods(args: {
    project_id: string;
    case_id?: string;
    line_id?: string;
    limit?: number;
  }): Promise<RetainerPeriodRow[]> {
    if (!args.project_id) throw new Error("listing retainer periods must be scoped to a project");
    return [...this.retainers.values()]
      .filter(
        (r) =>
          r.project_id === args.project_id &&
          (!args.case_id || r.case_id === args.case_id) &&
          (!args.line_id || r.line_id === args.line_id),
      )
      .sort((a, b) => (a.period_key < b.period_key ? 1 : -1))
      .slice(0, args.limit ?? 200)
      .map((r) => ({ ...r }));
  }

  async deleteInvoice(id: string): Promise<boolean> {
    return this.invoices.delete(id);
  }
}

/** The composite key, in one place, so the two stores cannot disagree about what "the same period" is. */
function retainerKey(r: { project_id: string; case_id: string; line_id: string; period_key: string }): string {
  return `${r.project_id} ${r.case_id} ${r.line_id} ${r.period_key}`;
}

// Process-wide singleton, the same shape as the domain and portal stores: synchronous accessor for
// the hot paths, one awaited init at boot to swap in the durable backend.
let cached: BillingStore | null = null;

export function getBillingStore(): BillingStore {
  if (!cached) cached = new InMemoryBillingStore();
  return cached;
}

export async function initBillingStore(): Promise<{ backend: string }> {
  const url = databaseUrl();
  // A configured database is always used, and a failure to reach it fails the boot.
  //
  // This used to throw unconditionally, because there was no Postgres backend. The reasoning behind
  // that throw is still the reasoning behind this branch: quietly falling back to the in-memory
  // store when a database IS configured gives a process that accepts writes, answers reads correctly
  // for its own lifetime, and loses everything on the next deploy. For invoices that is money — the
  // kind of loss you discover weeks later with no way to reconstruct it. So there is no `catch` here
  // either; a database that is configured but unreachable must stop the process, not degrade it.
  //
  // In-memory remains the correct backend when no database is configured at all, which is dev and
  // the test suite.
  if (url) {
    const { PostgresBillingStore } = await import("./billing.pg");
    cached = await PostgresBillingStore.connect(url);
    return { backend: "postgres" };
  }
  cached = new InMemoryBillingStore();
  return { backend: "memory" };
}

export async function closeBillingStore(): Promise<void> {
  await cached?.close?.();
}

/** Test seam — the singleton is process-local, exactly like the domain store's. */
export function _resetBilling(): void {
  cached = new InMemoryBillingStore();
}
