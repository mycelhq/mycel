import { test } from "node:test";
import assert from "node:assert/strict";
import { api, makeApp, waitTask } from "./helpers";
import { getDomainStore } from "../src/domain";
import { registerActionGrant } from "../src/actiongrants";

const WEDGE = "books-keeper"; // declares cases.stages: open → collecting → … → filed

test("cases: create with the wedge's initial stage, reject undeclared stages", async () => {
  const { app } = makeApp();

  assert.equal((await api(app, "cases", { method: "POST", body: JSON.stringify({ title: "no wedge" }) })).status, 400);
  assert.equal((await api(app, "cases", { method: "POST", body: JSON.stringify({ wedge: "ghost", title: "x" }) })).status, 400);
  assert.equal(
    (await api(app, "cases", { method: "POST", body: JSON.stringify({ wedge: WEDGE, title: "x", stage: "not-a-stage" }) })).status,
    400,
    "a stage the wedge doesn't declare is refused at the boundary",
  );

  const created = await api(app, "cases", { method: "POST", body: JSON.stringify({ wedge: WEDGE, title: "Acme — October close", data: { max_transactions: 300 } }) });
  assert.equal(created.status, 201);
  assert.equal(created.json.stage, "open", "took the wedge's initial stage");
  assert.equal(created.json.status, "open");
  assert.equal(created.json.history[0].kind, "created");
  assert.ok(created.json.project_id, "stamped with the tenant");
});

test("cases: stage transitions and data merges are recorded in history", async () => {
  const { app } = makeApp();
  const kase = (await api(app, "cases", { method: "POST", body: JSON.stringify({ wedge: WEDGE, title: "m", data: { a: 1 } }) })).json;

  const bad = await api(app, `cases/${kase.id}`, { method: "PUT", body: JSON.stringify({ stage: "nope" }) });
  assert.equal(bad.status, 400, "invalid transitions are refused");

  const moved = await api(app, `cases/${kase.id}`, { method: "PUT", body: JSON.stringify({ stage: "collecting", note: "period opened", data: { b: 2 } }) });
  assert.equal(moved.json.stage, "collecting");
  assert.deepEqual(moved.json.data, { a: 1, b: 2 }, "data merges — a partial update can't wipe state");
  const ev = moved.json.history.at(-1);
  assert.equal(ev.kind, "stage_changed");
  assert.equal(ev.from, "open");
  assert.equal(ev.to, "collecting");
  assert.equal(ev.note, "period opened");

  const closed = await api(app, `cases/${kase.id}`, { method: "PUT", body: JSON.stringify({ status: "closed", note: "done" }) });
  assert.equal(closed.json.status, "closed");
  assert.ok(closed.json.closed_at);
  assert.equal(closed.json.history.at(-1).kind, "closed");
});

test("cases: a task is an episode — inherits the case, runs, and shows on the case", async () => {
  const { app } = makeApp();
  const kase = (await api(app, "cases", { method: "POST", body: JSON.stringify({ wedge: WEDGE, title: "episode test", data: { period: "2026-10" } }) })).json;

  assert.equal(
    (await api(app, `cases/${kase.id}/tasks`, { method: "POST", body: JSON.stringify({ task_type: "bogus" }) })).status,
    400,
    "task_type still validated against the wedge",
  );

  const spawned = await api(app, `cases/${kase.id}/tasks`, { method: "POST", body: JSON.stringify({ task_type: "monthly_close", input: { period: "2026-10" } }) });
  assert.equal(spawned.status, 201);
  assert.equal(spawned.json.case_id, kase.id, "the task knows its case");
  assert.equal(spawned.json.wedge, WEDGE, "wedge inherited from the case");
  assert.deepEqual(spawned.json.input.case.data, { period: "2026-10" }, "case state is handed to the run");

  const done = await waitTask(app, spawned.json.id);
  assert.equal(done.status, "succeeded");

  const detail = await api(app, `cases/${kase.id}`);
  assert.equal(detail.json.tasks.length, 1, "the case lists its episodes");
  assert.ok(detail.json.stages.includes("collecting"), "the wedge's stage machine is exposed to UIs");
  assert.ok(detail.json.history.some((h: { kind: string }) => h.kind === "task_spawned"));

  // closed cases don't accept new episodes
  await api(app, `cases/${kase.id}`, { method: "PUT", body: JSON.stringify({ status: "closed" }) });
  assert.equal((await api(app, `cases/${kase.id}/tasks`, { method: "POST", body: JSON.stringify({ task_type: "monthly_close" }) })).status, 409);
});

test("cases: the agent can read and advance its own case, scoped to its run", async () => {
  const { app } = makeApp();
  const domain = getDomainStore();
  const kase = (await api(app, "cases", { method: "POST", body: JSON.stringify({ wedge: WEDGE, title: "agent test" }) })).json;
  const spawned = (await api(app, `cases/${kase.id}/tasks`, { method: "POST", body: JSON.stringify({ task_type: "monthly_close" }) })).json;

  const nonce = await registerActionGrant({ task_id: spawned.id, connectionIds: [], caseId: kase.id });
  const H = { authorization: `Bearer ${nonce}`, "content-type": "application/json" };

  const read = await (await app.request("/v1/internal/case", { headers: H })).json();
  assert.equal(read.ok, true);
  assert.equal(read.case.id, kase.id);
  assert.ok(read.case.stages.length, "the agent is told which stages exist");

  const upd = await (await app.request("/v1/internal/case/update", { method: "POST", headers: H, body: JSON.stringify({ stage: "collecting", data: { receipts_missing: 3 }, note: "3 receipts outstanding" }) })).json();
  assert.equal(upd.ok, true);
  assert.equal(upd.case.stage, "collecting");
  assert.deepEqual(upd.case.data, { receipts_missing: 3 });
  assert.equal(upd.case.history.at(-1).actor, "agent", "attributed to the agent, not a member");

  // the agent cannot invent a stage
  const badStage = await (await app.request("/v1/internal/case/update", { method: "POST", headers: H, body: JSON.stringify({ stage: "invented" }) })).json();
  assert.equal(badStage.ok, false);

  // and an unauthenticated caller gets nothing
  assert.equal((await app.request("/v1/internal/case", { headers: { authorization: "Bearer nope" } })).status, 401);

  // a run with no case says so rather than leaking someone else's
  const orphan = await registerActionGrant({ task_id: spawned.id, connectionIds: [] });
  assert.equal((await app.request("/v1/internal/case", { headers: { authorization: `Bearer ${orphan}` } })).status, 404);

  await domain.listCases({ project_id: "p1" }); // sanity: store still healthy
});

test("cases: list filters by wedge, status and stage", async () => {
  const { app } = makeApp();
  // The domain store is a process singleton, so other tests in this file have already created
  // cases. Assert on deltas rather than absolute counts.
  const before = {
    all: (await api(app, "cases")).json.length,
    chaser: (await api(app, "cases?wedge=invoice-chaser")).json.length,
    closed: (await api(app, "cases?status=closed")).json.length,
  };

  const a = (await api(app, "cases", { method: "POST", body: JSON.stringify({ wedge: WEDGE, title: "filter-a" }) })).json;
  await api(app, "cases", { method: "POST", body: JSON.stringify({ wedge: "invoice-chaser", title: "filter-b" }) });
  await api(app, `cases/${a.id}`, { method: "PUT", body: JSON.stringify({ stage: "reconciling" }) });

  assert.equal((await api(app, "cases")).json.length, before.all + 2);
  assert.equal((await api(app, "cases?wedge=invoice-chaser")).json.length, before.chaser + 1, "filters by wedge");
  const reconciling = (await api(app, "cases?stage=reconciling")).json;
  assert.deepEqual(reconciling.map((k: { id: string }) => k.id), [a.id], "filters by stage");
  assert.equal((await api(app, "cases?status=closed")).json.length, before.closed, "filters by status");

  // a case in one wedge is never returned when filtering by another
  assert.ok(!(await api(app, `cases?wedge=${WEDGE}`)).json.some((k: { title: string }) => k.title === "filter-b"));
});

/**
 * The conversion: a prospect's case gets a client after the fact.
 *
 * A case for a prospect is opened before the client exists — that is what a prospect is — so
 * `client_id` being write-once-at-create severed outbound from delivery entirely. Nothing could
 * mark a won deal, so `won` was a stage nothing read and delivered artifacts appeared under no
 * customer. This is the join, and the three rules that keep it from being a hole.
 */
test("cases: a case can be linked to a client after it was opened, once", async () => {
  const { app } = makeApp();
  const kase = (await api(app, "cases", { method: "POST", body: JSON.stringify({ wedge: WEDGE, title: "conversion" }) })).json;
  assert.equal(kase.client_id, undefined, "opened without a client, like every prospect");

  const client = (await api(app, "clients", { method: "POST", body: JSON.stringify({ display_name: "Northwind" }) })).json;
  const other = (await api(app, "clients", { method: "POST", body: JSON.stringify({ display_name: "Contoso" }) })).json;

  assert.equal(
    (await api(app, `cases/${kase.id}`, { method: "PUT", body: JSON.stringify({ client_id: "not-a-client" }) })).status,
    400,
    "an id from a request body is never trusted — the client must exist in this project",
  );

  const linked = await api(app, `cases/${kase.id}`, { method: "PUT", body: JSON.stringify({ client_id: client.id, stage: "collecting", note: "won" }) });
  assert.equal(linked.status, 200);
  assert.equal(linked.json.client_id, client.id);
  assert.equal(linked.json.stage, "collecting", "the stage move and the link land together");

  // Idempotent: a retried conversion (double click, replayed action) must not error.
  const again = await api(app, `cases/${kase.id}`, { method: "PUT", body: JSON.stringify({ client_id: client.id }) });
  assert.equal(again.status, 200);
  assert.equal(again.json.client_id, client.id);

  // But re-pointing at a DIFFERENT client is a bug in the caller, and is told so.
  const repoint = await api(app, `cases/${kase.id}`, { method: "PUT", body: JSON.stringify({ client_id: other.id }) });
  assert.equal(repoint.status, 400);
  assert.match(repoint.json.error, /already belongs/);

  // And the link is what makes the work findable from the customer.
  assert.ok((await api(app, `cases?client_id=${client.id}`)).json.some((k: { id: string }) => k.id === kase.id));
});
