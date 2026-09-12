import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { api, makeApp, waitTask, KEY } from "./helpers";
import { getDomainStore } from "../src/domain";
import { emitEvent } from "../src/events";
import {
  _resetPortal,
  exchangePortalLink,
  mintPortalLink,
  resolveClientSession,
  revokeClientSessions,
} from "../src/portal";

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

  // Single SESSION rather than single request — see `EXCHANGE_GRACE_MS`. Re-exchanging straight
  // away hands back the session that already exists rather than minting a second one, because the
  // second fetch of a link within a minute of the first is far more often the human clicking after
  // a mail scanner than it is an attacker.
  const replay = await api(app, "portal/session", { method: "POST", body: JSON.stringify({ token }) });
  assert.equal(replay.status, 200);
  assert.equal(replay.json.token, session.json.token, "one link, one session, however many clicks");

  // Forged and expired look identical to each other — otherwise a stale link tells whoever is
  // holding it whether it was ever real.
  const forged = await api(app, "portal/session", { method: "POST", body: JSON.stringify({ token: "mpl_nope" }) });
  assert.equal(forged.status, 401);
  const stale = mintPortalLink({ project_id: "p0", client_id: "c0", ttlMs: -1 });
  const expired = await api(app, "portal/session", { method: "POST", body: JSON.stringify({ token: stale.token }) });
  assert.equal(expired.status, 401);
  assert.equal(forged.json.error, expired.json.error);
});

test("portal: a link scanner cannot burn a link the human has not clicked yet", async () => {
  // THE BUG THIS EXISTS FOR. A one-time link travels by email, and the things that fetch a URL out
  // of an email before its recipient does are entirely routine: Defender Safe Links, Mimecast and
  // Proofpoint follow every href to score it, and throw the response — session and all — away.
  // Under strict single-use the human's click was then the SECOND exchange, and they were told the
  // link had expired, with nothing on the page to do about it.
  _resetPortal();
  mock.timers.enable({ apis: ["Date"], now: Date.now() });
  try {
    const link = mintPortalLink({ project_id: "p1", client_id: "c1" });

    const scanner = await exchangePortalLink(link.token);
    assert.ok(scanner, "the scanner's GET succeeds — it cannot be stopped from here, only survived");

    mock.timers.tick(90_000); // The person reads the mail a minute and a half later.
    const human = await exchangePortalLink(link.token);
    assert.ok(human, "and the person the link was written for gets in");
    assert.equal(human.token, scanner.token, "on the SAME session — not a second one to revoke");
    assert.deepEqual(human.scope, { kind: "client", project_id: "p1", client_id: "c1" });

    // The window is not a hole left propped open. Past it the original guarantee is back, which is
    // the property the `used` flag was introduced for: a forwarded email is worthless tomorrow.
    mock.timers.tick(16 * 60 * 1000);
    assert.equal(await exchangePortalLink(link.token), undefined, "grace is minutes, not days");
  } finally {
    mock.timers.reset();
  }
});

test("portal: revoking access beats the grace window", async () => {
  // Otherwise the mechanism above would be a bypass with a clock on it: a founder revokes at 10:00
  // and a link exchanged at 09:58 still works until 10:13. The replay is bound to the SESSION, and
  // revoking deletes sessions, so cutting a client off cuts off every replay of their link too —
  // without `revokeClientSessions` needing to know the grace window exists.
  _resetPortal();
  const link = mintPortalLink({ project_id: "p2", client_id: "c2" });
  assert.ok(await exchangePortalLink(link.token));
  await revokeClientSessions("c2");
  assert.equal(await exchangePortalLink(link.token), undefined);
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

test("portal: a client's reply starts work, and their stream hides the operator's internals", async () => {
  _resetPortal();
  const { app } = makeApp();
  const projectId = (await api(app, "me")).json.projects[0].id;
  const domain = getDomainStore();

  // A thread on a real channel, which is what makes a reply actionable rather than just recorded.
  const conn = await domain.createConnection({
    project_id: projectId, kind: "email", name: "mail",
    owner: { kind: "founder", id: "founder" }, config: { api_url: "http://x", from: "a@b.c" },
  });
  const channel = await domain.createChannel({
    project_id: projectId, connection_id: conn.id, kind: "email", address: "ops@x.test",
    wedge: "books-keeper", task_type: "daily_sync",
  });
  const cl = await domain.createClient({ project_id: projectId, display_name: "acme", handles: ["a@x.test"], metadata: {} });
  const thread = await domain.createThread({ project_id: projectId, client_id: cl.id, channel_id: channel.id, subject: "hi", status: "open" });

  const link = await api(app, `clients/${cl.id}/portal-link`, { method: "POST" });
  const tok = (await api(app, "portal/session", { method: "POST", body: JSON.stringify({ token: link.json.token }) })).json.token as string;

  const sent = await api(app, `portal/threads/${thread.id}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${tok}` },
    body: JSON.stringify({ body: "can you check my March receipts?" }),
  });
  assert.equal(sent.status, 201);
  // The whole point: recording the message and stopping there made the portal a suggestion box.
  assert.ok(sent.json.task_id, "a reply starts a run rather than waiting for the founder to notice");

  // The run is scoped to this client, so its connection grants are too.
  const task = (await api(app, `tasks/${sent.json.task_id}`)).json;
  assert.equal(task.actor.id, cl.id);
  assert.equal(task.project_id, projectId);

  await waitTask(app, sent.json.task_id as string);

  // A customer may watch their own run…
  const res = await app.request(`/v1/portal/tasks/${sent.json.task_id}/events`, {
    headers: { authorization: `Bearer ${tok}` },
  });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /task\.created/);
  assert.match(body, /task\.finished/);

  // …but not the operator's internals. An allowlist, so a new event type is invisible to clients
  // until someone decides otherwise — the safe default when the alternative leaks whatever's added
  // next. Costs are margins; token.delta is raw model output before validation.
  assert.ok(!body.includes("cost.charged"), "a customer must not see what the run cost");
  assert.ok(!body.includes("token.delta"), "nor unvalidated model output");
  assert.ok(!body.includes("approval."), "nor that a human had to sign it off");

  // And not someone else's run. The founder-plane stream stays unreachable with a client token.
  assert.equal((await app.request(`/v1/tasks/${sent.json.task_id}/events`, { headers: { authorization: `Bearer ${tok}` } })).status, 401);
  const other = await api(app, "tasks", {
    method: "POST",
    body: JSON.stringify({ wedge: "books-keeper", task_type: "daily_sync", input: {} }),
  });
  assert.equal(
    (await app.request(`/v1/portal/tasks/${other.json.id}/events`, { headers: { authorization: `Bearer ${tok}` } })).status,
    404,
    "a run that isn't theirs doesn't exist as far as they're concerned",
  );
});

test("portal: a session outlives the process that minted it", async () => {
  // These were in-process Maps. A deploy silently signed out every customer — they clicked the link
  // in their inbox and were told it was no longer valid — and on two replicas a link minted by one
  // could not be exchanged on the other. The cache is still there for speed; the point of this test
  // is that a miss is no longer the same as "invalid".
  const { app } = makeApp();
  const domain = getDomainStore();
  const projectId = (await api(app, "me")).json.projects[0].id;
  const clientRow = await domain.createClient({ project_id: projectId, display_name: "Durable Co" } as never);

  const link = mintPortalLink({ project_id: projectId, client_id: clientRow.id });
  const session = (await exchangePortalLink(link.token))!;
  assert.ok(await resolveClientSession(session.token), "resolves while cached");

  // Simulate the replica that never saw it: clear the process-local cache only.
  _resetPortal();
  const after = await resolveClientSession(session.token);
  if (process.env.MYCEL_DATABASE_URL) {
    assert.ok(after, "a durable install resolves it from the database");
    assert.equal(after!.client_id, clientRow.id);
  } else {
    // Without a database there is nowhere else to look, and saying so plainly is the honest
    // behaviour — this is the single-process development default.
    assert.equal(after, undefined);
  }
});

test("portal: two clicks racing on one link produce ONE session, not two", async () => {
  // A forwarded email, or a scanner and a human landing together, produces exactly this. With a
  // database the claim is one UPDATE … WHERE used = false, so only one caller can create anything;
  // the loser now replays the winner's session instead of being turned away.
  //
  // What is asserted is the invariant that actually matters, and it did not change when the grace
  // window was added: a link is a route to ONE session. Two sessions from one link would mean
  // revoking a client left a credential behind that nothing was tracking.
  const { app } = makeApp();
  const domain = getDomainStore();
  const projectId = (await api(app, "me")).json.projects[0].id;
  const clientRow = await domain.createClient({ project_id: projectId, display_name: "Race Co" } as never);
  const link = mintPortalLink({ project_id: projectId, client_id: clientRow.id });

  const [a, b] = await Promise.all([exchangePortalLink(link.token), exchangePortalLink(link.token)]);
  assert.ok(a && b, "neither click is turned away");
  assert.equal(a.token, b.token, "exactly one session exists, and both clicks hold it");
});

test("portal: an allowed event still can't carry the operator's words to the customer", async () => {
  // The type allowlist was only half the boundary. Every allowed event's whole `data` object went
  // out verbatim, and `progress.note` is free text written by the runtime and the agent — a
  // customer watching a run saw "mock runtime — no sandbox, canned result". Anything the agent
  // decides to narrate about its own internals reached the client the same way.
  const { app, store } = makeApp();
  const domain = getDomainStore();
  const projectId = (await api(app, "me")).json.projects[0].id;
  const clientRow = await domain.createClient({ project_id: projectId, display_name: "Watcher" } as never);
  const now = new Date().toISOString();
  const taskId = `leak-${Date.now()}`;
  await store.createTask({
    id: taskId, project_id: projectId, wedge: "books-keeper", task_type: "daily_sync",
    actor: { kind: "user", id: clientRow.id }, input: { client_id: clientRow.id },
    constraints: {}, tools: [], status: "succeeded", cost_usd: 0.42, created_at: now, updated_at: now,
  } as never);

  await emitEvent(store, taskId, "progress", { note: "mock runtime — no sandbox, canned result" });
  await emitEvent(store, taskId, "tool.called", { tool: "gmail_send", arguments: { to: "someone-else@example.com" } });
  await emitEvent(store, taskId, "artifact.created", { artifact_id: "a1", name: "july.pdf", content_type: "application/pdf" });
  await emitEvent(store, taskId, "task.finished", { status: "succeeded", cost_usd: 0.42, model: "claude-x" });

  const session = (await exchangePortalLink(
    mintPortalLink({ project_id: projectId, client_id: clientRow.id }).token,
  ))!.token;
  const res = await app.request(`/v1/portal/tasks/${taskId}/events`, {
    headers: { authorization: `Bearer ${session}`, "Last-Event-ID": "0" },
  });
  const body = await res.text();

  assert.ok(!body.includes("mock runtime"), "the operator's narration does not reach the customer");
  assert.ok(!body.includes("someone-else@example.com"), "nor a tool call's arguments");
  assert.ok(!body.includes("claude-x"), "nor which model ran");
  assert.ok(!body.includes("0.42"), "nor what it cost");

  // …while everything the customer legitimately needs still arrives.
  assert.ok(body.includes("july.pdf"), "the file they are about to download is named");
  assert.ok(body.includes("gmail_send"), "and which capability ran, without its arguments");
  assert.ok(body.includes("succeeded"), "and that it finished");

  // The founder plane is untouched — they are entitled to all of it.
  const asFounder = await app.request(`/v1/tasks/${taskId}/events`, {
    headers: { authorization: `Bearer ${KEY}`, "Last-Event-ID": "0" },
  });
  const full = await asFounder.text();
  assert.ok(full.includes("mock runtime") && full.includes("claude-x"), "nothing is hidden from the operator");
});
