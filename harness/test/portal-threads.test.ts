// A CLIENT STARTING A CONVERSATION, AND THE PORTAL KNOWING WHOSE IT IS.
//
// Every test names the bug it prevents. The scoping tests are the point of the file: `POST
// /v1/portal/threads` is the first route on the client plane that CREATES a row, and a create is
// where a body field gets to decide who a record belongs to. Two cross-tenant leaks have shipped in
// this repo already.
import { test } from "node:test";
import assert from "node:assert/strict";
import { api, makeApp, makeFreshApp } from "./helpers";
import { getDomainStore } from "../src/domain";
import { _resetPortal } from "../src/portal";

/** One project with a live channel, two clients, and a second tenant to try to reach. */
async function world() {
  _resetPortal();
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
    const client = await domain.createClient({
      project_id: projectId, display_name: name, handles: [`${name}@x.test`], metadata: {},
    });
    const link = await api(app, `clients/${client.id}/portal-link`, { method: "POST" });
    const token = (
      await api(app, "portal/session", { method: "POST", body: JSON.stringify({ token: link.json.token }) })
    ).json.token as string;
    return { client, token, h: { authorization: `Bearer ${token}` } };
  };

  return { app, projectId, domain, channel, a: await mk("acme"), b: await mk("beta") };
}

test("portal: a client with no threads can start one, and it lands in their own account", async () => {
  // THE BUG THIS PREVENTS: observed in production 2026-08-10. A real client signed in and the entire
  // page held one interactive element — "Sign out of this browser". The conversations empty state
  // said "when we message you, it'll appear here": the client plane could only APPEND to a thread the
  // business had already started, so asking your agency for work was impossible and the answer was
  // to go back to email. This route is the door.
  const { app, a } = await world();

  const before = await api(app, "portal/threads", { headers: a.h });
  assert.deepEqual(before.json, [], "a new client starts with nothing — this is the case that was broken");

  const created = await api(app, "portal/threads", {
    method: "POST",
    headers: a.h,
    body: JSON.stringify({ subject: "New job", body: "Can you also take on our VAT return?" }),
  });
  assert.equal(created.status, 201);
  assert.equal(created.json.thread.subject, "New job");
  assert.equal(created.json.thread.client_id, a.client.id);
  assert.equal(created.json.message.direction, "inbound");
  assert.equal(created.json.message.author, a.client.id, "attributed from the session, not from the body");

  const after = await api(app, "portal/threads", { headers: a.h });
  assert.equal(after.json.length, 1);
  assert.equal(after.json[0].id, created.json.thread.id);

  // And it is a real conversation: the message is on it and readable back through the scoped read.
  const read = await api(app, `portal/threads/${created.json.thread.id}`, { headers: a.h });
  assert.equal(read.status, 200);
  assert.equal(read.json.messages[0].body, "Can you also take on our VAT return?");
});

test("portal: the new thread's owner comes from the session and a body field cannot move it", async () => {
  // THE BUG THIS PREVENTS: the leak shape this repo has shipped twice. `client_id: b.client_id ??
  // session.client_id` reads as defensive and is the whole vulnerability — the fallback only fires
  // when the attacker declines to supply the field. So the route accepts no identity at all, and this
  // asserts that supplying every identity field anybody might add later changes nothing.
  const { app, a, b, projectId } = await world();

  const created = await api(app, "portal/threads", {
    method: "POST",
    headers: a.h,
    body: JSON.stringify({
      body: "hello",
      client_id: b.client.id,
      project_id: "some-other-project",
      case_id: "not-mine",
      channel_id: "not-mine-either",
    }),
  });
  assert.equal(created.status, 201);
  assert.equal(created.json.thread.client_id, a.client.id, "the body renamed the owner of a new thread");
  assert.equal(created.json.thread.project_id, projectId, "the body moved a thread into another project");
  assert.equal(created.json.thread.case_id, undefined, "a client named an engagement");

  // The other client's account is untouched — the strongest statement of the same fact.
  const theirs = await api(app, "portal/threads", { headers: b.h });
  assert.deepEqual(theirs.json, [], "beta can see a thread acme's request created");
});

test("portal: with no channel on the project, nothing is created and the client is told", async () => {
  // THE BUG THIS PREVENTS: `threads.channel_id` is NOT NULL and there is no honest client-side
  // choice of channel. Inventing one would file the client's message on a channel the business
  // cannot reply on — a message written into a drawer nobody opens, reported as "Sent." That is the
  // "failed while reporting success" shape this codebase keeps paying for.
  _resetPortal();
  // `makeFreshApp`, not `makeApp`: the domain store is a process-wide singleton, so a channel another
  // test in this file created is still there and this project would not be channel-less at all.
  const { app } = await makeFreshApp();
  const domain = getDomainStore();
  const projectId = (await api(app, "me")).json.projects[0].id as string;
  const client = await domain.createClient({
    project_id: projectId, display_name: "solo", handles: ["solo@x.test"], metadata: {},
  });
  const link = await api(app, `clients/${client.id}/portal-link`, { method: "POST" });
  const token = (
    await api(app, "portal/session", { method: "POST", body: JSON.stringify({ token: link.json.token }) })
  ).json.token as string;
  const h = { authorization: `Bearer ${token}` };

  const created = await api(app, "portal/threads", { method: "POST", headers: h, body: JSON.stringify({ body: "hi" }) });
  assert.equal(created.status, 409);
  assert.match(created.json.error, /nowhere to go/);
  assert.deepEqual((await api(app, "portal/threads", { headers: h })).json, [], "a thread was created anyway");
});

test("portal: an empty message is refused and a long one is not silently truncated", async () => {
  // THE BUG THIS PREVENTS: the composer is the one control on the page. A blank submit that creates
  // an empty thread puts a "No subject / (nothing)" row in the founder's inbox and teaches the client
  // the button does nothing. And a message quietly cut at the cap is the client believing they sent
  // a paragraph they did not — the same cap and the same 413 as the reply route.
  const { app, a } = await world();

  assert.equal((await api(app, "portal/threads", { method: "POST", headers: a.h, body: JSON.stringify({ body: "   " }) })).status, 400);
  assert.equal((await api(app, "portal/threads", { method: "POST", headers: a.h, body: JSON.stringify({}) })).status, 400);
  const long = await api(app, "portal/threads", {
    method: "POST", headers: a.h, body: JSON.stringify({ body: "x".repeat(10_001) }),
  });
  assert.equal(long.status, 413);
  assert.deepEqual((await api(app, "portal/threads", { headers: a.h })).json, []);
});

test("portal: a message with no subject gets one derived from its first line", async () => {
  // THE BUG THIS PREVENTS: no subject is the common case on a phone, and storing NULL renders as
  // "No subject" next to a message that plainly has one — in the client's own list AND in the
  // founder's inbox, where it is the only thing they have to triage on.
  const { app, a } = await world();
  const created = await api(app, "portal/threads", {
    method: "POST", headers: a.h, body: JSON.stringify({ body: "Our year end moved\n\nIt's now March." }),
  });
  assert.equal(created.json.thread.subject, "Our year end moved");
});

test("portal: the page can name the business, and only the one the session is in", async () => {
  // THE BUG THIS PREVENTS: observed in production 2026-08-10 — nothing on the signed-in portal
  // identified the agency. A client had no idea whose portal they were on, or whether their
  // documents were on their accountant's system or a stranger's. The hosted app answers for every
  // tenant on ONE hostname, so it cannot resolve the brand from the Host header the way the
  // per-tenant template does; the session is the only thing it holds.
  //
  // The second half is the reason this is a session-keyed route with no path parameter: there is
  // nothing here to iterate, so a client session cannot walk the estate's branding.
  const { app, a } = await world();
  const biz = await api(app, "portal/business", { headers: a.h });
  assert.equal(biz.status, 200);
  assert.ok(biz.json.display_name, "the portal still has no name to show a client");
  assert.match(biz.json.accent, /^#[0-9a-f]{6}$/);
  // No project id in, none out, and no bytes: this is on every portal page load.
  assert.equal(biz.json.logo, undefined);
  assert.equal(biz.json.project_id, undefined);

  const anon = await api(app, "portal/business", {}, "not-a-session");
  assert.equal(anon.status, 401, "the business's brand is readable without a client session");
});
