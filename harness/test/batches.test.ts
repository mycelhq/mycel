import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  InMemoryBatchStore,
  _resetBatchStore,
  getBatchStore,
  onChildFinished,
  setBatchStore,
} from "../src/batches";
import type { Task } from "../src/contract";
import { api, makeApp, waitTask } from "./helpers";
import { registerActionGrant } from "../src/actiongrants";
import { InMemoryStore } from "../src/store";

function child(partial: Partial<Task> & Pick<Task, "id" | "status" | "batch_id">): Task {
  const at = new Date().toISOString();
  return {
    project_id: "p1",
    wedge: "books-keeper",
    task_type: "monthly_close",
    actor: { kind: "system", id: "t" },
    input: {},
    constraints: { max_runtime_s: 60, max_cost_usd: 1, approval_required: false },
    tools: [],
    cost_usd: 0,
    created_at: at,
    updated_at: at,
    ...partial,
  };
}

test("batches: join all succeeds when every child succeeds", async () => {
  _resetBatchStore();
  const store = new InMemoryStore();
  const batches = getBatchStore();
  const parentId = randomUUID();
  const batch = await batches.createBatch({
    project_id: "p1",
    parent_task_id: parentId,
    wedge: "books-keeper",
    join: "all",
  });
  await store.createTask(
    child({ id: parentId, status: "awaiting_batch", batch_id: batch.id, task_type: "monthly_close" }),
  );
  const c1 = child({ id: randomUUID(), status: "succeeded", batch_id: batch.id, input: { __batch_output: { n: 1 } } });
  const c2 = child({ id: randomUUID(), status: "succeeded", batch_id: batch.id, input: { __batch_output: { n: 2 } } });
  await store.createTask(c1);
  await store.createTask(c2);
  await batches.addChild(batch.id, c1.id);
  await batches.addChild(batch.id, c2.id);

  const joined = await onChildFinished(store, c2);
  assert.ok(joined);
  assert.equal(joined!.status, "succeeded");
  assert.equal(joined!.aggregate?.succeeded, 2);
  assert.deepEqual(joined!.aggregate?.outputs, [{ n: 1 }, { n: 2 }]);

  const parent = await store.getTask(parentId);
  assert.equal(parent?.status, "succeeded");
});

test("batches: parent carrying batch_id does not join as a child", async () => {
  _resetBatchStore();
  const store = new InMemoryStore();
  const batches = getBatchStore();
  const parentId = randomUUID();
  const batch = await batches.createBatch({
    project_id: "p1",
    parent_task_id: parentId,
    wedge: "books-keeper",
    join: "all",
  });
  const parent = child({ id: parentId, status: "awaiting_batch", batch_id: batch.id });
  await store.createTask(parent);
  const noop = await onChildFinished(store, parent);
  assert.equal(noop, undefined);
  assert.equal((await store.getTask(parentId))?.status, "awaiting_batch");
});

test("batches: quorum joins early once enough children succeed", async () => {
  setBatchStore(new InMemoryBatchStore());
  const store = new InMemoryStore();
  const batches = getBatchStore();
  const parentId = randomUUID();
  const batch = await batches.createBatch({
    project_id: "p1",
    parent_task_id: parentId,
    wedge: "books-keeper",
    join: "quorum",
    quorum: 1,
  });
  await store.createTask(child({ id: parentId, status: "awaiting_batch", batch_id: batch.id }));
  const ok = child({ id: randomUUID(), status: "succeeded", batch_id: batch.id, input: { __batch_output: "a" } });
  const pending = child({ id: randomUUID(), status: "running", batch_id: batch.id });
  await store.createTask(ok);
  await store.createTask(pending);
  await batches.addChild(batch.id, ok.id);
  await batches.addChild(batch.id, pending.id);

  const joined = await onChildFinished(store, ok);
  assert.equal(joined?.status, "succeeded");
  assert.equal(joined?.aggregate?.succeeded, 1);
  assert.equal((await store.getTask(parentId))?.status, "succeeded");
});

test("batches: agent opens a batch over the internal endpoint; children join the parent", async () => {
  _resetBatchStore();
  const { store, app } = makeApp();
  const kase = (await api(app, "cases", { method: "POST", body: JSON.stringify({ wedge: "books-keeper", title: "batch" }) })).json;
  // Parent must exist with a project, but must NOT finish before we open the batch — create via
  // store so it is not enqueued, then open the batch (which enqueues children only).
  const at = new Date().toISOString();
  const parentId = randomUUID();
  await store.createTask({
    id: parentId,
    project_id: kase.project_id,
    case_id: kase.id,
    wedge: "books-keeper",
    task_type: "monthly_close",
    actor: { kind: "system", id: "test" },
    input: {},
    constraints: { max_runtime_s: 120, max_cost_usd: 1, approval_required: false },
    tools: [],
    status: "running",
    cost_usd: 0,
    created_at: at,
    updated_at: at,
  });
  const nonce = await registerActionGrant({ task_id: parentId, connectionIds: [], caseId: kase.id });
  const H = { authorization: `Bearer ${nonce}`, "content-type": "application/json" };

  const res = await app.request("/v1/internal/batches", {
    method: "POST",
    headers: H,
    body: JSON.stringify({
      join: "all",
      children: [
        { task_type: "monthly_close", input: { period: "2026-01" } },
        { task_type: "monthly_close", input: { period: "2026-02" } },
      ],
    }),
  });
  assert.equal(res.status, 201, await res.clone().text());
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.child_task_ids.length, 2);
  assert.equal((await store.getTask(parentId))?.status, "awaiting_batch");
  assert.equal((await store.getTask(parentId))?.batch_id, body.batch.id);

  await waitTask(app, body.child_task_ids[0]);
  await waitTask(app, body.child_task_ids[1]);
  // Join is async in orchestrator finally — poll parent briefly.
  const start = Date.now();
  let parent = await store.getTask(parentId);
  while (parent && parent.status === "awaiting_batch" && Date.now() - start < 4000) {
    await new Promise((r) => setTimeout(r, 20));
    parent = await store.getTask(parentId);
  }
  assert.equal(parent?.status, "succeeded", `parent stuck as ${parent?.status}`);

  const listed = await api(app, "batches", {
    headers: { "x-mycel-project": kase.project_id },
  });
  assert.equal(listed.status, 200);
  assert.ok((listed.json as { id: string }[]).some((b) => b.id === body.batch.id));
});
