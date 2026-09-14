// A DECISION ON A JOB THAT IS ALREADY OVER.
//
// a comparable runtime's `projects/lib/pending-questions.ts` puts the rule this way: a stale ask "is
// worse than none: it invites an answer nothing is waiting for." We were on the wrong side of it in
// both directions.
//
// RENDER: `GET /v1/approvals` filtered on tenancy alone, so a `pending` approval whose task had
// already cancelled, expired or failed kept showing up in the founder's queue as a live decision.
//
// WRITE, and this is the one that cost something: approving that card ran `parkAfterChaseSend`
// BEFORE the terminal check that suppressed the status flip and the event. So the invoice was
// parked and its dunning ladder advanced as though a chase had gone out, while the run that was
// supposed to send it was already dead. The rung was claimed, nothing was delivered, and the next
// legitimate chase would find the slot taken — the failure class `promises.ts` documents.
//
// These tests pin both halves: a terminal task's approval does not render as pending, and the
// approve route refuses it at the door rather than half-executing it.
import test from "node:test";
import assert from "node:assert/strict";
import { api, makeApp } from "./helpers";
import { awaitApproval } from "../src/approvals";

async function seed(store: any, projectId: string, id: string) {
  const now = new Date().toISOString();
  await store.createTask({
    id,
    project_id: projectId,
    wedge: "invoice-chaser",
    task_type: "chase_invoice",
    actor: { kind: "system", id: "test" },
    input: {},
    constraints: { max_runtime_s: 60, max_cost_usd: 1, approval_required: true },
    tools: [],
    status: "queued",
    cost_usd: 0,
    created_at: now,
    updated_at: now,
  } as any);
  // A run suspended on the gate, exactly as a real one leaves it.
  awaitApproval(store, id, {
    action: "email:send_reminder",
    risk: "high",
    preview: {},
    requireHuman: true,
    ttlMs: 30_000,
  }).catch(() => {});
  await new Promise((r) => setTimeout(r, 20));
}

async function ownerToken(app: any) {
  const login = await api(app, "auth/login", {
    method: "POST",
    body: JSON.stringify({
      email: process.env.MYCEL_OWNER_EMAIL || "owner@test.co",
      password: process.env.MYCEL_OWNER_PASSWORD || "secret",
    }),
  });
  assert.equal(login.status, 200, login.text);
  return login.json.token as string;
}

test("approvals: a pending approval on a terminal task does not render as pending", async () => {
  const { app, store } = makeApp();
  const projectId = (await api(app, "me")).json.projects[0].id as string;
  const token = await ownerToken(app);
  const taskId = "task-stale-render-1";
  await seed(store, projectId, taskId);

  // It is a live decision while the task is alive.
  const live = await api(app, "approvals?status=pending", {}, token);
  assert.equal(live.status, 200, live.text);
  assert.equal(
    live.json.filter((a: any) => a.task_id === taskId).length,
    1,
    "a pending approval on a running task belongs in the queue",
  );

  // The run dies underneath it. The approval row is untouched — that is the whole point: nothing
  // sweeps it, so the list has to be the thing that knows.
  await store.setStatus(taskId, "failed");

  const after = await api(app, "approvals?status=pending", {}, token);
  assert.equal(after.status, 200, after.text);
  assert.equal(
    after.json.filter((a: any) => a.task_id === taskId).length,
    0,
    "an approval whose job already failed must not be offered as a live decision",
  );
});

test("approvals: approving a terminal task's approval is refused, not half-executed", async () => {
  const { app, store } = makeApp();
  const projectId = (await api(app, "me")).json.projects[0].id as string;
  const token = await ownerToken(app);
  const taskId = "task-stale-write-1";
  await seed(store, projectId, taskId);

  const pending = await api(app, "approvals?status=pending", {}, token);
  const approvalId = pending.json.find((a: any) => a.task_id === taskId)?.approval_id;
  assert.ok(approvalId, "expected a pending approval to decide");

  await store.setStatus(taskId, "cancelled");

  const res = await api(app, `approvals/${approvalId}/approve`, { method: "POST", body: "{}" }, token);
  assert.equal(res.status, 409, `approving a cancelled job should be 409, got ${res.status} ${res.text}`);
  assert.match(res.json.error, /already cancelled/, "the refusal should say which state ended it");

  // Refused means REFUSED: the approval row did not move, so nothing downstream can read it as a
  // grant. Before the fix the route reached `resolveApproval`, woke the suspended run, and let it
  // park the invoice on the way to discovering the task was dead.
  const row = await store.getApproval(approvalId);
  assert.equal(row?.status, "pending", "a refused decision must not settle the approval");

  // And the task stayed dead — no flip back to running.
  const t = await store.getTask(taskId);
  assert.equal(t?.status, "cancelled", "a terminal task must not be revived by an approval");
});

test("approvals: rejecting a terminal task's approval is refused the same way", async () => {
  const { app, store } = makeApp();
  const projectId = (await api(app, "me")).json.projects[0].id as string;
  const token = await ownerToken(app);
  const taskId = "task-stale-write-2";
  await seed(store, projectId, taskId);

  const pending = await api(app, "approvals?status=pending", {}, token);
  const approvalId = pending.json.find((a: any) => a.task_id === taskId)?.approval_id;
  assert.ok(approvalId);

  await store.setStatus(taskId, "expired");

  // A veto is still a decision, and there is equally nothing left to veto. Symmetry matters here:
  // a founder who sees a stale card is as likely to click Reject to clear it, and that must not be
  // reported as having stopped anything.
  const res = await api(app, `approvals/${approvalId}/reject`, { method: "POST", body: "{}" }, token);
  assert.equal(res.status, 409, `rejecting an expired job should be 409, got ${res.status} ${res.text}`);
  assert.match(res.json.error, /nothing left to reject/);
});
