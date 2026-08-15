// What the Postgres knowledge store can be held to WITHOUT a database.
//
// Same approach as billing-pg.test.ts: the store is driven against a fake `Queryable` and the
// assertions are about the SQL it emits. The two properties that matter here are that EVERY
// statement carries `project_id` — rules are a description of how one specific business judges
// things, so a leak is the worst kind this system has — and that the two counters are incremented
// in SQL, because they are written on human decisions that can land together.
//
// Not provable here: that Postgres accepts the DDL, that the partial-unique/ANY casts behave, and
// that concurrent increments really do serialise. That needs MYCEL_TEST_DATABASE_URL.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PostgresKnowledgeStore,
  RULE_COLUMNS,
  observationWhere,
  rowToObservation,
  rowToRule,
  rulePatchSql,
  ruleValues,
  ruleWhere,
} from "../src/knowledge.pg";
import { toRow } from "../src/knowledge.store";
import type { Queryable } from "../src/billing.pg";
import type { NewRule, Rule } from "../src/knowledge";

interface Call {
  sql: string;
  vals: unknown[];
}

class FakeDb implements Queryable {
  calls: Call[] = [];
  constructor(private respond: (c: Call) => any[] = () => []) {}
  async query(sql: string, values: unknown[] = []) {
    const call = { sql, vals: values };
    this.calls.push(call);
    const rows = this.respond(call);
    return { rows, rowCount: rows.length };
  }
  get sql(): string {
    return this.calls.map((c) => c.sql).join("\n---\n");
  }
}

const CANDIDATE: NewRule = {
  project_id: "proj-a",
  wedge: "bookkeeping",
  client_id: "cli-1",
  task_types: ["reply_to_lead"],
  subject: "send_email.subject",
  text: "Lead with the amount owed.",
  kind: "style",
  provenance: { source: "approval_edit", at: "2026-07-01T09:00:00.000Z", before: "a", after: "b" },
};

/** The row Postgres would hand back, built from the production insert path. */
function pgRuleRow(r: Rule): Record<string, unknown> {
  const vals = ruleValues(r);
  const row: Record<string, unknown> = {};
  RULE_COLUMNS.forEach((c, i) => (row[c] = vals[i]));
  row.task_types = JSON.parse(row.task_types as string); // jsonb comes back parsed
  row.provenance = JSON.parse(row.provenance as string);
  for (const c of ["created_at", "updated_at"]) row[c] = new Date(row[c] as string);
  return row;
}

test("knowledge.pg: a rule survives the insert path and comes back identical", async () => {
  const rule = toRow(CANDIDATE);
  const back = rowToRule(pgRuleRow(rule));
  assert.deepEqual(JSON.parse(JSON.stringify(back)), JSON.parse(JSON.stringify(rule)));
  // The counters `toRow` seeded must survive the round trip as numbers, not strings.
  assert.equal(back.corroborations, 1);
  assert.equal(back.corrections_since, 0);
  assert.equal(back.uses, 0);
  assert.equal(back.needs_review, false);
});

test("knowledge.pg: every statement is project-scoped", async () => {
  const rule = toRow(CANDIDATE);
  const obsRow = { id: "o1", project_id: "proj-a", wedge: "bookkeeping", task_type: "t", kind: "gap", at: new Date() };
  const db = new FakeDb((c) => [/observations/.test(c.sql) ? obsRow : pgRuleRow(rule)]);
  const store = PostgresKnowledgeStore._withQueryable(db);
  await store.putRule(CANDIDATE);
  await store.getRule(rule.id, "proj-a");
  await store.listRules("proj-a", { wedge: "bookkeeping" });
  await store.updateRule(rule.id, "proj-a", { status: "superseded" });
  await store.noteCorrectionOn("proj-a", "bookkeeping", "send_email.subject");
  await store.noteUses("proj-a", [rule.id]);
  await store.recordObservation({ project_id: "proj-a", wedge: "bookkeeping", task_type: "t", kind: "gap" });
  await store.listObservations("proj-a", {});

  assert.equal(db.calls.length, 8);
  for (const c of db.calls) {
    assert.ok(/project_id/.test(c.sql), `no tenant column in: ${c.sql}`);
    assert.ok(c.vals.includes("proj-a"), `the tenant is not bound in: ${c.sql}`);
  }
});

test("knowledge.pg: an empty project id reads nothing and writes nothing — no query at all", async () => {
  const db = new FakeDb(() => [{}]);
  const store = PostgresKnowledgeStore._withQueryable(db);
  assert.equal(await store.getRule("r1", ""), undefined);
  assert.deepEqual(await store.listRules(""), []);
  assert.equal(await store.updateRule("r1", "", { uses: 5 }), undefined);
  await store.noteCorrectionOn("", "w", "s");
  await store.noteUses("", ["r1"]);
  assert.deepEqual(await store.listObservations(""), []);
  assert.equal(db.calls.length, 0, "fail closed in JS as well as in SQL — an unscoped read never happens");
});

test("knowledge.pg: an id from another tenant simply misses", async () => {
  // The tenant predicate is in the same statement as the read/write, so there is no window where
  // the row is fetched and then checked in JS.
  const db = new FakeDb(() => []);
  const store = PostgresKnowledgeStore._withQueryable(db);
  assert.equal(await store.getRule("r-from-proj-b", "proj-a"), undefined);
  assert.match(db.calls[0].sql, /WHERE id=\$1 AND project_id=\$2/);
  assert.equal(await store.updateRule("r-from-proj-b", "proj-a", { text: "mine now" }), undefined);
  assert.match(db.calls[1].sql, /WHERE id=\$2 AND project_id=\$3/);
});

test("knowledge.pg: noteCorrectionOn increments in SQL, on active rules only", async () => {
  const db = new FakeDb(() => []);
  const store = PostgresKnowledgeStore._withQueryable(db);
  await store.noteCorrectionOn("proj-a", "bookkeeping", "send_email.subject");
  assert.equal(db.calls.length, 1, "one statement — two workers must not both read 3 and both write 4");
  assert.match(db.calls[0].sql, /corrections_since = corrections_since \+ 1/);
  assert.match(db.calls[0].sql, /status='active'/);
  assert.ok(!/SELECT/i.test(db.sql));
  // Not an edit to the rule: `updated_at` means "when was this rule last changed".
  assert.ok(!/updated_at/.test(db.calls[0].sql));
  assert.deepEqual(db.calls[0].vals, ["proj-a", "bookkeeping", "send_email.subject"]);
});

test("knowledge.pg: noteUses increments the whole batch in one statement", async () => {
  const db = new FakeDb(() => []);
  const store = PostgresKnowledgeStore._withQueryable(db);
  await store.noteUses("proj-a", ["r1", "r2", "r3"]);
  assert.equal(db.calls.length, 1);
  assert.match(db.calls[0].sql, /uses = uses \+ 1/);
  assert.match(db.calls[0].sql, /project_id=\$1 AND id = ANY\(\$2::text\[\]\)/);
  assert.deepEqual(db.calls[0].vals, ["proj-a", ["r1", "r2", "r3"]]);
});

test("knowledge.pg: an empty id list is not an unfiltered UPDATE", async () => {
  const db = new FakeDb(() => []);
  await PostgresKnowledgeStore._withQueryable(db).noteUses("proj-a", []);
  assert.equal(db.calls.length, 0, "every rule in the project would otherwise be bumped");
});

test("knowledge.pg: the rule filter binds, and treats an empty value as a value", async () => {
  assert.deepEqual(ruleWhere("p", {}), { clause: "WHERE project_id=$1", vals: ["p"] });
  assert.deepEqual(ruleWhere("p", { wedge: "w", status: "active", subject: "s", client_id: "c" }), {
    clause: "WHERE project_id=$1 AND wedge=$2 AND status=$3 AND subject=$4 AND client_id=$5",
    vals: ["p", "w", "active", "s", "c"],
  });
  // `!== undefined`, not truthiness: an empty client_id means "house rules", not "any client".
  assert.deepEqual(ruleWhere("p", { client_id: "" }), {
    clause: "WHERE project_id=$1 AND client_id=$2",
    vals: ["p", ""],
  });
  assert.equal(ruleWhere("p'; DROP TABLE rules; --", {}).clause, "WHERE project_id=$1");
});

test("knowledge.pg: the observation filter is inclusive on `since` and compares as a timestamp", async () => {
  const { clause, vals } = observationWhere("p", { wedge: "w", since: "2026-07-01T00:00:00.000Z" });
  assert.equal(clause, "WHERE project_id=$1 AND wedge=$2 AND at >= $3::timestamptz");
  assert.deepEqual(vals, ["p", "w", "2026-07-01T00:00:00.000Z"]);
  assert.equal(
    rowToObservation({ id: "o1", project_id: "p", wedge: "w", task_type: "t", kind: "gap", at: new Date("2026-07-01T00:00:00Z") }).at,
    "2026-07-01T00:00:00.000Z",
  );
});

test("knowledge.pg: the patch allowlist cannot move a rule between tenants or subjects", async () => {
  const patch = {
    text: "Say the amount first.",
    status: "superseded",
    // Not patchable. Re-homing a rule would make the tenant filter meaningless, and a rule whose
    // subject changed is a different rule — supersession, not an edit.
    project_id: "proj-b",
    wedge: "other",
    subject: "something_else",
    id: "r-other",
    "text=$1, project_id='proj-b' --": "injection",
  } as Record<string, unknown>;
  const { sets, vals } = rulePatchSql(patch as never);
  assert.deepEqual(sets, ["text=$1", "status=$2"]);
  assert.deepEqual(vals, ["Say the amount first.", "superseded"]);
  for (const forbidden of ["project_id", "wedge", "subject", "injection"]) {
    assert.ok(!sets.join(" ").includes(forbidden), `${forbidden} must not be patchable`);
  }
});

test("knowledge.pg: jsonb patches are serialised and cast", async () => {
  const { sets, vals } = rulePatchSql({ task_types: ["a", "b"], provenance: CANDIDATE.provenance });
  assert.deepEqual(sets, ["task_types=$1::jsonb", "provenance=$2::jsonb"]);
  assert.deepEqual(JSON.parse(vals[0] as string), ["a", "b"]);
});

test("knowledge.pg: an empty patch still stamps updated_at rather than emitting `SET  WHERE`", async () => {
  const rule = toRow(CANDIDATE);
  const db = new FakeDb(() => [pgRuleRow(rule)]);
  await PostgresKnowledgeStore._withQueryable(db).updateRule(rule.id, "proj-a", {});
  assert.match(db.calls[0].sql, /SET updated_at=now\(\)\s+WHERE/);
});

test("knowledge.pg: putRule upserts, and refuses to overwrite another tenant's rule", async () => {
  const db = new FakeDb(() => [pgRuleRow(toRow(CANDIDATE))]);
  await PostgresKnowledgeStore._withQueryable(db).putRule(CANDIDATE);
  assert.match(db.calls[0].sql, /ON CONFLICT \(id\) DO UPDATE SET/);
  assert.match(db.calls[0].sql, /WHERE rules\.project_id = EXCLUDED\.project_id/);
  assert.ok(!/created_at = EXCLUDED\.created_at/.test(db.calls[0].sql), "the original creation time is kept");

  // The conflict branch matched nothing: the id exists under another project. Refusing loudly beats
  // silently rewriting someone else's judgement, which is what the in-memory Map would do.
  const blocked = PostgresKnowledgeStore._withQueryable(new FakeDb(() => []));
  await assert.rejects(() => blocked.putRule(CANDIDATE), /different project/);
});
