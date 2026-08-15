// The client-context façade and the task fields it joins on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { api, makeApp, waitTask } from "./helpers";
import { getDomainStore } from "../src/domain";

const OWNER_EMAIL = process.env.MYCEL_OWNER_EMAIL || "owner@test.co";
const OWNER_PW = process.env.MYCEL_OWNER_PASSWORD || "secret";

test("client context aggregates profile, preferences, threads, cases and prior deliverables", async () => {
  const { app, store } = makeApp();
  const domain = getDomainStore();
  const projectId = (await api(app, "me")).json.projects[0].id;

  const client = (await api(app, "clients", {
    method: "POST",
    body: JSON.stringify({ display_name: "Acme", handles: ["ops@acme.test"], preferences: { tone: "formal" } }),
  })).json;

  const thread = await domain.createThread({ project_id: projectId, client_id: client.id, channel_id: "ch", subject: "kickoff", status: "open" });
  await domain.addMessage({ thread_id: thread.id, direction: "inbound", author: client.id, body: "here are the books" });
  await domain.createCase({ project_id: projectId, wedge: "books-keeper", title: "Oct close", client_id: client.id, stage: "open", status: "open", data: {} });

  // A task for this client, with an artifact — the concrete meaning of "prior deliverable".
  const task = (await api(app, "tasks", {
    method: "POST",
    body: JSON.stringify({ wedge: "books-keeper", task_type: "daily_sync", input: {}, client_id: client.id }),
  })).json;
  assert.equal(task.client_id, client.id);
  assert.equal(task.source, "api");
  assert.equal(task.assigned_to, "agent");
  await waitTask(app, task.id);
  await store.addArtifact({ task_id: task.id, name: "october.csv", content_type: "text/csv", content: "a,b,c" });

  const ctx = (await api(app, `clients/${client.id}/context`)).json;
  assert.equal(ctx.client.preferences.tone, "formal");
  assert.equal(ctx.threads.length, 1);
  assert.equal(ctx.threads[0].messages[0].body, "here are the books");
  assert.equal(ctx.cases.length, 1);
  const ours = ctx.deliverables.find((a: { name: string }) => a.name === "october.csv");
  assert.ok(ours, "the artifact from this client's task is a prior deliverable");
  // Content is NOT inlined — a context read fans out over a client's whole history.
  for (const d of ctx.deliverables) assert.equal(d.content, undefined);
  assert.ok(Array.isArray(ctx.invoices), "money belongs on the same context as outreach");
});

test("client context includes invoices for the timeline", async () => {
  const { app } = makeApp();
  const { getBillingStore, initBillingStore, _resetBilling } = await import("../src/billing");
  await initBillingStore();
  _resetBilling();
  const projectId = (await api(app, "me")).json.projects[0].id;
  const client = (
    await api(app, "clients", {
      method: "POST",
      body: JSON.stringify({ display_name: "Payee", handles: ["ap@payee.test"] }),
    })
  ).json;
  await getBillingStore().createInvoice({
    project_id: projectId,
    client_id: client.id,
    currency: "USD",
    status: "sent",
    due_date: "2026-01-01",
    issue_date: "2025-12-01",
    number: "INV-CTX-1",
    lines: [{ id: "l1", description: "work", kind: "fixed", quantity_milli: 1000, unit_amount: 100_00 }],
    sent_at: "2025-12-02T00:00:00.000Z",
  } as never);

  const ctx = (await api(app, `clients/${client.id}/context`)).json;
  assert.equal(ctx.invoices.length, 1);
  assert.equal(ctx.invoices[0].number, "INV-CTX-1");
});

test("patching context merges preferences instead of replacing the object", async () => {
  const { app } = makeApp();
  const client = (await api(app, "clients", {
    method: "POST",
    body: JSON.stringify({ display_name: "Acme", handles: ["a@acme.test"], preferences: { tone: "formal", tz: "America/New_York" } }),
  })).json;

  const patched = await api(app, `clients/${client.id}/context`, {
    method: "PATCH",
    body: JSON.stringify({ preferences: { tone: "warm" } }),
  });
  assert.equal(patched.status, 200);
  // A replace here would silently drop every other preference the business had captured.
  assert.deepEqual(patched.json.client.preferences, { tone: "warm", tz: "America/New_York" });
  assert.equal((await api(app, "clients/does-not-exist/context")).status, 404);
});

test("PATCH /v1/tasks/:id: assignment and confidence, validated", async () => {
  const { app } = makeApp();
  const task = (await api(app, "tasks", {
    method: "POST",
    body: JSON.stringify({ wedge: "books-keeper", task_type: "daily_sync", input: {} }),
  })).json;

  const ok = await api(app, `tasks/${task.id}`, {
    method: "PATCH",
    body: JSON.stringify({ assigned_to: "human", confidence_score: 0.4 }),
  });
  assert.equal(ok.json.assigned_to, "human");
  assert.equal(ok.json.confidence_score, 0.4);

  // null clears it; out-of-range and nonsense are refused rather than coerced.
  assert.equal((await api(app, `tasks/${task.id}`, { method: "PATCH", body: JSON.stringify({ confidence_score: null }) })).json.confidence_score, null);
  assert.equal((await api(app, `tasks/${task.id}`, { method: "PATCH", body: JSON.stringify({ confidence_score: 4 }) })).status, 400);
  assert.equal((await api(app, `tasks/${task.id}`, { method: "PATCH", body: JSON.stringify({ assigned_to: "nobody" }) })).status, 400);
  assert.equal((await api(app, "tasks/ghost", { method: "PATCH", body: "{}" })).status, 404);
});

test("a task CANNOT be attached to another project's client", async () => {
  const { app } = makeApp();
  const login = await app.request("/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PW }),
  });
  const tok = (await login.json()).token as string;
  const other = (await api(app, "projects", { method: "POST", body: JSON.stringify({ name: "victim" }) }, tok)).json;
  const victimKey = other.api_key as string;

  // The victim's client, in the victim's project.
  const victimClient = (await api(app, "clients", {
    method: "POST",
    body: JSON.stringify({ display_name: "Victim Co", handles: ["v@victim.test"] }),
  }, victimKey)).json;

  // task.client_id is what the context façade joins on. Writing it unchecked would let an attacker
  // surface their own artifacts inside a rival's client context — and read that client's id back.
  const created = await api(app, "tasks", {
    method: "POST",
    body: JSON.stringify({ wedge: "books-keeper", task_type: "daily_sync", input: {}, client_id: victimClient.id }),
  });
  assert.equal(created.status, 400);
  assert.match(created.json.error, /unknown client_id/);

  const mine = (await api(app, "tasks", {
    method: "POST",
    body: JSON.stringify({ wedge: "books-keeper", task_type: "daily_sync", input: {} }),
  })).json;
  const repointed = await api(app, `tasks/${mine.id}`, {
    method: "PATCH",
    body: JSON.stringify({ client_id: victimClient.id }),
  });
  assert.equal(repointed.status, 400, "the same check applies on the patch path");

  // The victim's context is untouched by any of it.
  const ctx = (await api(app, `clients/${victimClient.id}/context`, {}, victimKey)).json;
  assert.equal(ctx.deliverables.length, 0);
  assert.equal(ctx.cases.length, 0);
});
