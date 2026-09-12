// What to post, where, and when — with nothing that publishes.
//
// The founder's instruction was explicit: do not automate posting to Reddit, just tell me what to
// post and where, on a schedule. That is the right call for a reason bigger than Reddit — posting
// under somebody's own name is public and permanent, and `packages/linkedin` bans it from automation
// for exactly that. What a founder actually needs is not a robot with their password. It is to stop
// opening a blank box on a Sunday night wondering what to write.
//
// So this schedules and never sends, and the tests below are mostly about the four rules that make a
// calendar one a person keeps rather than one they abandon in week two.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import contentCalendar, { type PlannedPiece } from "../../workflows/content-calendar.mjs";

/** `as const` so `effort` narrows to the enum rather than widening to `string`. */
const PLAN: PlannedPiece[] = [
  { what: "Answer the gummy-crumb question with photos", where: "r/Breadit", why: "asked four times this month", effort: "small" },
  { what: "The real cost of a bakery POS, itemised", where: "LinkedIn", why: "nobody publishes the numbers", effort: "medium" },
  { what: "Our 2026 wholesale margin survey", where: "your blog", why: "original data nobody can copy", effort: "large" },
  { what: "What we learned pricing by weight", where: "LinkedIn", why: "proves the survey", effort: "small" },
];

/** A Monday. */
const START = "2026-09-07";

test("every date is a weekday", () => {
  // A post timestamped Sunday reads as a scheduling tool, which is the one thing it must not read as.
  const r = contentCalendar({ plan: PLAN, start: START, per_week: 2 });
  for (const s of r.scheduled) {
    const day = new Date(`${s.when}T00:00:00Z`).getUTCDay();
    assert.ok(day >= 1 && day <= 5, `${s.what} lands on day ${day}`);
  }
});

test("nothing goes to the same place twice in one day", () => {
  // Two posts to one channel on one day is the pattern every community reads as flooding, and on
  // Reddit it is how an account gets filtered.
  const sameDay = [
    { what: "A", where: "LinkedIn", why: "x" },
    { what: "B", where: "LinkedIn", why: "y" },
    { what: "C", where: "LinkedIn", why: "z" },
  ];
  const r = contentCalendar({ plan: sameDay, start: START, per_week: 7 });
  const seen = new Set<string>();
  for (const s of r.scheduled) {
    const key = `${s.where.toLowerCase()}|${s.when}`;
    assert.ok(!seen.has(key), `two things on ${s.where} on ${s.when}`);
    seen.add(key);
  }
});

test("a large piece takes the room a large piece needs", () => {
  // Original work is not an afternoon. The week it lands in must not also carry two other pieces, or
  // the calendar is a fiction on the day it is handed over.
  const r = contentCalendar({ plan: PLAN, start: START, per_week: 2 });
  const large = r.scheduled.find((s) => s.effort === "large")!;
  const after = r.scheduled[r.scheduled.indexOf(large) + 1]!;
  const gapDays = (Date.parse(`${after.when}T00:00:00Z`) - Date.parse(`${large.when}T00:00:00Z`)) / 86_400_000;
  const small = r.scheduled[0]!;
  const nextSmall = r.scheduled[1]!;
  const normal = (Date.parse(`${nextSmall.when}T00:00:00Z`) - Date.parse(`${small.when}T00:00:00Z`)) / 86_400_000;
  assert.ok(gapDays > normal, `large got ${gapDays}d, a normal gap is ${normal}d`);
});

test("the cadence is the one the founder said they could keep", () => {
  // A calendar that assumes five a week is a calendar abandoned in week two — and an abandoned
  // calendar is worse than none, because it also carries the evidence that they abandoned it.
  const twice = contentCalendar({ plan: PLAN, start: START, per_week: 2 });
  const daily = contentCalendar({ plan: PLAN, start: START, per_week: 5 });
  assert.ok(Date.parse(daily.through!) < Date.parse(twice.through!), "five a week finishes sooner than two");
  assert.equal(twice.scheduled.length, PLAN.length, "nothing is dropped to fit a cadence");
  assert.equal(daily.scheduled.length, PLAN.length);
});

test("it is the same calendar every time it is run", () => {
  // A founder re-reading Monday's list on Wednesday must see the same thing. A workflow that read a
  // clock would quietly reschedule itself between two glances.
  const a = contentCalendar({ plan: PLAN, start: START, per_week: 2 });
  const b = contentCalendar({ plan: PLAN, start: START, per_week: 2 });
  assert.deepEqual(a, b);
  // And it refuses to guess the date rather than defaulting to today.
  assert.throws(() => contentCalendar({ plan: PLAN } as unknown as Parameters<typeof contentCalendar>[0]), /start is required/);
  assert.throws(() => contentCalendar({ plan: [], start: START }), /must not be empty/);
});

test("the headline is what to do, not a count of rows", () => {
  const r = contentCalendar({ plan: PLAN, start: START, per_week: 2 });
  assert.match(r.headline, /4 pieces between 2026-09-07 and/);
  assert.match(r.headline, /2 a week/);
  // The channels are named, because "across 3 channels" tells a founder nothing they can act on.
  assert.match(r.headline, /r\/Breadit/);
  assert.equal(r.next!.when, "2026-09-07");
  assert.equal(r.next!.where, "r/Breadit");

  const one = contentCalendar({ plan: [PLAN[0]!], start: START });
  assert.equal(one.headline, "One piece to post, on 2026-09-07.");
});

test("nothing in here can post anything", () => {
  // The guarantee, asserted rather than assumed. A future edit that reached for a network call would
  // have to delete this test to do it.
  const src = readFileSync(new URL("../../workflows/content-calendar.mjs", import.meta.url), "utf8");
  for (const banned of ["fetch(", "http", "require(", "import(", "process.env"]) {
    assert.equal(src.includes(banned), false, `content-calendar must not reference ${banned}`);
  }
});
