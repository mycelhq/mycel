// Multi-instance safety. Runs TWO independent kernel instances against ONE Postgres — the shape a
// cloud fleet actually has — and asserts the thing that would otherwise be a customer-visible
// catastrophe: a schedule due once must fire exactly ONCE across the fleet, not once per replica.
//
// Skipped unless MYCEL_TEST_DATABASE_URL points at a throwaway Postgres.
import { test } from "node:test";
import assert from "node:assert/strict";

const URL = process.env.MYCEL_TEST_DATABASE_URL;
const skip = URL ? false : "set MYCEL_TEST_DATABASE_URL to run";

test("two replicas, one Postgres: a due schedule fires exactly once", { skip }, async () => {
  process.env.MYCEL_DATABASE_URL = URL;
  const { PostgresDomainStore } = await import("../src/domain.pg");
  const { nextRun } = await import("../src/scheduler");

  // two stores = two replicas talking to the same database
  const a = await PostgresDomainStore.connect(URL!);
  const b = await PostgresDomainStore.connect(URL!);

  const name = `mi-${Date.now()}`;
  const created = await a.createSchedule({
    project_id: "p",
    name,
    wedge: "books-keeper",
    task_type: "daily_sync",
    input: {},
    cadence: { kind: "every", seconds: 3600 },
    enabled: true,
    next_run_at: new Date(Date.now() - 5_000).toISOString(), // already due
  });

  const now = new Date().toISOString();
  const advance = (s: import("../src/contract").Schedule, at: Date) => nextRun(s.cadence, at).toISOString();

  // both replicas tick at the same instant — the race a fleet actually has
  const [claimedA, claimedB] = await Promise.all([
    a.claimDueSchedules(now, advance),
    b.claimDueSchedules(now, advance),
  ]);

  const wonA = claimedA.filter((s) => s.id === created.id).length;
  const wonB = claimedB.filter((s) => s.id === created.id).length;
  assert.equal(wonA + wonB, 1, `exactly one replica may claim it (A=${wonA}, B=${wonB}) — otherwise the client gets duplicate emails`);

  // and it is no longer due for anyone
  const after = await a.getSchedule(created.id);
  assert.ok(after!.next_run_at > now, "next_run_at was advanced inside the claim transaction");
  const third = await b.claimDueSchedules(new Date().toISOString(), advance);
  assert.equal(third.filter((s) => s.id === created.id).length, 0, "a later tick does not re-fire it");

  await a.deleteSchedule(created.id);
  await a.close();
  await b.close();
});

test("hammer: 4 replicas ticking concurrently still fire each schedule once", { skip }, async () => {
  process.env.MYCEL_DATABASE_URL = URL;
  const { PostgresDomainStore } = await import("../src/domain.pg");
  const { nextRun } = await import("../src/scheduler");

  const replicas = await Promise.all([0, 1, 2, 3].map(() => PostgresDomainStore.connect(URL!)));
  const stamp = Date.now();
  const ids: string[] = [];
  for (let i = 0; i < 10; i++) {
    const s = await replicas[0].createSchedule({
      project_id: "p",
      name: `hammer-${stamp}-${i}`,
      wedge: "books-keeper",
      task_type: "daily_sync",
      input: {},
      cadence: { kind: "every", seconds: 3600 },
      enabled: true,
      next_run_at: new Date(Date.now() - 5_000).toISOString(),
    });
    ids.push(s.id);
  }

  const now = new Date().toISOString();
  const advance = (s: import("../src/contract").Schedule, at: Date) => nextRun(s.cadence, at).toISOString();
  const results = await Promise.all(replicas.map((r) => r.claimDueSchedules(now, advance)));

  // count claims per schedule across all replicas
  const counts = new Map<string, number>();
  for (const claimed of results) {
    for (const s of claimed) counts.set(s.id, (counts.get(s.id) ?? 0) + 1);
  }
  for (const id of ids) {
    assert.equal(counts.get(id) ?? 0, 1, `schedule ${id} was claimed ${counts.get(id) ?? 0} times, must be exactly 1`);
  }

  for (const id of ids) await replicas[0].deleteSchedule(id);
  await Promise.all(replicas.map((r) => r.close()));
});
