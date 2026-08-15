// Standing approvals: the only mechanism in this product by which something reaches a client
// without a human looking at it in the moment, other than a wedge's own shipped envelope.
//
// Every test here is named after the way it could become a hole in the gate. The five properties
// standing.ts claims are each asserted, because a claim in a comment is not a control.
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { getDomainStore } from "../src/domain";
import {
  describeGrant,
  grantStanding,
  HARD_MAX_USES_PER_DAY,
  isLive,
  listStanding,
  matchStanding,
  MAX_GRANT_DAYS,
  revokeStanding,
} from "../src/standing";
import { InMemoryStore } from "../src/store";
import { api, makeApp } from "./helpers";
import { createServer } from "../src/server";
import { registerActionGrant } from "../src/actiongrants";
import { resetPolicyCounters } from "../src/policy";

const RUN = randomUUID().slice(0, 8);
const PW = "a-long-enough-password";
const domain = getDomainStore();
const P = () => `p-${RUN}-${randomUUID().slice(0, 6)}`;

test("a standing grant cannot be written by the agent, the sweep, or anything else that is not a person", async () => {
  // PROPERTY 2, and the one that matters most. If the agent can author its own permission then the
  // gate is decorative: every other control in this file is downstream of "a human said so".
  const project = P();
  for (const author of ["", "  ", "agent", "policy", "system", "kernel", "sweep", "AUTO", "autonomy", "worker"]) {
    await assert.rejects(
      () => grantStanding(domain, project, { action: "email:send_status_update" }, author),
      /only be granted by a person/,
      `"${author}" was allowed to grant itself standing permission`,
    );
  }
  assert.deepEqual(await listStanding(domain, project), [], "a refused grant must not be half-written");

  const ok = await grantStanding(domain, project, { action: "email:send_status_update" }, "mem_123");
  assert.equal(ok.granted_by, "mem_123");
});

test("a grant never covers a high-risk action, however it was written", async () => {
  // PROPERTY 3. This is what stops a grant written for a routine weekly update from becoming
  // authority over a refund when the action changes shape.
  const project = P();
  await grantStanding(domain, project, { action: "email:send_status_update" }, "mem_1");
  const args = { projectId: project, action: "email:send_status_update", commit: false as const };

  assert.equal((await matchStanding(domain, { ...args, risk: "low" })).auto, true);
  assert.equal((await matchStanding(domain, { ...args, risk: "medium" })).auto, true);
  const high = await matchStanding(domain, { ...args, risk: "high" });
  assert.equal(high.auto, false);
  assert.match(high.reason, /high risk/);
});

test("a grant is exact: not a prefix, not a wildcard, not another action that starts the same way", async () => {
  const project = P();
  await assert.rejects(() => grantStanding(domain, project, { action: "email:" }, "mem_1"), /pattern, not an action/);
  await assert.rejects(() => grantStanding(domain, project, { action: "email:*" }, "mem_1"), /pattern, not an action/);
  await assert.rejects(() => grantStanding(domain, project, { action: "  " }, "mem_1"), /exactly one action/);

  await grantStanding(domain, project, { action: "email:send_status_update" }, "mem_1");
  const at = (action: string) => matchStanding(domain, { projectId: project, action, risk: "low", commit: false });
  assert.equal((await at("email:send_status_update")).auto, true);
  assert.equal((await at("EMAIL:SEND_STATUS_UPDATE")).auto, true, "case is not a distinction anyone means");
  assert.equal((await at("email:send_status_update_final")).auto, false, "a longer action is a different action");
  assert.equal((await at("email:send_invoice")).auto, false);
});

test("a grant for one client does not cover another, and a grant in one project does not cover another", async () => {
  // The tenancy half. Two cross-tenant leaks have shipped in this repo; a leak HERE would be one
  // business's standing permission spending itself on another business's clients.
  const a = P();
  const b = P();
  await grantStanding(domain, a, { action: "email:send_status_update", client_id: "cli_acme" }, "mem_1");

  const ask = (project: string, clientId?: string) =>
    matchStanding(domain, { projectId: project, action: "email:send_status_update", clientId, risk: "low", commit: false });

  assert.equal((await ask(a, "cli_acme")).auto, true);
  assert.equal((await ask(a, "cli_other")).auto, false, "a grant for one client covered another");
  assert.equal((await ask(a, undefined)).auto, false, "a grant for one client covered an unattributed send");
  assert.equal((await ask(b, "cli_acme")).auto, false, "a grant leaked across projects");
  assert.equal((await ask(undefined as unknown as string, "cli_acme")).auto, false, "an unscoped call was answered");
});

test("a grant with no client covers every client, and says so out loud", async () => {
  const project = P();
  const g = await grantStanding(domain, project, { action: "email:send_status_update" }, "mem_1");
  assert.match(describeGrant(g), /for every client/);
  const hit = await matchStanding(domain, { projectId: project, action: "email:send_status_update", clientId: "anyone", risk: "low", commit: false });
  assert.equal(hit.auto, true);
});

test("a grant is revocable, and revoking one does not disturb the others", async () => {
  // PROPERTY 4, and the specific failure the one-row-per-grant shape prevents: "I revoked the
  // invoice one and the status updates stopped too."
  const project = P();
  const keep = await grantStanding(domain, project, { action: "email:send_status_update" }, "mem_1");
  const drop = await grantStanding(domain, project, { action: "email:send_timesheet" }, "mem_1");

  assert.equal(await revokeStanding(domain, project, drop.id, "mem_1"), true);
  assert.equal(await revokeStanding(domain, project, drop.id, "mem_1"), true, "revoking twice is not an error");
  assert.equal(await revokeStanding(domain, project, "nope", "mem_1"), false);
  assert.equal(await revokeStanding(domain, P(), keep.id, "mem_1"), false, "another project revoked this one's grant");

  const ask = (action: string) => matchStanding(domain, { projectId: project, action, risk: "low", commit: false });
  assert.equal((await ask("email:send_timesheet")).auto, false, "a revoked grant still let something through");
  assert.equal((await ask("email:send_status_update")).auto, true, "revoking one grant killed another");
});

test("a revoked grant stays VISIBLE — a list that hides it cannot answer 'did I grant that?'", async () => {
  const project = P();
  const g = await grantStanding(domain, project, { action: "email:send_status_update" }, "mem_1");
  await revokeStanding(domain, project, g.id, "mem_9");
  const rows = await listStanding(domain, project);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].revoked_by, "mem_9");
  assert.ok(rows[0].revoked_at);
  assert.equal(isLive(rows[0], new Date()), false);
});

test("no grant is forever, and one that has lapsed stops working without being deleted", async () => {
  // PROPERTY 5. The worst case for a founder who granted something and forgot is bounded by a
  // calendar rather than by their memory.
  const project = P();
  const g = await grantStanding(domain, project, { action: "email:send_status_update", days: 9_999 }, "mem_1");
  const lifetimeDays = (Date.parse(g.expires_at) - Date.parse(g.granted_at)) / 86_400_000;
  assert.ok(lifetimeDays <= MAX_GRANT_DAYS + 0.01, `a grant lived ${lifetimeDays} days`);

  const later = new Date(Date.parse(g.expires_at) + 1000);
  const after = await matchStanding(domain, { projectId: project, action: "email:send_status_update", risk: "low", now: later, commit: false });
  assert.equal(after.auto, false, "a lapsed grant still let something through");
  assert.equal((await listStanding(domain, project)).length, 1, "a lapsed grant vanished instead of lapsing");
});

test("the daily ceiling is real, is clamped, and a refusal does not spend it", async () => {
  resetPolicyCounters();
  const project = P();
  const greedy = await grantStanding(domain, project, { action: "email:send_status_update", max_per_day: 9_999 }, "mem_1");
  assert.equal(greedy.max_per_day, HARD_MAX_USES_PER_DAY, "a founder raised a ceiling that only lowers");

  const project2 = P();
  await grantStanding(domain, project2, { action: "email:send_status_update", max_per_day: 2 }, "mem_1");
  const spend = () => matchStanding(domain, { projectId: project2, action: "email:send_status_update", risk: "low" });

  assert.equal((await spend()).auto, true);
  assert.equal((await spend()).auto, true);
  const third = await spend();
  assert.equal(third.auto, false, "the daily ceiling did not hold");
  assert.match(third.reason, /spent its 2 for today/);

  // A high-risk action is refused before the counters are even loaded, so it cannot drain a grant
  // it was never eligible for.
  const highRefusal = await matchStanding(domain, { projectId: project2, action: "email:send_status_update", risk: "high" });
  assert.equal(highRefusal.auto, false);
});

test("when a grant lets something through, the founder is told which grant and can revoke it", async () => {
  const project = P();
  const g = await grantStanding(domain, project, { action: "email:send_status_update", client_id: "cli_acme", days: 30 }, "mem_1");
  const hit = await matchStanding(domain, { projectId: project, action: "email:send_status_update", clientId: "cli_acme", risk: "low", commit: false });
  assert.equal(hit.auto, true);
  assert.ok(hit.auto && hit.grant.id === g.id, "the decision must name the grant, or nothing can offer to revoke it");
  assert.match(hit.reason, /you allowed this on/);
  assert.match(hit.reason, /cli_acme/);
});

// ── the gate itself ──────────────────────────────────────────────────────────────────────────────

test("end to end: a granted routine send goes out unasked; the same action at high risk still stops", async () => {
  resetPolicyCounters();
  const store = new InMemoryStore();
  const app = createServer(store);
  const { createServer: httpServer } = await import("node:http");
  let hits = 0;
  const srv = httpServer((_q, res) => { hits++; res.end("ok"); });
  await new Promise<void>((r) => srv.listen(0, r));
  const port = (srv.address() as { port: number }).port;

  const project = P();
  const mkTask = async (id: string) => {
    const now = new Date().toISOString();
    await store.createTask({
      id, project_id: project, wedge: "business-shaper", task_type: "shape",
      actor: { kind: "system", id: "s" }, input: { client_id: "cli_acme" },
      constraints: { max_runtime_s: 300, max_cost_usd: 1, approval_required: false },
      tools: [], status: "running", cost_usd: 0, created_at: now, updated_at: now,
    } as never);
  };
  const conn = await domain.createConnection({
    project_id: project, kind: "email", name: `mail-${RUN}`, owner: { kind: "founder", id: "founder" },
    config: { api_url: `http://127.0.0.1:${port}`, from: "a@b.c" },
  });

  await grantStanding(domain, project, { action: "email:send_status_update", client_id: "cli_acme" }, "mem_1");

  // The routine one: low risk, covered, no human, and still recorded.
  await mkTask(`ok-${RUN}`);
  const nonce1 = await registerActionGrant({ task_id: `ok-${RUN}`, connectionIds: [conn.id] });
  const res = await app.request("/v1/internal/actions/send_status_update", {
    method: "POST",
    headers: { authorization: `Bearer ${nonce1}`, "content-type": "application/json" },
    body: JSON.stringify({ connection_id: conn.id, to: "x@acme.test", body: "this week we shipped the thing" }),
  });
  assert.equal((await res.json()).ok, true);
  assert.equal(hits, 1, "the send did not actually happen");
  assert.equal((await store.getTask(`ok-${RUN}`))!.status, "running", "the run suspended despite a grant");

  const auto = (await store.listApprovals("auto_approved")).filter((a) => a.task_id === `ok-${RUN}`);
  assert.equal(auto.length, 1, "a grant let something through invisibly");
  assert.match(auto[0].policy_reason!, /you allowed this on/);

  // The same wording, carrying a fee. `assessRisk` scores it high, so the grant cannot cover it.
  await mkTask(`stop-${RUN}`);
  const nonce2 = await registerActionGrant({ task_id: `stop-${RUN}`, connectionIds: [conn.id] });
  const pending = app.request("/v1/internal/actions/send_status_update", {
    method: "POST",
    headers: { authorization: `Bearer ${nonce2}`, "content-type": "application/json" },
    body: JSON.stringify({ connection_id: conn.id, to: "x@acme.test", body: "and a change order", amount_minor: 900_000, currency: "USD" }),
  });
  let row: Awaited<ReturnType<InMemoryStore["listApprovals"]>>[number] | undefined;
  for (let i = 0; i < 60 && !row; i++) {
    await new Promise((r) => setTimeout(r, 25));
    row = (await store.listApprovals("pending")).find((a) => a.task_id === `stop-${RUN}`);
  }
  assert.ok(row, "a $9,000 send cleared a standing grant written for routine updates");
  assert.equal(row!.risk, "high");
  assert.equal(hits, 1, "it sent before anyone said yes");

  const { resolveApproval } = await import("../src/approvals");
  resolveApproval(row!.approval_id, "rejected");
  await pending;
  srv.close();
});

test("the routes: an operator cannot grant one, an owner can, and it is listed and revocable", async () => {
  // Approving one thing is an operator's job. Deciding that a whole CLASS of thing no longer needs
  // approving is a change to how the business is governed, and this product answers "who governs"
  // the same way everywhere — the same rule the domain and branding routes use.
  const { app } = makeApp();
  const boss = await api(app, "auth/signup", {
    method: "POST",
    body: JSON.stringify({ email: `sboss-${Date.now()}@example.com`, password: PW }),
  });
  const bossSession = boss.json.token as string;
  const projectId = boss.json.projects[0].id as string;
  const H = { "x-mycel-project": projectId };

  const inv = await api(app, "team/invites", {
    method: "POST", body: JSON.stringify({ email: `sop-${Date.now()}@example.com`, role: "operator" }),
  }, bossSession);
  const staff = await api(app, `invites/${inv.json.token}/accept`, {
    method: "POST", body: JSON.stringify({ password: PW }),
  }, "nokey");

  const denied = await api(app, "standing", {
    method: "POST", headers: H, body: JSON.stringify({ action: "email:send_status_update" }),
  }, staff.json.token);
  assert.equal(denied.status, 403, denied.text);

  const made = await api(app, "standing", {
    method: "POST", headers: H, body: JSON.stringify({ action: "email:send_status_update", max_per_day: 3, days: 30 }),
  }, bossSession);
  assert.equal(made.status, 201, made.text);
  assert.equal(made.json.granted_by, boss.json.member?.id ?? made.json.granted_by);
  assert.ok(made.json.granted_by && !["", "founder", "system", "policy"].includes(made.json.granted_by),
    "the author must be a real member, not a friendly default");

  const listed = await api(app, "standing", { headers: H }, bossSession);
  assert.equal(listed.json.grants.length, 1);
  assert.equal(listed.json.grants[0].live, true);
  assert.match(listed.json.grants[0].sentence, /every client/);

  // An operator cannot take one away either — a permission an operator can revoke is a permission
  // an operator can churn, and the founder would find out from the queue rather than from a person.
  const cannotRevoke = await api(app, `standing/${made.json.id}`, { method: "DELETE", headers: H }, staff.json.token);
  assert.equal(cannotRevoke.status, 403);

  const gone = await api(app, `standing/${made.json.id}`, { method: "DELETE", headers: H }, bossSession);
  assert.equal(gone.status, 200, gone.text);
  const after = await api(app, "standing", { headers: H }, bossSession);
  assert.equal(after.json.grants[0].live, false, "a revoked grant must still be visible, and must be dead");
});

test("the routes: an API key cannot sign a human's name to a standing approval", async () => {
  // A product/API key session has no `member_id`. Defaulting that to a friendly string — which is
  // exactly what the neighbouring `/v1/autonomy` route does with "founder" — would let a key hand
  // itself permission to skip a person and file it under somebody else's name.
  const store = new InMemoryStore();
  const app = createServer(store);
  const res = await app.request("/v1/standing", {
    method: "POST",
    headers: { authorization: "Bearer testkey", "content-type": "application/json", "x-mycel-project": "p" },
    body: JSON.stringify({ action: "email:send_status_update" }),
  });
  assert.ok([400, 403].includes(res.status), `an API key got ${res.status} writing a standing approval`);
});
