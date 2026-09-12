import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseBlocks, applyBlockEdits, editableFormat, type BlockFormat } from "../src/doc-blocks";

/**
 * The invariant the whole feature rests on: parsing a document and applying NO edits must hand back
 * the identical bytes. If this can fail, then every founder edit silently rewrites parts of the
 * client's document that the founder never looked at.
 */
function assertRoundTrip(src: string, format: BlockFormat, what: string) {
  const blocks = parseBlocks(src, format);
  const { text, changes } = applyBlockEdits(src, blocks, [], format);
  assert.equal(text, src, `${what}: round trip changed the bytes`);
  assert.deepEqual(changes, [], `${what}: no edits should report no changes`);
}

const MD_KITCHEN_SINK = `# Ridgeline — April visibility

Two paragraphs, the second of which
runs across lines and must keep
its own newlines exactly.

## What we found

- First bullet
- Second bullet with **bold**
  - a nested one
1. numbered
2) and the other marker

> A quote, indented oddly

| Metric | April | March |
| --- | ---: | :-: |
| Impressions | 12,004 | 9,118 |
| Clicks | 431 | 388 |

\`\`\`sql
select 1
from t;
\`\`\`

Trailing paragraph with trailing spaces.   
`;

describe("doc-blocks: the round trip", () => {
  it("returns identical bytes for a document using every markdown construct we emit", () => {
    assertRoundTrip(MD_KITCHEN_SINK, "markdown", "kitchen sink");
  });

  it("survives CRLF, which a founder's paste and half of Windows will produce", () => {
    assertRoundTrip(MD_KITCHEN_SINK.replace(/\n/g, "\r\n"), "markdown", "crlf");
  });

  it("survives an empty document and a document that is only whitespace", () => {
    assertRoundTrip("", "markdown", "empty");
    assertRoundTrip("\n\n   \n", "markdown", "whitespace");
  });

  it("survives an unterminated code fence", () => {
    assertRoundTrip("# T\n\n```js\nnever closed\n", "markdown", "open fence");
  });

  it("returns identical bytes for html", () => {
    assertRoundTrip(
      `<!doctype html><html><head><style>p{color:red}</style></head><body>\n<h1>Q1 &amp; Q2</h1>\n<p>Body text.</p>\n<script>var x = "<b>";</script>\n</body></html>`,
      "html",
      "html",
    );
  });

  it("returns identical bytes for csv, including quoted cells", () => {
    assertRoundTrip(`name,note,amount\n"Acme, Inc.","he said ""yes""",1200\nBeta,,0\n`, "csv", "csv");
  });
});

describe("doc-blocks: editing one block touches only that block", () => {
  it("changes the edited heading and nothing else in the file", () => {
    const blocks = parseBlocks(MD_KITCHEN_SINK, "markdown");
    const h = blocks.find((b) => b.kind === "heading" && b.text.startsWith("Ridgeline"))!;
    const { text, changes } = applyBlockEdits(MD_KITCHEN_SINK, blocks, [{ id: h.id, text: "Ridgeline — April search visibility" }], "markdown");

    assert.equal(changes.length, 1);
    assert.equal(changes[0]!.before, "Ridgeline — April visibility");
    assert.equal(changes[0]!.after, "Ridgeline — April search visibility");
    assert.ok(text.startsWith("# Ridgeline — April search visibility\n"));

    // Everything after the heading line is byte-identical.
    const tail = (s: string) => s.slice(s.indexOf("\n"));
    assert.equal(tail(text), tail(MD_KITCHEN_SINK));
  });

  it("edits one bullet out of a list without touching its siblings", () => {
    const blocks = parseBlocks(MD_KITCHEN_SINK, "markdown");
    const second = blocks.filter((b) => b.kind === "list_item")[1]!;
    const { text } = applyBlockEdits(MD_KITCHEN_SINK, blocks, [{ id: second.id, text: "Second bullet, rewritten" }], "markdown");
    assert.ok(text.includes("- First bullet\n"));
    assert.ok(text.includes("- Second bullet, rewritten\n"));
    assert.ok(text.includes("  - a nested one\n"), "the nested bullet kept its indent");
  });

  it("applies several edits at once without the earlier ones shifting the later ones", () => {
    const blocks = parseBlocks(MD_KITCHEN_SINK, "markdown");
    const targets = blocks.filter((b) => b.kind === "list_item" || b.kind === "heading");
    // No trailing whitespace: the guard trims headings and bullets, correctly, and a fixture that
    // generated a trailing space would be asserting the guard is broken.
    const edits = targets.map((b, i) => ({ id: b.id, text: `EDITED-${i}${"x".repeat(i * 7)}` }));
    const { text, changes } = applyBlockEdits(MD_KITCHEN_SINK, blocks, edits, "markdown");
    assert.equal(changes.length, targets.length);
    // Re-parsing the result must find every new value where it was put.
    const after = parseBlocks(text, "markdown");
    for (const e of edits) assert.ok(after.some((b) => b.text === e.text), `lost: ${e.text}`);
  });

  it("reports changes in document order however they were submitted", () => {
    const blocks = parseBlocks(MD_KITCHEN_SINK, "markdown");
    const items = blocks.filter((b) => b.kind === "list_item").slice(0, 3);
    const reversed = [...items].reverse().map((b, i) => ({ id: b.id, text: `z${i}` }));
    const { changes } = applyBlockEdits(MD_KITCHEN_SINK, blocks, reversed, "markdown");
    const order = changes.map((ch) => blocks.findIndex((b) => b.id === ch.id));
    assert.deepEqual(order, [...order].sort((a, b) => a - b), "changes were not in document order");
  });
});

describe("doc-blocks: an edit cannot break the document around it", () => {
  it("flattens a newline pasted into a bullet, which would otherwise end the list", () => {
    const src = "- one\n- two\n";
    const blocks = parseBlocks(src, "markdown");
    const { text } = applyBlockEdits(src, blocks, [{ id: blocks[0]!.id, text: "one\n\nrogue paragraph" }], "markdown");
    assert.equal(text, "- one rogue paragraph\n- two\n");
  });

  it("escapes a pipe typed into a table cell instead of inventing a column", () => {
    const src = "| a | b |\n| --- | --- |\n| 1 | 2 |\n";
    const blocks = parseBlocks(src, "markdown");
    const cell = blocks.find((b) => b.text === "1")!;
    const { text } = applyBlockEdits(src, blocks, [{ id: cell.id, text: "1 | 3" }], "markdown");
    assert.equal(text.split("\n")[2], "| 1 \\| 3 | 2 |");
  });

  it("does not offer the alignment row as something to edit", () => {
    const src = "| a | b |\n| --- | ---: |\n| 1 | 2 |\n";
    const blocks = parseBlocks(src, "markdown");
    assert.ok(!blocks.some((b) => b.text.includes("---")), "the divider was offered as prose");
  });

  it("re-escapes html so a typed ampersand does not corrupt the page", () => {
    const src = "<p>Q1 and Q2</p>";
    const blocks = parseBlocks(src, "html");
    const { text } = applyBlockEdits(src, blocks, [{ id: blocks[0]!.id, text: "Q1 & Q2 <b>" }], "html");
    assert.equal(text, "<p>Q1 &amp; Q2 &lt;b&gt;</p>");
  });

  it("never offers script or style bodies as editable prose", () => {
    const src = `<style>p{color:red}</style><p>Real text</p><script>alert("hi")</script>`;
    const blocks = parseBlocks(src, "html");
    assert.deepEqual(blocks.map((b) => b.text), ["Real text"]);
  });

  it("quotes a csv cell that gains a comma", () => {
    const src = "name,amount\nAcme,10\n";
    const blocks = parseBlocks(src, "csv");
    const cell = blocks.find((b) => b.text === "Acme")!;
    const { text } = applyBlockEdits(src, blocks, [{ id: cell.id, text: "Acme, Inc." }], "csv");
    assert.equal(text, 'name,amount\n"Acme, Inc.",10\n');
  });

  it("doubles quotes inside a cell that was already quoted", () => {
    const src = 'name\n"a b"\n';
    const blocks = parseBlocks(src, "csv");
    const cell = blocks.find((b) => b.text === "a b")!;
    const { text } = applyBlockEdits(src, blocks, [{ id: cell.id, text: 'a "b"' }], "csv");
    assert.equal(text, 'name\n"a ""b"""\n');
  });
});

describe("doc-blocks: what we refuse to pretend we can edit", () => {
  it("refuses pdf, which is a rendering and not a source", () => {
    assert.equal(editableFormat("application/pdf", "report.pdf"), undefined);
    assert.equal(editableFormat("text/plain", "report.pdf"), undefined, "the extension has to win — we mislabel content types");
  });

  it("refuses binary office and image formats", () => {
    for (const n of ["a.xlsx", "a.docx", "a.pptx", "a.png", "a.zip", "a.svg"]) {
      assert.equal(editableFormat("application/octet-stream", n), undefined, n);
    }
  });

  it("accepts the formats our runs actually produce, including the mislabelled ones", () => {
    // Production stores .md and .html as text/plain — 7,073 artifacts of it. The extension decides.
    assert.equal(editableFormat("text/plain", "monthly-close-inputs-needed.md"), "markdown");
    assert.equal(editableFormat("text/plain", "monitoring-setup-required.html"), "html");
    assert.equal(editableFormat("text/csv", "ridgeline-april-answers.csv"), "csv");
    assert.equal(editableFormat("text/plain", "result.txt"), "markdown");
  });
});

describe("doc-blocks: every block is addressable and labelled for a person", () => {
  it("labels blocks the way a founder would refer to them", () => {
    const blocks = parseBlocks(MD_KITCHEN_SINK, "markdown");
    const labels = blocks.map((b) => b.label);
    assert.ok(labels.includes("Heading"), labels.join(" | "));
    assert.ok(labels.includes("Heading 2"));
    assert.ok(labels.some((l) => l.startsWith("Bullet ")));
    assert.ok(labels.some((l) => /^Row \d+, column \d+$/.test(l)));
    assert.ok(labels.some((l) => l.startsWith("Code block ")));
  });

  it("gives every block a distinct id", () => {
    const blocks = parseBlocks(MD_KITCHEN_SINK, "markdown");
    assert.equal(new Set(blocks.map((b) => b.id)).size, blocks.length);
  });

  it("drops an edit for a block that no longer exists rather than failing the save", () => {
    const blocks = parseBlocks(MD_KITCHEN_SINK, "markdown");
    const { text, changes } = applyBlockEdits(MD_KITCHEN_SINK, blocks, [{ id: "b9999", text: "ghost" }], "markdown");
    assert.equal(text, MD_KITCHEN_SINK);
    assert.deepEqual(changes, []);
  });

  it("treats a no-op edit as no change, so saving twice does not write a second version", () => {
    const blocks = parseBlocks(MD_KITCHEN_SINK, "markdown");
    const h = blocks.find((b) => b.kind === "heading")!;
    const { changes } = applyBlockEdits(MD_KITCHEN_SINK, blocks, [{ id: h.id, text: h.text }], "markdown");
    assert.deepEqual(changes, []);
  });
});
