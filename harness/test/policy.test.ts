import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluatePolicy, payloadAmount, resetPolicyCounters } from "../src/policy";
import type { WedgeManifest } from "../src/wedge";
import { InMemoryStore } from "../src/store";
import { createServer } from "../src/server";
import { getDomainStore } from "../src/domain";
import { registerActionGrant } from "../src/actiongrants";

const manifest = (policy: unknown): WedgeManifest => ({ wedge: "w", policy } as WedgeManifest);

test("no policy means everything is gated — the safe default", () => {
  const d = evaluatePolicy(manifest(undefined), { action: "email:send", taskId: "t" });
  assert.equal(d.auto, false);
  assert.match(d.reason, /no auto-approve policy/);
  assert.equal(evaluatePolicy(undefined, { action: "x", taskId: "t" }).auto, false);
});

test("an action outside the envelope stays gated; inside it auto-approves", () => {
  resetPolicyCounters();
  const m = manifest({ auto_approve: [{ action: "email:send_reminder" }] });
  assert.equal(evaluatePolicy(m, { action: "email:send_reminder", taskId: "t1" }).auto, true);
  assert.equal(evaluatePolicy(m, { action: "stripe:charge", taskId: "t1" }).auto, false, "money has no rule → gated");
});

test("prefix rules match a family of actions", () => {
  resetPolicyCounters();
  const m = manifest({ auto_approve: [{ action: "ads:" }] });
  assert.equal(evaluatePolicy(m, { action: "ads:set_budget", taskId: "t" }).auto, true);
  assert.equal(evaluatePolicy(m, { action: "ads:pause_campaign", taskId: "t" }).auto, true);
  assert.equal(evaluatePolicy(m, { action: "stripe:refund", taskId: "t" }).auto, false);
});

test("amount ceilings: within passes, over is gated, missing amount is gated", () => {
  resetPolicyCounters();
  const m = manifest({ auto_approve: [{ action: "ads:set_budget", max_amount_usd: 50 }] });
  assert.equal(evaluatePolicy(m, { action: "ads:set_budget", payload: { amount: 20 }, taskId: "t" }).auto, true);
  const over = evaluatePolicy(m, { action: "ads:set_budget", payload: { amount: 500 }, taskId: "t" });
  assert.equal(over.auto, false);
  assert.match(over.reason, /exceeds/);
  const missing = evaluatePolicy(m, { action: "ads:set_budget", payload: {}, taskId: "t" });
  assert.equal(missing.auto, false, "a cap with no amount to check must fail closed");
});

test("per-task and per-day ceilings stop runaway autonomy, and a refusal doesn't burn budget", () => {
  resetPolicyCounters();
  const m = manifest({ auto_approve: [{ action: "email:send", max_per_task: 2, max_per_day: 3 }] });

  assert.equal(evaluatePolicy(m, { action: "email:send", taskId: "a", projectId: "p" }).auto, true);
  assert.equal(evaluatePolicy(m, { action: "email:send", taskId: "a", projectId: "p" }).auto, true);
  const third = evaluatePolicy(m, { action: "email:send", taskId: "a", projectId: "p" });
  assert.equal(third.auto, false, "per-task ceiling reached");
  assert.match(third.reason, /per-task limit of 2/);

  // a different task gets its own per-task budget, but shares the daily one
  assert.equal(evaluatePolicy(m, { action: "email:send", taskId: "b", projectId: "p" }).auto, true);
  const dayCapped = evaluatePolicy(m, { action: "email:send", taskId: "c", projectId: "p" });
  assert.equal(dayCapped.auto, false, "daily ceiling reached");
  assert.match(dayCapped.reason, /daily limit of 3/);

  // another project has its own daily budget
  assert.equal(evaluatePolicy(m, { action: "email:send", taskId: "d", projectId: "other" }).auto, true);
});

test("commit:false evaluates without consuming budget", () => {
  resetPolicyCounters();
  const m = manifest({ auto_approve: [{ action: "x", max_per_task: 1 }] });
  assert.equal(evaluatePolicy(m, { action: "x", taskId: "t", commit: false }).auto, true);
  assert.equal(evaluatePolicy(m, { action: "x", taskId: "t", commit: false }).auto, true, "peeking is free");
  assert.equal(evaluatePolicy(m, { action: "x", taskId: "t" }).auto, true);
  assert.equal(evaluatePolicy(m, { action: "x", taskId: "t" }).auto, false, "now the budget is spent");
});

test("payloadAmount reads the usual shapes", () => {
  assert.equal(payloadAmount({ amount: 12 }), 12);
  assert.equal(payloadAmount({ amount_usd: "34.5" }), 34.5);
  assert.equal(payloadAmount({ total: 7 }), 7);
  assert.equal(payloadAmount({ nothing: "here" }), undefined);
});

test("end to end: an in-envelope action executes with no human, and is queued for batch review", async () => {
  resetPolicyCounters();
  const store = new InMemoryStore();
  const app = createServer(store);
  const domain = getDomainStore();

  // a live sink so the action actually executes
  const { createServer: httpServer } = await import("node:http");
  let hits = 0;
  const srv = httpServer((_q, res) => { hits++; res.end("ok"); });
  await new Promise<void>((r) => srv.listen(0, r));
  const port = (srv.address() as { port: number }).port;

  const now = new Date().toISOString();
  await store.createTask({
    id: "pt1", project_id: "p", wedge: "invoice-chaser", task_type: "chase_invoice",
    actor: { kind: "system", id: "s" }, input: {},
    constraints: { max_runtime_s: 300, max_cost_usd: 1, approval_required: false },
    tools: [], status: "running", cost_usd: 0, created_at: now, updated_at: now,
  } as never);
  const conn = await domain.createConnection({
    project_id: "p", kind: "email", name: "billing-email", owner: { kind: "founder", id: "founder" },
    config: { api_url: `http://127.0.0.1:${port}`, from: "a@b.c" },
  });
  const nonce = registerActionGrant({ task_id: "pt1", connectionIds: [conn.id] });
  const H = { authorization: `Bearer ${nonce}`, "content-type": "application/json" };

  // invoice-chaser's policy auto-approves email:send_reminder (3/task) — no human, no suspend
  const res = await app.request("/v1/internal/actions/send_reminder", {
    method: "POST", headers: H, body: JSON.stringify({ connection_id: conn.id, to: "x@y.z", body: "gentle nudge" }),
  });
  const out = await res.json();
  assert.equal(out.ok, true, "the action executed without a human");
  assert.equal(hits, 1, "it really hit the connection");
  assert.equal((await store.getTask("pt1"))!.status, "running", "the task never suspended");

  // …but it IS recorded, with the reason, so the founder can batch-review what autonomy did
  // Scoped to THIS task, not the whole store. `listApprovals` is global, so an absolute count here
  // only held while this was the one test in the file that auto-approved anything.
  const auto = (await store.listApprovals("auto_approved")).filter((a) => a.task_id === "pt1");
  assert.equal(auto.length, 1);
  assert.equal(auto[0].action, "email:send_reminder");
  assert.match(auto[0].policy_reason!, /auto-approved/);

  const events = await store.eventsAfter("pt1", 0);
  const resolved = events.find((e) => e.type === "approval.resolved");
  assert.equal((resolved!.data as { decision: string }).decision, "auto_approved");
  assert.ok(!events.some((e) => e.type === "approval.requested"), "no human was ever asked");

  srv.close();
});
