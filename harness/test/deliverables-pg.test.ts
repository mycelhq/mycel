// What the Postgres deliverable store can be held to WITHOUT a database.
//
// There is no Postgres in this environment, and the four ways this class could break the loop are
// all visible in the SQL it emits: an unscoped list, a version number allocated by a read, a
// transition that checks before it writes, and a verdict recorded against a version the founder
// never released. So the store is driven against a fake `Queryable` that records every statement,
// and the assertions are about the statements themselves — one query, the guards in the WHERE.
//
// What this canNOT prove is that Postgres agrees: that the DDL is valid, that `status = ANY($3)`
// actually filters, and that `FOR UPDATE` actually serialises two concurrent submits. That needs a
// real database — see postgres.test.ts and the note in deliverables.pg.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PostgresDeliverableStore,
  listDeliverablesSql,
  releaseSql,
  rowToDeliverable,
  rowToVersion,
  settleSql,
  submitVersionSql,
  transitionSql,
  type Queryable,
} from "../src/deliverables.pg";
import { OPEN_DELIVERABLE_STATUSES } from "../src/deliverables";

interface Call {
  sql: string;
  vals: unknown[];
}

/** A `Queryable` that records what it was asked and answers with whatever the test decides. */
class FakeDb implements Queryable {
  calls: Call[] = [];
  constructor(private respond: (c: Call) => any[] = () => []) {}
  async query(sql: string, values: unknown[] = []) {
    const call = { sql, vals: values };
    this.calls.push(call);
    const rows = this.respond(call);
    return { rows, rowCount: rows.length };
  }
}

const ROW = {
  id: "d1",
  project_id: "p1",
  case_id: "c1",
  client_id: "cl1",
  title: "Q1 accounts",
  kind: "document",
  status: "with_client",
  current_version: 2,
  accepted_at: null,
  withdrawn_reason: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
};

// ── tenancy ──────────────────────────────────────────────────────────────────────────────────────

test("deliverables.pg: the tenant is in the WHERE clause of every read, and the limit is in SQL", () => {
  // THE BUG, and the mechanism behind one of the two cross-tenant leaks this repo has shipped: a
  // post-filtered list returns the wrong rows the moment a LIMIT truncates before the filter runs.
  const { sql, vals } = listDeliverablesSql({ project_id: "p1", client_id: "cl1", status: "accepted", limit: 10 });
  assert.match(sql, /WHERE project_id = \$1/, "the tenant is first and unconditional");
  assert.match(sql, /LIMIT 10/, "the limit is applied by the database, after the filter");
  assert.equal(vals[0], "p1");
  assert.ok(vals.includes("cl1") && vals.includes("accepted"));

  // Even with no other filter at all, the project is still pushed in.
  assert.match(listDeliverablesSql({ project_id: "p1" }).sql, /WHERE project_id = \$1/);
  // And `open` resolves from the state table rather than a second hand-written list of statuses.
  const open = listDeliverablesSql({ project_id: "p1", open: true });
  assert.deepEqual(open.vals[1], OPEN_DELIVERABLE_STATUSES);
  assert.equal(OPEN_DELIVERABLE_STATUSES.includes("accepted" as never), false);
});

test("deliverables.pg: a by-id read takes the project, so wrong-tenant and missing are one answer", async () => {
  const db = new FakeDb(() => []);
  const store = PostgresDeliverableStore._withQueryable(db);
  await store.getDeliverable("p1", "d1");
  assert.match(db.calls[0]!.sql, /WHERE id=\$1 AND project_id=\$2/);
  assert.deepEqual(db.calls[0]!.vals, ["d1", "p1"]);

  // A read with no project is a programming error, not a wide read.
  await assert.rejects(() => store.getDeliverable("", "d1"), /project_id/);
  await assert.rejects(() => store.listDeliverables({ project_id: "" } as any), /project_id/);
  await assert.rejects(() => store.listVersions("", "d1"), /project_id/);
});

test("deliverables.pg: versions carry their own project column and read on it", async () => {
  // THE BUG: authorising a version by joining to its parent. A read that needs a join to be safe is
  // a read somebody will one day write without the join.
  const db = new FakeDb(() => []);
  const store = PostgresDeliverableStore._withQueryable(db);
  await store.getVersion("p1", "d1", 2);
  assert.match(db.calls[0]!.sql, /WHERE project_id=\$1 AND deliverable_id=\$2 AND version=\$3/);
});

// ── exactly once ─────────────────────────────────────────────────────────────────────────────────

test("deliverables.pg: a version number is allocated inside the write, under a row lock", () => {
  // THE BUG: `max(version) + 1` read then inserted. Two retried runs revising the same deliverable
  // both read 2 and both write 3, and the client's portal shows two cards labelled "Version 3" with
  // different files in them.
  const { sql, vals } = submitVersionSql({
    project_id: "p1",
    deliverable_id: "d1",
    allowedFrom: ["drafting", "changes_requested"],
    version: { summary: "v2", artifact_ids: ["a1"] },
    at: "2026-01-03T00:00:00Z",
    new_id: "v-new",
  });
  assert.match(sql, /FOR UPDATE/, "the parent read is locked, so a second submit queues rather than races");
  assert.match(sql, /parent\.current_version \+ 1/, "the number comes from the locked read, not from a max()");
  assert.doesNotMatch(sql, /max\(/i, "and never from an aggregate over the version table");
  assert.match(sql, /status = ANY\(\$3\)/, "an illegal source status makes every branch of the CTE empty");
  assert.match(sql, /superseded_at = \$9/, "the outgoing version is stamped in the same statement");
  assert.match(sql, /SET status = 'in_review'/, "and so is the status move");
  assert.deepEqual(vals[2], ["drafting", "changes_requested"]);
  // One statement. Not three.
  assert.equal(sql.split(/;/).filter((p) => p.trim()).length, 1);
});

test("deliverables.pg: submitVersion refuses to report success on a half-applied CTE", async () => {
  // THE BUG this repo names in every header: something failing while reporting success. A shape
  // where the version came back but the parent update did not is precisely that, so BOTH columns
  // are checked rather than just the one the caller wanted.
  const store = PostgresDeliverableStore._withQueryable(
    new FakeDb(() => [{ deliverable: null, version: { ...ROW, deliverable_id: "d1", version: 3, artifact_ids: [] } }]),
  );
  const out = await store.submitVersion({
    project_id: "p1",
    deliverable_id: "d1",
    allowedFrom: ["drafting"],
    version: { summary: "x", artifact_ids: [] },
    at: "2026-01-03T00:00:00Z",
  });
  assert.equal(out, undefined);
});

test("deliverables.pg: a transition carries its allowlist in the WHERE, and never moves accepted_at", () => {
  // THE BUG: read-then-write. Two tabs — or one double-clicked button — both read `with_client` and
  // both write, so "accept" followed by "request changes" leaves the work accepted AND reopened.
  const { sql, vals } = transitionSql({
    project_id: "p1",
    id: "d1",
    to: "accepted",
    allowedFrom: ["with_client"],
    at: "2026-01-04T00:00:00Z",
    accepted_at: "2026-01-04T00:00:00Z",
  });
  assert.match(sql, /WHERE id = \$2 AND project_id = \$1 AND status = ANY\(\$7\)/);
  assert.match(
    sql,
    /accepted_at = COALESCE\(deliverables\.accepted_at, \$5\)/,
    "written once and never moved — an invoice may already rest on that date",
  );
  assert.deepEqual(vals[6], ["with_client"]);
  assert.equal(sql.split(/;/).filter((p) => p.trim()).length, 1);
});

// ── the founder's gate, at the write ─────────────────────────────────────────────────────────────

test("deliverables.pg: releasing twice cannot move the date the client was first shown something", () => {
  // THE BUG: a second approval click re-stamping `released_at`. That date is evidence.
  const { sql } = releaseSql({ project_id: "p1", deliverable_id: "d1", version: 1, at: "2026-01-05T00:00:00Z" });
  assert.match(sql, /released_at IS NULL/);
  assert.match(sql, /WHERE project_id = \$1 AND deliverable_id = \$2 AND version = \$3/);
});

test("deliverables.pg: a verdict cannot be recorded against an unreleased or already-settled version", () => {
  // THREE guards, three real failures: the cross-tenant write, the founder's gate held at the WRITE
  // as well as at the read (so no future route can route around it), and the double submit.
  const { sql, vals } = settleSql({
    project_id: "p1",
    deliverable_id: "d1",
    version: 2,
    at: "2026-01-06T00:00:00Z",
    verdict: { kind: "changes_requested", request: "bigger logo" },
  });
  assert.match(sql, /project_id = \$1/);
  assert.match(sql, /released_at IS NOT NULL/, "the founder's gate, enforced by the database");
  assert.match(sql, /accepted_at IS NULL/);
  assert.match(sql, /change_requested_at IS NULL/);
  assert.equal(vals[3], null, "a change request writes no acceptance");
  assert.equal(vals[5], "bigger logo");

  const accepted = settleSql({
    project_id: "p1",
    deliverable_id: "d1",
    version: 2,
    at: "2026-01-06T00:00:00Z",
    verdict: { kind: "accepted", note: "great" },
  });
  assert.equal(accepted.vals[3], "2026-01-06T00:00:00Z");
  assert.equal(accepted.vals[4], "great");
  assert.equal(accepted.vals[5], null, "and an acceptance writes no change request");
});

// ── row mapping ──────────────────────────────────────────────────────────────────────────────────

test("deliverables.pg: an unreadable kind or status is failed CLOSED on the way out", () => {
  // THE BUG: `kind` and `status` are plain `text` columns and can hold whatever a previous deploy or
  // a hand-run UPDATE left there. Handing an unrecognised string back typed as `DeliverableStatus`
  // pushes the lie into every caller — including the portal's "what may this client see" check.
  const bad = rowToDeliverable({ ...ROW, kind: "website", status: "shipped" });
  assert.equal(bad.kind, "document");
  assert.equal(
    bad.status,
    "drafting",
    "drafting is the state with NO client sentence, so a corrupt row is invisible to a client rather than presented as accepted work",
  );

  const good = rowToDeliverable(ROW);
  assert.equal(good.kind, "document");
  assert.equal(good.status, "with_client");
  assert.equal(good.current_version, 2, "and the integer arrives as a number, whatever the driver says");
  assert.equal(good.accepted_at, undefined, "null becomes absent, never the string 'null'");
});

test("deliverables.pg: a version with no artifact array maps to an empty one, not undefined", () => {
  // THE BUG: `artifact_ids.includes(...)` throwing inside the download authorisation, which fails
  // the request in a way that looks like a server fault rather than a refusal.
  const v = rowToVersion({
    id: "v1",
    project_id: "p1",
    deliverable_id: "d1",
    version: 1,
    summary: null,
    artifact_ids: null,
    created_at: "2026-01-01T00:00:00Z",
  });
  assert.deepEqual(v.artifact_ids, []);
  assert.equal(v.summary, "");
  assert.equal(v.released_at, undefined);
});
