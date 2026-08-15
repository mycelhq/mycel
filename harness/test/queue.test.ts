import { test } from "node:test";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { createServer } from "../src/server";
import { PostgresStore } from "../src/store.pg";
import { closeQueue, enqueueTask, initQueue, queueEnabled, startWorker } from "../src/queue";

/**
 * The queue, against a real Postgres.
 *
 * Skipped without MYCEL_DATABASE_URL, like the other Postgres-gated tests — the point is that the
 * behaviour under test only exists when there IS a queue. In-memory runs inline, which every other
 * test already covers.
 */
const URL = process.env.MYCEL_DATABASE_URL;
const maybe = URL ? test : test.skip;

// A uuid column, and a REAL database that persists between runs — a fixed id passes once and then
// collides forever.
const DEDUPE_ID = randomUUID();

maybe("queue: work is distributed to workers, not run by whoever received the request", async () => {
  const store = await PostgresStore.connect(URL!);
  const app = createServer(store);

  const { mode } = await initQueue();
  assert.equal(mode, "queue", "a configured database means a real queue");
  assert.equal(queueEnabled(), true);

  try {
    // Enqueue with NO worker running. Under the old design the API process would already have
    // started executing; the whole point is that it hasn't.
    const created = await app.request("/v1/tasks", {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.MYCEL_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ wedge: "books-keeper", task_type: "daily_sync", input: { message: "hi" } }),
    });
    assert.equal(created.status, 201);
    const task = await created.json();

    await new Promise((r) => setTimeout(r, 500));
    assert.equal((await store.getTask(task.id))!.status, "queued", "still waiting for a worker");

    // Now start one. NOTIFY should pick it up in milliseconds rather than on a poll.
    const worker = await startWorker(store);
    assert.ok(worker, "a worker starts when a database is configured");

    const began = Date.now();
    let final;
    for (let i = 0; i < 300; i++) {
      await new Promise((r) => setTimeout(r, 20));
      final = await store.getTask(task.id);
      if (final && ["succeeded", "failed"].includes(final.status)) break;
    }
    assert.equal(final?.status, "succeeded", "the worker claimed and ran it");
    // Generous, but it pins the property that matters: LISTEN/NOTIFY, not a slow poll.
    assert.ok(Date.now() - began < 4000, "picked up promptly rather than on the fallback poll");

    await worker!.stop();
  } finally {
    await closeQueue();
    await store.close?.();
  }
});

maybe("queue: enqueuing the same task twice runs it once", async () => {
  // A retried HTTP request or a duplicated webhook must not provision two sandboxes and send two
  // emails. The queue dedupes on jobKey before any of that happens.
  const store = await PostgresStore.connect(URL!);
  await initQueue();
  try {
    const now = new Date().toISOString();
    await store.createTask({
      id: DEDUPE_ID, project_id: null, wedge: "books-keeper", task_type: "daily_sync",
      actor: { kind: "system", id: "s" }, input: { message: "x" },
      constraints: { max_runtime_s: 60, max_cost_usd: 1, approval_required: false },
      tools: [], status: "queued", cost_usd: 0, created_at: now, updated_at: now,
    } as never);

    await enqueueTask(store, DEDUPE_ID);
    await enqueueTask(store, DEDUPE_ID);
    await enqueueTask(store, DEDUPE_ID);

    const pg = await import("pg");
    const probe = new pg.default.Pool({ connectionString: URL });
    const { rows } = await probe.query("SELECT 1 FROM graphile_worker.jobs WHERE key = $1", [DEDUPE_ID]);
    await probe.end();
    assert.equal(rows.length, 1, "three enqueues, one job — deduped before a sandbox is provisioned");
  } finally {
    await closeQueue();
    await store.close?.();
  }
});
