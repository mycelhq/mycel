import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE PROMPT AND THE CRAFT HAVE TO AGREE
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `craft/presenting-work.md` is mounted on every delivering run and opens with "self-contained HTML
 * is the default for anything a person reads" and "markdown is a working note. It is not a
 * deliverable."
 *
 * In production, runs had authored 4,923 `.txt`, 2,045 `.md`, 23 `.csv` and ZERO `.html`.
 *
 * The prompt was why. Every shape took one line — "Be concise. Write deliverables to ./output/." —
 * which named no format and told the shape whose own comment says "these are the runs whose output
 * IS the product" to write less of it. `exemplar.ts` had already diagnosed the symptom: output
 * "competent, correctly structured, and SHORT".
 */
const RUNTIME = readFileSync(join(import.meta.dirname, "..", "src", "runtime.ts"), "utf8");
const CRAFT = readFileSync(
  join(import.meta.dirname, "..", "..", "library", "craft", "presenting-work.md"),
  "utf8",
);

/**
 * The `deliver` branch of the instruction builder, WITH COMMENTS STRIPPED.
 *
 * The first version of this asserted against the raw slice and failed on its own documentation —
 * the note above the branch explains why "be concise" was wrong and therefore contains the phrase.
 * A test that reads prose is testing what is written rather than what runs, which is the mistake
 * this file is about in the first place.
 */
const DELIVER = RUNTIME.slice(
  RUNTIME.indexOf('} else if (profile.shape === "deliver") {'),
  RUNTIME.indexOf('  } else {\n    parts.push(\n      `Use your tools to do the real work.'),
)
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/[^\n]*/g, "");

test("a delivering run is never told to be concise", () => {
  assert.ok(DELIVER.length > 200, "the deliver branch moved — this test is reading the wrong slice");
  assert.ok(
    !/Be concise/.test(DELIVER),
    "the shape whose output IS the product is being told to write less of it",
  );
});

test("the prompt names the format the craft asks for", () => {
  // Not a restatement of the craft — that would be two sources of truth for a rule that changes.
  // It points at the file and names the decision made before anyone opens the result.
  assert.match(DELIVER, /craft:presenting-work/, "nothing points the run at the craft it is mounted with");
  assert.match(DELIVER, /\.html/, "no format is named, which is how 2,045 markdown files happened");
  assert.match(DELIVER, /inline SVG/, "charts have no stated form");
});

test("and the craft it points at still says those things", () => {
  /**
   * The pairing is the point. If the craft is rewritten to prefer something else and the prompt is
   * not, the run gets two answers — which is the state this test exists to end, not to re-create.
   */
  assert.match(CRAFT, /Self-contained HTML is the default/i);
  assert.match(CRAFT, /Markdown is a working note/i);
  assert.match(CRAFT, /inline SVG/i);
});

test("other shapes keep the concise instruction", () => {
  // An operate tick's output is not a product and brevity is right for it. The fix is shape-aware,
  // not a global loosening.
  const general = RUNTIME.slice(RUNTIME.indexOf("  } else {\n    parts.push(\n      `Use your tools to do the real work."));
  assert.match(general.slice(0, 600), /Be concise/, "the concise instruction was removed for every shape");
});
