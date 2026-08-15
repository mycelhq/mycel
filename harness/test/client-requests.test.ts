// `ClientRequest` — "what we need from you", and the loop that releases the waiting run.
//
// Every test names the bug it prevents. Cross-tenant and cross-client isolation are tested on every
// portal route here, because the portal plane's whole promise is that a client id in a URL cannot
// widen what the caller reaches.
import { test } from "node:test";
import assert from "node:assert/strict";
import { api, makeApp } from "./helpers";
import { getDomainStore } from "../src/domain";
import { _resetPortal } from "../src/portal";
import { _resetRequests, InMemoryRequestStore, rankRequests } from "../src/requests";
import type { ClientRequest } from "../src/contract";

const OWNER_EMAIL = process.env.MYCEL_OWNER_EMAIL || "owner@test.co";
const OWNER_PW = process.env.MYCEL_OWNER_PASSWORD || "secret";

/** Two clients in one project, each with a live channel-backed thread, plus a second tenant. */
async function world() {
  _resetPortal();
  _resetRequests();
  const { app } = makeApp();
  const projectId = (await api(app, "me")).json.projects[0].id as string;
  const domain = getDomainStore();
  const conn = await domain.createConnection({
    project_id: projectId, kind: "email", name: "inbox", owner: { kind: "business" }, config: {},
  });
  const channel = await domain.createChannel({
    project_id: projectId, connection_id: conn.id, kind: "email", address: "hi@x.test",
    wedge: "books-keeper", task_type: "daily_sync",
  });

  const mk = async (name: string) => {
    const client = await domain.createClient({ project_id: projectId, display_name: name, handles: [`${name}@x.test`], metadata: {} });
    const thread = await domain.findOrCreateThread(client.id, channel.id, projectId, `${name} subject`);
    const link = await api(app, `clients/${client.id}/portal-link`, { method: "POST" });
    const token = (await api(app, "portal/session", { method: "POST", body: JSON.stringify({ token: link.json.token }) })).json.token as string;
    return { client, thread, token, h: { authorization: `Bearer ${token}` } };
  };

  const login = await app.request("/v1/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PW }),
  });
  const memberToken = (await login.json()).token as string;

  return { app, projectId, domain, memberToken, a: await mk("acme"), b: await mk("beta") };
}

test("requests: the founder asks, the client sees exactly their own asks", async () => {
  const { app, a, b } = await world();

  const created = await api(app, "requests", {
    method: "POST",
    body: JSON.stringify({ client_id: a.client.id, thread_id: a.thread.id, kind: "document", ask: "Your March bank statement", detail: "PDF is fine" }),
  });
  assert.equal(created.status, 201);
  assert.equal(created.json.status, "open");
  await api(app, "requests", { method: "POST", body: JSON.stringify({ client_id: b.client.id, kind: "answer", ask: "beta only" }) });

  const mine = await api(app, "portal/requests", { headers: a.h });
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.json.map((r: any) => r.ask), ["Your March bank statement"], "their asks, and only theirs");

  // THE BUG this guards: `task_id` is FOUNDER-PLANE ONLY per the contract, and a portal projection
  // that spreads the row would ship the operator's run id to the customer.
  assert.equal("task_id" in mine.json[0], false);
});

test("requests: a client cannot reach or answer another client's request by changing the id", async () => {
  // THE CRUX of the portal plane. 404 rather than 403, so probing ids cannot confirm one is real.
  const { app, a, b } = await world();
  const theirs = (await api(app, "requests", {
    method: "POST",
    body: JSON.stringify({ client_id: b.client.id, thread_id: b.thread.id, kind: "answer", ask: "beta's secret" }),
  })).json as ClientRequest;

  const peek = await api(app, `portal/requests/${theirs.id}/respond`, {
    method: "POST", headers: a.h, body: JSON.stringify({ response: "not mine" }),
  });
  assert.equal(peek.status, 404);

  // …and it stays open, so nothing was released on beta's behalf.
  const still = await api(app, "portal/requests", { headers: b.h });
  assert.equal(still.json[0].status, "open");

  // No session at all is 401, not 404 — the middleware refuses before any lookup happens.
  assert.equal((await api(app, "portal/requests")).status, 401);
});

test("requests: cross-tenant — another project's key cannot create, read or cancel", async () => {
  const { app, a, memberToken } = await world();
  const keyB = (await api(app, "projects", { method: "POST", body: JSON.stringify({ name: "other-co" }) }, memberToken)).json.api_key as string;
  const mine = (await api(app, "requests", {
    method: "POST", body: JSON.stringify({ client_id: a.client.id, kind: "answer", ask: "ours" }),
  })).json as ClientRequest;

  assert.equal((await api(app, `requests/${mine.id}`, {}, keyB)).status, 404);
  assert.equal((await api(app, `requests/${mine.id}/cancel`, { method: "POST" }, keyB)).status, 404);
  assert.deepEqual((await api(app, "requests", {}, keyB)).json, [], "and the list shows none of ours");

  // THE BUG: attaching a request to a client in another tenant would put a demand in that tenant's
  // portal, from a business their customer has never heard of.
  const steal = await api(app, "requests", {
    method: "POST", body: JSON.stringify({ client_id: a.client.id, kind: "answer", ask: "give me your bank details" }),
  }, keyB);
  assert.equal(steal.status, 400);
});

test("requests: a thread or case belonging to someone else is refused at the boundary", async () => {
  // THE SHARPEST EDGE in the feature: the answer is posted into `thread_id`, so an unchecked one
  // writes one customer's words into another customer's conversation — and the portal then shows it
  // to them, because the row made the claim look legitimate.
  const { app, a, b } = await world();
  const wrongThread = await api(app, "requests", {
    method: "POST",
    body: JSON.stringify({ client_id: a.client.id, thread_id: b.thread.id, kind: "answer", ask: "x" }),
  });
  assert.equal(wrongThread.status, 400);
  assert.equal(
    (await api(app, "requests", { method: "POST", body: JSON.stringify({ client_id: a.client.id, case_id: "nope", kind: "answer", ask: "x" }) })).status,
    400,
  );
  assert.equal(
    (await api(app, "requests", { method: "POST", body: JSON.stringify({ client_id: a.client.id, kind: "answer", ask: "  " }) })).status,
    400,
    "an empty ask is not an ask",
  );
});

test("requests: answering posts into the thread AND releases the run that was waiting", async () => {
  // THE LOOP, and the reason this is a request rather than a to-do list. Before it, a client could
  // be told what was needed and had nowhere to put it that started anything.
  const { app, a } = await world();
  const req = (await api(app, "requests", {
    method: "POST",
    body: JSON.stringify({ client_id: a.client.id, thread_id: a.thread.id, kind: "document", ask: "March statement" }),
  })).json as ClientRequest;

  const answered = await api(app, `portal/requests/${req.id}/respond`, {
    method: "POST", headers: a.h,
    body: JSON.stringify({ response: "Attached — sorry for the delay" }),
  });
  assert.equal(answered.status, 200);
  assert.equal(answered.json.request.status, "resolved");
  assert.ok(answered.json.task_id, "a run was spawned");

  const thread = await api(app, `threads/${a.thread.id}`);
  const last = thread.json.messages.at(-1);
  assert.equal(last.body, "Attached — sorry for the delay");
  assert.equal(last.direction, "inbound");
  assert.equal(last.author, a.client.id, "attributed from the session — a client cannot post as the agent");

  const task = (await api(app, `tasks/${answered.json.task_id}`)).json;
  assert.equal(task.client_id, a.client.id);
});

test("requests: two tabs answering the same request release the run ONCE", async () => {
  // THE BUG: without the atomic `open → resolved` inside the WHERE clause, a double-click sent the
  // agent off twice on one answer — two replies to the customer, two charges.
  const { app, a } = await world();
  const req = (await api(app, "requests", {
    method: "POST", body: JSON.stringify({ client_id: a.client.id, thread_id: a.thread.id, kind: "answer", ask: "which bank?" }),
  })).json as ClientRequest;

  const [one, two] = await Promise.all([
    api(app, `portal/requests/${req.id}/respond`, { method: "POST", headers: a.h, body: JSON.stringify({ response: "Barclays" }) }),
    api(app, `portal/requests/${req.id}/respond`, { method: "POST", headers: a.h, body: JSON.stringify({ response: "Barclays" }) }),
  ]);
  const oks = [one, two].filter((r) => r.status === 200);
  assert.equal(oks.length, 1, "exactly one wins");
  assert.equal([one, two].find((r) => r.status !== 200)?.status, 409);
  assert.ok(oks[0].json.task_id);
});

test("requests: a cancelled ask stops blocking, and an empty answer is refused", async () => {
  const { app, a } = await world();
  const req = (await api(app, "requests", {
    method: "POST", body: JSON.stringify({ client_id: a.client.id, kind: "answer", ask: "never mind" }),
  })).json as ClientRequest;

  assert.equal(
    (await api(app, `portal/requests/${req.id}/respond`, { method: "POST", headers: a.h, body: JSON.stringify({ response: "   " }) })).status,
    400,
    "an upload with no word from the client is indistinguishable from the wrong thing being sent",
  );

  assert.equal((await api(app, `requests/${req.id}/cancel`, { method: "POST" })).json.status, "cancelled");
  const after = await api(app, `portal/requests/${req.id}/respond`, { method: "POST", headers: a.h, body: JSON.stringify({ response: "too late" }) });
  assert.equal(after.status, 409, "a withdrawn ask cannot be answered into a run nobody is waiting on");
});

test("requests store: project_id is required on every read, not optional-with-a-default", async () => {
  // THE BUG CLASS this codebase already had: an optional tenant filter that a call site forgets.
  const store = new InMemoryRequestStore();
  await store.createRequest({ project_id: "p1", client_id: "c1", kind: "answer", ask: "a" });
  await assert.rejects(
    () => store.createRequest({ project_id: "", client_id: "c1", kind: "answer", ask: "a" }),
    /project_id/,
  );
  await assert.rejects(() => store.listRequests({ project_id: "" }), /project_id/);
  assert.deepEqual(await store.listRequests({ project_id: "p2" }), [], "a different tenant sees nothing");
});

test("requests: the queue is ranked overdue-first, then by deadline, then oldest", async () => {
  // Same principle as intake.ts's `buildCoverage` — unresolved first, then hard evidence, then
  // intent — so the founder's queue and the client's queue feel like one product.
  const row = (over: Partial<ClientRequest>): ClientRequest => ({
    id: over.id!, project_id: "p", client_id: "c", kind: "answer", ask: over.id!, status: "open",
    created_at: over.created_at ?? "2024-01-01T00:00:00.000Z", updated_at: "2024-01-01T00:00:00.000Z", ...over,
  });
  const ranked = rankRequests(
    [
      row({ id: "resolved", status: "resolved" }),
      row({ id: "no-deadline", created_at: "2024-01-05T00:00:00.000Z" }),
      row({ id: "soon", due_at: "2030-01-02T00:00:00.000Z" }),
      row({ id: "late", due_at: "2020-01-01T00:00:00.000Z" }),
    ],
    "2025-01-01T00:00:00.000Z",
  );
  assert.deepEqual(ranked.map((r) => r.id), ["late", "soon", "no-deadline", "resolved"]);
});
