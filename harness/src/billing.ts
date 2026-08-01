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
 * There is deliberately no payment provider here, and `Invoice.payment_link_url` is the only place
 * one would attach.
 *
 * Taking money on behalf of a third party is not a library choice, it is a regulated posture. The
 * moment Mycel collects a founder's client's payment into a Mycel-controlled account, Mycel is
 * handling other people's money: that is money transmission in most US states, a payment-services
 * question in the UK/EU, and it drags KYC, onboarding, chargeback liability, tax reporting and
 * negative-balance risk in behind it. Stripe Connect exists precisely to answer those questions,
 * and choosing between its models — Standard (the founder owns the Stripe account and the risk),
 * Express, or Custom (Mycel owns both) — is a decision about what kind of company this is. It has
 * to be made on purpose, by a person, with the compliance answer already in hand.
 *
 * So: the domain is modelled, the surfaces exist, a founder can paste in a payment link they made
 * themselves, and the kernel moves no money. When that decision is taken, it lands here —
 * `paymentLinkFor` becomes "ask the provider for a checkout URL for this invoice", and the webhook
 * that confirms a payment calls `recordPayment` exactly as the manual route does today. Everything
 * else on this page already works.
 */
export function paymentLinkFor(inv: Invoice): string | undefined {
  // Today: whatever the founder pasted in. Tomorrow: a provider call, behind the same signature.
  // Never on a draft — a link to pay something that hasn't been issued is a support ticket.
  return inv.status === "draft" || inv.status === "void" ? undefined : inv.payment_link_url;
}

/**
 * How many minor units make one major unit, by currency.
 *
 * ISO-4217 exponents. Only the exceptions are listed; everything else is 2. This is the ONLY place
 * that knows, and the value is handed to the portal in the invoice payload so a browser can format
 * ¥1250 and £12.50 correctly without shipping a currency table to it.
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

export interface InvoiceFilter {
  /**
   * TENANT SCOPE, and it fails closed exactly like `listCases`/`queryRecords`: pass it and you get
   * only rows whose project_id is exactly that string. Callers holding one project (the portal, the
   * action proxy) MUST push it down here rather than filter the result, because a post-filter only
   * protects the rows the query happened to return and leaks the moment a `limit` truncates.
   */
  project_id?: string;
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

export interface BillingStore {
  createInvoice(i: NewInvoice): Promise<Invoice>;
  getInvoice(id: string): Promise<Invoice | undefined>;
  listInvoices(f?: InvoiceFilter): Promise<Invoice[]>;
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
   * Read-merge-write means two £500 payments landing together both read 0 and both write 500, and
   * the business has quietly written off £500. On Postgres this is `amount_paid = amount_paid + $2`
   * in a single statement — the same reasoning as `DomainStore.bumpPacing`.
   */
  recordPayment(id: string, amountMinor: number): Promise<Invoice | undefined>;
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

  async listInvoices(f: InvoiceFilter = {}): Promise<Invoice[]> {
    return [...this.invoices.values()]
      .filter(
        (v) =>
          // Tenant scope first, and strict. An invoice is money; "visible to everyone by accident"
          // is not a failure mode this row type gets to have.
          (f.project_id === undefined || v.project_id === f.project_id) &&
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

  async deleteInvoice(id: string): Promise<boolean> {
    return this.invoices.delete(id);
  }
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
  // The Postgres backend is not written yet.
  //
  // Failing loudly here is deliberate. The alternative — quietly falling back to the in-memory
  // store when a database IS configured — gives a process that accepts writes, answers reads
  // correctly for its own lifetime, and loses everything on the next deploy. For invoices that is
  // money; for distilled knowledge it is the founder's corrections. Both are the kind of loss you
  // discover weeks later with no way to reconstruct it.
  //
  // In-memory remains the correct backend when no database is configured at all, which is dev and
  // the test suite.
  if (url) {
    throw new Error(
      "billing: MYCEL_DATABASE_URL is set but the Postgres billing store is not implemented yet. " +
        "Refusing to start rather than keep invoices in memory and lose them on restart.",
    );
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
