// A failed run that cannot say why it failed.
//
// ─── THE PRODUCTION BUG THESE PIN ───
//
// Several `invoice-chaser` chases spawned by the dunning sweep sat in the console as `failed` at
// `$0.00`, going back weeks, while other runs of the SAME task type succeeded and produced real
// firm_reminder decisions for $0.0003. Zero cost means they died before a single token, and the row
// carried no reason at all — so from the console the only honest reading was "the feature is
// broken", which it was not.
//
// Two holes produced that, both in this repo's recurring shape: something failing while saying
// nothing.
//
//   1. `recoverTasks` called `setStatus(id, "failed")` with no error argument, and BOTH stores leave
//      the column untouched when `error === undefined`. The reason existed only inside the event
//      log, and /work/<id> renders the ROW.
//   2. Anything thrown without a message — `new Error("")`, a bare `throw undefined` — wrote an
//      empty string into the same column, which the page treats as absent.
//
// The mechanism that fed hole 1 is worth knowing and is asserted below: `listUnfinished` reclaims
// `queued` rows too, so the tail of a 25-invoice sweep batch running against a worker concurrency of
// 4 is reclaimed by the next deploy having never started. "Never started" and "died mid-run" are
// very different things to a founder — one is safe to retry and the other may already have emailed
// a client — so they must not read the same.
import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryStore } from "../src/store";
import { recoverTasks } from "../src/recovery";
import { failureReason } from "../src/orchestrator";
import type { Task } from "../src/contract";

function chase(id: string, status: Task["status"]): Task {
  const at = new Date().toISOString();
  return {
    id,
    project_id: "proj_1",
    wedge: "invoice-chaser",
    task_type: "chase_invoice",
    actor: { kind: "system", id: "kernel" },
    input: { invoice_id: "inv_1" },
    constraints: { max_cost_usd: 0.5, max_runtime_s: 240, approval_required: false },
    tools: [],
    source: "schedule",
    assigned_to: "agent",
    status,
    cost_usd: 0,
    created_at: at,
    updated_at: at,
  } as Task;
}

test("a run reclaimed on boot says why on the row, not only in the event log", async () => {
  const store = new InMemoryStore();
  await store.createTask(chase("t_running", "running"));

  const n = await recoverTasks(store);
  assert.equal(n, 1);

  const row = await store.getTask("t_running");
  assert.equal(row?.status, "failed");
  // The whole bug: this was undefined in production, so the console showed a red badge and a blank.
  assert.ok(row?.error, "a failed run with no error on the row is unreadable to the founder");
  assert.match(row!.error!, /restart/i);
});

test("a chase that never left the queue does not claim it was interrupted mid-run", async () => {
  // The sweep spawns up to 25 chases per tick against a concurrency of 4, and `listUnfinished`
  // reclaims anything non-terminal after ten minutes — `queued` included. These runs did nothing,
  // sent nothing and cost nothing, and telling a founder they were "interrupted" invites them to go
  // and check whether a client was half-chased.
  const store = new InMemoryStore();
  await store.createTask(chase("t_queued", "queued"));

  await recoverTasks(store);

  const row = await store.getTask("t_queued");
  assert.equal(row?.status, "failed");
  assert.match(row!.error!, /never started/i);
  assert.match(row!.error!, /safe to run again/i);
  assert.equal(row?.cost_usd, 0);
});

test("the reason is on the row AND on the stream, because they are read by different things", async () => {
  // /work/<id> reads the row on load and the event stream when it is live. They disagreed.
  const store = new InMemoryStore();
  await store.createTask(chase("t_both", "running"));
  await recoverTasks(store);

  const row = await store.getTask("t_both");
  const finished = (await store.eventsAfter("t_both", 0)).find((e) => e.type === "task.finished");
  assert.equal((finished?.data as { error?: string })?.error, row?.error);
});

test("a terminal run is never reclaimed a second time", async () => {
  // The guard on the guard: rewriting `error` on an already-failed run would replace a real
  // diagnosis with a generic one every time the kernel reboots.
  const store = new InMemoryStore();
  await store.createTask(chase("t_done", "succeeded"));
  await store.setStatus("t_done", "failed", "opencode Anthropic: overloaded_error");

  assert.equal(await recoverTasks(store), 0);
  assert.equal((await store.getTask("t_done"))?.error, "opencode Anthropic: overloaded_error");
});

test("a throw with no message still writes a sentence, never an empty column", () => {
  // `String((e as Error)?.message ?? e)` was the old line. `new Error("")` is not `undefined`, so the
  // empty string WAS persisted — and /work/<id> renders `row.error ? … : {}`, where "" is falsy. The
  // founder saw a failed run and a blank space, indistinguishable from the recovery hole above.
  assert.equal(failureReason(new Error("opencode failed to start (no log)")), "opencode failed to start (no log)");
  for (const thrown of [new Error(""), new Error("   "), undefined, null, {}, ""]) {
    const reason = failureReason(thrown);
    assert.ok(reason.trim().length > 0, `an empty reason for ${String(thrown)} is an unreadable row`);
  }
  assert.match(failureReason(new Error("")), /no message/);
  assert.match(failureReason(undefined), /no message/);
});
