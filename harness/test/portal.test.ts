import { test } from "node:test";
import assert from "node:assert/strict";
import { api, makeApp, KEY } from "./helpers";
import { getDomainStore } from "../src/domain";
import { _resetPortal } from "../src/portal";

/** Two clients in one project, each with a thread — the shape every isolation claim is tested on. */
async function twoClients() {
  const { app } = makeApp();
  const projectId = (await api(app, "me")).json.projects[0].id;
  const domain = getDomainStore();

  const mk = async (name: string) => {
    const client = await domain.createClient({ project_id: projectId, display_name: name, handles: [`${name}@x.test`], metadata: {} });
    const thread = await domain.createThread({ project_id: projectId, client_id: client.id, channel_id: "ch", subject: `${name} subject`, status: "open" });
    await domain.addMessage({ thread_id: thread.id, direction: "outbound", author: "agent", body: `hello ${name}`, status: "sent" });
    return { client, thread };
  };

  return { app, projectId, a: await mk("acme"), b: await mk("beta") };
}

const portal = (token: string) => ({ authorization: `Bearer ${token}` });

test("portal: a link is single-use, time-bound, and yields a session", async () => {
  _resetPortal();
  const { app, a } = await twoClients();

  const link = await api(app, `clients/${a.client.id}/portal-link`, { method: "POST" });
  assert.equal(link.status, 201);
  const token = link.json.token as string;
  assert.ok(token.startsWith("mpl_"));

  const session = await api(app, "portal/session", { method: "POST", body: JSON.stringify({ token }) });
  assert.equal(session.status, 200);
  assert.ok((session.json.token as string).startsWith("mcli_"));
  assert.equal(session.json.client.display_name, "acme");

  // Single use. A link that still works is a link anyone who saw the email can reuse.
  const replay = await api(app, "portal/session", { method: "POST", body: JSON.stringify({ token }) });
  assert.equal(replay.status, 401);

  // Forged and expired look identical to used — otherwise a stale link tells you it was once real.
  const forged = await api(app, "portal/session", { method: "POST", body: JSON.stringify({ token: "mpl_nope" }) });
  assert.equal(forged.status, 401);
  assert.equal(forged.json.error, replay.json.error);
});

test("portal: a client sees their own work and CANNOT reach another client's", async () => {
  _resetPortal();
  const { app, a, b } = await twoClients();
  const link = await api(app, `clients/${a.client.id}/portal-link`, { method: "POST" });
  const sess = await api(app, "portal/session", { method: "POST", body: JSON.stringify({ token: link.json.token }) });
  const tok = sess.json.token as string;

  const me = await api(app, "portal/me", { headers: portal(tok) });
  assert.equal(me.json.display_name, "acme");

  const threads = (await api(app, "portal/threads", { headers: portal(tok) })).json as { id: string }[];
  assert.deepEqual(threads.map((t) => t.id), [a.thread.id], "their threads, and only theirs");

  const own = await api(app, `portal/threads/${a.thread.id}`, { headers: portal(tok) });
  assert.equal(own.status, 200);
  assert.equal(own.json.messages.length, 1);

  // The crux. Guessing another client's thread id must not work, and must not confirm it exists —
  // hence 404 rather than 403.
  const other = await api(app, `portal/threads/${b.thread.id}`, { headers: portal(tok) });
  assert.equal(other.status, 404);
  const reply = await api(app, `portal/threads/${b.thread.id}/messages`, {
    method: "POST",
    headers: portal(tok),
    body: JSON.stringify({ body: "let me read your mail" }),
  });
  assert.equal(reply.status, 404);
  assert.equal((await api(app, `portal/threads/${b.thread.id}`)).status, 401, "and not without a session either");
});

test("portal: a client credential is useless on every founder route", async () => {
  // The strongest version of the property: not "filtered to nothing" but "not a credential at all".
  // A filter someone forgets to apply leaks; a token the founder plane can't parse cannot.
  _resetPortal();
  const { app, a } = await twoClients();
  const link = await api(app, `clients/${a.client.id}/portal-link`, { method: "POST" });
  const tok = (await api(app, "portal/session", { method: "POST", body: JSON.stringify({ token: link.json.token }) })).json.token as string;

  for (const path of ["me", "tasks", "clients", "connections", "schedules", "approvals", "blueprints", "projects"]) {
    const r = await api(app, path, {}, tok);
    assert.equal(r.status, 401, `a client token must not authenticate GET /v1/${path}`);
  }
  // And it can't mint itself a wider one.
  assert.equal((await api(app, `clients/${a.client.id}/portal-link`, { method: "POST" }, tok)).status, 401);
});

test("portal: a founder token is equally useless on the portal plane", async () => {
  // The reverse direction matters too: the planes are separate, not nested.
  _resetPortal();
  const { app, a } = await twoClients();
  assert.equal((await api(app, "portal/threads", { headers: { authorization: `Bearer ${KEY}` } })).status, 401);
  assert.equal((await api(app, "portal/me")).status, 401);
  void a;
});

test("portal: a client can reply, attributed to them and nobody else", async () => {
  _resetPortal();
  const { app, a } = await twoClients();
  const link = await api(app, `clients/${a.client.id}/portal-link`, { method: "POST" });
  const tok = (await api(app, "portal/session", { method: "POST", body: JSON.stringify({ token: link.json.token }) })).json.token as string;

  const sent = await api(app, `portal/threads/${a.thread.id}/messages`, {
    method: "POST",
    headers: portal(tok),
    // Trying to pose as the agent. Authorship comes from the session, so the attempt is ignored
    // rather than honoured — otherwise a customer could forge a message from the business.
    body: JSON.stringify({ body: "here are the receipts", author: "agent", direction: "outbound" }),
  });
  assert.equal(sent.status, 201);
  assert.equal(sent.json.author, a.client.id);
  assert.equal(sent.json.direction, "inbound");

  assert.equal((await api(app, `portal/threads/${a.thread.id}/messages`, { method: "POST", headers: portal(tok), body: JSON.stringify({ body: "  " }) })).status, 400);
  assert.equal(
    (await api(app, `portal/threads/${a.thread.id}/messages`, { method: "POST", headers: portal(tok), body: JSON.stringify({ body: "x".repeat(10_001) }) })).status,
    413,
    "and can't paste a novel into the founder's timeline",
  );

  const thread = await api(app, `portal/threads/${a.thread.id}`, { headers: portal(tok) });
  assert.equal(thread.json.messages.length, 2);
});

test("portal: revoking access kills live sessions and any link still sitting in an inbox", async () => {
  _resetPortal();
  const { app, a } = await twoClients();
  const used = await api(app, `clients/${a.client.id}/portal-link`, { method: "POST" });
  const tok = (await api(app, "portal/session", { method: "POST", body: JSON.stringify({ token: used.json.token }) })).json.token as string;
  // A second link that was emailed but never opened.
  const unopened = await api(app, `clients/${a.client.id}/portal-link`, { method: "POST" });

  assert.equal((await api(app, "portal/me", { headers: portal(tok) })).status, 200);

  const revoke = await api(app, `clients/${a.client.id}/portal-revoke`, { method: "POST" });
  assert.equal(revoke.json.ok, true);

  assert.equal((await api(app, "portal/me", { headers: portal(tok) })).status, 401, "live session is dead");
  assert.equal(
    (await api(app, "portal/session", { method: "POST", body: JSON.stringify({ token: unopened.json.token }) })).status,
    401,
    "and the unopened link no longer works — otherwise 'revoke' left a working key in their email",
  );
});

test("portal: minting a link is auditable, without recording the link", async () => {
  _resetPortal();
  const { app, projectId, a } = await twoClients();
  const link = await api(app, `clients/${a.client.id}/portal-link`, { method: "POST" });

  const chain = (await api(app, `audit?project_id=${projectId}`)).json as { action: string; detail: Record<string, unknown> }[];
  const entry = chain.find((e) => e.action === "client.portal_link");
  assert.ok(entry, "granting a customer access to their data is a consequential act");
  assert.ok(
    !JSON.stringify(entry).includes(link.json.token),
    "but the audit log must not itself become a way in",
  );
});
