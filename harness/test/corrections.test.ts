import { test } from "node:test";
import assert from "node:assert/strict";
import { api, makeApp } from "./helpers";
import { awaitApproval } from "../src/approvals";

test("approve-with-edit teaches the wedge, instead of fixing one message and forgetting", async () => {
  // "Every human correction sharpens the wedge" is the thesis this product is sold on, and it was
  // not true: an edit was applied to the action in flight, recorded in the audit as `edited: true`,
  // and then discarded. The same mistake arrives again next week and is corrected again by hand,
  // which is a treadmill rather than a moat.
  const { app, store } = makeApp();
  const projectId = (await api(app, "me")).json.projects[0].id;
  const now = new Date().toISOString();
  const taskId = `edit-task-${Date.now()}`;
  await store.createTask({
    id: taskId, project_id: projectId, wedge: "books-keeper", task_type: "daily_sync",
    actor: { kind: "system", id: "test" }, input: {}, constraints: {}, tools: [],
    status: "awaiting_approval", cost_usd: 0, created_at: now, updated_at: now,
  } as never);

  const before = (await api(app, "wedges/books-keeper/knowledge")).json.length;

  // A live waiter has to exist, or `resolveApproval` finds nothing to settle and the route 409s.
  // That is the real flow: a task is suspended ON the approval, which is why an edit can still
  // change what goes out.
  const waiting = awaitApproval(store, taskId, {
    action: "send_email",
    risk: "medium",
    preview: { subject: "Yo", body: "u owe us money" },
  });
  const pending = (await api(app, "approvals?status=pending")).json as { approval_id: string }[];
  const mine = pending.find((a) => a.approval_id);
  assert.ok(mine, "the action raised an approval");

  const decided = await api(app, `approvals/${mine!.approval_id}/approve`, {
    method: "POST",
    body: JSON.stringify({ edited: { subject: "July invoice", body: "Hi — the July invoice is now overdue." } }),
  });
  await waiting;
  assert.equal(decided.status, 200, decided.text);
  assert.ok(decided.json.correction_id, "the correction is filed, and the caller is told where");

  const knowledge = (await api(app, "wedges/books-keeper/knowledge")).json as {
    id: string; kind: string; source: string; content: string;
  }[];
  assert.equal(knowledge.length, before + 1);
  const lesson = knowledge.find((k) => k.id === decided.json.correction_id)!;
  assert.equal(lesson.kind, "correction");
  assert.equal(lesson.source, "feedback");
  // Both versions, deliberately: "here is what good looks like" teaches far less than "here is
  // what it wrote and here is what I sent instead".
  assert.match(lesson.content, /u owe us money/, "what the agent proposed");
  assert.match(lesson.content, /the July invoice is now overdue/, "and what actually went out");
});

test("approving unchanged files no lesson, and rejecting never does", async () => {
  // A wedge whose knowledge fills up with "the agent was right" entries is a wedge whose grounding
  // set is noise. Only an actual rewrite is a lesson.
  const { app, store } = makeApp();
  const projectId = (await api(app, "me")).json.projects[0].id;
  const now = new Date().toISOString();

  // Real waiters, not rows written straight into the store: an approval with nothing suspended on
  // it settles nowhere and the route 409s, which would make this pass no matter what the code did.
  const suspend = async (id: string) => {
    await store.createTask({
      id, project_id: projectId, wedge: "books-keeper", task_type: "daily_sync",
      actor: { kind: "system", id: "test" }, input: {}, constraints: {}, tools: [],
      status: "awaiting_approval", cost_usd: 0, created_at: now, updated_at: now,
    } as never);
    const waiting = awaitApproval(store, id, { action: "send_email", risk: "low", preview: { body: "fine" } });
    const pending = (await api(app, "approvals?status=pending")).json as { approval_id: string; task_id: string }[];
    return { waiting, approvalId: pending.find((a) => a.task_id === id)!.approval_id };
  };

  const before = (await api(app, "wedges/books-keeper/knowledge")).json.length;

  const plain = await suspend(`plain-${Date.now()}`);
  const approved = await api(app, `approvals/${plain.approvalId}/approve`, { method: "POST", body: "{}" });
  assert.equal(approved.status, 200, approved.text);
  assert.equal(approved.json.correction_id, undefined, "nothing was rewritten, so there is nothing to learn");
  await plain.waiting;

  const refused = await suspend(`refused-${Date.now()}`);
  const r = await api(app, `approvals/${refused.approvalId}/reject`, {
    method: "POST",
    body: JSON.stringify({ edited: { body: "never mind" } }),
  });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.correction_id, undefined, "a rejection is not a correction — nothing was sent");
  await refused.waiting;

  assert.equal((await api(app, "wedges/books-keeper/knowledge")).json.length, before, "no new knowledge");
});
