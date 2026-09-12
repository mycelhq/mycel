// FIFTY-ONE ASKS, ZERO DELIVERED.
//
// Every client request in production has `thread_id` NULL. Not most — all of them. Forty-one still
// open, median eleven and a half days, and across twenty-one projects there is ONE channel, ONE
// thread and ONE message ever sent. The chain that makes this product autonomous has never once
// completed: a run needs a document, files a question against a client who is never told, the client
// never answers, the work starves, and the engine produces a well-typeset "inputs not supplied".
//
// `portal-threads.ts` already refuses to open a conversation with no channel. This path returned a
// 201 and a request id for the identical missing thing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { api, makeApp } from "./helpers";
import { getDomainStore } from "../src/domain";
import { getRequestStore } from "../src/requests";
import { registerActionGrant } from "../src/actiongrants";
import { clientReachable, redirectedNote } from "../src/ask-reachable";

const WEDGE = "books-keeper";

/** An email connection the way `resolveCapability("send_email", …)` expects to find one. */
const mailbox = [
  {
    id: "c1", project_id: "p1", kind: "email", name: "mailbox",
    owner: { kind: "founder", id: "f" },
    config: { from: "hello@practice.test", api_url: "https://api.postmark.test/email" },
    secret_ref: "env:MAIL", created_at: "", updated_at: "",
  },
] as never[];

test("reachable: both halves are required, and each says which is missing", () => {
  const addressed = { handles: ["ops@acme.test"] };

  assert.equal(clientReachable(mailbox, "p1", addressed).ok, true, "a real email connection must count as sendable");

  // A mailbox with nobody to send to is as undeliverable as the reverse, and both were being filed
  // as though a customer had been contacted.
  assert.match(clientReachable(mailbox, "p1", { handles: [] }).because ?? "", /nowhere to send a question TO/);
  assert.match(clientReachable([], "p1", addressed).because ?? "", /nothing to send a client question FROM/);
  assert.match(clientReachable([], "p1", { handles: [] }).because ?? "", /nothing connected that can send email/);

  // A connection belonging to a DIFFERENT project does not make this one sendable.
  assert.equal(clientReachable(mailbox, "p2", addressed).ok, false);

  // A blank string is not an address.
  assert.equal(clientReachable(mailbox, "p1", { handles: ["  ", ""] }).ok, false);
  assert.equal(clientReachable(mailbox, "p1", undefined).ok, false);
});

test("reachable: the send test is the SENDER'S, not a second opinion", () => {
  // The first version counted `channels`, because that is what portal-threads refuses on. Four
  // existing wait tests caught it: a project can hold an email connection and no channel and send
  // perfectly well. Two functions answering "can this go out" is two answers, and the wrong one is
  // the one that never runs at send time.
  const src = readFileSync(new URL("../src/ask-reachable.ts", import.meta.url), "utf8");
  assert.match(src, /resolveCapability\("send_email", connections, projectId\)/);
  assert.ok(!/listChannels|ChannelLike/.test(src), "it is back to counting channels");
});

test("reachable: the run is told not to wait, because a wait on an unsent question never ends", () => {
  const note = redirectedNote("Where is the March statement?", "this business has no mailbox connected");
  assert.match(note, /Not sent to the client/);
  assert.match(note, /in front of the founder/);
  // The load-bearing sentence. A run that believes it asked the client parks on a wait nothing can
  // satisfy, which is a stalled engagement no log explains.
  assert.match(note, /Do not wait on a client reply/);
});

test("reachable: an unreachable client ask becomes a founder gap, not a silent client request", async () => {
  const { app, store } = makeApp();
  const projectId = (await api(app, "me")).json.projects[0].id as string;
  // A client with an address but NO mailbox on the project — the exact production shape.
  const client = await getDomainStore().createClient({
    project_id: projectId, display_name: "Brightline", handles: ["ops@brightline.test"],
  } as never);

  const taskId = `unreachable-${randomUUID()}`;
  const now = new Date().toISOString();
  await store.createTask({
    id: taskId, project_id: projectId, client_id: client.id, case_id: "case-x", wedge: WEDGE,
    task_type: "reconcile", actor: { kind: "system", id: "scheduler" }, input: {}, constraints: {},
    tools: [], status: "running", cost_usd: 0, created_at: now, updated_at: now,
  } as never);
  const nonce = await registerActionGrant({ task_id: taskId, connectionIds: [] });

  const before = (await getRequestStore().listRequests({ project_id: projectId })).length;
  const r = (
    await api(app, "internal/knowledge/gap", {
      method: "POST",
      headers: { authorization: `Bearer ${nonce}` },
      body: JSON.stringify({
        question: "Where is the receipt for the 14 March payment?",
        ask_client: true, kind: "document", fallback: "assumed the Q1 retainer",
      }),
    })
  ).json;

  assert.equal(r.asked, "founder", "an undeliverable question was still filed against the client");
  assert.equal(r.redirected, true);
  assert.ok(r.recorded, "the question was discarded instead of redirected — a run with no answer guesses");
  assert.match(String(r.because), /no mailbox/);
  // NOTHING was filed against the client. That is the whole point: fifty-one rows that looked like
  // contact and were not.
  assert.equal((await getRequestStore().listRequests({ project_id: projectId })).length, before);
});

test("reachable: a client who CAN be reached is still asked, exactly as before", async () => {
  // The refusal must be narrow. A product that stopped asking clients anything would be worse than
  // one that asks into the void.
  const { app, store } = makeApp();
  const projectId = (await api(app, "me")).json.projects[0].id as string;
  await getDomainStore().createConnection({
    project_id: projectId, kind: "email", name: "mailbox", owner: { kind: "founder", id: "f" },
    config: { from: "hello@practice.test", api_url: "https://api.postmark.test/email" }, secret_ref: "env:MAIL",
  } as never);
  const client = await getDomainStore().createClient({
    project_id: projectId, display_name: "Acme", handles: ["ops@acme.test"],
  } as never);

  const taskId = `reachable-${randomUUID()}`;
  const now = new Date().toISOString();
  await store.createTask({
    id: taskId, project_id: projectId, client_id: client.id, case_id: "case-y", wedge: WEDGE,
    task_type: "reconcile", actor: { kind: "system", id: "scheduler" }, input: {}, constraints: {},
    tools: [], status: "running", cost_usd: 0, created_at: now, updated_at: now,
  } as never);
  const nonce = await registerActionGrant({ task_id: taskId, connectionIds: [] });

  const r = (
    await api(app, "internal/knowledge/gap", {
      method: "POST",
      headers: { authorization: `Bearer ${nonce}` },
      body: JSON.stringify({ question: "Which bank is the October statement from?", ask_client: true, kind: "text" }),
    })
  ).json;
  assert.equal(r.asked, "client");
  assert.ok(r.request_id);
  assert.notEqual(r.redirected, true);
});
