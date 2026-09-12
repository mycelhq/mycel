// Every statement builder, handed to Postgres and asked whether it is even legal.
//
// ═══ WHY `PREPARE` IS THE RIGHT CHECK, AND WHY IT IS CHEAP ═══
//
// `submitVersionSql` shipped a statement that used one parameter for a `text` column and two
// `timestamptz` ones. Postgres cannot deduce a consistent type for that, so the statement failed to
// PREPARE — it never executed at all, in production, on the delivery path. The suite stayed green
// because the pg tests hand statements to a `FakeDb` that records the string and never runs it.
//
// PREPARE is exactly the boundary that matters here. It resolves table and column names, checks
// types, and deduces one type per parameter — catching a renamed column, a typo, and the parameter
// bug — and it needs NO fixture data, no valid ids and no rows. So one test can cover every builder
// in the codebase for the price of a connection.
//
// It deliberately does not assert results. Whether a statement does the RIGHT thing is what the
// suites next door are for; this asserts only that it CAN run, which is the thing nobody was
// checking and the thing that was false.
//
// ═══ ITS OWN SCHEMA ═══
//
// The stores create their tables wherever the connection points, so a private `search_path` gives
// this file real tables without touching what the rest of the live tier is using — the collision
// `schema-race.test.ts` used to cause.
//
// SKIPPED, NOT FAILED, without a database. Same rule as the rest of the tier.
import { test } from "node:test";
import assert from "node:assert/strict";

const URL_ = process.env.MYCEL_TEST_DATABASE_URL;
const SCHEMA = "mycel_sql_prepares";

test("every SQL builder produces a statement Postgres will accept", async (t) => {
  if (!URL_) return t.skip("set MYCEL_TEST_DATABASE_URL to run");

  const { Pool } = (await import("pg")).default;
  const admin = new Pool({ connectionString: URL_ });
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};`);
  const scoped = `${URL_}${URL_.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-c search_path=${SCHEMA}`)}`;

  // The real DDL, from the real stores. Connecting is what creates the tables these statements name,
  // so a column renamed in one and forgotten in the other shows up here rather than in production.
  const { PostgresBillingStore } = await import("../src/billing.pg");
  const { PostgresDeliverableStore } = await import("../src/deliverables.pg");
  const billingStore = await PostgresBillingStore.connect(scoped).catch((e: Error) => e);
  const deliverablesStore = await PostgresDeliverableStore.connect(scoped).catch((e: Error) => e);
  assert.ok(!(billingStore instanceof Error), `billing schema failed to create: ${(billingStore as Error)?.message}`);
  assert.ok(
    !(deliverablesStore instanceof Error),
    `deliverables schema failed to create: ${(deliverablesStore as Error)?.message}`,
  );

  const b = await import("../src/billing.pg");
  const d = await import("../src/deliverables.pg");

  const AT = "2026-01-03T00:00:00Z";
  /** One plausible call per builder. The ARGUMENTS do not matter to PREPARE; the shape does. */
  const built: { name: string; sql: string }[] = [
    { name: "deliverables.listDeliverablesSql", ...d.listDeliverablesSql({ project_id: "p1" } as never) },
    {
      name: "deliverables.submitVersionSql",
      ...d.submitVersionSql({
        project_id: "p1",
        deliverable_id: "d1",
        allowedFrom: ["drafting"],
        version: { summary: "s", artifact_ids: [], author: "agent" } as never,
        at: AT,
        new_id: "v1",
      }),
    },
    {
      name: "deliverables.transitionSql",
      ...d.transitionSql({ project_id: "p1", id: "d1", to: "with_client" as never, allowedFrom: ["in_review"] as never, at: AT }),
    },
    { name: "deliverables.releaseSql", ...d.releaseSql({ project_id: "p1", deliverable_id: "d1", version: 1, at: AT }) },
    {
      name: "deliverables.settleSql",
      ...d.settleSql({ project_id: "p1", deliverable_id: "d1", version: 1, at: AT, verdict: { kind: "accepted", note: "ok" } }),
    },
    {
      // The other branch builds different SQL, so it is a different statement and gets its own probe.
      name: "deliverables.settleSql(changes_requested)",
      ...d.settleSql({ project_id: "p1", deliverable_id: "d1", version: 1, at: AT, verdict: { kind: "changes_requested", request: "please revise" } }),
    },
    { name: "billing.chaseClaimUpdate", ...b.chaseClaimUpdate("i1", AT, AT) },
    { name: "billing.chaseClaimRelease", ...b.chaseClaimRelease("i1", AT, "sent") },
    {
      name: "billing.externalPaymentApply",
      ...b.externalPaymentApply({
        project_id: "p1", invoice_id: "i1", amount_minor: 100, currency: "GBP",
        paid_at: AT, basis: "bank", source: "manual", method: "transfer", reference: "r1",
      } as never),
    },
    {
      name: "billing.paymentCheckUpsert",
      ...b.paymentCheckUpsert({ project_id: "p1", invoice_id: "i1", attempted_at: AT, ok: true, detail: "" } as never),
    },
  ];

  const broken: string[] = [];
  // ONE connection for all of them. A pool per statement was correct and took thirty seconds; a
  // prepared name is per-session, so `DEALLOCATE` after each is all the isolation this needs.
  const { Client } = (await import("pg")).default;
  const conn = new Client({ connectionString: scoped });
  await conn.connect();
  try {
    for (const [i, s] of built.entries()) {
      try {
        // No type list: Postgres infers, exactly as node-postgres leaves it to. That inference is
        // what the parameter bug tripped over, so declaring types here would hide the very thing
        // this test exists to catch.
        await conn.query(`PREPARE probe_${i} AS ${s.sql}`);
        await conn.query(`DEALLOCATE probe_${i}`);
      } catch (e) {
        broken.push(`${s.name}\n      ${(e as Error).message}`);
        // A failed PREPARE aborts the session's transaction state on some paths; a rollback keeps
        // one broken statement from reporting every statement after it as broken too.
        await conn.query("ROLLBACK").catch(() => {});
      }
    }

    assert.deepEqual(
      broken,
      [],
      `these statements cannot run on Postgres at all:\n\n   ${broken.join("\n\n   ")}\n\n` +
        `PREPARE resolves columns, types and one type per parameter. A failure here means the\n` +
        `statement never executes in production, however green the unit tests are.`,
    );
  } finally {
    await conn.end().catch(() => {});
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
    await admin.end().catch(() => {});
  }
});
