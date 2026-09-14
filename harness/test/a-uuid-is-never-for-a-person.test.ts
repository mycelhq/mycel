/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * THE SHOP WINDOW SHOWED A UUID TO EVERY VISITOR
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Found by opening the live demo on 13 September and reading it as a prospect would. Under "Worth
 * doing next", on Home, in front of anybody evaluating the product:
 *
 *   "…stopped: every way out of this wait is closed: their answer on 'Calder Dental — February
 *    visibility' (deliverable e2496dc9-e8df-4ec9-aa58-ee00d51f4ce3 is not in this project)."
 *
 * `waits.ts` HAD ALREADY FIXED THIS. Its own comment quotes that exact sentence, calls out both
 * faults — "a UUID is never a thing to show a person" and "'is not in this project' is a developer's
 * diagnosis" — and it now writes "the work it was waiting on no longer exists" with the id going to
 * the log.
 *
 * The two rows were written on 5 September, before that shipped. A stored string does not change
 * because the code that would have written it did. So a correct fix at the source left the shop
 * window unchanged for eight days, and nothing would ever have changed it.
 *
 * ═══ THE RULE THIS ADDS ═══
 *
 * A fix at the source stops the NEXT one. The render boundary has to trust nothing it reads,
 * because history is permanent and a founder-facing sentence is never the right place for a machine
 * identifier — whoever wrote it, and whenever.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { plainly } from "../src/moves";

test("A PARENTHETICAL HOLDING AN ID GOES WHOLE", () => {
  /**
   * Stripping only the id leaves "(deliverable is not in this project)", which is still a
   * developer's diagnosis of our tenancy model rather than an account of what happened to the work.
   */
  assert.equal(
    plainly(
      'their answer on "Calder Dental — February visibility" (deliverable e2496dc9-e8df-4ec9-aa58-ee00d51f4ce3 is not in this project)',
    ),
    'their answer on "Calder Dental — February visibility"',
  );
});

test("and a bare id is removed without taking the sentence with it", () => {
  assert.equal(plainly("run 648dee91-fe51-4b3d-9084-b03abfed4eda stopped early"), "run stopped early");
  assert.equal(plainly("nothing to scrub here"), "nothing to scrub here");
});

test("A PARENTHETICAL WITHOUT AN ID IS LEFT ALONE", () => {
  /**
   * The direction that matters more. A scrubber that eats real explanation is worse than the UUID
   * it was written to remove, because nobody notices the sentence that stopped being said.
   */
  const kept = "the client asked for changes (twice) before the deadline";
  assert.equal(plainly(kept), kept);
  assert.equal(plainly("waiting on the statement (bank, not card)"), "waiting on the statement (bank, not card)");
});

test("it tidies only what removal left behind", () => {
  // No double spaces and no space before punctuation — the tells that something was cut out.
  assert.equal(plainly("the work (deliverable 648dee91-fe51-4b3d-9084-b03abfed4eda) is gone."), "the work is gone.");
  assert.ok(!/\s{2,}/.test(plainly("a  b (id 648dee91-fe51-4b3d-9084-b03abfed4eda) c")));
});

test("IT IS NOT A COPY EDITOR", () => {
  /**
   * Text that is merely clumsy stays clumsy and gets fixed where it is written. A scrubber that
   * rewrites prose is one that eventually rewrites a number.
   */
  const clumsy = "stopped: every way out of this wait is closed: their answer never came";
  assert.equal(plainly(clumsy), clumsy);
});

test("empty and absent are the empty string, never the word undefined", () => {
  // `${undefined}` in a founder's sentence is its own kind of leak.
  assert.equal(plainly(undefined), "");
  assert.equal(plainly(null), "");
  assert.equal(plainly(""), "");
});

test("THE MOVE ACTUALLY USES IT", () => {
  /**
   * Built-but-never-invoked is the dominant bug class in this codebase, and a scrubber nothing calls
   * is indistinguishable from the bug it was written to fix.
   */
  const src = readFileSync(new URL("../src/moves.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.match(src, /\$\{plainly\(w\.reason\)\} since/, "the wait's reason reaches the founder unscrubbed");
  assert.match(src, /stopped: \$\{plainly\(w\.error\)/, "the wait's error reaches the founder unscrubbed");
});
