import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as httpServer } from "node:http";
import { safeReadPath } from "../src/actions";
import { InMemoryStore } from "../src/store";
import { createServer } from "../src/server";
import { getDomainStore } from "../src/domain";
import { registerActionGrant } from "../src/actiongrants";

test("safeReadPath blocks anything that could leave the connection's host (no SSRF)", () => {
  // allowed: relative paths
  assert.equal(safeReadPath("v1/charges"), "v1/charges");
  assert.equal(safeReadPath("/v1/charges"), "v1/charges");
  assert.equal(safeReadPath(""), "");
  // blocked: absolute URLs, protocol-relative, traversal, header injection, non-strings
  for (const bad of [
    "http://evil.com/x",
    "https://evil.com",
    "file:///etc/passwd",
    "//evil.com/x",
    "../../secrets",
    "v1/../../x",
    "v1/charges\r\nHost: evil.com",
    undefined,
    42,
    { path: "x" },
  ]) {
    assert.equal(safeReadPath(bad as unknown), null, `should block: ${JSON.stringify(bad)}`);
  }
});

async function fixture() {
  const store = new InMemoryStore();
  const app = createServer(store);
  const domain = getDomainStore();
  const now = new Date().toISOString();
  await store.createTask({
    id: "rt1", project_id: "p", wedge: "w", task_type: "x", actor: { kind: "system", id: "s" },
    input: {}, constraints: { max_runtime_s: 300, max_cost_usd: 1, approval_required: false },
    tools: [], status: "running", cost_usd: 0, created_at: now, updated_at: now,
  } as never);
  return { store, app, domain };
}

test("reads are ungated: no approval, data returned, secret resolved server-side, traced", async () => {
  process.env.READ_SECRET = "read-token";
  let sawAuth: string | undefined;
  let sawUrl: string | undefined;
  const srv = httpServer((req, res) => {
    sawAuth = req.headers.authorization;
    sawUrl = req.url;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ transactions: [{ id: "tx_1", amount: 1200 }] }));
  });
  await new Promise<void>((r) => srv.listen(0, r));
  const port = (srv.address() as { port: number }).port;

  const { store, app, domain } = await fixture();
  const conn = await domain.createConnection({
    project_id: "p", kind: "custom", name: "bank", owner: { kind: "founder", id: "founder" },
    config: { api_url: `http://127.0.0.1:${port}` }, secret_ref: "env:READ_SECRET",
  });
  const nonce = registerActionGrant({ task_id: "rt1", connectionIds: [conn.id] });

  const res = await app.request("/v1/internal/reads/list_transactions", {
    method: "POST",
    headers: { authorization: `Bearer ${nonce}`, "content-type": "application/json" },
    body: JSON.stringify({ connection_id: conn.id, path: "v1/transactions", query: { limit: "10" } }),
  });
  const out = await res.json();

  assert.equal(out.ok, true, "the read succeeded with NO human approval");
  assert.deepEqual(out.data.transactions[0], { id: "tx_1", amount: 1200 }, "the agent got the data");
  assert.equal(sawAuth, "Bearer read-token", "the real secret was resolved server-side");
  assert.match(sawUrl!, /^\/v1\/transactions\?limit=10$/, "path + query were forwarded");
  assert.equal((await store.getTask("rt1"))!.status, "running", "the task never suspended");

  // traced onto the timeline so the founder can see what data was pulled
  const events = await store.eventsAfter("rt1", 0);
  const called = events.find((e) => e.type === "tool.called");
  const result = events.find((e) => e.type === "tool.result");
  assert.equal((called!.data as { tool: string }).tool, "read:custom:list_transactions");
  assert.equal((result!.data as { ok: boolean }).ok, true);

  srv.close();
});

test("reads stay scoped: bad nonce, ungranted connection, and host escape are all refused", async () => {
  const { app, domain } = await fixture();
  const granted = await domain.createConnection({
    project_id: "p", kind: "custom", name: "ok", owner: { kind: "founder", id: "founder" },
    config: { api_url: "http://127.0.0.1:1" },
  });
  const other = await domain.createConnection({
    project_id: "p", kind: "custom", name: "not-granted", owner: { kind: "founder", id: "founder" },
    config: { api_url: "http://127.0.0.1:1" },
  });
  const nonce = registerActionGrant({ task_id: "rt1", connectionIds: [granted.id] });
  const H = { authorization: `Bearer ${nonce}`, "content-type": "application/json" };

  const bad = await app.request("/v1/internal/reads/x", { method: "POST", headers: { authorization: "Bearer nope" }, body: "{}" });
  assert.equal(bad.status, 401, "bad nonce refused");

  const ungranted = await app.request("/v1/internal/reads/x", { method: "POST", headers: H, body: JSON.stringify({ connection_id: other.id, path: "a" }) });
  assert.equal(ungranted.status, 403, "a connection outside the grant is refused");

  const escape = await app.request("/v1/internal/reads/x", { method: "POST", headers: H, body: JSON.stringify({ connection_id: granted.id, path: "http://evil.com/steal" }) });
  const out = await escape.json();
  assert.equal(out.ok, false);
  assert.match(out.detail, /invalid path/, "the sandbox cannot choose the host");
});

test("reads are size-capped so a huge response can't blow up the run", async () => {
  const big = "x".repeat(400 * 1024);
  const srv = httpServer((_req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end(big); });
  await new Promise<void>((r) => srv.listen(0, r));
  const port = (srv.address() as { port: number }).port;

  const { app, domain } = await fixture();
  const conn = await domain.createConnection({
    project_id: "p", kind: "custom", name: "big", owner: { kind: "founder", id: "founder" },
    config: { api_url: `http://127.0.0.1:${port}` },
  });
  const nonce = registerActionGrant({ task_id: "rt1", connectionIds: [conn.id] });

  const res = await app.request("/v1/internal/reads/fetch", {
    method: "POST",
    headers: { authorization: `Bearer ${nonce}`, "content-type": "application/json" },
    body: JSON.stringify({ connection_id: conn.id, path: "big" }),
  });
  const out = await res.json();
  assert.equal(out.truncated, true, "the agent is told it didn't get everything");
  assert.ok(out.body.length < big.length, "the response was capped");
  srv.close();
});
