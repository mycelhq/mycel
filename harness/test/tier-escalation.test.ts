// ONE MODEL FOR A WHOLE RUN IS ONE GUESS MADE BEFORE THE WORK STARTS.
//
// The usual alternative is to classify each turn's difficulty and route on it — another guess, made
// more often, by something that has not seen the answer either. There is a third signal and it is
// free: THE RUN ALREADY FAILED. A repair round only happens after a workspace failed verification,
// so it is not a suspicion that the task is hard, it is proof.
//
// That is also where the money is. models.ts records what being out of depth costs: a `chase_invoice`
// on `fast` "tried again, identically, ELEVEN times ... 233 events, twenty-five minutes, killed by
// the runtime ceiling with nothing delivered." Per token `fast` is 4× cheaper; per delivered answer
// it was infinitely more expensive. Escalating a proven-hard round is the cheap move — the loop is
// what costs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { escalatedTier } from "../src/models";

test("a normal run is untouched", () => {
  for (const t of ["fast", "standard", "deep"] as const) {
    assert.equal(escalatedTier(t, 0, "scale"), t);
    assert.equal(escalatedTier(t, -1, "scale"), t, "a nonsense round must not move anything");
    assert.equal(escalatedTier(t, NaN, "scale"), t);
  }
});

test("one step per round, on proof rather than suspicion", () => {
  assert.equal(escalatedTier("fast", 1, "scale"), "standard");
  assert.equal(escalatedTier("fast", 2, "scale"), "deep");
  assert.equal(escalatedTier("standard", 1, "scale"), "deep");
});

test("it stops at the top rather than wrapping or throwing", () => {
  assert.equal(escalatedTier("deep", 1, "scale"), "deep");
  assert.equal(escalatedTier("fast", 99, "scale"), "deep");
});

test("the plan's ceiling is the ceiling, even after two failures", () => {
  // A Starter org does not get the deep tier because its build failed twice. `wasClamped` already
  // says the ceiling bit out loud when it bites; this must not quietly route around it.
  assert.equal(escalatedTier("standard", 2, "starter"), "standard");
  assert.equal(escalatedTier("fast", 2, "starter"), "standard");
  assert.equal(escalatedTier("fast", 1, "free"), "standard");
});

test("an unlimited org is not bound by its plan row", () => {
  assert.equal(escalatedTier("standard", 1, "starter", true), "deep");
});

test("it never goes downward — a chosen tier is not demoted to save money on a retry", () => {
  // A wedge manifest asking for `deep` gets `deep` on round zero. Quietly demoting it would make
  // the second attempt worse than the first, which is the opposite of the point.
  for (const round of [1, 2, 3]) {
    assert.equal(escalatedTier("deep", round, "scale"), "deep");
    assert.notEqual(escalatedTier("standard", round, "scale"), "fast");
  }
});

test("the runtime escalates off the repair round and says so", () => {
  const src = readFileSync(new URL("../src/runtime.ts", import.meta.url).pathname, "utf8");
  assert.match(src, /escalatedTier\(profile\.tier, repairRound, plan, unlimited\)/);
  assert.match(src, /repair_round/, "the signal comes from the orchestrator's repair loop");
  // Visible, for the same reason the plan clamp is: a founder comparing two rounds should not have
  // to guess why the second reads better, or costs more.
  assert.match(src, /this round runs on the \$\{tier\} model instead of \$\{profile\.tier\}/);
});

test("an explicit model on the task still wins — an operator debugging one run is not escalated", () => {
  const src = readFileSync(new URL("../src/runtime.ts", import.meta.url).pathname, "utf8");
  const at = src.indexOf("typeof task.input?.model === \"string\"");
  assert.ok(at > 0, "the explicit-model override moved");
  assert.ok(at > src.indexOf("const tier: ModelTier"), "the override is read after the tier, and beats it");
});
