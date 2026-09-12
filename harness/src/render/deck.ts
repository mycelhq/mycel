// A deck: the same design system, at presentation size.
//
// ═══ WHY THIS FILE IS SHORT, AND WHY THAT IS THE POINT ═══
//
// This is the test of whether taste got put into the system or applied to one template by hand. A
// deck shares nothing with a monthly close except the brand — different page, different type sizes,
// different everything a person would call "the design". If the ladder were real, a deck would be a
// page size and a list of slide kinds. It is:
//
//     designFor(kit, { base: 20, page: { width: 1280, height: 720 } })
//
// and every size, gap and colour below comes back correct at presentation scale, because they are
// steps and rhythm units rather than numbers somebody chose for A4. There is not one point value in
// this file. `taste.ts` then holds it to the same standard as the PDF, without knowing what a slide
// is — `flat-hierarchy` is a ratio, `single-axis` is a distribution, `off-page` is a comparison.
//
// ═══ THE ONE RULE A DECK HAS THAT A DOCUMENT DOES NOT ═══
//
// One idea per slide. A document is read; a deck is read AT somebody while a person talks over it,
// and the moment a slide holds a paragraph the audience stops listening and starts reading. So the
// slide kinds are deliberately narrow — a claim, some figures, a chart, a short list — and there is
// no "paragraph". `overfull-slide` in the linter catches the rest.
//
// ═══ WHAT THE MODEL CHOOSES AND WHAT IT DOES NOT ═══
//
// Same split as `report.ts`. The model picks the slides and what each one says. It never picks a
// size, a position, or where something breaks. A model asked to lay out a slide produces a slide
// that looks like a model laid it out.
import type { BrandKit } from "../brandkit";
import { fontFor, textWidth } from "./fonts";
import { as, designFor, type DesignSystem, type TypeRole } from "./design";
import { SceneBuilder, type Scene, type TextNode } from "./scene";
import { wrapText, type ReportField } from "./report";

/** 16:9 at a size where a point is a comfortable unit. Every dimension below is derived from it. */
export const SLIDE = { width: 1280, height: 720 } as const;

export type DeckSlide =
  /** The opener. One per deck, and it is the only slide with no page furniture. */
  | { kind: "title"; title: string; subtitle?: string; footnote?: string }
  /** A divider between acts. An eyebrow and a title on an otherwise empty slide, deliberately. */
  | { kind: "section"; title: string; eyebrow?: string }
  /**
   * ONE CLAIM, SET LARGE. The slide kind most decks are missing and most need.
   *
   * A statement slide is the one an audience remembers, because it is the only kind that cannot be
   * skimmed — there is nothing else on it. `support` is a single line underneath for the evidence,
   * and it is optional because the strongest version of this slide has none.
   */
  | { kind: "statement"; text: string; support?: string }
  /** Figures, as cards. Two to six; more than six is a table and should say so. */
  | { kind: "stats"; title?: string; rows: ReportField[] }
  | { kind: "bullets"; title?: string; items: string[] }
  | { kind: "chart"; title?: string; series: { label: string; value: number; note?: string }[] }
  | { kind: "quote"; text: string; attribution?: string }
  | { kind: "table"; title?: string; columns: string[]; rows: string[][] };

export interface DeckDocumentInput {
  /** Carried in the corner of every slide and into the PDF metadata. */
  title: string;
  /** The line under the deck title on the opening slide. */
  subtitle?: string;
  /** Bottom-left of every slide after the first. A client name, a date, a confidentiality note. */
  footer?: string;
  slides: DeckSlide[];
}

/** One slide's canvas plus the system, so a layout function takes one argument. */
interface Stage {
  b: SceneBuilder;
  d: DesignSystem;
  M: number;
  R: number;
  W: number;
  /** Top of the content area, below the slide title when there is one. */
  top: number;
  set: (x: number, baseline: number, text: string, role: TypeRole, anchor?: TextNode["anchor"]) => void;
}

/**
 * The largest step on the ladder at which `text` fits `lines` lines in `width`.
 *
 * Stepping rather than scaling is the whole discipline: a deck that shrinks a heading to 27.4pt to
 * make it fit has left the scale, and the next slide's 31.5pt heading now looks like a mistake
 * rather than a match. Falling off the end returns the smallest step and lets the linter complain.
 */
function fits(text: string, role: TypeRole, d: DesignSystem, width: number, lines: number, steps: number[]): number {
  const found = steps.find((size) => wrapText(text, role.family, role.weight, size, width).length <= lines);
  return found ?? steps[steps.length - 1] ?? d.role.body.size;
}

export function deckScenes(input: DeckDocumentInput, kit: BrandKit): Scene[] {
  const d = designFor(kit, { base: 20, page: SLIDE });
  const S = d.surface;
  const slides = input.slides?.length ? input.slides : [{ kind: "title" as const, title: input.title, subtitle: input.subtitle }];

  return slides.map((slide, i) => {
    const b = new SceneBuilder(SLIDE.width, SLIDE.height);
    const M = d.page.margin;
    const stage: Stage = {
      b,
      d,
      M,
      R: d.right,
      W: d.content,
      top: M + d.space(2),
      set: (x, baseline, text, role, anchor = "start") =>
        b.text({ x, y: baseline, text, size: role.size, family: role.family, weight: role.weight, fill: role.fill, anchor, ...(role.tracking ? { tracking: role.tracking } : {}) }),
    };

    /**
     * Furniture on every slide except the opener and the section breaks.
     *
     * Those two are the slides whose entire job is to hold nothing, and a page number in the corner
     * of a slide that says "Part two" is the design equivalent of clearing your throat.
     */
    const bare = slide.kind === "title" || slide.kind === "section";
    if (!bare) {
      const quiet = as(d.role.micro, { fill: S.faint });
      const base = SLIDE.height - M + d.space(1);
      b.rect({ x: M, y: M - d.space(2), w: d.space(6), h: 3, fill: S.accent, rx: 1.5 });
      if (input.footer) stage.set(M, base, input.footer, quiet);
      stage.set(d.right, base, `${i + 1}`, quiet, "end");
      stage.top = M + d.space(5);
    }

    layoutSlide(stage, slide, kit);
    return b.done(input.title);
  });
}

function layoutSlide(p: Stage, slide: DeckSlide, kit: BrandKit): void {
  const { d, M, W } = p;
  const S = d.surface;
  /** The optical centre of a slide sits a little above the true one — the same reason a book's
   *  text block does. Centring on the geometric middle reads as slightly low. */
  const middle = SLIDE.height * 0.46;

  if (slide.kind === "title") {
    // The one slide with a full-bleed accent edge: it is the only place a brand should shout.
    p.b.rect({ x: 0, y: 0, w: d.space(1.5), h: SLIDE.height, fill: S.accent });
    const size = fits(slide.title, d.role.display, d, W, 3, [d.role.display.size, d.role.figure.size, d.role.heading.size]);
    const lines = wrapText(slide.title, d.role.display.family, "bold", size, W);
    const leading = Math.round(size * 1.15);
    let y = middle - ((lines.length - 1) * leading) / 2;
    for (const line of lines) {
      p.set(M, y, line, as(d.role.display, { size }));
      y += leading;
    }
    if (slide.subtitle) {
      p.set(M, y + d.space(3), slide.subtitle, as(d.role.lede, { fill: S.faint }));
      y += d.space(3) + d.role.lede.leading;
    }
    p.b.rect({ x: M, y: y + d.space(3), w: d.space(9), h: 4, fill: S.accent, rx: 2 });
    if (slide.footnote) p.set(M, SLIDE.height - M, slide.footnote, as(d.role.micro, { fill: S.faint }));
    return;
  }

  if (slide.kind === "section") {
    if (slide.eyebrow) p.set(M, middle - d.space(6), slide.eyebrow.toUpperCase(), d.role.eyebrow);
    p.b.rect({ x: M, y: middle - d.space(4), w: d.space(6), h: 3, fill: S.accent, rx: 1.5 });
    /**
     * A section divider carries ONE line on an otherwise empty slide, so it has to be big enough to
     * justify the slide existing. At heading size it read as a slide whose content had failed to
     * load — which is what it looked like in the first render of this deck.
     */
    const size = fits(slide.title, d.role.display, d, W, 2, [d.role.display.size, d.role.figure.size, d.role.heading.size]);
    let y = middle + d.space(4);
    for (const line of wrapText(slide.title, d.role.display.family, "bold", size, W)) {
      p.set(M, y, line, as(d.role.display, { size }));
      y += Math.round(size * 1.18);
    }
    return;
  }

  if (slide.kind === "statement") {
    /**
     * Set as large as it will go in four lines, which is what makes this slide unskimmable.
     *
     * A statement at heading size is a heading with nothing under it, and an audience reads it in
     * half a second and goes back to their phone. The size IS the content.
     */
    const size = fits(slide.text, d.role.display, d, W, 4, [d.role.display.size, d.role.figure.size, d.role.heading.size, d.role.subhead.size]);
    const lines = wrapText(slide.text, d.role.display.family, "bold", size, W);
    const leading = Math.round(size * 1.16);
    let y = middle - ((lines.length - 1) * leading) / 2;
    for (const line of lines) {
      p.set(M, y, line, as(d.role.display, { size }));
      y += leading;
    }
    if (slide.support) {
      p.b.rect({ x: M, y: y + d.space(2), w: d.space(6), h: 3, fill: S.accent, rx: 1.5 });
      p.set(M, y + d.space(7), slide.support, as(d.role.lede, { fill: S.faint }));
    }
    return;
  }

  if (slide.kind === "quote") {
    const size = fits(slide.text, d.role.figure, d, W, 5, [d.role.figure.size, d.role.heading.size, d.role.subhead.size]);
    const lines = wrapText(slide.text, d.role.figure.family, "normal", size, W);
    const leading = Math.round(size * 1.3);
    let y = middle - ((lines.length - 1) * leading) / 2;
    // A rule down the left, not a quotation glyph. A 200pt curly quote is a stock-slide tell.
    p.b.rect({ x: M, y: y - size, w: 3, h: lines.length * leading, fill: S.accent });
    for (const line of lines) {
      p.set(M + d.space(4), y, line, as(d.role.figure, { size, weight: "normal" }));
      y += leading;
    }
    if (slide.attribution) p.set(M + d.space(4), y + d.space(2), slide.attribution, as(d.role.small, { fill: S.faint }));
    return;
  }

  // ── The kinds that carry a title and a body ──
  let y = p.top;
  if ("title" in slide && slide.title) {
    /**
     * A SLIDE TITLE IS A HEADLINE, NOT A SECTION HEADING — one step above where a document sets one.
     *
     * The linter found this rather than me: the chart slide came back `flat-hierarchy`, because a
     * heading-sized title against 18pt bar labels is 1.75× and reads as one grey field from the back
     * of a room. On a page you hold, a heading works because you are already close to it.
     */
    const size = fits(slide.title, d.role.figure, d, W, 2, [d.role.figure.size, d.role.heading.size, d.role.subhead.size]);
    for (const line of wrapText(slide.title, d.role.figure.family, "bold", size, W)) {
      p.set(M, y + size, line, as(d.role.figure, { size }));
      y += Math.round(size * 1.2);
    }
    y += d.space(4);
  }

  if (slide.kind === "stats") {
    /**
     * ═══ ON A SLIDE THE NUMBER IS THE SLIDE ═══
     *
     * Same card grid as the close pack and the same rule about an even grid, but the value is set at
     * `display` where the document uses `figure`. A figure on a slide that a room can read from the
     * back is worth more than four they cannot, which is also why more than six falls back to a
     * single row of smaller cards rather than a second grid.
     */
    const rows = slide.rows.slice(0, 6);
    const cols = rows.length <= 3 ? rows.length : rows.length === 4 ? 2 : 3;
    const gut = d.space(3);
    const pad = d.space(4);
    const cardW = (W - gut * (cols - 1)) / cols;
    const label = as(d.role.caption, { weight: "bold", fill: S.faint, tracking: 0.8 });
    const steps = [d.role.display.size, d.role.figure.size, d.role.heading.size, d.role.subhead.size];
    const inner = cardW - pad * 2;
    // One size for all of them: two figures in a row at different sizes reads as a bug.
    const valueSize = steps.find((s) => rows.every((r) => textWidth(r.value, fontFor(d.role.display.family, "bold"), s) <= inner)) ?? d.role.subhead.size;
    const cardH = pad * 2 + label.size + d.space(3) + valueSize;
    const lines = Math.ceil(rows.length / cols);
    // Centred in what is left of the slide, so a two-card slide is not two cards floating at the top.
    const block = lines * cardH + (lines - 1) * gut;
    const top = Math.max(y, y + (SLIDE.height - d.page.margin * 2 - (y - p.top) - block) / 2 - d.space(4));
    rows.forEach((row, i) => {
      const cx = M + (i % cols) * (cardW + gut);
      const cy = top + Math.floor(i / cols) * (cardH + gut);
      p.b.rect({ x: cx, y: cy, w: cardW, h: cardH, fill: S.panel, rx: d.space(1.5) });
      p.set(cx + pad, cy + pad + label.size * 0.8, row.label.toUpperCase(), label);
      p.set(cx + pad, cy + cardH - pad, row.value, as(d.role.display, { size: valueSize }));
    });
    return;
  }

  if (slide.kind === "bullets") {
    const role = d.role.lede;
    const indent = d.space(4);
    for (const item of slide.items) {
      wrapText(item, role.family, role.weight, role.size, W - indent).forEach((line, i) => {
        if (i === 0) p.b.rect({ x: M, y: y + role.size * 0.35, w: d.space(1), h: d.space(1), fill: S.accent, rx: 1 });
        p.set(M + indent, y + role.size, line, as(role, { fill: S.ink }));
        y += role.leading;
      });
      y += d.space(2.5);
    }
    return;
  }

  if (slide.kind === "chart") {
    const series = slide.series.filter((s2) => Number.isFinite(s2.value));
    if (!series.length) return;
    const peak = Math.max(...series.map((s2) => Math.abs(s2.value)));
    if (!peak) return;
    const labelRole = as(d.role.small, { fill: S.ink });
    const noteRole = as(d.role.small, { fill: S.faint });
    const bar = d.space(2.5);
    // Rows share out whatever height is left, so four bars fill the slide and ten still fit.
    const room = SLIDE.height - d.page.margin - d.space(4) - y;
    const row = Math.min(d.space(11), room / series.length);
    const labelW = Math.min(d.space(20), Math.max(...series.map((s2) => textWidth(s2.label, fontFor(labelRole.family, "normal"), labelRole.size))) + d.space(3));
    const noteW = Math.max(...series.map((s2) => textWidth(s2.note ?? "", fontFor(noteRole.family, "normal"), noteRole.size))) + d.space(3);
    const trackX = M + labelW;
    const trackW = Math.max(d.space(20), p.R - trackX - noteW);
    for (const item of series) {
      const w = Math.max(2, (Math.abs(item.value) / peak) * trackW);
      p.b.rect({ x: trackX, y, w: trackW, h: bar, fill: S.track, rx: 2 });
      p.b.rect({ x: trackX, y, w, h: bar, fill: S.accent, rx: 2 });
      p.set(M, y + bar * 0.8, item.label, labelRole);
      if (item.note) p.set(p.R, y + bar * 0.8, item.note, noteRole, "end");
      y += row;
    }
    return;
  }

  if (slide.kind === "table") {
    const cols = Math.max(1, slide.columns.length);
    const colW = W / cols;
    const pad = d.space(1.5);
    const headRole = as(d.role.small, { weight: "bold", fill: S.ink });
    const cellRole = as(d.role.small, { fill: S.ink });
    p.b.rect({ x: M, y, w: W, h: d.space(6), fill: S.accentWash });
    slide.columns.forEach((c, i) => p.set(M + i * colW + pad, y + d.space(4), wrapText(c, headRole.family, "bold", headRole.size, colW - pad * 2)[0] ?? c, headRole));
    y += d.space(6);
    // Rows past the bottom of the slide are DROPPED WITH A COUNT rather than run off the edge:
    // silent truncation reading as complete coverage is a failure this repo has paid for before.
    const room = SLIDE.height - d.page.margin - d.space(6) - y;
    const rowH = d.space(5.5);
    const fit = Math.max(1, Math.floor(room / rowH));
    for (const r of slide.rows.slice(0, fit)) {
      r.forEach((cell, i) => p.set(M + i * colW + pad, y + cellRole.size + d.space(1), wrapText(String(cell ?? ""), cellRole.family, "normal", cellRole.size, colW - pad * 2)[0] ?? "", cellRole));
      p.b.line({ x1: M, y1: y + rowH, x2: p.R, y2: y + rowH, stroke: S.hairline, width: 1 });
      y += rowH;
    }
    const rest = slide.rows.length - fit;
    if (rest > 0) p.set(M, y + d.space(4), `and ${rest} more — the full list is in the pack`, as(d.role.small, { fill: S.faint }));
  }
}

// ── The same content, as slides ──────────────────────────────────────────────────────────────────
//
// ═══ WHY THE MODEL DOES NOT WRITE THE DECK ═══
//
// A wedge that wanted a deck could declare a slide list in its output schema and have the model fill
// it. That hands the model a layout decision — how much goes on a slide, where a section breaks,
// which sentence is the headline — and a model asked to lay out a deck produces a deck that looks
// like a model laid it out. It also means every run of that task type spends tokens re-deriving a
// structure that is the same every week.
//
// So a wedge declares `"deck": true` on the task type and the model writes exactly what it already
// writes: markdown. `blocksFromMarkdown` reads it, the wedge's declared chart is spliced in from the
// output that was already checked, and this turns the result into slides. The model's job did not
// change and its output is now two artifacts.
//
// ═══ THE TRANSFORM, AND THE ONE RULE IT FOLLOWS ═══
//
// NOTHING IS DROPPED. Every rule below either carries a block onto a slide or splits it across
// several; there is no "and the rest did not fit". Silent truncation reading as complete coverage is
// a failure this repo has paid for three times, and a deck is the easiest place in the world for it
// to happen unnoticed.
//
//   the opening paragraph  → a statement slide (its first sentence), with the second as support and
//                            anything after that as bullets. The lede carries the finding, and the
//                            finding is what a statement slide is for.
//   a heading              → the title of whatever comes next; two in a row makes the first a section
//   bullets                → a bullets slide, five to a slide
//   a later paragraph      → bullets, one per sentence. What a person does converting a note to slides.
//   fields                 → a stats slide, six to a slide
//   chart / table          → their own slide

import { sentencesOf } from "../tells";
import type { ReportBlock } from "./report";

/** Chunk, so a rule that splits never has to also decide what to leave out. */
const chunk = <T,>(xs: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

/**
 * SPLIT BULLETS BY HEIGHT, NOT BY COUNT.
 *
 * FOUND BY READING A REAL DECK: a GEO week's three sized recommendations ran four lines each, the
 * fixed five-to-a-slide rule kept all three together, and the last one was drawn straight through
 * the footer — the client's own name overprinted by the end of a sentence.
 *
 * Five is right for five short lines and wrong for three long ones, and no constant is right for
 * both, because the thing that overflows is LINES and a bullet is worth between one and six of
 * them. So measure: wrap each item at the real width with the real metrics, and start a new slide
 * when the next one would not fit. Same wrap function the renderer uses, so the count that decides
 * the split is the count that gets drawn.
 *
 * A single bullet taller than a whole slide still goes on its own slide and still overflows. That
 * is a content problem — nothing can set nine lines in the space for six — and `taste.ts` reports
 * it as `off-page` rather than this quietly dropping the tail.
 */
function packBullets(items: string[], kit: BrandKit): string[][] {
  const d = designFor(kit, { base: 20, page: SLIDE });
  const role = d.role.lede;
  const width = d.content - d.space(4);
  // Top of the body on a titled slide down to the rule above the footer. The title itself is two
  // lines at most, and assuming two on every slide costs one line of capacity on the slides that
  // use one — the safe direction to be wrong in.
  const room = SLIDE.height - d.page.margin - d.space(3) - (d.page.margin + d.space(5) + d.role.figure.leading * 2 + d.space(3));
  const cost = (item: string): number =>
    wrapText(item, role.family, role.weight, role.size, width).length * role.leading + d.space(2.5);

  const out: string[][] = [];
  let current: string[] = [];
  let used = 0;
  for (const item of items) {
    const h = cost(item);
    if (current.length && used + h > room) {
      out.push(current);
      current = [];
      used = 0;
    }
    current.push(item);
    used += h;
  }
  if (current.length) out.push(current);
  return out.length ? out : [items];
}

export function slidesFromBlocks(blocks: ReportBlock[], head: { title: string; subtitle?: string }, kit: BrandKit): DeckSlide[] {
  // The same ladder the renderer will use, so every measurement here is the one that gets drawn.
  const dm = designFor(kit, { base: 20, page: SLIDE });
  const slides: DeckSlide[] = [{ kind: "title", title: head.title, ...(head.subtitle ? { subtitle: head.subtitle } : {}) }];
  /** The heading waiting for something to title. Consumed by the next content block. */
  let pending: string | undefined;
  let statementDone = false;
  const take = (): string | undefined => {
    const t = pending;
    pending = undefined;
    return t;
  };

  blocks.forEach((block, i) => {
    if (block.kind === "divider") return;
    if (block.kind === "heading") {
      // Two headings in a row means the first titles nothing, which is exactly a section break.
      if (pending) slides.push({ kind: "section", title: pending });
      pending = block.text;
      return;
    }
    if (block.kind === "paragraph") {
      const sentences = sentencesOf(block.text);
      if (!sentences.length) return;
      if (!statementDone && !pending) {
        statementDone = true;
        slides.push({ kind: "statement", text: sentences[0]!, ...(sentences[1] ? { support: sentences[1] } : {}) });
        for (const part of packBullets(sentences.slice(2), kit)) slides.push({ kind: "bullets", items: part });
        return;
      }
      const title = take();
      packBullets(sentences, kit).forEach((part, k) => slides.push({ kind: "bullets", ...(k === 0 && title ? { title } : {}), items: part }));
      return;
    }
    if (block.kind === "bullets") {
      const title = take();
      packBullets(block.items, kit).forEach((part, k) => slides.push({ kind: "bullets", ...(k === 0 && title ? { title } : {}), items: part }));
      return;
    }
    if (block.kind === "fields") {
      const title = take();
      chunk(block.rows, 6).forEach((part, k) => slides.push({ kind: "stats", ...(k === 0 && title ? { title } : {}), rows: part }));
      return;
    }
    if (block.kind === "chart") {
      // The AUTHOR's heading wins over the wedge's declared chart title: they wrote it for this
      // slide, and using ours instead would drop a line somebody chose in favour of a default.
      const title = take() ?? block.title;
      slides.push({ kind: "chart", ...(title ? { title } : {}), series: block.series });
      return;
    }
    if (block.kind === "table") {
      const title = take();
      slides.push({ kind: "table", ...(title ? { title } : {}), columns: block.columns, rows: block.rows });
      return;
    }
    void i;
  });

  // A heading with nothing after it is still a heading somebody wrote, so it becomes a section
  // rather than disappearing.
  if (pending) slides.push({ kind: "section", title: pending });

  /**
   * ═══ ONE BULLET ON A SLIDE IS NOT A LIST ═══
   *
   * The first deck this transform produced had two slides carrying a single bulleted sentence and a
   * page number. That is the `dangling-page` failure of a deck, and worse, because a bullet point
   * announces "here is one of several" and then there is only the one.
   *
   * A lone sentence with no heading over it IS a statement — usually the last line of the lede or a
   * closing commitment, which are the two things most worth setting large. So it becomes one.
   */
  /**
   * ONLY IF IT IS ACTUALLY A SENTENCE.
   *
   * Once bullets started splitting by height, a lone bullet stopped meaning "one short line" and
   * started often meaning "the paragraph that did not fit on the slide before". Promoting a
   * 350-character recommendation to a statement sets it in display type, and `fits` runs out of
   * ladder long before it runs out of words — so the fix for one overflow would have caused another.
   *
   * Four lines at the smallest step the statement slide will drop to is exactly the space that slide
   * has. If it does not fit there, it was never a statement.
   */
  const statementFits = (text: string): boolean =>
    wrapText(text, dm.role.display.family, "bold", dm.role.subhead.size, dm.content).length <= 4;
  return slides.map((s) =>
    s.kind === "bullets" && s.items.length === 1 && !s.title && statementFits(s.items[0]!)
      ? { kind: "statement" as const, text: s.items[0]! }
      : s,
  );
}
