// Durability tests — run only when MYCEL_TEST_DATABASE_URL points at a throwaway Postgres.
// These caught two real bugs the in-memory suite could not: tasks were missing project_id in the
// pg schema (every task 404'd under Postgres), and identity ids were regenerated per boot (so
// durable rows were scoped to a dead project). Skipped when no database is configured.
import { test } from "node:test";
import assert from "node:assert/strict";

const URL = process.env.MYCEL_TEST_DATABASE_URL;

test("postgres: tasks + service surface survive a restart", { skip: URL ? false : "set MYCEL_TEST_DATABASE_URL to run" }, async () => {
  process.env.MYCEL_DATABASE_URL = URL;

  // ── boot 1: write ──
  const { createStore } = await import("../src/store");
  const { initDomainStore, getDomainStore } = await import("../src/domain");
  const { initIdentityStore, getIdentityStore } = await import("../src/identity");
  const { createServer } = await import("../src/server");

  const first = await createStore();
  assert.equal(first.backend, "postgres");
  await initDomainStore();
  await initIdentityStore();
  const app1 = createServer(first.store);
  const key = getIdentityStore() && process.env.MYCEL_API_KEY!;
  const H = { authorization: `Bearer ${key}`, "content-type": "application/json" };

  const taskRes = await app1.request("/v1/tasks", { method: "POST", headers: H, body: JSON.stringify({ wedge: "enrollment-operator", task_type: "reply_to_lead", input: { message: "durable?" } }) });
  assert.equal(taskRes.status, 201);
  const taskId = (await taskRes.json()).id as string;
  await app1.request("/v1/connections", { method: "POST", headers: H, body: JSON.stringify({ kind: "email", name: `pg-${Date.now()}`, config: {} }) });
  await app1.request("/v1/wedges/enrollment-operator/knowledge", { method: "POST", headers: H, body: JSON.stringify({ name: `pg-${Date.now()}.md`, content: "survives", kind: "fact" }) });
  await first.store.close?.();

  // ── boot 2: fresh stores against the same database ──
  const second = await createStore();
  await initDomainStore();
  await initIdentityStore();
  const app2 = createServer(second.store);

  const got = await app2.request(`/v1/tasks/${taskId}`, { headers: H });
  assert.equal(got.status, 200, "the task is still readable after a restart (project_id persisted)");

  const conns = await (await app2.request("/v1/connections", { headers: H })).json();
  assert.ok(conns.length > 0, "connections persisted and are in scope");

  const knowledge = await (await app2.request("/v1/wedges/enrollment-operator/knowledge", { headers: H })).json();
  assert.ok(knowledge.length > 0, "living knowledge persisted and is in scope");

  await second.store.close?.();
  await (getDomainStore() as { close?: () => Promise<void> }).close?.();
});
