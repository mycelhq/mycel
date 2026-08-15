// The inbound half of email — the loop that did not exist.
//
// The failure every test here defends against is one sequence: we email a client chasing money, they
// reply "I paid on the 3rd, reference X", the kernel never sees it, and three days later the ladder
// escalates at somebody who answered us. Making that impossible needs four things to hold at once —
// the webhook must be authentic, it must land in the right tenant, the reply must attach to the
// conversation it answers, and it must actually stop the chase. Each of those is a separate way to
// ship something that looks finished and is not, so each has its own test naming its own bug.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { api, makeFreshApp } from "./helpers";
import {
  _resetUnattributedInbound,
  claimDomainForProject,
  deliverabilityAdvice,
  findAgentMailThread,
  findAgentMailThreadGlobal,
  linkAgentMailThread,
  listUnattributedInbound,
  parseAddress,
  parseAgentMailInbound,
  signAgentMailWebhook,
  spfConflict,
  verifyAgentMailWebhook,
} from "../src/agentmail";
import { getBillingStore } from "../src/billing";
import type { Invoice } from "../src/contract";
import { getDomainStore } from "../src/domain";
import { setChaseDeps } from "../src/dunning";
import { intakeSourceForChannelKind, resetIntakeReplay } from "../src/intake-normalize";
import { noteClientReplyOnInvoice, paymentQuestionGate, QUESTION_GRACE_HOURS } from "../src/payments.manual";

// A real Svix secret is `whsec_` + base64. Both are used below, because which of the two you feed to
// the HMAC is the single most likely thing to get wrong here — see the trap test.
const SECRET = "whsec_" + Buffer.from("a-test-signing-key-for-agentmail").toString("base64");
process.env.AGENTMAIL_API_KEY = "test-key";
process.env.AGENTMAIL_WEBHOOK_SECRET = SECRET;

type App = Awaited<ReturnType<typeof makeFreshApp>>["app"];

function receivedEvent(o: {
  inbox_id: string;
  thread_id?: string;
  message_id?: string;
  from?: string;
  subject?: string;
  text?: string;
}): Record<string, unknown> {
  return {
    type: "event",
    event_type: "message.received",
    event_id: `evt_${randomUUID()}`,
    message: {
      inbox_id: o.inbox_id,
      thread_id: o.thread_id ?? `thd_${randomUUID()}`,
      message_id: o.message_id ?? `<${randomUUID()}@agentmail.to>`,
      from: o.from ?? "Jane Doe <jane@client.test>",
      to: ["Billing <billing@acme.test>"],
      subject: o.subject ?? "Re: Invoice INV-1",
      text: o.text ?? "I paid this on the 3rd, reference ABC123.",
      timestamp: new Date().toISOString(),
    },
    thread: { thread_id: o.thread_id ?? "thd_x", inbox_id: o.inbox_id },
  };
}

/** POST a delivery, signed unless the caller asks for something else. */
async function deliver(
  app: App,
  body: unknown,
  opts: { secret?: string; signature?: string; timestamp?: string; id?: string } = {},
) {
  const raw = JSON.stringify(body);
  const id = opts.id ?? `msg_${randomUUID()}`;
  const timestamp = opts.timestamp ?? String(Math.floor(Date.now() / 1000));
  const signature = opts.signature ?? signAgentMailWebhook({ secret: opts.secret ?? SECRET, webhookId: id, timestamp, rawBody: raw });
  const res = await app.request("/v1/agentmail/webhook", {
    method: "POST",
    // No authorization header, deliberately: the point of this route is that the signature is the
    // only credential. A test that authenticated as well would pass with the verifier removed.
    headers: { "content-type": "application/json", "svix-id": id, "svix-timestamp": timestamp, "svix-signature": signature },
    body: raw,
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-json */
  }
  return { status: res.status, json, text };
}

/** A tenant with a provisioned mailbox: connection + channel, exactly as the provisioning route makes. */
async function mailbox(projectId: string, address = `billing-${randomUUID().slice(0, 8)}@acme.test`) {
  const domain = getDomainStore();
  const inboxId = `inbox_${randomUUID()}`;
  const conn = await domain.createConnection({
    project_id: projectId,
    kind: "agentmail",
    name: `mailbox ${address}`,
    owner: { kind: "founder", id: "founder" },
    config: { inbox_id: inboxId, address, from: address },
  });
  const channel = await domain.createChannel({
    project_id: projectId,
    connection_id: conn.id,
    kind: "agentmail",
    address,
    wedge: "books-keeper",
    task_type: "daily_sync",
  });
  return { conn, channel, inboxId, address };
}

async function firstProject(app: App): Promise<string> {
  return (await api(app, "me")).json.projects[0].id;
}

// ═══════════════════════════ SIGNATURE ═══════════════════════════

test("a forged webhook is refused: without this, anyone who learns the URL can stop a company's dunning ladder", async () => {
  const { app } = await makeFreshApp();
  const { inboxId } = await mailbox(await firstProject(app));

  const forged = await deliver(app, receivedEvent({ inbox_id: inboxId }), { signature: "v1,bm90LWEtc2lnbmF0dXJl" });
  assert.equal(forged.status, 401);
  assert.equal(forged.json.reason, "mismatch");

  // Signed with a key that is not ours — the shape an attacker who read the docs would produce.
  const wrongKey = await deliver(app, receivedEvent({ inbox_id: inboxId }), {
    secret: "whsec_" + Buffer.from("some-other-tenants-key").toString("base64"),
  });
  assert.equal(wrongKey.status, 401);
});

test("an unsigned webhook is refused: a missing header must not read as 'nothing to check'", async () => {
  const { app } = await makeFreshApp();
  const raw = JSON.stringify(receivedEvent({ inbox_id: "inbox_whatever" }));
  const res = await app.request("/v1/agentmail/webhook", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw,
  });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).reason, "missing_headers");
});

test("a captured delivery cannot be replayed forever: an old timestamp is refused even with a valid signature", async () => {
  const { app } = await makeFreshApp();
  const { inboxId } = await mailbox(await firstProject(app));
  const old = String(Math.floor(Date.now() / 1000) - 3600);
  const res = await deliver(app, receivedEvent({ inbox_id: inboxId }), { timestamp: old });
  assert.equal(res.status, 401);
  assert.equal(res.json.reason, "stale");
});

test("THE SVIX TRAP: the secret is base64-DECODED, so a signature made with the raw secret string is refused", () => {
  // composio.ts documents the mirror of this bug — Composio's scheme looks like Svix but uses the
  // secret as raw UTF-8. Copying that verifier here produces one that rejects every real AgentMail
  // delivery, and a test that signs the same wrong way would never notice. So: sign the wrong way on
  // purpose and require a refusal.
  const rawBody = '{"hello":"world"}';
  const webhookId = "msg_1";
  const timestamp = String(Math.floor(Date.now() / 1000));
  const undecoded = createHmac("sha256", SECRET).update(`${webhookId}.${timestamp}.${rawBody}`).digest("base64");

  const wrong = verifyAgentMailWebhook({ secret: SECRET, webhookId, timestamp, rawBody, signature: `v1,${undecoded}` });
  assert.equal(wrong.ok, false);

  const right = verifyAgentMailWebhook({
    secret: SECRET,
    webhookId,
    timestamp,
    rawBody,
    signature: signAgentMailWebhook({ secret: SECRET, webhookId, timestamp, rawBody }),
  });
  assert.equal(right.ok, true);
});

test("unconfigured is ABSENT, not broken and not open: no secret means the route accepts nothing", async () => {
  const { app } = await makeFreshApp();
  const saved = process.env.AGENTMAIL_WEBHOOK_SECRET;
  delete process.env.AGENTMAIL_WEBHOOK_SECRET;
  try {
    const res = await deliver(app, receivedEvent({ inbox_id: "inbox_x" }));
    // 501 and not 200: an unconfigured deployment must not quietly become an unauthenticated
    // "write into this company's conversation" endpoint.
    assert.equal(res.status, 501);
    assert.equal(res.json.code, "agentmail.unconfigured");
  } finally {
    process.env.AGENTMAIL_WEBHOOK_SECRET = saved;
  }
});

// ═══════════════════════════ TENANCY ═══════════════════════════

test("the project comes from OUR record of the inbox: a payload naming another project cannot move an inbound", async () => {
  const { app } = await makeFreshApp();
  resetIntakeReplay();
  const ours = await firstProject(app);
  const { inboxId } = await mailbox(ours);

  const event = receivedEvent({ inbox_id: inboxId });
  // Everything an attacker would try, all at once, in the payload.
  const res = await deliver(app, { ...event, project_id: "proj-someone-else", case_id: randomUUID(), client_id: randomUUID() });
  assert.equal(res.status, 201);

  const task = (await api(app, `tasks/${res.json.task_id}`)).json;
  assert.equal(task.project_id, ours, "the inbound landed in the project our own connection row names");
});

test("a provider thread id belonging to another tenant resolves to nothing: the thread lookup is project-scoped", async () => {
  await makeFreshApp();
  const theirs = `proj-${randomUUID()}`;
  const ours = `proj-${randomUUID()}`;
  const providerThreadId = `thd_${randomUUID()}`;

  await linkAgentMailThread(theirs, {
    provider_thread_id: providerThreadId,
    thread_id: randomUUID(),
    channel_id: randomUUID(),
    client_id: randomUUID(),
    invoice_id: randomUUID(),
  });

  // Same id, our project. If this returned their row, a reply carrying a guessed thread id would be
  // filed into another business's engagement and would stand down THEIR invoice chase.
  assert.equal(await findAgentMailThread(ours, providerThreadId), undefined);
  assert.ok(await findAgentMailThread(theirs, providerThreadId));
});

test("shared inbox: findAgentMailThreadGlobal resolves the project we stored on send", async () => {
  await makeFreshApp();
  const tenant = `proj-${randomUUID()}`;
  const providerThreadId = `thd_${randomUUID()}`;
  const threadId = randomUUID();
  const channelId = randomUUID();
  const clientId = randomUUID();

  await linkAgentMailThread(tenant, {
    provider_thread_id: providerThreadId,
    thread_id: threadId,
    channel_id: channelId,
    client_id: clientId,
  });

  const hit = await findAgentMailThreadGlobal(providerThreadId);
  assert.ok(hit);
  assert.equal(hit!.project_id, tenant);
  assert.equal(hit!.thread_id, threadId);
  assert.equal(hit!.channel_id, channelId);
  assert.equal(await findAgentMailThreadGlobal(`thd_unknown_${randomUUID()}`), undefined);
});

test("an inbound for an inbox nobody owns is surfaced and retryable, never dropped with a 200", async () => {
  const { app } = await makeFreshApp();
  _resetUnattributedInbound();

  const res = await deliver(app, receivedEvent({ inbox_id: "inbox_orphaned" }));
  // 503 so Svix retries — the operator repairing the connection inside the retry window is the
  // recovery. A 200 here is the failure-while-reporting-success shape: the mailbox keeps receiving,
  // every reply is binned, and the first anyone hears is a client asking why they were escalated at.
  assert.equal(res.status, 503);
  assert.equal(res.json.code, "agentmail.unattributed");

  const surfaced = listUnattributedInbound();
  assert.equal(surfaced.length, 1);
  assert.equal(surfaced[0].inbox_id, "inbox_orphaned");
  // And it holds no message content — we do not know whose mail it is, so we must not retain it.
  assert.ok(!JSON.stringify(surfaced[0]).includes("I paid this on the 3rd"));

  const listed = await api(app, "agentmail/unattributed");
  assert.equal(listed.status, 200);
  assert.equal(listed.json.items.length, 1);
});

test("an inbox whose connection has no channel is a fault, not a silent drop", async () => {
  const { app } = await makeFreshApp();
  _resetUnattributedInbound();
  const projectId = await firstProject(app);
  const inboxId = `inbox_${randomUUID()}`;
  // A connection with no channel: nothing says which wedge an inbound runs. Half-provisioned.
  await getDomainStore().createConnection({
    project_id: projectId,
    kind: "agentmail",
    name: "half-provisioned",
    owner: { kind: "founder", id: "founder" },
    config: { inbox_id: inboxId, address: "orphan@acme.test" },
  });

  const res = await deliver(app, receivedEvent({ inbox_id: inboxId }));
  assert.equal(res.status, 503);
  assert.equal(res.json.code, "agentmail.no_channel");
  assert.equal(listUnattributedInbound().length, 1);
});

// ═══════════════════════════ THREADING ═══════════════════════════

test("a reply attaches to the conversation it answers, instead of opening an orphan thread", async () => {
  const { app } = await makeFreshApp();
  resetIntakeReplay();
  const domain = getDomainStore();
  const projectId = await firstProject(app);
  const { channel, inboxId } = await mailbox(projectId);

  // The chase we sent: a client, a thread on an engagement, an outbound message.
  const client = await domain.createClient({ project_id: projectId, display_name: "Jane", handles: ["jane@client.test"], metadata: {} });
  const kase = await domain.createCase({ project_id: projectId, client_id: client.id, kind: "engagement", stage: "open", data: {} } as any);
  const thread = await domain.findOrCreateThread(client.id, channel.id, projectId, "Invoice INV-1", kase.id);
  await domain.addMessage({ thread_id: thread.id, direction: "outbound", author: "agent", body: "Invoice INV-1 is now 12 days overdue." });

  const providerThreadId = `thd_${randomUUID()}`;
  await linkAgentMailThread(projectId, {
    provider_thread_id: providerThreadId,
    thread_id: thread.id,
    channel_id: channel.id,
    client_id: client.id,
    case_id: kase.id,
  });

  const res = await deliver(app, receivedEvent({ inbox_id: inboxId, thread_id: providerThreadId }));
  assert.equal(res.status, 201);
  assert.equal(res.json.thread_id, thread.id, "the reply landed on the thread the chase was sent on");
  assert.equal(res.json.case_id, kase.id, "and the run is an episode of that engagement, not a free-floating job");

  const msgs = await domain.listMessages(thread.id);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[1].direction, "inbound");
  assert.match(msgs[1].body, /reference ABC123/);

  // No second conversation was invented for the same client on the same channel.
  const threads = await domain.listThreadsForClient(client.id);
  assert.equal(threads.length, 1);
});

test("a reply on an unknown provider thread still lands — losing a customer's email is the worse failure", async () => {
  const { app } = await makeFreshApp();
  resetIntakeReplay();
  const projectId = await firstProject(app);
  const { inboxId } = await mailbox(projectId);

  const res = await deliver(app, receivedEvent({ inbox_id: inboxId, from: "Cold Lead <lead@elsewhere.test>" }));
  assert.equal(res.status, 201);
  assert.ok(res.json.thread_id, "it goes to the general conversation rather than nowhere");
  assert.equal(res.json.case_id, undefined);
});

test("a Svix retry replays instead of creating a second task, a second run and a second stand-down", async () => {
  const { app } = await makeFreshApp();
  resetIntakeReplay();
  const projectId = await firstProject(app);
  const { inboxId } = await mailbox(projectId);

  const event = receivedEvent({ inbox_id: inboxId, message_id: "<stable-id@agentmail.to>" });
  const first = await deliver(app, event);
  const second = await deliver(app, event);
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(second.json.task_id, first.json.task_id);
});

// ═══════════════════════════ IT MUST CHANGE BEHAVIOUR ═══════════════════════════

async function chasedInvoice(projectId: string, clientId: string, caseId?: string): Promise<Invoice> {
  const inv = await getBillingStore().createInvoice({
    project_id: projectId,
    client_id: clientId,
    ...(caseId ? { case_id: caseId } : {}),
    currency: "GBP",
    status: "sent",
    lines: [{ id: "l1", description: "March retainer", kind: "fixed", quantity_milli: 1000, unit_amount: 400_000 }],
    issue_date: "2026-02-01",
    due_date: "2026-03-01",
  } as any);
  return (await getBillingStore().updateInvoice(inv.id, { last_chased_at: new Date().toISOString() } as any)) ?? inv;
}

test("a reply on a chased invoice stands the in-flight chase down: the email must not go out after they answered", async () => {
  const { app } = await makeFreshApp();
  resetIntakeReplay();
  const domain = getDomainStore();
  const projectId = await firstProject(app);
  const { channel, inboxId } = await mailbox(projectId);

  const client = await domain.createClient({ project_id: projectId, display_name: "Jane", handles: ["jane@client.test"], metadata: {} });
  const thread = await domain.findOrCreateThread(client.id, channel.id, projectId, "Invoice INV-1");
  const inv = await chasedInvoice(projectId, client.id);

  // A chase run parked on the approval gate with the words already written — the window that made
  // `standDownChases` necessary in the first place.
  const inFlight = `task-${randomUUID()}`;
  setChaseDeps({
    wedgeEnabled: () => true,
    spawnTask: async () => "unused",
    attachInvoiceDocument: async () => ({ artifact_id: "art" }),
    openChasesFor: async (a) => (a.project_id === projectId && a.invoice_id === inv.id ? [inFlight] : []),
  });

  const providerThreadId = `thd_${randomUUID()}`;
  await linkAgentMailThread(projectId, {
    provider_thread_id: providerThreadId,
    thread_id: thread.id,
    channel_id: channel.id,
    client_id: client.id,
    invoice_id: inv.id,
  });

  const res = await deliver(app, receivedEvent({ inbox_id: inboxId, thread_id: providerThreadId }));
  assert.equal(res.status, 201);
  assert.deepEqual(res.json.chase?.stood_down, [inFlight], "the queued chase was cancelled by the reply");
  assert.equal(res.json.chase?.invoice_id, inv.id);
});

test("a client who answered is not escalated at tomorrow either: the reply gates the next rung", async () => {
  await makeFreshApp();
  const projectId = `proj-${randomUUID()}`;
  const inv = await chasedInvoice(projectId, "cli-1");
  setChaseDeps({
    wedgeEnabled: () => true,
    spawnTask: async () => "unused",
    attachInvoiceDocument: async () => ({ artifact_id: "art" }),
    openChasesFor: async () => [],
  });

  // This business has no payment provider, so after a first chase the ladder already holds to ask the
  // FOUNDER whether it was paid. That is pre-existing behaviour and not what is under test here; what
  // matters is that the client's reply is a distinct, separately-stated reason to hold.
  const before = await paymentQuestionGate(inv);
  assert.ok(!before.detail.includes("the client replied"), "no reply has arrived yet");

  await noteClientReplyOnInvoice(inv, { thread_id: "thr-1", body: "I paid this on the 3rd, reference ABC123." });

  const after = await paymentQuestionGate(inv);
  assert.equal(after.blocked, true, "the sweep holds — standing down the in-flight run alone would let 03:00 chase again");
  assert.match(after.detail, /replied/);
  assert.equal(after.question?.client_replied_at !== undefined, true);
  // The DEBTOR's claim is not the FOUNDER's answer. A ladder that accepted "I paid" as payment could
  // be switched off by anyone who can type.
  assert.equal(after.question?.answer, undefined);
  assert.match(after.question?.client_reply_excerpt ?? "", /reference ABC123/);
});

test("the suppression is bounded: a reply cannot switch off collections forever", async () => {
  await makeFreshApp();
  const projectId = `proj-${randomUUID()}`;
  const inv = await chasedInvoice(projectId, "cli-1");
  setChaseDeps({
    wedgeEnabled: () => true,
    spawnTask: async () => "unused",
    attachInvoiceDocument: async () => ({ artifact_id: "art" }),
    openChasesFor: async () => [],
  });

  const repliedAt = new Date(Date.now() - (QUESTION_GRACE_HOURS + 1) * 3_600_000);
  await noteClientReplyOnInvoice(inv, { body: "will look into it" }, repliedAt);

  const gate = await paymentQuestionGate(inv);
  // Not blocked by the reply any more. It may still be blocked by the founder question the reply
  // opened, which is the correct ladder for an unverifiable business — what must NOT happen is a
  // permanent halt triggered by a stranger's email.
  assert.ok(!gate.detail.includes("the client replied to us about"));
});

test("a stand-down that could not run is reported, never reported as success", async () => {
  await makeFreshApp();
  const projectId = `proj-${randomUUID()}`;
  const inv = await chasedInvoice(projectId, "cli-1");
  // A deployment that cannot look up in-flight chases. The bug this prevents is a caller believing it
  // cancelled a chase that is still sitting on the approval gate.
  setChaseDeps({ wedgeEnabled: () => true, spawnTask: async () => "x", attachInvoiceDocument: async () => undefined });

  const out = await noteClientReplyOnInvoice(inv, { body: "already paid" });
  assert.deepEqual(out.stood_down, []);
  assert.ok(out.stand_down_refusal, "the refusal travels back to the caller instead of being swallowed");
});

// ═══════════════════════════ PARSING, AND WHAT IS NOT A REPLY ═══════════════════════════

test("spam and unauthenticated senders never become messages from the client", async () => {
  const { app } = await makeFreshApp();
  const projectId = await firstProject(app);
  const { inboxId } = await mailbox(projectId);

  for (const eventType of ["message.received.spam", "message.received.blocked", "message.received.unauthenticated", "message.bounced"]) {
    const res = await deliver(app, { ...receivedEvent({ inbox_id: inboxId }), event_type: eventType });
    // 200 so Svix stops retrying, with a REASON — a bare 200 would be indistinguishable from "filed".
    assert.equal(res.status, 200, eventType);
    assert.equal(res.json.ok, true, eventType);
    assert.ok(res.json.ignored, eventType);
    assert.equal(res.json.task_id, undefined, `${eventType} must not start a run`);
  }
});

test("a reply from Jane@Example.com is the same client as jane@example.com", () => {
  // Handles are matched by exact string in findClientByHandle. Without normalising, a capitalised
  // reply creates a duplicate client — and the duplicate has no invoices, so the reply attaches to
  // nothing and the ladder carries on.
  assert.deepEqual(parseAddress("Jane Doe <Jane@Example.com>"), { name: "Jane Doe", handle: "jane@example.com" });
  assert.deepEqual(parseAddress("  bare@example.com "), { handle: "bare@example.com" });
  assert.deepEqual(parseAddress('"Doe, Jane" <j@x.io>'), { name: "Doe, Jane", handle: "j@x.io" });
});

test("an html-only reply still has a body, instead of being refused as an empty message", () => {
  const parsed = parseAgentMailInbound({
    event_type: "message.received",
    event_id: "evt_1",
    message: {
      inbox_id: "inbox_1",
      thread_id: "thd_1",
      message_id: "<m@x>",
      from: "a@b.test",
      html: "<p>Paid on the <b>3rd</b>.</p><script>ignore()</script>",
    },
  });
  assert.equal(parsed.ok, true);
  // Whitespace around inline tags is not preserved and does not need to be — the requirement is that
  // the words survive and that <script> contents never reach an agent's context as if they were the
  // client's own sentence.
  assert.match(parsed.ok ? parsed.value.text : "", /^Paid on the 3rd\s*\.$/);
  assert.ok(!(parsed.ok && parsed.value.text.includes("ignore()")));
});

test("a payload missing the fields we route on is refused rather than half-filed", () => {
  for (const message of [
    { thread_id: "t", message_id: "m", from: "a@b.test", text: "x" }, // no inbox
    { inbox_id: "i", message_id: "m", from: "a@b.test", text: "x" }, // no thread
    { inbox_id: "i", thread_id: "t", message_id: "m", text: "x" }, // no sender
    { inbox_id: "i", thread_id: "t", message_id: "m", from: "a@b.test" }, // no body
  ]) {
    const parsed = parseAgentMailInbound({ event_type: "message.received", event_id: "e", message });
    assert.equal(parsed.ok, false, JSON.stringify(message));
  }
});

test("agentmail inbound is normalised as EMAIL, so it shares one adapter and one dedupe rule", () => {
  // Adding a provider must never mean adding a TaskSource — otherwise every downstream switch on
  // source grows a branch per vendor and one of them gets forgotten.
  assert.equal(intakeSourceForChannelKind("agentmail"), "email");
  assert.equal(intakeSourceForChannelKind("email"), "email");
  assert.equal(intakeSourceForChannelKind("slack"), undefined);
});

// ═══════════════════════════ DELIVERABILITY ═══════════════════════════

test("a second SPF record is detected: two of them fail the mail the business already had working", () => {
  assert.equal(spfConflict([]).conflict, false);
  assert.equal(spfConflict(["v=spf1 include:spf.agentmail.to ~all"]).conflict, false);
  const clash = spfConflict(["v=spf1 include:_spf.google.com ~all"]);
  assert.equal(clash.conflict, true);
  assert.match(clash.detail ?? "", /do not add a second one/i);
});

test("the customer is told the three things that actually break deliverability, in the product", () => {
  const advice = deliverabilityAdvice(
    [
      { name: "acme.test", type: "TXT", value: "v=spf1 include:spf.agentmail.to ~all" },
      { name: "am1._domainkey.acme.test", type: "CNAME", value: "am1.dkim.agentmail.to" },
      { name: "acme.test", type: "MX", value: "inbound-smtp.us-east-1.amazonaws.com", priority: 10 },
    ],
    "pending",
  );
  const all = advice.join(" ");
  assert.match(all, /ONE SPF record/);
  assert.match(all, /DNS only/); // the Cloudflare grey-cloud trap
  assert.match(all, /MX record is what lets replies come BACK/);
  assert.match(all, /not be picked up/); // unverified is stated, not implied
});

test("the deliverability and provisioning routes degrade honestly when AgentMail is unconfigured", async () => {
  const { app } = await makeFreshApp();
  const projectId = await firstProject(app);
  const saved = process.env.AGENTMAIL_API_KEY;
  delete process.env.AGENTMAIL_API_KEY;
  try {
    for (const path of ["agentmail/domains", "agentmail/inboxes"]) {
      const res = await api(app, path, {
        method: "POST",
        headers: { "x-mycel-project": projectId },
        body: JSON.stringify({ domain: "acme.test", username: "billing", wedge: "books-keeper", task_type: "daily_sync" }),
      });
      // 501 with a sentence naming the missing variable — absent, not broken, and not a stack trace.
      assert.equal(res.status, 501, path);
      assert.match(res.json.error, /AGENTMAIL_API_KEY/);
    }
  } finally {
    process.env.AGENTMAIL_API_KEY = saved;
  }
});

test("an inbound cannot be attributed to another tenant's project, even from the same sender", async () => {
  const { app, store } = await makeFreshApp();
  resetIntakeReplay();
  // Two businesses on one deployment, each with its own mailbox, both hearing from the same person.
  // Two cross-tenant leaks have shipped in this repo; the shape of both was a lookup that could see
  // outside the project. The routing key here is the inbox, and the inbox belongs to exactly one
  // connection row, so there is no query in the path that could return the other tenant's anything.
  const a = `proj-a-${randomUUID()}`;
  const b = `proj-b-${randomUUID()}`;
  const mailboxA = await mailbox(a);
  const mailboxB = await mailbox(b);

  const toA = await deliver(app, receivedEvent({ inbox_id: mailboxA.inboxId, from: "Jane <jane@client.test>", text: "invoice for A" }));
  const toB = await deliver(app, receivedEvent({ inbox_id: mailboxB.inboxId, from: "Jane <jane@client.test>", text: "invoice for B" }));
  assert.equal(toA.status, 201);
  assert.equal(toB.status, 201);

  assert.equal((await store.getTask(toA.json.task_id))?.project_id, a);
  assert.equal((await store.getTask(toB.json.task_id))?.project_id, b);
  assert.notEqual(toA.json.client_id, toB.json.client_id, "one person writing to two businesses is two client records");
  assert.notEqual(toA.json.thread_id, toB.json.thread_id);
});

test("one tenant cannot read another tenant's domain verification state", async () => {
  const { app } = await makeFreshApp();
  const mine = await firstProject(app);
  // Registered by somebody else on this same deployment. ONE AgentMail account serves every tenant,
  // so without a project-scoped claim this route reports a competitor's domain, their DKIM progress
  // and whether they are live yet — to anyone who can guess the name.
  await claimDomainForProject(`proj-${randomUUID()}`, "competitor.test");
  await claimDomainForProject(mine, "acme.test");

  const theirs = await api(app, "agentmail/domains/competitor.test", { headers: { "x-mycel-project": mine } });
  assert.equal(theirs.status, 404, "404, not 403 — a domain name must not be probeable for existence");

  const listed = await api(app, "agentmail/domains", { headers: { "x-mycel-project": mine } });
  assert.equal(listed.status, 200);
  assert.deepEqual(
    listed.json.items.map((i: { domain: string }) => i.domain),
    ["acme.test"],
    "the list is this project's claims, never the deployment's whole AgentMail account",
  );
});

test("one tenant cannot make a mailbox on another tenant's domain: that is impersonation with working DKIM", async () => {
  const { app } = await makeFreshApp();
  const mine = await firstProject(app);
  await claimDomainForProject(`proj-${randomUUID()}`, "victim.test");

  const res = await api(app, "agentmail/inboxes", {
    method: "POST",
    headers: { "x-mycel-project": mine },
    body: JSON.stringify({ username: "billing", domain: "victim.test", wedge: "books-keeper", task_type: "daily_sync" }),
  });
  // 403 and — the part that matters — refused BEFORE the AgentMail call, so no orphan inbox is left
  // behind on the shared account. A 502 here would mean we reached the API and it happened to fail.
  assert.equal(res.status, 403);
  assert.equal(res.json.code, "agentmail.domain_not_yours");
});

test("a mailbox nothing runs on is refused at provisioning, not discovered when replies vanish", async () => {
  const { app } = await makeFreshApp();
  const projectId = await firstProject(app);
  const res = await api(app, "agentmail/inboxes", {
    method: "POST",
    headers: { "x-mycel-project": projectId },
    body: JSON.stringify({ username: "billing" }),
  });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /wedge and task_type are required/);
});
