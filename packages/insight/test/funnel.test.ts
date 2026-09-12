// Funnel maths. Pinned here because the kernel keeps its own copy of these formulas
// (`kernel/harness/src/insight/funnel.ts`) and the two must not drift — a dashboard and an SDK
// disagreeing about a conversion rate is the kind of bug that gets argued about instead of fixed.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { analyseFunnel, defineFunnel, stepIndex } from "../src/funnel";

const intake = defineFunnel("intake", ["viewed", "started", "submitted", "paid"]);

test("a declaration normalises names and rejects a broken one", () => {
  assert.deepEqual(defineFunnel("Intake", ["  Viewed ", "Started"]).steps, ["viewed", "started"]);
  assert.equal(defineFunnel("Intake", ["a", "b"]).name, "intake");
  // A duplicate step would make `from_previous` compare a step against itself: a declaration bug,
  // caught where the fix is obvious rather than as a strange number three weeks later.
  assert.throws(() => defineFunnel("x", ["a", "a"]), /duplicate/);
  assert.throws(() => defineFunnel("x", ["a"]), /at least two/);
  assert.equal(stepIndex(intake, "SUBMITTED"), 2);
  assert.equal(stepIndex(intake, "nope"), -1);
});

test("drop-off is arithmetic, not a judgement", () => {
  const r = analyseFunnel(intake, { viewed: 100, started: 60, submitted: 50, paid: 10 });
  assert.equal(r.entered, 100);
  assert.equal(r.completed, 10);
  assert.equal(r.completion_rate, 0.1);
  assert.deepEqual(
    r.steps.map((s) => s.from_start),
    [1, 0.6, 0.5, 0.1],
  );
  assert.equal(r.steps[1]?.from_previous, 0.6);
  assert.equal(r.steps[3]?.loss_rate, 0.8);
  // 40 lost at the first transition, 40 at the last — the tie breaks EARLIEST, because fixing an
  // early step also feeds every step after it.
  assert.deepEqual(r.biggest_drop_off, { from: "viewed", to: "started", lost: 40, loss_rate: 0.4 });
});

test("the worst transition is the one that loses the most people, not the highest percentage", () => {
  const r = analyseFunnel(intake, { viewed: 1000, started: 400, submitted: 399, paid: 1 });
  // "submitted → paid" loses 99.7% and 398 people; "viewed → started" loses 60% and 600. The
  // second is the one worth a task, and pointing an agent at the first costs a task and buys
  // nothing.
  assert.equal(r.biggest_drop_off?.from, "viewed");
  assert.equal(r.biggest_drop_off?.lost, 600);
});

test("counts are clamped monotonic so a double submit can't report 120% conversion", () => {
  const r = analyseFunnel(intake, { viewed: 10, started: 8, submitted: 12, paid: 4 });
  assert.equal(r.steps[2]?.count, 12, "the raw count stays visible");
  assert.equal(r.steps[2]?.reached, 8, "but the maths uses the clamped one");
  assert.equal(r.steps[2]?.from_start, 0.8);
  assert.ok(r.completion_rate <= 1);
});

test("an empty funnel is zeroes, never NaN", () => {
  const r = analyseFunnel(intake, {});
  assert.equal(r.entered, 0);
  assert.equal(r.completion_rate, 0);
  assert.equal(r.biggest_drop_off, null);
  for (const s of r.steps) {
    assert.ok(Number.isFinite(s.from_start));
    assert.ok(Number.isFinite(s.from_previous));
    assert.ok(Number.isFinite(s.loss_rate));
  }
  // Negative and fractional inputs are nonsense that must not propagate into a rate.
  const weird = analyseFunnel(intake, { viewed: -5, started: 2.7 });
  assert.equal(weird.entered, 0);
  assert.equal(weird.steps[1]?.count, 2);
});
