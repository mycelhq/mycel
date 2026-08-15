// The SQL the Postgres request store emits, verified with no Postgres.
//
// There is no database in the test environment, and the failure modes this backend exists to
// prevent — an unscoped read, a read-then-write resolve — are both visible in the statements it
// sends. Same seam and same reasoning as test/billing-pg.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildListQuery, PostgresRequestStore, rowToRequest, type Queryable } from "../src/requests.pg";

/** Records every statement, answers with whatever the test queued. */
function fake(rows: any[][] = []): Queryable & { sql: string[]; values: unknown[][] } {
  const sql: string[] = [];
  const values: unknown[][] = [];
  return {
    sql,
    values,
    async query(q: string, v?: unknown[]) {
      sql.push(q);
      values.push(v ?? []);
      return { rows: rows.shift() ?? [], rowCount: 0 };
    },
  };
}

const ROW = {
  id: "r1", project_id: "p1", client_id: "c1", case_id: null, thread_id: "t1", task_id: null,
  kind: "document", ask: "March statement", detail: null, status: "open", due_at: null,
  response: null, resolved_at: null, created_at: "2024-01-01T00:00:00.000Z", updated_at: "2024-01-01T00:00:00.000Z",
};

test("requests.pg: project_id is structural in the list WHERE, never conditional", async () => {
  // THE BUG CLASS: a tenant predicate that is one optional argument away from being omitted. Here
  // it is `$1` and always present, so no arrangement of caller input produces a query without it.
  const bare = buildListQuery({ project_id: "p1" });
  assert.match(bare.sql, /WHERE project_id = \$1/);
  assert.equal(bare.values[0], "p1");

  const full = buildListQuery({ project_id: "p1", client_id: "c1", status: "open", limit: 5 });
  assert.match(full.sql, /WHERE project_id = \$1 AND client_id = \$2 AND status = \$3/);
  assert.deepEqual(full.values, ["p1", "c1", "open", 5]);

  // A limit a caller controls must not become a way to pull the whole table.
  assert.equal(buildListQuery({ project_id: "p1", limit: 100_000 }).values.at(-1), 500);
  assert.equal(buildListQuery({ project_id: "p1", limit: 0 }).values.at(-1), 1);
});

test("requests.pg: every by-id statement carries the tenant, and resolve is atomic", async () => {
  const db = fake([[ROW], [ROW], [ROW]]);
  const store = PostgresRequestStore._withQueryable(db);

  await store.getRequest("p1", "r1");
  assert.match(db.sql[0], /WHERE id=\$1 AND project_id=\$2/, "scoped in the WHERE, not checked afterwards");

  await store.resolveRequest("p1", "r1", "here you go");
  // THE GUARANTEE: `status='open'` is part of the WHERE, so two tabs answering the same request
  // cannot both spawn the run that was waiting.
  assert.match(db.sql[1], /WHERE id=\$1 AND project_id=\$2 AND status='open'/);
  assert.match(db.sql[1], /RETURNING \*/, "the loser gets no row, so the caller does nothing");

  await store.cancelRequest("p1", "r1");
  assert.match(db.sql[2], /WHERE id=\$1 AND project_id=\$2 AND status='open'/);
});

test("requests.pg: a request with no tenant is refused before it reaches the database", async () => {
  const db = fake();
  const store = PostgresRequestStore._withQueryable(db);
  await assert.rejects(() => store.createRequest({ project_id: "", client_id: "c1", kind: "answer", ask: "a" }), /project_id/);
  await assert.rejects(() => store.createRequest({ project_id: "p1", client_id: "", kind: "answer", ask: "a" }), /client_id/);
  assert.equal(db.sql.length, 0);
});

test("requests.pg: NULL columns map to undefined, not to null", async () => {
  // A `null` here reaches JSON as an explicit null, and the portal projection then renders "null"
  // where a client expects nothing. The contract says optional; the mapping has to agree.
  const row = rowToRequest(ROW);
  assert.equal(row.case_id, undefined);
  assert.equal(row.response, undefined);
  assert.equal(row.resolved_at, undefined);
  assert.equal(row.thread_id, "t1");
  assert.equal(row.created_at, "2024-01-01T00:00:00.000Z");
});
