import { test } from "node:test";
import assert from "node:assert/strict";
import { nextRun } from "../src/scheduler";
import { getDomainStore } from "../src/domain";
import { startScheduler, firstRun } from "../src/scheduler";
import { api, makeApp, waitTask } from "./helpers";

const at = (s: string) => new Date(s);

test("cadence math: every N seconds", () => {
  assert.equal(nextRun({ kind: "every", seconds: 60 }, at("2026-03-01T10:00:00Z")).toISOString(), "2026-03-01T10:01:00.000Z");
  // never returns a zero/negative interval
  assert.ok(nextRun({ kind: "every", seconds: 0 }, at("2026-03-01T10:00:00Z")).getTime() > at("2026-03-01T10:00:00Z").getTime());
});

test("cadence math: daily rolls to tomorrow once today's time has passed", () => {
  const c = { kind: "daily", hour: 6, minute: 30 } as const;
  assert.equal(nextRun(c, at("2026-03-01T05:00:00Z")).toISOString(), "2026-03-01T06:30:00.000Z");
  assert.equal(nextRun(c, at("2026-03-01T06:30:00Z")).toISOString(), "2026-03-02T06:30:00.000Z", "exactly-due rolls forward (no double fire)");
  assert.equal(nextRun(c, at("2026-03-01T23:59:00Z")).toISOString(), "2026-03-02T06:30:00.000Z");
});

test("cadence math: monthly clamps short months and crosses year boundaries", () => {
  const first = { kind: "monthly", day: 1, hour: 9, minute: 0 } as const;
  assert.equal(nextRun(first, at("2026-03-15T00:00:00Z")).toISOString(), "2026-04-01T09:00:00.000Z");
  // day 31 in a 30-day month clamps to the 30th
  const end = { kind: "monthly", day: 31, hour: 0, minute: 0 } as const;
  assert.equal(nextRun(end, at("2026-04-05T00:00:00Z")).toISOString(), "2026-04-30T00:00:00.000Z");
  // February clamp (2026 is not a leap year)
  assert.equal(nextRun(end, at("2026-02-05T00:00:00Z")).toISOString(), "2026-02-28T00:00:00.000Z");
  // December → January of the next year
  assert.equal(nextRun(first, at("2026-12-10T00:00:00Z")).toISOString(), "2027-01-01T09:00:00.000Z");
});

test("schedules API: create, validate, pause, fire-now", async () => {
  const { app } = makeApp();

  // validation at the boundary
  assert.equal((await api(app, "schedules", { method: "POST", body: JSON.stringify({ name: "x" }) })).status, 400);
  assert.equal((await api(app, "schedules", { method: "POST", body: JSON.stringify({ name: "x", wedge: "ghost", task_type: "y", cadence: { kind: "daily", hour: 6, minute: 0 } }) })).status, 400);
  assert.equal(
    (await api(app, "schedules", { method: "POST", body: JSON.stringify({ name: "x", wedge: "books-keeper", task_type: "daily_sync", cadence: { kind: "daily", hour: 99, minute: 0 } }) })).status,
    400,
    "a nonsense cadence is rejected before it can trip the tick loop",
  );

  const created = await api(app, "schedules", {
    method: "POST",
    body: JSON.stringify({ name: "daily sync", wedge: "books-keeper", task_type: "daily_sync", input: { message: "sync" }, cadence: { kind: "daily", hour: 6, minute: 0 } }),
  });
  assert.equal(created.status, 201);
  assert.ok(created.json.next_run_at, "next_run_at is computed on create");
  assert.equal(created.json.enabled, true);
  const id = created.json.id as string;

  // pause it
  const paused = await api(app, `schedules/${id}`, { method: "PUT", body: JSON.stringify({ enabled: false }) });
  assert.equal(paused.json.enabled, false);

  // fire now → creates a real task that runs (mock runtime)
  const fired = await api(app, `schedules/${id}/run`, { method: "POST" });
  assert.equal(fired.status, 201);
  const done = await waitTask(app, fired.json.task_id);
  assert.equal(done.status, "succeeded");
  assert.equal(done.actor.id, `schedule:${id}`, "the task records which schedule spawned it");
  assert.equal(done.input.schedule_id, id);

  // delete
  assert.equal((await api(app, `schedules/${id}`, { method: "DELETE" })).json.ok, true);
  assert.equal((await api(app, `schedules/${id}`)).status, 404);
});

test("tick loop: a due schedule fires once and re-arms", async () => {
  const { store, app } = makeApp();
  const domain = getDomainStore();

  const cadence = { kind: "every", seconds: 3600 } as const;
  const s = await domain.createSchedule({
    project_id: (await api(app, "projects")).json[0].id,
    name: "tick test",
    wedge: "books-keeper",
    task_type: "daily_sync",
    input: {},
    cadence,
    enabled: true,
    next_run_at: new Date(Date.now() - 1000).toISOString(), // already due
  });

  const sched = startScheduler(store, domain, 1_000_000); // don't let the interval fire; drive it manually
  try {
    const fired = await sched.tick();
    assert.deepEqual(fired, [s.id], "the due schedule fired");

    const after = await domain.getSchedule(s.id);
    assert.ok(after!.next_run_at > new Date().toISOString(), "next_run_at was advanced");
    assert.ok(after!.last_task_id, "the spawned task is recorded");

    // a second tick must NOT fire it again
    assert.deepEqual(await sched.tick(), [], "no double fire");

    const task = await store.getTask(after!.last_task_id!);
    assert.ok(task, "the task exists");
  } finally {
    sched.stop();
  }
});

test("firstRun never schedules in the past", () => {
  const iso = firstRun({ kind: "daily", hour: 0, minute: 0 });
  assert.ok(new Date(iso).getTime() > Date.now());
});

// ── weekly ──────────────────────────────────────────────────────────────────
//
// The cadence the union's own comment promised and did not have. `{every: 604800}` was the obvious
// substitute and drifts: it counts from the last RUN, so one retry or one catch-up fire on boot
// moves "the Monday report" permanently onto Tuesday. These tests are about the day of the week
// surviving things that move the clock.

test("weekly: picks the next occurrence of the weekday", () => {
  // Sat 2026-08-22 → next Monday 09:00 is 2026-08-24.
  const from = new Date("2026-08-22T12:00:00Z");
  const d = nextRun({ kind: "weekly", weekday: 1, hour: 9, minute: 0 }, from);
  assert.equal(d.toISOString(), "2026-08-24T09:00:00.000Z");
  assert.equal(d.getUTCDay(), 1);
});

test("weekly: later the same day still fires today", () => {
  // Monday 06:00, report due Monday 09:00 — today, not next week.
  const from = new Date("2026-08-24T06:00:00Z");
  const d = nextRun({ kind: "weekly", weekday: 1, hour: 9, minute: 0 }, from);
  assert.equal(d.toISOString(), "2026-08-24T09:00:00.000Z");
});

test("weekly: past the time on the day advances a FULL week, not a day", () => {
  // The bug a naive daily-style `+1 day` produces: Monday 10:00 would become Tuesday 09:00 and the
  // schedule would never be on a Monday again.
  const from = new Date("2026-08-24T10:00:00Z");
  const d = nextRun({ kind: "weekly", weekday: 1, hour: 9, minute: 0 }, from);
  assert.equal(d.toISOString(), "2026-08-31T09:00:00.000Z");
  assert.equal(d.getUTCDay(), 1);
});

test("weekly: exactly on the boundary moves to next week", () => {
  // `<=` not `<`: firing at exactly next_run_at must not schedule the same instant again.
  const from = new Date("2026-08-24T09:00:00Z");
  const d = nextRun({ kind: "weekly", weekday: 1, hour: 9, minute: 0 }, from);
  assert.equal(d.toISOString(), "2026-08-31T09:00:00.000Z");
});

test("weekly: an out-of-range weekday is normalised, not trusted", () => {
  // `weekday: 7` meaning Sunday would otherwise land seven days out and quietly become fortnightly.
  const from = new Date("2026-08-22T12:00:00Z");
  const seven = nextRun({ kind: "weekly", weekday: 7, hour: 9, minute: 0 }, from);
  const zero = nextRun({ kind: "weekly", weekday: 0, hour: 9, minute: 0 }, from);
  assert.equal(seven.toISOString(), zero.toISOString());
  assert.equal(seven.getUTCDay(), 0);
  // Negative too, for the same reason.
  const minusOne = nextRun({ kind: "weekly", weekday: -1, hour: 9, minute: 0 }, from);
  assert.equal(minusOne.getUTCDay(), 6);
});

test("weekly: the weekday never drifts across many runs", () => {
  // The property the whole cadence exists for. Chain fifty runs and every one is a Monday.
  let t = new Date("2026-08-22T12:00:00Z");
  for (let i = 0; i < 50; i++) {
    t = nextRun({ kind: "weekly", weekday: 1, hour: 9, minute: 0 }, t);
    assert.equal(t.getUTCDay(), 1, `run ${i} landed on ${t.toISOString()}`);
    assert.equal(t.getUTCHours(), 9);
  }
});
