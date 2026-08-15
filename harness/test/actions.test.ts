import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as httpServer } from "node:http";
import { InMemoryStore } from "../src/store";
import { createServer } from "../src/server";
import { getDomainStore } from "../src/domain";
import { registerActionGrant } from "../src/actiongrants";
import { resolveApproval } from "../src/approvals";

test("action proxy: nonce → human gate → execute → outbound message; secret resolved server-side", async () => {
  process.env.SINK_SECRET = "shhh";

  // webhook sink that records what it receives
  let received: { auth?: string; body: string } | null = null;
  const sink = httpServer((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => {
      received = { auth: req.headers.authorization, body: b };
      res.end("ok");
    });
  });
  await new Promise<void>((r) => sink.listen(0, r));
  const port = (sink.address() as any).port;

  const store = new InMemoryStore();
  const app = createServer(store);
  const domain = getDomainStore();

  // a running task + a connection + a thread + a grant (what the runtime sets up)
  const now = new Date().toISOString();
  await store.createTask({ id: "t1", project_id: "p", wedge: "w", task_type: "x", actor: { kind: "user", id: "a" }, input: {}, constraints: { max_runtime_s: 300, max_cost_usd: 1, approval_required: false }, tools: [], status: "running", cost_usd: 0, created_at: now, updated_at: now } as any);
  const conn = await domain.createConnection({ project_id: "p", kind: "webhook", name: "sink", owner: { kind: "founder", id: "founder" }, config: { url: `http://127.0.0.1:${port}/` }, secret_ref: "env:SINK_SECRET" });
  const thread = await domain.createThread({ project_id: "p", client_id: "c", channel_id: "ch", status: "open" });
  const nonce = await registerActionGrant({ task_id: "t1", connectionIds: [conn.id], threadId: thread.id });

  // the sandbox calls the action proxy — this BLOCKS on the human gate
  const callP = app.request("/v1/internal/actions/send_webhook", {
    method: "POST",
    headers: { authorization: `Bearer ${nonce}`, "content-type": "application/json" },
    body: JSON.stringify({ connection_id: conn.id, body: "hello world" }),
  });

  // bad nonce is rejected
  const badNonce = await app.request("/v1/internal/actions/send_webhook", { method: "POST", headers: { authorization: "Bearer nope" }, body: "{}" });
  assert.equal(badNonce.status, 401);

  // human approves: find the approval id from the emitted event, approve it
  let approvalId: string | undefined;
  for (let i = 0; i < 100 && !approvalId; i++) {
    await new Promise((r) => setTimeout(r, 15));
    const req = (await store.eventsAfter("t1", 0)).find((e) => e.type === "approval.requested");
    if (req) approvalId = (req.data as any).approval_id;
  }
  assert.ok(approvalId, "approval was surfaced");
  assert.equal((await store.getTask("t1"))!.status, "awaiting_approval");
  resolveApproval(approvalId!, "approved");

  const out = await (await callP).json();
  assert.equal(out.ok, true);
  assert.ok(received, "sink received the POST");
  assert.equal(received!.auth, "Bearer shhh"); // real secret resolved server-side, not from the sandbox

  const msgs = await domain.listMessages(thread.id);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].direction, "outbound");
  assert.equal(msgs[0].status, "sent");

  sink.close();
});

test("action proxy: rejected action does not execute", async () => {
  const store = new InMemoryStore();
  const app = createServer(store);
  const domain = getDomainStore();
  const now = new Date().toISOString();
  await store.createTask({ id: "t2", project_id: "p", wedge: "w", task_type: "x", actor: { kind: "user", id: "a" }, input: {}, constraints: { max_runtime_s: 300, max_cost_usd: 1, approval_required: false }, tools: [], status: "running", cost_usd: 0, created_at: now, updated_at: now } as any);
  const conn = await domain.createConnection({ project_id: "p", kind: "webhook", name: "sink2", owner: { kind: "founder", id: "founder" }, config: { url: "http://127.0.0.1:1/" } });
  const nonce = await registerActionGrant({ task_id: "t2", connectionIds: [conn.id] });

  const callP = app.request("/v1/internal/actions/send_webhook", { method: "POST", headers: { authorization: `Bearer ${nonce}`, "content-type": "application/json" }, body: JSON.stringify({ connection_id: conn.id, body: "no" }) });
  let approvalId: string | undefined;
  for (let i = 0; i < 100 && !approvalId; i++) {
    await new Promise((r) => setTimeout(r, 15));
    const req = (await store.eventsAfter("t2", 0)).find((e) => e.type === "approval.requested");
    if (req) approvalId = (req.data as any).approval_id;
  }
  resolveApproval(approvalId!, "rejected");
  const out = await (await callP).json();
  assert.equal(out.ok, false);
  assert.equal(out.decision, "rejected");
});
