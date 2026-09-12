import { test } from "node:test";
import assert from "node:assert/strict";

// Its own file AND ITS OWN SCHEMA, and the second half is the part that was missing.
//
// This DROPs tables to make the race reachable. The original reasoning was that "Node isolates each
// test file in its own process", which is true and does not help: separate processes still share
// ONE Postgres, and `node --test` runs files concurrently. So this was dropping `tasks` out from
// under whatever else was mid-run against it.
//
// It went unnoticed because the test most likely to collide — `queue.test.ts` — read the wrong
// environment variable and had never run. The moment it did, it failed here with the exact symptom
// the note below predicts: a task created, then gone, then "cannot read properties of undefined".
//
// A private schema on the search_path fixes it properly. The stores create their tables wherever
// the connection points, so they need no change, and this file can drop whatever it likes.

test("postgres: concurrent boots do not race on schema creation", { skip: !process.env.MYCEL_TEST_DATABASE_URL && "set MYCEL_TEST_DATABASE_URL to run" }, async () => {
  // `CREATE TABLE IF NOT EXISTS` is NOT concurrency-safe: two connections both check, both find
  // nothing, both create, and the loser gets "duplicate key value violates unique constraint
  // pg_type_typname_nsp_index" because a table creates a row type. The deployment runs two API
  // replicas and two workers against one database, so four kernels do this at once on every deploy
  // and some fraction crash at boot — which reads as a flaky deploy rather than as a bug.
  //
  // Caught the first time the suite ran against real Postgres instead of the in-memory store.
  const base = process.env.MYCEL_TEST_DATABASE_URL!;
  const { Pool } = (await import("pg")).default;

  /**
   * A schema of this file's own. `options=-c search_path=…` is honoured by libpq and therefore by
   * `pg`, so every connection made from this URL — including the six the stores open below — creates
   * and reads its tables in here rather than in `public`, where the rest of the live tier is working.
   */
  const SCHEMA = "mycel_schema_race";
  const admin = new Pool({ connectionString: base });
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};`);
  const url = `${base}${base.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-c search_path=${SCHEMA}`)}`;

  const { PostgresStore } = await import("../src/store.pg");
  const { PortalPg } = await import("../src/portal.pg");

  // Six at once — more than the four the deployment actually runs, so a pass is not luck.
  const boots = [
    ...Array.from({ length: 4 }, () => PostgresStore.connect(url)),
    ...Array.from({ length: 2 }, () => PortalPg.connect(url)),
  ];
  const settled = await Promise.allSettled(boots);
  const failed = settled.filter((s) => s.status === "rejected");
  assert.equal(
    failed.length,
    0,
    `every concurrent boot must succeed; got ${failed.length} failures: ${failed
      .map((f) => (f as PromiseRejectedResult).reason?.message)
      .join(" | ")}`,
  );

  // And the schema is actually usable afterwards, not merely un-crashed.
  const store = (settled[0] as PromiseFulfilledResult<InstanceType<typeof PostgresStore>>).value;
  // In OUR schema, not `public` — that literal is what would quietly pass while the stores created
  // their tables somewhere else entirely, which is the failure mode this whole change is about.
  const probe = await admin.query(`SELECT to_regclass('${SCHEMA}.tasks') IS NOT NULL AS ok`);
  assert.equal(probe.rows[0].ok, true, "tasks exists in this test's own schema");
  await store.close?.();
  // Leave the database as it was found. A schema left behind is the next run's confusing state.
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
  await admin.end();
});
