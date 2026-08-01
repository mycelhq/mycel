import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../src/server";
import { InMemoryStore } from "../src/store";
import { registerActionGrant } from "../src/actiongrants";
import { getDomainStore } from "../src/domain";

/**
 * Two API instances sharing one store — the shape of `desired_count = 2`.
 *
 * The in-process bus and the in-process waiter registry both exist only inside one process, so a
 * shared store is exactly the condition under which they stop being sufficient. These pin the
 * fallbacks that make horizontal scaling a config change rather than a Redis dependency.
 */
async function twoReplicas() {
  const store = new InMemoryStore();
  const a = createServer(store);
  const b = createServer(store);
  // A REAL project id: every route filters by tenancy, so a made-up one 404s before any of the
  // cross-instance behaviour is reached.
  const me = await (await a.request("/v1/me", { headers: { authorization: "Bearer testkey" } })).json();
  return { store, a, b, projectId: me.projects[0].id as string };
}

test("multi-replica: an approval decided on instance B unblocks a run waiting on instance A", async () => {
  // The failure this prevents is silent: the approval is recorded, the UI says approved, and the
  // run hangs until its TTL expires — at the exact moment the product's core promise is exercised.
  const { store, a, b, projectId } = await twoReplicas();
  const domain = getDomainStore();
  const now = new Date().toISOString();

  await store.createTask({
    id: "replica-task", project_id: projectId, wedge: "w", task_type: "x",
    actor: { kind: "system", id: "s" }, input: {},
    constraints: { max_runtime_s: 300, max_cost_usd: 1, approval_required: true },
    tools: [], status: "running", cost_usd: 0, created_at: now, updated_at: now,
  } as never);

  const conn = await domain.createConnection({
    project_id: projectId, kind: "webhook", name: "sink",
    owner: { kind: "founder", id: "founder" }, config: { url: "http://127.0.0.1:1/" },
  });
  const nonce = await registerActionGrant({ task_id: "replica-task", connectionIds: [conn.id] });

  // The run blocks on instance A.
  const blocked = a.request("/v1/internal/actions/send_webhook", {
    method: "POST",
    headers: { authorization: `Bearer ${nonce}`, "content-type": "application/json" },
    body: JSON.stringify({ connection_id: conn.id, body: "hello" }),
  });

  // Find the approval, then decide it on instance B — a different process, as far as the in-process
  // waiter registry is concerned.
  let approvalId: string | undefined;
  for (let i = 0; i < 200 && !approvalId; i++) {
    await new Promise((r) => setTimeout(r, 15));
    const pending = await store.listApprovals("pending");
    approvalId = pending.find((x) => x.task_id === "replica-task")?.approval_id;
  }
  assert.ok(approvalId, "the gate fired");

  const decided = await b.request(`/v1/approvals/${approvalId}/approve`, {
    method: "POST",
    headers: { authorization: "Bearer testkey", "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(decided.status, 200);

  // Instance A must notice, via the row rather than the bus. Generous timeout: the poll is 700ms.
  const out = await Promise.race([
    blocked.then((r) => r.json()),
    new Promise((r) => setTimeout(() => r({ timedOut: true }), 6000)),
  ]);
  assert.ok(!(out as { timedOut?: boolean }).timedOut, "instance A never saw the decision made on B");
});

test("multi-replica: a stream on instance B sees events emitted on instance A", async () => {
  // Same principle for SSE: the durable event log is the bus, and the in-process emitter is only a
  // latency optimisation on the path where producer and subscriber share a process.
  const { store, a, b, projectId } = await twoReplicas();
  const now = new Date().toISOString();
  await store.createTask({
    id: "stream-task", project_id: projectId, wedge: "w", task_type: "x",
    actor: { kind: "system", id: "s" }, input: {},
    constraints: { max_runtime_s: 300, max_cost_usd: 1, approval_required: false },
    tools: [], status: "running", cost_usd: 0, created_at: now, updated_at: now,
  } as never);

  const res = await b.request("/v1/tasks/stream-task/events", {
    headers: { authorization: "Bearer testkey", accept: "text/event-stream" },
  });
  assert.equal(res.status, 200);

  // Emitted through instance A's app — a different EventEmitter to the one B subscribed on.
  const { emitEvent } = await import("../src/events");
  await emitEvent(store, "stream-task", "progress", { note: "from the other replica" });
  await emitEvent(store, "stream-task", "task.finished", { status: "succeeded" });
  void a;

  const reader = res.body!.getReader();
  let seen = "";
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline && !seen.includes("task.finished")) {
    const { value, done } = await reader.read();
    if (done) break;
    seen += new TextDecoder().decode(value);
  }
  assert.match(seen, /from the other replica/, "the stream never picked up the other instance's event");
});
