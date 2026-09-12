/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * THE DOCUMENT, IN THE PIECES A PERSON ACTUALLY EDITS
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Until this file existed, a founder reviewing a deliverable could edit exactly one thing: the
 * summary — the covering note the client reads above the work. The work itself, the markdown report
 * or the HTML page or the CSV that is the entire reason the run happened, was READ-ONLY. Their only
 * options on a document with one wrong sentence in it were to send it wrong, or to send the whole
 * thing back and wait for a fresh run.
 *
 * That is not how anyone edits anything. You click the sentence and you fix the sentence.
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * WHY SPANS, AND NOT A SYNTAX TREE
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The obvious build is parse → tree → edit the tree → re-serialise. Every markdown library on earth
 * does that, and it is WRONG HERE, because re-serialising rewrites the entire file. Change one word
 * in paragraph nine and the library also normalises your list markers, collapses your blank lines,
 * reflows your tables and reorders your link references. The founder changed six characters and the
 * client receives a document that differs on four hundred lines. Any diff we show them is a lie, any
 * lesson we distil from it is noise, and the one thing they wanted to keep — the agent's work — is
 * the thing we silently mangled.
 *
 * So a block here is not a node. It is a RANGE: `[start, end)` into the original string, plus the
 * editable text inside that range. Applying an edit splices bytes. Everything outside the ranges the
 * founder touched is byte-identical, guaranteed, by construction rather than by care.
 *
 * The invariant that falls out, and which `doc-blocks.test.ts` asserts on every fixture:
 *
 *     applyBlockEdits(src, parseBlocks(src, fmt), []) === src
 *
 * Not "equivalent". Not "renders the same". The same bytes. This is what makes it safe to point the
 * feature at a client-ready document we did not write and cannot fully parse.
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * WHICH MEANS AN UNPARSEABLE DOCUMENT IS STILL EDITABLE
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A tree parser has to understand a construct to let you touch it. A span parser does not: anything
 * the splitter fails to recognise becomes one `raw` block covering its own lines, still selectable,
 * still editable, and — because the span is exact — still incapable of disturbing its neighbours.
 * Footnotes, reference links, HTML embedded in markdown, a table dialect we have never seen: all of
 * them degrade to "you can edit this as text", which is strictly better than "you cannot edit this".
 */

/** The formats a founder can edit in place. PDF is deliberately absent — see `editableFormat`. */
export type BlockFormat = "markdown" | "html" | "csv";

export type BlockKind =
  | "heading"
  | "paragraph"
  | "list_item"
  | "quote"
  | "table_row"
  | "code"
  | "cell"
  | "raw";

export interface DocBlock {
  /**
   * Stable for one parse of one source, and used as the address an edit is posted against. NOT
   * stable across an edit: the caller re-parses after applying, exactly as a text editor re-lexes.
   */
  id: string;
  kind: BlockKind;
  /** What the founder sees and types into. The marker (`## `, `- `) is not part of it. */
  text: string;
  /**
   * The bytes between `start` and the beginning of `text`. Re-emitted verbatim on serialise, which
   * is how `## ` stays `## ` and a three-space list indent stays three spaces.
   */
  prefix: string;
  /** The bytes between the end of `text` and `end` — a closing fence, a trailing pipe. */
  suffix: string;
  start: number;
  end: number;
  /** Where a person would say this is, for the audit trail: "Heading 2", "Row 4, Column C". */
  label: string;
  /**
   * Grid position, on table and CSV cells only.
   *
   * The console has to rebuild a real `<table>` out of a flat list, and the alternative was parsing
   * it back out of `label` — which makes a display string load-bearing and breaks the layout the
   * first time anybody rewords "Row 4, column 2". Two numbers say it once.
   */
  row?: number;
  col?: number;
  /** Heading depth, 1-6. Headings only — the console sizes the text with it. */
  level?: number;
}

export interface BlockEdit {
  id: string;
  text: string;
}

/** One block a founder actually changed, in the terms the lesson writer needs. */
export interface BlockChange {
  id: string;
  kind: BlockKind;
  label: string;
  before: string;
  after: string;
}

/**
 * The format to edit an artifact as, or `undefined` when in-place editing is not honest for it.
 *
 * PDF returns `undefined` ON PURPOSE and this is the most important line in the file. A PDF is a
 * RENDERING — the text in it is positioned glyphs, and "editing" one means reflowing a document
 * whose source we do not hold. We could ship something that appears to work and produces a subtly
 * broken PDF. Refusing is the honest answer, and the console says so in words and offers the two
 * things that do work: change the covering note, or send it back with what to fix.
 */
export function editableFormat(contentType: string, name: string): BlockFormat | undefined {
  const type = (contentType || "").toLowerCase();
  const file = (name || "").toLowerCase();
  if (/\.pdf$/.test(file) || type.includes("pdf")) return undefined;
  if (/\.(png|jpe?g|gif|webp|svg|zip|gz|xlsx|docx|pptx)$/.test(file)) return undefined;
  if (/\.html?$/.test(file) || type.includes("html")) return "html";
  if (/\.(csv|tsv)$/.test(file) || type.includes("csv")) return "csv";
  if (/\.(md|markdown|txt|text)$/.test(file) || type.includes("markdown") || type.includes("text/plain")) return "markdown";
  return undefined;
}

export function parseBlocks(source: string, format: BlockFormat): DocBlock[] {
  if (format === "html") return parseHtmlBlocks(source);
  if (format === "csv") return parseCsvBlocks(source);
  return parseMarkdownBlocks(source);
}

/**
 * Splice the edits in and hand back the new source, plus exactly what changed.
 *
 * Applied HIGHEST OFFSET FIRST so that every remaining span still points at the right bytes — the
 * standard reason a multi-edit patcher corrupts a file is applying left to right and letting the
 * first length change shift everything after it.
 *
 * An edit naming a block that is not in `blocks` is dropped rather than throwing. The console can be
 * a parse behind (the founder edited, the document re-parsed, a stale save arrives); losing one
 * stale edit is recoverable, and refusing the whole save is the founder's afternoon.
 */
export function applyBlockEdits(
  source: string,
  blocks: DocBlock[],
  edits: BlockEdit[],
  format: BlockFormat = "markdown",
): { text: string; changes: BlockChange[] } {
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const applicable: { block: DocBlock; text: string }[] = [];
  for (const e of edits) {
    const block = byId.get(e.id);
    if (!block) continue;
    // Normalise the newline the browser sends before comparing, or every textarea save on Windows
    // reads as a change to every line it touched.
    const next = e.text.replace(/\r\n/g, "\n");
    if (next === block.text) continue;
    applicable.push({ block, text: next });
  }

  applicable.sort((a, b) => b.block.start - a.block.start);

  let text = source;
  const changes: BlockChange[] = [];
  for (const { block, text: next } of applicable) {
    // Guard first (keep the edit inside its block), then escape for the target format. Reversing
    // these would escape the guard's own characters and write `&amp;` into a markdown file.
    const replacement = block.prefix + serialiseBlockText(format, guardBlockText(block, next)) + block.suffix;
    text = text.slice(0, block.start) + replacement + text.slice(block.end);
    changes.push({ id: block.id, kind: block.kind, label: block.label, before: block.text, after: next });
  }
  // Report in document order. The founder reads their own changes top to bottom, and so should the
  // timeline entry and the lesson.
  changes.reverse();
  return { text, changes };
}

/**
 * Keep an edit inside its own block.
 *
 * A founder pasting two paragraphs into a list item would otherwise write a newline into the middle
 * of a `- ` line and silently end the list. The structural characters that can escape a block are
 * per-kind, and they are neutralised rather than rejected: the paste lands, the document stays
 * valid, and nobody loses typing to a validation error on a screen they are trying to leave.
 */
function guardBlockText(block: DocBlock, next: string): string {
  switch (block.kind) {
    case "heading":
    case "list_item":
    case "quote":
      return next.replace(/\n+/g, " ").trim();
    case "table_row":
      // A newline ends the row and a bare pipe invents a column. Both silently reshape the table.
      return next.replace(/\n+/g, " ").replace(/\|/g, "\\|").trim();
    case "cell": {
      const flat = next.replace(/\r?\n/g, " ");
      // An unquoted cell that now contains a delimiter or a quote would split the row on the next
      // read. It gets quoted here; a cell that was ALREADY quoted keeps its quotes in prefix/suffix
      // and only needs its inner quotes doubled.
      const wasQuoted = block.prefix.trimStart().startsWith('"');
      if (wasQuoted) return flat.replace(/"/g, '""');
      return /[",\t]/.test(flat) ? '"' + flat.replace(/"/g, '""') + '"' : flat;
    }
    case "code":
    case "paragraph":
    case "raw":
    default:
      return next;
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// MARKDOWN
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const HEADING = /^(\s{0,3}#{1,6}\s+)(.*?)(\s*)$/;
const LIST_ITEM = /^(\s*(?:[-*+]|\d{1,9}[.)])\s+)(.*?)(\s*)$/;
const QUOTE = /^(\s{0,3}>\s?)(.*?)(\s*)$/;
const TABLE_ROW = /^\s*\|.*\|?\s*$/;
// `| --- | :-: |` carries no prose and editing it would be editing the table's alignment as if it
// were a sentence. It stays in the document untouched and simply is not offered as a block.
const TABLE_DIVIDER = /^\s*\|?[\s:|-]+\|?\s*$/;

function parseMarkdownBlocks(source: string): DocBlock[] {
  const out: DocBlock[] = [];
  const lines = splitKeepingOffsets(source);
  let i = 0;
  let n = 0;
  const push = (b: Omit<DocBlock, "id">) => out.push({ ...b, id: `b${n++}` });
  const counts: Record<string, number> = {};
  const ordinal = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);

  while (i < lines.length) {
    const line = lines[i]!;

    // Fenced code — opaque, and taken whole so an edit cannot lose the fence.
    const fence = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(line.text);
    if (fence) {
      const marker = fence[2]!;
      const openEnd = line.end;
      let j = i + 1;
      while (j < lines.length && !new RegExp(`^\\s*${marker[0]}{${marker.length},}\\s*$`).test(lines[j]!.text)) j++;
      const closed = j < lines.length;
      const bodyStart = i + 1 <= lines.length - 1 ? lines[i + 1]?.start ?? openEnd : openEnd;
      const bodyEnd = closed ? lines[j]!.start : source.length;
      push({
        kind: "code",
        text: source.slice(bodyStart, bodyEnd).replace(/\n$/, ""),
        prefix: "",
        suffix: source.slice(bodyStart, bodyEnd).endsWith("\n") ? "\n" : "",
        start: bodyStart,
        end: bodyEnd,
        label: `Code block ${ordinal("code")}`,
      });
      i = closed ? j + 1 : lines.length;
      continue;
    }

    if (!line.text.trim()) {
      i++;
      continue;
    }

    const heading = HEADING.exec(line.text);
    if (heading) {
      const level = (heading[1]!.match(/#/g) ?? []).length;
      push({
        kind: "heading",
        text: heading[2]!,
        prefix: heading[1]!,
        suffix: heading[3]!,
        start: line.start,
        end: line.start + line.text.length,
        label: `Heading${level > 1 ? ` ${level}` : ""}`,
        level,
      });
      i++;
      continue;
    }

    const quote = QUOTE.exec(line.text);
    if (quote) {
      push({
        kind: "quote",
        text: quote[2]!,
        prefix: quote[1]!,
        suffix: quote[3]!,
        start: line.start,
        end: line.start + line.text.length,
        label: `Quote ${ordinal("quote")}`,
      });
      i++;
      continue;
    }

    const item = LIST_ITEM.exec(line.text);
    if (item) {
      // One bullet, one block. A founder fixing the third bullet should not be handed the whole
      // list in a textarea and asked not to disturb the other four.
      push({
        kind: "list_item",
        text: item[2]!,
        prefix: item[1]!,
        suffix: item[3]!,
        start: line.start,
        end: line.start + line.text.length,
        label: `Bullet ${ordinal("bullet")}`,
      });
      i++;
      continue;
    }

    if (TABLE_ROW.test(line.text)) {
      if (TABLE_DIVIDER.test(line.text)) {
        i++;
        continue;
      }
      const row = ordinal("row");
      for (const cell of splitTableRow(line.text, line.start)) {
        push({
          kind: "table_row",
          text: cell.text,
          prefix: cell.prefix,
          suffix: cell.suffix,
          start: cell.start,
          end: cell.end,
          label: `Row ${row}, column ${cell.column}`,
          row,
          col: cell.column,
        });
      }
      i++;
      continue;
    }

    // A paragraph: consecutive lines that start nothing else. Its span covers them all, so the
    // internal newlines and any trailing spaces come back exactly as written.
    const start = line.start;
    let end = line.start + line.text.length;
    let j = i;
    while (j < lines.length) {
      const t = lines[j]!.text;
      if (!t.trim()) break;
      if (j > i && (HEADING.test(t) || LIST_ITEM.test(t) || QUOTE.test(t) || TABLE_ROW.test(t) || /^(\s*)(`{3,}|~{3,})/.test(t))) break;
      end = lines[j]!.start + t.length;
      j++;
    }
    push({
      kind: "paragraph",
      text: source.slice(start, end),
      prefix: "",
      suffix: "",
      start,
      end,
      label: `Paragraph ${ordinal("para")}`,
    });
    i = j;
  }
  return out;
}

/** Cells of a `| a | b |` row, each with the exact pipes and padding around it. */
function splitTableRow(text: string, base: number): { text: string; prefix: string; suffix: string; start: number; end: number; column: number }[] {
  const out: { text: string; prefix: string; suffix: string; start: number; end: number; column: number }[] = [];
  const parts: { raw: string; at: number }[] = [];
  let buf = "";
  let at = 0;
  for (let k = 0; k < text.length; k++) {
    const ch = text[k]!;
    if (ch === "\\" && text[k + 1] === "|") {
      buf += "\\|";
      k++;
      continue;
    }
    if (ch === "|") {
      parts.push({ raw: buf, at });
      buf = "";
      at = k + 1;
      continue;
    }
    buf += ch;
  }
  parts.push({ raw: buf, at });

  let column = 0;
  for (const p of parts) {
    // The leading and trailing fragments of `| a | b |` are the outside of the table, not cells.
    if (!p.raw.trim()) continue;
    const lead = p.raw.length - p.raw.trimStart().length;
    const trail = p.raw.length - p.raw.trimEnd().length;
    column++;
    out.push({
      text: p.raw.trim(),
      prefix: p.raw.slice(0, lead),
      suffix: p.raw.slice(p.raw.length - trail),
      start: base + p.at,
      end: base + p.at + p.raw.length,
      column,
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// HTML — the text between the tags, and nothing else
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Only text nodes become blocks, so there is no path by which editing a page can produce invalid
 * markup: the founder never holds a `<` and the tags are outside every span we will write to.
 *
 * `<script>` and `<style>` bodies are excluded — they are text nodes, they are not prose, and the
 * only thing offering them achieves is letting somebody break the page's rendering by "fixing a
 * sentence" that was a CSS rule.
 */
function parseHtmlBlocks(source: string): DocBlock[] {
  const out: DocBlock[] = [];
  let n = 0;
  let count = 0;
  const re = /<!--[\s\S]*?-->|<(script|style)\b[\s\S]*?<\/\1\s*>|<[^>]*>/gi;
  let last = 0;
  let m: RegExpExecArray | null;
  const emit = (start: number, end: number) => {
    const raw = source.slice(start, end);
    if (!raw.trim()) return;
    if (!/[A-Za-z0-9]/.test(raw)) return;
    const lead = raw.length - raw.trimStart().length;
    const trail = raw.length - raw.trimEnd().length;
    count++;
    out.push({
      id: `b${n++}`,
      kind: "paragraph",
      text: decodeEntities(raw.trim()),
      prefix: raw.slice(0, lead),
      suffix: raw.slice(raw.length - trail),
      start,
      end,
      label: `Text ${count}`,
    });
  };
  while ((m = re.exec(source))) {
    if (m.index > last) emit(last, m.index);
    last = m.index + m[0]!.length;
  }
  if (last < source.length) emit(last, source.length);
  return out;
}

/**
 * The five that matter, in the order that makes `&amp;lt;` survive a round trip — ampersand last on
 * the way out, first on the way in. Getting this backwards double-decodes and turns a page that
 * displays `&lt;` into one that renders a tag.
 */
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function encodeEntities(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// CSV — one cell, one block
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const MAX_CSV_CELLS = 4_000;

function parseCsvBlocks(source: string): DocBlock[] {
  const out: DocBlock[] = [];
  let n = 0;
  const delimiter = source.includes("\t") && !source.includes(",") ? "\t" : ",";
  let row = 0;
  for (const line of splitKeepingOffsets(source)) {
    if (!line.text.trim()) continue;
    row++;
    let column = 0;
    let at = 0;
    let inQuotes = false;
    const flush = (endAt: number) => {
      const raw = line.text.slice(at, endAt);
      column++;
      // A quoted cell is offered as its contents; the quotes are prefix and suffix, so a comma typed
      // into an already-quoted cell stays inside its quotes and does not split the row.
      const quoted = /^\s*"[\s\S]*"\s*$/.test(raw);
      const lead = quoted ? raw.indexOf('"') + 1 : raw.length - raw.trimStart().length;
      const trail = quoted ? raw.length - raw.lastIndexOf('"') : raw.length - raw.trimEnd().length;
      out.push({
        id: `b${n++}`,
        kind: "cell",
        text: quoted ? raw.slice(lead, raw.length - trail).replace(/""/g, '"') : raw.trim(),
        prefix: raw.slice(0, lead),
        suffix: raw.slice(raw.length - trail),
        start: line.start + at,
        end: line.start + endAt,
        label: row === 1 ? `Header, column ${column}` : `Row ${row - 1}, column ${column}`,
        row,
        col: column,
      });
      at = endAt + 1;
    };
    for (let k = 0; k < line.text.length && out.length < MAX_CSV_CELLS; k++) {
      const ch = line.text[k]!;
      if (ch === '"') inQuotes = !inQuotes;
      else if (ch === delimiter && !inQuotes) flush(k);
    }
    if (out.length < MAX_CSV_CELLS) flush(line.text.length);
    if (out.length >= MAX_CSV_CELLS) break;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Lines with their absolute offsets, keeping the source's own newlines out of the text. */
function splitKeepingOffsets(source: string): { text: string; start: number; end: number }[] {
  const out: { text: string; start: number; end: number }[] = [];
  let start = 0;
  for (let i = 0; i <= source.length; i++) {
    if (i === source.length || source[i] === "\n") {
      let text = source.slice(start, i);
      // A CRLF file must not hand `\r` back as part of the editable text, and must still get it back
      // on serialise — so it lives in the line's suffix, which the span preserves untouched.
      if (text.endsWith("\r")) text = text.slice(0, -1);
      out.push({ text, start, end: i });
      start = i + 1;
    }
  }
  return out;
}

/** For HTML, the founder's text has to be re-escaped on the way in. Exported for the route. */
export function serialiseBlockText(format: BlockFormat, text: string): string {
  return format === "html" ? encodeEntities(text) : text;
}
