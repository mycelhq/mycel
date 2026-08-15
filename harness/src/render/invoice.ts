// The invoice template: structured invoice + brand kit → a Scene.
//
// This is the piece the model does NOT get to write. The agent decides which lines, what note, which
// dunning step; where the total sits, how a tax column aligns and what a paid invoice looks like are
// decided once, here, and are identical for every tenant and every render. That is the founder's
// principle applied to documents: the model chooses content, a workflow chooses rendering.
//
// A template is a pure function. No store, no clock it did not receive, no network. Everything it
// needs — including the logo bytes — arrives in its arguments, which is what makes "this document
// contains this total" a unit test instead of a screenshot.
import { effectiveStatus, invoiceTotals, lineAmount, lineTax } from "../billing";
import type { BrandKit } from "../brandkit";
import type { Invoice } from "../contract";
import type { PaymentOffer, SellerIdentity } from "../payments.rails";
import { fontFor, truncateToWidth } from "./fonts";
import { formatBps, formatMoney, formatQuantityMilli } from "./money";
import { A4, SceneBuilder, tint, type Scene } from "./scene";

export interface InvoiceDocumentInput {
  invoice: Invoice;
  /** Who the document is addressed to. Absent is fine — the block collapses rather than showing
   *  an empty "Bill to" heading over nothing. */
  bill_to?: { name?: string; email?: string; address?: string[] };
  /**
   * Who is issuing it. Address, company number, VAT — the block an accounts department looks for
   * under the letterhead. When it is missing, `seller_missing` is the sentence that says so, and
   * the document prints that sentence rather than looking like a complete invoice it is not.
   */
  seller?: SellerIdentity;
  seller_missing?: string;
  /** Today, for the status derivation. Injected so a test is not at the mercy of the clock. */
  today?: string;
  /**
   * HOW TO PAY THIS. The rails this business has actually configured, rendered in order.
   *
   * Prefer `how_to_pay` over the legacy `payment_instructions` + `payment_link_url` pair. The
   * legacy fields remain so existing tests and a renderer that has not been handed an offer still
   * print something; when the offer is present it is the authority.
   */
  how_to_pay?: PaymentOffer;
  /**
   * @deprecated Prefer `how_to_pay`. Kept so a caller that still has free-form lines (the old
   * payment-instructions row) produces the same document it produced yesterday.
   */
  payment_instructions?: string[];
}

const M = 48; // page margin
const RIGHT = A4.width - M;

/** Column right edges. A number column is right-aligned; that is why `fonts.ts` exists. */
const COL = { qty: 356, unit: 424, tax: 470, amount: RIGHT } as const;
const DESC_WIDTH = COL.qty - M - 90;

/** How many line rows fit above the totals. Past this the document says so rather than overflowing
 *  off the bottom of a page that nobody would ever see. */
const MAX_ROWS = 18;

export function invoiceScene(input: InvoiceDocumentInput, kit: BrandKit): Scene {
  const inv = input.invoice;
  const b = new SceneBuilder(A4.width, A4.height);
  const totals = invoiceTotals(inv);
  const status = effectiveStatus(inv, input.today);
  const ink = kit.neutral;
  const faint = tint(ink, 0.55);
  const hair = tint(ink, 0.86);

  const head = kit.type.heading;
  const body = kit.type.body;

  // ── Letterhead ────────────────────────────────────────────────────────────────────────────
  let top = M;
  if (kit.letterhead === "band") {
    b.rect({ x: 0, y: 0, w: A4.width, h: 10, fill: kit.accent });
    top = M + 8;
  }

  // ── Identity: the logo if we have one, the name in the heading face if we do not ───────────
  // Never a placeholder box. A business with nothing configured gets a clean wordmark.
  const logo = kit.logo;
  if (logo) {
    const h = Math.min(46, (logo.height / logo.width) * 190);
    const w = (logo.width / logo.height) * h;
    b.image({ x: M, y: top, w: Math.min(w, 190), h, mime: logo.mime, data: logo.data });
  } else {
    b.text({ x: M, y: top + 22, text: kit.display_name, size: 20, family: head, weight: "bold", fill: ink, anchor: "start" });
  }
  if (logo) {
    b.text({ x: M, y: top + 62, text: kit.display_name, size: 9, family: body, weight: "normal", fill: faint, anchor: "start" });
  }

  // ── The document's own heading, right ──────────────────────────────────────────────────────
  b.text({ x: RIGHT, y: top + 20, text: "INVOICE", size: 22, family: head, weight: "bold", fill: kit.accent, anchor: "end", tracking: 1 });
  let meta = top + 42;
  const metaRow = (label: string, value: string) => {
    if (!value) return;
    b.text({ x: RIGHT - 92, y: meta, text: label, size: 9, family: body, weight: "normal", fill: faint, anchor: "end" });
    b.text({ x: RIGHT, y: meta, text: value, size: 9, family: body, weight: "bold", fill: ink, anchor: "end" });
    meta += 14;
  };
  metaRow("Number", inv.number ?? "");
  metaRow("Issued", inv.issue_date ?? "");
  metaRow("Due", inv.due_date ?? "");

  let y = Math.max(top + 96, meta + 12);
  if (kit.letterhead === "rule") {
    b.line({ x1: M, y1: y, x2: RIGHT, y2: y, stroke: kit.accent, width: 1.5 });
    y += 26;
  } else {
    y += 12;
  }

  // ── Bill to / From ─────────────────────────────────────────────────────────────────────
  const to = input.bill_to;
  const toLines = [to?.name, ...(to?.address ?? []), to?.email].filter((l): l is string => !!l);
  const seller = input.seller;
  const fromBody = [
    ...(seller?.address ?? []),
    seller?.company_number ? `Company no. ${seller.company_number}` : undefined,
    seller?.vat_number ? `VAT ${seller.vat_number}` : undefined,
  ].filter((l): l is string => !!l);

  const colTop = y;
  let leftY = colTop;
  let rightY = colTop;
  if (toLines.length) {
    b.text({ x: M, y: leftY, text: "BILL TO", size: 8, family: body, weight: "bold", fill: faint, anchor: "start", tracking: 0.8 });
    leftY += 15;
    for (const line of toLines) {
      b.text({ x: M, y: leftY, text: truncateToWidth(line, fontFor(body, "normal"), 10, 260), size: 10, family: body, weight: "normal", fill: ink, anchor: "start" });
      leftY += 13;
    }
  }
  if (fromBody.length) {
    b.text({ x: RIGHT, y: rightY, text: "FROM", size: 8, family: body, weight: "bold", fill: faint, anchor: "end", tracking: 0.8 });
    rightY += 15;
    for (const line of fromBody) {
      b.text({ x: RIGHT, y: rightY, text: truncateToWidth(line, fontFor(body, "normal"), 10, 260), size: 10, family: body, weight: "normal", fill: ink, anchor: "end" });
      rightY += 13;
    }
  }
  y = Math.max(leftY, rightY, colTop);

  if (status === "paid" || totals.amount_due === 0) {
    b.text({ x: RIGHT, y: y + 4, text: "PAID IN FULL", size: 12, family: head, weight: "bold", fill: kit.accent, anchor: "end", tracking: 0.6 });
    y += 18;
  } else if (status === "overdue") {
    b.text({ x: RIGHT, y: y + 4, text: "OVERDUE", size: 12, family: head, weight: "bold", fill: "#b91c1c", anchor: "end", tracking: 0.6 });
    y += 18;
  }

  if (!fromBody.length && input.seller_missing && totals.amount_due > 0) {
    y += 8;
    for (const line of wrapNote(input.seller_missing, 92).slice(0, 3)) {
      b.text({ x: M, y, text: line, size: 8, family: body, weight: "normal", fill: "#b91c1c", anchor: "start" });
      y += 11;
    }
  }
  y += 18;

  // ── Lines ─────────────────────────────────────────────────────────────────────────────────
  const HEADER_H = 22;
  const ROW_H = 21;
  b.rect({ x: M, y, w: RIGHT - M, h: HEADER_H, fill: tint(kit.accent, 0.9) });
  const heading = (x: number, text: string, anchor: "start" | "end") =>
    b.text({ x, y: y + 15, text, size: 8, family: body, weight: "bold", fill: ink, anchor, tracking: 0.6 });
  heading(M + 10, "DESCRIPTION", "start");
  heading(COL.qty, "QTY", "end");
  heading(COL.unit, "UNIT", "end");
  heading(COL.tax, "TAX", "end");
  heading(COL.amount - 10, "AMOUNT", "end");
  y += HEADER_H;

  const lines = inv.lines ?? [];
  const shown = lines.slice(0, MAX_ROWS);
  for (const l of shown) {
    const base = y + 14;
    b.text({
      x: M + 10,
      y: base,
      text: truncateToWidth(l.description || "—", fontFor(body, "normal"), 9.5, DESC_WIDTH),
      size: 9.5,
      family: body,
      weight: "normal",
      fill: ink,
      anchor: "start",
    });
    if (l.kind === "unit") {
      b.text({ x: COL.qty, y: base, text: formatQuantityMilli(l.quantity_milli ?? 0), size: 9.5, family: body, weight: "normal", fill: faint, anchor: "end" });
      b.text({ x: COL.unit, y: base, text: formatMoney(l.unit_amount ?? 0, inv.currency), size: 9.5, family: body, weight: "normal", fill: faint, anchor: "end" });
    }
    if (l.tax_bps) {
      b.text({ x: COL.tax, y: base, text: formatBps(l.tax_bps), size: 9.5, family: body, weight: "normal", fill: faint, anchor: "end" });
    }
    b.text({ x: COL.amount - 10, y: base, text: formatMoney(lineAmount(l), inv.currency), size: 9.5, family: body, weight: "normal", fill: ink, anchor: "end" });
    y += ROW_H;
    b.line({ x1: M, y1: y, x2: RIGHT, y2: y, stroke: hair, width: 0.5 });
  }
  if (lines.length > shown.length) {
    // Said out loud rather than dropped. The totals below are still the totals of ALL lines.
    b.text({
      x: M + 10,
      y: y + 14,
      text: `+ ${lines.length - shown.length} further line${lines.length - shown.length === 1 ? "" : "s"}, included in the totals below`,
      size: 9,
      family: body,
      weight: "normal",
      fill: faint,
      anchor: "start",
    });
    y += ROW_H;
  }

  // ── Totals ────────────────────────────────────────────────────────────────────────────────
  y += 16;
  // The label column ends far enough left that the longest label ("Amount due", bold, 11pt) cannot
  // run into the longest amount. Two right-aligned columns with a fixed gutter, not one guess.
  const LABEL_RIGHT = RIGHT - 110;
  const totalRow = (label: string, value: string, emphasis = false) => {
    b.text({ x: LABEL_RIGHT, y, text: label, size: emphasis ? 11 : 9.5, family: body, weight: emphasis ? "bold" : "normal", fill: emphasis ? ink : faint, anchor: "end" });
    b.text({ x: RIGHT, y, text: value, size: emphasis ? 11 : 9.5, family: body, weight: "bold", fill: emphasis ? kit.accent : ink, anchor: "end" });
    y += emphasis ? 20 : 15;
  };
  totalRow("Subtotal", formatMoney(totals.subtotal, inv.currency));
  if (totals.tax_total !== 0) totalRow("Tax", formatMoney(totals.tax_total, inv.currency));
  totalRow("Total", formatMoney(totals.total, inv.currency));
  if (totals.amount_paid !== 0) totalRow("Paid", `-${formatMoney(totals.amount_paid, inv.currency)}`);
  b.line({ x1: LABEL_RIGHT - 60, y1: y - 8, x2: RIGHT, y2: y - 8, stroke: hair, width: 0.5 });
  y += 6;
  totalRow("Amount due", formatMoney(totals.amount_due, inv.currency), true);

  // ── Note and payment terms ────────────────────────────────────────────────────────────────
  y += 12;
  if (inv.note) {
    for (const line of wrapNote(inv.note, 92).slice(0, 6)) {
      b.text({ x: M, y, text: line, size: 9, family: body, weight: "normal", fill: faint, anchor: "start" });
      y += 12;
    }
  }

  // ── How to pay ────────────────────────────────────────────────────────────────────────────
  //
  // Suppressed entirely once nothing is owed. Payment details on a settled invoice invite a client
  // to pay it a second time, and a duplicate payment is a refund conversation the business did not
  // need to have. This is also why the same block on the receipt template does not exist at all.
  //
  // Rails first: the offer is what every surface renders, so the PDF, the portal and the chase
  // cannot disagree about how this business takes money. The legacy lines+link pair remains for a
  // caller that has not been handed an offer yet — existing tests, an older attach path.
  if (totals.amount_due > 0) {
    const offer = input.how_to_pay;
    const legacyLines = (input.payment_instructions ?? []).filter((l) => !!l && !!l.trim()).slice(0, 6);
    const legacyLink = inv.status === "draft" || inv.status === "void" ? undefined : inv.payment_link_url;
    const hasOffer = offer && (offer.online || offer.blocks.length > 0);
    const hasLegacy = !offer && (legacyLines.length > 0 || !!legacyLink);

    if (hasOffer || hasLegacy) {
      y += 8;
      b.text({ x: M, y, text: "HOW TO PAY", size: 8, family: body, weight: "bold", fill: faint, anchor: "start", tracking: 0.8 });
      y += 14;
      if (hasOffer && offer) {
        if (offer.online) {
          b.text({
            x: M,
            y,
            text: truncateToWidth(`${offer.online.label}: ${offer.online.url}`, fontFor(body, "normal"), 9, RIGHT - M),
            size: 9,
            family: body,
            weight: "normal",
            fill: kit.accent,
            anchor: "start",
          });
          y += 12;
        }
        for (const block of offer.blocks) {
          b.text({ x: M, y, text: block.heading, size: 8, family: body, weight: "bold", fill: faint, anchor: "start" });
          y += 12;
          for (const line of block.lines) {
            b.text({
              x: M,
              y,
              text: truncateToWidth(line, fontFor(body, "normal"), 9, RIGHT - M),
              size: 9,
              family: body,
              weight: "normal",
              fill: ink,
              anchor: "start",
            });
            y += 12;
          }
        }
      } else {
        for (const line of legacyLines) {
          b.text({
            x: M,
            y,
            text: truncateToWidth(line, fontFor(body, "normal"), 9, RIGHT - M),
            size: 9,
            family: body,
            weight: "normal",
            fill: ink,
            anchor: "start",
          });
          y += 12;
        }
        if (legacyLink) {
          b.text({
            x: M,
            y,
            text: truncateToWidth(`Pay online: ${legacyLink}`, fontFor(body, "normal"), 9, RIGHT - M),
            size: 9,
            family: body,
            weight: "normal",
            fill: kit.accent,
            anchor: "start",
          });
          y += 12;
        }
        if (inv.number) {
          b.text({
            x: M,
            y,
            text: `Please quote ${inv.number} as the payment reference.`,
            size: 9,
            family: body,
            weight: "normal",
            fill: faint,
            anchor: "start",
          });
          y += 12;
        }
      }
    } else if (offer?.missing) {
      y += 8;
      for (const line of wrapNote(offer.missing, 92).slice(0, 3)) {
        b.text({ x: M, y, text: line, size: 8, family: body, weight: "normal", fill: faint, anchor: "start" });
        y += 11;
      }
    }
  }

  // ── Footer: the kit's small print, on every artifact this business produces ────────────────
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

  return b.done(`${kit.display_name} — Invoice ${inv.number ?? ""}`.trim());
}

/**
 * Word wrapping for the ONE free-text field on the document.
 *
 * By character count rather than by measured width, because the note sits in a single full-width
 * column where a few points of slack cost nothing — and a measured wrap here would be the first
 * step toward a layout engine this renderer has deliberately decided not to be.
 */
function wrapNote(note: string, cols: number): string[] {
  const out: string[] = [];
  for (const paragraph of note.split(/\n+/)) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (line && line.length + 1 + word.length > cols) {
        out.push(line);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    if (line) out.push(line);
  }
  return out;
}
