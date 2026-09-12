// A workbook a client opens, written by hand.
//
// The complaint underneath this: a client paying £400 a month received their monthly close as a PDF
// and a CSV. Both correct. A CSV is a text file with commas in it — their accountant imports it and
// nobody opens it twice — so the work arrived looking like an export because it was shipped like one.
//
// There is no xlsx library in this repo and there is not going to be. `pdf.ts` already made the
// argument: the piece of a library we would actually use is a few hundred lines and the rest is
// opinions. An xlsx is a ZIP of XML, and Node ships `deflateRawSync` and `crc32`.
//
// These tests read the bytes back as a ZIP and parse every part, because "it produced a file" is not
// the claim — the claim is that Excel opens it.
import test from "node:test";
import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import { colName, renderWorkbook } from "../src/render/xlsx";

/** Read a named entry out of the container, so the tests assert on what a reader would see. */
function readZip(bytes: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  // Walk the local file headers. Enough of the format to verify ours, and it fails loudly on the
  // signature if we ever write a malformed one.
  let i = 0;
  while (i + 30 <= bytes.length && bytes.readUInt32LE(i) === 0x04034b50) {
    const method = bytes.readUInt16LE(i + 8);
    const compSize = bytes.readUInt32LE(i + 18);
    const nameLen = bytes.readUInt16LE(i + 26);
    const extraLen = bytes.readUInt16LE(i + 28);
    const name = bytes.subarray(i + 30, i + 30 + nameLen).toString("utf8");
    const start = i + 30 + nameLen + extraLen;
    const raw = bytes.subarray(start, start + compSize);
    // Raw deflate, not zlib-wrapped — the ZIP format stores the deflate stream bare.
    out.set(name, method === 8 ? inflateRawSync(raw).toString("utf8") : raw.toString("utf8"));
    i = start + compSize;
  }
  return out;
}

const WB = {
  currency: "GBP",
  sheets: [
    {
      name: "Ledger",
      note: "The bank statement was not supplied.",
      header: ["Date", "Amount", "Description"],
      rows: [
        [
          { kind: "d" as const, v: "2026-07-04" },
          { kind: "n" as const, v: -1280, format: "money" as const },
          { kind: "s" as const, v: "Studio rent, July" },
        ],
        [
          { kind: "d" as const, v: "not a date" },
          { kind: "n" as const, v: 4800, format: "money" as const },
          { kind: "s" as const, v: 'He said "no"' },
        ],
      ],
    },
  ],
};

test("the bytes are a valid ZIP whose every part is well-formed XML", () => {
  const doc = renderWorkbook(WB);
  assert.equal(doc.content_type, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  const bytes = Buffer.from(doc.content, "base64");
  assert.equal(doc.size_bytes, bytes.length);
  // PK\003\004 — if this is wrong, nothing downstream matters.
  assert.equal(bytes.readUInt32LE(0), 0x04034b50);

  const parts = readZip(bytes);
  for (const required of [
    "[Content_Types].xml",
    "_rels/.rels",
    "xl/workbook.xml",
    "xl/_rels/workbook.xml.rels",
    "xl/styles.xml",
    "xl/worksheets/sheet1.xml",
  ]) {
    assert.ok(parts.has(required), `missing ${required}`);
  }
  // Cheap well-formedness: every part starts with a declaration and has balanced angle brackets in
  // the sense that no raw `&` survived escaping. A malformed part is a workbook that will not open.
  for (const [name, xml] of parts) {
    assert.match(xml, /^<\?xml version="1\.0"/, `${name} has no XML declaration`);
    assert.equal(/&(?!amp;|lt;|gt;|quot;|apos;|#)/.test(xml), false, `${name} has an unescaped ampersand`);
  }
});

test("a value with a quote or a comma survives into the cell", () => {
  // The CSV failure this format does not have — but only because the escaping is right.
  const parts = readZip(Buffer.from(renderWorkbook(WB).content, "base64"));
  const sheet = parts.get("xl/worksheets/sheet1.xml")!;
  assert.match(sheet, /Studio rent, July/);
  assert.match(sheet, /He said &quot;no&quot;/);
});

test("dates become Excel serials, and an unparseable one stays text rather than a wrong number", () => {
  const sheet = readZip(Buffer.from(renderWorkbook(WB).content, "base64")).get("xl/worksheets/sheet1.xml")!;
  // 2026-07-04. The epoch is 1899-12-30, not 1900-01-01: Lotus believed 1900 was a leap year, Excel
  // copied the bug, and getting it wrong puts every date in a client's ledger two days out.
  const serial = Math.floor(Date.UTC(2026, 6, 4) / 86_400_000) + 25_569;
  assert.match(sheet, new RegExp(`<v>${serial}</v>`));
  // "not a date" must not silently become a number.
  assert.match(sheet, /<t>not a date<\/t>/);
});

test("the header row is frozen and money carries a currency format", () => {
  const parts = readZip(Buffer.from(renderWorkbook(WB).content, "base64"));
  const sheet = parts.get("xl/worksheets/sheet1.xml")!;
  // A note occupies row 1, blank row 2, header row 3 — so the freeze is below row 3.
  assert.match(sheet, /ySplit="3"/);
  assert.match(sheet, /state="frozen"/);
  assert.match(sheet, /<autoFilter/);
  // The currency symbol is in the number format, so the column sums as money rather than as text
  // that looks like money — which is the entire reason to ship a workbook instead of a CSV.
  assert.match(parts.get("xl/styles.xml")!, /&quot;£&quot;#,##0\.00/);
});

test("sheet names Excel refuses are made safe rather than producing a file that will not open", () => {
  const doc = renderWorkbook({
    sheets: [
      { name: "P&L: 2026/07 [draft]", header: ["a"], rows: [[{ kind: "s", v: "x" }]] },
      { name: "", header: ["a"], rows: [[{ kind: "s", v: "x" }]] },
      { name: "x".repeat(60), header: ["a"], rows: [[{ kind: "s", v: "x" }]] },
    ],
  });
  const names = [...readZip(Buffer.from(doc.content, "base64")).get("xl/workbook.xml")!.matchAll(/name="([^"]*)"/g)].map(
    (m) => m[1]!,
  );
  assert.equal(names[0], "P&amp;L  2026 07  draft", "colon, slash and brackets are stripped, not passed through");
  assert.equal(names[1], "Sheet2", "an empty name gets a real one");
  assert.equal(names[2]!.length, 31, "Excel's 31-character cap");
});

test("column letters run past Z", () => {
  assert.equal(colName(0), "A");
  assert.equal(colName(25), "Z");
  assert.equal(colName(26), "AA");
  assert.equal(colName(51), "AZ");
  assert.equal(colName(52), "BA");
});

test("a workbook with no sheets is refused rather than written empty", () => {
  assert.throws(() => renderWorkbook({ sheets: [] }), /at least one sheet/);
});

test("identical figures produce identical bytes", () => {
  // Timestamps are pinned rather than taken from the clock, so a diff between two months shows what
  // changed in the numbers and a rebuilt artifact does not look like a new one.
  assert.equal(renderWorkbook(WB).content, renderWorkbook(WB).content);
});
