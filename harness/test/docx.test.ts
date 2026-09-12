// A Word file we wrote, read back by the parser this product already ships.
//
// ═══ WHY THE ROUND TRIP IS THE TEST ═══
//
// Asserting on the XML we just generated proves the template matches itself. It cannot catch the
// failure that actually matters here — a byte sequence Word refuses to open — because the only
// authority on that is a reader.
//
// We have one. `attachments.ts` has parsed `.docx` since clients could upload them, it is
// independent of this writer, and it is what the product uses when a client sends a Word file back.
// So every test below writes with `renderDocument` and reads with `docxText`, and a break in either
// direction turns them red. It is not Word, and it is the strongest available check short of one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { docxText } from "../src/attachments";
import { renderDocument, type Block } from "../src/render/docx";

const bytes = (blocks: Block[], title = "Test") =>
  Buffer.from(renderDocument({ title, blocks }).content, "base64");

const text = (blocks: Block[]) => docxText(bytes(blocks));

test("a document we write is a document we can read", () => {
  const out = text([
    { kind: "heading", level: 1, text: "Statement of work" },
    { kind: "para", text: "Prepared for Kestrel Analytics." },
  ]);
  assert.match(out, /Statement of work/);
  assert.match(out, /Prepared for Kestrel Analytics\./);
});

test("AN AMPERSAND IN A CLIENT'S NAME DOES NOT DESTROY THE FILE", () => {
  /**
   * The one that matters most, because most law firms are called "X & Y" and the failure is total:
   * an unescaped `&` produces a file Word refuses to open at all, with an error naming a line in a
   * part the founder has never heard of. Not a cosmetic bug — a deliverable the person paying for
   * it cannot open.
   */
  const out = text([{ kind: "para", text: 'Smith & Partners <LLP> said "yes"' }]);
  assert.match(out, /Smith & Partners <LLP> said "yes"/);
});

test("a control character a model emitted is dropped, not embedded", () => {
  // XML 1.0 forbids them outright; embedding one is the same total failure as the ampersand.
  /*
    The escape is `\u0007`, NOT a literal byte. A control character in a source file survives git
    but not every editor or formatter — and the day one is silently stripped, this test asserts
    that "beforeafter" round-trips, which it does, proving nothing about the thing it is named
    after. The length check is the receipt that the fixture is what it claims, which is the same
    "confirm the sabotage applied" rule AGENTS.md sets for controls.
  */
  const dirty = "before\u0007after";
  assert.equal(dirty.length, 12, "the control character is missing from the fixture");
  assert.match(text([{ kind: "para", text: dirty }]), /beforeafter/);
});

test("headings, bullets and numbers all survive", () => {
  const out = text([
    { kind: "heading", level: 2, text: "Scope" },
    { kind: "bullets", items: ["Monthly close", "Sales tax return"] },
    { kind: "numbers", items: ["First", "Second"] },
  ]);
  for (const s of ["Scope", "Monthly close", "Sales tax return", "First", "Second"]) {
    assert.match(out, new RegExp(s), `${s} did not survive the round trip`);
  }
});

test("A TABLE IS A TABLE, NOT PROSE", () => {
  /**
   * Ten of twelve shipped exemplars had a grid that the prose path silently dropped —
   * `STANDARD.md` counts that as a defect, and a contract's payment schedule is a grid. If tables
   * ever stop round-tripping, the honest thing is a red test rather than a document that quietly
   * loses its numbers.
   */
  const out = text([
    { kind: "table", header: ["Milestone", "Amount"], rows: [["On signature", "£2,000"], ["On delivery", "£3,000"]] },
  ]);
  for (const s of ["Milestone", "Amount", "On signature", "2,000", "On delivery", "3,000"]) {
    assert.match(out, new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${s} is missing from the table`);
  }
});

test("a short row is padded and a long one is trimmed, and neither loses the document", () => {
  /**
   * A model that emits five headers and a four-cell row has made a mistake. Throwing loses an
   * otherwise complete document over one row; padding leaves a visible empty cell for the founder
   * reviewing it. The second is cheaper for everyone and teaches somebody something.
   */
  const out = text([
    { kind: "table", header: ["A", "B", "C"], rows: [["one"], ["x", "y", "z", "DROPPED"]] },
  ]);
  assert.match(out, /one/, "a short row lost the whole document");
  assert.match(out, /z/);
  assert.ok(!/DROPPED/.test(out), "a cell beyond the header width was rendered, widening the table");
});

test("two renders of the same content are byte-identical", () => {
  /**
   * `ooxml.ts` fixes the ZIP timestamps for this, and `docx.ts` deliberately writes no
   * `dcterms:created`. A diff between two months should show what changed in the words, and a
   * rebuilt artifact should not look like a new one — a clock in the core properties would undo
   * that in the one part nobody thinks to look at.
   */
  const blocks: Block[] = [{ kind: "para", text: "same" }];
  assert.equal(bytes(blocks).toString("hex"), bytes(blocks).toString("hex"));
});

test("the file announces itself as a Word document", () => {
  const doc = renderDocument({ title: "x", blocks: [] });
  assert.equal(
    doc.content_type,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  assert.equal(doc.encoding, "base64", "every artifact in this system moves as base64 with an encoding");
  assert.ok(doc.size_bytes > 0 && doc.size_bytes === Buffer.from(doc.content, "base64").length);
});

test("an empty document is still a valid document", () => {
  // A run that produced no blocks should ship an openable empty file, not a corrupt one.
  assert.doesNotThrow(() => docxText(bytes([])));
});

test("THE RENDERER HAS A PRODUCTION CALLER", () => {
  /**
   * The reachability assertion, and the reason this file is not just nine unit tests.
   *
   * A renderer with a spec and no call site looks MORE finished than dead code — it passes CI while
   * proving nothing about whether a client ever receives a Word file. `renderWorkbook` earned its
   * caller the same way, on the same seam: a workflow returns a plain-data spec and `server.ts`
   * renders it, because founder workflow code is pure by design and cannot write OOXML itself.
   */
  const src = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  assert.match(src, /import \{ renderDocument \}/, "server.ts no longer imports the document renderer");
  assert.match(src, /renderDocument\(docSpec as/, "nothing calls renderDocument in production");
  assert.match(src, /\.docx`/, "the rendered document is not being named as a .docx");
});
