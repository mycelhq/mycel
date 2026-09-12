/**
 * SEVENTEEN APPROVALS, `pending`, ON TASKS THAT HAD ALREADY FAILED. Oldest: 1,630 hours.
 *
 * Measured in production. `failWaitersForTask` exists for this and could never have reached them:
 * it walks an in-memory map, and both routes to an orphan empty that map first — a task failing
 * (nothing on the failure path calls it) and a process restarting (which erases every waiter and
 * every TTL timer, which is also why these never expired).
 *
 * `GET /v1/approvals` already hides them, so this was never a visible bug. It was a lying table:
 * `pending` is what every count reads, and "a human never answered" became indistinguishable from
 * "there was nobody left to answer".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { reconcileOrphanedApprovals, startApprovalReconciler } from "../src/approvals";
import { InMemoryStore } from "../src/store";

let seq = 0;
async function taskWithApproval(store: any, status: string) {
  const now = new Date().toISOString();
  const id = `t${++seq}`;
  const t = await store.createTask({
    id, project_id: "p1", wedge: "books-keeper", task_type: "monthly_close",
    actor: { kind: "user", id: "u" }, input: {},
    constraints: { max_runtime_s: 300, max_cost_usd: 1, approval_required: true },
    tools: [], status: "awaiting_approval", cost_usd: 0, created_at: now, updated_at: now,
  } as any);
  const a = await store.createApproval({ task_id: t.id, action: "send_email", risk: "medium", preview: {} });
  await store.setStatus(t.id, status);
  return { task: t, approval: a };
}

test("an approval on a failed run is closed, and says why", async () => {
  const store = new InMemoryStore();
  const { approval } = await taskWithApproval(store, "failed");

  const before = await store.listApprovals("pending");
  assert.equal(before.length, 1, "fixture did not leave a pending approval");

  const n = await reconcileOrphanedApprovals(store);
  assert.equal(n, 1);

  const after = await store.getApproval(approval.approval_id);
  // `expired`, never `rejected`: nobody refused it, and recording a refusal would put a decision in
  // the founder's audit trail that they never took.
  assert.equal(after!.status, "expired");
  assert.match(String(after!.policy_reason ?? ""), /failed/);
});

test("an approval on a LIVE run is left alone — this must never close a real decision", async () => {
  const store = new InMemoryStore();
  await taskWithApproval(store, "awaiting_approval");
  assert.equal(await reconcileOrphanedApprovals(store), 0);
  assert.equal((await store.listApprovals("pending")).length, 1);
});

test("every terminal status counts, not just failure", async () => {
  for (const status of ["succeeded", "failed", "cancelled", "expired", "rejected"]) {
    const store = new InMemoryStore();
    await taskWithApproval(store, status);
    assert.equal(await reconcileOrphanedApprovals(store), 1, `${status} left an orphan behind`);
  }
});

test("already-decided approvals are not touched — that is history", async () => {
  const store = new InMemoryStore();
  const { approval } = await taskWithApproval(store, "failed");
  await store.setApproval(approval.approval_id, "approved");
  assert.equal(await reconcileOrphanedApprovals(store), 0);
  assert.equal((await store.getApproval(approval.approval_id))!.status, "approved");
});

test("the sweep runs and is idempotent", async () => {
  const store = new InMemoryStore();
  await taskWithApproval(store, "failed");
  const sweep = startApprovalReconciler(store, 60_000);
  try {
    assert.equal(await sweep.tick(), 1);
    assert.equal(await sweep.tick(), 0, "a second pass closed something twice");
  } finally {
    sweep.stop();
  }
});

/**
 * The whole point of the bug was a function nobody called. Asserting the CALL SITE, not the
 * definition — `reapSandboxFor` already taught this repo that `indexOf("name(")` finds the `export
 * function` line and proves nothing.
 */
test("the reconciler is actually started at boot, and stopped on shutdown", () => {
  const boot = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(boot, /const approvalReconciler = startApprovalReconciler\(store\)/, "never started");
  assert.match(boot, /void approvalReconciler\.tick\(\)/, "boot is the event that orphans them — it must tick once immediately");
  assert.match(boot, /approvalReconciler\.stop\(\)/, "never stopped, so the timer outlives shutdown");
});
