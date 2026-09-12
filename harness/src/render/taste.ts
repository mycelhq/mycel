// The design linter: what makes a page look generated, checked before it reaches a client.
//
// ═══ THE ARGUMENT ═══
//
// `tells.ts` exists because forbidding the word "leverage" does not stop a model writing an empty
// sentence — what gives machine writing away is SHAPE, and shape is checkable. A page is the same.
// A document does not look generated because a colour is wrong. It looks generated because:
//
//   every line is the same size · everything starts at the same x · there is no whitespace variance ·
//   nothing is grouped · one word sits alone under a heading · two things overlap
//
// Every one of those is arithmetic over a `Scene`, which is a flat list of positioned primitives.
// So this is a linter, and it runs on the output of EVERY template — the invoice, the receipt, the
// report, and whichever one exists next month — without that template opting in.
//
// ═══ WHY A LINTER AND NOT JUST A BETTER TEMPLATE ═══
//
// Because the better template is one afternoon and the linter is forever. `design.ts` supplies good
// defaults; a template can still ignore all of them, and the first one that does will be a template
// somebody wrote in a hurry for a service business the onboarding invented. The founder we are
// building for cannot be the quality gate — they are going to send this to their client and find out
// what it looks like at the same moment the client does.
//
// This is the `ship_checks` posture applied to layout: the arithmetic lives somewhere honest, and
// the gate refuses the run that ignored it.
//
// ═══ WHAT IS DELIBERATELY NOT IN HERE ═══
//
// Anything requiring an opinion about content — whether the accent suits the trade, whether a chart
// was the right chart, whether the title is any good. A linter that guesses at those produces
// findings nobody can act on, and gets switched off. Every rule below is mechanical, and every one
// of them fired on a real document this repo actually shipped.
import { fontFor, textWidth } from "./fonts";
import type { Scene, SceneNode, TextNode } from "./scene";

/** One thing wrong with a deliverable, and what to do about it. Shaped like `Tell`, on purpose. */
export interface TasteFinding {
  /** Stable id. Renaming one orphans any history keyed on it. */
  rule: string;
  /**
   * Where it is, in the words the person looking at the file would use: "Page 2", or
   * "the July tab, column Amount". Never an index into a data structure — this can reach a founder,
   * and the rule about not exposing the guts of the platform applies to our own error messages first.
   */
  where: string;
  /** Plain English, and it must say what to change — never only what is wrong. */
  detail: string;
}

/**
 * `blocking` findings are the ones that make the file WRONG rather than plain: text off the page,
 * text on text, a column of money Excel cannot sum, a header that is a database field name.
 *
 * Everything else is a nudge, because a gate that refuses a delivery over eight type sizes gets
 * switched off the first time it is wrong, and then it is not catching the off-page text either.
 */
const BLOCKING = new Set([
  "off-page",
  "collision",
  "unreadable-type",
  "dangling-page",
  "machine-headers",
  "numbers-as-text",
  "dates-as-text",
  "ragged-rows",
]);

export function isBlocking(f: TasteFinding): boolean {
  return BLOCKING.has(f.rule);
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** A text node's ink box. Ascent/descent approximated as .76/.22 of size — true enough for overlap. */
function boxOf(n: TextNode): Box {
  const w = textWidth(n.text, fontFor(n.family, n.weight), n.size) + (n.tracking ?? 0) * Math.max(0, n.text.length - 1);
  const x0 = n.anchor === "end" ? n.x - w : n.anchor === "middle" ? n.x - w / 2 : n.x;
  return { x0, y0: n.y - n.size * 0.76, x1: x0 + w, y1: n.y + n.size * 0.22 };
}

const isText = (n: SceneNode): n is TextNode => n.t === "text";

/** The most common value in a list, which is the page's real body size / real left edge. */
function modeOf(values: number[]): number {
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = values[0] ?? 0;
  let bestN = 0;
  for (const [v, n] of counts) if (n > bestN || (n === bestN && v < best)) [best, bestN] = [v, n];
  return best;
}

export interface TasteOptions {
  /** The page margin the template used. Only affects the off-page rule's tolerance. */
  margin?: number;
}

/**
 * Every finding, for every page. Pure: no clock, no config, no I/O — the same Scene always produces
 * the same list, which is what lets a test pin it.
 */
export function tasteFindings(scenes: Scene[], opts: TasteOptions = {}): TasteFinding[] {
  const out: TasteFinding[] = [];
  const pages = scenes.length;
  scenes.forEach((scene, i) => {
    const page = i + 1;
    const add = (rule: string, detail: string) => out.push({ rule, where: `Page ${page}`, detail });
    const texts = scene.nodes.filter(isText);
    const marks = scene.nodes.filter((n) => n.t === "rect" || n.t === "line" || n.t === "image");
    // A page with almost no text is a cover or a spacer, and the hierarchy rules do not apply to it.
    const dense = texts.length >= 12;

    /**
     * ── OFF THE PAGE ────────────────────────────────────────────────────────────────────────────
     * The one failure a client cannot fail to notice. A hard-wrapped URL, a table with one column
     * too many, a right-aligned value longer than the space reserved for it — all three have shipped
     * from this repo's ancestors, and all three are one comparison.
     */
    const tol = 1.5;
    for (const n of texts) {
      const b = boxOf(n);
      if (b.x0 < -tol || b.x1 > scene.width + tol || b.y0 < -tol || b.y1 > scene.height + tol) {
        add("off-page", `"${clip(n.text)}" runs off the edge of the page. Wrap it, shorten it, or give the column more room.`);
        break; // one per page: the cause is usually one block, and twelve findings is noise
      }
    }

    /**
     * ── TEXT ON TEXT ────────────────────────────────────────────────────────────────────────────
     * Two blocks laid out by different code paths that did not know about each other. This is what
     * a right-aligned meta column and a long title do to each other, and it is the single ugliest
     * thing a document can do.
     */
    const boxes = texts.map((n) => ({ n, b: boxOf(n) }));
    outer: for (let a = 0; a < boxes.length; a++) {
      for (let c = a + 1; c < boxes.length; c++) {
        const A = boxes[a]!;
        const B = boxes[c]!;
        // Overlap in BOTH axes, with a point of slack so touching baselines are not a finding.
        const dx = Math.min(A.b.x1, B.b.x1) - Math.max(A.b.x0, B.b.x0);
        const dy = Math.min(A.b.y1, B.b.y1) - Math.max(A.b.y0, B.b.y0);
        if (dx > 1 && dy > 1) {
          add("collision", `"${clip(A.n.text)}" and "${clip(B.n.text)}" overlap. Two blocks are being positioned without knowing about each other.`);
          break outer;
        }
      }
    }

    /** ── TOO SMALL TO READ ─────────────────────────────────────────────────────────────────── */
    const tiny = texts.find((n) => n.size < 6);
    if (tiny) add("unreadable-type", `"${clip(tiny.text)}" is set at ${tiny.size}pt. Under 6pt is decoration, not text — either make it readable or take it out.`);

    if (dense) {
      const sizes = texts.map((n) => n.size);
      const bodySize = modeOf(sizes);
      const largest = Math.max(...sizes);
      const distinct = new Set(sizes);

      /**
       * ── FLAT HIERARCHY: THE SLAB ────────────────────────────────────────────────────────────
       * THE RULE THIS FILE WAS WRITTEN FOR. A page where the biggest thing is barely bigger than
       * the body is a page a reader has to read in order to find out what it is. Every "it looks
       * like a wall of text" complaint is this number.
       *
       * 1.8× is the boundary where a title stops being a slightly bolder sentence: at 1.5× a
       * 15pt heading over 10pt body is findable only if you are already looking for it.
       */
      if (largest < bodySize * 1.8) {
        add(
          "flat-hierarchy",
          `Nothing on this page is more than ${(largest / bodySize).toFixed(1)}× the body text, so it reads as one slab. The title or the headline figure should be at least twice the body size.`,
        );
      }

      /**
       * ── ONE COLUMN, ONE EDGE ────────────────────────────────────────────────────────────────
       * Every element starting at the same x is the other half of the slab. A designed page has at
       * least a second axis — a right-aligned figure, an indent, a panel inset, a label column.
       */
      const starts = texts.map((n) => Math.round(boxOf(n).x0));
      const atLeft = starts.filter((x) => x === modeOf(starts)).length;
      if (atLeft / texts.length > 0.9) {
        add(
          "single-axis",
          `${Math.round((atLeft / texts.length) * 100)}% of the text on this page starts at the same left edge. Give figures a right-aligned column, or indent something.`,
        );
      }

      /**
       * ── NOTHING BUT WORDS ───────────────────────────────────────────────────────────────────
       * No rules, no panels, no bars, no logo. Grouping is what tells a reader which four things
       * belong together, and a page of pure text has told them nothing.
       */
      if (marks.length === 0) {
        add("no-structure", "This page is text only — no rules, panels or grouping. Figures that belong together should sit in a panel, and sections should be separated by something the eye can find.");
      }

      /**
       * ── SIZE SPRAWL ─────────────────────────────────────────────────────────────────────────
       * The opposite failure, and it looks equally unowned. Eight sizes on one page means several
       * of them are a point apart, which reads as a mistake rather than a distinction.
       */
      if (distinct.size > 7) {
        add("size-sprawl", `${distinct.size} different text sizes on one page. A page needs four or five; the extras read as accidents. Use the roles in design.ts rather than picking a number.`);
      }

      /**
       * ── TWO SIZES TOO CLOSE TO BE A DECISION ────────────────────────────────────────────────
       * THE RULE THAT ACTUALLY CATCHES IT, and the count above only approximates.
       *
       * 12pt and 12.5pt on one page. 9pt and 9.5pt. 20pt and 22pt. A reader cannot see the
       * difference, so it does not read as hierarchy — it reads as two people having laid out one
       * page, which is exactly what happened: each number was chosen on its own, months apart.
       *
       * 8% is the boundary and it is base-independent, so it holds on a slide as well as on A4.
       * The 1.25 ladder in `design.ts` puts every neighbouring step 25% apart, which means a
       * template that asks for a role can never trip this and one that picks a number can.
       */
      const ordered = [...distinct].sort((a, b) => a - b);
      for (let k = 1; k < ordered.length; k++) {
        if (ordered[k]! / ordered[k - 1]! < 1.08) {
          add("near-duplicate-size", `${ordered[k - 1]}pt and ${ordered[k]}pt are both on this page, and nobody can see the difference — so it reads as an accident rather than as hierarchy. Pick one, or move a full step up the scale.`);
          break;
        }
      }

      /**
       * ── PALETTE SPRAWL ──────────────────────────────────────────────────────────────────────
       * Counted over text only. Rect fills are tints of one ink by construction; it is the TEXT
       * colours that multiply, one grey at a time, until a page has five of them and no reason.
       */
      const fills = new Set(texts.map((n) => n.fill.toLowerCase()));
      if (fills.size > 5) {
        add("palette-sprawl", `${fills.size} different text colours on one page. Ink, a muted grey, a faint grey and the accent is the whole vocabulary.`);
      }

      /**
       * ── A WALL WITH NO LANDING ──────────────────────────────────────────────────────────────
       * Eighteen consecutive lines at body size with nothing between them. Even correct, useful
       * prose is not read in that shape — the eye needs somewhere to stop.
       */
      const order = scene.nodes;
      let run = 0;
      let worst = 0;
      for (const n of order) {
        if (isText(n) && n.size <= bodySize) run++;
        else if (isText(n)) run = 0;
        else run = 0; // a rule, panel or image is a landing
        worst = Math.max(worst, run);
      }
      if (worst >= 18) {
        add("wall-of-text", `${worst} lines of body text in a row with nothing to break them. Add a subheading, pull out the figures, or split the section.`);
      }
    }

    /**
     * ── A SLIDE WITH A DOCUMENT ON IT ──────────────────────────────────────────────────────────
     *
     * Landscape only, because that is what a deck is and the rule is about how a deck is READ: at
     * somebody, while a person talks over it. The moment a slide holds a paragraph the room stops
     * listening and starts reading, and the speaker is now competing with their own slide.
     *
     * Generous on purpose — a table slide legitimately carries a lot of short strings, and a rule
     * that fires on those gets switched off before it ever catches the wall of prose it is for.
     */
    if (scene.width > scene.height) {
      const words = texts.reduce((n, t) => n + (t.text.trim().match(/\S+/g)?.length ?? 0), 0);
      if (words > 120) {
        add("overfull-slide", `${words} words on one slide. A room reads it instead of listening to whoever is presenting it — cut it to the one idea, and put the rest in the notes or the pack.`);
      }
    }

    /**
     * ── A PAGE THAT IS ALMOST EMPTY ────────────────────────────────────────────────────────────
     * Not on a single-page document, where short is correct — and not on a cover. A LAST page
     * carrying two lines is a pagination bug wearing a page number, and it is what a client
     * remembers about the pack.
     */
    if (pages > 1 && page === pages) {
      const lowest = Math.max(0, ...texts.map((n) => boxOf(n).y1));
      // The footer sits near the bottom on every page, so measure against content ABOVE it.
      const contentBottom = Math.max(0, ...texts.filter((n) => n.y < scene.height - 60).map((n) => boxOf(n).y1));
      if (contentBottom > 0 && contentBottom < scene.height * 0.22 && lowest > 0) {
        add("dangling-page", "The last page holds only a couple of lines. Tighten the page before it so this fits, or let the section start here properly.");
      }
    }
  });
  return out;
}

/** First 48 characters, so a finding names the text without quoting a paragraph at somebody. */
function clip(s: string): string {
  const t = s.trim();
  return t.length > 48 ? `${t.slice(0, 47)}…` : t;
}

// ── The same linter, a different medium ──────────────────────────────────────────────────────────
//
// ═══ WHY THIS LIVES IN THE SAME FILE AS THE PAGE RULES ═══
//
// Taste is not a property of PDFs. A workbook has exactly the same failure — it can arrive looking
// like something a person made, or like a database table somebody exported and emailed. And the
// difference is just as mechanical: `closing_balance_minor` as a column heading, `1349461` where
// £13,494.61 belongs, a date Excel will not sort because it is a string.
//
// One finding shape, one blocking set, one place to look. A third medium — a deck, a code repo —
// adds a function here and inherits the vocabulary rather than inventing its own.
//
// ═══ THE ONE THAT MATTERS MOST ═══
//
// `machine-headers`. Our own outputs are snake_case objects, so the shortest path from a result to a
// spreadsheet is `Object.keys(row)` as the header row — and that hands a founder's CLIENT the field
// names of our internal schema. The rule is that a founder never sees the guts of the platform; it
// applies twice as hard to a file their client opens.

import type { Cell, Workbook } from "./xlsx";

/** Looks like a number somebody has already formatted into a string. */
const FORMATTED_NUMBER = /^-?[£$€¥]?\s?\d{1,3}(,\d{3})+(\.\d+)?%?$|^-?[£$€¥]\s?\d+(\.\d+)?$|^-?\d+\.\d+\s?%?$|^-?\d+\s?%$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]|$)/;
const SNAKE = /^[a-z0-9]+(_[a-z0-9]+)+$/;
const CAMEL = /^[a-z]+([A-Z][a-z0-9]*)+$/;
/** Columns whose contents are money by their name alone. */
const MONETARY = /\b(amount|total|price|cost|balance|revenue|fee|value|paid|due|net|gross|vat|tax|subtotal|charge|spend|budget)\b/i;

/**
 * The column headings that are OUR field names rather than the client's words.
 *
 * Exported because a spreadsheet is not the only file that carries a header row: `runtime.ts` runs
 * this over every CSV a wedge ships, so the rule holds wherever the row appears rather than only
 * where I happened to write the check.
 *
 * `amount_minor` and `companyDomain` are the shape it exists for. Both come from the shortest path
 * between a result object and a file — `Object.keys(row)` — and both tell a client something true
 * about our internals and nothing about their business.
 */
export function machineHeaders(headers: readonly string[]): string[] {
  return headers.filter((h) => {
    const t = String(h ?? "").trim();
    return SNAKE.test(t) || CAMEL.test(t) || /_(minor|cents|id|at|ts)$/i.test(t) || t.toLowerCase() === "id";
  });
}

/**
 * Every finding for a workbook. Pure, same as the page linter — the same workbook always produces
 * the same list.
 */
export function sheetFindings(wb: Workbook): TasteFinding[] {
  const out: TasteFinding[] = [];
  for (const sheet of wb.sheets ?? []) {
    const at = (col?: string) => (col ? `the ${sheet.name} tab, column ${col}` : `the ${sheet.name} tab`);
    const add = (rule: string, where: string, detail: string) => out.push({ rule, where, detail });
    const header = sheet.header ?? [];

    /**
     * ── OUR FIELD NAMES IN SOMEBODY ELSE'S SPREADSHEET ──────────────────────────────────────────
     * `closing_balance_minor`, `companyDomain`, `invoice_id`. Every one of these is the shortest
     * path from a result object to a header row, and every one tells a client something true about
     * our internals and nothing about their business.
     */
    const machine = machineHeaders(header);
    if (machine.length) {
      add("machine-headers", at(machine[0]), `${machine.map((h) => `"${h}"`).join(", ")} ${machine.length === 1 ? "is a field name" : "are field names"}, not a column heading. Write what the column means: "Closing balance", not "closing_balance_minor".`);
    } else if (header.length > 1 && header.every((h) => h === h.toLowerCase() && /[a-z]/.test(h))) {
      // Not blocking — legible, just clearly untouched by anybody after the export.
      add("raw-headers", at(), "Every column heading is lower case, which is what an export looks like. Capitalise them the way a person writing the sheet would.");
    }
    const dupes = header.filter((h, i) => header.indexOf(h) !== i);
    if (dupes.length) add("duplicate-headers", at(dupes[0]), `"${dupes[0]}" appears twice. Two columns with one name cannot be told apart in a filter or a pivot.`);
    const blank = header.findIndex((h) => !String(h ?? "").trim());
    if (blank >= 0) add("blank-header", at(colLetter(blank)), "A column has no heading. A reader has to infer what is in it from the values, and they will infer wrong.");

    if (!sheet.rows?.length) {
      add("empty-sheet", at(), "This tab has headings and no rows. Either fill it or take it out — an empty tab reads as something that failed rather than as something with nothing to report.");
      continue;
    }

    const ragged = sheet.rows.find((r) => r.length !== header.length);
    if (ragged) {
      add("ragged-rows", at(), `A row has ${ragged.length} cells against ${header.length} headings, so the values are under the wrong columns from there on.`);
    }

    header.forEach((name, c) => {
      const col = sheet.rows.map((r) => r[c]).filter((x): x is Cell => !!x);
      if (!col.length) return;
      const where = at(name || colLetter(c));

      /**
       * ── A COLUMN EXCEL CANNOT SUM ──────────────────────────────────────────────────────────
       * The single most common way a workbook fails the person who opened it. They select the
       * column, look at the status bar, and there is no total — because every cell is a string
       * that happens to look like money. The deliverable was a picture of a spreadsheet.
       */
      const textNumbers = col.filter((x) => x.kind === "s" && FORMATTED_NUMBER.test(x.v.trim()));
      if (textNumbers.length >= Math.max(2, col.length * 0.5)) {
        add("numbers-as-text", where, `The values here are text that looks like numbers ("${(textNumbers[0] as { v: string }).v}"), so this column cannot be summed, sorted or charted. Put the number in the cell and let the format do the currency.`);
      }
      const textDates = col.filter((x) => x.kind === "s" && ISO_DATE.test(x.v.trim()));
      if (textDates.length >= Math.max(2, col.length * 0.5)) {
        add("dates-as-text", where, "The dates here are text, so they sort alphabetically rather than chronologically. Store them as dates.");
      }

      /**
       * ── MONEY WITHOUT A MONEY FORMAT ───────────────────────────────────────────────────────
       * Not blocking: the column sums correctly, so it works. It just shows 1234.5 where a client
       * expects 1,234.50, and rounds two figures differently on the same row.
       */
      if (MONETARY.test(name) && col.every((x) => x.kind === "n") && !col.some((x) => x.kind === "n" && x.format === "money")) {
        add("unformatted-money", where, `"${name}" reads as money but is formatted as a plain number, so it will show 1234.5 rather than 1,234.50. Set the money format on the column.`);
      }
    });

    if (header.length > 20) {
      add("too-many-columns", at(), `${header.length} columns. Past about twenty a sheet is a dump rather than an answer — split it, or take out the ones nobody asked for.`);
    }
  }
  return out;
}

/** A, B, C… for naming a column that has no heading to name it by. */
function colLetter(i: number): string {
  let n = i + 1;
  let out = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - r) / 26);
  }
  return out;
}
