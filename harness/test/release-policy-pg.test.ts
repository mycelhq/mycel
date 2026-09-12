// Deriving the track record from the rows that already describe it, so the policy and the history
// cannot disagree — they are the same rows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readRecord, markAutoReleased, wasAutoReleased } from "../src/release-policy.pg";

function db(rows: any[]) {
  const seen: { sql: string; args: any[] }[] = [];
  return {
    seen,
    query: async (sql: string, args: any[] = []) => {
      seen.push({ sql, args });
      if (/SELECT auto_released/i.test(sql)) return { rows: [{ auto_released: true }], rowCount: 1 };
      if (/^UPDATE/i.test(sql)) return { rows: [], rowCount: 1 };
      return { rows, rowCount: rows.length };
    },
  };
}
const A = { project_id: "p1", client_id: "c1", wedge: "books-keeper" };

test("one version accepted is a CLEAN accept; more than one is not", async () => {
  const r = await readRecord(db([
    { status: "accepted", auto_released: false, versions: 1 },
    { status: "accepted", auto_released: false, versions: 3 },
  ]), A);
  assert.deepEqual(r.outcomes, ["clean_accept", "accept_after_changes"]);
});

test("changes on auto-released work is recorded differently from changes on reviewed work", async () => {
  const r = await readRecord(db([
    { status: "changes_requested", auto_released: true, versions: 1 },
    { status: "changes_requested", auto_released: false, versions: 1 },
  ]), A);
  assert.deepEqual(r.outcomes, ["auto_released_then_changes", "changes_requested"]);
});

test("UNRESOLVED WORK IS SKIPPED, not counted as a failure", async () => {
  // A deliverable sitting in review is not evidence yet. Counting it against the pairing would mean
  // a business that delivers faster than its clients answer can never earn the gate.
  const q = db([]);
  await readRecord(q, A);
  assert.match(q.seen[0]!.sql, /status IN \('accepted', 'changes_requested'\)/);
});

test("it filters on the pairing — project, client AND wedge", async () => {
  const q = db([]);
  await readRecord(q, A);
  assert.deepEqual(q.seen[0]!.args, ["p1", "c1", "books-keeper"]);
  assert.match(q.seen[0]!.sql, /JOIN public\.cases k ON k\.id::text = d\.case_id/);
  assert.match(q.seen[0]!.sql, /k\.wedge\s+= \$3/);
});

test("newest first, and bounded", async () => {
  const q = db([]);
  await readRecord(q, A);
  assert.match(q.seen[0]!.sql, /ORDER BY d\.created_at DESC/);
  assert.match(q.seen[0]!.sql, /LIMIT 50/);
});

test("a pairing with no history reads as empty rather than throwing", async () => {
  assert.deepEqual((await readRecord(db([]), A)).outcomes, []);
  assert.deepEqual((await readRecord(db([]), { ...A, client_id: "" })).outcomes, []);
});

test("marking and reading the auto-release flag", async () => {
  const q = db([]);
  await markAutoReleased(q, "d1");
  assert.match(q.seen[0]!.sql, /SET auto_released = true/);
  assert.equal(await wasAutoReleased(db([]), "d1"), true);
});
