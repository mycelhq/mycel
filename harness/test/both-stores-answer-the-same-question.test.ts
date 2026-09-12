// A DROPPED DEFAULT CANCELLED LIVE RUNS ON EVERY INSTALL WITHOUT POSTGRES.
//
// ═══ WHAT HAPPENED, MEASURED ═══
//
// A real-key job on the local kernel: started, ran, called tools, charged $0.014, and was killed
// with "This run went silent while running — nothing has driven it for over ten minutes, so it was
// closed." The run had lived 65 SECONDS and its largest internal gap was 8.9 seconds. Both halves of
// that sentence were wrong, and it is the sentence the founder reads.
//
// ═══ WHY ═══
//
//     store.pg.ts   listUnfinished(staleAfterMs = STALE_TASK_MS)   ← ten minutes
//     store.ts      listUnfinished(staleAfterMs?: number)          ← no default
//
// `recovery.ts` calls `listUnfinished()` with no argument. On Postgres that means ten minutes; on
// memory it meant no cutoff at all, so the filter passed EVERY non-terminal row and the dead-run
// reaper — on a two-minute timer — cancelled runs that had started seconds earlier.
//
// Both signatures satisfy the interface. Both typecheck. The reaper's own note says "a live run is
// never a candidate", which was true of the store it was reasoned against and false of the other.
//
// It hit exactly the installs with no Postgres: `npm run demo`, the test suite, and every stranger
// who clones the open repo and runs a job.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { InMemoryStore, STALE_TASK_MS } from "../src/store";
import type { Task } from "../src/contract";

function row(id: string, ageMs: number): Task {
  const at = new Date(Date.now() - ageMs).toISOString();
  return {
    id,
    project_id: "p",
    wedge: "invoice-chaser",
    task_type: "chase_invoice",
    actor: { kind: "system", id: "kernel" },
    input: {},
    constraints: { max_cost_usd: 1, max_runtime_s: 60, approval_required: false },
    tools: [],
    status: "running",
    cost_usd: 0,
    created_at: at,
    updated_at: at,
  } as Task;
}

test("a run that is working right now is never a reclaim candidate", async () => {
  /**
   * The exact failure, as behaviour rather than as a signature check: called with NO argument — the
   * way `recovery.ts` calls it — a run touched seconds ago must not come back.
   */
  const store = new InMemoryStore();
  await store.createTask(row("fresh", 2_000));
  await store.createTask(row("also-fresh", 30_000));

  const stuck = await store.listUnfinished();
  assert.deepEqual(
    stuck.map((t) => t.id),
    [],
    "a live run was offered for reclamation — the dead-run reaper would cancel it mid-flight",
  );
});

test("a genuinely stale run still is one", async () => {
  /*
    The other half, or the fix is just "never reclaim anything" — which would leave dead runs holding
    their claims until the next deploy. Measured in production before the reaper existed: 331 of 350
    reclaimed runs had done no real work for an average of 7,043 seconds.
  */
  const store = new InMemoryStore();
  await store.createTask(row("dead", STALE_TASK_MS + 60_000));
  const stuck = await store.listUnfinished();
  assert.deepEqual(stuck.map((t) => t.id), ["dead"]);
});

test("the two stores declare the same default, not merely a compatible signature", () => {
  /**
   * `staleAfterMs?: number` and `staleAfterMs = STALE_TASK_MS` both satisfy the interface, so the
   * type system cannot catch this class — which is why it is asserted on the source.
   *
   * Both must name `STALE_TASK_MS` as the default. Matching the VALUE rather than a spelling of the
   * parameter, so a rename does not go red and a silently different number does.
   */
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
  const mem = strip(readFileSync(new URL("../src/store.ts", import.meta.url), "utf8"));
  const pg = strip(readFileSync(new URL("../src/store.pg.ts", import.meta.url), "utf8"));

  for (const [label, src] of [["memory", mem], ["postgres", pg]] as const) {
    /*
      `async` anchors this to the IMPLEMENTATION. Without it the first match in `store.ts` is the
      interface declaration — `listUnfinished(staleAfterMs?: number)` — which correctly has no
      default, so the guard failed against a correct implementation. An interface cannot carry a
      default; only the two classes can, and they are what must agree.
    */
    const m = src.match(/async listUnfinished\(staleAfterMs[^)]*\)/);
    assert.ok(m, `${label}: could not find the listUnfinished implementation — this guard is measuring nothing`);
    assert.match(
      m[0],
      /=\s*STALE_TASK_MS/,
      `${label}: listUnfinished has no default — the caller passes no argument, so this store will answer a different question from its sibling`,
    );
  }
});

test("the constant lives where both stores can reach it", () => {
  /**
   * The cause, not just the symptom. `STALE_TASK_MS` was exported from `store.pg.ts`, which the
   * memory store cannot import without dragging in the `pg` driver — so it had no default available
   * to use, and the divergence was structural rather than an oversight.
   */
  assert.equal(typeof STALE_TASK_MS, "number");
  assert.ok(STALE_TASK_MS > 0);
  const mem = readFileSync(new URL("../src/store.ts", import.meta.url), "utf8");
  assert.match(mem, /export const STALE_TASK_MS/, "the constant moved back out of the shared module");
  const pg = readFileSync(new URL("../src/store.pg.ts", import.meta.url), "utf8");
  assert.ok(
    !/export const STALE_TASK_MS\s*=/.test(pg),
    "store.pg.ts declares its own STALE_TASK_MS again — two constants is how the two stores drift",
  );
});
