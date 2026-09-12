// A deploy is not an edge case for recovery — it is the normal path. `shutdown` drains correctly,
// but ECS SIGKILLs at `stopTimeout` (120s max on Fargate) and a `decide` run is 300–600s. So every
// deploy lands on somebody's engagement, and what recovery does with it is the whole story.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isSafeToRequeue, recoverTasks } from "../src/recovery";
import type { Store } from "../src/store";
import type { Task } from "../src/contract";

const task = (id: string, status: string): Task => ({ id, status, wedge: "books-keeper" }) as unknown as Task;

function fakeStore(stuck: Task[]) {
  const setStatus: { id: string; status: string; error?: string }[] = [];
  const events: { id: string; type: string; note?: string }[] = [];
  return {
    setStatus,
    events,
    store: {
      async listUnfinished() { return stuck; },
      async setStatus(id: string, status: string, error?: string) { setStatus.push({ id, status, error }); },
      /**
       * POSITIONAL, matching the real `Store`. `emitEvent` calls
       * `appendEvent(taskId, type, data)`, and this fixture used to take a single event object —
       * so every recorded note came back `undefined`. Nothing caught it because no test had
       * asserted on note text before, which is exactly how a fixture drifts from the interface it
       * stands in for.
       */
      async appendEvent(taskId: string, type: string, data?: Record<string, unknown>) {
        events.push({ id: taskId, type, note: data?.note as string | undefined });
        return { id: `e-${events.length}`, task_id: taskId, type, data } as unknown;
      },
      async getTask() { return undefined; },
    } as unknown as Store,
  };
}

test("the line: never-started is requeueable, mid-flight is not", () => {
  assert.equal(isSafeToRequeue("queued"), true);
  // Everything else may have sent an email, taken a payment or booked a meeting.
  for (const s of ["running", "awaiting_approval", "awaiting_batch", "awaiting_client", "paused"]) {
    assert.equal(isSafeToRequeue(s), false, `${s} must not auto-retry`);
  }
});

test("a QUEUED task goes back in the queue and is NOT marked failed", async () => {
  const { store, setStatus } = fakeStore([task("t1", "queued")]);
  const requeued: string[] = [];
  const n = await recoverTasks(store, async (id) => { requeued.push(id); });

  assert.deepEqual(requeued, ["t1"]);
  assert.deepEqual(setStatus, [], "a run that is going to happen must not leave a permanent red row");
  assert.equal(n, 1);
});

test("a RUNNING task stays failed — re-sending a client's invoice chase is worse than a button", async () => {
  const { store, setStatus } = fakeStore([task("t2", "running")]);
  const requeued: string[] = [];
  await recoverTasks(store, async (id) => { requeued.push(id); });

  assert.deepEqual(requeued, [], "mid-flight side effects are not knowable from here");
  assert.equal(setStatus[0]?.status, "failed");
  assert.match(String(setStatus[0]?.error), /Interrupted by a kernel restart/);
});

test("a requeue that throws still leaves the row terminal, never stuck", async () => {
  // A non-terminal row nobody will ever finish is the worst outcome: the SSE stream never closes
  // and the founder watches a spinner for ever.
  const { store, setStatus } = fakeStore([task("t3", "queued")]);
  await recoverTasks(store, async () => { throw new Error("queue is down"); });
  assert.equal(setStatus[0]?.status, "failed");
});

test("with no requeue function at all, behaviour is exactly what it was before", async () => {
  const { store, setStatus } = fakeStore([task("t4", "queued"), task("t5", "running")]);
  await recoverTasks(store);
  assert.deepEqual(setStatus.map((s) => s.status), ["failed", "failed"]);
});

test("a mixed batch: the safe ones are rescued, the rest are reported", async () => {
  const { store, setStatus } = fakeStore([
    task("a", "queued"), task("b", "running"), task("c", "queued"), task("d", "awaiting_approval"),
  ]);
  const requeued: string[] = [];
  const n = await recoverTasks(store, async (id) => { requeued.push(id); });
  assert.deepEqual(requeued, ["a", "c"]);
  assert.deepEqual(setStatus.map((s) => s.id), ["b", "d"]);
  assert.equal(n, 4, "the count is what was interrupted, not what was buried");
});

// ── a parked fan-out parent ──────────────────────────────────────────────────────────────────────
//
// `awaiting_batch` is neither of the two statuses `isSafeToRequeue` was written about. The parent
// has FANNED OUT — spawned children and parked itself — so it is doing nothing, and its own side
// effects happened before it parked. Failing it orphaned every child's completed work, because
// `onChildFinished` only advances a parent still sitting in `awaiting_batch`.
//
// Two of six `weekly_report` failures in three weeks were this, on the only job in the product that
// produces a real client deliverable.

test("a PARKED parent whose children finished during the outage is advanced, not buried", async () => {
  const { store, setStatus, events } = fakeStore([task("p1", "awaiting_batch")]);
  // The join fires: the parent is no longer parked when recovery re-reads it.
  const n = await recoverTasks(store, undefined, async () => true);

  assert.deepEqual(setStatus, [], "the parent was failed even though its work was collectable");
  // `recoverTasks` returns how many interrupted tasks it HANDLED, not how many it failed — the
  // requeue path counts too. Whether the row was buried is `setStatus`, which is what matters here.
  assert.equal(n, 1);
  assert.match(
    events.find((e) => e.type === "progress")?.note ?? "",
    /nothing was re-sent/,
    "the client-facing note does not say why re-joining was safe",
  );
});

test("a PARKED parent with a child still running is left alone to be triggered later", async () => {
  const { store, setStatus } = fakeStore([task("p2", "awaiting_batch")]);
  // Not advanced yet, but a pending child will call onChildFinished when it lands.
  const n = await recoverTasks(store, undefined, async () => true);
  assert.deepEqual(setStatus, [], "a parent with work still in flight was failed");
  assert.equal(n, 1, "it was handled, just not buried");
});

test("a PARKED parent nothing can ever advance is still failed — no new stall", async () => {
  /**
   * The trap this codebase keeps naming. Nothing sweeps `awaiting_batch`:
   * `reconcileStarvedTasks` filters on `isSafeToRequeue` too, so a parent left parked with every
   * child terminal and no join would sit there for ever. Worse than the bug it replaces.
   */
  const { store, setStatus } = fakeStore([task("p3", "awaiting_batch")]);
  const n = await recoverTasks(store, undefined, async () => false);

  assert.equal(setStatus.length, 1, "it was left parked with nothing able to advance it");
  assert.equal(setStatus[0].status, "failed");
  assert.equal(n, 1);
});

test("a rejoin that throws fails the row rather than leaving it non-terminal", async () => {
  // Same rule the requeue path states: a recovery step that cannot happen must never leave the row
  // open, or the SSE stream never closes and the run is stuck for ever.
  const { store, setStatus } = fakeStore([task("p4", "awaiting_batch")]);
  const n = await recoverTasks(store, undefined, async () => {
    throw new Error("batch store unreachable");
  });
  assert.equal(setStatus.length, 1);
  assert.equal(setStatus[0].status, "failed");
  assert.equal(n, 1);
});

test("none of this loosens the rule that mid-flight work stays failed", async () => {
  /**
   * The safety property the whole module is built on, and the one a change like this could quietly
   * weaken. A `running` task may have sent a chase, taken a payment or booked a meeting — none of
   * which is inferable from its status — so it must stay failed even with a rejoin available.
   */
  const { store, setStatus } = fakeStore([task("r1", "running"), task("a1", "awaiting_approval")]);
  const requeued: string[] = [];
  await recoverTasks(store, async (id) => { requeued.push(id); }, async () => true);

  assert.deepEqual(requeued, [], "a mid-flight run was auto-retried");
  assert.deepEqual(setStatus.map((x) => [x.id, x.status]), [["r1", "failed"], ["a1", "failed"]]);
});

test("with no rejoin injected, behaviour is exactly what it was", async () => {
  // The parameter is optional, and a caller that omits it must see the old behaviour unchanged.
  const { store, setStatus } = fakeStore([task("p5", "awaiting_batch")]);
  const n = await recoverTasks(store);
  assert.equal(setStatus.length, 1);
  assert.equal(setStatus[0].status, "failed");
  assert.equal(n, 1);
});
