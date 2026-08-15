// The report template: a structured report + brand kit → a paginated Scene[].
//
// This is the artifact half of the top-20 the kernel could not make. Invoices and receipts are one
// page of positioned numbers; a monthly-close pack, a GEO report, a candidate packet, a filled
// questionnaire are FLOWED PROSE that runs to several pages. The seam the render directory reserved
// for exactly this (`pdf.ts` header: "a second EMITTER against the same Scene") is `toPdfPages`, and
// pagination is done HERE, in the template, using the same `fonts.ts` metrics the invoice uses to
// align a column — so the preview a founder sees and the document a client receives still cannot
// drift.
//
// The founder principle, applied to documents: the MODEL chooses the content (which sections, what
// each says), a WORKFLOW chooses the rendering (where the heading sits, how a paragraph wraps, where
// the page breaks, what the footer says). The model fills `blocks`; it never positions a glyph.
//
// A template is a pure function of its input and the kit. No store, no clock it did not receive, no
// network. `blocksFromMarkdown` lets a wedge hand the model's markdown straight in — the model's
// natural output — without the model ever touching layout.
import type { BrandKit } from "../brandkit";
import { fontFor, textWidth } from "./fonts";
import { A4, SceneBuilder, tint, type Scene } from "./scene";
import type { TypeFamily } from "../brandkit";
import type { FontWeight } from "./fonts";

// ── The input the model fills ──────────────────────────────────────────────────────────────────

/** A stat/field row: a label and its value, e.g. "Net profit" / "£12,480". */
export interface ReportField {
  label: string;
  value: string;
}

/** The body is a list of blocks. The model picks the blocks; the template lays them out. */
export type ReportBlock =
  | { kind: "heading"; text: string; level?: 1 | 2 }
  | { kind: "paragraph"; text: string }
  | { kind: "bullets"; items: string[] }
  | { kind: "fields"; rows: ReportField[] }
  | { kind: "table"; columns: string[]; rows: string[][] }
  | { kind: "divider" };

export interface ReportDocumentInput {
  /** The report's own title, in the letterhead. */
  title: string;
  /** One line under the title — the period, the client, the engagement. Optional. */
  subtitle?: string;
  /** Header meta rows, right-aligned under the document heading (Prepared, Period, For). */
  meta?: ReportField[];
  /** The report itself. */
  blocks: ReportBlock[];
  /** A footer note carried on every page (confidentiality, a reference). Optional. */
  footer?: string;
}

// ── Geometry ─────────────────────────────────────────────────────────────────────────────────

const M = 48; // page margin, matching the invoice
const RIGHT = A4.width - M;
const CONTENT_W = RIGHT - M;
const BOTTOM = A4.height - 64; // leave room for the footer
const CONT_TOP = M + 8; // where body starts on a continuation page

// ── Text measurement + wrapping ────────────────────────────────────────────────────────────────

/**
 * Greedy word wrap using the real Base-14 metrics. A token longer than the line (a URL, a long
 * reference) is hard-broken by character rather than allowed to run off the margin — the one place
 * "we do not wrap" (fonts.ts) is not good enough, because a report is prose and prose has long words.
 */
export function wrapText(text: string, family: TypeFamily, weight: FontWeight, size: number, maxWidth: number): string[] {
  const font = fontFor(family, weight);
  const out: string[] = [];
  for (const rawLine of String(text ?? "").split("\n")) {
    const words = rawLine.split(/\s+/).filter((w) => w.length > 0);
    if (words.length === 0) {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (textWidth(candidate, font, size) <= maxWidth || !line) {
        // A single word wider than the line: break it by character rather than overflow.
        if (!line && textWidth(word, font, size) > maxWidth) {
          let chunk = "";
          for (const ch of word) {
            if (textWidth(chunk + ch, font, size) > maxWidth && chunk) {
              out.push(chunk);
              chunk = ch;
            } else {
              chunk += ch;
            }
          }
          line = chunk;
        } else {
          line = candidate;
        }
      } else {
        out.push(line);
        line = word;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

// ── Markdown → blocks, so a wedge can hand the model's natural output straight in ────────────────

/**
 * A deliberately small markdown reader: `#`/`##` headings, `-`/`*` bullets, `key: value` field runs,
 * `---` dividers, blank-line-separated paragraphs. It is not CommonMark and does not try to be — it
 * turns the shape a model actually emits for a business report into the block list the template
 * lays out. Anything it does not recognise becomes a paragraph, which is the safe default.
 */
export function blocksFromMarkdown(md: string): ReportBlock[] {
  const blocks: ReportBlock[] = [];
  const lines = String(md ?? "").replace(/\r\n?/g, "\n").split("\n");
  let para: string[] = [];
  let bullets: string[] = [];
  let fields: ReportField[] = [];
  const flushPara = () => {
    if (para.length) blocks.push({ kind: "paragraph", text: para.join(" ") });
    para = [];
  };
  const flushBullets = () => {
    if (bullets.length) blocks.push({ kind: "bullets", items: bullets });
    bullets = [];
  };
  const flushFields = () => {
    if (fields.length) blocks.push({ kind: "fields", rows: fields });
    fields = [];
  };
  const flushAll = () => {
    flushPara();
    flushBullets();
    flushFields();
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const t = line.trim();
    if (t === "") {
      flushAll();
      continue;
    }
    if (/^#{1,}\s+/.test(t)) {
      flushAll();
      const level = t.startsWith("## ") || /^#{2,}\s/.test(t) ? 2 : 1;
      blocks.push({ kind: "heading", text: t.replace(/^#{1,}\s+/, ""), level });
      continue;
    }
    if (/^([-*])\s+/.test(t)) {
      flushPara();
      flushFields();
      bullets.push(t.replace(/^([-*])\s+/, ""));
      continue;
    }
    if (/^-{3,}$/.test(t)) {
      flushAll();
      blocks.push({ kind: "divider" });
      continue;
    }
    // `Label: value` where the label is short — a stat row, not a sentence with a colon.
    const kv = t.match(/^([^:]{1,32}):\s+(.+)$/);
    if (kv && !/\.\s/.test(kv[1])) {
      flushPara();
      flushBullets();
      fields.push({ label: kv[1].trim(), value: kv[2].trim() });
      continue;
    }
    flushBullets();
    flushFields();
    para.push(t.replace(/^\*\*(.+)\*\*$/, "$1"));
  }
  flushAll();
  return blocks;
}

// ── The pager ────────────────────────────────────────────────────────────────────────────────

class Pager {
  private readonly builders: { b: SceneBuilder }[] = [];
  private b!: SceneBuilder;
  y = 0;
  constructor(
    private readonly input: ReportDocumentInput,
    private readonly kit: BrandKit,
  ) {
    this.startPage(true);
  }

  private startPage(first: boolean): void {
    this.b = new SceneBuilder(A4.width, A4.height);
    this.builders.push({ b: this.b });
    this.y = first ? this.letterhead() : this.continuationHead();
  }

  /** Break to a new page when `space` more points would run under the footer. */
  ensure(space: number): void {
    if (this.y + space > BOTTOM) this.startPage(false);
  }

  get scene(): SceneBuilder {
    return this.b;
  }

  // ── Chrome ──
  private letterhead(): number {
    const { kit, input, b } = { kit: this.kit, input: this.input, b: this.b };
    const ink = kit.neutral;
    const faint = tint(ink, 0.55);
    const head = kit.type.heading;
    const body = kit.type.body;
    let top = M;
    if (kit.letterhead === "band") {
      b.rect({ x: 0, y: 0, w: A4.width, h: 10, fill: kit.accent });
      top = M + 8;
    }
    const logo = kit.logo;
    if (logo) {
      const h = Math.min(40, (logo.height / logo.width) * 170);
      const w = (logo.width / logo.height) * h;
      b.image({ x: M, y: top, w: Math.min(w, 170), h, mime: logo.mime, data: logo.data });
    } else {
      b.text({ x: M, y: top + 20, text: kit.display_name, size: 16, family: head, weight: "bold", fill: ink, anchor: "start" });
    }
    // Document heading, right.
    b.text({ x: RIGHT, y: top + 18, text: "REPORT", size: 12, family: head, weight: "bold", fill: kit.accent, anchor: "end", tracking: 1.5 });
    let meta = top + 36;
    for (const row of this.input.meta ?? []) {
      if (!row.value) continue;
      b.text({ x: RIGHT - 96, y: meta, text: row.label, size: 8, family: body, weight: "normal", fill: faint, anchor: "end" });
      b.text({ x: RIGHT, y: meta, text: row.value, size: 8, family: body, weight: "bold", fill: ink, anchor: "end" });
      meta += 13;
    }
    // Title block, left. Wrapped so a long title flows onto a second line instead of running into
    // the right-aligned meta column — the collision the first close-pack showed.
    let y = top + 66;
    const titleWidth = (this.input.meta?.length ? RIGHT - 108 : RIGHT) - M;
    for (const line of wrapText(input.title, head, "bold", 22, titleWidth)) {
      b.text({ x: M, y, text: line, size: 22, family: head, weight: "bold", fill: ink, anchor: "start" });
      y += 26;
    }
    if (input.subtitle) {
      b.text({ x: M, y: y - 2, text: input.subtitle, size: 11, family: body, weight: "normal", fill: faint, anchor: "start" });
      y += 16;
    }
    y = Math.max(y, meta) + 10;
    b.line({ x1: M, y1: y, x2: RIGHT, y2: y, stroke: kit.accent, width: kit.letterhead === "band" ? 1 : 1.5 });
    return y + 22;
  }

  private continuationHead(): number {
    const { kit, input, b } = { kit: this.kit, input: this.input, b: this.b };
    const faint = tint(kit.neutral, 0.55);
    if (kit.letterhead === "band") b.rect({ x: 0, y: 0, w: A4.width, h: 6, fill: kit.accent });
    const y = M;
    b.text({ x: M, y, text: kit.display_name, size: 8, family: kit.type.body, weight: "bold", fill: faint, anchor: "start", tracking: 0.5 });
    b.text({ x: RIGHT, y, text: input.title, size: 8, family: kit.type.body, weight: "normal", fill: faint, anchor: "end" });
    b.line({ x1: M, y1: y + 8, x2: RIGHT, y2: y + 8, stroke: tint(kit.neutral, 0.86), width: 0.75 });
    return CONT_TOP + 20;
  }

  /** Draw the footer on every page once the total is known, then finalise the scenes. */
  finish(): Scene[] {
    const total = this.builders.length;
    const faint = tint(this.kit.neutral, 0.55);
    const hair = tint(this.kit.neutral, 0.86);
    this.builders.forEach(({ b }, i) => {
      const fy = A4.height - 40;
      b.line({ x1: M, y1: fy, x2: RIGHT, y2: fy, stroke: hair, width: 0.75 });
      if (this.input.footer) {
        b.text({ x: M, y: fy + 14, text: this.input.footer, size: 7.5, family: this.kit.type.body, weight: "normal", fill: faint, anchor: "start" });
      }
      b.text({ x: RIGHT, y: fy + 14, text: `Page ${i + 1} of ${total}`, size: 7.5, family: this.kit.type.body, weight: "normal", fill: faint, anchor: "end" });
    });
    return this.builders.map(({ b }) => b.done(this.input.title));
  }
}

// ── Block layout ─────────────────────────────────────────────────────────────────────────────

export function reportScenes(input: ReportDocumentInput, kit: BrandKit): Scene[] {
  const p = new Pager(input, kit);
  const ink = kit.neutral;
  const faint = tint(ink, 0.55);
  const hair = tint(ink, 0.86);
  const head = kit.type.heading;
  const body = kit.type.body;

  for (const block of input.blocks) {
    if (block.kind === "divider") {
      p.ensure(14);
      p.scene.line({ x1: M, y1: p.y, x2: RIGHT, y2: p.y, stroke: hair, width: 0.75 });
      p.y += 16;
      continue;
    }
    if (block.kind === "heading") {
      const level = block.level ?? 1;
      const size = level === 1 ? 15 : 12;
      p.y += level === 1 ? 12 : 8;
      p.ensure(size + 10);
      p.scene.text({ x: M, y: p.y + size, text: block.text, size, family: head, weight: "bold", fill: level === 1 ? ink : tint(ink, 0.15), anchor: "start" });
      p.y += size + (level === 1 ? 10 : 7);
      continue;
    }
    if (block.kind === "paragraph") {
      const lines = wrapText(block.text, body, "normal", 10, CONTENT_W);
      for (const line of lines) {
        p.ensure(15);
        p.scene.text({ x: M, y: p.y + 10, text: line, size: 10, family: body, weight: "normal", fill: ink, anchor: "start" });
        p.y += 15;
      }
      p.y += 6;
      continue;
    }
    if (block.kind === "bullets") {
      for (const item of block.items) {
        const lines = wrapText(item, body, "normal", 10, CONTENT_W - 16);
        lines.forEach((line, i) => {
          p.ensure(15);
          if (i === 0) p.scene.text({ x: M + 3, y: p.y + 10, text: "•", size: 10, family: body, weight: "bold", fill: kit.accent, anchor: "start" });
          p.scene.text({ x: M + 16, y: p.y + 10, text: line, size: 10, family: body, weight: "normal", fill: ink, anchor: "start" });
          p.y += 15;
        });
        p.y += 3;
      }
      p.y += 5;
      continue;
    }
    if (block.kind === "fields") {
      for (const row of block.rows) {
        p.ensure(17);
        p.scene.text({ x: M, y: p.y + 11, text: row.label, size: 9.5, family: body, weight: "normal", fill: faint, anchor: "start" });
        p.scene.text({ x: RIGHT, y: p.y + 11, text: row.value, size: 10, family: body, weight: "bold", fill: ink, anchor: "end" });
        p.scene.line({ x1: M, y1: p.y + 17, x2: RIGHT, y2: p.y + 17, stroke: hair, width: 0.5 });
        p.y += 20;
      }
      p.y += 6;
      continue;
    }
    if (block.kind === "table") {
      layoutTable(p, block.columns, block.rows, kit);
      continue;
    }
  }

  return p.finish();
}

/** Equal-width columns; cells wrap; the header row repeats on every page the table spills onto. */
function layoutTable(p: Pager, columns: string[], rows: string[][], kit: BrandKit): void {
  const cols = Math.max(1, columns.length);
  const colW = CONTENT_W / cols;
  const body = kit.type.body;
  const ink = kit.neutral;
  const pad = 5;
  const drawHeader = () => {
    p.ensure(22);
    p.scene.rect({ x: M, y: p.y, w: CONTENT_W, h: 20, fill: tint(kit.accent, 0.86) });
    columns.forEach((c, i) => {
      const text = wrapText(c, body, "bold", 9, colW - pad * 2)[0] ?? c;
      p.scene.text({ x: M + i * colW + pad, y: p.y + 13, text, size: 9, family: body, weight: "bold", fill: ink, anchor: "start" });
    });
    p.y += 20;
  };
  drawHeader();
  for (const row of rows) {
    const cellLines = row.map((cell, i) => wrapText(String(cell ?? ""), body, "normal", 9, colW - pad * 2));
    const rowH = Math.max(18, ...cellLines.map((l) => l.length * 12 + 6));
    if (p.y + rowH > BOTTOM) {
      p.ensure(rowH + 22); // forces a new page, then reprint the header
      drawHeader();
    }
    cellLines.forEach((lines, i) => {
      lines.forEach((line, li) => {
        p.scene.text({ x: M + i * colW + pad, y: p.y + 12 + li * 12, text: line, size: 9, family: body, weight: "normal", fill: ink, anchor: "start" });
      });
    });
    p.scene.line({ x1: M, y1: p.y + rowH, x2: RIGHT, y2: p.y + rowH, stroke: tint(ink, 0.86), width: 0.5 });
    p.y += rowH;
  }
  p.y += 8;
}
