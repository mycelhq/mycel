// The SQL a written service is stored and read with, verified without a Postgres.
//
// Same seam and same reasoning as requests-pg.test.ts: there is no database in this environment, and
// tenancy is exactly the part worth verifying anyway. A fake `Queryable` records every statement, so
// the properties that matter — the tenant is in the WHERE, the status guard is in the UPDATE — are
// assertions about the string rather than about a round trip.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PostgresAuthoredStore, buildAuthoredListQuery, rowToAuthored, type Queryable } from "../src/authored.pg";
import { authoredSlug } from "../src/wedge";
import type { WedgeManifest } from "../src/wedge";

function fake(rows: any[] = []): Queryable & { calls: Array<{ sql: string; values?: unknown[] }> } {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  return {
    calls,
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      return { rows, rowCount: rows.length };
    },
  };
}

const SLUG = authoredSlug("proposals");

test("every read names the project in the WHERE clause, not in a check afterwards", async () => {
  // THE BUG: a post-read `if (row.project_id !== projectId)` is one early return away from being
  // skipped. A filter the row never escapes cannot be.
  const db = fake();
  const store = PostgresAuthoredStore._withQueryable(db);
  await store.getAuthored("p1", SLUG);
  assert.match(db.calls[0].sql, /WHERE project_id=\$1 AND slug=\$2/);
  assert.deepEqual(db.calls[0].values, ["p1", SLUG]);
});

test("a read with no project id reads nothing rather than everything", async () => {
  // THE BUG this repo has shipped twice: a scope that defaults. An empty project id must be the
  // empty set, never the unfiltered set.
  const db = fake([{ id: "x", project_id: "someone-else", slug: SLUG }]);
  const store = PostgresAuthoredStore._withQueryable(db);
  assert.equal(await store.getAuthored("", SLUG), undefined);
  assert.equal(db.calls.length, 0, "it must not even reach the database");
  await assert.rejects(() => store.listAuthored({ project_id: "" }), /project_id/);
});

test("the list query scopes to one project and clamps the limit", () => {
  // THE BUG: `limit=0` read as "no limit" turns one tenant's list route into a full table scan.
  assert.deepEqual(buildAuthoredListQuery({ project_id: "p1" }).values[0], "p1");
  assert.match(buildAuthoredListQuery({ project_id: "p1" }).sql, /WHERE project_id = \$1/);
  assert.equal(buildAuthoredListQuery({ project_id: "p1", limit: 0 }).values.at(-1), 1);
  assert.equal(buildAuthoredListQuery({ project_id: "p1", limit: 99999 }).values.at(-1), 500);
  const withStatus = buildAuthoredListQuery({ project_id: "p1", status: "promoted" });
  assert.deepEqual(withStatus.values.slice(0, 2), ["p1", "promoted"]);
});

test("promotion is a single statement guarded on the current status", async () => {
  // THE BUG: read-check-write. Two tabs both read `drafted`, both write `promoted`, and the audit
  // trail records whoever landed second — so nobody can say who agreed to let it email their
  // clients. The guard has to be inside the UPDATE.
  const db = fake();
  const store = PostgresAuthoredStore._withQueryable(db);
  await store.decide("p1", SLUG, "promoted", "member-7");
  assert.match(db.calls[0].sql, /UPDATE authored_wedges/);
  assert.match(db.calls[0].sql, /WHERE project_id=\$1 AND slug=\$2 AND status='drafted'/);
  assert.deepEqual(db.calls[0].values, ["p1", SLUG, "promoted", "member-7"]);
});

test("re-drafting cannot rewrite a service somebody already agreed to run", async () => {
  // THE BUG: a founder clicks "try again" and the definition of something already carrying live
  // engagements is silently replaced underneath them. The conflict clause declines rather than
  // overwriting, which is why the insert carries its own status guard.
  const db = fake([{ id: "x", project_id: "p1", slug: SLUG, title: "T", manifest: {}, status: "drafted" }]);
  const store = PostgresAuthoredStore._withQueryable(db);
  await store.createDraft({
    project_id: "p1",
    slug: SLUG,
    title: "T",
    manifest: { wedge: SLUG } as WedgeManifest,
    skills: [],
    knowledge: [],
    described_as: "",
  });
  assert.match(db.calls[0].sql, /ON CONFLICT \(project_id, slug\) DO UPDATE/);
  assert.match(db.calls[0].sql, /WHERE authored_wedges\.status = 'drafted'/);
});

test("the store refuses to file a row under a slug that hides what it is", async () => {
  // THE BUG: an authored definition stored under a plain slug is back inside `loadWedge`'s reach,
  // and the lexical tenancy guarantee in wedge.ts is undone by one row.
  const store = PostgresAuthoredStore._withQueryable(fake());
  await assert.rejects(
    () =>
      store.createDraft({
        project_id: "p1",
        slug: "proposals",
        title: "T",
        manifest: {} as WedgeManifest,
        skills: [],
        knowledge: [],
        described_as: "",
      }),
    /authored slug/,
  );
});

test("an unreadable stored definition becomes a service that declares nothing, not a 500", () => {
  // THE BUG: a row written by an older shape, or by hand, throws on read and takes the tenant's
  // whole services list down. An empty manifest declares no jobs, so nothing can be spawned against
  // it — the fail-closed direction — and the page still renders.
  const row = rowToAuthored({ id: "x", project_id: "p1", slug: SLUG, title: "T", manifest: "{not json", status: "promoted" });
  assert.equal(row.manifest.task_types, undefined);
  assert.equal(row.manifest.wedge, SLUG);
  assert.deepEqual(row.skills, []);
});

test("a row that forgot to say its status reads as a draft", () => {
  // THE BUG: a future writer that omits `status` produces a service nobody agreed to that is
  // nonetheless loadable. The column default and this mapper both answer `drafted` — the direction
  // where a mistake costs a click rather than a client email.
  assert.equal(rowToAuthored({ id: "x", project_id: "p", slug: SLUG, manifest: {} }).status, "drafted");
});
