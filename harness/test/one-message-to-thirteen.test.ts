/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * "THIRTEEN MESSAGES, CHECK THEM" IS A DIFFERENT DECISION FROM "ONE MESSAGE, TO THIRTEEN PEOPLE"
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Read out of production, 13 September. A real campaign artifact, 7,386 bytes, headed "Every
 * message, in full", with a `### Name` section for each of thirteen prospects — and the SAME
 * paragraph under every one, `{first_name}` not even interpolated. Twenty-six copies of one
 * sentence.
 *
 * Nothing was broken. Sequence copy is a template by design and the renderer printed it once per
 * recipient, faithfully. But a heading per person promises that what follows is about that person,
 * and the founder approving it was reading the wrong decision.
 *
 * One message to thirteen people is a template to review once and a recipient list to scan.
 * Thirteen written messages is half an hour of reading. Printing the first as the second buries the
 * fact that nothing is personalised, at the exact moment somebody decides whether it is good enough
 * to send — which is the only moment it can be caught.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Read from source: `messageSections` is a module-local helper inside a function that needs a store,
 * a task and an approval path. Extracting it to test it would be testing a copy.
 */
const src = readFileSync(new URL("../src/gtm/campaign.ts", import.meta.url), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
  .replace(/^\s*\/\/.*$/gm, "");
const fn = (() => {
  const start = src.indexOf("function messageSections");
  const end = src.indexOf("\nfunction ", start + 1);
  return src.slice(start, end === -1 ? src.indexOf("\nexport ", start + 1) : end);
})();

test("THE DOCUMENT GROUPS BY THE COPY, NOT BY THE PERSON", () => {
  assert.ok(fn.length > 200, "messageSections could not be located");
  assert.match(fn, /JSON\.stringify\(Object\.entries\(copy\)\.sort\(\)\)/, "identical copy is no longer grouped");
  assert.ok(!/### \$\{p\.name \?\? p\.profile_id\}/.test(src), "it still prints a heading per prospect regardless");
});

test("IT SAYS PLAINLY WHEN NOTHING IS PERSONALISED", () => {
  /**
   * The sentence that changes the founder's decision. Without it, the grouped version is merely
   * shorter — which is an improvement in length and not in honesty.
   */
  assert.match(fn, /One message, to all \$\{prospects\.length\}/, "the all-identical case is not named");
  assert.match(fn, /Nothing below is personalised/, "the founder is not told what they are approving");
});

test("a genuinely written message keeps the person's name as its heading", () => {
  // The original shape was right for the case it was written for. A group of one is that case.
  assert.match(fn, /g\.who\.length === 1 \? `### \$\{g\.who\[0\]\}`/, "a one-off message lost its name");
});

test("AND THE RECIPIENTS ARE NAMED, NOT COUNTED", () => {
  /**
   * "Going to 13 prospects" is a number nobody can act on. The founder scans that list for one
   * person who should not be on it — a current client, a competitor, somebody they just met.
   */
  assert.match(fn, /Going to: \$\{g\.who\.join\(", "\)\}/, "recipients are counted rather than named");
});

test("the mixed case is described honestly", () => {
  // Some templated, some written. Saying only "4 distinct" hides which of the four is a template.
  assert.match(fn, /distinct, across \$\{prospects\.length\} prospects/);
  assert.match(fn, /go to more than one person/, "the mixed case does not say which are shared");
  // And the sentence agrees with its own count — "1 of these go to" is the tell that nobody read it.
  assert.match(fn, /One of these goes to more than one person/, "the singular case is ungrammatical");
});
