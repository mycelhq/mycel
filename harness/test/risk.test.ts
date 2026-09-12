// What actually reaches a founder, and how loudly it asks.
//
// Every test here is named after a bug that shipped or nearly did. The headline one is the first:
// the action proxy passed `risk: "high"` as a string literal for every action this product has ever
// taken, so a first polite reminder and a refund arrived looking identical. A queue where
// everything is maximum severity trains the founder to clear it without reading — which is the
// failure the gate exists to prevent, arriving through the front door.
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { assessRisk, declaredRisk, HIGH_AMOUNT_MAJOR } from "../src/risk";
import type { WedgeManifest } from "../src/wedge";
import { InMemoryStore } from "../src/store";
import { createServer } from "../src/server";
import { getDomainStore } from "../src/domain";
import { registerActionGrant } from "../src/actiongrants";
import { resetPolicyCounters } from "../src/policy";

const RUN = randomUUID().slice(0, 8);

const score = (action: string, payload: Record<string, unknown> = {}, extra = {}) =>
  assessRisk({ action, capability: action.split(":").pop() ?? action, payload, clientFacing: true, ...extra });

test("a reminder and a refund are not the same decision — the bug this file exists for", () => {
  const reminder = score("email:send_reminder", { body: "just a nudge about INV-104" });
  const refund = score("composio:STRIPE_CREATE_REFUND", { amount_minor: 42_00, currency: "USD" });

  assert.equal(reminder.risk, "low");
  assert.equal(refund.risk, "high");
  assert.notEqual(reminder.why, refund.why, "the card has to say something different, not just look different");
  assert.match(refund.why, /moves money/);
});

test("money is high at any size — a $4 refund is still irreversible", () => {
  assert.equal(score("composio:STRIPE_CREATE_REFUND", { amount_minor: 400, currency: "USD" }).risk, "high");
  assert.equal(score("composio:XERO_CREATE_PAYMENT", {}).risk, "high");
  assert.equal(score("bank:transfer", {}).risk, "high");
});

test("a commitment carrying a fee is high even though no money moves — the founder's own example", () => {
  // The scope-change proposal. Nothing leaves the bank when it goes out, which is exactly why an
  // amount-only rule scored it as harmless, and it is the most expensive email an agency sends.
  const v = score("email:send_scope_change", { body: "additional 12 hours at the agreed rate" });
  assert.equal(v.risk, "high");
  assert.match(v.why, /commits the business/);
});

test("size alone escalates: the same send at $180 and at $9,000 are different decisions", () => {
  const small = score("email:send_reminder", { amount: 180, currency: "USD" });
  const large = score("email:send_reminder", { amount: HIGH_AMOUNT_MAJOR + 1, currency: "USD" });
  assert.equal(small.risk, "medium", "an amount on a live thread is worth a glance");
  assert.equal(large.risk, "high");
});

test("minor units are not read as major units — the hundredfold bug", () => {
  // `amount_minor: 250000` is USD 2,500 and must escalate. Read as major units it would be
  // 250,000 (also escalating, so the wrong direction hides); the dangerous direction is the other
  // one — `amount_minor: 5000` is fifty dollars, and must NOT be scored as five thousand.
  const big = score("email:send_statement", { amount_minor: 250_000, currency: "USD" });
  assert.equal(big.risk, "high");
  assert.match(big.why, /USD 2500\.00/, "the card must show money the way a person writes it");
  assert.equal(
    score("email:send_statement", { amount_minor: 5_000, currency: "USD" }).risk,
    "medium",
    "USD 50 in minor units must not be scored as USD 5,000",
  );
  // A zero-exponent currency has no minor unit at all: `amount_minor: 5000` in JPY is five thousand
  // yen, which is over the bar. A path that divided by 100 regardless of currency would read it as
  // fifty and wave it through, and `minorUnitExponent` exists precisely so nothing here does.
  // (The bar is a magnitude in the action's OWN currency — FX is not modelled. See risk.ts.)
  assert.equal(score("email:send_statement", { amount_minor: 5_000, currency: "JPY" }).risk, "high");
  assert.match(score("email:send_statement", { amount_minor: 5_000, currency: "JPY" }).why, /JPY 5000/);
  assert.equal(score("email:send_statement", { amount_minor: 1_500, currency: "JPY" }).risk, "medium");
});

test("first contact is medium; a reply on a live thread is low", () => {
  const cold = score("linkedin:send_first_message", { body: "hi" }, { firstContact: true });
  const warm = score("linkedin:send_message", { body: "hi" }, { firstContact: false });
  assert.equal(cold.risk, "medium");
  assert.match(cold.why, /hasn't written back/);
  assert.equal(warm.risk, "low");
});

test("an action nobody classified is medium, never low — unknown is not safe", () => {
  const v = assessRisk({ action: "custom:frobnicate", capability: "frobnicate", payload: {} });
  assert.equal(v.risk, "medium");
  assert.match(v.why, /Unknown isn't the same as safe/);
});

test("low is a recognition, not a default — the sandbox gate knows only a tool name", () => {
  // `/v1/internal/gate` gets a tool NAME and nothing else: no connection, so no `clientFacing`. It
  // must still be able to tell "chase the timesheet again" from a capability nobody classified,
  // because otherwise every gated tool call is permanently medium and the band means nothing there.
  assert.equal(assessRisk({ action: "email:send_reminder", capability: "send_reminder", payload: {} }).risk, "low");
  assert.equal(assessRisk({ action: "slack:check_in", capability: "check_in", payload: {} }).risk, "low");
  // …and recognising the name is not enough on its own if there is anything in it.
  assert.equal(
    assessRisk({ action: "email:send_reminder", capability: "send_reminder", payload: { amount_minor: 900_000, currency: "USD" } }).risk,
    "high",
  );
  assert.equal(assessRisk({ action: "custom:frobnicate", capability: "frobnicate", payload: {} }).risk, "medium");
});

test("the outreach guard's verdict cannot be talked down by anything", () => {
  const v = score("linkedin:send_invite", {}, { forcedHuman: true, firstContact: true });
  assert.equal(v.risk, "high");
});

test("a wedge manifest can RAISE a verdict and can never lower one", () => {
  const m = (approvals: unknown): WedgeManifest => ({ wedge: "w", approvals } as WedgeManifest);

  // Raise: an ordinary-looking send the wedge author knows is serious.
  const raised = assessRisk({
    action: "email:send_final_notice",
    capability: "send_final_notice",
    payload: {},
    clientFacing: true,
    manifest: m([{ action: "send_final_notice", risk: "high", required: true }]),
  });
  assert.equal(raised.risk, "high");
  assert.match(raised.why, /playbook/);

  // Lower: a manifest claiming a live refund is routine must be ignored. If this ever passes,
  // the queue's honesty lives in a JSON file that ships with the product.
  const lowered = assessRisk({
    action: "composio:STRIPE_CREATE_REFUND",
    capability: "STRIPE_CREATE_REFUND",
    payload: { amount_minor: 500_00, currency: "USD" },
    clientFacing: true,
    manifest: m([{ action: "refund", risk: "low", required: true }]),
  });
  assert.equal(lowered.risk, "high");

  assert.equal(declaredRisk(m([{ action: "send", risk: "medium" }]), "email:send_reminder"), "medium");
  assert.equal(declaredRisk(m([{ action: "charge", risk: "high" }]), "email:send_reminder"), undefined);
});

test("no shipped wedge declares a blanket send, which would put a floor under the whole queue", async () => {
  // THE REGRESSION THIS PREVENTS. `invoice-chaser` declared `{action:"send", risk:"high"}`, which
  // matched every chase it writes, so the risk score could never vary no matter how good the
  // heuristics got — and the founder's queue stayed a wall of identical red. A blanket entry here
  // is not a small config choice; it silently disables this entire file.
  const { readdirSync, readFileSync, existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { wedgesDir } = await import("../src/wedge");
  const root = wedgesDir();
  for (const slug of readdirSync(root)) {
    const file = join(root, slug, "wedge.json");
    if (!existsSync(file)) continue;
    const m = JSON.parse(readFileSync(file, "utf8")) as WedgeManifest;
    for (const a of m.approvals ?? []) {
      assert.notEqual(
        a.action,
        "send",
        `${slug} declares a blanket "send" approval — name the specific send that is genuinely serious`,
      );
    }
  }
});

// ── end to end, through the real proxy ───────────────────────────────────────────────────────────

async function fixture(wedge: string, taskId: string) {
  const store = new InMemoryStore();
  const app = createServer(store);
  const domain = getDomainStore();
  const { createServer: httpServer } = await import("node:http");
  let hits = 0;
  const srv = httpServer((_q, res) => { hits++; res.end("ok"); });
  await new Promise<void>((r) => srv.listen(0, r));
  const port = (srv.address() as { port: number }).port;
  const now = new Date().toISOString();
  await store.createTask({
    id: taskId, project_id: `p-${RUN}`, wedge, task_type: "chase_invoice",
    actor: { kind: "system", id: "s" }, input: {},
    constraints: { max_runtime_s: 300, max_cost_usd: 1, approval_required: false },
    tools: [], status: "running", cost_usd: 0, created_at: now, updated_at: now,
  } as never);
  const conn = await domain.createConnection({
    project_id: `p-${RUN}`, kind: "email", name: `mail-${taskId}`, owner: { kind: "founder", id: "founder" },
    config: { api_url: `http://127.0.0.1:${port}`, from: "a@b.c" },
  });
  const nonce = await registerActionGrant({ task_id: taskId, connectionIds: [conn.id] });
  return {
    store, app, conn, srv,
    hits: () => hits,
    H: { authorization: `Bearer ${nonce}`, "content-type": "application/json" },
  };
}

test("a routine read never reaches the approval queue", async () => {
  // The asymmetric half of the trust model, asserted rather than assumed. An agent that must wait
  // for a human before it can look at today's transactions is useless, and a queue that fills with
  // "may I read this" is a queue nobody reads. It has always been true; nothing tested it, so
  // nothing stopped the next person from routing a read through `awaitApproval` for consistency.
  const f = await fixture("invoice-chaser", `read-${RUN}`);
  const before = (await f.store.listApprovals()).length;
  const res = await f.app.request("/v1/internal/reads/invoices", {
    method: "POST", headers: f.H, body: JSON.stringify({ connection_id: f.conn.id, path: "invoices" }),
  });
  assert.equal(res.status, 200);
  assert.equal((await f.store.listApprovals()).length, before, "a read created an approval row");
  assert.equal((await f.store.getTask(`read-${RUN}`))!.status, "running", "a read suspended the task");
  const events = await f.store.eventsAfter(`read-${RUN}`, 0);
  assert.ok(!events.some((e) => e.type === "approval.requested"), "a read asked a human");
  f.srv.close();
});

test("a client-facing send always stops at a human, and the card now says WHY", async () => {
  resetPolicyCounters();
  // `business-shaper` declares no auto-approve envelope, so this is the plain gate.
  // Subject is required: `planSendEmail` refuses a subjectless body before the gate, which would
  // look like "the gate failed" when the planner correctly declined to queue a spam-shaped send.
  const f = await fixture("business-shaper", `send-${RUN}`);
  try {
    const pending = f.app.request("/v1/internal/actions/send_email", {
      method: "POST", headers: f.H,
      body: JSON.stringify({
        connection_id: f.conn.id,
        to: "client@acme.test",
        subject: "Quick update",
        body: "here is the update",
      }),
    });

    // The run suspends. Find the approval it raised, and read what the founder would see.
    let row: Awaited<ReturnType<InMemoryStore["listApprovals"]>>[number] | undefined;
    for (let i = 0; i < 60 && !row; i++) {
      await new Promise((r) => setTimeout(r, 25));
      row = (await f.store.listApprovals("pending")).find((a) => a.task_id === `send-${RUN}`);
    }
    assert.ok(row, "a client-facing send did not stop at a human");
    assert.equal(f.hits(), 0, "it sent before anyone said yes");
    assert.equal((await f.store.getTask(`send-${RUN}`))!.status, "awaiting_approval");
    assert.notEqual(row!.risk, "high", "a plain update with no money in it is not an emergency");
    assert.equal(typeof (row!.preview as { why?: string }).why, "string", "the card cannot explain itself");

    const { resolveApproval } = await import("../src/approvals");
    resolveApproval(row!.approval_id, "approved");
    await pending;
    assert.equal(f.hits(), 1);
  } finally {
    f.srv.close();
  }
});
