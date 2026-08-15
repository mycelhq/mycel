// How this business gets paid. One answer, project-scoped, rendered by every surface that faces a
// client: the invoice document, the portal page, and the chase email.
//
// ═══════════════════════════ WHY THIS EXISTS ═══════════════════════════
//
// Before this file the entire client-facing payment surface was `Invoice.payment_link_url` — a string
// a founder pasted in BY HAND, PER INVOICE. Everything downstream inherited that shape's two failures:
//
//   · IT ONLY DESCRIBES ONE RAIL. A URL is a card payment. A business paid by bank transfer has no URL
//     to paste, so the field stays empty for ever, and the portal prints "there are no payment details
//     on this invoice, reply to us and we'll send them over" — which is an invoice that cannot be paid
//     without sending an email first, and then gets chased for being late.
//
//   · IT IS PER-INVOICE, WHICH IS THE WRONG CARDINALITY. A sort code does not change between invoices.
//     Asking for it once per document is asking a founder to re-enter the same twelve digits every
//     time, and the failure mode of any such field is that it is eventually left blank.
//
// So the model is: a business declares its RAILS once, and every document renders whatever is actually
// configured. Not "add Stripe" — Stripe is one of three, and it is not the common one. Most small
// service firms are paid by bank transfer, and after that in cash.
//
// ═══════════════════════════ WHY A SET AND NOT AN ENUM ═══════════════════════════
//
// The obvious model is one field, `payment_method: "stripe" | "bank" | "cash"`. It is wrong, because
// real businesses run more than one at once: a builder takes card for the deposit and cash for the
// final, and an agency offers a link but will happily take a transfer from a client whose finance
// department only does BACS. Forcing a single choice makes the founder pick the one they wish their
// clients used, and the document then omits the one their clients actually use.
//
// So: a set of rails, each independently enabled, in a stable order, with the first enabled one
// leading the block. Nothing is exclusive.
//
// ═══════════════════════════ WHY THE DETAILS ARE FREE-FORM LINES ═══════════════════════════
//
// Not re-litigated here — see the long note at PAYMENT INSTRUCTIONS in payments.manual.ts. Short
// version: IBAN/BIC, sort code/account number, routing/account, PIX key and UPI id are genuinely
// different shapes per country, and a typed banking schema is a form that half the world cannot fill
// in correctly. The founder writes the lines their own clients need to read. This file adds the RAIL
// around those lines — what kind of payment they describe, and therefore how a surface renders them —
// without taking away the founder's ability to write what their bank actually calls things.
//
// ═══════════════════════════ STORAGE: THE SAME ROW, WIDENED ═══════════════════════════
//
// This writes to the record `payments/payment_instructions/default` that `getPaymentInstructions`
// already reads, adding `rails` and `primary` beside the existing `lines`. Deliberately not a new
// table and not a new collection: every business that has already typed its bank details keeps them,
// `getPaymentInstructions` keeps returning exactly what it returned before, and there is no migration
// and no backfill. A business configured before this file existed reads back as a bank-transfer rail
// carrying the lines it already had — which is what those lines always meant.
import type { Invoice } from "./contract";
import { getDomainStore } from "./domain";
import { paymentLinkFor } from "./billing";
import {
  INSTRUCTIONS_COLLECTION,
  MAX_INSTRUCTION_CHARS,
  MAX_INSTRUCTION_LINES,
  PAYMENTS_WEDGE,
  normalizeInstructions,
} from "./payments.manual";

/**
 * The rails, in the order they are offered to a client.
 *
 * Order is not alphabetical and is not arbitrary. It is easiest-to-pay first: a link is one click, a
 * transfer is a trip to a banking app, and cash requires arranging a meeting. A client who can pay the
 * top one never reads the rest, and a client who cannot works down the list.
 */
export const RAIL_KINDS = ["stripe", "bank_transfer", "cash_or_cheque"] as const;
export type RailKind = (typeof RAIL_KINDS)[number];

export const isRailKind = (v: unknown): v is RailKind =>
  typeof v === "string" && (RAIL_KINDS as readonly string[]).includes(v);

export interface PaymentRail {
  kind: RailKind;
  /**
   * Whether this rail is offered. A rail that exists but is disabled is not the same as one that was
   * never configured: it keeps the founder's bank details so that turning it back on does not mean
   * typing them again, and it renders nothing meanwhile.
   */
  enabled: boolean;
  /**
   * What the client reads. Bank details for `bank_transfer`; how to arrange handover for
   * `cash_or_cheque`. Empty for `stripe`, whose instruction is the button itself.
   */
  lines: string[];
}

export interface SellerIdentity {
  /**
   * Registered address, one line per row. What an accounts department looks for under the letterhead.
   * Empty means we do not have one, and the document must say so rather than looking complete.
   */
  address: string[];
  /** Companies House number, EIN, ACN — whatever this jurisdiction puts on an invoice. */
  company_number?: string;
  /** VAT / GST / sales-tax number. Optional: plenty of businesses are not registered. */
  vat_number?: string;
}

export interface PaymentRails {
  /** TENANT SCOPE. Required, never defaulted. */
  project_id: string;
  rails: PaymentRail[];
  /**
   * What new invoices open in. ISO-4217, upper.
   *
   * Absent on purpose when the founder has not said: guessing USD for a UK business is how an
   * invoice lands on a client's desk in the wrong currency, and a wrong currency on an invoice is a
   * dispute, not a formatting issue. The create form reads this; the kernel uses it when the body
   * names none.
   */
  currency?: string;
  seller: SellerIdentity;
}

/** The default shape for a business that has configured nothing: every rail off, no details. */
export function emptyRails(projectId: string): PaymentRails {
  if (!projectId) throw new Error("payment rails must be scoped to a project");
  return {
    project_id: projectId,
    rails: RAIL_KINDS.map((kind) => ({ kind, enabled: false, lines: [] })),
    seller: { address: [] },
  };
}

function toRails(projectId: string, data: Record<string, unknown> | undefined): PaymentRails {
  const out = emptyRails(projectId);
  const byKind = new Map(out.rails.map((r) => [r.kind, r]));

  // ── the legacy row, read forward ──
  //
  // A business configured before rails existed has `lines` and nothing else. Those lines are bank
  // details — that is what the field was for and what every caller rendered them as — so they read
  // back as an ENABLED bank-transfer rail. Reading them as "configured but off" would silently take
  // the payment details off the invoices of every existing customer the day this ships, which is the
  // failing-while-reporting-success shape this repo keeps paying for.
  const legacy = normalizeInstructions(data?.lines);
  if (legacy.length) {
    const bank = byKind.get("bank_transfer")!;
    bank.enabled = true;
    bank.lines = legacy;
  }

  const raw = Array.isArray(data?.rails) ? data!.rails : [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const rec = r as Record<string, unknown>;
    if (!isRailKind(rec.kind)) continue; // An unknown rail is dropped, never rendered as a guess.
    const rail = byKind.get(rec.kind)!;
    rail.enabled = rec.enabled === true;
    rail.lines = normalizeInstructions(rec.lines);
  }

  const currency = typeof data?.currency === "string" ? data.currency.toUpperCase() : "";
  if (/^[A-Z]{3}$/.test(currency)) out.currency = currency;

  const sellerRaw = data?.seller && typeof data.seller === "object" && !Array.isArray(data.seller)
    ? (data.seller as Record<string, unknown>)
    : undefined;
  out.seller = {
    address: normalizeInstructions(sellerRaw?.address ?? data?.address),
    company_number: typeof sellerRaw?.company_number === "string" ? sellerRaw.company_number.trim().slice(0, 40) || undefined : undefined,
    vat_number: typeof sellerRaw?.vat_number === "string" ? sellerRaw.vat_number.trim().slice(0, 40) || undefined : undefined,
  };
  return out;
}

/** How this business gets paid. Tenant-scoped by the query, never filtered afterwards. */
export async function getPaymentRails(projectId: string): Promise<PaymentRails> {
  if (!projectId) throw new Error("reading payment rails must be scoped to a project");
  const rows = await getDomainStore().queryRecords({
    project_id: projectId,
    wedge: PAYMENTS_WEDGE,
    collection: INSTRUCTIONS_COLLECTION,
    limit: 1,
  });
  return toRails(projectId, rows[0]?.data as Record<string, unknown> | undefined);
}

/**
 * Set the rails. Whole-object write, and it keeps `lines` in step for the old reader.
 *
 * `lines` at the top level stays populated with the BANK TRANSFER rail's lines, because
 * `getPaymentInstructions` still reads it and is still called by surfaces this change does not touch.
 * Two readers of one fact is a drift risk, so the write keeps them equal at the single point where
 * either can change, rather than leaving a second copy to rot.
 */
export async function setPaymentRails(projectId: string, input: unknown): Promise<PaymentRails> {
  if (!projectId) throw new Error("setting payment rails must be scoped to a project");
  // A rails array alone is still accepted — that is what the first writer of this file took — and a
  // whole-object body is accepted too, so currency and seller travel with the rails they belong to.
  const rec =
    input && typeof input === "object" && !Array.isArray(input) && !("kind" in (input as object))
      ? (input as Record<string, unknown>)
      : { rails: input };
  const proposed = toRails(projectId, rec);
  const bank = proposed.rails.find((r) => r.kind === "bank_transfer");
  await getDomainStore().upsertRecord({
    project_id: projectId,
    wedge: PAYMENTS_WEDGE,
    collection: INSTRUCTIONS_COLLECTION,
    key: "default",
    data: {
      lines: bank?.enabled ? bank.lines : [],
      rails: proposed.rails,
      ...(proposed.currency ? { currency: proposed.currency } : {}),
      seller: proposed.seller,
    },
  });
  return proposed;
}

/**
 * What an accounts department looks for and does not find.
 *
 * VAT is not in this list: plenty of businesses are not VAT-registered, and demanding a number they
 * do not have would make every one of their invoices look incomplete. Address and company number
 * are the two that turn a PDF into a document a bookkeeper will process rather than bounce.
 */
export function sellerGaps(seller: SellerIdentity): string[] {
  const gaps: string[] = [];
  if (!seller.address.length) gaps.push("registered address");
  if (!seller.company_number) gaps.push("company number");
  return gaps;
}

/** A sentence for the document and the founder's screen. Undefined when the identity is complete. */
export function sellerMissingSentence(seller: SellerIdentity): string | undefined {
  const gaps = sellerGaps(seller);
  if (!gaps.length) return undefined;
  const list = gaps.length === 1 ? gaps[0] : `${gaps.slice(0, -1).join(", ")} and ${gaps[gaps.length - 1]}`;
  return `This invoice is missing the ${list} an accounts department needs — add them under How clients pay you before you send this to a client who will process it.`;
}

/** The offer, flattened for an email body or a chase that cannot render headings. */
export function offerLines(offer: PaymentOffer): string[] {
  const out: string[] = [];
  if (offer.online) out.push(`${offer.online.label}: ${offer.online.url}`);
  for (const block of offer.blocks) {
    out.push(block.heading);
    out.push(...block.lines);
  }
  if (offer.missing) out.push(offer.missing);
  return out;
}

// ═══════════════════════════ WHAT A CLIENT IS SHOWN ═══════════════════════════

export interface PaymentOffer {
  /** A place to pay online, when a rail provides one. */
  online?: { url: string; label: string };
  /** Blocks of instructions, in rail order. Each is rendered under its own heading. */
  blocks: { kind: RailKind; heading: string; lines: string[] }[];
  /**
   * WHY THIS CLIENT CANNOT BE TOLD HOW TO PAY, when that is the case. Undefined when the offer is
   * renderable.
   *
   * Never an empty payment block presented as if it were complete. The house rule is that nothing may
   * fail while reporting success, and an invoice that renders a confident "How to pay" heading over
   * nothing is exactly that failure aimed at the person whose money it is about.
   */
  missing?: string;
}

const HEADING: Record<RailKind, string> = {
  stripe: "Pay by card",
  bank_transfer: "Pay by bank transfer",
  cash_or_cheque: "Cash or cheque",
};

/**
 * What to print on this invoice, for this business, right now.
 *
 * ═══ THE REFERENCE LINE IS NOT DECORATION ═══
 *
 * The bank-transfer block always ends with the invoice number as the payment reference, appended here
 * rather than left to the founder's own lines. That sentence is what makes the money findable later:
 * `reconcileProject` matches a payment to an invoice on the reference the client quoted (match.ts pass
 * one), and it allows no fuzzy fallback. A client who quotes nothing produces a payment that matches
 * nothing, which becomes an `unplaced_payment` for a human to place by hand — and, until they do, an
 * invoice that still looks unpaid and is still being chased.
 *
 * So the one line that most reduces manual work downstream is a line of text on the document, and it
 * is generated rather than typed because a founder cannot type a per-invoice number into a per-project
 * setting.
 */
export async function howToPay(inv: Invoice): Promise<PaymentOffer> {
  if (!inv.project_id) throw new Error("working out how to pay an invoice must be scoped to a project");
  const rails = await getPaymentRails(inv.project_id);
  const offer: PaymentOffer = { blocks: [] };

  for (const rail of rails.rails) {
    if (!rail.enabled) continue;
    if (rail.kind === "stripe") {
      // `paymentLinkFor` remains the single seam for "where does a client pay online". It refuses on
      // drafts and voids, so an unissued invoice cannot render a pay button.
      const url = paymentLinkFor(inv);
      if (url) offer.online = { url, label: HEADING.stripe };
      continue;
    }
    const lines = [...rail.lines];
    if (rail.kind === "bank_transfer") lines.push(`Please quote reference: ${inv.number}`);
    if (lines.length) offer.blocks.push({ kind: rail.kind, heading: HEADING[rail.kind], lines });
  }

  if (!offer.online && offer.blocks.length === 0) {
    // The sentence is about the founder's business, not about our machinery, and it says what would
    // fix it. Which of the two situations it is matters: a business that has configured nothing needs
    // to go and do that, and a business whose only rail is Stripe on a draft invoice needs to issue it.
    const anyEnabled = rails.rails.some((r) => r.enabled);
    offer.missing = anyEnabled
      ? "This invoice cannot show a way to pay yet — the card link is only available once the invoice has been issued."
      : "This business has not said how it takes payment, so this invoice cannot tell the client where to send the money.";
  }
  return offer;
}

/** The limits, re-exported so a form can enforce the same ones the store does. */
export { MAX_INSTRUCTION_CHARS, MAX_INSTRUCTION_LINES };
