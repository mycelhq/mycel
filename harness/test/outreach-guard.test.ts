// The outreach capability guard — the platform's own rules, tested against the real profiles.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  capabilitiesForConnection,
  capabilitiesForPlatform,
  guardOutreach,
  guardSend,
  isMessagingSend,
} from "../src/outreach/guard";

const li = capabilitiesForPlatform("linkedin");
const wa = capabilitiesForPlatform("whatsapp");
const ig = capabilitiesForPlatform("instagram");

test("LinkedIn: a cold initiate is allowed but force_approval is set", () => {
  const cold = guardSend(li, { to: "urn:member", text: "hi" });
  assert.equal(cold.allow, true);
  assert.equal(cold.force_approval, true);
  // A reply into an existing thread is a plain allow — no window on LinkedIn.
  const reply = guardSend(li, { thread: "t", text: "x" });
  assert.equal(reply.allow, true);
  assert.equal(reply.force_approval, undefined);
});

test("velocity is NOT this module's job — no send-rate field exists to disagree with pacing.ts", () => {
  // A flat hourly cap here would be a second, worse opinion than pacing.ts (tier ceilings, age
  // ramp, engagement multiplier, working-hours window). Assert it never comes back.
  for (const cap of [li, wa, ig, capabilitiesForPlatform("email")]) {
    assert.ok(!("max_sends_per_hour" in cap), `${cap.platform} must not carry a rate cap`);
  }
  // …and no number of prior sends changes the verdict.
  assert.equal(guardSend(li, { thread: "t", text: "x" }).allow, true);
});

test("WhatsApp: a cold initiate needs a template; replies obey the 24h window", () => {
  assert.equal(guardSend(wa, { to: "+212600", text: "x" }).code, "template_required");
  assert.equal(guardSend(wa, { to: "+212600", text: "x", template: { name: "t", language: "fr" } }).allow, true);
  assert.equal(guardSend(wa, { thread: "t", text: "x" }, {}).code, "reply_window_closed");
  const recent = new Date(Date.now() - 3_600_000).toISOString();
  assert.equal(guardSend(wa, { thread: "t", text: "x" }, { last_inbound_at: recent }).allow, true);
  // A garbage timestamp must close the window, not open it.
  assert.equal(guardSend(wa, { thread: "t", text: "x" }, { last_inbound_at: "not-a-date" }).code, "reply_window_closed");
});

test("Instagram: a cold DM is structurally refused; the 24h reply window is enforced", () => {
  assert.equal(guardSend(ig, { to: "someone", text: "cold" }).code, "cannot_initiate");
  const old = new Date(Date.now() - 25 * 3_600_000).toISOString();
  assert.equal(guardSend(ig, { thread: "t", text: "x" }, { last_inbound_at: old }).code, "reply_window_closed");
});

test("length caps and no-target are refused", () => {
  assert.equal(guardSend(li, { thread: "t", text: "a".repeat(8001) }).code, "too_long");
  assert.equal(guardSend(li, { text: "no target" }).code, "no_target");
  assert.equal(guardSend(ig, { thread: "t", text: "a".repeat(1001) }, { last_inbound_at: new Date().toISOString() }).code, "too_long");
});

test("capabilitiesForConnection maps kind + composio toolkit", () => {
  assert.equal(capabilitiesForConnection({ kind: "linkedin", config: {} }).platform, "linkedin");
  assert.equal(capabilitiesForConnection({ kind: "composio", config: { toolkit: "whatsapp" } }).platform, "whatsapp");
  assert.equal(capabilitiesForConnection({ kind: "composio", config: { toolkit: "instagram" } }).platform, "instagram");
  assert.equal(capabilitiesForConnection({ kind: "email", config: {} }).platform, "email");
  // a non-messaging composio toolkit and unknown kinds fall back to permissive
  assert.equal(capabilitiesForConnection({ kind: "composio", config: { toolkit: "xero" } }).platform, "generic");
  assert.equal(capabilitiesForConnection({ kind: "webhook", config: {} }).platform, "generic");
});

test("isMessagingSend keeps the guard off actions that have no recipient", () => {
  // Otherwise every read/lookup on a messaging connection would be refused with no_target.
  assert.equal(isMessagingSend(capabilitiesForPlatform("generic"), "XERO_CREATE_INVOICE"), false);
  assert.equal(isMessagingSend(wa, "WHATSAPP_SEND_MESSAGE"), true);
  assert.equal(isMessagingSend(ig, "INSTAGRAM_SEND_DM"), true);
  assert.equal(isMessagingSend(wa, "WHATSAPP_LIST_CONTACTS"), false);
  // A LinkedIn session connection only ever sends, whatever the capability is called.
  assert.equal(isMessagingSend(li, "anything"), true);
});

test("guardOutreach composes profile + guard for a connection in one call", () => {
  const v = guardOutreach({ kind: "linkedin", config: {} }, { to: "urn:member", text: "hi" });
  assert.equal(v.force_approval, true);
  // permissive kinds allow freely
  assert.equal(guardOutreach({ kind: "webhook", config: {} }, { to: "x", text: "hi" }).allow, true);
});

// ── wiring: the guard runs inside the action proxy, before the approval gate ──
import { InMemoryStore } from "../src/store";
import { createServer } from "../src/server";
import { getDomainStore } from "../src/domain";
import { registerActionGrant } from "../src/actiongrants";
import { awaitApproval } from "../src/approvals";
import { resetPolicyCounters } from "../src/policy";

async function runningTask(store: InMemoryStore, id: string, wedge = "invoice-chaser") {
  const now = new Date().toISOString();
  await store.createTask({
    id, project_id: "p", wedge, task_type: "chase_invoice",
    actor: { kind: "system", id: "s" }, input: {},
    constraints: { max_runtime_s: 300, max_cost_usd: 1, approval_required: false },
    tools: [], status: "running", cost_usd: 0, created_at: now, updated_at: now,
  } as never);
}

test("action proxy: a platform-illegal send is refused BEFORE a human is asked", async () => {
  const store = new InMemoryStore();
  const app = createServer(store);
  const domain = getDomainStore();
  await runningTask(store, "gt1");

  // Instagram cannot be cold-DMed by anyone. The point of refusing here rather than after the gate
  // is that a founder's approval is the scarce resource — don't spend it on a doomed send.
  const conn = await domain.createConnection({
    project_id: "p", kind: "composio", name: "ig", owner: { kind: "founder", id: "f" },
    config: { toolkit: "instagram" },
  });
  const nonce = registerActionGrant({ task_id: "gt1", connectionIds: [conn.id] });

  const res = await app.request("/v1/internal/actions/INSTAGRAM_SEND_DM", {
    method: "POST",
    headers: { authorization: `Bearer ${nonce}`, "content-type": "application/json" },
    body: JSON.stringify({ connection_id: conn.id, to: "stranger", body: "cold pitch" }),
  });
  const out = await res.json();
  assert.equal(out.ok, false);
  assert.equal(out.code, "cannot_initiate");

  const events = await store.eventsAfter("gt1", 0);
  assert.ok(!events.some((e) => e.type === "approval.requested"), "no human was bothered");
  assert.equal((await store.listApprovals()).filter((a) => a.task_id === "gt1").length, 0, "no approval row");
  assert.equal((await store.getTask("gt1"))!.status, "running", "the task never suspended");
});

test("force_approval is honoured: a wedge auto-approve policy cannot sign off a forced send", async () => {
  resetPolicyCounters();
  const store = new InMemoryStore();
  await runningTask(store, "gt2");

  // invoice-chaser's policy auto-approves email:send_reminder. Same action, same wedge, twice —
  // the only difference is the flag the guard sets for a cold initiate on a ban-risk account.
  const auto = await awaitApproval(store, "gt2", {
    action: "email:send_reminder", risk: "high", preview: {},
  });
  assert.equal(auto.decision, "auto_approved", "baseline: the policy does apply to this action");

  const forced = awaitApproval(store, "gt2", {
    action: "email:send_reminder", risk: "high", preview: {}, requireHuman: true, ttlMs: 3000,
  });
  // It must be waiting on a real human rather than resolving itself.
  await new Promise((r) => setTimeout(r, 50));
  const pending = (await store.listApprovals("pending")).filter((a) => a.task_id === "gt2");
  assert.equal(pending.length, 1, "the forced send is parked on a human");
  assert.equal((await store.getTask("gt2"))!.status, "awaiting_approval");

  const { resolveApproval } = await import("../src/approvals");
  resolveApproval(pending[0].approval_id, "rejected");
  assert.equal((await forced).decision, "rejected");
});
