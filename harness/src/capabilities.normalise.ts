// One shape per capability, whatever the provider. The seam payments.ts said was needed.
//
// ═══ THE FAILURE THIS EXISTS FOR ═══
//
// payments.ts shipped with a catalogue of exactly one vendor:
//
//   const PAYMENT_READS = { stripe: [ { slug: "STRIPE_LIST_INVOICES", parse: … } ] }
//   export const PAYMENT_TOOLKITS = Object.keys(PAYMENT_READS);
//
// and a comment saying the toolkit list is the seam. This is that seam widened. `XERO_GET_PAYMENTS`
// and `QUICKBOOKS_QUERY_PAYMENTS` do not return anything like a Stripe charge — different field
// names, different envelopes, decimals instead of minor units, and in QuickBooks' case a customer
// reference where Stripe has an invoice number. Every one of those differences is a place to get
// money wrong, so each provider gets its own explicit reader rather than a generic field-sniffer.
// "Whatever field is called amount" is how a Stripe `amount` (what was charged) got confused with
// `amount_paid` (what settled) in the first draft of the Stripe reader.
//
// ═══ IT NEVER INVENTS A VALUE ═══
//
// The rule, stated once and enforced by every function below: if the provider did not say it, we do
// not have it. Concretely —
//
//   · A payment with no timestamp is NOT stamped with today. `ExternalPayment.paid_at` is documented
//     as "when the money moved, NOT when we were told about it", and the gap matters: an invoice
//     settled on the 3rd and read on the 6th was never overdue, and stamping the 6th would make our
//     own audit trail agree with a chase we should not have sent. A dateless payment is SKIPPED and
//     the skip is reported.
//   · A decimal amount is converted through its string form, never through `Math.round(v * 100)`.
//     `Math.round(1.005 * 100)` is 100, not 101, because 1.005 is not representable — and a rounding
//     that is wrong one time in a thousand on money is worse than one that is wrong every time,
//     because nobody finds it.
//   · A currency whose minor-unit exponent we do not know REFUSES. There is no 2-decimal default:
//     ¥1,000 is 1000 minor units, not 100000, and defaulting would inflate a Japanese invoice
//     hundredfold in the direction of "settled".
//   · A skip is a SENTENCE, returned to the caller, never a silent `continue`. See `Normalised`.
import type { CapabilityName } from "./capabilities";

/**
 * What a reader returns.
 *
 * `skipped` is the whole reason this is not a bare array. The recurring expensive bug in this repo is
 * something failing while reporting success, and the shape it takes in a normaliser is precise: a
 * provider returns forty invoices, thirty-eight are in a currency we cannot size, the reader returns
 * two, and the reconciliation summary says "read 2 payments" with total confidence. Skips travel up
 * into `ReconcileSummary.detail` and onto the founder's screen.
 */
export interface Normalised<T> {
  items: T[];
  /** One human sentence per thing we refused to guess at. Empty is the good case, not the usual one. */
  skipped: string[];
}

const ok = <T>(items: T[], skipped: string[] = []): Normalised<T> => ({ items, skipped });

/**
 * A payment as the provider describes it, normalised.
 *
 * Moved here from payments.ts unchanged — the definition is now shared by four readers instead of
 * two, and leaving it next to one vendor's parser was how the vendor's assumptions leaked into it.
 * payments.ts re-exports it so no caller has to move.
 *
 * `amount_minor` is integer minor units and NEGATIVE for a refund. Refunds are modelled as payments
 * in the other direction so `amount_paid` corrects itself through the same atomic add.
 */
export interface ObservedPayment {
  /** The provider's immutable id for this money movement. The idempotency key; required. */
  external_id: string;
  /** What the client quoted — an invoice number, or our number in provider metadata. */
  reference?: string;
  amount_minor: number;
  /** ISO-4217, upper. NOT assumed to equal the invoice's; see `currency_mismatch`. */
  currency: string;
  /** ISO-8601 instant the money moved. Never fabricated — a payment without one is skipped. */
  paid_at: string;
}

/**
 * An invoice raised somewhere other than here, normalised.
 *
 * Shaped to line up with `Invoice` in contract.ts and with `Matchable` in match.ts, which is the
 * point: an invoice read out of Xero and an invoice raised in Mycel go through the SAME matcher, so
 * there is no second definition of "does this payment settle this invoice" to drift.
 *
 * Everything optional is optional because a provider may genuinely not say it. `client_name` absent
 * means the read did not include the contact, not that the invoice has no client.
 */
export interface ObservedInvoice {
  /** The provider's own id. Namespaced by the caller, exactly as payments are. */
  external_id: string;
  /** The number a client would quote. The only field `match.ts` pass 1 can use. */
  number?: string;
  client_name?: string;
  /** Integer minor units. */
  total_minor: number;
  /** Integer minor units. Zero when the provider says nothing has been paid. */
  amount_paid_minor: number;
  /** Integer minor units, from the provider — NOT computed, so a provider's own view is preserved. */
  amount_due_minor: number;
  currency: string;
  /** `YYYY-MM-DD`. */
  issue_date?: string;
  /** `YYYY-MM-DD`. What pass 2 of the matcher compares. */
  due_date?: string;
  /** The provider's word for its state, lower-cased. Deliberately not mapped onto `InvoiceStatus` —
   *  Xero's `AUTHORISED` is not `sent` and pretending it is would put a foreign status machine into
   *  ours. Callers that need a decision read the amounts. */
  status_hint?: string;
}

// ═══════════════════════════ MONEY ═══════════════════════════

/**
 * Currencies whose smallest unit IS the unit. ¥1,000 is 1000, not 100000.
 *
 * Not exhaustive and it does not need to be — an unlisted currency falls through to the two-decimal
 * default only if it is a currency we recognise at all. See `minorUnits`.
 */
const ZERO_DECIMAL = new Set(["BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"]);
/** Three decimal places. Getting these wrong is a factor of ten on a Gulf invoice. */
const THREE_DECIMAL = new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]);

/** How many decimal places this currency has, or undefined if we should not pretend to know. */
function exponent(currency: string): number | undefined {
  const c = currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(c)) return undefined;
  if (ZERO_DECIMAL.has(c)) return 0;
  if (THREE_DECIMAL.has(c)) return 3;
  return 2;
}

/**
 * A provider's decimal amount → integer minor units, exactly, or an error sentence.
 *
 * STRING ARITHMETIC, NOT FLOAT. `Math.round(v * 100)` looks correct and is not: JavaScript cannot
 * represent 1.005, and `Math.round(1.005 * 100)` is 100. On a ledger read hourly that is a penny
 * missing from an invoice that then never reaches `amount_due === 0` and gets chased forever.
 *
 * More digits than the currency allows is a REFUSAL, not a rounding. A provider reporting 10.005 GBP
 * is telling us something we do not understand — a partial allocation, a different currency, a
 * corrupt read — and half a penny in either direction is a decision this code is not entitled to
 * make. It goes to a human as a skip.
 */
export function toMinorUnits(value: unknown, currency: string): { minor: number } | { error: string } {
  const exp = exponent(currency);
  if (exp === undefined) {
    return { error: `the currency "${String(currency)}" is not one this kernel can size, so the amount was not converted` };
  }
  let s: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return { error: `the amount "${String(value)}" is not a finite number` };
    // Round-trips exactly for every value a JSON decimal can hold; `toFixed` would round for us.
    s = String(value);
  } else if (typeof value === "string" && value.trim()) {
    s = value.trim();
  } else {
    return { error: `the amount was missing or not a number` };
  }
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (!m[2] && !m[3])) return { error: `the amount "${s}" is not a plain decimal number` };
  // Exponential notation (1e-7) reaches here as an unparseable string rather than being silently
  // mis-read. A provider that sends 1e2 for £1.00 is a provider we should stop and look at.
  const [, sign, whole, frac = ""] = m;
  const trimmed = frac.replace(/0+$/, "");
  if (trimmed.length > exp) {
    return {
      error: `the amount "${s}" has more decimal places than ${currency.toUpperCase()} has, so it was not rounded — a human has to say what it means`,
    };
  }
  const padded = (frac + "0".repeat(exp)).slice(0, exp);
  const n = Number(`${sign}${whole || "0"}${padded}`);
  if (!Number.isSafeInteger(n)) return { error: `the amount "${s}" is too large to hold exactly` };
  return { minor: n };
}

// ═══════════════════════════ SHARED HELPERS ═══════════════════════════

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) ? v : undefined;
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** Composio wraps a provider list in one of a few envelopes depending on the tool. Unwrap defensively. */
function rows(data: unknown, ...keys: string[]): Record<string, unknown>[] {
  const d = (data ?? {}) as Record<string, unknown>;
  const inner = (d.data ?? {}) as Record<string, unknown>;
  const resp = (d.response_data ?? {}) as Record<string, unknown>;
  const candidates: unknown[] = [d, d.data, inner.data, d.response_data, resp.data];
  // Named collections — Xero answers `{ Invoices: [...] }`, QuickBooks `{ QueryResponse: { Invoice: [...] } }`.
  for (const src of [d, inner, resp, (inner.QueryResponse ?? resp.QueryResponse ?? d.QueryResponse) as Record<string, unknown> | undefined]) {
    if (!src) continue;
    for (const k of keys) candidates.push(src[k]);
  }
  for (const path of candidates) {
    if (Array.isArray(path)) return path.filter((x) => x && typeof x === "object") as Record<string, unknown>[];
  }
  return [];
}

/** Seconds since epoch → ISO. Stripe timestamps are seconds; treating them as ms lands in 1970. */
function stripeTime(v: unknown): string | undefined {
  const n = num(v);
  if (n === undefined || n <= 0) return undefined;
  const d = new Date(n * 1000);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/**
 * Xero dates, in both forms it emits: `2026-03-04T00:00:00` and `/Date(1772582400000+0000)/`.
 *
 * Returns undefined rather than a best guess. A date we cannot read is a payment we cannot place in
 * time, and `paid_at` is not a field to approximate — see the header.
 */
function xeroTime(v: unknown): string | undefined {
  const s = str(v);
  if (!s) return undefined;
  const ms = /^\/Date\((-?\d+)([+-]\d{4})?\)\/$/.exec(s);
  if (ms) {
    const d = new Date(Number(ms[1]));
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  const iso = /^\d{4}-\d{2}-\d{2}/.test(s) ? new Date(s.length === 10 ? `${s}T00:00:00Z` : s) : null;
  return iso && !Number.isNaN(iso.getTime()) ? iso.toISOString() : undefined;
}

/** `YYYY-MM-DD` out of anything `xeroTime` can read. What `Matchable.date` compares. */
const dayOf = (iso: string | undefined): string | undefined => iso?.slice(0, 10);

// ═══════════════════════════ STRIPE ═══════════════════════════

/**
 * Stripe invoices → payments.
 *
 * `amount_paid`, never `total` and never `amount_due`. A Stripe invoice for £4,000 that the client
 * part-paid £1,000 against reports `total: 400000, amount_paid: 100000` — reading `total` would
 * settle our invoice in full off a quarter of the money and stop the chase that should continue.
 *
 * The reference is our invoice number where the founder put it in metadata, falling back to Stripe's
 * own invoice number. Metadata first because it is the only one that can be OUR reference; Stripe's
 * number only matches when the founder happens to number both systems the same way.
 *
 * Stripe is the one provider here that already speaks minor units, so there is no conversion and no
 * currency-exponent question. That is a property of Stripe, not the shape of the seam.
 */
export function normaliseStripeInvoices(data: unknown): Normalised<ObservedPayment> {
  const out: ObservedPayment[] = [];
  const skipped: string[] = [];
  for (const r of rows(data)) {
    const paid = num(r.amount_paid);
    if (paid === undefined || paid === 0) continue;
    const id = str(r.id);
    if (!id) continue;
    const meta = (r.metadata ?? {}) as Record<string, unknown>;
    const at = stripeTime((r.status_transitions as Record<string, unknown> | undefined)?.paid_at) ?? stripeTime(r.created);
    if (!at) {
      // Was `?? new Date(0).toISOString()` — 1970, silently, on every invoice Stripe dated oddly.
      // A 1970 payment can never match a real invoice by date and reads as ancient in the audit
      // trail, which is a fabricated fact rather than a missing one.
      skipped.push(`Stripe invoice ${id} reports money paid but no date it was paid, so it was not applied`);
      continue;
    }
    out.push({
      external_id: id,
      reference: str(meta.mycel_invoice_number) ?? str(meta.invoice_number) ?? str(r.number),
      amount_minor: paid,
      currency: (str(r.currency) ?? "").toUpperCase(),
      paid_at: at,
    });
  }
  return ok(out, skipped);
}

/**
 * Stripe charges → payments.
 *
 * `amount_captured` rather than `amount`: an authorised-but-uncaptured charge is not money, and an
 * invoice marked paid off an authorisation that later expires is an invoice we have stopped chasing
 * for no reason. Refunded charges emit the NET, so a fully refunded charge contributes nothing and a
 * partly refunded one contributes what is left.
 */
export function normaliseStripeCharges(data: unknown): Normalised<ObservedPayment> {
  const out: ObservedPayment[] = [];
  const skipped: string[] = [];
  for (const r of rows(data)) {
    const id = str(r.id);
    if (!id || r.status !== "succeeded") continue;
    const captured = num(r.amount_captured) ?? num(r.amount);
    if (captured === undefined) continue;
    const net = captured - (num(r.amount_refunded) ?? 0);
    if (net === 0) continue;
    const at = stripeTime(r.created);
    if (!at) {
      skipped.push(`Stripe charge ${id} has no creation date, so it was not applied`);
      continue;
    }
    const meta = (r.metadata ?? {}) as Record<string, unknown>;
    out.push({
      external_id: id,
      reference: str(meta.mycel_invoice_number) ?? str(meta.invoice_number) ?? str(r.invoice) ?? str(r.description),
      amount_minor: net,
      currency: (str(r.currency) ?? "").toUpperCase(),
      paid_at: at,
    });
  }
  return ok(out, skipped);
}

/** Stripe invoices → invoices. Same rows, the other shape; Stripe is already in minor units. */
export function normaliseStripeInvoiceList(data: unknown): Normalised<ObservedInvoice> {
  const out: ObservedInvoice[] = [];
  const skipped: string[] = [];
  for (const r of rows(data)) {
    const id = str(r.id);
    if (!id) continue;
    const total = num(r.total);
    const paid = num(r.amount_paid) ?? 0;
    const due = num(r.amount_due);
    if (total === undefined || due === undefined) {
      skipped.push(`Stripe invoice ${id} did not report a total and a balance, so it was not read`);
      continue;
    }
    const cust = (r.customer as Record<string, unknown> | undefined) ?? undefined;
    out.push({
      external_id: id,
      number: str(r.number),
      client_name: str(r.customer_name) ?? (cust ? str(cust.name) : undefined),
      total_minor: total,
      amount_paid_minor: paid,
      amount_due_minor: due,
      currency: (str(r.currency) ?? "").toUpperCase(),
      issue_date: dayOf(stripeTime(r.created)),
      due_date: dayOf(stripeTime(r.due_date)),
      status_hint: str(r.status)?.toLowerCase(),
    });
  }
  return ok(out, skipped);
}

// ═══════════════════════════ XERO ═══════════════════════════

/**
 * Xero payments → payments. `XERO_GET_PAYMENTS`.
 *
 * Xero reports decimals (`"Amount": 100.50`) and a currency on the payment, so every amount goes
 * through `toMinorUnits` and a currency we cannot size refuses rather than assuming pence.
 *
 * `PaymentType` decides the SIGN. Xero models a refund as `ARCREDITPAYMENT` with a positive amount,
 * so reading the amount alone would apply a refund as a payment and mark a reopened invoice settled.
 */
export function normaliseXeroPayments(data: unknown): Normalised<ObservedPayment> {
  const out: ObservedPayment[] = [];
  const skipped: string[] = [];
  for (const r of rows(data, "Payments", "payments")) {
    const id = str(r.PaymentID) ?? str(r.paymentID) ?? str(r.payment_id);
    if (!id) continue;
    const inv = (r.Invoice ?? r.invoice ?? {}) as Record<string, unknown>;
    const currency = (str(r.CurrencyCode) ?? str(inv.CurrencyCode) ?? "").toUpperCase();
    const converted = toMinorUnits(r.Amount ?? r.amount, currency);
    if ("error" in converted) {
      skipped.push(`Xero payment ${id}: ${converted.error}`);
      continue;
    }
    const at = xeroTime(r.Date ?? r.date);
    if (!at) {
      skipped.push(`Xero payment ${id} has no date on it, so it was not applied`);
      continue;
    }
    const type = (str(r.PaymentType) ?? "").toUpperCase();
    const isRefund = type.includes("CREDIT") || type.includes("OVERPAYMENT") || type.includes("PREPAYMENT");
    if (converted.minor === 0) continue;
    out.push({
      external_id: id,
      reference: str(inv.InvoiceNumber) ?? str(r.Reference),
      amount_minor: isRefund ? -converted.minor : converted.minor,
      currency,
      paid_at: at,
    });
  }
  return ok(out, skipped);
}

/**
 * Xero invoices → invoices. `XERO_GET_INVOICES` — the slug `books-keeper.json` already declared.
 *
 * `Type` is checked: `ACCPAY` is a BILL the business owes a supplier, not an invoice a client owes
 * it. Reading both would put the business's own outgoings into its accounts receivable, and every
 * number that follows — what is owed, what is overdue, who gets chased — would be wrong in the
 * direction of chasing a supplier for money we owe them.
 */
export function normaliseXeroInvoices(data: unknown): Normalised<ObservedInvoice> {
  const out: ObservedInvoice[] = [];
  const skipped: string[] = [];
  for (const r of rows(data, "Invoices", "invoices")) {
    const id = str(r.InvoiceID) ?? str(r.invoiceID) ?? str(r.invoice_id);
    if (!id) continue;
    const type = (str(r.Type) ?? "ACCREC").toUpperCase();
    if (type !== "ACCREC") continue;
    const currency = (str(r.CurrencyCode) ?? "").toUpperCase();
    const total = toMinorUnits(r.Total ?? r.total, currency);
    const paid = toMinorUnits(r.AmountPaid ?? 0, currency);
    const due = toMinorUnits(r.AmountDue ?? r.Total ?? 0, currency);
    if ("error" in total || "error" in paid || "error" in due) {
      const first = [total, paid, due].find((x): x is { error: string } => "error" in x)!;
      skipped.push(`Xero invoice ${str(r.InvoiceNumber) ?? id}: ${first.error}`);
      continue;
    }
    const contact = (r.Contact ?? {}) as Record<string, unknown>;
    out.push({
      external_id: id,
      number: str(r.InvoiceNumber),
      client_name: str(contact.Name),
      total_minor: total.minor,
      amount_paid_minor: paid.minor,
      amount_due_minor: due.minor,
      currency,
      issue_date: dayOf(xeroTime(r.Date ?? r.DateString)),
      due_date: dayOf(xeroTime(r.DueDate ?? r.DueDateString)),
      status_hint: str(r.Status)?.toLowerCase(),
    });
  }
  return ok(out, skipped);
}

// ═══════════════════════════ QUICKBOOKS ═══════════════════════════

/**
 * QuickBooks payments → payments. `QUICKBOOKS_QUERY_PAYMENTS`.
 *
 * QuickBooks has a first-class `Payment` entity with a `TxnDate`, which is why it is read here rather
 * than derived from an invoice's balance: a QuickBooks INVOICE reports what is outstanding but never
 * says when anything was paid, and a payment with no date is one this seam refuses to invent (see the
 * header). Deriving one would have been the easy path and it would have stamped today's date on money
 * that arrived last month.
 *
 * The reference is the linked invoice's `DocNumber` where the read included it, falling back to the
 * payment's own `PaymentRefNum` — which on a bank-transfer payment is the reference the client typed,
 * i.e. exactly what `match.ts` pass 1 wants.
 */
export function normaliseQuickBooksPayments(data: unknown): Normalised<ObservedPayment> {
  const out: ObservedPayment[] = [];
  const skipped: string[] = [];
  for (const r of rows(data, "Payment", "payments", "Payments")) {
    const id = str(r.Id) ?? str(r.id);
    if (!id) continue;
    const currency = (str((r.CurrencyRef as Record<string, unknown> | undefined)?.value) ?? str(r.currency) ?? "").toUpperCase();
    const converted = toMinorUnits(r.TotalAmt ?? r.total_amt, currency);
    if ("error" in converted) {
      skipped.push(`QuickBooks payment ${id}: ${converted.error}`);
      continue;
    }
    if (converted.minor === 0) continue;
    const day = str(r.TxnDate ?? r.txn_date);
    if (!day || !/^\d{4}-\d{2}-\d{2}/.test(day)) {
      skipped.push(`QuickBooks payment ${id} has no transaction date, so it was not applied`);
      continue;
    }
    const line = Array.isArray(r.Line) ? (r.Line as Record<string, unknown>[]) : [];
    const linked = line
      .flatMap((l) => (Array.isArray(l.LinkedTxn) ? (l.LinkedTxn as Record<string, unknown>[]) : []))
      .find((t) => str(t.TxnType) === "Invoice");
    out.push({
      external_id: id,
      reference: str(r.PaymentRefNum) ?? (linked ? str(linked.TxnId) : undefined),
      amount_minor: converted.minor,
      currency,
      paid_at: new Date(`${day.slice(0, 10)}T00:00:00Z`).toISOString(),
    });
  }
  return ok(out, skipped);
}

/**
 * QuickBooks invoices → invoices. `QUICKBOOKS_QUERY_INVOICES`.
 *
 * `Balance` is what is still owed; QuickBooks does not report an amount paid, so it is derived as
 * `TotalAmt - Balance` — the one derivation in this file, and it is arithmetic on two numbers the
 * provider DID return rather than a value invented for a field it left empty.
 *
 * `DocNumber` is the number a client quotes, not `Id`. Reading `Id` as the reference would put a
 * QuickBooks internal integer into `match.ts` pass 1, where it would match nothing forever while
 * looking like it was trying.
 */
export function normaliseQuickBooksInvoices(data: unknown): Normalised<ObservedInvoice> {
  const out: ObservedInvoice[] = [];
  const skipped: string[] = [];
  for (const r of rows(data, "Invoice", "invoices", "Invoices")) {
    const id = str(r.Id) ?? str(r.id);
    if (!id) continue;
    const currency = (str((r.CurrencyRef as Record<string, unknown> | undefined)?.value) ?? str(r.currency) ?? "").toUpperCase();
    const total = toMinorUnits(r.TotalAmt ?? r.total_amt, currency);
    const balance = toMinorUnits(r.Balance ?? r.balance, currency);
    if ("error" in total || "error" in balance) {
      const first = [total, balance].find((x): x is { error: string } => "error" in x)!;
      skipped.push(`QuickBooks invoice ${str(r.DocNumber) ?? id}: ${first.error}`);
      continue;
    }
    const cust = (r.CustomerRef ?? {}) as Record<string, unknown>;
    const day = (v: unknown) => {
      const s = str(v);
      return s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : undefined;
    };
    out.push({
      external_id: id,
      number: str(r.DocNumber),
      client_name: str(cust.name),
      total_minor: total.minor,
      amount_paid_minor: total.minor - balance.minor,
      amount_due_minor: balance.minor,
      currency,
      issue_date: day(r.TxnDate),
      due_date: day(r.DueDate),
      // QuickBooks has no status field on an invoice; the balance IS the status. Saying so is more
      // honest than mapping it to a word the provider never used.
      status_hint: balance.minor === 0 ? "paid" : undefined,
    });
  }
  return ok(out, skipped);
}

// ═══════════════════════════ CALENDAR ═══════════════════════════
//
// ═══ WHAT IS STORED AND WHAT IS DISPLAYED ═══
//
// The classic silent-wrong on a calendar is a naive datetime: `2026-03-05T15:00:00` with no offset.
// Read in the harness's process timezone (UTC in production, Europe/London on a founder's laptop)
// the same string is two different instants for half the year, so a "3pm Tuesday" confirmed by email
// arrives an hour late in April and on time in January, and nothing anywhere reports an error. So:
//
//   · `starts_at`/`ends_at` are ISO-8601 INSTANTS, always UTC, always ending in `Z`. Every comparison
//     in this kernel — overlap, free/busy, "is this slot taken" — uses only these. There is no code
//     path that does date arithmetic on a wall-clock string.
//   · `time_zone` is the IANA zone the PROVIDER says the event is displayed in. It is carried so a
//     confirmation email can say "3:00pm (Europe/London)" instead of an instant no client can read.
//     It is never used to compute an instant, because by the time we hold it the instant is settled.
//   · A datetime with NEITHER an offset NOR a zone alongside it is SKIPPED with a sentence. Guessing
//     is how the hour goes missing, and an event we cannot place in time is an event we must not
//     quietly treat as free.
//
// ═══ ALL-DAY EVENTS HAVE NO INSTANT, AND THAT IS NOT A DEFECT ═══
//
// Google returns `{ start: { date: "2026-03-05" } }` for an all-day event. There is no instant: an
// all-day event on the 5th in Australia is busy from 2026-03-04T13:00Z, and stamping it midnight-UTC
// would free up thirteen real hours that the founder is not free in. So an all-day event is carried
// with `all_day: true` and a `day`, and NO `starts_at`. `busyIntervals` leaves it out of the interval
// maths; `dayIsOpaque` is how a booker asks about it, and a booker that does not ask gets no false
// "free" — it gets an event it can see and must reason about.

/**
 * A calendar event as the provider describes it, normalised.
 *
 * Deliberately thin. This is what a booking desk needs to answer "is this slot taken and what is
 * already on it" — not a mirror of Google's event resource. Fields the kernel does not use are not
 * carried, because a field carried is a field somebody will eventually branch on.
 */
export interface ObservedEvent {
  /** The provider's own id. Namespaced by the caller exactly as payments and invoices are. */
  external_id: string;
  /** What is on the founder's calendar. Absent when the provider withheld it (a private event). */
  title?: string;
  /** UTC instant, `Z`-suffixed. Absent ONLY for an all-day event. */
  starts_at?: string;
  /** UTC instant, `Z`-suffixed. Absent ONLY for an all-day event. */
  ends_at?: string;
  /** `YYYY-MM-DD`, set ONLY for an all-day event, in the calendar's own local sense. */
  day?: string;
  /** True when this event has no instants and blocks a whole local day. */
  all_day: boolean;
  /** IANA zone for DISPLAY. Never used to compute an instant. Absent when the provider did not say. */
  time_zone?: string;
  /**
   * Does this event actually make the founder busy? Google's `transparency: "transparent"` and
   * Outlook's `showAs: "free"` both mean "on my calendar, not blocking" — a birthday, a held
   * placeholder. Treating those as busy is how a booking desk tells a client there is no availability
   * for a fortnight. Defaults to TRUE when the provider says nothing, because the safe direction to
   * be wrong in is refusing a slot, not double-booking the founder.
   */
  busy: boolean;
  /** The provider's own word for the state, lower-cased. `cancelled` events are dropped, not carried. */
  status_hint?: string;
}

/**
 * A provider datetime → UTC instant, or a refusal.
 *
 * Accepts only what is unambiguous: a string carrying an offset (`Z`, `+01:00`), or — the Google
 * shape — a naive local string WITH the zone the provider stated next to it, which is resolved
 * through `Intl` rather than by adding hours by hand. Anything else returns an error sentence.
 */
export function toInstant(value: unknown, zone?: string): { instant: string } | { error: string } {
  const s = str(value);
  if (!s) return { error: "no datetime" };
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return { error: `"${s}" is not a datetime this kernel can read` };
    return { instant: d.toISOString() };
  }
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s)) {
    return { error: `"${s}" is not a datetime this kernel can read` };
  }
  if (!zone) {
    // THE SILENT-WRONG, REFUSED. A wall clock with no zone is not a time; reading it in the
    // harness's own zone is how a 3pm meeting becomes a 2pm meeting for six months of the year.
    return { error: `"${s}" has no UTC offset and the provider named no timezone, so it is not a real instant` };
  }
  const offset = zoneOffsetMinutes(s, zone);
  if (offset === undefined) return { error: `timezone "${zone}" is not one this runtime knows` };
  const utcGuess = Date.parse(`${s.replace(" ", "T").replace(/(Z|[+-]\d{2}:?\d{2})$/, "")}Z`);
  if (!Number.isFinite(utcGuess)) return { error: `"${s}" is not a datetime this kernel can read` };
  return { instant: new Date(utcGuess - offset * 60_000).toISOString() };
}

/**
 * How far ahead of UTC `zone` is at (approximately) this wall time, in minutes.
 *
 * Two passes, because the offset depends on the instant and the instant depends on the offset. The
 * first pass reads the offset at the naive-as-UTC instant; the second re-reads it at the corrected
 * instant, which is what fixes the one hour on either side of a DST boundary. Two passes converge for
 * every real zone — no zone has a shift larger than its own offset error.
 */
function zoneOffsetMinutes(naive: string, zone: string): number | undefined {
  const asUtc = Date.parse(`${naive.replace(" ", "T")}Z`);
  if (!Number.isFinite(asUtc)) return undefined;
  const at = (ms: number): number | undefined => {
    try {
      const fmt = new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        hour12: false,
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
      });
      const p: Record<string, string> = {};
      for (const part of fmt.formatToParts(new Date(ms))) if (part.type !== "literal") p[part.type] = part.value;
      // `hour: "2-digit"` with hour12:false yields "24" at midnight in some ICU versions.
      const hour = p.hour === "24" ? "00" : p.hour;
      const local = Date.parse(`${p.year}-${p.month}-${p.day}T${hour}:${p.minute}:${p.second}Z`);
      return Number.isFinite(local) ? (local - ms) / 60_000 : undefined;
    } catch {
      return undefined; // an unknown IANA zone throws RangeError
    }
  };
  const first = at(asUtc);
  if (first === undefined) return undefined;
  return at(asUtc - first * 60_000) ?? first;
}

/** `YYYY-MM-DD` if this looks like a bare date, else undefined. */
const bareDay = (v: unknown): string | undefined => {
  const s = str(v);
  return s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : undefined;
};

/**
 * Google Calendar events → `ObservedEvent`.
 *
 * `start.dateTime` carries an offset and `start.timeZone` names the display zone; an all-day event
 * has `start.date` instead. Cancelled events are DROPPED rather than carried as busy — a cancelled
 * event that still blocked a slot would be a meeting nobody can book and nobody can see why.
 *
 * UNVERIFIED against the live catalogue: the envelope key (`items`) is Google's own and stable, but
 * the Composio tool slug that produces it is not verifiable without a key. A wrong slug fails as a
 * tool error, never as an empty calendar — see `whyNothingRead`.
 */
export function normaliseGoogleCalendarEvents(data: unknown): Normalised<ObservedEvent> {
  const out: ObservedEvent[] = [];
  const skipped: string[] = [];
  for (const r of rows(data, "items", "events")) {
    const id = str(r.id);
    if (!id) continue;
    const status = str(r.status)?.toLowerCase();
    if (status === "cancelled") continue;
    const start = (r.start ?? {}) as Record<string, unknown>;
    const end = (r.end ?? {}) as Record<string, unknown>;
    const zone = str(start.timeZone) ?? str(r.timeZone);
    const busy = str(r.transparency)?.toLowerCase() !== "transparent";
    const startDay = bareDay(start.date);
    if (startDay) {
      out.push({ external_id: id, title: str(r.summary), day: startDay, all_day: true, busy, ...(zone ? { time_zone: zone } : {}), ...(status ? { status_hint: status } : {}) });
      continue;
    }
    const s = toInstant(start.dateTime, zone);
    const e = toInstant(end.dateTime, str(end.timeZone) ?? zone);
    if ("error" in s || "error" in e) {
      const first = [s, e].find((x): x is { error: string } => "error" in x)!;
      skipped.push(`Google Calendar event ${str(r.summary) ?? id}: ${first.error}`);
      continue;
    }
    out.push({ external_id: id, title: str(r.summary), starts_at: s.instant, ends_at: e.instant, all_day: false, busy, ...(zone ? { time_zone: zone } : {}), ...(status ? { status_hint: status } : {}) });
  }
  return ok(out, skipped);
}

/**
 * Outlook / Microsoft Graph events → `ObservedEvent`.
 *
 * Graph is the one that bites: `start.dateTime` is `"2026-03-05T15:00:00.0000000"` with NO offset,
 * and the zone is in `start.timeZone` beside it — which is `"UTC"` by default unless the caller sent
 * a `Prefer: outlook.timezone` header. So a reader that parses `start.dateTime` alone is reading a
 * wall clock as UTC and will be silently wrong for every mailbox whose default is not UTC. That is
 * exactly what `toInstant`'s zone argument exists for, and why a missing zone is skipped rather than
 * defaulted.
 *
 * `showAs: "free"` is Graph's transparency; `isAllDay` its all-day flag. UNVERIFIED tool slug.
 */
export function normaliseOutlookEvents(data: unknown): Normalised<ObservedEvent> {
  const out: ObservedEvent[] = [];
  const skipped: string[] = [];
  for (const r of rows(data, "value", "events", "items")) {
    const id = str(r.id);
    if (!id) continue;
    const start = (r.start ?? {}) as Record<string, unknown>;
    const end = (r.end ?? {}) as Record<string, unknown>;
    const zone = str(start.timeZone);
    const busy = !["free", "workingelsewhere"].includes(str(r.showAs)?.toLowerCase() ?? "");
    const title = str(r.subject);
    if (r.isAllDay === true) {
      const day = bareDay(start.date) ?? str(start.dateTime)?.slice(0, 10);
      if (!day) {
        skipped.push(`Outlook event ${title ?? id}: marked all-day but carries no date`);
        continue;
      }
      out.push({ external_id: id, ...(title ? { title } : {}), day, all_day: true, busy, ...(zone ? { time_zone: zone } : {}) });
      continue;
    }
    // Graph's fractional seconds (`.0000000`) are longer than `Date` accepts in some runtimes; trim
    // to milliseconds. Dropping sub-millisecond precision on a meeting time costs nothing.
    const trim = (v: unknown) => str(v)?.replace(/(\.\d{3})\d+$/, "$1");
    const s = toInstant(trim(start.dateTime), zone);
    const e = toInstant(trim(end.dateTime), str(end.timeZone) ?? zone);
    if ("error" in s || "error" in e) {
      const first = [s, e].find((x): x is { error: string } => "error" in x)!;
      skipped.push(`Outlook event ${title ?? id}: ${first.error}`);
      continue;
    }
    out.push({ external_id: id, ...(title ? { title } : {}), starts_at: s.instant, ends_at: e.instant, all_day: false, busy, ...(zone ? { time_zone: zone } : {}) });
  }
  return ok(out, skipped);
}

/** Half-open `[from, to)` UTC instants the founder is busy in. All-day events are NOT here. */
export interface BusyInterval {
  from: string;
  to: string;
}

/**
 * The busy intervals in a set of events, merged and sorted.
 *
 * Half-open on purpose: a meeting ending at 15:00 and one starting at 15:00 do not overlap, and a
 * closed comparison would report every back-to-back calendar as double-booked and refuse to book
 * anything at all.
 */
export function busyIntervals(events: readonly ObservedEvent[]): BusyInterval[] {
  const spans = events
    .filter((e) => e.busy && !e.all_day && e.starts_at && e.ends_at && e.starts_at < e.ends_at)
    .map((e) => ({ from: e.starts_at!, to: e.ends_at! }))
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  const merged: BusyInterval[] = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s.from <= last.to) last.to = s.to > last.to ? s.to : last.to;
    else merged.push({ ...s });
  }
  return merged;
}

/**
 * Is this candidate slot free? Three answers, not two.
 *
 * `"unknown"` exists because of the all-day case above: an all-day event has no instant, so nothing
 * here can say whether it covers a given instant without inventing the calendar's zone. Returning
 * `"free"` there would be the silent-wrong (book over the founder's day off); returning `"busy"`
 * would refuse every slot on a day with a birthday on it. So the booker is told we do not know, and
 * a caller that cannot handle that must stop at a human — which is where a booking stops anyway.
 */
export function slotAvailability(
  events: readonly ObservedEvent[],
  slot: { from: string; to: string },
): { verdict: "free" | "busy" | "unknown"; why?: string } {
  const day = slot.from.slice(0, 10);
  const opaque = events.filter((e) => e.all_day && e.busy && e.day && e.day === day);
  for (const b of busyIntervals(events)) {
    if (slot.from < b.to && b.from < slot.to) {
      return { verdict: "busy", why: `something is already booked from ${b.from} to ${b.to}` };
    }
  }
  if (opaque.length) {
    return {
      verdict: "unknown",
      why:
        `${opaque.map((e) => e.title ?? "an all-day event").join(" and ")} covers ${day} as an all-day event, which has ` +
        `no instant to compare against — this kernel will not claim the slot is free`,
    };
  }
  return { verdict: "free" };
}

// ═══════════════════════════ THE REGISTRY ═══════════════════════════

/**
 * shape name → reader, per capability.
 *
 * Keyed by capability as well as by shape so that `stripe_invoices` can mean two different readings
 * of the same Stripe payload — a payment under `read_payments`, an invoice under `read_invoices` —
 * without one silently being used where the other was meant. `assertCapabilityTableValid` walks this
 * against the provider table at boot, so a table entry naming a shape that does not exist stops the
 * kernel rather than producing a provider that connects, looks correct, and reads nothing.
 */
export const PAYMENT_SHAPES: Record<string, (data: unknown) => Normalised<ObservedPayment>> = {
  stripe_invoices: normaliseStripeInvoices,
  stripe_charges: normaliseStripeCharges,
  xero_payments: normaliseXeroPayments,
  quickbooks_payments: normaliseQuickBooksPayments,
};

export const INVOICE_SHAPES: Record<string, (data: unknown) => Normalised<ObservedInvoice>> = {
  xero_invoices: normaliseXeroInvoices,
  quickbooks_invoices: normaliseQuickBooksInvoices,
  stripe_invoices: normaliseStripeInvoiceList,
};

export const CALENDAR_SHAPES: Record<string, (data: unknown) => Normalised<ObservedEvent>> = {
  google_calendar_events: normaliseGoogleCalendarEvents,
  outlook_events: normaliseOutlookEvents,
};

// ═══════════════════════════ CRM CONTACTS ═══════════════════════════

/**
 * A CRM contact as the provider describes it, normalised for import into Mycel clients.
 *
 * `email` is required to import — without a handle we cannot match inbound or send a chase, and
 * inventing one is how two people become one client. Phone alone is not enough for the beachhead.
 */
export interface ObservedContact {
  external_id: string;
  /** Display name. Optional — email alone is enough to create a client. */
  display_name?: string;
  /** Primary email, lower-cased. Required for import. */
  email: string;
  phone?: string;
}

const looksLikeEmail = (s: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

function pickEmail(...candidates: unknown[]): string | undefined {
  for (const c of candidates) {
    if (typeof c === "string" && looksLikeEmail(c.trim())) return c.trim().toLowerCase();
    if (Array.isArray(c)) {
      for (const item of c) {
        if (typeof item === "string" && looksLikeEmail(item.trim())) return item.trim().toLowerCase();
        if (item && typeof item === "object") {
          const o = item as Record<string, unknown>;
          const v = str(o.value) ?? str(o.email) ?? str(o.address) ?? str(o.email_address);
          if (v && looksLikeEmail(v)) return v.toLowerCase();
        }
      }
    }
    if (c && typeof c === "object") {
      const o = c as Record<string, unknown>;
      const v = str(o.value) ?? str(o.email) ?? str(o.address) ?? str(o.email_address);
      if (v && looksLikeEmail(v)) return v.toLowerCase();
    }
  }
  return undefined;
}

function pickPhone(...candidates: unknown[]): string | undefined {
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
    if (Array.isArray(c)) {
      for (const item of c) {
        if (typeof item === "string" && item.trim()) return item.trim();
        if (item && typeof item === "object") {
          const v = str((item as Record<string, unknown>).value) ?? str((item as Record<string, unknown>).number);
          if (v) return v;
        }
      }
    }
  }
  return undefined;
}

/** HubSpot contacts page → ObservedContact. */
export function normaliseHubspotContacts(data: unknown): Normalised<ObservedContact> {
  const items: ObservedContact[] = [];
  const skipped: string[] = [];
  for (const r of rows(data, "results", "contacts")) {
    const id = str(r.id) ?? str(r.hs_object_id);
    const props = (r.properties ?? r) as Record<string, unknown>;
    const email = pickEmail(props.email, props.work_email, r.email);
    const first = str(props.firstname) ?? str(props.firstName);
    const last = str(props.lastname) ?? str(props.lastName);
    const name = [first, last].filter(Boolean).join(" ") || str(props.name);
    if (!id) {
      skipped.push("HubSpot contact with no id was skipped");
      continue;
    }
    if (!email) {
      skipped.push(`HubSpot contact ${name ?? id}: no email, so it cannot become a Mycel client`);
      continue;
    }
    items.push({
      external_id: id,
      email,
      ...(name ? { display_name: name } : {}),
      ...(pickPhone(props.phone, props.mobilephone) ? { phone: pickPhone(props.phone, props.mobilephone) } : {}),
    });
  }
  return ok(items, skipped);
}

/** Pipedrive persons → ObservedContact. */
export function normalisePipedrivePersons(data: unknown): Normalised<ObservedContact> {
  const items: ObservedContact[] = [];
  const skipped: string[] = [];
  for (const r of rows(data, "data", "persons")) {
    const id = r.id !== undefined && r.id !== null ? String(r.id) : undefined;
    const email = pickEmail(r.email, r.primary_email);
    const name = str(r.name);
    if (!id) {
      skipped.push("Pipedrive person with no id was skipped");
      continue;
    }
    if (!email) {
      skipped.push(`Pipedrive person ${name ?? id}: no email, so it cannot become a Mycel client`);
      continue;
    }
    items.push({
      external_id: id,
      email,
      ...(name ? { display_name: name } : {}),
      ...(pickPhone(r.phone) ? { phone: pickPhone(r.phone) } : {}),
    });
  }
  return ok(items, skipped);
}

/** Salesforce contacts (SOQL / list) → ObservedContact. */
export function normaliseSalesforceContacts(data: unknown): Normalised<ObservedContact> {
  const items: ObservedContact[] = [];
  const skipped: string[] = [];
  for (const r of rows(data, "records", "contacts")) {
    const id = str(r.Id) ?? str(r.id);
    const email = pickEmail(r.Email, r.email);
    const first = str(r.FirstName) ?? str(r.firstName);
    const last = str(r.LastName) ?? str(r.lastName);
    const name = [first, last].filter(Boolean).join(" ") || str(r.Name) || str(r.name);
    if (!id) {
      skipped.push("Salesforce contact with no Id was skipped");
      continue;
    }
    if (!email) {
      skipped.push(`Salesforce contact ${name ?? id}: no Email, so it cannot become a Mycel client`);
      continue;
    }
    items.push({
      external_id: id,
      email,
      ...(name ? { display_name: name } : {}),
      ...(str(r.Phone) || str(r.phone) ? { phone: str(r.Phone) ?? str(r.phone) } : {}),
    });
  }
  return ok(items, skipped);
}

/**
 * Attio people records → ObservedContact.
 *
 * Attio values are often `{ email_addresses: [{ email_address }] }` or nested under `values`.
 * A row without an email is skipped — same rule as HubSpot.
 */
export function normaliseAttioPeople(data: unknown): Normalised<ObservedContact> {
  const items: ObservedContact[] = [];
  const skipped: string[] = [];
  for (const r of rows(data, "data", "records", "items")) {
    const rawId = r.id;
    const id =
      str(rawId) ??
      (rawId && typeof rawId === "object"
        ? str((rawId as Record<string, unknown>).record_id) ?? str((rawId as Record<string, unknown>).id)
        : undefined) ??
      str(r.record_id);
    const values = (r.values ?? r.attributes ?? r) as Record<string, unknown>;
    const email = pickEmail(
      values.email_addresses,
      values.email,
      values.primary_email_address,
      (values.email_addresses as unknown[])?.[0],
    );
    const name =
      str(values.name) ??
      str((values.name as Record<string, unknown> | undefined)?.full_name) ??
      (() => {
        const n = values.name;
        if (Array.isArray(n) && n[0] && typeof n[0] === "object") {
          return str((n[0] as Record<string, unknown>).full_name) ?? str((n[0] as Record<string, unknown>).value);
        }
        return undefined;
      })();
    const key = id ?? email;
    if (!key) {
      skipped.push("Attio record with no id was skipped");
      continue;
    }
    if (!email) {
      skipped.push(`Attio record ${name ?? key}: no email, so it cannot become a Mycel client`);
      continue;
    }
    items.push({
      external_id: String(key),
      email,
      ...(name ? { display_name: name } : {}),
    });
  }
  return ok(items, skipped);
}

export const CRM_SHAPES: Record<string, (data: unknown) => Normalised<ObservedContact>> = {
  hubspot_contacts: normaliseHubspotContacts,
  pipedrive_persons: normalisePipedrivePersons,
  salesforce_contacts: normaliseSalesforceContacts,
  attio_people: normaliseAttioPeople,
};

/** Does a normaliser exist for this shape on this capability? The boot gate's only question. */
export function hasShape(capability: CapabilityName, shape: string): boolean {
  if (capability === "read_payments") return Object.hasOwn(PAYMENT_SHAPES, shape);
  if (capability === "read_invoices") return Object.hasOwn(INVOICE_SHAPES, shape);
  if (capability === "read_calendar") return Object.hasOwn(CALENDAR_SHAPES, shape);
  if (capability === "read_crm") return Object.hasOwn(CRM_SHAPES, shape);
  // A capability the kernel does not parse has no shapes and must not declare any. Returning false
  // here is what makes `assertCapabilityTableValid` catch a read added to `send_email` by accident.
  return false;
}
