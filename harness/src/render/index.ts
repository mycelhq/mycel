// The registry, and the only thing outside this directory needs to import.
//
// THE SEAM, IN ONE PLACE
// ----------------------
// A document type is `(input, kit: BrandKit) => Scene` plus an entry in `TEMPLATES` below. Adding a
// report or a proposal means writing that function and naming it here. It inherits, without
// touching any of them: the brand kit, the type metrics, the SVG serialiser, the PDF emitter, the
// logo pipeline, the artifact write and the download route.
//
// What it must NOT do is invent a second way to produce bytes. `render()` is the only path from a
// Scene to a file, so every artifact this kernel emits is the same kind of object.
import type { BrandKit } from "../brandkit";
import { certificateScene, type CertificateDocumentInput } from "./certificate";
import { invoiceScene, type InvoiceDocumentInput } from "./invoice";
import { receiptScene, type ReceiptDocumentInput } from "./receipt";
import { proposalScene, type ProposalDocumentInput } from "./proposal";
import { reportScenes, type ReportDocumentInput } from "./report";
import { deckScenes, type DeckDocumentInput } from "./deck";
import { toPdf, toPdfPages } from "./pdf";
import type { Scene } from "./scene";
import { toSvg } from "./svg";
import { isBlocking, tasteFindings, type TasteFinding } from "./taste";

export type DocumentFormat = "pdf" | "svg";

/** Every document type the kernel can render, and the shape each one is handed. */
export interface DocumentInputs {
  invoice: InvoiceDocumentInput;
  receipt: ReceiptDocumentInput;
  report: ReportDocumentInput;
  /**
   * A deck. 16:9 rather than A4, and the whole of what that cost was a page size — see the header
   * of `deck.ts`. It is the proof that `design.ts` is a system and not a stylesheet for one template.
   */
  deck: DeckDocumentInput;
  /**
   * The evidence page for an executed agreement. Its own kind rather than a `report` assembled by
   * the caller, because a certificate has a FIXED structure that must not vary — see the header of
   * certificate.ts. A report is a container for whatever somebody put in it, and the day one is
   * built with the event log missing it will lay out cleanly and look correct.
   */
  certificate: CertificateDocumentInput;
  /**
   * The document a client signs. Built from the STRUCTURED output rather than from prose, because
   * the scope, the price and the term are what is being signed and those are fields `ship_checks`
   * already verified — see the header of proposal.ts.
   */
  proposal: ProposalDocumentInput;
}
export type DocumentKind = keyof DocumentInputs;

// A template returns one Scene (a single-page document) or an array of Scenes (one per page). The
// registry normalises the two so a template author never thinks about the PDF object graph.
const TEMPLATES: { [K in DocumentKind]: (input: DocumentInputs[K], kit: BrandKit) => Scene | Scene[] } = {
  invoice: invoiceScene,
  receipt: receiptScene,
  report: reportScenes,
  deck: deckScenes,
  certificate: certificateScene,
  proposal: proposalScene,
};

/** Filenames a human recognises in a downloads folder, per type. */
const BASENAME: Record<DocumentKind, (input: any) => string> = {
  invoice: (i: InvoiceDocumentInput) => `invoice-${i.invoice.number ?? i.invoice.id}`,
  // `receipt-INV-0007`, not `receipt-<uuid>`: these two files land in the same downloads folder and
  // the invoice number is the only token that ties them together for the person looking at them.
  receipt: (i: ReceiptDocumentInput) => `receipt-${i.invoice.number ?? i.invoice.id}`,
  // The report's own title is the name a human looks for; the sanitiser in `render` makes it safe.
  report: (i: ReportDocumentInput) => `report-${i.title || "document"}`,
  deck: (i: DeckDocumentInput) => `${i.title || "deck"}`,
  // Named for what it certifies, because it lands in a folder beside the thing it certifies.
  certificate: (i: CertificateDocumentInput) => `certificate-${i.certificate.title || "agreement"}`,
  proposal: (i: ProposalDocumentInput) => `proposal-${i.client || "engagement"}`,
};

/**
 * What the artifact layer stores. Deliberately shaped like `NewArtifact` minus the task, because the
 * caller's job is to attach it, not to reformat it.
 */
export interface RenderedDocument {
  name: string;
  content_type: string;
  /** PDFs are base64 — read the `Artifact.content` comment in contract.ts. SVG is text. */
  encoding: "utf8" | "base64";
  content: string;
  /** Size of the DECODED bytes, which is what a human means by "how big is that file". */
  size_bytes: number;
  /**
   * ═══ WHAT IS WRONG WITH HOW IT LOOKS ═══
   *
   * Every document is linted on the way out — see `taste.ts`. This is attached rather than thrown
   * because the caller owns the consequence: a preview shows them, and the delivery path holds the
   * task when one of them is `isBlocking` (text off the page, text on text, a page that is one line).
   *
   * Attached even when empty, so a caller that checks it never has to wonder whether the check ran.
   */
  taste: TasteFinding[];
}

/** The blocking findings only — what a delivery path refuses on. */
export function tasteBlockers(doc: RenderedDocument): TasteFinding[] {
  return doc.taste.filter(isBlocking);
}

export function render<K extends DocumentKind>(
  kind: K,
  input: DocumentInputs[K],
  kit: BrandKit,
  format: DocumentFormat = "pdf",
): RenderedDocument {
  const produced = TEMPLATES[kind](input, kit);
  const pages = Array.isArray(produced) ? produced : [produced];
  // A filename must not be able to escape a directory or inject a header — the artifact download
  // route puts it in a Content-Disposition, and the fs backend puts it on a disk.
  // Runs of dots collapse as well as separators being stripped: `..` is meaningless in a filename
  // and is the token every traversal attempt is built from.
  const base = BASENAME[kind](input).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/\.{2,}/g, ".").slice(0, 100) || kind;
  const taste = tasteFindings(pages);
  if (format === "svg") {
    // SVG is the preview format, and a preview is one page — the first. A multi-page report previews
    // its cover; the full document is the PDF.
    const svg = toSvg(pages[0]);
    return {
      name: `${base}.svg`,
      content_type: "image/svg+xml",
      encoding: "utf8",
      content: svg,
      size_bytes: Buffer.byteLength(svg, "utf8"),
      taste,
    };
  }
  const pdf = toPdfPages(pages);
  return {
    name: `${base}.pdf`,
    content_type: "application/pdf",
    encoding: "base64",
    content: pdf.toString("base64"),
    size_bytes: pdf.length,
    taste,
  };
}

/** The Scene(s), for tests and for anything that wants to inspect the layout rather than a file. */
export function scenes<K extends DocumentKind>(kind: K, input: DocumentInputs[K], kit: BrandKit): Scene[] {
  const produced = TEMPLATES[kind](input, kit);
  return Array.isArray(produced) ? produced : [produced];
}

/** The first (or only) Scene — the single-page inspector and the preview both want one page. */
export function scene<K extends DocumentKind>(kind: K, input: DocumentInputs[K], kit: BrandKit): Scene {
  return scenes(kind, input, kit)[0];
}

export { toPdf, toPdfPages, toSvg };
export type { Scene };
export type { InvoiceDocumentInput, ReceiptDocumentInput, ReportDocumentInput, DeckDocumentInput };
export type { DeckSlide } from "./deck";
export { SLIDE, slidesFromBlocks } from "./deck";
export { tasteFindings, isBlocking } from "./taste";
export type { TasteFinding } from "./taste";
export { designFor, as } from "./design";
export type { DesignSystem, TypeRole, RoleName } from "./design";
