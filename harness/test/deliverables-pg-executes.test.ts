// The SQL is EXECUTED here, not asserted as a string.
//
// ═══ THE BUG THIS EXISTS FOR ═══
//
// `submitVersionSql` used `$9` for `author` in the INSERT and, in the two UPDATEs below it, for
// `superseded_at` and `updated_at`. `$9` is a text parameter; those are `timestamptz` columns.
// Postgres deduces one type per parameter, infers `text` from the first use, and then refuses:
//
//   ERROR: column "superseded_at" is of type timestamp with time zone but expression is of type text
//
// It does not fail at execution. It fails to PREPARE. So every deliverable version submitted on
// Postgres failed — the whole delivery path, in production — while `deliverables-pg.test.ts` passed,
// because that suite hands the statement to a `FakeDb` which records the string and never runs it.
// A string is not a query, and asserting one proves the query was composed, never that it works.
//
// The shape is an off-by-one from inserting a positional parameter: `author` was added later, took
// `$9`, pushed the timestamp to `$10`, and the two references below were not moved.
//
// ═══ WHY IT EXECUTES AGAINST A REAL DATABASE ═══
//
// Nothing cheaper would have caught it. Type deduction across a CTE is a property of Postgres, not
// of the string, and a fake cannot have an opinion about it. So this connects, creates the real
// tables, prepares the real statement and runs it.
//
// SKIPPED, NOT FAILED, without a database. Most machines and most CI jobs have none, and a test that
// goes red on absence is a test somebody deletes — taking the only real check with it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { submitVersionSql } from "../src/deliverables.pg";

/**
 * `MYCEL_TEST_DATABASE_URL` is this repo's name for "a throwaway Postgres you may create tables in"
 * — `postgres.test.ts`, `multi-instance.test.ts` and the rest of the live tier all read it. Using a
 * different variable would mean this guard silently never runs wherever those do, which for a test
 * written to catch a production-only bug is the worst possible failure.
 */
const URL_ = process.env.MYCEL_TEST_DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

/** The columns the statement touches. Kept here so the test owns its own fixture. */
const SCHEMA = `
  DROP SCHEMA IF EXISTS mycel_sql_probe CASCADE;
  CREATE SCHEMA mycel_sql_probe;
  SET search_path = mycel_sql_probe;
  CREATE TABLE deliverables (
    id text PRIMARY KEY, project_id text, status text, current_version int, updated_at timestamptz);
  CREATE TABLE deliverable_versions (
    id text PRIMARY KEY, project_id text, deliverable_id text REFERENCES deliverables(id),
    version integer, summary text, artifact_ids text[], author text, url text, task_id text,
    review jsonb, edits jsonb, human_hours numeric, released_at timestamptz, change_request text, change_requested_at timestamptz,
    accepted_at timestamptz, accepted_note text, superseded_at timestamptz, created_at timestamptz);
`;

test("submitVersionSql actually runs on Postgres", async (t) => {
  if (!URL_) return t.skip("set MYCEL_TEST_DATABASE_URL to run the executing check");

  const { Client } = (await import("pg")) as typeof import("pg");
  const db = new Client({ connectionString: URL_ });
  await db.connect();
  try {
    await db.query(SCHEMA);
    // On the CONNECTION, not prefixed onto each query: a parameterised statement may carry exactly
    // one command, and `SET …; SELECT …` is two.
    await db.query(`SET search_path = mycel_sql_probe`);
    await db.query(`INSERT INTO deliverables VALUES ('d1','p1','drafting',0,now())`);

    const { sql, vals } = submitVersionSql({
      project_id: "p1",
      deliverable_id: "d1",
      allowedFrom: ["drafting", "changes_requested"],
      // `author` is the parameter that caused it. A null would have passed the broken statement.
      version: {
        summary: "August close",
        artifact_ids: ["a1"],
        author: "agent",
        review: { reviewed: true, at: "2026-01-03T00:00:00Z", verdict: { scores: [], headline: "Reads as finished.", overall: 88, serious: [], note: "" } },
      } as never,
      at: "2026-01-03T00:00:00Z",
      new_id: "v1",
    });

    const first = await db.query(sql, vals as unknown[]);
    assert.ok(first.rows[0]?.version, "the insert returned no version row");

    // The second submit is what proves `superseded_at` got a TIMESTAMP and not the author string.
    const second = submitVersionSql({
      project_id: "p1",
      deliverable_id: "d1",
      allowedFrom: ["in_review"],
      version: { summary: "revised", artifact_ids: ["a1"], author: "agent" } as never,
      at: "2026-01-04T00:00:00Z",
      new_id: "v2",
    });
    await db.query(second.sql, second.vals as unknown[]);

    const rows = await db.query(
      `SELECT id, author, superseded_at, review->'verdict'->>'overall' AS graded
         FROM deliverable_versions ORDER BY version`,
    );
    const [v1, v2] = rows.rows as { id: string; author: string; superseded_at: Date | null; graded: string | null }[];

    assert.equal(v1!.author, "agent", "the author was not stored");
    assert.ok(v1!.superseded_at instanceof Date, "superseded_at is not a timestamp — the $9/$10 bug is back");
    assert.equal(v2!.superseded_at, null, "the newest version was superseded by its own insert");

    // The verdict had no column at all until this was found: computed on every submit, discarded on
    // every Postgres write, and read back as undefined. No distribution could ever accumulate.
    assert.equal(v1!.graded, "88", "the review verdict did not round-trip");
  } finally {
    await db.query(`DROP SCHEMA IF EXISTS mycel_sql_probe CASCADE`).catch(() => {});
    await db.end();
  }
});

test("every parameter the statement references is supplied", () => {
  // The cheap half, and it runs everywhere. `$11` referenced with ten values is the same class of
  // mistake as `$9` referenced twice, and this catches it without a database.
  const { sql, vals } = submitVersionSql({
    project_id: "p1",
    deliverable_id: "d1",
    allowedFrom: ["drafting"],
    version: { summary: "s", artifact_ids: [] } as never,
    at: "2026-01-03T00:00:00Z",
    new_id: "v1",
  });
  const highest = Math.max(...[...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
  assert.equal(
    highest,
    vals.length,
    `the statement references $${highest} but ${vals.length} values are passed`,
  );
});
