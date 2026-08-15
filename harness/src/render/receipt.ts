// The receipt: what the client gets once their money has landed.
//
// ═══ WHY IT IS A SEPARATE TEMPLATE AND NOT AN INVOICE WITH A STAMP ═══
//
// `invoiceScene` already prints "PAID IN FULL" across a settled invoice, and reusing it was the
// cheap option. It is the wrong document, because an invoice and a receipt make opposite claims. An
// invoice is a DEMAND — it exists to be paid, so it carries a due date, payment instructions and a
// reference to quote. A receipt is an ACKNOWLEDGEMENT: the transaction is closed, and every one of
// those fields is now either meaningless or actively harmful. Bank details on a receipt are an
// invitation to pay twice, and a duplicate payment is a refund conversation and a support ticket
// that nobody needed to have.
//
// So the two templates share the letterhead, the type metrics and the totals arithmetic, and differ
// in exactly the places where the claim differs. What this one adds and the invoice does not have is
// the PAYMENT TABLE: what arrived, when, and how. That is the whole reason a client keeps a receipt —
// they are reconciling their own books against it — and it is the one thing an invoice can never
// show, because at the time an invoice is written none of it has happened yet.
//
// Like every template here it is a pure function. No store, no clock it did not receive, no network.
import { invoiceTotals } from "../billing";
import type { ExternalPayment, PaymentMethod } from "../billing";
import type { BrandKit } from "../brandkit";
import type { Invoice } from "../contract";
import { fontFor, truncateToWidth } from "./fonts";
import { formatMoney } from "./money";
import { A4, SceneBuilder, tint, type Scene } from "./scene";

export interface ReceiptDocumentInput {
  invoice: Invoice;
  /**
   * The payments behind the balance, newest first — the same rows `GET /v1/invoices/:id/payments`
   * serves. Both hand-recorded and provider-read payments appear here, because they are the same
   * kind of row in the same ledger, and a client who paid a deposit by card and the balance by
   * transfer needs to see both on one page.
   */
  payments?: ExternalPayment[];
  bill_to?: { name?: string; email?: string; address?: string[] };
  today?: string;
}

const M = 48;
const RIGHT = A4.width - M;
const COL = { when: 200, method: 330, reference: 430, amount: RIGHT } as const;

/** How many payment rows fit. Past this the document says so rather than running off the page. */
const MAX_ROWS = 14;

/**
 * A payment method as a person says it out loud.
 *
 * Exhaustive over `PAYMENT_METHODS` via the `Record` type, so adding a method to that union fails
 * the build here rather than silently rendering a raw enum value like `bank_transfer` to a client.
 */
const METHOD_LABEL: Record<PaymentMethod, string> = {
  bank_transfer: "Bank transfer",
  cash: "Cash",
  cheque: "Cheque",
  card: "Card",
  other: "Payment",
};

export function receiptScene(input: ReceiptDocumentInput, kit: BrandKit): Scene {
  const inv = input.invoice;
  const b = new SceneBuilder(A4.width, A4.height);
  const totals = invoiceTotals(inv);
  const ink = kit.neutral;
  const faint = tint(ink, 0.55);
  const hair = tint(ink, 0.86);
  const head = kit.type.heading;
  const body = kit.type.body;

  // ── Letterhead, identical to the invoice's: same business, same paper ──────────────────────
  let top = M;
  if (kit.letterhead === "band") {
    b.rect({ x: 0, y: 0, w: A4.width, h: 10, fill: kit.accent });
    top = M + 8;
  }
  const logo = kit.logo;
  if (logo) {
    const h = Math.min(46, (logo.height / logo.width) * 190);
    const w = (logo.width / logo.height) * h;
    b.image({ x: M, y: top, w: Math.min(w, 190), h, mime: logo.mime, data: logo.data });
    b.text({ x: M, y: top + 62, text: kit.display_name, size: 9, family: body, weight: "normal", fill: faint, anchor: "start" });
  } else {
    b.text({ x: M, y: top + 22, text: kit.display_name, size: 20, family: head, weight: "bold", fill: ink, anchor: "start" });
  }

  b.text({ x: RIGHT, y: top + 20, text: "RECEIPT", size: 22, family: head, weight: "bold", fill: kit.accent, anchor: "end", tracking: 1 });
  let meta = top + 42;
  const metaRow = (label: string, value: string) => {
    if (!value) return;
    b.text({ x: RIGHT - 92, y: meta, text: label, size: 9, family: body, weight: "normal", fill: faint, anchor: "end" });
    b.text({ x: RIGHT, y: meta, text: value, size: 9, family: body, weight: "bold", fill: ink, anchor: "end" });
    meta += 14;
  };
  // "For invoice" rather than "Number": this document's own identity is the invoice it settles, and
  // a client filing it needs to see which debt it closes at a glance.
  metaRow("For invoice", inv.number ?? "");
  metaRow("Issued", inv.issue_date ?? "");
  metaRow("Paid", (inv.paid_at ?? "").slice(0, 10));

  let y = Math.max(top + 96, meta + 12);
  if (kit.letterhead === "rule") {
    b.line({ x1: M, y1: y, x2: RIGHT, y2: y, stroke: kit.accent, width: 1.5 });
    y += 26;
  } else {
    y += 12;
  }

  // ── Received from ─────────────────────────────────────────────────────────────────────────
  const to = input.bill_to;
  const toLines = [to?.name, ...(to?.address ?? []), to?.email].filter((l): l is string => !!l);
  if (toLines.length) {
    b.text({ x: M, y, text: "RECEIVED FROM", size: 8, family: body, weight: "bold", fill: faint, anchor: "start", tracking: 0.8 });
    y += 15;
    for (const line of toLines) {
      b.text({ x: M, y, text: truncateToWidth(line, fontFor(body, "normal"), 10, 260), size: 10, family: body, weight: "normal", fill: ink, anchor: "start" });
      y += 13;
    }
  }

  /**
   * The headline, and the only sentence most people read.
   *
   * `amount_paid`, not `total`. On an overpaid invoice those differ, and the honest number to
   * acknowledge is what actually arrived — telling a client we received the invoice total when they
   * sent more is how an overpayment stops being visible to the only person who would notice it.
   */
  const settled = totals.amount_due === 0;
  b.text({
    x: RIGHT,
    y: y - 14,
    text: settled ? "PAID IN FULL" : "PART PAYMENT",
    size: 12,
    family: head,
    weight: "bold",
    fill: settled ? kit.accent : "#b45309",
    anchor: "end",
    tracking: 0.6,
  });
  y += 24;

  b.text({ x: M, y, text: "Thank you — we have received", size: 10, family: body, weight: "normal", fill: faint, anchor: "start" });
  y += 24;
  b.text({ x: M, y, text: formatMoney(totals.amount_paid, inv.currency), size: 26, family: head, weight: "bold", fill: ink, anchor: "start" });
  y += 26;

  // ── The payments themselves ───────────────────────────────────────────────────────────────
  const payments = [...(input.payments ?? [])]
    // Oldest first: a client reading a list of their own payments reads it as a story, and a deposit
    // followed by a balance only makes sense in that order. The API serves them newest-first because
    // an operator wants the latest at the top, which is the opposite need.
    .sort((a, p) => (a.paid_at < p.paid_at ? -1 : a.paid_at > p.paid_at ? 1 : 0));
  const shown = payments.slice(0, MAX_ROWS);
  if (shown.length) {
    y += 8;
    const HEADER_H = 22;
    const ROW_H = 21;
    b.rect({ x: M, y, w: RIGHT - M, h: HEADER_H, fill: tint(kit.accent, 0.9) });
    const heading = (x: number, text: string, anchor: "start" | "end") =>
      b.text({ x, y: y + 15, text, size: 8, family: body, weight: "bold", fill: ink, anchor, tracking: 0.6 });
    heading(M + 10, "DATE", "start");
    heading(COL.method, "METHOD", "end");
    heading(COL.reference, "REFERENCE", "end");
    heading(COL.amount - 10, "AMOUNT", "end");
    y += HEADER_H;

    for (const p of shown) {
      const base = y + 14;
      b.text({ x: M + 10, y: base, text: p.paid_at.slice(0, 10), size: 9.5, family: body, weight: "normal", fill: ink, anchor: "start" });
      b.text({
        x: COL.method,
        y: base,
        // A provider-read payment has no method recorded — the answer is implicit in the connection —
        // and inventing one for the document would be the renderer asserting a fact nobody stored.
        text: p.method ? METHOD_LABEL[p.method] : "—",
        size: 9.5,
        family: body,
        weight: "normal",
        fill: faint,
        anchor: "end",
      });
      if (p.reference) {
        b.text({
          x: COL.reference,
          y: base,
          text: truncateToWidth(p.reference, fontFor(body, "normal"), 9.5, COL.reference - COL.method - 8),
          size: 9.5,
          family: body,
          weight: "normal",
          fill: faint,
          anchor: "end",
        });
      }
      b.text({
        x: COL.amount - 10,
        y: base,
        // A refund is a negative row and prints as one. Netting it into the total above would leave a
        // client who was refunded holding a receipt that silently disagrees with their bank statement.
        text: formatMoney(p.amount_minor, inv.currency),
        size: 9.5,
        family: body,
        weight: "normal",
        fill: ink,
        anchor: "end",
      });
      y += ROW_H;
      b.line({ x1: M, y1: y, x2: RIGHT, y2: y, stroke: hair, width: 0.5 });
    }
    if (payments.length > shown.length) {
      b.text({
        x: M + 10,
        y: y + 14,
        text: `+ ${payments.length - shown.length} further payment${payments.length - shown.length === 1 ? "" : "s"}, included in the total above`,
        size: 9,
        family: body,
        weight: "normal",
        fill: faint,
        anchor: "start",
      });
      y += ROW_H;
    }
  }

  // ── What it settled ───────────────────────────────────────────────────────────────────────
  y += 20;
  const LABEL_RIGHT = RIGHT - 110;
  const totalRow = (label: string, value: string, emphasis = false) => {
    b.text({ x: LABEL_RIGHT, y, text: label, size: emphasis ? 11 : 9.5, family: body, weight: emphasis ? "bold" : "normal", fill: emphasis ? ink : faint, anchor: "end" });
    b.text({ x: RIGHT, y, text: value, size: emphasis ? 11 : 9.5, family: body, weight: "bold", fill: emphasis ? kit.accent : ink, anchor: "end" });
    y += emphasis ? 20 : 15;
  };
  totalRow(`Invoice ${inv.number ?? ""} total`.trim(), formatMoney(totals.total, inv.currency));
  totalRow("Received", formatMoney(totals.amount_paid, inv.currency));
  b.line({ x1: LABEL_RIGHT - 60, y1: y - 8, x2: RIGHT, y2: y - 8, stroke: hair, width: 0.5 });
  y += 6;
  if (totals.amount_paid > totals.total) {
    /**
     * OVERPAYMENT IS PRINTED, NOT ABSORBED.
     *
     * `invoiceTotals.amount_due` floors at zero, so the surplus is invisible in every other number on
     * this page. The client is the person best placed to notice they paid twice, and they only ever
     * see this document — burying it would mean the money quietly stays with the business until
     * somebody audits a ledger, which is the shape of a complaint rather than a bookkeeping entry.
     */
    totalRow("Overpaid — we owe you", formatMoney(totals.amount_paid - totals.total, inv.currency), true);
  } else {
    totalRow(settled ? "Balance" : "Still outstanding", formatMoney(totals.amount_due, inv.currency), true);
  }

  // ── Footer: the kit's small print. NO payment instructions — see the header note. ──────────
  const footerLines = [...kit.footer];
  if (kit.support_email) footerLines.push(kit.support_email);
  if (footerLines.length) {
    let fy = A4.height - M - (footerLines.length - 1) * 11;
    b.line({ x1: M, y1: fy - 18, x2: RIGHT, y2: fy - 18, stroke: hair, width: 0.5 });
    for (const line of footerLines) {
      b.text({ x: M, y: fy, text: line, size: 8, family: body, weight: "normal", fill: faint, anchor: "start" });
      fy += 11;
    }
  }

  return b.done(`${kit.display_name} — Receipt for invoice ${inv.number ?? ""}`.trim());
}
