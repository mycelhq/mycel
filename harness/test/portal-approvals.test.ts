// Client-facing approvals — the CLIENT signing off a deliverable.
//
// No new primitive: `resolveApproval` is reused verbatim, so the tests here are all about scoping
// and redaction, which is where the whole risk lives. Each names the bug it prevents.
import { test } from "node:test";
import assert from "node:assert/strict";
import { api, makeApp } from "./helpers";
import { getDomainStore } from "../src/domain";
import { _resetPortal } from "../src/portal";
import { awaitApproval } from "../src/approvals";
import { isClientFacing, redactPreview } from "../src/portal-approvals";
import type { Store } from "../src/store";

const OWNER_EMAIL = process.env.MYCEL_OWNER_EMAIL || "owner@test.co";
const OWNER_PW = process.env.MYCEL_OWNER_PASSWORD || "secret";

async function world() {
  _resetPortal();
  const { app, store } = makeApp();
  const projectId = (await api(app, "me")).json.projects[0].id as string;
  const domain = getDomainStore();

  const mk = async (name: string) => {
    const client = await domain.createClient({ project_id: projectId, display_name: name, handles: [`${name}@ap.test`], metadata: {} });
    const link = await api(app, `clients/${client.id}/portal-link`, { method: "POST" });
    const token = (await api(app, "portal/session", { method: "POST", body: JSON.stringify({ token: link.json.token }) })).json.token as string;
    return { client, h: { authorization: `Bearer ${token}` } };
  };
  return { app, store, projectId, a: await mk("acme"), b: await mk("beta") };
}

/** A queued task attributed to a client, which is what makes an approval on it theirs to decide. */
async function taskFor(app: any, clientId: string, projectId: string, key?: string): Promise<string> {
  const t = await api(app, "tasks", {
    method: "POST",
    headers: { "x-mycel-project": projectId },
    body: JSON.stringify({ wedge: "books-keeper", task_type: "daily_sync", input: {}, client_id: clientId, actor: { kind: "user", id: clientId } }),
  }, key);
  assert.equal(t.status, 201, t.text);
  return t.json.id as string;
}

/** Raise a client-facing approval and leave it PENDING with a live waiter, as a real run would. */
function raise(store: Store, taskId: string, action: string, preview: Record<string, unknown> = {}) {
  const settled = awaitApproval(store, taskId, { action, risk: "high", preview, requireHuman: true, ttlMs: 30_000 });
  // Swallow the eventual outcome; the test asserts on the route, not on the run.
  settled.catch(() => {});
  return settled;
}

test("portal approvals: only `client:` actions cross the plane", async () => {
  // THE BUG: "every approval on this client's task" would hand the customer a veto over the
  // business's own outbound actions — and a live feed of every action taken on their file.
  const { app, store, projectId, a } = await world();
  const taskId = await taskFor(app, a.client.id, projectId);
  raise(store, taskId, "email:send_reminder", { to: "someone@else.test" });
  raise(store, taskId, "client:sign_off", { summary: "Your Q1 accounts are ready" });
  await new Promise((r) => setTimeout(r, 20));

  const list = await api(app, "portal/approvals", { headers: a.h });
  assert.equal(list.status, 200);
  assert.equal(list.json.length, 1, "the operator-plane approval is not the customer's business");
  assert.equal(list.json[0].action, "sign_off", "the plane marker is stripped from what the client reads");
  assert.equal(list.json[0].preview.summary, "Your Q1 accounts are ready");

  assert.equal(isClientFacing("email:send_reminder"), false, "fails closed: unknown actions are operator-only");
  assert.equal(isClientFacing("client:sign_off"), true);
});

test("portal approvals: the preview is a field allowlist, not a passthrough", async () => {
  // THE BUG, and the same one `PORTAL_FIELDS` fixed on the event stream: a preview is built by
  // whoever raised the approval, so forwarding it verbatim ships every field a wedge author ever
  // adds — internal notes, cost estimates, the operator's draft reasoning — to the customer.
  const out = redactPreview({
    summary: "shown",
    internal_note: "they always pay late",
    cost_usd: 0.42,
    model: "claude-x",
    artifact_id: "art_1",
  });
  assert.deepEqual(out, { summary: "shown", artifact_id: "art_1" });
});

test("portal approvals: a client cannot see or decide another client's sign-off", async () => {
  // The crux of the plane. 404, never 403 — a 403 confirms the id is real.
  const { app, store, projectId, a, b } = await world();
  const theirTask = await taskFor(app, b.client.id, projectId);
  const pending = raise(store, theirTask, "client:sign_off", { summary: "beta's deliverable" });
  await new Promise((r) => setTimeout(r, 20));

  const theirs = await api(app, "portal/approvals", { headers: b.h });
  assert.equal(theirs.json.length, 1);
  const id = theirs.json[0].approval_id as string;

  assert.deepEqual((await api(app, "portal/approvals", { headers: a.h })).json, [], "acme sees none of beta's");
  assert.equal((await api(app, `portal/approvals/${id}/approve`, { method: "POST", headers: a.h })).status, 404);
  assert.equal((await api(app, `portal/approvals/${id}/reject`, { method: "POST", headers: a.h })).status, 404);
  assert.equal((await api(app, `portal/approvals/${id}/approve`, { method: "POST" })).status, 401, "and not without a session");

  // Still pending: nothing was decided on beta's behalf.
  assert.equal((await api(app, "portal/approvals", { headers: b.h })).json[0].status, "pending");
  await api(app, `portal/approvals/${id}/reject`, { method: "POST", headers: b.h });
  assert.equal((await pending).decision, "rejected");
});

test("portal approvals: cross-tenant — a session in one project cannot reach another's approval", async () => {
  const { app, store, projectId, a, memberToken } = await (async () => {
    const w = await world();
    const login = await w.app.request("/v1/auth/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PW }),
    });
    return { ...w, memberToken: (await login.json()).token as string };
  })();

  const other = await api(app, "projects", { method: "POST", body: JSON.stringify({ name: "other-co" }) }, memberToken);
  const otherProject = other.json.project.id as string;
  const domain = getDomainStore();
  const theirClient = await domain.createClient({ project_id: otherProject, display_name: "gamma", handles: ["g@ap.test"], metadata: {} });
  const theirTask = await taskFor(app, theirClient.id, otherProject, memberToken);
  raise(store, theirTask, "client:sign_off", { summary: "another tenant's deliverable" });
  await new Promise((r) => setTimeout(r, 20));

  // acme's session is in `projectId`. The approval is real and pending; it must be invisible.
  assert.deepEqual((await api(app, "portal/approvals", { headers: a.h })).json, []);
  void projectId;
});

test("portal approvals: a decision is atomic and never overrides a settled one", async () => {
  // THE BUG: approve/reject TOCTOU. The founder route already guarded it; the client route must
  // use the same guard rather than a second, subtly different one.
  const { app, store, projectId, a } = await world();
  const taskId = await taskFor(app, a.client.id, projectId);
  const pending = raise(store, taskId, "client:sign_off", { summary: "sign here" });
  await new Promise((r) => setTimeout(r, 20));
  const id = (await api(app, "portal/approvals", { headers: a.h })).json[0].approval_id as string;

  const ok = await api(app, `portal/approvals/${id}/approve`, { method: "POST", headers: a.h });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.decision, "approved");
  assert.equal((await pending).decision, "approved", "the waiting run was released, by the shared resolveApproval");

  const again = await api(app, `portal/approvals/${id}/reject`, { method: "POST", headers: a.h });
  assert.equal(again.status, 409, "a second decision cannot undo the first");
});
