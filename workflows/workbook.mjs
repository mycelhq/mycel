// A real spreadsheet, for any trade — not just the one that happened to need it first.
//
// ═══ WHY THIS IS SHARED AND NOT A SECOND `close_figures` ═══
//
// `render/xlsx.ts` writes a genuine Excel workbook by hand, and its header records the complaint it
// was built for: "a client paying £400 a month received a monthly close as a PDF and a CSV. Both
// correct. A CSV is a text file with commas in it — their accountant imports it, and nobody else
// opens it twice. The work looked like an export because it was shipped like one."
//
// That complaint is not about bookkeeping. A recruiter's screened longlist, a GEO agency's ranking
// table, a studio's budget, a security packet's control matrix — every one of them is a grid a
// client will want to sort, filter and hand to somebody else. All of them shipped as CSV or as a
// table flattened into prose.
//
// The kernel already renders a workbook for ANY workflow whose result carries `workbook` —
// `/v1/internal/workflows/:name` does it generically, stores the file and attaches it to the
// delivery without the model having to remember. Only `close_figures` ever returned one, because
// only `books-keeper` had a reason to write the plumbing. This is that plumbing, with the
// bookkeeping taken out.
//
// ═══ WHAT IT DOES NOT DO ═══
//
// No arithmetic. `close_figures` computes a reconciliation and OWNS those numbers, which is why its
// skill says never do the sums yourself. This one is a formatter: the caller has already decided
// what is true and this decides how Excel is told about it. Mixing the two would produce a workflow
// that silently re-totals somebody's column.
//
// No currency default. Same rule as the renderer: an absent currency formats as a plain number,
// which is honest, rather than as somebody else's money.
const KINDS = new Set(["s", "n", "d"]);
const FORMATS = new Set(["plain", "money", "pct", "int"]);

/** A loose cell from the model, coerced to the renderer's contract. */
function cell(raw) {
  if (raw === null || raw === undefined) return { kind: "s", v: "" };
  if (typeof raw === "number" && Number.isFinite(raw)) return { kind: "n", v: raw };
  if (typeof raw !== "object") return { kind: "s", v: String(raw) };
  const kind = KINDS.has(raw.kind) ? raw.kind : undefined;
  if (kind === "n") {
    const v = typeof raw.v === "number" ? raw.v : Number(raw.v);
    if (!Number.isFinite(v)) return { kind: "s", v: String(raw.v ?? "") };
    const format = FORMATS.has(raw.format) ? raw.format : undefined;
    return format ? { kind: "n", v, format } : { kind: "n", v };
  }
  if (kind === "d") return { kind: "d", v: String(raw.v ?? "") };
  return { kind: "s", v: String(raw.v ?? "") };
}

export default async function workbook(args) {
  const tabs = Array.isArray(args?.tabs) ? args.tabs : [];
  if (!tabs.length) return { ok: false, error: "a workbook needs at least one tab" };

  const sheets = [];
  for (const t of tabs) {
    const header = Array.isArray(t?.header) ? t.header.map((h) => String(h)) : [];
    if (!header.length) return { ok: false, error: `tab "${t?.name ?? "?"}" has no header row` };
    const rows = Array.isArray(t?.rows) ? t.rows : [];
    sheets.push({
      name: String(t?.name ?? `Sheet${sheets.length + 1}`),
      header,
      // Padded to the header, never clipped short: a row with a missing trailing cell is a small
      // mistake in one row, and dropping it loses a client's number.
      rows: rows.map((r) => {
        const cells = (Array.isArray(r) ? r : [r]).map(cell);
        while (cells.length < header.length) cells.push({ kind: "s", v: "" });
        return cells.slice(0, header.length);
      }),
      ...(t?.note ? { note: String(t.note) } : {}),
    });
  }

  const currency =
    typeof args?.currency === "string" && /^[A-Za-z]{3}$/.test(args.currency.trim())
      ? args.currency.trim().toUpperCase()
      : undefined;

  return {
    ok: true,
    // The kernel renders and attaches this. See `/v1/internal/workflows/:name`.
    workbook: { sheets, ...(currency ? { currency } : {}), ...(args?.filename ? { filename: String(args.filename) } : {}) },
    sheets: sheets.length,
    rows: sheets.reduce((n, s) => n + s.rows.length, 0),
  };
}
