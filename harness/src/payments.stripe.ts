// Stripe as ONE rail, not as the product.
//
// ═══════════════════════════ WHY THIS FILE IS NOT "ADD STRIPE" ═══════════════════════════
//
// `payments.rails.ts` is the model: a business declares how it gets paid, and Stripe is one of
// three. This file is the Stripe-shaped half of that declaration — generate a checkout URL for
// THIS invoice from integer minor units, and settle the invoice when Stripe says the money moved.
//
// It does not create Products or Prices in the founder's Stripe account. Checkout Sessions accept
// `price_data` inline, which is an amount and a currency for one payment, and that is the whole
// of what an invoice is. Writing a Product would leave a live catalogue of every invoice this
// business has ever issued, which we have no business owning and no brief to tidy up.
//
// ═══════════════════════════ MONEY MOVES IN THE FOUNDER'S ACCOUNT ═══════════════════════════
//
// Mycel does not collect. The checkout is created through the founder's own connected Stripe
// (Composio, founder-owned, this project), so the charge lands in their account and the risk stays
// with them. See `PAYMENT_SEAM` in billing.ts. The kernel's job is to point at the right checkout
// and to notice when it is paid — not to take a cut, not to hold funds, not to invent a Connect
// platform on the way past.
//
// ═══════════════════════════ WEBHOOK IS A FAST PATH, POLL IS THE RECORD ═══════════════════════════
//
// `payments.ts` argues at length that a webhook cannot tell you that nothing happened, and that
// argument is not re-litigated here. `reconcileProject` remains the mechanism of record. This file
// is the latency optimisation on top: when Stripe (via Composio) tells us a checkout completed, we
// settle THAT invoice immediately through the same `applyExternalPayment` ledger the poll uses, so
// a double delivery cannot double-count and a missed delivery is picked up within `SYNC_SECONDS`.
import type { Connection, Invoice } from "./contract";
import type { ActionResult } from "./actions";
import { noteInvoiceSettled, systemMoveAuthority } from "./moves";
import { getDomainStore } from "./domain";
import { standDownChases } from "./dunning";
import { getPaymentRails } from "./payments.rails";
import {
  canTransition,
  getBillingStore,
  invoiceTotals,
  type ExternalPayment,
} from "./billing";

/**
 * Composio's Stripe checkout slug. Unverified against the live catalogue in this environment —
 * a wrong slug fails the honest way (no URL, invoice still issues, bank/cash rails still print)
 * rather than inventing a Product to make a different tool work.
 */
export const STRIPE_CHECKOUT_TOOL = "STRIPE_CREATE_CHECKOUT_SESSION";

export interface CheckoutDeps {
  listConnections(): Promise<Connection[]>;
  execute(conn: Connection, tool: string, payload: Record<string, unknown>): Promise<ActionResult>;
  /** Success/cancel URLs on the Checkout Session. Injected so tests do not need MYCEL_PUBLIC_URL. */
  publicUrl(): string;
}

let checkoutDeps: CheckoutDeps | null = null;
export function setCheckoutDeps(d: CheckoutDeps | null): void {
  checkoutDeps = d;
}

/**
 * A checkout URL for this invoice, created if the Stripe rail is on and none exists yet.
 *
 * Never on a draft or a void — a link to pay something that has not been issued is a support
 * ticket, and `paymentLinkFor` already refuses those. Best-effort: a Stripe that will not create a
 * session must not fail the issue, because the other rails still work and the founder still needs
 * the invoice to go out.
 */
export async function ensureStripeCheckout(inv: Invoice): Promise<string | undefined> {
  if (!inv.project_id) throw new Error("creating a checkout must be scoped to a project");
  if (inv.status === "draft" || inv.status === "void") return undefined;
  if (inv.payment_link_url) return inv.payment_link_url;

  const rails = await getPaymentRails(inv.project_id);
  if (!rails.rails.some((r) => r.kind === "stripe" && r.enabled)) return undefined;
  if (!checkoutDeps) return undefined;

  const totals = invoiceTotals(inv);
  if (totals.amount_due <= 0) return undefined;
  if (!Number.isSafeInteger(totals.amount_due)) {
    // A float here would be a bug upstream. Refusing is the only honest option — charging 12 cents
    // for a $12.50 invoice is worse than having no card button.
    console.error(`[mycel] refused to create a checkout for invoice ${inv.id}: amount_due is not an integer`);
    return undefined;
  }

  const all = await checkoutDeps.listConnections();
  // Exact project_id equality, founder-owned only. A client-owned Stripe is the CLIENT's account;
  // charging their customers to settle OUR invoice is the cross-tenant leak in the other direction.
  const conn = all.find((c) => {
    if (c.project_id !== inv.project_id) return false;
    if (c.owner?.kind !== "founder") return false;
    const cfg = (c.config ?? {}) as Record<string, unknown>;
    return cfg.toolkit === "stripe" && typeof cfg.verified_at === "string" && cfg.verified_at;
  });
  if (!conn) {
    console.warn(
      `[mycel] invoice ${inv.number} wants a card link but this business has no verified Stripe connection`,
    );
    return undefined;
  }

  const origin = checkoutDeps.publicUrl().replace(/\/$/, "");
  const payload = {
    mode: "payment",
    // `price_data`, not a Price id. Creating a Product/Price per invoice would write into the
    // founder's live Stripe catalogue, which this file is forbidden to touch.
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: inv.currency.toLowerCase(),
          unit_amount: totals.amount_due,
          product_data: { name: `Invoice ${inv.number}` },
        },
      },
    ],
    client_reference_id: inv.id,
    metadata: {
      mycel_invoice_id: inv.id,
      mycel_invoice_number: inv.number,
      mycel_project_id: inv.project_id,
    },
    payment_intent_data: {
      metadata: {
        mycel_invoice_id: inv.id,
        mycel_invoice_number: inv.number,
        mycel_project_id: inv.project_id,
      },
    },
    success_url: `${origin}/portal/invoices/${inv.id}?paid=1`,
    cancel_url: `${origin}/portal/invoices/${inv.id}`,
  };

  const res = await checkoutDeps.execute(conn, STRIPE_CHECKOUT_TOOL, payload);
  if (!res.ok) {
    console.warn(`[mycel] Stripe checkout for invoice ${inv.number} was refused: ${res.detail ?? "no reason"}`);
    return undefined;
  }
  const url = checkoutUrlFrom(res.data);
  if (!url) {
    console.warn(`[mycel] Stripe checkout for invoice ${inv.number} returned no URL`);
    return undefined;
  }
  const updated = await getBillingStore().updateInvoice(inv.id, { payment_link_url: url });
  return updated?.payment_link_url ?? url;
}

/** Pull a checkout URL out of the shapes Composio actually returns. */
export function checkoutUrlFrom(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const rec = data as Record<string, unknown>;
  const nested = rec.data && typeof rec.data === "object" ? (rec.data as Record<string, unknown>) : rec;
  for (const v of [nested.url, nested.checkout_url, nested.payment_url, rec.url]) {
    if (typeof v === "string" && /^https:\/\//i.test(v)) return v;
  }
  return undefined;
}

export interface StripeSettlement {
  /** TENANT SCOPE. From the CONNECTION, never from the payload alone. */
  project_id: string;
  /** Stripe's id for this money movement. The idempotency key. */
  external_id: string;
  amount_minor: number;
  currency: string;
  paid_at: string;
  /** From Checkout metadata. Verified against the invoice's own project_id before anything writes. */
  invoice_id?: string;
  reference?: string;
}

export interface StripeSettleResult {
  applied: boolean;
  settled: boolean;
  invoice_id?: string;
  detail: string;
}

/**
 * Settle one invoice from a Stripe event. THE FAST PATH.
 *
 * `project_id` is required and is the connection's project, not a field the payload gets to name.
 * An event that names another tenant's invoice id is refused, not applied — the same closed door
 * `applyExternalPayment` already has in its WHERE clause, checked here so the refusal is a sentence
 * rather than a quiet no-op.
 *
 * A second delivery of the same `external_id` returns `{ applied: false, settled: false }` and
 * writes nothing. That is success: it is the ledger doing its job.
 */
export async function settleStripePayment(input: StripeSettlement): Promise<StripeSettleResult> {
  const projectId = input.project_id;
  if (!projectId) throw new Error("settling a Stripe payment must be scoped to a project");
  if (!Number.isSafeInteger(input.amount_minor) || input.amount_minor === 0) {
    return { applied: false, settled: false, detail: "a Stripe payment has to be a whole number of minor units, and not zero" };
  }
  if (!input.external_id) {
    return { applied: false, settled: false, detail: "a Stripe payment needs Stripe's own id so delivering it twice cannot count it twice" };
  }

  const billing = getBillingStore();
  let inv: Invoice | undefined;
  if (input.invoice_id) {
    inv = await billing.getInvoice(input.invoice_id);
    // Strict equality. Never `!inv.project_id || inv.project_id === projectId` — that is the leak
    // this repo has shipped four times, and on a payment it fabricates revenue for one business
    // while leaving the other still chasing.
    if (!inv || inv.project_id !== projectId) {
      return {
        applied: false,
        settled: false,
        detail: `refused to apply a Stripe payment to invoice ${input.invoice_id}, which is not in project ${projectId}`,
      };
    }
  }
  if (!inv) {
    return { applied: false, settled: false, detail: "this Stripe event named no invoice we can settle" };
  }
  if (inv.status === "draft" || inv.status === "void") {
    return { applied: false, settled: false, invoice_id: inv.id, detail: `invoice ${inv.number} cannot take a payment in status ${inv.status}` };
  }
  if (input.currency && inv.currency && input.currency.toUpperCase() !== inv.currency.toUpperCase()) {
    return {
      applied: false,
      settled: false,
      invoice_id: inv.id,
      detail: `a payment in ${input.currency} matched invoice ${inv.number}, which is in ${inv.currency} — nothing was applied`,
    };
  }

  const record: ExternalPayment = {
    project_id: projectId,
    invoice_id: inv.id,
    external_id: input.external_id.startsWith("stripe:") ? input.external_id : `stripe:${input.external_id}`,
    amount_minor: input.amount_minor,
    currency: inv.currency.toUpperCase(),
    paid_at: input.paid_at,
    basis: "reference",
    source: "stripe checkout",
    method: "card",
    reference: input.reference ?? inv.number,
  };
  const { applied, invoice } = await billing.applyExternalPayment(record);
  if (!invoice) {
    console.error(`[mycel] Stripe settlement refused: invoice ${inv.id} is not in project ${projectId}`);
    return { applied: false, settled: false, detail: "No such invoice." };
  }
  if (!applied) {
    return { applied: false, settled: false, invoice_id: invoice.id, detail: `payment ${record.external_id} was already applied` };
  }

  const totals = invoiceTotals(invoice);
  let settled = false;
  if (totals.amount_due === 0 && canTransition(invoice.status, "paid")) {
    await standDownChases(invoice, "Stripe reported this invoice paid").catch((e) =>
      console.error(`[mycel] could not stand down chases for invoice ${invoice.id}:`, e),
    );
    const done = await billing.transitionInvoice(invoice.id, "paid", ["sent", "overdue"], { paid_at: input.paid_at });
    if (done) {
      settled = true;
      await noteInvoiceSettled(getDomainStore(), systemMoveAuthority(done.project_id), done, input.paid_at).catch((e) =>
        console.error(`[mycel] could not attribute the settlement of invoice ${done.id}:`, e),
      );
    }
  }
  return {
    applied: true,
    settled,
    invoice_id: invoice.id,
    detail: settled ? `invoice ${invoice.number} settled from Stripe` : `applied ${input.amount_minor} to invoice ${invoice.number}`,
  };
}

/**
 * Pull a settlement out of a Composio Stripe trigger payload.
 *
 * Returns undefined when the event is not a payment we can settle — a customer created, a product
 * updated, a checkout that is still open. The caller then falls through to `reconcileProject`,
 * which is the right next step for anything this function cannot name with certainty.
 */
export function settlementFromStripeEvent(
  projectId: string,
  data: Record<string, unknown>,
): StripeSettlement | undefined {
  if (!projectId) throw new Error("reading a Stripe event must be scoped to a project");
  const obj = data.object && typeof data.object === "object" ? (data.object as Record<string, unknown>) : data;
  const meta = (obj.metadata && typeof obj.metadata === "object" ? obj.metadata : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  const num = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) ? v : undefined);

  const invoiceId = str(meta.mycel_invoice_id) ?? str(obj.client_reference_id);
  const amount =
    num(obj.amount_total) ??
    num(obj.amount_captured) ??
    num(obj.amount_paid) ??
    num(obj.amount);
  const currency = str(obj.currency)?.toUpperCase();
  const id = str(obj.id) ?? str(obj.payment_intent);
  if (!id || amount === undefined || amount === 0) return undefined;

  // Checkout sessions report amount_total in minor units already. A paid session that is not
  // `complete` / `paid` is not money — it is a form somebody opened.
  const status = str(obj.status) ?? str(obj.payment_status);
  if (status && !["complete", "paid", "succeeded"].includes(status)) return undefined;

  const paidAt =
    stripeTime(obj.created) ??
    stripeTime((obj.status_transitions as Record<string, unknown> | undefined)?.paid_at) ??
    new Date().toISOString();

  return {
    project_id: projectId,
    external_id: id,
    amount_minor: amount,
    currency: currency ?? "USD",
    paid_at: paidAt,
    invoice_id: invoiceId,
    reference: str(meta.mycel_invoice_number) ?? str(meta.invoice_number),
  };
}

function stripeTime(v: unknown): string | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v * 1000).toISOString();
  if (typeof v === "string" && v) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 1_000_000_000) return new Date(n * 1000).toISOString();
    const d = Date.parse(v);
    if (Number.isFinite(d)) return new Date(d).toISOString();
  }
  return undefined;
}
