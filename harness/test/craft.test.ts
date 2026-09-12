// THE CRAFT THAT BELONGS TO NO TRADE.
//
// A model playing a paying client rejected the same deliverable six times, and not one complaint was
// about bookkeeping: "you sent me an account of the work rather than the work", "you say reconciled
// and show no reconciliation", "a retainer should buy a clear recommendation and an efficient
// evidence request, not a list of ambiguities pushed back to me".
//
// All three are true of a GEO report, a screened longlist, an answered questionnaire and a finished
// site. All three had been written down inside books-keeper as though they were accounting rules,
// because that is the trade whose deliverable happened to be under a microscope. A new trade would
// have rediscovered each one the same way — through a rejected deliverable.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { sharedCraft } from "../src/craft";

test("the shared craft loads, and carries the rules a client actually named", () => {
  const craft = sharedCraft();
  assert.ok(craft.length > 0, "craft/ should ship at least one file");
  const all = craft.map((c) => c.content).join("\n");
  // Each of these is a client complaint that turned out to be trade-agnostic.
  assert.match(all, /not an account of the work/i);
  assert.match(all, /could not establish/i);
  assert.match(all, /evidence/i);
  assert.match(all, /scope you were not given/i);
  assert.match(all, /recommendation/i);
  assert.match(all, /written LAST, from the files/i);
});

test("craft is namespaced so a founder can tell it from their own trade's", () => {
  // A trace showing `chase-politely` and `delivering-work` side by side, with no marker, reads as if
  // the business declared both. One of them is ours.
  for (const c of sharedCraft()) assert.match(c.name, /^craft:/);
});

test("a missing craft directory mounts nothing rather than failing the run", () => {
  // Same call exemplarSkills makes: a run that refuses to start over the absence of general advice
  // would be trading the job for the lesson.
  assert.deepEqual(sharedCraft("/definitely/not/a/directory"), []);
});

test("craft does not live in wedges/, because it is not a trade", () => {
  /**
   * It did for about a minute and two of this repo's own guards caught it: the wedge-manifest tests
   * read every directory under wedges/ as a trade, and a separate test forbids naming a wedge
   * directory as a string literal in kernel source. Both were right, and the fix was to move the
   * folder rather than to teach the tests an exception.
   */
  assert.ok(!existsSync(join(process.cwd(), "wedges", "_craft")), "craft/ belongs beside wedges/, not inside it");
});
