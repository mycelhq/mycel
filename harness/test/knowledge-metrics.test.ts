import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MIN_DECISIONS,
  compareQuality,
  qualityByTaskType,
  qualityTrend,
} from "../src/knowledge-metrics";
import type { Observation } from "../src/knowledge.store";

let seq = 0;
const obs = (kind: Observation["kind"], taskType = "write_post"): Observation => ({
  id: `o${seq++}`,
  project_id: "p1",
  wedge: "w",
  task_type: taskType,
  kind,
  at: "2026-09-01T00:00:00.000Z",
});

const many = (kind: Observation["kind"], n: number, taskType?: string) =>
  Array.from({ length: n }, () => obs(kind, taskType));

test("under the floor it reports nothing rather than something shaped like an answer", () => {
  const t = qualityTrend([...many("approval_clean", 5), ...many("approval_edited", 3)]);
  assert.equal(t.reportable, false);
  assert.equal(t.cleanRate, 0, "no rate is published below the floor");
  assert.equal(t.decisions, 8);
  assert.match(t.summary, /8 of 20/);
  // The counts are still there — the caller may want them, it just may not have a rate.
  assert.equal(t.clean, 5);
  assert.equal(t.edited, 3);
});

test("a gap is not a failure and is not in the denominator", () => {
  // 15 clean + 5 edited = 20 decisions, plus 40 gaps that must not move the rate.
  const withGaps = qualityTrend([
    ...many("approval_clean", 15),
    ...many("approval_edited", 5),
    ...many("gap", 40),
  ]);
  const without = qualityTrend([...many("approval_clean", 15), ...many("approval_edited", 5)]);

  assert.equal(withGaps.decisions, 20, "gaps are excluded from the denominator");
  assert.equal(withGaps.cleanRate, 75);
  assert.equal(
    withGaps.cleanRate,
    without.cleanRate,
    "an agent that asks instead of guessing must not score worse than one that guesses and gets approved",
  );
  assert.equal(withGaps.gaps, 40);
  assert.match(withGaps.summary, /not an error/);
});

test("the rate is clean over every human verdict, rejections included", () => {
  const t = qualityTrend([
    ...many("approval_clean", 12),
    ...many("approval_edited", 6),
    ...many("approval_rejected", 2),
  ]);
  assert.equal(t.decisions, 20);
  assert.equal(t.cleanRate, 60);
  assert.equal(t.reportable, true);
  assert.match(t.summary, /60% of work went out exactly as drafted \(12 of 20\)/);
  assert.match(t.summary, /6 you rewrote/);
  assert.match(t.summary, /2 you sent back/);
});

test("feedback after the fact is counted and called out as already shipped", () => {
  const t = qualityTrend([...many("approval_clean", 20), ...many("feedback_bad", 3)]);
  assert.equal(t.feedbackBad, 3);
  assert.equal(t.decisions, 20, "post-hoc feedback is not an approval verdict");
  assert.equal(t.cleanRate, 100);
  assert.match(t.summary, /after the work had already gone out/);
});

test("an unrecognised kind is dropped, not bucketed as a failure", () => {
  const rogue = { ...obs("approval_clean"), kind: "something_new" } as unknown as Observation;
  const t = qualityTrend([...many("approval_clean", 20), rogue]);
  assert.equal(t.decisions, 20, "a future kind must not silently move this number");
  assert.equal(t.cleanRate, 100);
});

test("the split ranks worst first, and never-measured jobs sink to the bottom in volume order", () => {
  const rows = qualityByTaskType([
    // good: 18/20 clean
    ...many("approval_clean", 18, "chase_invoice"),
    ...many("approval_edited", 2, "chase_invoice"),
    // bad: 5/20 clean — this is the one eating the founder's week
    ...many("approval_clean", 5, "monthly_close"),
    ...many("approval_edited", 15, "monthly_close"),
    // under the floor, more of it
    ...many("approval_clean", 7, "draft_proposal"),
    // under the floor, less of it
    ...many("approval_clean", 2, "write_post"),
  ]);

  assert.deepEqual(
    rows.map((r) => r.taskType),
    ["monthly_close", "chase_invoice", "draft_proposal", "write_post"],
  );
  assert.equal(rows[0]!.cleanRate, 25);
  assert.equal(rows[1]!.cleanRate, 90);
  assert.equal(rows[2]!.reportable, false);
  assert.equal(rows[2]!.cleanRate, 0, "an unmeasured job gets no rate");
  assert.equal(rows[3]!.reportable, false);
});

test("a business-wide rate can hide a job that is failing", () => {
  const log = [
    ...many("approval_clean", 18, "chase_invoice"),
    ...many("approval_edited", 2, "chase_invoice"),
    ...many("approval_clean", 5, "monthly_close"),
    ...many("approval_edited", 15, "monthly_close"),
  ];
  const overall = qualityTrend(log);
  const worst = qualityByTaskType(log)[0]!;
  assert.equal(overall.cleanRate, 57.5);
  assert.equal(worst.cleanRate, 25);
  assert.ok(
    overall.cleanRate - worst.cleanRate > 30,
    "the headline number is why the split has to exist",
  );
});

test("gaps never reach the split — only verdicts do", () => {
  const rows = qualityByTaskType([...many("gap", 50, "monthly_close")]);
  assert.deepEqual(rows, [], "a job with nothing but gaps has no verdicts to rate");
});

test("improvement is stated in points, never as a percentage of a percentage", () => {
  const before = qualityTrend([...many("approval_clean", 8), ...many("approval_edited", 12)]); // 40%
  const after = qualityTrend([...many("approval_clean", 11), ...many("approval_edited", 14)]); // 44%
  assert.equal(before.cleanRate, 40);
  assert.equal(after.cleanRate, 44);

  const c = compareQuality(before, after);
  assert.equal(c.comparable, true);
  assert.equal(c.deltaPoints, 4);
  assert.match(c.summary, /4 percentage points better/);
  assert.match(c.summary, /40% → 44%/);
  // The tempting inflation is 10%. It must appear nowhere.
  assert.doesNotMatch(c.summary, /10%/);
});

test("a decline points at the split rather than just reporting the dip", () => {
  const before = qualityTrend([...many("approval_clean", 16), ...many("approval_edited", 4)]); // 80%
  const after = qualityTrend([...many("approval_clean", 10), ...many("approval_edited", 10)]); // 50%
  const c = compareQuality(before, after);
  assert.equal(c.deltaPoints, -30);
  assert.match(c.summary, /30 percentage points worse/);
  assert.match(c.summary, /job types/);
});

test("no change says it is not learning, which is the actionable reading", () => {
  const w = () => qualityTrend([...many("approval_clean", 10), ...many("approval_edited", 10)]);
  const c = compareQuality(w(), w());
  assert.equal(c.deltaPoints, 0);
  assert.match(c.summary, /not learning/);
  assert.match(c.summary, /corrections you are making are not reaching the next draft/);
});

test("a thin window refuses the comparison instead of flattering it", () => {
  const thin = qualityTrend([...many("approval_clean", 3)]);
  const fat = qualityTrend([...many("approval_clean", 20)]);
  for (const c of [compareQuality(thin, fat), compareQuality(fat, thin)]) {
    assert.equal(c.comparable, false);
    assert.equal(c.deltaPoints, 0);
    assert.match(c.summary, /too few reviewed decisions/);
  }
});

test("the floor agrees with the other two measurement modules", () => {
  assert.equal(MIN_DECISIONS, 20);
});
