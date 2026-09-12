import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { blocksFromMarkdown } from "../src/render/report";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE NUMBERS THE CLIENT IS PAYING FOR
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `ReportBlock` has had a `table` kind since the file was written and NOTHING EVER PRODUCED ONE.
 * The renderer could draw a table; the parser could not recognise one. So every markdown table a run
 * wrote reached the client as a run of paragraphs with pipes in them.
 *
 * Found by rendering our own exemplar through the real pipeline. `geo-monitor`'s weekly report is
 * the standard the model is held to and it contains the share-of-voice table; through
 * `blocksFromMarkdown` it produced 10 headings, 25 paragraphs, 6 dividers, 2 bullet lists and zero
 * tables. Ten of the twelve shipped exemplars have the same shape.
 *
 * A visibility report without its numbers laid out is a covering note. A close pack whose figures
 * run together as a sentence is worse than one with no figures — it looks finished.
 */
const WEDGES = join(import.meta.dirname, "..", "..", "wedges");

test("a pipe table becomes a table", () => {
  const blocks = blocksFromMarkdown(
    ["| Surface | Queries | Cited |", "|---|---|---|", "| ChatGPT | 12 | 3 |", "| Perplexity | 12 | 4 |"].join("\n"),
  );
  const table = blocks.find((b) => b.kind === "table");
  assert.ok(table, "a markdown table still renders as prose");
  assert.deepEqual(table.columns, ["Surface", "Queries", "Cited"]);
  assert.deepEqual(table.rows, [
    ["ChatGPT", "12", "3"],
    ["Perplexity", "12", "4"],
  ]);
});

test("the separator row is what makes it a table", () => {
  /**
   * A single line with pipes is a sentence about a keyboard. Requiring `|---|` means a paragraph
   * mentioning "a | b" is never swallowed into a table nobody wrote.
   */
  const blocks = blocksFromMarkdown("Pick one | the other, whichever you prefer.");
  assert.ok(!blocks.some((b) => b.kind === "table"), "a sentence containing a pipe became a table");
});

test("a short row is padded, never dropped", () => {
  // A model that writes four headers and a three-cell row made a small mistake in one row. Dropping
  // it loses a client's number; showing it short shows exactly what was written.
  const blocks = blocksFromMarkdown(
    ["| A | B | C |", "|---|---|---|", "| 1 | 2 |", "| 1 | 2 | 3 | 4 |"].join("\n"),
  );
  const table = blocks.find((b) => b.kind === "table");
  assert.ok(table);
  assert.deepEqual(table.rows, [
    ["1", "2", ""],
    ["1", "2", "3"],
  ]);
});

test("emphasis that wraps across lines does not reach the client as asterisks", () => {
  /**
   * `stripInline` runs per line and forbids a newline inside a pair, so a lone `*` starting a line
   * stays a bullet. That left a marker opened on one line and closed on the next untouched — and our
   * own GEO exemplar opens with exactly that, a two-line italic caveat, which reached the PDF with
   * its asterisks showing.
   */
  const blocks = blocksFromMarkdown("*(Reference document. Everything below\nis invented.)*");
  const para = blocks.find((b) => b.kind === "paragraph");
  assert.ok(para);
  assert.ok(!para.text.includes("*"), `asterisks survived into the document: ${para.text}`);
});

test("every shipped exemplar's tables actually parse", () => {
  /**
   * The regression that matters. These files ARE the standard — the model is shown one and told to
   * match it — so a table the parser cannot read is a table the client will not get, in that trade,
   * every month.
   */
  const missed: string[] = [];
  for (const wedge of readdirSync(WEDGES)) {
    let files: string[];
    try {
      files = readdirSync(join(WEDGES, wedge, "exemplars"));
    } catch {
      continue;
    }
    for (const f of files) {
      const md = readFileSync(join(WEDGES, wedge, "exemplars", f), "utf8");
      const pipeRows = md.split("\n").filter((l) => /^\s*\|.*\|\s*$/.test(l)).length;
      if (!pipeRows) continue;
      const tables = blocksFromMarkdown(md).filter((b) => b.kind === "table").length;
      if (!tables) missed.push(`${wedge}/${f} — ${pipeRows} pipe rows, 0 tables`);
    }
  }
  assert.deepEqual(missed, [], `these exemplars' tables render as prose:\n  ${missed.join("\n  ")}`);
});
