import { test } from "node:test";
import { jsonBody } from "./helpers";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { createServer } from "../src/server";
import { PostgresStore } from "../src/store.pg";
import { closeQueue, enqueueTask, initQueue, queueEnabled, startWorker } from "../src/queue";

/**
 * The queue, against a real Postgres.
 *
 * The behaviour under test only exists when there IS a queue; in-memory runs inline, which every
 * other test already covers.
 *
 * ═══ IT READS `MYCEL_TEST_DATABASE_URL`, AND THAT IS A SAFETY FIX ═══
 *
 * This gated on `MYCEL_DATABASE_URL` — the PRODUCTION variable, the one a running kernel points at
 * its real database — while the rest of the live tier reads `MYCEL_TEST_DATABASE_URL`, "a throwaway
 * Postgres you may create tables in". The header claimed to match "the other Postgres-gated tests"
 * and did not.
 *
 * Two consequences, and the second is the bad one. It never ran alongside the rest of the live tier,
 * so the queue had no coverage in a normal live run. And a developer with their kernel's environment
 * exported — which is the ordinary state of a machine that runs a kernel — would, on `npm test`,
 * have `startWorker` attach a real graphile-worker to the PRODUCTION queue, claim real queued tasks
 * and execute them on a laptop.
 *
 * So it reads the throwaway variable, and REFUSES rather than skips when that points at the same
 * database as the production one. Skipping would be the wrong answer to a misconfiguration this
 * dangerous: silence is how it stays misconfigured.
 */
const URL = process.env.MYCEL_TEST_DATABASE_URL;
if (URL && process.env.MYCEL_DATABASE_URL && URL === process.env.MYCEL_DATABASE_URL) {
  throw new Error(
    "MYCEL_TEST_DATABASE_URL is the same database as MYCEL_DATABASE_URL. These tests enqueue work " +
      "and START A WORKER that would execute it. Point the test variable at a throwaway database.",
  );
}
// `queue.ts` resolves its connection from `MYCEL_DATABASE_URL`, so the throwaway is installed there
// for this process only — the same thing `postgres.test.ts` does, and why `--test` running each
// file in its own process matters.
if (URL) process.env.MYCEL_DATABASE_URL = URL;
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
    const task = await jsonBody(created);

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
