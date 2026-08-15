// Safe in-product PREVIEW of an artifact — never a dump of binary, never executable HTML on our origin.
//
// ═══ WHY THIS IS A SEPARATE DOOR FROM `serveArtifact` ═══
//
// Downloads always force `Content-Disposition: attachment` and rewrite HTML/SVG to octet-stream so
// an uploaded file cannot execute on the kernel's (or Cloud's) origin. That is correct for download
// and useless for an inspector: a browser that is told "attachment" will not render a PDF in a pane.
//
// So preview is a second route with a strict allowlist. Anything not on it refuses with a sentence
// and the UI falls back to download. SVG / XML are never previewable — they are the XSS class.
// HTML is previewable ONLY as JSON the inspector puts in a sandboxed iframe (srcdoc, empty sandbox)
// — it is never served as `text/html` from this origin. Spreadsheets and CSV return a capped cell
// grid as JSON. Markdown returns text the inspector renders; it is never interpreted as HTML here.
import type { Artifact } from "./contract";
import { docxText, xlsxGrid } from "./attachments";

/** How the inspector should treat this file. Computed from type + name, never from trust of the client. */
export type PreviewMode = "inline" | "sheet" | "text" | "docx" | "html" | "markdown" | "none";

const INLINE =
  /^(application\/pdf|image\/(png|jpeg|jpg|gif|webp))$/i;
const TEXTUAL =
  /^(text\/plain|text\/csv|text\/tab-separated-values|application\/json|application\/x-ndjson|text\/yaml|application\/yaml)$/i;
const SHEET =
  /(spreadsheet|excel|application\/vnd\.openxmlformats-officedocument\.spreadsheetml)/i;
const DOCX =
  /(wordprocessingml|application\/msword|application\/vnd\.openxmlformats-officedocument\.wordprocessingml)/i;
const HTML_TYPE = /^(text\/html|application\/xhtml)/i;
const MARKDOWN_TYPE = /^text\/markdown/i;
const CSV_TYPE = /^(text\/csv|text\/tab-separated-values|application\/csv)/i;
const SVG_XML = /^(image\/svg\+xml|text\/xml|application\/xml)/i;
const SHEET_EXT = /\.(xlsx|csv|tsv)$/i;
const DOCX_EXT = /\.(docx|doc)$/i;
const TEXT_EXT = /\.(txt|json|ndjson|log|yaml|yml)$/i;
const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|java|kt|swift|c|cc|cpp|h|hpp|cs|php|sql|sh|bash|zsh|css|scss|less|vue|svelte|toml|ini|env|lock|gradle)$/i;
const HTML_EXT = /\.(html?|xhtml)$/i;
const MD_EXT = /\.(md|markdown)$/i;
const CSV_EXT = /\.(csv|tsv)$/i;

const MAX_SHEET_ROWS = 100;
const MAX_SHEET_COLS = 40;
const MAX_TEXT_CHARS = 200_000;

export function previewMode(contentType: string, name: string): PreviewMode {
  const type = (contentType || "").toLowerCase();
  const file = name || "";
  if (SVG_XML.test(type) || /\.svg$/i.test(file)) return "none";
  if (HTML_TYPE.test(type) || HTML_EXT.test(file)) return "html";
  if (INLINE.test(type) || /\.pdf$/i.test(file) || /\.(png|jpe?g|gif|webp)$/i.test(file)) return "inline";
  if (SHEET.test(type) || /\.xlsx$/i.test(file)) return "sheet";
  if (CSV_TYPE.test(type) || CSV_EXT.test(file)) return "sheet";
  if (DOCX.test(type) || DOCX_EXT.test(file)) return "docx";
  if (MARKDOWN_TYPE.test(type) || MD_EXT.test(file)) return "markdown";
  if (TEXTUAL.test(type) || TEXT_EXT.test(file) || CODE_EXT.test(file)) return "text";
  if (SHEET_EXT.test(file)) return "sheet";
  return "none";
}

/** Metadata the inspector needs without a second artifact round-trip. */
export function artifactFileMeta(a: Pick<Artifact, "id" | "name" | "content_type" | "size_bytes" | "encoding">) {
  const mode = previewMode(a.content_type, a.name);
  return {
    id: a.id,
    name: a.name,
    content_type: a.content_type,
    size_bytes: a.size_bytes ?? 0,
    encoding: a.encoding ?? "utf8",
    preview: mode,
  };
}

export type ArtifactFileMeta = ReturnType<typeof artifactFileMeta>;

export type PreviewResult =
  | { ok: true; kind: "bytes"; response: Response }
  | { ok: true; kind: "sheet"; body: { sheets: { name: string; rows: string[][] }[]; truncated: boolean } }
  | { ok: true; kind: "text"; body: { text: string; truncated: boolean; name: string } }
  | { ok: true; kind: "docx"; body: { text: string; truncated: boolean; name: string } }
  | { ok: true; kind: "markdown"; body: { text: string; truncated: boolean; name: string } }
  | { ok: true; kind: "html"; body: { html: string; truncated: boolean; name: string } }
  | { ok: false; status: 415 | 422; error: string };

function artifactBytes(a: Artifact): Buffer {
  return a.encoding === "base64" ? Buffer.from(a.content ?? "", "base64") : Buffer.from(a.content ?? "", "utf8");
}

function capText(text: string): { text: string; truncated: boolean } {
  const truncated = text.length > MAX_TEXT_CHARS;
  return { text: truncated ? text.slice(0, MAX_TEXT_CHARS) : text, truncated };
}

/**
 * CSV / TSV → capped cell grid. Quoted fields, doubled quotes, and mixed newlines.
 * Not a spreadsheet engine — enough to review a client export without dumping the file as prose.
 */
export function csvGrid(text: string, name = "Sheet"): { sheets: { name: string; rows: string[][] }[]; truncated: boolean } {
  const delimiter = guessCsvDelimiter(text);
  const rows: string[][] = [];
  let truncated = false;
  for (const line of splitCsvRecords(text)) {
    if (rows.length >= MAX_SHEET_ROWS) {
      truncated = true;
      break;
    }
    const cells = parseCsvRecord(line, delimiter);
    if (cells.length > MAX_SHEET_COLS) truncated = true;
    rows.push(cells.slice(0, MAX_SHEET_COLS));
  }
  while (rows.length && rows[rows.length - 1]!.every((c) => !c.trim())) rows.pop();
  return { sheets: rows.length ? [{ name, rows }] : [], truncated };
}

function guessCsvDelimiter(text: string): "," | "\t" | ";" {
  const sample = text.slice(0, 4000);
  const tabs = (sample.match(/\t/g) ?? []).length;
  const semis = (sample.match(/;/g) ?? []).length;
  const commas = (sample.match(/,/g) ?? []).length;
  if (tabs > commas && tabs > semis) return "\t";
  if (semis > commas && semis > tabs) return ";";
  return ",";
}

/** Split on newlines that are not inside quotes. */
function splitCsvRecords(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"') {
      inQuotes = !inQuotes;
      cur += ch;
      continue;
    }
    if (!inQuotes && (ch === "\n" || ch === "\r")) {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.length) out.push(cur);
  return out;
}

function parseCsvRecord(line: string, delimiter: "," | "\t" | ";"): string[] {
  const cells: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (!inQuotes && ch === delimiter) {
      cells.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  cells.push(cur);
  return cells;
}

/**
 * HTML the inspector may put in a sandboxed iframe. Never served as text/html from this origin.
 *
 * Scripts stripped, event handlers stripped, a CSP meta injected. The iframe still uses
 * `sandbox=""` (no flags) — this is defence in depth, not the gate.
 */
export function sandboxHtmlDocument(raw: string): string {
  const csp =
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:;">`;
  const stripped = raw
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<script\b[^>]*>/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  if (/<head[\s>]/i.test(stripped)) return stripped.replace(/<head([^>]*)>/i, `<head$1>${csp}`);
  return `<!doctype html><html><head><meta charset="utf-8">${csp}</head><body>${stripped}</body></html>`;
}

/**
 * Build a preview for one artifact the caller has ALREADY authorised.
 *
 * Authorisation is deliberately not this function's job — founder vs portal release gates live at
 * the route. Passing an unreleased artifact here would still preview it; that is a caller bug.
 */
export function buildArtifactPreview(a: Artifact): PreviewResult {
  const mode = previewMode(a.content_type, a.name);
  if (mode === "none") {
    return {
      ok: false,
      status: 415,
      error: `we cannot preview "${a.name}" in the product — download it to open it in the right app`,
    };
  }

  const bytes = artifactBytes(a);

  if (mode === "sheet") {
    const asWorkbook = SHEET.test(a.content_type) || /\.xlsx$/i.test(a.name);
    const grid = asWorkbook
      ? xlsxGrid(bytes)
      : csvGrid(bytes.toString("utf8"), a.name.replace(/\.[^.]+$/, "") || "Sheet");
    if (!grid.sheets.length) {
      return { ok: false, status: 422, error: `we could not read any cells from "${a.name}"` };
    }
    return { ok: true, kind: "sheet", body: grid };
  }

  if (mode === "docx") {
    const text = docxText(bytes);
    if (!text.trim()) {
      return {
        ok: false,
        status: 422,
        error: `we could not read the text of "${a.name}" — download it to open it in Word`,
      };
    }
    const capped = capText(text);
    return { ok: true, kind: "docx", body: { ...capped, name: a.name } };
  }

  if (mode === "html") {
    const capped = capText(bytes.toString("utf8"));
    return {
      ok: true,
      kind: "html",
      body: { html: sandboxHtmlDocument(capped.text), truncated: capped.truncated, name: a.name },
    };
  }

  if (mode === "markdown") {
    const capped = capText(bytes.toString("utf8"));
    return { ok: true, kind: "markdown", body: { ...capped, name: a.name } };
  }

  if (mode === "text") {
    const capped = capText(bytes.toString("utf8"));
    return { ok: true, kind: "text", body: { ...capped, name: a.name } };
  }

  // inline — PDF / image. Real content-type, disposition inline, still sandboxed CSP.
  const type = SVG_XML.test(a.content_type) || HTML_TYPE.test(a.content_type)
    ? "application/octet-stream"
    : a.content_type || "application/octet-stream";
  return {
    ok: true,
    kind: "bytes",
    response: new Response(new Uint8Array(bytes), {
      headers: {
        "content-type": type,
        "content-disposition": `inline; filename="${a.name.replace(/["\r\n]/g, "")}"`,
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox; img-src 'self' blob: data:; object-src 'self'; style-src 'unsafe-inline'",
        "cache-control": "private, no-store",
      },
    }),
  };
}
