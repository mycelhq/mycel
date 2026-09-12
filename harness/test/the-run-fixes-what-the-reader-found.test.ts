// THE REVIEWER NAMED THE FAULT AND NOTHING COULD ACT ON IT.
//
// ═══ WHAT WAS ALREADY THERE ═══
//
// The harness reads its own finished work before delivering it. `reviewVersion` fetches the real
// artifact bytes, `reviewDeliverable` grades them against the trade's criteria, and `gradeAllows`
// refuses to auto-release anything with a disqualifying fault — or anything that could not be read
// at all, because "a standing permission buys the founder's absence, not the reviewer's".
//
// Measured on a real deliverable: handed a well-formed configuration note instead of the weekly
// digest it was asked for, the reviewer scored the artefact 0 and wrote "this is a pre-delivery
// configuration note, not the report". Exactly right, and exactly actionable.
//
// ═══ AND NOTHING ACTED ON IT ═══
//
// The run was over. The sandbox was still alive for another few hundred lines. The only outcome was
// a hold: a founder opening a job that needs rewriting, with the rewrite note already written by a
// machine that could not do anything with it.
//
// ═══ WHY THIS CANNOT MAKE A GOOD DELIVERY WORSE ═══
//
// The repair is only reachable when the verdict names something DISQUALIFYING — precisely the
// condition that was about to hold the work for a person. Nothing that would have auto-released
// enters the branch. Worst case is a repair that is no better and the same hold one pass later.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const wrap = readFileSync(new URL("../src/deliverables.wrap.ts", import.meta.url), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/^\s*\/\/.*$/gm, " ");
const orch = readFileSync(new URL("../src/orchestrator.ts", import.meta.url), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/^\s*\/\/.*$/gm, " ");

test("a repair is only attempted on a verdict that named something disqualifying", () => {
  /**
   * The safety property, and the only one that makes this change safe to put on the path that
   * reaches paying clients. An unreachable reviewer must NOT trigger a rewrite: that already holds
   * the work unread, which is the correct answer to "we could not check it", and rewriting on it
   * would spend a model pass on work nobody has found fault with.
   */
  assert.match(
    wrap,
    /const serious = review\?\.reviewed \? \(review\.verdict\?\.serious \?\? \[\]\) : \[\];/,
    "the repair trigger no longer requires a successful review",
  );
  assert.match(
    wrap,
    /if \(args\.repair && serious\.length > 0\)/,
    "the repair can now fire without a disqualifying fault — it may run on work that would have shipped",
  );
});

test("a repair is kept only when it has fewer disqualifying faults", () => {
  /**
   * "It ran again" is not evidence of improvement — the same reasoning this repo records as
   * `a-guard-can-run-and-do-nothing`. A rewrite that introduced a NEW disqualifying fault is worse
   * than the original, and an unreadable second version must not displace a readable first one.
   *
   * `Number.POSITIVE_INFINITY` for an unreviewable retry is what makes that last case fall the right
   * way: it compares as worse than any real count, so the original stands.
   */
  assert.match(wrap, /const after = second\?\.reviewed \? \(second\.verdict\?\.serious \?\? \[\]\)\.length : Number\.POSITIVE_INFINITY;/);
  assert.match(wrap, /if \(after < before\)/, "a repair is now kept without being better");
});

test("the repair carries the reader's own words, not a paraphrase", () => {
  /*
    The schema retry next door works because it hands over the validator's specific message rather
    than "try again". Same reason here: "an invented figure in the third table" is actionable and
    "the reviewer was unhappy" is not.
  */
  assert.match(orch, /faults\.join\("; "\)/, "the faults are no longer passed through verbatim");
  assert.match(orch, /review_retry: true/, "the run cannot tell a repair pass from a first attempt");
  /*
    Matched on a CONTIGUOUS phrase. The instruction spans two template literals — "Do not start " +
    "the job over" — so a regex across the seam depends on how the concatenation happens to be
    wrapped, which is formatting, not behaviour.
  */
  assert.match(orch, /do not argue with the reader/, "the repair no longer tells the run to keep the work it already did");
});

test("one round, in the sandbox already paid for, and never on mock", () => {
  /**
   * A model that fails twice with the reason in front of it does not know the answer; a second round
   * buys a longer wait for the same hold. And canned mock output is not a rewrite — making every
   * mock test pay for a pass that cannot change anything would slow the suite for nothing.
   */
  assert.match(orch, /if \(useMock \|\| !sandbox\) return undefined;/, "mock runs or a dead sandbox now attempt a repair");
  // No loop: the wrap calls repair from a straight-line block, not from a while/for.
  const block = wrap.slice(wrap.indexOf("if (args.repair && serious.length > 0)"), wrap.indexOf("const gradeAllows"));
  assert.ok(block.length > 100, "could not isolate the repair block — this guard is measuring nothing");
  assert.ok(!/\b(while|for)\s*\(/.test(block), "the repair became a loop — one round is the rule");
});

test("only the artefacts the repair actually wrote are re-graded", () => {
  /*
    A repair that produced nothing new must return nothing, rather than re-offering the same bytes
    and inviting a second grade of work that did not change. Measured by diffing the task's artefacts
    across the pass, and excluding `result.txt`, which every run writes.
  */
  assert.match(orch, /!before\.has\(a\.id\) && a\.name !== "result\.txt"/, "unchanged artefacts can be re-offered as a repair");
  assert.match(orch, /return after\.length \? after\.map\(\(a\) => a\.id\) : undefined;/);
});
