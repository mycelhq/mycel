// Reading a dropped file — the tests.
//
// attachments.ts is a parser on the request path of a session-authenticated surface, which is the
// most dangerous kind of code in a product. Three failures matter:
//
//   1. IT SWALLOWS THE FILE. A founder drags a statement onto the composer and nothing visible
//      happens. Every refusal must be NAMED and must carry a sentence saying what to do instead —
//      "your file did nothing" is the worst answer available here.
//   2. IT IS UNBOUNDED. Size, character count, stream count. A parser with no ceiling on a public
//      door is a denial of service with a nice icon.
//   3. IT PRETENDS. A scanned PDF has no text in it. Returning an empty string that then produces a
//      confident answer from the rest of the business — as though the document had been read — is
//      exactly the "plausible prose" vision.md refuses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_TEXT_CHARS,
  extractText,
  type Extracted,
} from "../src/attachments";

const ok = (e: Extracted) => {
  assert.equal(e.ok, true, e.ok ? "" : `${e.reason}: ${e.message}`);
  return e as Extract<Extracted, { ok: true }>;
};
const refused = (e: Extracted) => {
  assert.equal(e.ok, false, "expected a refusal");
  return e as Extract<Extracted, { ok: false }>;
};

/**
 * A minimal but REAL PDF: catalog, page, and a Flate-compressed content stream with text operators.
 *
 * Built rather than fixtured because the point is the shape of a machine-generated invoice — the
 * only kind of PDF this reader claims to handle — and a binary fixture in the repo would be a thing
 * nobody could read or amend when the parser changes.
 */
function pdfWith(lines: string[], opts: { compress?: boolean } = {}): Buffer {
  const content = lines.map((l) => `BT (${l.replace(/([()\\])/g, "\\$1")}) Tj ET`).join("\n");
  const stream = opts.compress === false ? Buffer.from(content, "latin1") : deflateSync(Buffer.from(content, "latin1"));
  return Buffer.concat([
    Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n2 0 obj<</Length " + stream.byteLength + ">>stream\n", "latin1"),
    stream,
    Buffer.from("\nendstream endobj\ntrailer<</Root 1 0 R>>\n%%EOF", "latin1"),
  ]);
}

// ── it reads what it says it reads ───────────────────────────────────────────────────────────────

test("a machine-generated PDF gives up its text, compressed or not", () => {
  // THE BUG: the feature being decorative. Invoices, statements and quotes — the documents a service
  // business actually forwards — are Flate-compressed content streams of plain `Tj` operators, and a
  // reader that cannot do that one case cannot do anything a founder will attach.
  for (const compress of [true, false]) {
    const out = ok(extractText("statement.pdf", "application/pdf", pdfWith(["Northwind Ltd", "Balance due 4,200.00 USD"], { compress })));
    assert.match(out.text, /Northwind Ltd/);
    assert.match(out.text, /4,200\.00 USD/);
  }
});

test("a PDF is recognised by its bytes, not by what the browser called it", () => {
  // THE BUG: trusting `file.type`. A drag from Finder, a Windows machine with no association, or a
  // renamed file all arrive as `application/octet-stream`, and a reader that dispatches on the
  // declared type refuses documents it can plainly read.
  const out = ok(extractText("no-extension", "application/octet-stream", pdfWith(["Invoice INV-0007"])));
  assert.match(out.text, /INV-0007/);
});

test("text files are read; a binary wearing a .txt is refused rather than fed to a model", () => {
  // THE BUG: four thousand replacement characters reaching the composer, and a model inventing a
  // shape for the noise. Better to say "this does not look like text" than to answer from mojibake.
  assert.match(ok(extractText("notes.txt", "text/plain", Buffer.from("Agreed 30 day terms with Acme."))).text, /30 day terms/);
  assert.match(ok(extractText("rows.csv", "application/octet-stream", Buffer.from("client,amount\nAcme,1200"))).text, /Acme,1200/);
  const junk = Buffer.from(Array.from({ length: 4_000 }, (_, i) => (i % 7 === 0 ? 0xff : 0xfe)));
  assert.equal(refused(extractText("thing.txt", "text/plain", junk)).reason, "unsupported");
});

// ── it refuses out loud ──────────────────────────────────────────────────────────────────────────

test("a scanned PDF is refused by name, not answered around", () => {
  // THE BUG, and it is the honesty one: a PDF with no text layer extracts to "" and, if that were
  // treated as success, the turn would answer confidently from the rest of the business as though it
  // had read the document. `unreadable_pdf` says what happened and what to do instead.
  const scan = Buffer.concat([
    Buffer.from("%PDF-1.4\n1 0 obj<</Type/XObject/Subtype/Image>>stream\n", "latin1"),
    deflateSync(Buffer.alloc(2048, 0x7f)),
    Buffer.from("\nendstream\n%%EOF", "latin1"),
  ]);
  const r = refused(extractText("scan.pdf", "application/pdf", scan));
  assert.equal(r.reason, "unreadable_pdf");
  assert.match(r.message, /paste|text|spreadsheet/i);
});

test("every refusal carries a sentence that tells the founder what to do next", () => {
  // THE BUG: an error that is a state, not an instruction. This is the surface the product is judged
  // by; "unsupported file" is a shrug with a stack trace behind it.
  for (const e of [
    extractText("empty.txt", "text/plain", Buffer.alloc(0)),
    extractText("huge.txt", "text/plain", Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 0x41)),
    extractText("photo.png", "image/png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  ]) {
    const r = refused(e);
    assert.ok(r.message.length > 10, `"${r.message}" is not a sentence`);
    assert.ok(r.name && !r.name.includes("/"), "the refusal must name the file");
  }
  assert.equal(refused(extractText("photo.png", "image/png", Buffer.from([0x89, 0x50]))).reason, "unreadable_image");
  assert.equal(refused(extractText("huge.txt", "text/plain", Buffer.alloc(MAX_ATTACHMENT_BYTES + 1))).reason, "too_large");
});

test("an XLSX workbook yields tab-separated cell text", () => {
  // THE BUG: a founder drops a fee schedule / receipt list and the composer shrugs "unsupported",
  // so they paste twenty rows by hand. OOXML is ZIP+XML — same size argument as PDF, not a library.
  const book = minimalXlsx([
    ["Client", "Amount"],
    ["Acme", "1200"],
    ["Northwind", "450"],
  ]);
  const out = ok(extractText("fees.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", book));
  assert.match(out.text, /Client\tAmount/);
  assert.match(out.text, /Acme\t1200/);
  assert.match(out.text, /Northwind\t450/);
});

/** Minimal stored (method 0) XLSX: sharedStrings + one sheet. Enough for the reader, not Excel. */
function minimalXlsx(rows: string[][]): Buffer {
  const shared: string[] = [];
  const idx = (s: string) => {
    const i = shared.indexOf(s);
    if (i >= 0) return i;
    shared.push(s);
    return shared.length - 1;
  };
  const sheetRows = rows
    .map((row, r) => {
      const cells = row
        .map((v, c) => {
          const ref = `${String.fromCharCode(65 + c)}${r + 1}`;
          return `<c r="${ref}" t="s"><v>${idx(v)}</v></c>`;
        })
        .join("");
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join("");
  const sharedXml =
    `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">` +
    shared.map((s) => `<si><t>${s.replace(/&/g, "&amp;")}</t></si>`).join("") +
    `</sst>`;
  const sheetXml =
    `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`;
  return zipStore([
    ["xl/sharedStrings.xml", sharedXml],
    ["xl/worksheets/sheet1.xml", sheetXml],
  ]);
}

function zipStore(entries: [string, string][]): Buffer {
  const parts: Buffer[] = [];
  for (const [name, body] of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const data = Buffer.from(body, "utf8");
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4); // version
    header.writeUInt16LE(0, 6); // flags
    header.writeUInt16LE(0, 8); // stored
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt32LE(0, 14); // crc skipped — reader does not check
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(0, 28);
    parts.push(header, nameBuf, data);
  }
  return Buffer.concat(parts);
}

// ── it is bounded ────────────────────────────────────────────────────────────────────────────────

test("text is clipped at the ceiling and says it was", () => {
  // THE BUG: unbounded context, which is unbounded spend on a surface mounted on every page. The
  // `truncated` flag exists so the UI can say so — silently dropping half a contract and answering
  // from the rest is the same dishonesty as answering around a scan.
  const out = ok(extractText("long.txt", "text/plain", Buffer.from("word ".repeat(MAX_TEXT_CHARS))));
  assert.equal(out.text.length, MAX_TEXT_CHARS);
  assert.equal(out.truncated, true);
  assert.ok(out.chars > MAX_TEXT_CHARS);
  assert.equal(ok(extractText("short.txt", "text/plain", Buffer.from("hello"))).truncated, false);
});

test("a PDF with thousands of streams still returns in bounded work", () => {
  // THE BUG: a parser with no stream ceiling. A file that is legal, small on the wire and expensive
  // to walk is the cheapest denial of service there is.
  const many = pdfWith(Array.from({ length: 400 }, (_, i) => `line ${i}`));
  const started = Date.now();
  const out = extractText("big.pdf", "application/pdf", many);
  assert.ok(Date.now() - started < 3_000, "extraction must not be open-ended");
  if (out.ok) assert.ok(out.text.length <= MAX_TEXT_CHARS);
});

test("a malformed file produces a refusal, never a throw", () => {
  // THE BUG: a 500 in the founder's composer. This runs inside a request on a surface that renders
  // on every page; a parser that throws takes the front door down with it.
  for (const bytes of [
    Buffer.from("%PDF-1.4 stream\n\x00\x01\x02 endstream"),
    Buffer.from("%PDF"),
    Buffer.from("stream endstream stream"),
    Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00]),
  ]) {
    assert.doesNotThrow(() => extractText("broken.pdf", "application/pdf", bytes));
  }
});

test("a traversal in the filename is reduced to a basename before it is ever echoed", () => {
  // THE BUG: `../../etc/passwd` is harmless to this module and lethal to any consumer that writes
  // the name to disk or into a header. Names are cut where they are received, not where they are used.
  assert.equal(ok(extractText("../../etc/passwd.txt", "text/plain", Buffer.from("root:x"))).name, "passwd.txt");
  assert.equal(refused(extractText("..\\..\\win.png", "image/png", Buffer.from([0x89, 0x50]))).name, "win.png");
});
