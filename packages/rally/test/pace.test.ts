import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PACE, ESTABLISHED_PACE, PERSONAL_PACE, budgetToday, dayOfLife, mayAct, paceFor, type SeatHistory } from "../src/pace";

const NOON = Date.UTC(2026, 8, 8, 12, 0, 0);
const empty: SeatHistory = { actions: [], invites: [], firstRunAt: null, observedWeeklyCap: null };
const h = (over: Partial<SeatHistory> = {}): SeatHistory => ({ ...empty, ...over });

test("a fresh seat may act", () => {
  assert.deepEqual(mayAct("invite", DEFAULT_PACE, empty, NOON, 12), { go: true });
});

// THE REGRESSION THIS PACKAGE EXISTS FOR.
//
// 13:00:33, 13:00:41, 13:01:04, 13:01:10, 13:01:16 — five invites in 43 seconds, then HTTP 429.
// Replay those exact offsets and every one after the first must be refused.
test("the five invites that earned the 429 are refused after the first", () => {
  const t0 = NOON;
  const offsets = [0, 8_000, 31_000, 37_000, 43_000];
  const actions: number[] = [];
  const refused: number[] = [];
  for (const off of offsets) {
    const now = t0 + off;
    const v = mayAct("invite", DEFAULT_PACE, h({ actions, invites: actions, firstRunAt: t0 }), now, 12);
    if (v.go) actions.push(now);
    else refused.push(off);
  }
  assert.equal(actions.length, 1, "only the first invite should have been allowed");
  assert.deepEqual(refused, [8_000, 31_000, 37_000, 43_000]);
});

test("the gap brake makes the caller wait, it never fails", () => {
  const v = mayAct("invite", DEFAULT_PACE, h({ actions: [NOON - 1_000], invites: [], firstRunAt: NOON }), NOON, 12);
  assert.equal(v.go, false);
  if (v.go) return;
  assert.ok(v.waitMs > 0, "a brake must name when to come back");
  assert.match(v.because, /too soon/);
});

test("six actions in ten minutes is the burst ceiling", () => {
  const actions = [0, 1, 2, 3, 4, 5].map((i) => NOON - (9 - i) * 60_000);
  const v = mayAct("invite", DEFAULT_PACE, h({ actions, invites: [], firstRunAt: NOON - 86_400_000 }), NOON, 12);
  assert.equal(v.go, false);
  if (v.go) return;
  assert.match(v.because, /burst ceiling/);
});

test("day one is deliberately tiny, and the ramp climbs", () => {
  assert.equal(budgetToday(DEFAULT_PACE, empty, NOON), 8);
  const wk = h({ firstRunAt: NOON - 6 * 86_400_000 });
  assert.equal(dayOfLife(wk, NOON), 7);
  assert.equal(budgetToday(DEFAULT_PACE, wk, NOON), 30);
});

// ═══ THE CEILING IS A READING, NOT A SETTING ═══
//
// `weeklyInviteCap: 100` was a guess dressed as a fact, and it would have held every seat at 100
// forever whether or not LinkedIn objected. The published figure is the common case, not the rule.

test("before LinkedIn objects, a seat probes past 100 rather than stopping at a guess", () => {
  const invites = Array.from({ length: 120 }, (_, i) => NOON - 25 * 3_600_000 - i * 3_600_000);
  const v = mayAct("invite", DEFAULT_PACE, h({ invites, firstRunAt: NOON - 7 * 86_400_000 }), NOON, 12);
  assert.equal(v.go, true, "120 sent with no refusal is not evidence of a limit");
});

test("the probe ceiling still stops it pushing blind forever", () => {
  const invites = Array.from({ length: 220 }, (_, i) => NOON - 25 * 3_600_000 - i * 2_000_000);
  const v = mayAct("invite", DEFAULT_PACE, h({ invites, firstRunAt: NOON - 7 * 86_400_000 }), NOON, 12);
  assert.equal(v.go, false);
  if (v.go) return;
  assert.match(v.because, /without LinkedIn objecting/);
});

test("once measured, LinkedIn's own number is what binds", () => {
  const invites = Array.from({ length: 87 }, (_, i) => NOON - 25 * 3_600_000 - i * 3_600_000);
  const v = mayAct(
    "invite",
    DEFAULT_PACE,
    h({ invites, firstRunAt: NOON - 7 * 86_400_000, observedWeeklyCap: 87 }),
    NOON,
    12,
  );
  assert.equal(v.go, false);
  if (v.go) return;
  assert.match(v.because, /measured 87\/week/);
});

test("a measured ceiling below the probe bound is respected, not overridden", () => {
  const invites = Array.from({ length: 40 }, (_, i) => NOON - 25 * 3_600_000 - i * 3_600_000);
  const capped = mayAct("invite", DEFAULT_PACE, h({ invites, firstRunAt: NOON - 7 * 86_400_000, observedWeeklyCap: 40 }), NOON, 12);
  assert.equal(capped.go, false, "LinkedIn said 40, so 40 it is");
  const open = mayAct("invite", DEFAULT_PACE, h({ invites, firstRunAt: NOON - 7 * 86_400_000 }), NOON, 12);
  assert.equal(open.go, true, "the same history with no measurement keeps probing");
});

test("out of hours the seat sleeps, and it is told for how long", () => {
  const v = mayAct("invite", DEFAULT_PACE, empty, NOON, 3);
  assert.equal(v.go, false);
  if (v.go) return;
  assert.match(v.because, /asleep/);
  assert.equal(v.waitMs, 6 * 3_600_000);
});

// Reading our own inbox sends nothing to anybody, so it must not be rationed like an invitation —
// otherwise a busy sending day would stop us noticing that somebody replied.
test("checking the inbox is exempt from the outbound brakes", () => {
  const actions = [0, 1, 2, 3, 4, 5, 6].map((i) => NOON - i * 1_000);
  assert.deepEqual(mayAct("check", DEFAULT_PACE, h({ actions, firstRunAt: NOON }), NOON, 12), { go: true });
});

test("a seat that is both asleep and mid-burst is told the longer wait", () => {
  const actions = [0, 1, 2, 3, 4, 5].map((i) => NOON - i * 60_000);
  const v = mayAct("invite", DEFAULT_PACE, h({ actions, firstRunAt: NOON }), NOON, 3);
  assert.equal(v.go, false);
  if (v.go) return;
  assert.match(v.because, /asleep/, "six hours asleep beats ten minutes of burst");
});

// The founder's own account has outreach history; three of the four belong to family and do not.
// Treating them identically means either throttling the working account or rushing the dormant ones.
test("the established profile starts where the cautious one finishes", () => {
  assert.equal(budgetToday(DEFAULT_PACE, empty, NOON), 8);
  assert.equal(budgetToday(ESTABLISHED_PACE, empty, NOON), 20);
  const day7 = h({ firstRunAt: NOON - 6 * 86_400_000 });
  assert.equal(budgetToday(ESTABLISHED_PACE, day7, NOON), 40);
});

// ═══ 8/DAY WAS THE WRONG NUMBER FOR THESE ACCOUNTS ═══
//
// The cautious ramp exists because a DORMANT account that suddenly sends twenty invitations a day
// is a classic restriction trigger. A sibling's ordinary LinkedIn is not dormant: real profile,
// real connections, years of history, a login from this city. What it lacks is a habit of sending
// invitations, which is a smaller gap than opening at eight assumes.
test("a real person's account starts at 12, not 8", () => {
  assert.equal(budgetToday(PERSONAL_PACE, empty, NOON), 12);
  assert.equal(budgetToday(DEFAULT_PACE, empty, NOON), 8, "the cautious ramp still exists for new accounts");
  assert.equal(budgetToday(ESTABLISHED_PACE, empty, NOON), 20);
});

test("personal reaches 30 by day five, and the fleet clears more of the queue", () => {
  const day5 = h({ firstRunAt: NOON - 4 * 86_400_000 });
  assert.equal(budgetToday(PERSONAL_PACE, day5, NOON), 30);
  // One established seat and three personal ones, on day one.
  const fleet = budgetToday(ESTABLISHED_PACE, empty, NOON) + 3 * budgetToday(PERSONAL_PACE, empty, NOON);
  assert.equal(fleet, 56, "was 44 when the three family seats opened at 8");
});

test("paceFor maps the stored profile, and an unknown value is the middle one", () => {
  assert.equal(paceFor("established"), ESTABLISHED_PACE);
  assert.equal(paceFor("new"), DEFAULT_PACE);
  assert.equal(paceFor("personal"), PERSONAL_PACE);
  assert.equal(paceFor(null), PERSONAL_PACE, "never silently the fastest");
});

// Whatever the ramp, the brakes that make traffic look human are identical.
test("gap and burst are the same for every profile", () => {
  for (const p of [DEFAULT_PACE, PERSONAL_PACE, ESTABLISHED_PACE]) {
    assert.equal(p.minGapMs, DEFAULT_PACE.minGapMs);
    assert.ok(p.burstPer10Min <= 7);
  }
});
