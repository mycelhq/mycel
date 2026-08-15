// `Thread.case_id` — the join that was missing.
//
// Every test here names the bug it prevents. The motivating one: `findOrCreateThread` keyed on
// (client, channel, open), so every engagement a client ever had on one channel collapsed into a
// single thread and the run spawned from it inherited the wrong history.
import { test } from "node:test";
import assert from "node:assert/strict";
import { api, makeApp, KEY } from "./helpers";
import { getDomainStore } from "../src/domain";
import { _resetPortal } from "../src/portal";

const WEDGE = "books-keeper"; // declares cases.stages

async function setup() {
  const { app } = makeApp();
  const projectId = (await api(app, "me")).json.projects[0].id as string;
  const domain = getDomainStore();
  const client = await domain.createClient({
    project_id: projectId,
    display_name: "acme",
    handles: ["acme@x.test"],
    metadata: {},
  });
  return { app, projectId, domain, client };
}

test("thread identity: two engagements for one client on one channel are two conversations", async () => {
  // THE BUG: with the key (client, channel, open), a client's year-end question reopened the
  // conversation about their sales tax return, and the agent answered February's question with March's
  // context because it was handed one merged history.
  const { projectId, domain, client } = await setup();
  const caseA = await domain.createCase({
    project_id: projectId, wedge: WEDGE, title: "Sales tax", client_id: client.id, stage: "open", status: "open", data: {}, history: [],
  });
  const caseB = await domain.createCase({
    project_id: projectId, wedge: WEDGE, title: "Year end", client_id: client.id, stage: "open", status: "open", data: {}, history: [],
  });

  const a = await domain.findOrCreateThread(client.id, "ch", projectId, "Sales tax", caseA.id);
  const b = await domain.findOrCreateThread(client.id, "ch", projectId, "Year end", caseB.id);
  assert.notEqual(a.id, b.id, "different cases must not share a thread");
  assert.equal(a.case_id, caseA.id);
  assert.equal(b.case_id, caseB.id);

  const again = await domain.findOrCreateThread(client.id, "ch", projectId, "Sales tax again", caseA.id);
  assert.equal(again.id, a.id, "the same case reuses its own thread — that part was never broken");
});

test("thread identity: a message with no case still lands, and never joins a case's thread", async () => {
  // A new lead has no engagement yet. Two failures were possible and both are tested: dropping the
  // message, and filing it under whichever case happened to be open — which would then show one
  // customer's engagement history against an unrelated enquiry.
  const { projectId, domain, client } = await setup();
  const kase = await domain.createCase({
    project_id: projectId, wedge: WEDGE, title: "engagement", client_id: client.id, stage: "open", status: "open", data: {}, history: [],
  });
  const withCase = await domain.findOrCreateThread(client.id, "ch2", projectId, "job", kase.id);
  const lead = await domain.findOrCreateThread(client.id, "ch2", projectId, "hello?");

  assert.ok(lead, "an unattributed inbound must still get a thread");
  assert.equal(lead.case_id, undefined, "…a general one");
  assert.notEqual(lead.id, withCase.id, "…and not the engagement's");

  const second = await domain.findOrCreateThread(client.id, "ch2", projectId, "still here?");
  assert.equal(second.id, lead.id, "consecutive no-case messages share the general thread");
});

test("thread.case_id is write-once, so a conversation's history cannot be moved under another job", async () => {
  // THE BUG: a reassignable case_id means one call re-files an entire message transcript under a
  // different engagement, with nothing left to undo it with.
  const { projectId, domain, client } = await setup();
  const one = await domain.createCase({
    project_id: projectId, wedge: WEDGE, title: "one", client_id: client.id, stage: "open", status: "open", data: {}, history: [],
  });
  const two = await domain.createCase({
    project_id: projectId, wedge: WEDGE, title: "two", client_id: client.id, stage: "open", status: "open", data: {}, history: [],
  });
  const th = await domain.findOrCreateThread(client.id, "ch3", projectId, "lead");
  const attached = await domain.updateThread(th.id, { case_id: one.id });
  assert.equal(attached?.case_id, one.id, "a general thread can be attached once");
  const moved = await domain.updateThread(th.id, { case_id: two.id, subject: "renamed" });
  assert.equal(moved?.case_id, one.id, "…and never moved");
  assert.equal(moved?.subject, "renamed", "the rest of the patch still applies");
});

test("PUT /v1/threads/:id refuses a case from another client, another tenant, or a second attach", async () => {
  const { app, projectId, domain, client } = await setup();
  const other = await domain.createClient({ project_id: projectId, display_name: "beta", handles: ["b@x.test"], metadata: {} });
  const theirCase = await domain.createCase({
    project_id: projectId, wedge: WEDGE, title: "theirs", client_id: other.id, stage: "open", status: "open", data: {}, history: [],
  });
  const mine = await domain.createCase({
    project_id: projectId, wedge: WEDGE, title: "mine", client_id: client.id, stage: "open", status: "open", data: {}, history: [],
  });
  const th = await domain.findOrCreateThread(client.id, "ch4", projectId, "lead");

  // THE BUG: filing one customer's conversation under another customer's job. The portal reads
  // cases by client, so the wrong person would then be shown it.
  const wrongClient = await api(app, `threads/${th.id}`, { method: "PUT", body: JSON.stringify({ case_id: theirCase.id }) });
  assert.equal(wrongClient.status, 400);

  assert.equal(
    (await api(app, `threads/${th.id}`, { method: "PUT", body: JSON.stringify({ case_id: "no-such-case" }) })).status,
    404,
  );

  const ok = await api(app, `threads/${th.id}`, { method: "PUT", body: JSON.stringify({ case_id: mine.id }) });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.case_id, mine.id);

  const twice = await api(app, `threads/${th.id}`, { method: "PUT", body: JSON.stringify({ case_id: theirCase.id }) });
  assert.equal(twice.status, 409, "write-once is enforced at the route too, with a distinguishable code");
});

test("cross-tenant: another project's key can neither read nor re-file a thread", async () => {
  const { app, domain, projectId, client } = await setup();
  const th = await domain.findOrCreateThread(client.id, "ch5", projectId, "private");
  const OWNER_EMAIL = process.env.MYCEL_OWNER_EMAIL || "owner@test.co";
  const OWNER_PW = process.env.MYCEL_OWNER_PASSWORD || "secret";
  const login = await app.request("/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PW }),
  });
  const tok = (await login.json()).token as string;
  const keyB = (await api(app, "projects", { method: "POST", body: JSON.stringify({ name: "other-co" }) }, tok)).json.api_key as string;

  assert.equal((await api(app, `threads/${th.id}`, {}, keyB)).status, 404);
  assert.equal(
    (await api(app, `threads/${th.id}`, { method: "PUT", body: JSON.stringify({ subject: "hijacked" }) }, keyB)).status,
    404,
  );
  void KEY;
});

test("a client's portal reply spawns a run that carries the thread's case", async () => {
  // THE BUG: `spawnFromThread` set no case, so the engagement's history had a gap exactly where the
  // client spoke — the operator's case view showed the business's episodes and none of the
  // customer's.
  _resetPortal();
  const { app, projectId, domain, client } = await setup();
  const conn = await domain.createConnection({
    project_id: projectId, kind: "email", name: "inbox", owner: { kind: "business" }, config: {},
  });
  const channel = await domain.createChannel({
    project_id: projectId, connection_id: conn.id, kind: "email", address: "hi@x.test",
    wedge: "books-keeper", task_type: "daily_sync",
  });
  const kase = await domain.createCase({
    project_id: projectId, wedge: WEDGE, title: "engagement", client_id: client.id, stage: "open", status: "open", data: {}, history: [],
  });
  const thread = await domain.findOrCreateThread(client.id, channel.id, projectId, "job", kase.id);

  const link = await api(app, `clients/${client.id}/portal-link`, { method: "POST" });
  const tok = (await api(app, "portal/session", { method: "POST", body: JSON.stringify({ token: link.json.token }) })).json.token as string;

  const sent = await api(app, `portal/threads/${thread.id}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${tok}` },
    body: JSON.stringify({ body: "one more thing" }),
  });
  assert.equal(sent.status, 201);
  const task = (await api(app, `tasks/${sent.json.task_id}`)).json;
  assert.equal(task.case_id, kase.id, "the run is an episode of the engagement the thread names");
  assert.equal(task.input.case_id, kase.id, "and the agent is told which engagement it is working on");
});
