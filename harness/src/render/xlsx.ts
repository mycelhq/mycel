// A real Excel workbook, written by hand. No dependency.
//
// ═══ WHY THIS, AND WHY NOT A LIBRARY ═══
//
// The complaint that started it: a client paying £400 a month received a monthly close as a PDF and
// a CSV. Both correct. A CSV is a text file with commas in it — their accountant imports it, and
// nobody else opens it twice. The work looked like an export because it was shipped like one.
//
// `pdf.ts` already made this argument and took the same road: the piece of a library we would
// actually use is a few hundred lines, and the rest is layout opinions and a font pipeline we do not
// want. An xlsx is a ZIP of XML — five small documents and a container — and Node ships
// `zlib.deflateRawSync` and `zlib.crc32`, which is the whole of the hard part.
//
// What we buy by owning it: a workbook with a tab per schedule, a bold frozen header row, real
// currency formats so a column of money right-aligns and sorts as money, and column widths that fit
// the content. That is the difference between "they sent me a spreadsheet" and "they sent me a
// file". What we give up: formulas, pivot tables, conditional formatting, charts inside the
// workbook. None of those are things a client asked for, and the chart belongs on page one of the
// PDF where they will actually look at it.
//
// If a future artifact needs formulas, the seam is `Cell.formula` — one more attribute on the `<c>`
// element and a `<f>` child. It is deliberately not built until something needs it.

// The ZIP container moved to `ooxml.ts` when `docx.ts` needed the same one. Same function,
// same bytes, no format knowledge in it — see the note at the top of that file.
import { zip } from "./ooxml";
import { sheetFindings, type TasteFinding } from "./taste";

/** A cell. `n` sorts and sums as a number in Excel; `s` is text; `d` renders as a date. */
export type Cell =
  | { kind: "s"; v: string }
  | { kind: "n"; v: number; format?: "plain" | "money" | "pct" | "int" }
  | { kind: "d"; v: string };

export interface Sheet {
  /** Tab name. Excel forbids : \ / ? * [ ] and caps at 31 characters — both enforced below. */
  name: string;
  /** The header row. Bold, frozen, and what the column widths are measured against. */
  header: string[];
  rows: Cell[][];
  /** A note rendered above the header, for a caveat that must be read before the numbers. */
  note?: string;
}

export interface Workbook {
  sheets: Sheet[];
  /** ISO-4217, for the money format. One currency per workbook: a mixed one is a bug, not a feature. */
  currency?: string;
}

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);

/** Excel's column letters. 0 → A, 25 → Z, 26 → AA. */
export function colName(i: number): string {
  let n = i + 1;
  let out = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - r) / 26);
  }
  return out;
}

/**
 * Excel's serial date: days since 1899-12-30.
 *
 * Not 1900-01-01, and the two-day gap is not a rounding error — Lotus 1-2-3 believed 1900 was a leap
 * year, Excel copied the bug for compatibility, and every spreadsheet since has counted from a day
 * that did not exist. Getting this wrong puts every date in a client's ledger two days out.
 */
function serialDate(iso: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso.trim());
  if (!m) return undefined;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Math.floor(ms / 86_400_000) + 25_569;
}

/** Excel rejects these outright, and a workbook that will not open is worse than a CSV. */
const safeSheetName = (name: string, i: number): string => {
  const cleaned = name.replace(/[:\\/?*[\]]/g, " ").trim().slice(0, 31);
  return cleaned || `Sheet${i + 1}`;
};

const STYLE = { plainHeader: 1, money: 2, date: 3, pct: 4, int: 5 } as const;

/**
 * The style table. Index 0 is the default Excel requires; ours start at 1.
 *
 * `numFmtId` 164+ is the custom range. The money format carries the currency symbol so a column
 * right-aligns and sums as money rather than as text that looks like money — which is the entire
 * reason to ship a workbook rather than a CSV.
 */
function stylesXml(currency: string): string {
  // Unknown or absent formats as a plain number. Excel shows the column right-aligned and summing
  // correctly either way; what it must never do is show dollars for pounds.
  const sym = { GBP: "£", USD: "$", EUR: "€", JPY: "¥", INR: "₹" }[currency.toUpperCase()] ?? "";
  const moneyFmt = `${sym ? `&quot;${sym}&quot;` : ""}#,##0.00;[Red]-${sym ? `&quot;${sym}&quot;` : ""}#,##0.00`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2"><numFmt numFmtId="164" formatCode="${moneyFmt}"/><numFmt numFmtId="165" formatCode="yyyy-mm-dd"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF2F2F2"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FFBFBFBF"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="6">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="10" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
}

function sheetXml(sheet: Sheet): string {
  const offset = sheet.note ? 2 : 0; // The note, then a blank line, then the header.
  const rows: string[] = [];

  if (sheet.note) {
    rows.push(`<row r="1"><c r="A1" t="inlineStr"><is><t>${esc(sheet.note)}</t></is></c></row>`);
  }

  const headerRow = offset + 1;
  rows.push(
    `<row r="${headerRow}">` +
      sheet.header
        .map((h, i) => `<c r="${colName(i)}${headerRow}" s="${STYLE.plainHeader}" t="inlineStr"><is><t>${esc(h)}</t></is></c>`)
        .join("") +
      `</row>`,
  );

  sheet.rows.forEach((row, ri) => {
    const r = headerRow + 1 + ri;
    const cells = row
      .map((cell, ci) => {
        const ref = `${colName(ci)}${r}`;
        if (cell.kind === "s") {
          return cell.v === "" ? "" : `<c r="${ref}" t="inlineStr"><is><t>${esc(cell.v)}</t></is></c>`;
        }
        if (cell.kind === "d") {
          const serial = serialDate(cell.v);
          // An unparseable date stays TEXT rather than becoming a wrong number. A date silently two
          // days out is worse than a date that is obviously a string.
          return serial === undefined
            ? `<c r="${ref}" t="inlineStr"><is><t>${esc(cell.v)}</t></is></c>`
            : `<c r="${ref}" s="${STYLE.date}"><v>${serial}</v></c>`;
        }
        if (!Number.isFinite(cell.v)) return "";
        const s =
          cell.format === "money"
            ? STYLE.money
            : cell.format === "pct"
              ? STYLE.pct
              : cell.format === "int"
                ? STYLE.int
                : 0;
        return `<c r="${ref}"${s ? ` s="${s}"` : ""}><v>${cell.v}</v></c>`;
      })
      .join("");
    rows.push(`<row r="${r}">${cells}</row>`);
  });

  // Widths from the content, capped: a 200-character description must not push the money column off
  // the screen, which is the first thing a reader looks for.
  const widths = sheet.header.map((h, i) => {
    const longest = Math.max(
      String(h).length,
      ...sheet.rows.map((r) => {
        const c = r[i];
        if (!c) return 0;
        return c.kind === "s" ? c.v.length : c.kind === "d" ? 10 : String(c.v).length + 3;
      }),
    );
    return Math.min(Math.max(longest + 2, 9), 46);
  });

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="${headerRow}" topLeftCell="A${headerRow + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>
<sheetData>${rows.join("")}</sheetData>
<autoFilter ref="A${headerRow}:${colName(sheet.header.length - 1)}${headerRow + sheet.rows.length}"/>
</worksheet>`;
}



/**
 * A workbook, as bytes.
 *
 * Base64 rather than a Buffer at the boundary because every artifact in this system is stored and
 * moved as a base64 string with an `encoding` — the same road `render/pdf.ts` takes — and returning
 * a Buffer here would make this the one renderer whose output needs special handling.
 */
export function renderWorkbook(wb: Workbook): {
  content: string;
  encoding: "base64";
  content_type: string;
  size_bytes: number;
  /**
   * What is wrong with how it reads — see `taste.ts`. Attached, never thrown: the same posture the
   * PDF renderer takes, because the caller owns the consequence and a delivery that dies inside the
   * renderer is worse than one that arrives with a note on it.
   */
  taste: TasteFinding[];
} {
  /**
   * No default. A workbook whose money column silently carries the wrong symbol is worse than one
   * with none — see the note on `money` in `workflows/_figures.mjs`. An absent currency formats as a
   * plain number, which is honest, rather than as somebody else's money.
   */
  const currency = (wb.currency ?? "").trim().toUpperCase();
  const sheets = wb.sheets.map((s, i) => ({ ...s, name: safeSheetName(s.name, i) }));
  if (!sheets.length) throw new Error("a workbook needs at least one sheet");

  const files = [
    {
      name: "[Content_Types].xml",
      xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${sheets.map((_s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("\n")}
</Types>`,
    },
    {
      name: "_rels/.rels",
      xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
    },
    {
      name: "xl/workbook.xml",
      xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets>
</workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets.map((_s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("\n")}
<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
    },
    { name: "xl/styles.xml", xml: stylesXml(currency) },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, xml: sheetXml(s) })),
  ];

  const bytes = zip(files);
  return {
    content: bytes.toString("base64"),
    encoding: "base64",
    content_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    size_bytes: bytes.length,
    // Linted against the SAFE sheet names, so a finding names the tab the reader will actually see.
    taste: sheetFindings({ ...wb, sheets }),
  };
}
