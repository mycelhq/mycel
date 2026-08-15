import { test } from "node:test";
import assert from "node:assert/strict";
import { api, makeApp, waitTask } from "./helpers";

test("analytics: rolls up what actually happened, from data the kernel already had", async () => {
  const { app } = makeApp();

  const before = (await api(app, "analytics")).json;
  const spawn = () =>
    api(app, "tasks", {
      method: "POST",
      body: JSON.stringify({ wedge: "books-keeper", task_type: "daily_sync", input: {} }),
    });
  const a = await spawn();
  const b = await spawn();
  await waitTask(app, a.json.id);
  await waitTask(app, b.json.id);

  const now = (await api(app, "analytics")).json;
  assert.equal(now.tasks.total, before.tasks.total + 2);
  assert.ok(now.by_day.length >= 1, "bucketed by day so a caller can draw a line without re-deriving it");
  assert.ok(now.by_wedge.some((w: { wedge: string }) => w.wedge === "books-keeper"));

  // Success rate is over FINISHED work. Counting in-flight tasks as failures would make the number
  // sag whenever the business is busy, which is exactly backwards.
  assert.ok(now.tasks.success_rate === null || (now.tasks.success_rate >= 0 && now.tasks.success_rate <= 100));
  assert.equal(now.tasks.in_flight, 0, "everything finished");

  // The window is bounded so a caller can't ask for an unbounded scan.
  assert.equal((await api(app, "analytics?days=99999")).json.window_days, 365);
  assert.equal((await api(app, "analytics?days=0")).json.window_days, 1);
});

test("analytics: approval latency is measurable at all", async () => {
  // It wasn't. `Approval` carried only `expires_at`, so the single most important number about a
  // human-in-the-loop product — how long customers wait on a person — could not be computed.
  const { app } = makeApp();
  const a = (await api(app, "analytics")).json;
  assert.ok("median_wait_seconds" in a.approvals, "the field exists even when there's nothing to average");
  assert.ok(a.approvals.median_wait_seconds === null || typeof a.approvals.median_wait_seconds === "number");
});

test("analytics: the window means the same thing for every number on the page", async () => {
  // The approvals block used to be pulled from the whole store with no `since` filter, so it
  // silently described all time while sitting under a header that said "last 7 days". A dashboard
  // where one panel means something different from the others is worse than one panel fewer.
  const { app } = makeApp();
  const r = (await api(app, "analytics?days=7")).json;

  assert.equal(r.window_days, 7);
  assert.equal(r.by_day.length, 7, "every day in the window, including the empty ones");
  const days = r.by_day.map((d: { day: string }) => d.day);
  assert.deepEqual([...days].sort(), days, "and in order, so a chart can render it directly");

  // A rate with no direction is a number, not a signal.
  assert.ok(r.previous, "the same window, one window earlier");
  assert.equal(typeof r.previous.tasks, "number");
  assert.ok(r.previous.success_rate === null || typeof r.previous.success_rate === "number");

  // Blocked on a human and busy on a machine are opposite problems.
  assert.equal(typeof r.tasks.awaiting_approval, "number");
  assert.equal(typeof r.tasks.expired, "number", "never answered is its own outcome");
  assert.equal(
    r.tasks.total - r.tasks.succeeded - r.tasks.in_flight - r.tasks.awaiting_approval,
    r.tasks.failed + r.tasks.rejected + r.tasks.expired + r.tasks.cancelled,
    "the statuses account for every task exactly once",
  );
});
