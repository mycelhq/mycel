// Approval authority by role — the boundary the product SELLS and used not to enforce.
//
// A `viewer` is described in the UI as read-only ("Reads everything. Approves nothing."). Before
// `canApprove`, the approve/reject handler gated on tenancy alone, so any member of the org — viewer
// included — could settle an approval. These tests pin the rule: a viewer is refused on both approve
// AND reject (a veto is still a decision), while an operator, who the copy says runs the day to day,
// is allowed.
import test from "node:test";
import assert from "node:assert/strict";
import { api, makeApp, KEY } from "./helpers";
import { awaitApproval } from "../src/approvals";

async function member(app: any, ownerToken: string, role: string) {
  const inv = await api(
    app,
    "team/invites",
    { method: "POST", body: JSON.stringify({ email: `${role}-${Date.now()}-${Math.round(performance.now())}@ap.test`, role }) },
    ownerToken,
  );
  assert.equal(inv.status, 201, inv.text);
  const acc = await api(app, `invites/${inv.json.token}/accept`, {
    method: "POST",
    body: JSON.stringify({ name: role, password: "hunter2-hunter2" }),
  });
  assert.ok(acc.status === 200 || acc.status === 201, acc.text);
  return acc.json.token as string;
}

test("approvals: a viewer cannot approve or reject; an operator can", async () => {
  const { app, store } = makeApp();
  // The seeded owner's org — its project has wedges installed, so a task can be created on it. The
  // product API KEY resolves to that org/project; the owner member session (owner@test.co) is who
  // invites the teammates below, so the viewer/operator land in the SAME org as the approval.
  const projectId = (await api(app, "me")).json.projects[0].id as string;
  const login = await api(app, "auth/login", {
    method: "POST",
    body: JSON.stringify({ email: process.env.MYCEL_OWNER_EMAIL || "owner@test.co", password: process.env.MYCEL_OWNER_PASSWORD || "secret" }),
  });
  assert.equal(login.status, 200, login.text);
  const ownerToken = login.json.token as string;

  // A queued task on the owner's project and a pending approval on it, exactly as a real run leaves
  // one. Seeded straight into the store (not via POST /v1/tasks) so the test does not depend on which
  // wedges this app instance happens to have on disk — the approval-authority rule is what's under
  // test, not task creation.
  const now = new Date().toISOString();
  const taskId = "task-role-approve-1";
  await store.createTask({
    id: taskId,
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
  awaitApproval(store, taskId, { action: "email:send_reminder", risk: "high", preview: {}, requireHuman: true, ttlMs: 30_000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 20));

  const pending = await api(app, "approvals?status=pending", {}, ownerToken);
  assert.equal(pending.status, 200, pending.text);
  const approvalId = pending.json[0]?.approval_id;
  assert.ok(approvalId, "expected a pending approval to decide");

  const viewer = await member(app, ownerToken, "viewer");
  const vApprove = await api(app, `approvals/${approvalId}/approve`, { method: "POST", body: "{}" }, viewer);
  assert.equal(vApprove.status, 403, `viewer approve should be 403, got ${vApprove.status} ${vApprove.text}`);
  const vReject = await api(app, `approvals/${approvalId}/reject`, { method: "POST", body: "{}" }, viewer);
  assert.equal(vReject.status, 403, `viewer reject should be 403, got ${vReject.status} ${vReject.text}`);

  // The approval is still pending — the viewer settled nothing either way.
  const stillPending = await api(app, "approvals?status=pending", {}, ownerToken);
  assert.equal(stillPending.json.length, 1, "a refused viewer must not have moved the approval");

  // Control: an operator is allowed to approve.
  const operator = await member(app, ownerToken, "operator");
  const oApprove = await api(app, `approvals/${approvalId}/approve`, { method: "POST", body: "{}" }, operator);
  assert.equal(oApprove.status, 200, `operator approve should be 200, got ${oApprove.status} ${oApprove.text}`);
});
