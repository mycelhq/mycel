// The tenant filter on the two domain read paths that had none: listCases and queryRecords.
import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryDomainStore } from "../src/domain";

async function twoTenants() {
  const d = new InMemoryDomainStore();
  await d.createCase({ project_id: "A", wedge: "books-keeper", title: "A's books", stage: "open", status: "open", data: {} });
  await d.createCase({ project_id: "B", wedge: "books-keeper", title: "B's books", stage: "open", status: "open", data: {} });
  // A row from before project_id existed. It belongs to nobody, so it must answer to nobody.
  await d.createCase({ wedge: "books-keeper", title: "legacy", stage: "open", status: "open", data: {} });

  await d.upsertRecord({ project_id: "A", wedge: "books-keeper", collection: "tx", key: "1", data: { amount: 1 } });
  await d.upsertRecord({ project_id: "B", wedge: "books-keeper", collection: "tx", key: "1", data: { amount: 2 } });
  await d.upsertRecord({ wedge: "books-keeper", collection: "tx", key: "1", data: { amount: 3 } });
  return d;
}

test("listCases: a project sees only its own cases, and never an unscoped row", async () => {
  const d = await twoTenants();
  const a = await d.listCases({ project_id: "A" });
  assert.deepEqual(a.map((k) => k.title), ["A's books"]);
  assert.deepEqual((await d.listCases({ project_id: "B" })).map((k) => k.title), ["B's books"]);
  // Fail CLOSED: the legacy row with no project_id is in nobody's scope. `p && k.p && p !== k.p`
  // would have handed it to every tenant that asked.
  assert.equal((await d.listCases({ project_id: "A" })).some((k) => k.title === "legacy"), false);
  // No project asked for → unchanged behaviour, all three (the operator-wide read).
  assert.equal((await d.listCases()).length, 3);
  // A project that owns nothing gets nothing, not everything.
  assert.equal((await d.listCases({ project_id: "C" })).length, 0);
});

test("queryRecords/countRecords: same fail-closed tenant filter, and count agrees with rows", async () => {
  const d = await twoTenants();
  const q = { project_id: "A", wedge: "books-keeper", collection: "tx" };
  const rows = await d.queryRecords(q);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].data.amount, 1);
  // The count is what an agent is told the query matched — it must not span tenants either.
  assert.equal(await d.countRecords(q), 1);
  assert.equal(await d.countRecords({ project_id: "C", wedge: "books-keeper" }), 0);
  assert.equal(await d.countRecords({ wedge: "books-keeper" }), 3, "unscoped read is unchanged");
});
