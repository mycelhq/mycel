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
import { invoiceScene, type InvoiceDocumentInput } from "./invoice";
import { receiptScene, type ReceiptDocumentInput } from "./receipt";
import { reportScenes, type ReportDocumentInput } from "./report";
import { toPdf, toPdfPages } from "./pdf";
import type { Scene } from "./scene";
import { toSvg } from "./svg";

export type DocumentFormat = "pdf" | "svg";

/** Every document type the kernel can render, and the shape each one is handed. */
export interface DocumentInputs {
  invoice: InvoiceDocumentInput;
  receipt: ReceiptDocumentInput;
  report: ReportDocumentInput;
}
export type DocumentKind = keyof DocumentInputs;

// A template returns one Scene (a single-page document) or an array of Scenes (one per page). The
// registry normalises the two so a template author never thinks about the PDF object graph.
const TEMPLATES: { [K in DocumentKind]: (input: DocumentInputs[K], kit: BrandKit) => Scene | Scene[] } = {
  invoice: invoiceScene,
  receipt: receiptScene,
  report: reportScenes,
};

/** Filenames a human recognises in a downloads folder, per type. */
const BASENAME: Record<DocumentKind, (input: any) => string> = {
  invoice: (i: InvoiceDocumentInput) => `invoice-${i.invoice.number ?? i.invoice.id}`,
  // `receipt-INV-0007`, not `receipt-<uuid>`: these two files land in the same downloads folder and
  // the invoice number is the only token that ties them together for the person looking at them.
  receipt: (i: ReceiptDocumentInput) => `receipt-${i.invoice.number ?? i.invoice.id}`,
  // The report's own title is the name a human looks for; the sanitiser in `render` makes it safe.
  report: (i: ReportDocumentInput) => `report-${i.title || "document"}`,
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
    };
  }
  const pdf = toPdfPages(pages);
  return {
    name: `${base}.pdf`,
    content_type: "application/pdf",
    encoding: "base64",
    content: pdf.toString("base64"),
    size_bytes: pdf.length,
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
export type { InvoiceDocumentInput, ReceiptDocumentInput, ReportDocumentInput };
