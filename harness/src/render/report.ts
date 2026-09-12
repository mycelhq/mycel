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
import { fontFor, textWidth, truncateToWidth } from "./fonts";
import { SceneBuilder, type Scene, type TextNode } from "./scene";
import { as, designFor, type DesignSystem, type TypeRole } from "./design";
import { tasteFindings } from "./taste";
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
  /**
   * ═══ A CHART, BECAUSE PAGE ONE IS WHERE THEY LOOK ═══
   *
   * A monthly close arrived as a wall of correct figures, and every client who read one asked the
   * same question in different words: where is my money going. That answer is in the numbers and it
   * takes them four minutes to assemble, which means most of them never do.
   *
   * Bars only, horizontal, drawn from rects and text. No axes, no gridlines, no legend, no pie. A
   * pie needs arcs the Scene has no primitive for, and a legend is a lookup table between colours
   * and words — which is the reader doing work a label on the bar would have saved them.
   *
   * `value` drives the bar; `label` and `note` are what a person reads. The template never formats a
   * number: whatever produced the figures formatted them, in one place, and a chart that formatted
   * its own would be the hundredfold-error bug with a new surface to appear on.
   */
  | { kind: "chart"; title?: string; series: { label: string; value: number; note?: string }[] }
  | { kind: "divider" };

export interface ReportDocumentInput {
  /** The report's own title, in the letterhead. */
  title: string;
  /** One line under the title — the period, the client, the engagement. Optional. */
  subtitle?: string;
  /**
   * The kind of document, as the eyebrow at the top right: "Report", "Close pack", "Proposal".
   * Defaults to "Report" — but a close pack that calls itself a report has told the client one true
   * and useless thing about itself.
   */
  label?: string;
  /** Header meta rows, right-aligned under the document heading (Prepared, Period, For). */
  meta?: ReportField[];
  /** The report itself. */
  blocks: ReportBlock[];
  /** A footer note carried on every page (confidentiality, a reference). Optional. */
  footer?: string;
}

// ── Geometry ─────────────────────────────────────────────────────────────────────────────────
//
// There are no page constants here any more. Margin, content width and the vertical rhythm come from
// `designFor(kit)`, which derives them from the page size — so this same template laid out on a
// slide or a US-Letter page gets the right numbers rather than A4's numbers on a different page.

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
/**
 * A chart the WEDGE declared, built from the run's own structured output.
 *
 * ═══ WHY DECLARED AND NOT WRITTEN ═══
 *
 * A close arrived as a wall of correct figures, and every client who read one asked the same thing
 * in different words: where is my money going. The answer was in the numbers and took four minutes
 * to assemble, so most of them never did.
 *
 * The chart could have come from the prose — a fenced block the model pastes into its summary — and
 * that would put raw markup in the text a client reads in their portal, and hand the model one more
 * place to retype a figure. Both are things this codebase has already paid for once.
 *
 * So the wedge declares WHERE the series lives, the same way it declares `ship_requires` and
 * `ship_checks`, and the numbers come from the output object that was already checked. Nothing is
 * formatted twice and the model writes no markup.
 *
 *   "chart": { "series": "profit_and_loss.by_category", "label": "category",
 *              "value": "amount_minor", "title": "Where the money went" }
 *
 * Trade-blind: `top_competitors` by share of voice, `ranked` candidates by score, `lines` by charge.
 * Absent, or pointing at nothing, produces no chart and no complaint — a report without a picture is
 * a report, and a template that threw here would take the whole delivery with it.
 */
export interface ChartSpec {
  series: string;
  label: string;
  value: string;
  title?: string;
  /**
   * ═══ WHERE THIS RUN'S CURRENCY IS, NOT WHICH CURRENCY THIS SERVICE USES ═══
   *
   * A PATH, read the same way `series` and `value` are. books-keeper declared `"currency": "GBP"`
   * here, frozen in the manifest, and that is wrong in the one way this codebase has decided it
   * cares about most: a Swedish bookkeeping firm's close pack would state SEK in every figure the
   * workflow formatted and £ on the chart beside them. The currency belongs to the client's money,
   * not to the service.
   *
   * Resolved against the run's output first and then its input, because the run states it in one or
   * the other and a chart must not be the only thing on the page that guessed.
   */
  currency_at?: string;
  /** A literal ISO code. Only for a service whose money genuinely cannot be anything else. */
  currency?: string;
  /** Largest first, and at most this many — a bar chart with thirty rows is a table. */
  limit?: number;
}

/**
 * ═══ THE NUMBERS A CLIENT OPENED THE PACK FOR, AS FIGURES RATHER THAN AS A SENTENCE ═══
 *
 * `report.ts` grew a card grid for `fields` blocks, and on a real run it never fired once. The
 * reason is worth writing down: `blocksFromMarkdown` only produces a `fields` block from `Key: value`
 * lines, and a model writing a covering note writes PROSE. So a close pack shipped with
 * "£13,494.61" and "£4,070.61" buried in the ninth line of a paragraph, on a document whose entire
 * purpose is those two numbers.
 *
 * Asking the model to emit `Closing balance: £13,494.61` would work and is the wrong fix twice over:
 * it puts layout in the model's hands, and it asks it to retype a figure a workflow already
 * computed — the exact retyping every arithmetic gate in this repo exists to prevent.
 *
 * So the wedge DECLARES which output paths are the headline figures, the same way it declares
 * `chart`, and they are read off the output that already passed `ship_checks`:
 *
 *   "figures": [
 *     { "label": "Closing balance", "value": "reconciliation.closing_balance_minor" },
 *     { "label": "Money in",        "value": "profit_and_loss.revenue_minor" }
 *   ]
 *
 * Absent produces no panel and no complaint. A `value` that resolves to nothing is DROPPED rather
 * than rendered blank — a card reading "—" tells a client we could not work out their closing
 * balance, which is worse than not showing one.
 */
export interface FigureSpec {
  label: string;
  /** Dotted path into the run's own output. */
  value: string;
  /** Present when the figure is money. A path (resolved from the run) or a literal ISO code. */
  currency_at?: string;
  currency?: string;
  /**
   * What the number is measured in, when it is not money. `"%"` for a share, `" days"` for a wait.
   *
   * A percentage rendered as `25` on a card is a different claim from `25%`, and it is the claim a
   * client is most likely to misread on the one slide they look at.
   */
  suffix?: string;
}

export function figuresBlock(
  specs: FigureSpec[] | undefined,
  parsed: unknown,
  alsoLookIn?: unknown,
): ReportBlock | undefined {
  if (!Array.isArray(specs) || !specs.length) return undefined;
  const at = (obj: unknown, path: string): unknown =>
    path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
  const code = (v: unknown): string | undefined =>
    typeof v === "string" && /^[A-Za-z]{3}$/.test(v.trim()) ? v.trim().toUpperCase() : undefined;

  const rows: ReportField[] = [];
  for (const spec of specs) {
    if (!spec?.label || !spec.value) continue;
    const raw = at(parsed, spec.value);
    if (raw === undefined || raw === null || raw === "") continue;
    const currency = spec.currency_at
      ? (code(at(parsed, spec.currency_at)) ?? code(at(alsoLookIn, spec.currency_at)) ?? code(spec.currency))
      : code(spec.currency);
    const n = Number(raw);
    // A string that is already formatted is quoted as-is — `formatted.net` is "£4,070.61" and
    // reformatting it would be the second place a figure gets written, which is one too many.
    const value =
      typeof raw === "string" && !Number.isFinite(Number(raw))
        ? raw.trim()
        : currency && Number.isFinite(n)
          ? money(n, currency)
          : `${raw}${spec.suffix ?? ""}`;
    if (value) rows.push({ label: spec.label, value });
  }
  return rows.length ? { kind: "fields", rows } : undefined;
}

/**
 * A category as a person writes it. `bank_fees` → `Bank fees`.
 *
 * FOUND ON A REAL RUN. The close pack shipped a chart to a client with `bank_fees` on it, because
 * the category came straight from the ledger and nothing translated it. That is the same defect
 * `machineHeaders` catches in a spreadsheet column — the shortest path from a thing we stored to a
 * screen somebody else reads — and a chart label is more visible than a column heading, not less.
 *
 * Only the shape is changed, never the words. `payroll` stays `Payroll`; it does not become
 * "Staff costs", because renaming a founder's own categories is a different and worse liberty.
 */
export function humanLabel(raw: string): string {
  const t = String(raw ?? "").trim();
  if (!t) return "";
  // An acronym or a word the author capitalised deliberately is left alone: VAT is not Vat.
  if (/^[A-Z0-9&/ -]+$/.test(t)) return t;
  const spaced = t.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function chartBlock(spec: ChartSpec | undefined, parsed: unknown, alsoLookIn?: unknown): ReportBlock | undefined {
  if (!spec?.series || !spec.label || !spec.value) return undefined;
  const at = (obj: unknown, path: string): unknown =>
    path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
  const list = at(parsed, spec.series);
  if (!Array.isArray(list) || !list.length) return undefined;

  /**
   * The run's currency, from wherever the run stated it. Absent stays absent: `money()` explains why
   * there is no default, and a plain number is honest where somebody else's symbol is not.
   */
  const code = (v: unknown): string | undefined => (typeof v === "string" && /^[A-Za-z]{3}$/.test(v.trim()) ? v.trim().toUpperCase() : undefined);
  const currency = spec.currency_at
    ? (code(at(parsed, spec.currency_at)) ?? code(at(alsoLookIn, spec.currency_at)) ?? code(spec.currency))
    : code(spec.currency);

  const series = list
    .map((row) => {
      if (!row || typeof row !== "object") return undefined;
      const r = row as Record<string, unknown>;
      const label = humanLabel(typeof r[spec.label] === "string" ? (r[spec.label] as string) : "");
      const raw = Number(r[spec.value]);
      if (!label || !Number.isFinite(raw)) return undefined;
      // Magnitude drives the bar: costs are stored negative and a chart of negative bars is a chart
      // of nothing. The sign is not information here — every line in a cost breakdown is a cost.
      const value = Math.abs(raw);
      return { label, value, note: currency ? money(value, currency) : String(value) };
    })
    .filter((x): x is { label: string; value: number; note: string } => !!x)
    .sort((a, b) => b.value - a.value);

  if (!series.length) return undefined;
  /**
   * The share is of EVERYTHING, computed before the cap.
   *
   * Computed after it, the top ten of thirty categories would show percentages summing to 100% — a
   * chart quietly answering a different question than the one it appears to. Silent truncation
   * reading as complete coverage is a failure this repo has now paid for three times: the phantom
   * artifact, the judge's column totals over a broken parse, and this.
   */
  const total = series.reduce((s, x) => s + x.value, 0);
  for (const x of series) x.note = total ? `${x.note} · ${Math.round((x.value / total) * 100)}%` : x.note;

  const shown = series.slice(0, spec.limit ?? 10);
  const rest = series.length - shown.length;
  if (rest > 0) {
    // Named, not dropped. "8 others" is a row a reader can ask about; a chart that stops at ten and
    // says nothing has told them their costs are ten things.
    const restTotal = series.slice(shown.length).reduce((s, x) => s + x.value, 0);
    shown.push({
      label: `${rest} other${rest === 1 ? "" : "s"}`,
      value: restTotal,
      note: `${currency ? money(restTotal, currency) : String(restTotal)} · ${Math.round((restTotal / total) * 100)}%`,
    });
  }
  return { kind: "chart", title: spec.title, series: shown };
}

/**
 * Put the chart where the author left room for it.
 *
 * ═══ WHY NOT JUST "AFTER THE FIRST PARAGRAPH" ═══
 *
 * That is where it went, and it was right for a flowing document for the reason stated above: a
 * covering note ends with the questions the client has to answer, and a picture after those is a
 * picture nobody scrolls back up from.
 *
 * It is wrong the moment the author wrote a heading for it. A geo week's markdown contains
 * `## Who is ahead` with nothing underneath, because the model knows the picture goes there and has
 * been told not to write markup. Splicing the chart two blocks earlier leaves that heading titling
 * the section AFTER it — which in the deck came out as a slide holding two words and nothing else.
 *
 * So: the first heading with no content of its own is a slot, and the chart fills it. Otherwise the
 * old rule, which is still the right one when nobody reserved anything.
 */
export function insertChart(blocks: ReportBlock[], chart: ReportBlock | undefined): ReportBlock[] {
  if (!chart) return blocks;
  const out = blocks.slice();
  const slot = out.findIndex((b, i) => b.kind === "heading" && (i + 1 >= out.length || out[i + 1]!.kind === "heading"));
  if (slot >= 0) {
    out.splice(slot + 1, 0, chart);
    return out;
  }
  const after = out.findIndex((b) => b.kind === "paragraph");
  out.splice(after < 0 ? out.length : after + 1, 0, chart);
  return out;
}

/**
 * Minor units to a readable figure. Mirrors `_figures.mjs`; see the note there on doing this once —
 * and on why there is no default currency. A code with no glyph prints as the code, never as a
 * guessed symbol: "SEK 1,240.00" is what a Swedish reader expects and is never wrong.
 */
function money(minor: number, currency: string): string {
  const code = (currency ?? "").trim().toUpperCase();
  const known: Record<string, string> = { GBP: "£", USD: "$", EUR: "€", JPY: "¥", INR: "₹" };
  const sym = known[code] ?? (code ? `${code} ` : "");
  const abs = Math.round(Math.abs(minor));
  const whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sym}${whole}.${String(abs % 100).padStart(2, "0")}`;
}

export function blocksFromMarkdown(md: string): ReportBlock[] {
  const blocks: ReportBlock[] = [];
  const lines = String(md ?? "").replace(/\r\n?/g, "\n").split("\n");
  let para: string[] = [];
  let bullets: string[] = [];
  let fields: ReportField[] = [];
  const flushPara = () => {
    /**
     * STRIPPED AGAIN AFTER JOINING, because emphasis wraps across lines.
     *
     * `stripInline` runs per line and its patterns forbid a newline inside a pair — deliberately, so
     * a lone `*` at the start of a line stays a bullet. That leaves a marker opened on one line and
     * closed on the next untouched, and our own GEO exemplar opens with exactly that: a two-line
     * italic caveat. It reached the PDF as `*(Reference document …)*`, asterisks and all, in the
     * document a client reads.
     *
     * Safe here and not before: by this point the lines are one string, so a pair that really did
     * span them is now adjacent, and anything the per-line pass already removed is gone.
     */
    if (para.length) blocks.push({ kind: "paragraph", text: stripInline(para.join(" ")) });
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
  /**
   * MARKDOWN'S INLINE MARKERS ARE INSTRUCTIONS, NOT CHARACTERS.
   *
   * FOUND BY READING A REAL DECK. A GEO week told the client to create
   * `` `/fresh-bread-gluten-free-bristol` `` and the backticks were drawn onto the slide, because
   * the renderer draws the string it is given and nothing had ever removed them. A client reads
   * that as a typo in a document they are paying for.
   *
   * Done here rather than in the emitters because there are two of them now (`report.ts` and
   * `deck.ts`) and a third would inherit the bug. Paired markers only: a leading `* ` is a bullet
   * and must survive to the branch below that reads it, and `bank_fees` must not lose its
   * underscore — hence the no-space-inside and word-boundary guards.
   *
   * A link keeps its URL. Nothing here emits a PDF link annotation, so dropping the address would
   * turn "publish it here" into an instruction with no here in it.
   */
  const stripInline = (s: string): string =>
    s
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, "$1 ($2)")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\*\*(?!\s)([^*]+?)(?<!\s)\*\*/g, "$1")
      .replace(/(?<![\w*])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![\w*])/g, "$1")
      .replace(/(?<![\w_])_(?!\s)([^_\n]+?)(?<!\s)_(?![\w_])/g, "$1");

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = raw.trimEnd();
    const t = stripInline(line.trim());
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
    /**
     * ═══════════════════════════════════════════════════════════════════════════════════════════
     * A PIPE TABLE IS A TABLE, NOT FOUR PARAGRAPHS OF PROSE SOUP
     * ═══════════════════════════════════════════════════════════════════════════════════════════
     *
     * `ReportBlock` has had a `table` kind since this file was written, and NOTHING EVER PRODUCED
     * ONE. The renderer could draw a table; the parser could not recognise one, so every markdown
     * table a run wrote arrived as a run of paragraphs with pipes in them.
     *
     * FOUND BY RENDERING OUR OWN EXEMPLAR. `wedges/geo-monitor/exemplars/weekly-report.md` is the
     * standard the model is held to, and it contains the share-of-voice table — surface by surface,
     * queries, present, cited. Put through `blocksFromMarkdown` it produced 10 headings, 25
     * paragraphs, 6 dividers, 2 bullet lists and ZERO tables.
     *
     * That table is the part the client is paying for. A visibility report without its numbers laid
     * out is a covering note, and a close pack whose figures run together as a sentence is worse
     * than one with no figures at all — it looks finished.
     *
     * ═══ THE SEPARATOR ROW IS WHAT MAKES IT A TABLE ═══
     *
     * A single line with pipes in it is a sentence about a keyboard. What makes it a table is the
     * `|---|---|` under the header, which is unambiguous and is what every markdown writer emits.
     * Requiring it means a paragraph mentioning "a | b" is never swallowed.
     *
     * Ragged rows are PADDED rather than dropped. A model that writes four headers and a row with
     * three cells has made a small mistake in one row, and losing the row loses a client's number;
     * showing it short shows exactly what was written.
     */
    const pipeCells = (row: string): string[] =>
      row
        .replace(/^\s*\|/, "")
        .replace(/\|\s*$/, "")
        .split("|")
        .map((c) => stripInline(c.trim()));

    if (t.includes("|") && /^\s*\|?[\s:-]*-[\s:|-]*$/.test(stripInline(lines[i + 1]?.trim() ?? ""))) {
      const columns = pipeCells(t);
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length) {
        const cand = lines[j].trim();
        if (!cand.includes("|")) break;
        const cells = pipeCells(stripInline(cand));
        // Pad or clip to the header width so the emitter never reads past a row.
        rows.push(
          Array.from({ length: columns.length }, (_, k) => cells[k] ?? ""),
        );
        j++;
      }
      if (columns.length >= 2 && rows.length) {
        flushAll();
        blocks.push({ kind: "table", columns, rows });
        i = j - 1;
        continue;
      }
    }

    if (/^-{3,}$/.test(t)) {
      flushAll();
      blocks.push({ kind: "divider" });
      continue;
    }
    /**
     * ═══ A LABEL WITH NOTHING AFTER IT IS A HEADING ═══
     *
     * "5 things I need from you:" and "This week:" are how a model writes a section title when it
     * has not been told to use markdown headings — and both shipped on real runs. In the close pack
     * the label rendered as a plain paragraph over the list it introduces; in the GEO deck it became
     * an entire slide reading "This week:" and nothing else, immediately before the slide holding
     * the actual recommendations.
     *
     * A short line ending in a colon, with nothing after the colon and a list or paragraph beneath,
     * is a heading in every register a person writes in. Treating it as one costs nothing and is
     * what the author meant. Length-capped because a sentence can legitimately end in a colon and
     * then run on, and that is prose.
     */
    if (/^.{2,48}:$/.test(t) && !/^https?:/i.test(t)) {
      flushAll();
      blocks.push({ kind: "heading", text: t.replace(/:$/, ""), level: 2 });
      continue;
    }

    // `Label: value` where the label is short — a stat row, not a sentence with a colon.
    //
    // THE VALUE HAS TO BE SHORT TOO, and it did not have to be. A stat row draws the label at the
    // left margin and the value right-aligned at the other, so a "value" that is a whole sentence
    // runs backwards across the label and the two overlap into unreadable mush. A close shipped with
    // "Why I am asking: This is a payment to an individual, so it could instead be employee pay..."
    // rendered exactly that way, on top of the question it was explaining.
    //
    // Forty characters is the honest boundary: `£13,494.61`, `7 November 2026`, `standard accrual`
    // are stats; anything longer is prose and belongs in a paragraph, where it wraps.
    const kv = t.match(/^([^:]{1,32}):\s+(.+)$/);
    /**
     * A VALUE LOOKS LIKE A VALUE, and the length cap alone did not say so.
     *
     * The cap was forty characters, and "Here is the thing: it kept going for a while afterwards."
     * is under it — so an ordinary sentence containing a colon rendered as a stat row: the label at
     * the left margin and the rest of the sentence right-aligned at the other, which is exactly the
     * unreadable shape the note above records shipping once already.
     *
     * A stat value is short in WORDS, or it is a figure. `£13,494.61`, `7 November 2026`, `standard
     * accrual`, `25%` all pass; a clause does not. Four words is the boundary because a date is
     * three and anything longer is prose that belongs in a paragraph, where it wraps.
     */
    const looksLikeValue = (v: string): boolean =>
      /^[£$€¥]?[\d,.]+%?$/.test(v.replace(/\s/g, "")) || (v.match(/\S+/g)?.length ?? 0) <= 4;
    if (kv && !/\.\s/.test(kv[1]) && kv[2].length <= 40 && looksLikeValue(kv[2])) {
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

/**
 * Everything below asks `design.ts` for a size, a gap or a colour and never picks one.
 *
 * That is not tidiness. This template previously contained eighteen hand-chosen numbers, and the
 * linter's verdict on the result was nine type sizes and six text colours on one page — sprawl I
 * introduced myself, one reasonable-looking decision at a time, while trying to make it look better.
 * A ladder cannot do that: two sizes are either the same step or a clearly different one.
 */
class Pager {
  private readonly builders: { b: SceneBuilder }[] = [];
  private b!: SceneBuilder;
  y = 0;
  readonly d: DesignSystem;
  /** Left margin, right margin, content width, and the last y a block may occupy. */
  readonly M: number;
  readonly R: number;
  readonly W: number;
  readonly bottom: number;

  constructor(
    private readonly input: ReportDocumentInput,
    private readonly kit: BrandKit,
    squeeze = 1,
  ) {
    this.d = designFor(kit, { squeeze });
    this.M = this.d.page.margin;
    this.R = this.d.right;
    this.W = this.d.content;
    // Room for the footer rule and its line of text, from the rhythm rather than from a round number.
    this.bottom = this.d.page.height - this.d.space(16);
    this.startPage(true);
  }

  private startPage(first: boolean): void {
    this.b = new SceneBuilder(this.d.page.width, this.d.page.height);
    this.builders.push({ b: this.b });
    this.y = first ? this.letterhead() : this.continuationHead();
  }

  /** Break to a new page when `space` more points would run under the footer. */
  ensure(space: number): void {
    if (this.y + space > this.bottom) this.startPage(false);
  }

  get scene(): SceneBuilder {
    return this.b;
  }

  /** Draw one run of text in a role, at (x, baseline). The only way text reaches the scene. */
  set(x: number, baseline: number, text: string, role: TypeRole, anchor: TextNode["anchor"] = "start"): void {
    this.b.text({ x, y: baseline, text, size: role.size, family: role.family, weight: role.weight, fill: role.fill, anchor, ...(role.tracking ? { tracking: role.tracking } : {}) });
  }

  // ── Chrome ──
  private letterhead(): number {
    const { kit, input, b, d } = { kit: this.kit, input: this.input, b: this.b, d: this.d };
    const { M, R } = this;
    let top = M;
    if (kit.letterhead === "band") {
      b.rect({ x: 0, y: 0, w: d.page.width, h: d.space(2.5), fill: d.surface.accent });
      top = M + d.space(2);
    }
    const logo = kit.logo;
    const wordmark = d.role.subhead;
    /**
     * The wordmark is SUBHEAD, not the biggest thing on the page — it used to be 16pt against a 22pt
     * title, which is a letterhead arguing with its own document. The client knows who sent it; what
     * they do not know is what it says.
     */
    if (logo) {
      const h = Math.min(d.space(10), (logo.height / logo.width) * d.space(42));
      const w = (logo.width / logo.height) * h;
      b.image({ x: M, y: top, w: Math.min(w, d.space(42)), h, mime: logo.mime, data: logo.data });
    } else {
      this.set(M, top + wordmark.size + 2, kit.display_name, wordmark);
    }
    // The document type is a LABEL, not a headline: an 8pt tracked eyebrow, where it used to be 12pt
    // bold competing with the title three lines below it.
    this.set(R, top + wordmark.size + 2, (input.label ?? "Report").toUpperCase(), d.role.eyebrow, "end");

    const metaLabel = as(d.role.caption, { fill: d.surface.faint, tracking: 0.3 });
    const metaValue = as(d.role.caption, { weight: "bold", fill: d.surface.ink });
    let meta = top + d.space(8);
    /**
     * ═══════════════════════════════════════════════════════════════════════════════════════════
     * A LONG META VALUE USED TO PRINT ON TOP OF ITS OWN LABEL
     * ═══════════════════════════════════════════════════════════════════════════════════════════
     *
     * Both are right-aligned: the label ends at `R - space(25)` and the value ends at `R`. So the
     * value grows LEFTWARD and `space(25)` was the entire budget between them — a fixed gutter,
     * never measured against the string going into it.
     *
     * Anything wider simply overprinted the label. A real deliverable shipped with
     * "ChatGPT, Perplexity, Claude, Gemini" stamped through the word "Surfaces", on page one of the
     * document a client opens. Nothing failed; PDF text has no collision detection, so two strings
     * at overlapping coordinates both render and the reader sees mud.
     *
     * The fix is to measure, which this renderer has always been able to do — `textWidth` is
     * imported at the top of this file and `truncateToWidth` sits beside it in fonts.ts, written
     * for exactly this and never called here.
     *
     * The label is pushed left to clear the value, and if the pair cannot fit the header width the
     * VALUE is truncated rather than the label: a clipped label ("Surfa…") tells the reader nothing,
     * while a clipped value still carries its most significant part, which for a list is the first
     * item or two. `truncateToWidth`'s own note makes the same argument for invoice line items.
     */
    const metaGap = d.space(4);
    // Left edge available to the meta block. The wordmark occupies the other half of the line, so
    // the header's midpoint is the floor — a meta row must never reach back into the logo.
    const metaLeft = M + (R - M) / 2;
    for (const row of input.meta ?? []) {
      if (!row.value) continue;
      const labelW = textWidth(row.label, fontFor(metaLabel.family, metaLabel.weight), metaLabel.size);
      const room = R - metaLeft - labelW - metaGap;
      const value = truncateToWidth(
        row.value,
        fontFor(metaValue.family, metaValue.weight),
        metaValue.size,
        Math.max(room, d.space(10)),
      );
      const valueW = textWidth(value, fontFor(metaValue.family, metaValue.weight), metaValue.size);
      // Never TIGHTER than the original gutter, so short rows keep the spacing they were designed
      // with and only a long value moves its label.
      const labelRight = Math.min(R - d.space(25), R - valueW - metaGap);
      this.set(labelRight, meta, row.label, metaLabel, "end");
      this.set(R, meta, value, metaValue, "end");
      meta += d.space(3.5);
    }
    const metaBottom = (input.meta ?? []).some((r) => r.value) ? meta : top;

    /**
     * ═══ THE TITLE TAKES THE FULL WIDTH, AND STARTS BELOW THE META ═══
     *
     * It used to reserve 116 points for the meta column whenever there was any meta at all, which
     * wrapped "July close — Harlow & Finch" onto two lines and left "Finch" orphaned under a 30pt
     * line. The collision it was avoiding is real, but the honest fix is vertical: start the title
     * under the meta block and then use the whole page. `Math.max` costs nothing and scales — five
     * meta rows push the title down instead of squeezing it into a column.
     *
     * The size steps DOWN THE LADDER rather than shrinking freely, so a long title stays on the
     * scale. Three lines of display type is a cover, not a letterhead.
     */
    const title = [d.role.display.size, d.role.figure.size, d.role.heading.size];
    const size = title.find((s) => wrapText(input.title, d.role.display.family, "bold", s, this.W).length <= 2) ?? d.role.heading.size;
    const leading = Math.round(size * 1.23);
    let y = Math.max(top + d.space(20), metaBottom + d.space(6));
    for (const line of wrapText(input.title, d.role.display.family, "bold", size, this.W)) {
      this.set(M, y, line, as(d.role.display, { size }));
      y += leading;
    }
    if (input.subtitle) {
      this.set(M, y + d.space(1), input.subtitle, as(d.role.lede, { fill: d.surface.faint }));
      y += d.space(5);
    }
    y += d.space(4);
    /**
     * A SHORT accent rule, not a full-width one.
     *
     * A line from margin to margin under a title is a divider, and a divider says "the title is
     * over". A short stroke reads as a mark belonging to the title — the move a masthead makes, and
     * the cheapest way to make a page look designed rather than generated.
     */
    b.rect({ x: M, y, w: d.space(14), h: 3, fill: d.surface.accent, rx: 1.5 });
    return y + d.space(7);
  }

  private continuationHead(): number {
    const { kit, input, b, d } = { kit: this.kit, input: this.input, b: this.b, d: this.d };
    const quiet = as(d.role.caption, { fill: d.surface.faint });
    if (kit.letterhead === "band") b.rect({ x: 0, y: 0, w: d.page.width, h: d.space(1.5), fill: d.surface.accent });
    const y = this.M;
    this.set(this.M, y, kit.display_name, as(quiet, { weight: "bold", tracking: 0.5 }));
    this.set(this.R, y, input.title, quiet, "end");
    b.line({ x1: this.M, y1: y + d.space(2), x2: this.R, y2: y + d.space(2), stroke: d.surface.hairline, width: 0.75 });
    return this.M + d.space(7);
  }

  /** Draw the footer on every page once the total is known, then finalise the scenes. */
  finish(): Scene[] {
    const total = this.builders.length;
    const d = this.d;
    const quiet = as(d.role.caption, { fill: d.surface.faint });
    this.builders.forEach(({ b }, i) => {
      const fy = d.page.height - d.space(10);
      b.line({ x1: this.M, y1: fy, x2: this.R, y2: fy, stroke: d.surface.hairline, width: 0.75 });
      const base = fy + d.space(3.5);
      if (this.input.footer) {
        b.text({ x: this.M, y: base, text: this.input.footer, size: quiet.size, family: quiet.family, weight: quiet.weight, fill: quiet.fill, anchor: "start" });
      }
      b.text({ x: this.R, y: base, text: `Page ${i + 1} of ${total}`, size: quiet.size, family: quiet.family, weight: quiet.weight, fill: quiet.fill, anchor: "end" });
    });
    return this.builders.map(({ b }) => b.done(this.input.title));
  }
}

// ── Block layout ─────────────────────────────────────────────────────────────────────────────

/**
 * ═══ THE GATE DRIVES THE FIX ═══
 *
 * The first layout of this template's own test document put a heading, a footer and ONE bullet on
 * page two. That is the `dangling-page` finding in `taste.ts`, and it is what a client remembers
 * about a pack: not the reconciliation, the page that was nearly empty.
 *
 * The tempting fix is to shave four points off a gap until this month's numbers fit, which is duct
 * tape with a shelf life of one client. The honest one is to notice that vertical rhythm is the only
 * genuinely elastic thing on a page — type size is not, leading is not — and to let the same check
 * that would refuse the document decide when to pull that lever.
 *
 * So: lay it out, ask the linter, and if it dangles, lay it out again at tighter rhythm and keep the
 * better of the two. Never worse, because the comparison is explicit. Any other template that emits
 * Scenes gets this for free by doing the same three lines.
 */
export function reportScenes(input: ReportDocumentInput, kit: BrandKit): Scene[] {
  const dangles = (s: Scene[]): boolean => tasteFindings(s).some((f) => f.rule === "dangling-page");
  const full = layout(input, kit, 1);
  if (full.length < 2 || !dangles(full)) return full;
  const tight = layout(input, kit, 0.78);
  return tight.length < full.length || !dangles(tight) ? tight : full;
}

function layout(input: ReportDocumentInput, kit: BrandKit, squeeze: number): Scene[] {
  const p = new Pager(input, kit, squeeze);
  const d = p.d;
  const { M, R, W } = p;
  const S = d.surface;
  /** The first paragraph is set as a lede. See the note on the paragraph block. */
  let seenBody = false;

  for (const block of input.blocks) {
    if (block.kind === "divider") {
      p.ensure(d.space(3.5));
      p.scene.line({ x1: M, y1: p.y, x2: R, y2: p.y, stroke: S.hairline, width: 0.75 });
      p.y += d.space(4);
      continue;
    }
    /**
     * ═══ A SECTION HEADING IS A LANDMARK, NOT A BIGGER SENTENCE ═══
     *
     * These were 15pt and 12pt bold at the same margin as everything else, so scanning the page for
     * "where does the VAT part start" meant reading it. A heading earns its place by being findable
     * at arm's length, and size alone never does that on a page that is already all text.
     *
     * A level-1 is a tracked eyebrow in the accent over a hairline: the eye lands on the rule and the
     * colour long before it reads the words. Level-2 stays a word, at weight, because a document with
     * two competing landmark styles has none.
     */
    if (block.kind === "heading") {
      const level = block.level ?? 1;
      if (level === 1) {
        p.y += d.space(5);
        p.ensure(d.space(8));
        p.set(M, p.y + d.space(2.25), block.text.toUpperCase(), d.role.eyebrow);
        p.scene.line({ x1: M, y1: p.y + d.space(4.25), x2: R, y2: p.y + d.space(4.25), stroke: S.hairline, width: 0.75 });
        p.y += d.space(7.5);
      } else {
        p.y += d.space(3.5);
        p.ensure(d.space(6));
        p.set(M, p.y + d.role.subhead.size, block.text, d.role.subhead);
        p.y += d.space(5.5);
      }
      continue;
    }

    /**
     * THE FIRST PARAGRAPH IS A LEDE, and it was the same size as the rest.
     *
     * On a covering note the opening sentences carry the finding — "July reconciles to the penny,
     * four items need your answer" — and everything after them is support. Setting them one step up
     * the ladder with more leading is how a reader knows where to start and, more usefully, that they
     * may stop there and still have the answer.
     */
    if (block.kind === "paragraph") {
      /**
       * A LEDE IS SHORT, OR IT IS NOT A LEDE.
       *
       * The first paragraph is set a step up because on a covering note the opening sentences carry
       * the finding. That is true of two or three sentences and false of thirteen — a real close came
       * back with a 200-word single paragraph, and setting it at lede size produced exactly the wall
       * this document was rebuilt to stop being. The larger type made it worse, not better.
       *
       * Six lines is the boundary: about as much as anybody reads before deciding whether to keep
       * going. Past it the paragraph is prose and gets body treatment, which is the honest answer —
       * the fix for a 200-word opener is a shorter opener, and shrinking it is us declining to
       * pretend otherwise.
       */
      const asLede = !seenBody && wrapText(block.text, d.role.lede.family, d.role.lede.weight, d.role.lede.size, W).length <= 6;
      const role = asLede ? as(d.role.lede, { fill: S.ink }) : d.role.body;
      seenBody = true;
      for (const line of wrapText(block.text, role.family, role.weight, role.size, W)) {
        p.ensure(role.leading);
        p.set(M, p.y + role.size, line, role);
        p.y += role.leading;
      }
      p.y += d.space(2.5);
      continue;
    }

    /**
     * A hanging indent and a small square, not a bullet glyph at the margin.
     *
     * The wrapped lines used to start at the same x as the first, so a two-line item read as two
     * items. Hanging the text off a fixed indent is the whole of what makes a list scannable, and it
     * costs one number.
     */
    if (block.kind === "bullets") {
      const role = d.role.body;
      const indent = d.space(4.5);
      for (const item of block.items) {
        wrapText(item, role.family, role.weight, role.size, W - indent).forEach((line, i) => {
          p.ensure(role.leading);
          if (i === 0) p.scene.rect({ x: M + 1, y: p.y + d.space(1.4), w: 4, h: 4, fill: S.accent, rx: 1 });
          p.set(M + indent, p.y + role.size, line, role);
          p.y += role.leading;
        });
        p.y += d.space(1.25);
      }
      p.y += d.space(1.5);
      continue;
    }

    /**
     * ═══ FIGURES ARE THE THING THEY CAME FOR, SO THEY GET THE PAGE'S LARGEST TYPE ═══
     *
     * A stat row was a label, a right-aligned value and a hairline — the same visual weight as a
     * sentence. On a monthly close those three or four rows ARE the deliverable, and they were the
     * quietest thing on the page.
     *
     * A grid of cards fixes both halves of "it looks like a slab" at once: the numbers are set at
     * `figure`, two steps above the body, and the cards put content at four different x positions on
     * a page that otherwise has one. It is also the treatment a founder recognises from every
     * dashboard they have ever used, which is the point — this is their client's first impression.
     *
     * A GRID ONLY WHEN IT COMES OUT EVEN. Five cards in threes leaves a two-card orphan row, which
     * looks like the layout ran out rather than like a decision; those fall back to the list panel,
     * which handles any count. Long values (a sentence, a date range) fall back too — a card is for
     * a figure.
     */
    if (block.kind === "fields") {
      const rows = block.rows;
      const even: Record<number, number> = { 2: 2, 3: 3, 4: 2, 6: 3 };
      const cols = rows.every((r) => r.value.length <= 18) ? even[rows.length] : undefined;
      if (cols) statCards(p, rows, cols);
      else statPanel(p, rows);
      continue;
    }
    if (block.kind === "chart") {
      const series = block.series.filter((s2) => Number.isFinite(s2.value));
      if (!series.length) continue;
      const peak = Math.max(...series.map((s2) => Math.abs(s2.value)));
      if (!peak) continue;

      const ROW = d.space(5);
      const BAR = d.space(2.5);
      const labelRole = as(d.role.small, { fill: S.ink });
      const noteRole = as(d.role.small, { fill: S.faint });
      const labelW = Math.min(d.space(34), Math.max(...series.map((s2) => textWidth(s2.label, fontFor(labelRole.family, "normal"), labelRole.size))) + d.space(3));
      const noteW = Math.max(...series.map((s2) => textWidth(s2.note ?? "", fontFor(noteRole.family, "normal"), noteRole.size))) + d.space(3);
      const trackX = M + labelW;
      const trackW = Math.max(d.space(20), R - trackX - noteW);

      p.ensure(series.length * ROW + (block.title ? d.space(6) : 0) + d.space(2));
      if (block.title) {
        p.set(M, p.y + d.role.subhead.size, block.title, d.role.subhead);
        p.y += d.space(5.5);
      }
      for (const item of series) {
        const w = Math.max(1.5, (Math.abs(item.value) / peak) * trackW);
        // The track first, so a short bar reads as a proportion of something rather than as a stub
        // floating in white space.
        p.scene.rect({ x: trackX, y: p.y, w: trackW, h: BAR, fill: S.track, rx: 1.5 });
        p.scene.rect({ x: trackX, y: p.y, w, h: BAR, fill: S.accent, rx: 1.5 });
        p.set(M, p.y + BAR * 0.85, item.label, labelRole);
        if (item.note) p.set(R, p.y + BAR * 0.85, item.note, noteRole, "end");
        p.y += ROW;
      }
      p.y += d.space(2);
      continue;
    }
    if (block.kind === "table") {
      layoutTable(p, block.columns, block.rows);
      continue;
    }
  }

  return p.finish();
}

/** The grid. One size for every value on it, so the row of numbers reads as a set. */
function statCards(p: Pager, rows: ReportField[], cols: number): void {
  const d = p.d;
  const S = d.surface;
  const gut = d.space(3);
  const pad = d.space(4);
  const cardW = (p.W - gut * (cols - 1)) / cols;
  const labelRole = as(d.role.caption, { weight: "bold", fill: S.faint, tracking: 0.6 });
  /**
   * ONE SIZE FOR ALL OF THEM, chosen as the largest ladder step every value fits at.
   *
   * Shrinking each value independently would put "£13,494.61" and "£96.00" at different sizes in the
   * same row, which reads as a bug; and shrinking freely rather than by step is how a page ends up
   * with nine type sizes. Both failures were in this file a day ago.
   */
  const ladder = [d.role.figure.size, d.role.heading.size, d.role.subhead.size, d.role.body.size];
  const inner = cardW - pad * 2;
  const valueSize = ladder.find((s) => rows.every((r) => textWidth(r.value, fontFor(d.role.figure.family, "bold"), s) <= inner)) ?? d.role.body.size;
  const valueRole = as(d.role.figure, { size: valueSize });
  const cardH = pad * 2 + labelRole.size + d.space(3) + valueSize;
  const lines = Math.ceil(rows.length / cols);

  p.ensure(lines * (cardH + gut));
  const top = p.y;
  rows.forEach((row, i) => {
    const cx = p.M + (i % cols) * (cardW + gut);
    const cy = top + Math.floor(i / cols) * (cardH + gut);
    p.scene.rect({ x: cx, y: cy, w: cardW, h: cardH, fill: S.panel, rx: d.space(1.5) });
    p.set(cx + pad, cy + pad + labelRole.size * 0.8, row.label.toUpperCase(), labelRole);
    p.set(cx + pad, cy + cardH - pad, row.value, valueRole);
  });
  p.y = top + lines * (cardH + gut) + d.space(2);
}

/** The fallback: a tinted panel of label/value rows. Handles any count and any value length. */
function statPanel(p: Pager, rows: ReportField[]): void {
  const d = p.d;
  const S = d.surface;
  const H = d.space(6.5);
  const padY = d.space(3);
  const padX = d.space(4);
  const labelRole = as(d.role.small, { fill: S.faint });
  const valueRole = d.role.subhead;
  const height = rows.length * H + padY * 2 - d.space(1.5);
  p.ensure(height + d.space(2.5));
  p.scene.rect({ x: p.M, y: p.y, w: p.W, h: height, fill: S.panel, rx: d.space(1.5) });
  let ry = p.y + padY;
  rows.forEach((row, i) => {
    p.set(p.M + padX, ry + labelRole.size + 3, row.label, labelRole);
    p.set(p.R - padX, ry + valueRole.size + 1, row.value, valueRole, "end");
    if (i < rows.length - 1) {
      p.scene.line({ x1: p.M + padX, y1: ry + H - 4, x2: p.R - padX, y2: ry + H - 4, stroke: S.hairline, width: 0.5 });
    }
    ry += H;
  });
  p.y += height + d.space(4);
}

/** Equal-width columns; cells wrap; the header row repeats on every page the table spills onto. */
function layoutTable(p: Pager, columns: string[], rows: string[][]): void {
  const d = p.d;
  const S = d.surface;
  const cols = Math.max(1, columns.length);
  const colW = p.W / cols;
  const pad = d.space(1.25);
  const headRole = as(d.role.small, { weight: "bold", fill: S.ink });
  const cellRole = as(d.role.small, { fill: S.ink });
  const drawHeader = () => {
    p.ensure(d.space(5.5));
    p.scene.rect({ x: p.M, y: p.y, w: p.W, h: d.space(5), fill: S.accentWash });
    columns.forEach((c, i) => {
      const text = wrapText(c, headRole.family, "bold", headRole.size, colW - pad * 2)[0] ?? c;
      p.set(p.M + i * colW + pad, p.y + d.space(3.25), text, headRole);
    });
    p.y += d.space(5);
  };
  drawHeader();
  for (const row of rows) {
    const cellLines = row.map((cell) => wrapText(String(cell ?? ""), cellRole.family, "normal", cellRole.size, colW - pad * 2));
    const rowH = Math.max(d.space(4.5), ...cellLines.map((l) => l.length * cellRole.leading + d.space(1.5)));
    if (p.y + rowH > p.bottom) {
      p.ensure(rowH + d.space(5.5)); // forces a new page, then reprint the header
      drawHeader();
    }
    cellLines.forEach((lines, i) => {
      lines.forEach((line, li) => {
        p.set(p.M + i * colW + pad, p.y + cellRole.size + d.space(0.75) + li * cellRole.leading, line, cellRole);
      });
    });
    p.scene.line({ x1: p.M, y1: p.y + rowH, x2: p.R, y2: p.y + rowH, stroke: S.hairline, width: 0.5 });
    p.y += rowH;
  }
  p.y += d.space(2);
}
