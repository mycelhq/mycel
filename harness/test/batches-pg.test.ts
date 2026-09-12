// The stall this exists for: the first fan-out to get through the ALB spawned twelve children,
// sixteen runs succeeded, and the parent sat in `awaiting_batch` for two hours — because the batch
// lived in a Map that died with the process that made it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PgBatchStore } from "../src/batches.pg";
import type { Task } from "../src/contract";

/** A tiny in-process stand-in for Postgres: enough SQL shape to exercise the store's logic. */
function fakeDb() {
  const rows: any[] = [];
  return {
    rows,
    async query(text: string, values: any[] = []) {
      if (/INSERT INTO public\.batches/i.test(text)) {
        const row = {
          id: values[9], project_id: values[0], parent_task_id: values[1], wedge: values[2],
          case_id: values[3], client_id: values[4], status: values[5], join_mode: values[6],
          quorum: values[7], child_task_ids: values[8], aggregate: null,
          created_at: new Date(), updated_at: new Date(), joined_at: null,
        };
        rows.push(row);
        return { rows: [row], rowCount: 1 };
      }
      if (/SELECT \* FROM public\.batches WHERE id/i.test(text)) {
        const r = rows.find((x) => x.id === values[0]);
        return { rows: r ? [r] : [], rowCount: r ? 1 : 0 };
      }
      if (/UPDATE public\.batches[\s\S]*array_append/i.test(text)) {
        const r = rows.find((x) => x.id === values[0]);
        if (!r) return { rows: [], rowCount: 0 };
        if (!r.child_task_ids.includes(values[1])) r.child_task_ids.push(values[1]);
        return { rows: [r], rowCount: 1 };
      }
      if (/UPDATE public\.batches[\s\S]*SET status/i.test(text)) {
        // The compare-and-set: only an `open` row is updated.
        const r = rows.find((x) => x.id === values[0] && x.status === "open");
        if (!r) return { rows: [], rowCount: 0 };
        r.status = values[1];
        r.aggregate = JSON.parse(values[2]);
        r.joined_at = new Date();
        return { rows: [r], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

const kid = (id: string, status: string, out?: unknown): Task =>
  ({ id, status, input: out === undefined ? {} : { __batch_output: out } }) as unknown as Task;

const make = async (store: PgBatchStore, join: "all" | "quorum" = "all", quorum?: number) =>
  store.createBatch({ project_id: "p1", parent_task_id: "parent1", wedge: "geo-monitor", join, quorum });

test("a batch survives as a row, not as a Map entry", async () => {
  const db = fakeDb();
  const store = PgBatchStore._withQueryable(db);
  const b = await make(store);
  assert.equal(db.rows.length, 1, "the batch is a durable row");
  assert.equal((await store.getBatch(b.id))?.parent_task_id, "parent1");
});

test("a batch with no parent is refused — a row nothing can ever join", async () => {
  const store = PgBatchStore._withQueryable(fakeDb());
  await assert.rejects(() => store.createBatch({ project_id: "p1", parent_task_id: "", wedge: "w", join: "all" }));
  await assert.rejects(() => store.createBatch({ project_id: "", parent_task_id: "t", wedge: "w", join: "all" }));
  await assert.rejects(() =>
    store.createBatch({ project_id: "p", parent_task_id: "t", wedge: "w", join: "quorum" }),
  );
});

test("addChild is append-only, so two children registering at once both land", async () => {
  const store = PgBatchStore._withQueryable(fakeDb());
  const b = await make(store);
  await store.addChild(b.id, "c1");
  await store.addChild(b.id, "c2");
  await store.addChild(b.id, "c1"); // idempotent
  assert.deepEqual((await store.getBatch(b.id))?.child_task_ids, ["c1", "c2"]);
});

test("it will NOT join on a partial set — four of twelve probes is not a report", async () => {
  const store = PgBatchStore._withQueryable(fakeDb());
  const b = await make(store);
  for (const id of ["c1", "c2", "c3"]) await store.addChild(b.id, id);
  const got = await store.tryJoin(b.id, [kid("c1", "succeeded"), kid("c2", "succeeded")]);
  assert.equal(got?.status, "open", "two of three loaded — do not join");
});

test("it waits for every child to be terminal, then joins with the aggregate", async () => {
  const store = PgBatchStore._withQueryable(fakeDb());
  const b = await make(store);
  for (const id of ["c1", "c2"]) await store.addChild(b.id, id);

  assert.equal((await store.tryJoin(b.id, [kid("c1", "succeeded"), kid("c2", "running")]))?.status, "open");

  const joined = await store.tryJoin(b.id, [kid("c1", "succeeded", { cited: ["a"] }), kid("c2", "failed")]);
  assert.equal(joined?.status, "succeeded", "any success means the batch succeeded");
  assert.equal(joined?.aggregate?.succeeded, 1);
  assert.equal(joined?.aggregate?.failed, 1);
  assert.deepEqual(joined?.aggregate?.outputs, [{ cited: ["a"] }]);
});

test("`rejected` and `expired` are terminal too — a join that waits for them waits for ever", async () => {
  const store = PgBatchStore._withQueryable(fakeDb());
  const b = await make(store);
  for (const id of ["c1", "c2"]) await store.addChild(b.id, id);
  const joined = await store.tryJoin(b.id, [kid("c1", "succeeded"), kid("c2", "expired")]);
  assert.equal(joined?.status, "succeeded");
  assert.equal(joined?.aggregate?.failed, 1);
});

test("nothing succeeded means the batch failed", async () => {
  const store = PgBatchStore._withQueryable(fakeDb());
  const b = await make(store);
  await store.addChild(b.id, "c1");
  assert.equal((await store.tryJoin(b.id, [kid("c1", "failed")]))?.status, "failed");
});

test("quorum joins early, without waiting for the stragglers", async () => {
  const store = PgBatchStore._withQueryable(fakeDb());
  const b = await make(store, "quorum", 2);
  for (const id of ["c1", "c2", "c3"]) await store.addChild(b.id, id);
  const joined = await store.tryJoin(b.id, [kid("c1", "succeeded"), kid("c2", "succeeded"), kid("c3", "running")]);
  assert.equal(joined?.status, "succeeded");
});

test("TWO CHILDREN FINISHING AT ONCE JOIN THE PARENT ONCE", async () => {
  // Without the compare-and-set both callers join, the parent resumes twice, and one week's work
  // becomes two deliverables.
  const store = PgBatchStore._withQueryable(fakeDb());
  const b = await make(store);
  for (const id of ["c1", "c2"]) await store.addChild(b.id, id);
  const kids = [kid("c1", "succeeded", 1), kid("c2", "succeeded", 2)];

  const [a, z] = await Promise.all([store.tryJoin(b.id, kids), store.tryJoin(b.id, kids)]);
  assert.equal(a?.status, "succeeded");
  assert.equal(z?.status, "succeeded");
  assert.equal(a?.joined_at, z?.joined_at, "both callers see the SAME join, not two");
});

test("a joined batch is idempotent — a late child does not re-join it", async () => {
  const store = PgBatchStore._withQueryable(fakeDb());
  const b = await make(store);
  await store.addChild(b.id, "c1");
  const first = await store.tryJoin(b.id, [kid("c1", "succeeded")]);
  const again = await store.tryJoin(b.id, [kid("c1", "succeeded")]);
  assert.equal(again?.joined_at, first?.joined_at);
});
