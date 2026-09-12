// The five tokens a schedule template may use, as a table.
//
// Every one of these is a date the manifest cannot know when it is written and the clock knows when
// it fires. The bug they exist to end: a monthly close scheduled with an empty input, declaring
// `period` REQUIRED, firing 3,077 times in a fortnight as a close of nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SCHEDULE_TOKENS, fillScheduleInput } from "../src/schedule-input";

const at = (iso: string) => new Date(iso);

test("month_ended is the month BEFORE the one it fires in", () => {
  /**
   * The whole point, and the easiest thing to get backwards. A close fires on the 1st and covers
   * what just finished; `this_month` would close a month still in progress and produce figures that
   * change the next day.
   */
  assert.equal(SCHEDULE_TOKENS.month_ended(at("2026-09-01T09:00:00Z")), "2026-08");
  assert.equal(SCHEDULE_TOKENS.month_ended(at("2026-09-30T23:59:00Z")), "2026-08");
  // Across a year boundary, which is where a naive `month - 1` produces "2026-00".
  assert.equal(SCHEDULE_TOKENS.month_ended(at("2026-01-01T09:00:00Z")), "2025-12");
});

test("this_month is the month it fires in", () => {
  assert.equal(SCHEDULE_TOKENS.this_month(at("2026-09-01T00:00:00Z")), "2026-09");
  assert.equal(SCHEDULE_TOKENS.this_month(at("2026-01-31T23:00:00Z")), "2026-01");
});

test("week_ended is the last COMPLETE week, whatever day the schedule runs", () => {
  /**
   * A half-week is not a reporting period. A weekly job that fires on Monday and one that fires on
   * Wednesday must name the same finished week, or two of a client's reports are not comparable.
   */
  const week = "2026-09-06"; // a Sunday
  for (const day of ["2026-09-07", "2026-09-09", "2026-09-12"]) {
    assert.equal(SCHEDULE_TOKENS.week_ended(at(`${day}T09:00:00Z`)), week, `fired ${day}`);
  }
  // And a Sunday run reports the week BEFORE itself, not the day it is standing on.
  assert.equal(SCHEDULE_TOKENS.week_ended(at("2026-09-13T09:00:00Z")), "2026-09-06");
});

test("quarter_ended crosses the year correctly", () => {
  assert.equal(SCHEDULE_TOKENS.quarter_ended(at("2026-09-01T00:00:00Z")), "2026-Q2");
  assert.equal(SCHEDULE_TOKENS.quarter_ended(at("2026-04-02T00:00:00Z")), "2026-Q1");
  // Q1 of a year reports the previous year's Q4 — the case a modulo alone gets wrong.
  assert.equal(SCHEDULE_TOKENS.quarter_ended(at("2026-02-11T00:00:00Z")), "2025-Q4");
});

test("everything is UTC, so a firm's month does not end on the server's clock", () => {
  // 23:30 on the last of August in UTC is already September in Sydney. The period is UTC's.
  assert.equal(SCHEDULE_TOKENS.this_month(at("2026-08-31T23:30:00Z")), "2026-08");
});

test("a whole value is filled and a sentence is left alone", () => {
  const now = at("2026-09-01T09:00:00Z");
  const out = fillScheduleInput(
    { period: "{{month_ended}}", spaced: "{{ month_ended }}", prose: "the {{month_ended}} close", n: 3 },
    now,
  );
  assert.equal(out.period, "2026-08");
  assert.equal(out.spaced, "2026-08", "whitespace inside the braces should be tolerated");
  assert.equal(
    out.prose,
    "the {{month_ended}} close",
    "interpolating into a sentence is how a token expander becomes a template language",
  );
  assert.equal(out.n, 3, "non-strings pass through untouched");
});

test("AN UNKNOWN TOKEN IS LEFT ALONE, NOT BLANKED", () => {
  /**
   * The failure mode this chooses between. Blanking produces a close of the empty string, which
   * satisfies a `type: string` contract and reaches the model as a period of nothing. Leaving it
   * produces `$.period: required`-shaped noise or a visibly wrong literal, both of which name the
   * field. The loud wrong answer beats the quiet one.
   */
  const out = fillScheduleInput({ period: "{{munth_ended}}" }, at("2026-09-01T09:00:00Z"));
  assert.equal(out.period, "{{munth_ended}}");
});

test("nested objects fill one level down, and arrays are left alone", () => {
  const out = fillScheduleInput(
    { window: { from: "{{month_ended}}" }, list: ["{{month_ended}}"] },
    at("2026-09-01T09:00:00Z"),
  );
  assert.deepEqual(out.window, { from: "2026-08" });
  assert.deepEqual(out.list, ["{{month_ended}}"], "an array of tokens has no use case and inventing one is the next mistake");
});

test("an empty or missing input is an empty object, never a throw", () => {
  // This runs on the path that fires every scheduled job in production. It may not have a bad day.
  assert.deepEqual(fillScheduleInput(undefined, new Date()), {});
  assert.deepEqual(fillScheduleInput({}, new Date()), {});
});
