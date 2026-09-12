import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { InMemoryStore } from "../src/store";
import type { Task } from "../src/contract";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * SCOPE IN THE QUERY — A PERFORMANCE FIX THAT IS REALLY A TENANCY FIX
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `/v1/analytics` did `listTasks({ limit: 5000 })` and filtered by project in JavaScript. It was the
 * slowest call in the product — 9.5s at the worst, measured from the cloud's own slow-call log,
 * eight times the next endpoint and sitting on Home.
 *
 * The correctness half is worse. Taking the newest five thousand rows ACROSS EVERY TENANT and only
 * then keeping the ones you may see means a busy neighbour fills the window: a small customer opens
 * their analytics and reads zero, on rows that exist and were never fetched. `countTasksSince` in
 * `store.ts` carries a warning about this exact bug in these words, because it was found and fixed
 * there. It was still here.
 */
const task = (project_id: string, created_at: string): Task => ({
  id: randomUUID(),
  project_id,
  wedge: "books-keeper",
  task_type: "monthly_close",
  actor: { kind: "system", id: "test" },
  input: {},
  constraints: {},
  tools: [],
  status: "succeeded",
  cost_usd: 0.01,
  created_at,
  updated_at: created_at,
});

const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86400_000).toISOString();

test("a busy neighbour cannot push a tenant out of their own window", async () => {
  const store = new InMemoryStore();
  // The loud tenant, newest rows.
  for (let i = 0; i < 200; i++) await store.createTask(task("loud", iso(0)));
  // The quiet one, older — exactly the rows a global LIMIT would drop.
  for (let i = 0; i < 3; i++) await store.createTask(task("quiet", iso(5)));

  const unscoped = await store.listTasks({ limit: 50 });
  assert.equal(
    unscoped.filter((t) => t.project_id === "quiet").length,
    0,
    "the premise is wrong — a global limit did not actually hide the quiet tenant",
  );

  const scoped = await store.listTaskFacts({ project_ids: ["quiet"], limit: 50 });
  assert.equal(scoped.length, 3, "the quiet tenant still cannot see their own rows");
  assert.ok(scoped.every((t) => t.project_id === "quiet"), "another tenant's rows crossed the boundary");
});

test("an empty scope matches nothing, never everything", async () => {
  /**
   * The direction that matters. A caller who can see no projects must get no rows — the tempting
   * implementation skips the WHERE clause when the list is empty, which widens to the whole table
   * at exactly the moment the caller is least entitled to it.
   */
  const store = new InMemoryStore();
  for (let i = 0; i < 5; i++) await store.createTask(task("someone", iso(1)));
  const none = await store.listTaskFacts({ project_ids: [], limit: 50 });
  assert.deepEqual(none, [], "an empty scope returned rows");
});

test("the window is applied in the read, not after it", async () => {
  const store = new InMemoryStore();
  await store.createTask(task("p", iso(1)));
  await store.createTask(task("p", iso(40)));
  const recent = await store.listTaskFacts({ project_ids: ["p"], since: iso(30) });
  assert.equal(recent.length, 1, "the 40-day-old row was returned inside a 30-day window");
});

test("facts carry what an aggregate needs and no payload", async () => {
  // The point of the lean read: `tasks` averages ~3KB a row because input/constraints/tools/output
  // are JSON, and analytics counted rows and summed a float. Fifteen megabytes to do arithmetic.
  const store = new InMemoryStore();
  await store.createTask(task("p", iso(1)));
  const [fact] = await store.listTaskFacts({ project_ids: ["p"] });
  assert.ok(fact, "no fact came back");
  assert.deepEqual(
    Object.keys(fact).sort(),
    ["cost_usd", "created_at", "id", "project_id", "status", "wedge"],
    "the fact shape drifted — either analytics needs more, or this is carrying a payload again",
  );
});
