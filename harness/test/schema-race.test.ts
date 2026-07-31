import { test } from "node:test";
import assert from "node:assert/strict";

// Its own file: this DROPs the schema to make the race reachable, and Node isolates each test file
// in its own process. Sharing one with a test that is mid-run against those tables is how you get
// "relation tasks does not exist" from a test that is actually about something else.

test("postgres: concurrent boots do not race on schema creation", { skip: !process.env.MYCEL_TEST_DATABASE_URL && "set MYCEL_TEST_DATABASE_URL to run" }, async () => {
  // `CREATE TABLE IF NOT EXISTS` is NOT concurrency-safe: two connections both check, both find
  // nothing, both create, and the loser gets "duplicate key value violates unique constraint
  // pg_type_typname_nsp_index" because a table creates a row type. The deployment runs two API
  // replicas and two workers against one database, so four kernels do this at once on every deploy
  // and some fraction crash at boot — which reads as a flaky deploy rather than as a bug.
  //
  // Caught the first time the suite ran against real Postgres instead of the in-memory store.
  const url = process.env.MYCEL_TEST_DATABASE_URL!;
  const { Pool } = (await import("pg")).default;
  const admin = new Pool({ connectionString: url });

  // A fresh schema, so the race is actually reachable. Ordered for foreign keys.
  await admin.query(`
    DROP TABLE IF EXISTS artifacts, approvals, events, tasks CASCADE;
    DROP TABLE IF EXISTS portal_links, portal_sessions CASCADE;
  `);

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
  const probe = await admin.query("SELECT to_regclass('public.tasks') IS NOT NULL AS ok");
  assert.equal(probe.rows[0].ok, true, "tasks exists");
  await store.close?.();
  await admin.end();
});
