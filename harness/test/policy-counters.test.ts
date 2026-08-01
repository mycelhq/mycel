// Policy ceilings under replication.
//
// `max_per_day: 40` with the counters in a process `Map` and 2 API replicas + 2 workers is an
// envelope that actually permits ~160 auto-approved real-world actions a day. That is a security
// control failing OPEN, silently, only in production. These cover the two properties that make the
// ceiling real: the increment is atomic (nobody's +1 is lost), and the ceiling admits exactly N
// callers no matter how many processes race for the last slot.
//
// The multi-replica assertions need a shared backend and are skipped without
// MYCEL_TEST_DATABASE_URL; the single-store ones run everywhere.
import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryPolicyCounters } from "../src/store";
import { evaluatePolicy, resetPolicyCounters } from "../src/policy";
import type { WedgeManifest } from "../src/wedge";
import type { PolicyCounterStore } from "../src/store";

const URL = process.env.MYCEL_TEST_DATABASE_URL;
const skip = URL ? false : "set MYCEL_TEST_DATABASE_URL to run";

const manifest = (policy: unknown): WedgeManifest => ({ wedge: "w", policy } as WedgeManifest);
const soon = () => new Date(Date.now() + 3_600_000);

/**
 * The shared assertion: N concurrent `bump`s against one counter must return 1..N exactly once
 * each. A returned value that repeats is a lost update, which is a ceiling that lets an extra
 * action through.
 */
async function assertNoLostUpdates(bump: () => Promise<number>, n: number): Promise<void> {
  const results = await Promise.all(Array.from({ length: n }, () => bump()));
  const sorted = [...results].sort((a, b) => a - b);
  assert.deepEqual(
    sorted,
    Array.from({ length: n }, (_, i) => i + 1),
    `each increment must return its own position; got ${JSON.stringify(sorted)}`,
  );
}

test("concurrent increments do not lose an update (in-memory)", async () => {
  const c = new InMemoryPolicyCounters();
  await assertNoLostUpdates(() => c.bump("p", "day", "2026-01-01|email:send", soon()), 50);
});

test("a bump on an expired counter starts a new window rather than continuing the old one", async () => {
  const c = new InMemoryPolicyCounters();
  await c.bump("p", "day", "k", new Date(Date.now() - 1));
  assert.equal(await c.peek("p", "day", "k"), 0, "an expired counter reads as zero");
  assert.equal(await c.bump("p", "day", "k", soon()), 1, "and the next bump restarts at 1");
  assert.equal(await c.bump("p", "day", "k", soon()), 2);
});

test("counters are project-scoped, and 'no project' is a sentinel rather than a hole", async () => {
  const c = new InMemoryPolicyCounters();
  await c.bump("p1", "day", "k", soon());
  await c.bump("p1", "day", "k", soon());
  assert.equal(await c.peek("p2", "day", "k"), 0, "another tenant's budget is not this tenant's");
  assert.equal(await c.peek("-", "day", "k"), 0, "and the unscoped sentinel is its own bucket");
});

test("the in-memory counters evict — the old perTask map never did", async () => {
  const c = new InMemoryPolicyCounters();
  const past = new Date(Date.now() - 1);
  // One entry per (task, rule) forever was the old behaviour: a long-lived API replica accumulated
  // a row for every task it ever auto-approved anything on.
  for (let i = 0; i < 500; i++) await c.bump("p", "task", `task-${i}|email:send`, past);
  await c.bump("p", "task", "live|email:send", soon());

  const remaining = c.sweepNow();
  assert.equal(remaining, 1, `expected only the live counter to survive, ${remaining} remain`);
  assert.equal(await c.peek("p", "task", "live|email:send"), 1, "the sweep must not take live budget");
});

test("a per-day ceiling admits exactly N, even when every caller races for the last slot", async () => {
  resetPolicyCounters();
  const m = manifest({ auto_approve: [{ action: "email:send", max_per_day: 5 }] });
  // 25 callers, all peeking at the same instant against the same counter. The peek is advisory;
  // the number the atomic increment hands back is what decides, so the total cannot exceed 5.
  const decisions = await Promise.all(
    Array.from({ length: 25 }, (_, i) =>
      evaluatePolicy(m, { action: "email:send", taskId: `race-${i}`, projectId: "race-project" }),
    ),
  );
  const allowed = decisions.filter((d) => d.auto).length;
  assert.equal(allowed, 5, `a max_per_day of 5 must auto-approve 5, not ${allowed}`);
  for (const d of decisions.filter((x) => !x.auto)) assert.match(d.reason, /daily limit of 5/);
});

test("a per-task ceiling admits exactly N under the same race", async () => {
  resetPolicyCounters();
  const m = manifest({ auto_approve: [{ action: "email:send", max_per_task: 3 }] });
  const decisions = await Promise.all(
    Array.from({ length: 20 }, () => evaluatePolicy(m, { action: "email:send", taskId: "one-task" })),
  );
  assert.equal(decisions.filter((d) => d.auto).length, 3);
});

test("policy fails CLOSED when the counters are unreachable", async () => {
  // The deliberate decision, written out in policy.ts: this gates auto-approval of real-world
  // actions — client email, money movement. Failing open would make an unreachable database
  // dissolve every ceiling in the system at once. Failing closed routes the action to the human
  // gate, which is the kernel's documented default for anything without a policy.
  const { resetPolicyCounterStoreForTests } = await import("../src/store");
  const saved = process.env.MYCEL_DATABASE_URL;
  const savedPooled = process.env.MYCEL_DATABASE_POOLED_URL;
  process.env.MYCEL_DATABASE_POOLED_URL = "";
  process.env.MYCEL_DATABASE_URL = "postgres://nobody:nobody@127.0.0.1:1/nothing";
  resetPolicyCounterStoreForTests();
  try {
    const m = manifest({ auto_approve: [{ action: "email:send", max_per_day: 40 }] });
    const d = await evaluatePolicy(m, { action: "email:send", taskId: "t", projectId: "p" });
    assert.equal(d.auto, false, "an unreachable counter store must not grant autonomy");
    assert.match(d.reason, /policy counters unavailable/);
  } finally {
    if (saved === undefined) delete process.env.MYCEL_DATABASE_URL;
    else process.env.MYCEL_DATABASE_URL = saved;
    if (savedPooled === undefined) delete process.env.MYCEL_DATABASE_POOLED_URL;
    else process.env.MYCEL_DATABASE_POOLED_URL = savedPooled;
    resetPolicyCounterStoreForTests();
  }
});

// ── The real thing: two counter stores, one database ───────────────────────────

test("cross-replica: concurrent increments across two instances lose nothing", { skip }, async () => {
  const { PostgresPolicyCounters } = await import("../src/store.pg");
  const a = await PostgresPolicyCounters.connect(URL!);
  const b = await PostgresPolicyCounters.connect(URL!);
  const key = `k-${Date.now()}`;
  let turn = 0;
  const stores: PolicyCounterStore[] = [a, b];
  // Alternate between the two "replicas" so half the increments cross the process boundary.
  await assertNoLostUpdates(() => stores[turn++ % 2].bump("p", "day", key, soon()), 40);
  await a.close();
  await b.close();
});

test("cross-replica: a per-day ceiling holds when two replicas increment", { skip }, async () => {
  const { PostgresPolicyCounters } = await import("../src/store.pg");
  const replicas = [await PostgresPolicyCounters.connect(URL!), await PostgresPolicyCounters.connect(URL!)];
  const project = `proj-${Date.now()}`;
  const key = "2026-01-01|email:send";
  const LIMIT = 10;

  // 60 attempts spread over both replicas, all at once. Each caller keeps its slot only if the
  // number the increment handed back is within the ceiling — which is the whole enforcement.
  const kept = await Promise.all(
    Array.from({ length: 60 }, (_, i) =>
      replicas[i % 2].bump(project, "day", key, soon()).then((n) => n <= LIMIT),
    ),
  );
  assert.equal(kept.filter(Boolean).length, LIMIT, "exactly the ceiling, across both replicas");
  assert.equal(await replicas[0].peek(project, "day", key), 60, "and every attempt was counted once");

  await Promise.all(replicas.map((r) => r.close()));
});
