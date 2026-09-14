// A THIRD OF THE DELIVERABLE WAS A STYLESHEET THE HARNESS WAS GOING TO REPLACE.
//
// ═══ MEASURED ON A REAL RUN ═══
//
// The agent wrote an 8,391-character HTML report. 3,079 of those characters — 37% — were hand-rolled
// CSS: a `:root` block of custom properties, `clamp()` typography, a box-sizing reset, forty-one
// lines of a design system invented from nothing. Against 592 words of actual analysis.
//
// And the harness had ALREADY rendered the same content properly. `deliverables.wrap.ts` does
// `if (kind === "document" && content && renderDocument)`, which sends the run's markdown through
// `blocksFromMarkdown` → `insertChart` → `render("report", …, brandKit)` — the founder's own brand,
// the wedge's declared chart, and `tasteBlockers` checking the layout.
//
// So every deliverable shipped TWO documents: a branded, taste-checked PDF and a bespoke HTML file
// with a different look. Same content, two designs.
//
// ═══ WHY THIS IS A QUALITY FIX AND NOT A TIDINESS ONE ═══
//
// The independent reviewer failed that run on "It is the thing they asked for" and "Every number and
// claim is traceable". Both are ANALYSIS faults. The attention that would have fixed them went into
// a stylesheet.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const runtime = readFileSync(new URL("../src/runtime.ts", import.meta.url), "utf8");
const code = runtime.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

test("the run is told to write the analysis, not the document", () => {
  assert.match(code, /\*\*Write the analysis, not the document\.\*\*/, "the instruction is gone");
  /*
    Named formats, because "write data" is not actionable. A run that knows `.md`, `.csv` and `.json`
    are what the renderer wants does not have to guess, and guessing is what produced the HTML.
  */
  for (const fmt of ["markdown", "`.csv`", "`.json`"]) {
    assert.ok(code.includes(fmt), `the instruction no longer names ${fmt} as a form the renderer takes`);
  }
});

test("HTML and CSS are refused by name, with the reason", () => {
  /**
   * A prohibition without a reason is one a model talks itself out of when the task feels like it
   * wants a document. The reason given is the one that is actually true: the stylesheet is thrown
   * away or attached beside the rendered one, so the client gets the same report twice.
   */
  assert.match(code, /Do not write HTML and do not write CSS/);
  assert.match(code, /same report twice in two designs/, "the consequence is no longer stated");
});

test("the renderer it defers to is the one that actually runs", () => {
  /*
    The instruction is only true because `deliverables.wrap.ts` renders `content` for a document
    deliverable. If that stopped happening, telling a run not to write a document would leave the
    founder with no document at all — which is a far worse failure than a duplicate.
  */
  const wrap = readFileSync(new URL("../src/deliverables.wrap.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");
  assert.match(
    wrap,
    /if \(kind === "document" && content && renderDocument\)/,
    "nothing renders the run's content any more — the run must not be told to stop writing documents",
  );
});

test("the brand and the taste check are still on the path the run now depends on", () => {
  /**
   * The whole argument for taking the document away from the run is that the harness does it BETTER:
   * the founder's own brand, and a layout lint. If either left this path, the run would be giving up
   * a bespoke document for a worse generic one.
   */
  const orch = readFileSync(new URL("../src/orchestrator.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");
  assert.match(orch, /render\("report", \{ title, blocks \}, kit\)/, "the report is no longer rendered with the brand kit");
  assert.match(orch, /tasteBlockers\(doc\)/, "the layout lint left the render path");
  assert.match(orch, /blocksFromMarkdown\(content\)/, "markdown is no longer what the renderer takes");
});
