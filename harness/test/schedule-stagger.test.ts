// SEVENTEEN PROJECTS, ONE SECOND.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// THE BURST THIS EXISTS TO PREVENT
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// `daily`, `weekly` and `monthly` cadences pin to an exact hour and minute, so every schedule
// sharing a cadence fires in the same second. With one project that is invisible. On 2026-09-05
// production had seventeen, each with its own `reflect_memory` at 03:00, `review_work` at 04:00 and
// `review_artifacts` at 05:00 — and the task table showed exactly that: 17 rows sharing a
// created_at, three times a night, every night.
//
// Each run holds a 10 GiB sandbox, so each burst asked for 170 GiB against a 300 GiB quota that
// already carried 135 GiB of snapshots. The nightly cluster of `Total disk limit exceeded` sat at
// 03:00-05:00 and nowhere else. Cleaning up dead sandboxes cannot help: those seventeen are all
// legitimately alive at the same moment.

import { test } from "node:test";
import assert from "node:assert/strict";
import { nextRun, firstRun, scheduleKey } from "../src/scheduler";
import type { Cadence } from "../src/contract";

const DAILY: Cadence = { kind: "daily", hour: 3, minute: 0 };
const FROM = new Date("2026-09-05T12:00:00.000Z");

test("no key means no change — every existing caller sees the instant it always did", () => {
  // The offset is opt-in. Every call site that does not know a schedule's identity must keep the
  // exact behaviour it had, which is what lets this ship without re-timing the whole scheduler.
  const d = nextRun(DAILY, FROM);
  assert.equal(d.toISOString(), "2026-09-06T03:00:00.000Z");
});

test("the same schedule lands on the same second every time", () => {
  // A schedule that wandered night to night would be worse than one that collides: nobody could
  // reason about when their work runs, and a run that drifts later each day eventually drifts into
  // the next job's window.
  const a = nextRun(DAILY, FROM, "sched-abc");
  const b = nextRun(DAILY, new Date("2026-10-11T12:00:00.000Z"), "sched-abc");
  assert.equal(a.getUTCMinutes(), b.getUTCMinutes());
  assert.equal(a.getUTCSeconds(), b.getUTCSeconds());
});

test("seventeen schedules do not stack on one minute", () => {
  // The real shape of the outage: 17 projects, one cadence. This does not need perfect spreading,
  // it needs the peak to stop being "all of them".
  const keys = Array.from({ length: 17 }, (_, i) => `project-${i}-reflect_memory`);
  const minutes = keys.map((k) => nextRun(DAILY, FROM, k).getUTCMinutes());
  const distinct = new Set(minutes);
  assert.ok(
    distinct.size >= 12,
    `17 schedules should spread across the hour, got ${distinct.size} distinct minutes: ${[...distinct].sort((x, y) => x - y).join(",")}`,
  );
  // And no minute may carry a crowd. Three at once is a bad coincidence; seventeen is the outage.
  const worst = Math.max(...[...distinct].map((m) => minutes.filter((x) => x === m).length));
  assert.ok(worst <= 3, `no minute should carry more than 3 of 17 schedules, worst was ${worst}`);
});

test("a spread schedule is still recognisably a three-o'clock job", () => {
  // A daily job asked for 03:00. Pushing it to 04:00 to relieve load would be a different promise.
  for (let i = 0; i < 200; i++) {
    const d = nextRun(DAILY, FROM, `k${i}`);
    assert.equal(d.getUTCHours(), 3, `key k${i} left the requested hour`);
  }
});

test("the offset never returns a time in the past", () => {
  // The `<= from` advance has to happen AFTER the offset is applied. Otherwise a schedule whose
  // spread lands it earlier today than `from` returns an instant already gone, and the tick claims
  // it immediately — turning a daily job into a hot loop.
  for (let i = 0; i < 200; i++) {
    const key = `k${i}`;
    // Walk `from` across the whole spread window, including the minutes the offset can produce.
    for (const mins of [0, 1, 17, 30, 54, 55, 59]) {
      const from = new Date(Date.UTC(2026, 8, 5, 3, mins, 0, 0));
      const d = nextRun(DAILY, from, key);
      assert.ok(d.getTime() > from.getTime(), `key ${key} at 03:${mins} returned ${d.toISOString()}`);
    }
  }
});

test("weekly and monthly spread too, and keep their day", () => {
  const weekly: Cadence = { kind: "weekly", weekday: 1, hour: 7, minute: 0 };
  const monthly: Cadence = { kind: "monthly", day: 1, hour: 9, minute: 0 };
  const wk = Array.from({ length: 17 }, (_, i) => nextRun(weekly, FROM, `w${i}`));
  const mo = Array.from({ length: 17 }, (_, i) => nextRun(monthly, FROM, `m${i}`));
  assert.ok(new Set(wk.map((d) => d.getUTCMinutes())).size >= 12, "weekly should spread");
  assert.ok(new Set(mo.map((d) => d.getUTCMinutes())).size >= 12, "monthly should spread");
  for (const d of wk) assert.equal(d.getUTCDay(), 1, "weekly must stay on its weekday");
  for (const d of mo) assert.equal(d.getUTCDate(), 1, "monthly must stay on its day");
});

test("adjacent keys do not walk in a straight line", () => {
  // FNV-1a alone is linear across keys differing by one character: `m0`..`m7` came out exactly
  // seven minutes apart in order, so a run of adjacent ids wrapped the hour and re-collided.
  // Schedule ids are uuids, which would have hidden this until the day something keys on
  // `project-1`, `project-2`.
  const minutes = Array.from({ length: 17 }, (_, i) => nextRun(DAILY, FROM, `m${i}`).getUTCMinutes());
  const gaps = minutes.slice(1).map((m, i) => (m - minutes[i] + 60) % 60);
  assert.ok(
    new Set(gaps).size > 2,
    `adjacent keys are marching in step — gaps between consecutive minutes: ${gaps.join(",")}`,
  );
  assert.ok(new Set(minutes).size >= 12, `short adjacent keys should still spread, got ${new Set(minutes).size}`);
});

test("`every` cadences are left alone", () => {
  // They are relative to the last run rather than to a wall clock, so they only collide when they
  // were created together — and offsetting one would change the interval the caller asked for.
  const every: Cadence = { kind: "every", seconds: 300 };
  assert.equal(
    nextRun(every, FROM, "any-key").toISOString(),
    nextRun(every, FROM).toISOString(),
  );
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// AND THE SPREAD HAS TO REACH CREATION
// ─────────────────────────────────────────────────────────────────────────────────────────────────
//
// Keying only the scheduler tick spreads the SECOND run and leaves the FIRST one stacked. That is
// still the burst — it just waits a day, and it lands on the night a batch of projects is
// provisioned from one blueprint, which is exactly when nobody is watching.

test("seventeen projects provisioned from one blueprint do not share a first run", () => {
  const keys = Array.from({ length: 17 }, (_, i) => scheduleKey(`project-${i}`, "reflect_memory"));
  const minutes = keys.map((k) => new Date(firstRun(DAILY, FROM, k)).getUTCMinutes());
  assert.ok(
    new Set(minutes).size >= 12,
    `firstRun must spread across projects, got ${new Set(minutes).size} distinct minutes`,
  );
});

test("firstRun without a key is unchanged", () => {
  assert.equal(firstRun(DAILY, FROM), "2026-09-06T03:00:00.000Z");
});

test("scheduleKey separates the two things that actually collide", () => {
  // Same project, different jobs → different offsets. Different projects, same job → different
  // offsets. Same pair → stable forever.
  assert.notEqual(scheduleKey("p1", "reflect_memory"), scheduleKey("p1", "review_work"));
  assert.notEqual(scheduleKey("p1", "reflect_memory"), scheduleKey("p2", "reflect_memory"));
  assert.equal(scheduleKey("p1", "reflect_memory"), scheduleKey("p1", "reflect_memory"));
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// TWO THINGS THE FIRST VERSION GOT WRONG, BOTH INVISIBLE AT minute: 0
// ─────────────────────────────────────────────────────────────────────────────────────────────────

test("a cadence at :30 does not get spread into the next hour", () => {
  // `h % (55 * 60)` added to the seconds field is only safe when the cadence asks for minute 0.
  // `seed-demo.ts` has a daily 07:30; a 55-minute offset put it at 08:25 — a different hour, which
  // is precisely what "a deterministic offset inside the hour it asked for" promised not to do.
  // Every original test used minute: 0.
  const half: Cadence = { kind: "daily", hour: 7, minute: 30 };
  for (let i = 0; i < 300; i++) {
    const d = nextRun(half, FROM, `k${i}`);
    assert.equal(d.getUTCHours(), 7, `key k${i} left hour 7 → ${d.toISOString()}`);
    assert.ok(d.getUTCMinutes() >= 30, `key k${i} landed before the requested :30`);
  }
});

test("a cadence at :58 still gets an offset and stays in its hour", () => {
  const late: Cadence = { kind: "daily", hour: 7, minute: 58 };
  const mins = new Set<number>();
  for (let i = 0; i < 60; i++) {
    const d = nextRun(late, FROM, `k${i}`);
    assert.equal(d.getUTCHours(), 7, "must not bleed into 08:00");
    mins.add(d.getUTCMinutes() * 60 + d.getUTCSeconds());
  }
  assert.ok(mins.size > 1, "a late cadence should still be spread a little, not collapsed to one instant");
});

test("a legacy schedule due today is not re-fired the same day", () => {
  // MIGRATION BUG. `claimDueSchedules` advances from `now`. A row sitting at 03:00:00, claimed at
  // 03:00:05, recomputed to today 03:00:47 — still in the future, so it fired a SECOND time the
  // same night. Once per schedule, on the first night after the deploy.
  //
  // The advance check has to use the UNSPREAD base: "has three o'clock happened today" must not
  // depend on where this schedule sits inside the hour.
  const claimedAt = new Date("2026-09-06T03:00:05.000Z");
  for (let i = 0; i < 200; i++) {
    const next = nextRun(DAILY, claimedAt, `k${i}`);
    assert.ok(
      next.getTime() > claimedAt.getTime() + 12 * 60 * 60 * 1000,
      `key k${i} rescheduled to ${next.toISOString()} — same day, so it fires twice`,
    );
  }
});
