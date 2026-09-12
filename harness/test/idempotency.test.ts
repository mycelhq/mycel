// THE SAME REQUEST, SENT TWICE, MUST NOT BE TWO JOBS.
//
// `POST /v1/tasks` honoured `Idempotency-Key` through a process-local `Map`, and the comment above
// it admitted the hole: "In-process for now (single-instance); back with the store for
// multi-instance." We run several replicas. A caller whose POST timed out at the proxy retries, the
// retry lands on a different kernel, that kernel has never heard of the key, and a second task is
// created — a second sandbox, a second run, and for a `chase_invoice` a second email to somebody's
// client. The caller cannot detect it, because their retry succeeded.
//
// `kortix-ai/suna` state the principle in `apps/api/src/projects/session-lifecycle/requeue-policy.ts`:
// "retryability is a property of WHO OWNS THE OUTCOME, not of the error", and record the same
// outcome when both owners act — "Two billed sandboxes execute the baked initial_prompt."
//
// It was not atomic on ONE replica either: `has()`, then `await store.getTask()`, then `set()` much
// later. Two concurrent requests both pass the check inside that await.
import test from "node:test";
import assert from "node:assert/strict";
import { api, makeApp } from "./helpers";
import { InMemoryGrantStore } from "../src/store";

function taskBody() {
  /*
    A REAL INVOICE ID, because input contracts are enforced at creation now. `chase_invoice`
    requires one, and `dunning.ts`'s own header says why: a chase run with "no invoice id, no
    amount, no due date" is "an agent handed nothing to chase and every opportunity to invent
    something". This fixture was that exact shape, standing in for any task type.
  */
  return JSON.stringify({
    wedge: "invoice-chaser",
    task_type: "chase_invoice",
    input: { invoice_id: "inv_idempotency_fixture" },
  });
}

test("idempotency: a repeated key returns the FIRST task, not a second one", async () => {
  const { app } = makeApp();
  const key = `k-${Date.now()}-${Math.round(performance.now())}`;
  const h = { "idempotency-key": key };

  const first = await api(app, "tasks", { method: "POST", body: taskBody(), headers: h });
  assert.ok(first.status === 201 || first.status === 200, first.text);
  const id = first.json.id as string;
  assert.ok(id);

  const second = await api(app, "tasks", { method: "POST", body: taskBody(), headers: h });
  assert.equal(second.status, 200, `a replay should be a replay, got ${second.status} ${second.text}`);
  assert.equal(second.json.id, id, "the same key must not produce a second job");
});

test("idempotency: a DIFFERENT key is a different job", async () => {
  const { app } = makeApp();
  const a = await api(app, "tasks", {
    method: "POST",
    body: taskBody(),
    headers: { "idempotency-key": `a-${Date.now()}` },
  });
  const b = await api(app, "tasks", {
    method: "POST",
    body: taskBody(),
    headers: { "idempotency-key": `b-${Date.now()}` },
  });
  assert.notEqual(a.json.id, b.json.id, "the guard must not collapse genuinely distinct requests");
});

test("idempotency: no key at all still works, and does not dedupe", async () => {
  // The overwhelming majority of callers send none. They must be unaffected — a guard that quietly
  // deduped keyless requests would collapse two legitimate chases into one.
  const { app } = makeApp();
  const a = await api(app, "tasks", { method: "POST", body: taskBody() });
  const b = await api(app, "tasks", { method: "POST", body: taskBody() });
  assert.ok(a.json.id && b.json.id);
  assert.notEqual(a.json.id, b.json.id);
});

// ─── The claim itself, which is where the atomicity lives ─────────────────────────────────────

test("putIfAbsent: the second caller loses and reads the winner's payload", async () => {
  const g = new InMemoryGrantStore();
  const exp = new Date(Date.now() + 60_000);

  const won = await g.putIfAbsent("idem", "n1", { task_id: "t-1" }, exp);
  assert.equal(won, undefined, "an unclaimed key is taken, and taking it reports nothing");

  const lost = await g.putIfAbsent("idem", "n1", { task_id: "t-2" }, exp);
  // Returning the EXISTING payload rather than a boolean is what lets the loser answer with the
  // winner's result instead of an error.
  assert.deepEqual(lost, { task_id: "t-1" }, "the loser must see the winner's task, not its own");
  assert.deepEqual(await g.get("idem", "n1"), { task_id: "t-1" }, "and must not have overwritten it");
});

test("putIfAbsent: an EXPIRED claim is not a claim", async () => {
  const g = new InMemoryGrantStore();
  await g.putIfAbsent("idem", "n2", { task_id: "old" }, new Date(Date.now() - 1));

  // A key that outlived its window must not block a genuinely new request for ever. Same rule `get`
  // applies when it refuses to return an expired grant.
  const won = await g.putIfAbsent("idem", "n2", { task_id: "new" }, new Date(Date.now() + 60_000));
  assert.equal(won, undefined, "an expired row is taken over, not treated as a conflict");
  assert.deepEqual(await g.get("idem", "n2"), { task_id: "new" });
});

test("putIfAbsent: namespaces do not collide", async () => {
  // `idem` shares a table with live capabilities. A claim resolving as a proxy grant, or the
  // reverse, is the failure `GrantKind` exists to prevent.
  const g = new InMemoryGrantStore();
  const exp = new Date(Date.now() + 60_000);
  await g.putIfAbsent("idem", "same", { task_id: "t" }, exp);
  assert.equal(await g.putIfAbsent("action", "same", { task_id: "other" }, exp), undefined);
  assert.deepEqual(await g.get("idem", "same"), { task_id: "t" });
});
