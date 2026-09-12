// THE TRIAL — every threshold in it, argued with.
//
// The constants are exported precisely so these tests can name them: a constant nobody can see is a
// constant nobody can challenge, and each one below is a decision about how much churn a founder's
// procedures should suffer on the strength of a model's opinion.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHALLENGER_SHARE,
  MIN_MARGIN,
  MIN_PER_ARM,
  armFor,
  armOf,
  judgeTrial,
} from "../src/skill-trial";
import { challengerFor } from "../src/models";

const arm = (decisions: number, released: number, paid = 0) => ({ decisions, released, paid });

test("a clear win is promoted", () => {
  const v = judgeTrial(arm(10, 5), arm(10, 9));
  assert.equal(v.outcome, "promote");
  assert.equal(v.incumbent_rate, 0.5);
  assert.equal(v.challenger_rate, 0.9);
  assert.match(v.why, /90% .*50%/);
});

test("a clear loss keeps the incumbent", () => {
  const v = judgeTrial(arm(10, 9), arm(10, 3));
  assert.equal(v.outcome, "keep_incumbent");
  assert.match(v.why, /Keeping the current procedure/);
});

test("equal is not better", () => {
  // The tie-break that matters: the incumbent has history, the challenger has a model's opinion, and
  // churning a procedure the founder had learned to predict costs something neither rate shows.
  const v = judgeTrial(arm(10, 7), arm(10, 7));
  assert.equal(v.outcome, "keep_incumbent");
  assert.match(v.why, /Equal is not better/);
});

test("a lead smaller than the margin is noise, not a result", () => {
  // At eight per arm one deliverable moves the rate 12.5 points, so anything under the margin is a
  // coin landing. This is the assertion that stops a procedure churning every month for ever.
  // Exactly at the threshold, from both directions of the float error. 9/10 - 8/10 lands at
  // 0.10000000000000009 and other equally-spaced pairs land just under, so both must promote or the
  // rule is a coin flip dressed up as a threshold.
  assert.equal(judgeTrial(arm(10, 7), arm(10, 8)).outcome, "promote", "exactly the margin clears it");
  assert.equal(judgeTrial(arm(10, 8), arm(10, 9)).outcome, "promote", "and so does the other rounding");
  assert.equal(judgeTrial(arm(20, 14), arm(20, 16)).outcome, "promote", "and at a different denominator");

  const narrow = judgeTrial(arm(20, 14), arm(20, 15)); // +5 points
  assert.equal(narrow.outcome, "keep_incumbent");
  assert.match(narrow.why, /inside the noise/);
});

test("neither arm may be thin, and the message says how thin", () => {
  // Three deliverables to two is not a result. Without the floor, the first challenger to get lucky
  // on its opening run is promoted for ever and every later one is measured against a fluke.
  const v = judgeTrial(arm(MIN_PER_ARM, MIN_PER_ARM), arm(2, 2));
  assert.equal(v.outcome, "running");
  assert.equal(v.needs, MIN_PER_ARM - 2);
  assert.match(v.why, new RegExp(`${MIN_PER_ARM - 2} more settled deliverable`));

  // And a thin INCUMBENT stops it just as firmly — a perfect challenger against nothing is nothing.
  const other = judgeTrial(arm(1, 1), arm(30, 30));
  assert.equal(other.outcome, "running");
});

test("a trial that is decided does not linger", () => {
  // An inconclusive trial left running is a permanent tax on quality that nobody remembers switching
  // on. Once both arms are past the floor, every outcome is terminal.
  for (const [i, c] of [
    [arm(MIN_PER_ARM, 8), arm(MIN_PER_ARM, 0)],
    [arm(MIN_PER_ARM, 4), arm(MIN_PER_ARM, 4)],
    [arm(MIN_PER_ARM, 0), arm(MIN_PER_ARM, 8)],
  ] as const) {
    assert.notEqual(judgeTrial(i, c).outcome, "running");
  }
});

test("an empty arm has a rate of zero rather than a division by zero", () => {
  const v = judgeTrial(arm(0, 0), arm(0, 0));
  assert.equal(v.incumbent_rate, 0);
  assert.equal(v.challenger_rate, 0);
  assert.equal(v.outcome, "running");
});

test("the split is derived from the task, so it never answers twice", () => {
  // A random draw would let one deliverable be counted in both arms when a run is re-read or
  // reported on later, which corrupts the only evidence the trial has.
  for (const id of ["task-1", "abc", "a1b2c3d4-e5f6", ""]) {
    assert.equal(armFor(id), armFor(id), id);
  }
});

test("the split lands near the share, and never inverts", () => {
  // `Math.imul` yields a signed 32-bit value; without the >>> 0 a negative numerator puts a fifth of
  // tasks on the wrong side of every comparison, which is invisible until the arms look wrong.
  let challengers = 0;
  const N = 4000;
  for (let i = 0; i < N; i++) if (armFor(`task-${i}`) === "challenger") challengers += 1;
  const share = challengers / N;
  assert.ok(share > 0.15 && share < 0.25, `share was ${share}`);
  assert.ok(Math.abs(share - CHALLENGER_SHARE) < 0.04);
});

test("a run with no identity takes the safe arm", () => {
  assert.equal(armFor(""), "incumbent");
  assert.equal(armFor(undefined as never), "incumbent");
});

test("a share of zero runs no experiment at all", () => {
  // The kill switch. Every task must land on the incumbent, not almost every task.
  for (let i = 0; i < 500; i++) assert.equal(armFor(`task-${i}`, 0), "incumbent");
});

test("armOf reads a scale row, and a missing row is an empty arm", () => {
  assert.deepEqual(armOf(undefined), { decisions: 0, released: 0, paid: 0 });
  assert.deepEqual(
    armOf({ founder_total: 9, released: 6, paid: 2 }),
    { decisions: 9, released: 6, paid: 2 },
  );
});

test("payment is carried but never decides", () => {
  // Reported so a human reading the result can see it; not decisive, because a trial decided on
  // money would take a year and would mostly measure how well the founder chases invoices.
  const v = judgeTrial(arm(10, 9, 0), arm(10, 3, 40));
  assert.equal(v.outcome, "keep_incumbent", "forty paid invoices do not rescue a worse procedure");
  assert.ok(MIN_MARGIN > 0 && MIN_PER_ARM > 0);
});

/**
 * ═══ THE MODEL TRIAL: THE WIRE THAT MAKES `armFor` USABLE FOR WHAT ITS CALLERS CITE IT FOR ═══
 *
 * models.ts and harness.ts both defer the model decision to "a trial with armFor", and until
 * `challengerFor` existed there was no way to run one — armFor only ever picked a skill overlay.
 * These pin the properties that make it safe to leave switched on in production.
 */
test("no trial configured means no behaviour at all", () => {
  delete process.env.MYCEL_MODEL_TRIAL;
  delete process.env.MYCEL_MODEL_TRIAL_TIER;
  assert.equal(challengerFor("standard", "challenger"), undefined);
  assert.equal(challengerFor("standard", "incumbent"), undefined);
});

test("the incumbent arm is never diverted, even mid-trial", () => {
  process.env.MYCEL_MODEL_TRIAL = "deepseek/deepseek-v4-pro";
  try {
    assert.equal(challengerFor("standard", "incumbent"), undefined);
    assert.equal(challengerFor("standard", "challenger"), "deepseek/deepseek-v4-pro");
  } finally {
    delete process.env.MYCEL_MODEL_TRIAL;
  }
});

/**
 * Without this, a challenger run would swap the model for its `fast` classification calls too.
 * That is a different question with a different right answer, and a trial that changes two things
 * at once has measured neither.
 */
test("a trial touches only the tier under test", () => {
  process.env.MYCEL_MODEL_TRIAL = "x/challenger";
  process.env.MYCEL_MODEL_TRIAL_TIER = "deep";
  try {
    assert.equal(challengerFor("deep", "challenger"), "x/challenger");
    assert.equal(challengerFor("fast", "challenger"), undefined);
    assert.equal(challengerFor("standard", "challenger"), undefined);
  } finally {
    delete process.env.MYCEL_MODEL_TRIAL;
    delete process.env.MYCEL_MODEL_TRIAL_TIER;
  }
});

test("a nonsense tier name disables the trial rather than matching everything", () => {
  process.env.MYCEL_MODEL_TRIAL = "x/challenger";
  process.env.MYCEL_MODEL_TRIAL_TIER = "expensive";
  try {
    for (const t of ["fast", "standard", "deep"] as const) {
      assert.equal(challengerFor(t, "challenger"), undefined, t);
    }
  } finally {
    delete process.env.MYCEL_MODEL_TRIAL;
    delete process.env.MYCEL_MODEL_TRIAL_TIER;
  }
});

/** A retried deliverable must land in the arm it started in, or it is counted on both sides. */
test("the arm survives a retry of the same task", () => {
  process.env.MYCEL_MODEL_TRIAL = "x/challenger";
  try {
    for (let i = 0; i < 200; i++) {
      const id = `deliverable-${i}`;
      assert.equal(challengerFor("standard", armFor(id)), challengerFor("standard", armFor(id)), id);
    }
  } finally {
    delete process.env.MYCEL_MODEL_TRIAL;
  }
});
