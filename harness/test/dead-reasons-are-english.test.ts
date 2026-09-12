/**
 * WHAT A STALLED ENGAGEMENT SAYS TO THE PERSON WHO OWNS IT.
 *
 * A `dead` reason from `evaluateWait` is not a log line. It travels up through the wait sweep and
 * is rendered verbatim on Home, inside the sentence explaining why an engagement stopped. On the
 * live demo it read:
 *
 *   "every way out of this wait is closed: their answer on 'Calder Dental — February visibility'
 *    (deliverable e24996dc9-e8df-4ec9-aa58-ee00d51f4ce3 is not in this project)"
 *
 * Two faults in one clause. A UUID is never a thing to show a person — the same defect
 * `cloud/lib/client-name.ts` exists for, one process away. And "is not in this project" describes
 * our tenancy model rather than what happened to their work.
 *
 * The ids are still wanted when these fire. They go to `console.error`, where the person who can
 * use them looks.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/waits.ts", import.meta.url), "utf8");
// Comments quote the old wording on purpose; this is about strings a founder reads.
const code = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

test("no dead reason interpolates anything", () => {
  // Deliberately stricter than "no UUID": every value this branch has to hand IS an identifier, so
  // the rule that survives contact is that these sentences are literals.
  const bad = [...code.matchAll(/dead:\s*[`"']([^`"']*)[`"']/g)]
    .map((m) => m[1]!)
    .filter((s) => s.includes("${"));
  assert.deepEqual(bad, [], `a dead reason still interpolates:\n  ${bad.join("\n  ")}`);
});

test("no dead reason talks about projects", () => {
  // "is not in this project" / "belongs to a different project" are true and useless: a founder has
  // one business and did not put anything in the wrong one.
  const reasons = [...code.matchAll(/dead:\s*[`"']([^`"']*)[`"']/g)].map((m) => m[1]!);
  assert.ok(reasons.length >= 5, `only found ${reasons.length} dead reasons — did the shape change?`);
  for (const r of reasons) {
    assert.doesNotMatch(r, /\bproject\b/i, `dead reason exposes the tenancy model: "${r}"`);
  }
});

test("the ids that were dropped are logged instead", () => {
  // Losing them entirely would trade a bad founder experience for a bad on-call one.
  for (const probe of [
    /names request \$\{c\.request_id\}/,
    /names invoice \$\{c\.invoice_id\}/,
    /names deliverable \$\{c\.deliverable_id\}/,
    /names thread \$\{c\.thread_id\}/,
  ]) {
    assert.match(code, probe, `an id was dropped without being logged: ${probe}`);
  }
});

test("each reason reads as a sentence about their work", () => {
  const reasons = [...code.matchAll(/dead:\s*[`"']([^`"']*)[`"']/g)].map((m) => m[1]!);
  for (const r of reasons) {
    assert.ok(r.split(" ").length >= 4, `not a sentence: "${r}"`);
    assert.doesNotMatch(r, /[_:]|[0-9a-f]{8}-/, `identifier-shaped text in a reason: "${r}"`);
  }
});
