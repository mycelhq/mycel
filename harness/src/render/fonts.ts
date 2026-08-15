// Type metrics, and the reason there are only four fonts.
//
// The PDF specification guarantees fourteen fonts are present in every conforming reader without
// being embedded — the "base 14". Four of them are all a business document needs: a sans and a serif,
// each regular and bold. Using them means the kernel ships no font binaries, embeds no licensed
// outlines, and produces a file that opens identically on a phone, a bank's PDF viewer and a
// printer's RIP.
//
// The price is that WE own the metrics: to right-align a total we must know how wide the string is,
// and there is no layout engine to ask. So the widths are here, from the Adobe AFM files, in units
// of 1/1000 em. This is the whole cost of not shipping a browser, and it is one table.
import type { TypeFamily } from "../brandkit";

export type FontWeight = "normal" | "bold";
export type FontId = "Helvetica" | "Helvetica-Bold" | "Times-Roman" | "Times-Bold";

export function fontFor(family: TypeFamily, weight: FontWeight): FontId {
  if (family === "serif") return weight === "bold" ? "Times-Bold" : "Times-Roman";
  return weight === "bold" ? "Helvetica-Bold" : "Helvetica";
}

/** The CSS family a browser should use for the SVG preview, chosen to match the PDF's metrics. */
export function cssFamily(font: FontId): string {
  return font.startsWith("Times") ? "Times New Roman, Times, serif" : "Helvetica, Arial, sans-serif";
}

// Widths for codes 32..126, from the Adobe Core 14 AFMs. Everything above 126 falls back to the
// digit width, which is exact for the glyphs that actually matter above 126 here — $ € ¥ are all
// digit-width in both families, and a currency symbol sits in a right-aligned column.
const WIDTHS: Record<FontId, number[]> = {
  Helvetica: [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
    1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
    333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
    556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
  ],
  "Helvetica-Bold": [
    278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
    975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
    333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
    611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
  ],
  "Times-Roman": [
    250, 333, 408, 500, 500, 833, 778, 180, 333, 333, 500, 564, 250, 333, 250, 278,
    500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 278, 278, 564, 564, 564, 444,
    921, 722, 667, 667, 722, 611, 556, 722, 722, 333, 389, 722, 611, 889, 722, 722,
    556, 722, 667, 556, 611, 722, 722, 944, 722, 722, 611, 333, 278, 333, 469, 500,
    333, 444, 500, 444, 500, 444, 333, 500, 500, 278, 278, 500, 278, 778, 500, 500,
    500, 500, 333, 389, 278, 500, 500, 722, 500, 500, 444, 480, 200, 480, 541,
  ],
  "Times-Bold": [
    250, 333, 555, 500, 500, 1000, 833, 278, 333, 333, 500, 570, 250, 333, 250, 278,
    500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 333, 333, 570, 570, 570, 500,
    930, 722, 667, 722, 722, 667, 611, 778, 778, 389, 500, 778, 667, 944, 722, 778,
    611, 778, 722, 556, 667, 722, 722, 1000, 722, 722, 667, 333, 278, 333, 581, 500,
    333, 500, 556, 444, 556, 444, 333, 500, 556, 278, 333, 556, 278, 833, 556, 500,
    556, 556, 444, 389, 333, 556, 500, 722, 500, 500, 444, 394, 220, 394, 520,
  ],
};

/**
 * The handful of characters that are NOT where Latin-1 puts them in WinAnsiEncoding.
 *
 * A curly apostrophe is what a word processor produces and what a founder will paste into a footer;
 * emitting its UTF-16 code point into a PDF string would render as a random accented letter.
 */
const WIN_ANSI: Record<string, number> = {
  "€": 0x80, "‚": 0x82, "ƒ": 0x83, "„": 0x84, "…": 0x85,
  "†": 0x86, "‡": 0x87, "ˆ": 0x88, "‰": 0x89, "Š": 0x8a,
  "‹": 0x8b, "Œ": 0x8c, "Ž": 0x8e, "‘": 0x91, "’": 0x92,
  "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97,
  "˜": 0x98, "™": 0x99, "š": 0x9a, "›": 0x9b, "œ": 0x9c,
  "ž": 0x9e, "Ÿ": 0x9f,
};

/** A string as WinAnsi bytes. Anything with no WinAnsi glyph becomes "?" — visible, not corrupt. */
export function winAnsiBytes(text: string): Buffer {
  const out = Buffer.alloc(text.length);
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const mapped = WIN_ANSI[ch];
    if (mapped !== undefined) out[i] = mapped;
    else {
      const code = ch.charCodeAt(0);
      out[i] = code >= 32 && code < 256 ? code : 0x3f;
    }
  }
  return out;
}

/** Width of a string at a size, in points. The only reason the table above exists. */
export function textWidth(text: string, font: FontId, size: number): number {
  const w = WIDTHS[font];
  const digit = w[16];
  let total = 0;
  for (const byte of winAnsiBytes(text)) {
    total += byte >= 32 && byte <= 126 ? w[byte - 32] : digit;
  }
  return (total * size) / 1000;
}

/**
 * Cut a string to fit a column, with an ellipsis when it had to.
 *
 * Truncation rather than wrapping is a deliberate limit of this renderer: a wrapping line item
 * changes the height of a row, which changes where the next row starts, which is a layout engine.
 * A description that does not fit is shortened visibly; an invoice that silently reflowed onto a
 * second page nobody generated is worse.
 */
export function truncateToWidth(text: string, font: FontId, size: number, maxWidth: number): string {
  if (textWidth(text, font, size) <= maxWidth) return text;
  const ell = "…";
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (textWidth(text.slice(0, mid) + ell, font, size) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + ell;
}
