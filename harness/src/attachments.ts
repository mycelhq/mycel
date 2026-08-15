// Turning a file a founder dropped on the composer into text a turn can cite — and nothing else.
//
// ═══ WHERE AN ATTACHMENT GOES, AND THE ARGUMENT FOR IT ═══
//
// Three options were on the table. Only one of them is safe at this door.
//
//   1. KNOWLEDGE (persisted, retrievable later). REJECTED. `knowledge.ts` defaults `sensitivity` to
//      `client` because a document with no attribution written as `house` is the leak that already
//      shipped in this codebase: a file about one client mounted into every other client's run.
//      Nothing at the composer names a client — a founder typed a sentence, they did not select an
//      engagement — so the only labels available are `house` (wrong, and the exact shape of the old
//      bug) or `client` with no owner, which `mayMount` correctly makes readable by nobody. A write
//      that is either dangerous or inert is not a write worth making.
//   2. A TASK DOCUMENT mounted into `./inputs/`. REJECTED HERE, but only here. It is the right home
//      for a bank statement that belongs to a specific engagement, and the product already has that
//      door: `POST /v1/tasks/:id/artifacts`, which takes a `client_id` because the task has one. The
//      composer has no task. Inventing one to hold a file would be inventing an engagement.
//   3. TRANSIENT CONTEXT for this turn. TAKEN. The text is extracted, bounded, numbered into the
//      fact list, cited as `attachment`, and dropped when the response returns.
//
// The narrowest option is the default because the two failure directions are not symmetric, which is
// the same argument `sensitivityOf` makes: an attachment we forget is one re-upload, and an
// attachment we filed under the wrong client is a disclosure of one customer's business to another.
//
// A founder who wants a document to persist can say so, once, in a place where the client is named.
// That is a decision with an owner. This module refuses to make it on their behalf.
//
// ═══ AND IT IS NOT A PARSER FARM ═══
//
// Text, PDF (embedded text), XLSX and DOCX — and only the parts we can bound. There is still no
// image OCR and no arbitrary archive walking: a full office/OCR farm is a decompression bomb with a
// founder's session on the other side of it. Anything we cannot read comes back as a NAMED REFUSAL
// with a sentence that says what to do, because "your file did nothing" is the worst possible answer
// to someone who just dragged a statement onto the screen.
import { inflateSync, inflateRawSync } from "node:zlib";

/** Per file. Small on purpose: this is a thing you drop on a chat box, not a data import. */
export const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;
/** Per turn. Four documents is already more than one question is usually about. */
export const MAX_ATTACHMENTS = 4;
/** Characters kept from one file. Matches `ask.MAX_ATTACHMENT_CHARS` — the context bound. */
export const MAX_TEXT_CHARS = 6_000;

/** Types whose bytes are already text. Anything else is either PDF or refused. */
const TEXTUAL = /^(text\/|application\/json|application\/x-ndjson|application\/xml|text\/xml)/i;
/** Extensions a browser routinely mislabels as `application/octet-stream`. */
const TEXTUAL_EXT = /\.(txt|md|markdown|csv|tsv|json|ndjson|log|yaml|yml|xml|html?)$/i;

export type ExtractRefusal = "too_large" | "empty" | "unsupported" | "unreadable_pdf" | "unreadable_image";

export type Extracted =
  | { ok: true; name: string; text: string; chars: number; truncated: boolean }
  | { ok: false; name: string; reason: ExtractRefusal; message: string };

/** Basename only — a name like `../../etc/passwd` is harmless here and lethal to a later consumer. */
const basename = (n: string): string => (n || "file").split(/[\\/]/).pop()!.slice(0, 200);

/**
 * One file → text, or a refusal that says what to do about it.
 *
 * Every branch returns; nothing throws. This runs on the request path of a surface mounted on every
 * page, and a malformed PDF must produce a sentence, not a 500 in the founder's composer.
 */
export function extractText(name: string, mediaType: string, bytes: Buffer): Extracted {
  const file = basename(name);
  if (bytes.byteLength === 0) {
    return { ok: false, name: file, reason: "empty", message: `${file} is empty.` };
  }
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    return {
      ok: false,
      name: file,
      reason: "too_large",
      message: `${file} is larger than ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB. Attach the relevant pages, or put the whole thing on the engagement it belongs to.`,
    };
  }

  const type = (mediaType || "").toLowerCase();
  const isPdf = type.startsWith("application/pdf") || /^%PDF-/.test(bytes.subarray(0, 5).toString("latin1"));

  if (isPdf) {
    const text = pdfText(bytes);
    if (!text.trim()) {
      return {
        ok: false,
        name: file,
        reason: "unreadable_pdf",
        message: `I could not find any text in ${file} — it is probably a scan or an image. Paste the part you want me to read, or attach a text / spreadsheet version.`,
      };
    }
    return clipped(file, text);
  }

  // Spreadsheets (XLSX = zip of XML). Same bound as PDF: first sheets only, capped characters.
  if (
    type.includes("spreadsheet") ||
    type.includes("excel") ||
    /\.xlsx$/i.test(file) ||
    (bytes[0] === 0x50 && bytes[1] === 0x4b && /\.xlsx$/i.test(file))
  ) {
    const text = xlsxText(bytes);
    if (!text.trim()) {
      return {
        ok: false,
        name: file,
        reason: "unsupported",
        message: `I could not read cells from ${file}. Save a CSV of the sheet that matters, or paste the rows.`,
      };
    }
    return clipped(file, text);
  }

  // DOCX — same OOXML zip idea; body text only, no track-changes farm.
  if (type.includes("wordprocessingml") || /\.docx$/i.test(file)) {
    const text = docxText(bytes);
    if (!text.trim()) {
      return {
        ok: false,
        name: file,
        reason: "unsupported",
        message: `I could not find text in ${file}. Export as PDF or paste the paragraphs that matter.`,
      };
    }
    return clipped(file, text);
  }

  if (type.startsWith("image/") || /\.(png|jpe?g|gif|webp|tiff?)$/i.test(file)) {
    return {
      ok: false,
      name: file,
      reason: "unreadable_image",
      message: `I cannot read text out of images yet. Paste what ${file} says, or attach a PDF/CSV that already has the text.`,
    };
  }

  if (TEXTUAL.test(type) || TEXTUAL_EXT.test(file)) {
    const text = bytes.toString("utf8");
    // A binary mislabelled as text decodes to replacement characters. Better to refuse than to feed
    // a model four thousand U+FFFD and let it hallucinate a shape onto the noise.
    const junk = (text.match(/�/g) ?? []).length;
    if (junk > Math.max(16, text.length * 0.02)) {
      return { ok: false, name: file, reason: "unsupported", message: `${file} does not look like text.` };
    }
    return clipped(file, text);
  }

  return {
    ok: false,
    name: file,
    reason: "unsupported",
    message: `I can read text, CSV, PDF, XLSX and DOCX. ${file} is none of those — export it as one of those, or paste the part that matters.`,
  };
}

function clipped(name: string, raw: string): Extracted {
  const text = normalise(raw);
  if (!text) return { ok: false, name, reason: "empty", message: `${name} has no readable text in it.` };
  return {
    ok: true,
    name,
    text: text.slice(0, MAX_TEXT_CHARS),
    chars: text.length,
    truncated: text.length > MAX_TEXT_CHARS,
  };
}

/** Collapse the whitespace a PDF's layout leaves behind; strip control bytes. */
const normalise = (s: string): string =>
  s
    .replace(/\r\n?/g, "\n")
    // Control bytes, tab and newline excepted. A PDF's own operators leave these behind and they
    // read as garbage in a fact list.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

// ── PDF ──────────────────────────────────────────────────────────────────────────────────────────
//
// A DELIBERATELY SMALL READER, and the smallness is the feature.
//
// The files this actually has to handle are invoices, statements, contracts and quotes — machine-
// generated PDFs whose content streams are Flate-compressed and whose text is in plain `Tj`/`TJ`
// operators. That is a couple of hundred lines of well-understood parsing. The alternative was a
// dependency that handles every PDF ever written, which is also a dependency that handles every
// malformed PDF ever written, on the request path of a session-authenticated surface.
//
// So this reads what it can read and says so when it cannot. A scan comes back `unreadable_pdf` with
// a sentence, and that is a better product than a silent empty answer AND a smaller attack surface
// than a full parser. `attachments.test.ts` pins both directions.

/** Streams inspected. A 500-page PDF is not a chat attachment; the first slice carries the point. */
const MAX_STREAMS = 60;

function pdfText(bytes: Buffer): string {
  const out: string[] = [];
  let taken = 0;
  const latin = bytes.toString("latin1");
  const re = /stream\r?\n?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(latin)) && taken < MAX_STREAMS) {
    const start = m.index + m[0].length;
    const end = latin.indexOf("endstream", start);
    if (end < 0) break;
    re.lastIndex = end;
    const raw = bytes.subarray(start, end);
    if (raw.byteLength === 0 || raw.byteLength > MAX_ATTACHMENT_BYTES) continue;
    const body = inflate(raw) ?? raw;
    // Only content streams have text operators. Fonts, images and metadata are skipped by this test
    // rather than by trusting a `/Filter` declaration we would have to parse to find.
    if (!/\bT[Jj]\b/.test(body.toString("latin1").slice(0, 4096)) && !/\bT[Jj]\b/.test(body.toString("latin1"))) continue;
    taken++;
    out.push(textOps(body.toString("latin1")));
    if (out.join(" ").length > MAX_TEXT_CHARS * 4) break;
  }
  return out.join("\n");
}

function inflate(raw: Buffer): Buffer | undefined {
  for (const fn of [inflateSync, inflateRawSync]) {
    try {
      return fn(raw);
    } catch {
      /* not this one */
    }
  }
  return undefined;
}

/**
 * Pull the strings out of a content stream's text operators.
 *
 * `(...) Tj` is one string. `[(a) -250 (b)] TJ` is a kerned run whose pieces are one word. A `TD`,
 * `Td`, `T*` or `ET` between them is a line break, which is what makes an extracted invoice readable
 * as rows rather than as one four-thousand-character sentence.
 */
function textOps(s: string): string {
  const out: string[] = [];
  let line: string[] = [];
  const flush = () => {
    if (line.length) out.push(line.join("").replace(/[ \t]{2,}/g, " ").trim());
    line = [];
  };
  const re = /\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]*>|\bT[Jj]\b|\bT[Dd*]\b|\bET\b/g;
  let m: RegExpExecArray | null;
  const pending: string[] = [];
  while ((m = re.exec(s))) {
    const tok = m[0];
    if (tok.startsWith("(")) pending.push(pdfString(tok.slice(1, -1)));
    else if (tok.startsWith("<")) pending.push(hexString(tok.slice(1, -1)));
    else if (tok === "Tj" || tok === "TJ") {
      line.push(pending.splice(0).join(""));
    } else {
      pending.length = 0;
      flush();
    }
  }
  flush();
  return out.filter(Boolean).join("\n");
}

const ESCAPES: Record<string, string> = { n: "\n", r: "\n", t: "\t", b: "", f: "", "(": "(", ")": ")", "\\": "\\" };

function pdfString(s: string): string {
  return s.replace(/\\([0-7]{1,3}|.)/gs, (_, e: string) =>
    /^[0-7]{1,3}$/.test(e) ? String.fromCharCode(parseInt(e, 8)) : (ESCAPES[e] ?? e),
  );
}

/** `<48656C6C6F>`. UTF-16BE when it opens with a BOM, otherwise byte-per-pair. */
function hexString(s: string): string {
  const h = s.replace(/\s+/g, "");
  const pairs = h.match(/.{1,2}/g) ?? [];
  const bytes = Buffer.from(pairs.map((p) => parseInt(p.padEnd(2, "0"), 16)));
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return utf16be(bytes.subarray(2));
  return bytes.toString("latin1");
}

/** Node has no UTF-16BE decoder, and a PDF has no UTF-16LE. Swap, then decode. */
function utf16be(b: Buffer): string {
  const swapped = Buffer.from(b.subarray(0, b.length - (b.length % 2)));
  swapped.swap16();
  return swapped.toString("utf16le");
}

// ── OOXML (XLSX / DOCX) ──────────────────────────────────────────────────────────────────────────
//
// Same argument as the PDF reader: a dependency that "handles Excel" is a decompression-bomb farm
// on a chat upload door. XLSX/DOCX are ZIP containers of XML. We walk local file headers only,
// inflate known paths, and stop. Encrypted workbooks, macros, and charts are out of scope — refuse
// by returning empty and letting extractText name the next step.

const MAX_ZIP_ENTRIES = 80;
const MAX_XLSX_SHEETS = 4;

/** Pull one stored/deflated entry from a ZIP by exact path. Returns undefined if missing/corrupt. */
function zipEntry(bytes: Buffer, path: string): Buffer | undefined {
  // Local file header: PK\x03\x04
  let i = 0;
  let seen = 0;
  while (i + 30 < bytes.length && seen < MAX_ZIP_ENTRIES) {
    if (bytes[i] !== 0x50 || bytes[i + 1] !== 0x4b || bytes[i + 2] !== 0x03 || bytes[i + 3] !== 0x04) {
      // Central directory or trailing junk — stop scanning.
      break;
    }
    seen++;
    const method = bytes.readUInt16LE(i + 8);
    const compSize = bytes.readUInt32LE(i + 18);
    const nameLen = bytes.readUInt16LE(i + 26);
    const extraLen = bytes.readUInt16LE(i + 28);
    const nameStart = i + 30;
    const name = bytes.subarray(nameStart, nameStart + nameLen).toString("utf8");
    const dataStart = nameStart + nameLen + extraLen;
    const dataEnd = dataStart + compSize;
    if (dataEnd > bytes.length) return undefined;
    if (name === path) {
      const raw = bytes.subarray(dataStart, dataEnd);
      if (method === 0) return Buffer.from(raw);
      if (method === 8) {
        try {
          return inflateRawSync(raw);
        } catch {
          return undefined;
        }
      }
      return undefined;
    }
    i = dataEnd;
  }
  return undefined;
}

/** Cap for the inspector grid — enough to review, not a data warehouse dump. */
const MAX_SHEET_ROWS = 100;
const MAX_SHEET_COLS = 40;

/**
 * Spreadsheet → capped cell grid for the deliverable inspector.
 *
 * Same parser as `xlsxText`, shaped for a table UI rather than a prose paste. Truncation is reported
 * so the inspector can say "showing first 100 rows" instead of implying the file is small.
 */
export function xlsxGrid(bytes: Buffer): { sheets: { name: string; rows: string[][] }[]; truncated: boolean } {
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return { sheets: [], truncated: false };
  const sharedXml = zipEntry(bytes, "xl/sharedStrings.xml")?.toString("utf8") ?? "";
  const shared = [...sharedXml.matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((m) => decodeXml(m[1]));
  const sheets: { name: string; rows: string[][] }[] = [];
  let truncated = false;
  for (let n = 1; n <= MAX_XLSX_SHEETS; n++) {
    const sheet = zipEntry(bytes, `xl/worksheets/sheet${n}.xml`)?.toString("utf8");
    if (!sheet) break;
    const rowsXml = sheet.match(/<row\b[^>]*>[\s\S]*?<\/row>/g) ?? [];
    const rows: string[][] = [];
    for (const row of rowsXml) {
      if (rows.length >= MAX_SHEET_ROWS) {
        truncated = true;
        break;
      }
      const cells: string[] = [];
      for (const cell of row.match(/<c\b[^>]*>[\s\S]*?<\/c>|<c\b[^>]*\/>/g) ?? []) {
        if (cells.length >= MAX_SHEET_COLS) {
          truncated = true;
          break;
        }
        const t = /\bt="([^"]+)"/.exec(cell)?.[1];
        const v = /<v>([^<]*)<\/v>/.exec(cell)?.[1];
        if (v === undefined) {
          cells.push("");
          continue;
        }
        if (t === "s") {
          const idx = Number(v);
          cells.push(Number.isFinite(idx) ? (shared[idx] ?? "") : "");
        } else if (t === "inlineStr") {
          const inline = /<t[^>]*>([^<]*)<\/t>/.exec(cell)?.[1];
          cells.push(decodeXml(inline ?? ""));
        } else {
          cells.push(decodeXml(v));
        }
      }
      if (cells.some((c) => c.trim())) rows.push(cells);
    }
    if (rows.length) sheets.push({ name: `Sheet ${n}`, rows });
  }
  return { sheets, truncated };
}

function xlsxText(bytes: Buffer): string {
  const { sheets } = xlsxGrid(bytes);
  const lines: string[] = [];
  for (const sheet of sheets) {
    for (const row of sheet.rows) {
      const line = row.join("\t").trimEnd();
      if (line.trim()) lines.push(line);
      if (lines.join("\n").length > MAX_TEXT_CHARS * 4) break;
    }
  }
  return lines.join("\n");
}

export function docxText(bytes: Buffer): string {
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return "";
  const xml = zipEntry(bytes, "word/document.xml")?.toString("utf8") ?? "";
  if (!xml) return "";
  // Paragraphs → newlines; runs concatenated. Drop w:instrText (fields) noise lightly.
  const paras = xml.match(/<w:p[\s>][\s\S]*?<\/w:p>/g) ?? [];
  const lines: string[] = [];
  for (const p of paras) {
    const parts = [...p.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => decodeXml(m[1]));
    const line = parts.join("").trim();
    if (line) lines.push(line);
    if (lines.join("\n").length > MAX_TEXT_CHARS * 4) break;
  }
  return lines.join("\n");
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
