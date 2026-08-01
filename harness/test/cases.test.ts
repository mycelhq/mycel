import { test } from "node:test";
import assert from "node:assert/strict";
import { api, makeApp, waitTask } from "./helpers";
import { getDomainStore } from "../src/domain";
import { registerActionGrant } from "../src/actiongrants";

const WEDGE = "property-sourcer"; // declares cases.stages: brief → sourcing → … → completed

test("cases: create with the wedge's initial stage, reject undeclared stages", async () => {
  const { app } = makeApp();

  assert.equal((await api(app, "cases", { method: "POST", body: JSON.stringify({ title: "no wedge" }) })).status, 400);
  assert.equal((await api(app, "cases", { method: "POST", body: JSON.stringify({ wedge: "ghost", title: "x" }) })).status, 400);
  assert.equal(
    (await api(app, "cases", { method: "POST", body: JSON.stringify({ wedge: WEDGE, title: "x", stage: "not-a-stage" }) })).status,
    400,
    "a stage the wedge doesn't declare is refused at the boundary",
  );

  const created = await api(app, "cases", { method: "POST", body: JSON.stringify({ wedge: WEDGE, title: "BL3 mandate", data: { max_price: 160000 } }) });
  assert.equal(created.status, 201);
  assert.equal(created.json.stage, "brief", "took the wedge's initial stage");
  assert.equal(created.json.status, "open");
  assert.equal(created.json.history[0].kind, "created");
  assert.ok(created.json.project_id, "stamped with the tenant");
});

test("cases: stage transitions and data merges are recorded in history", async () => {
  const { app } = makeApp();
  const kase = (await api(app, "cases", { method: "POST", body: JSON.stringify({ wedge: WEDGE, title: "m", data: { a: 1 } }) })).json;

  const bad = await api(app, `cases/${kase.id}`, { method: "PUT", body: JSON.stringify({ stage: "nope" }) });
  assert.equal(bad.status, 400, "invalid transitions are refused");

  const moved = await api(app, `cases/${kase.id}`, { method: "PUT", body: JSON.stringify({ stage: "sourcing", note: "brief signed off", data: { b: 2 } }) });
  assert.equal(moved.json.stage, "sourcing");
  assert.deepEqual(moved.json.data, { a: 1, b: 2 }, "data merges — a partial update can't wipe state");
  const ev = moved.json.history.at(-1);
  assert.equal(ev.kind, "stage_changed");
  assert.equal(ev.from, "brief");
  assert.equal(ev.to, "sourcing");
  assert.equal(ev.note, "brief signed off");

  const closed = await api(app, `cases/${kase.id}`, { method: "PUT", body: JSON.stringify({ status: "closed", note: "done" }) });
  assert.equal(closed.json.status, "closed");
  assert.ok(closed.json.closed_at);
  assert.equal(closed.json.history.at(-1).kind, "closed");
});

test("cases: a task is an episode — inherits the case, runs, and shows on the case", async () => {
  const { app } = makeApp();
  const kase = (await api(app, "cases", { method: "POST", body: JSON.stringify({ wedge: WEDGE, title: "episode test", data: { postcode: "BL3" } }) })).json;

  assert.equal(
    (await api(app, `cases/${kase.id}/tasks`, { method: "POST", body: JSON.stringify({ task_type: "bogus" }) })).status,
    400,
    "task_type still validated against the wedge",
  );

  const spawned = await api(app, `cases/${kase.id}/tasks`, { method: "POST", body: JSON.stringify({ task_type: "source_property", input: { listing: "x" } }) });
  assert.equal(spawned.status, 201);
  assert.equal(spawned.json.case_id, kase.id, "the task knows its case");
  assert.equal(spawned.json.wedge, WEDGE, "wedge inherited from the case");
  assert.deepEqual(spawned.json.input.case.data, { postcode: "BL3" }, "case state is handed to the run");

  const done = await waitTask(app, spawned.json.id);
  assert.equal(done.status, "succeeded");

  const detail = await api(app, `cases/${kase.id}`);
  assert.equal(detail.json.tasks.length, 1, "the case lists its episodes");
  assert.ok(detail.json.stages.includes("sourcing"), "the wedge's stage machine is exposed to UIs");
  assert.ok(detail.json.history.some((h: { kind: string }) => h.kind === "task_spawned"));

  // closed cases don't accept new episodes
  await api(app, `cases/${kase.id}`, { method: "PUT", body: JSON.stringify({ status: "closed" }) });
  assert.equal((await api(app, `cases/${kase.id}/tasks`, { method: "POST", body: JSON.stringify({ task_type: "source_property" }) })).status, 409);
});

test("cases: the agent can read and advance its own case, scoped to its run", async () => {
  const { app } = makeApp();
  const domain = getDomainStore();
  const kase = (await api(app, "cases", { method: "POST", body: JSON.stringify({ wedge: WEDGE, title: "agent test" }) })).json;
  const spawned = (await api(app, `cases/${kase.id}/tasks`, { method: "POST", body: JSON.stringify({ task_type: "source_property" }) })).json;

  const nonce = await registerActionGrant({ task_id: spawned.id, connectionIds: [], caseId: kase.id });
  const H = { authorization: `Bearer ${nonce}`, "content-type": "application/json" };

  const read = await (await app.request("/v1/internal/case", { headers: H })).json();
  assert.equal(read.ok, true);
  assert.equal(read.case.id, kase.id);
  assert.ok(read.case.stages.length, "the agent is told which stages exist");

  const upd = await (await app.request("/v1/internal/case/update", { method: "POST", headers: H, body: JSON.stringify({ stage: "sourcing", data: { shortlist: 3 }, note: "found 3" }) })).json();
  assert.equal(upd.ok, true);
  assert.equal(upd.case.stage, "sourcing");
  assert.deepEqual(upd.case.data, { shortlist: 3 });
  assert.equal(upd.case.history.at(-1).actor, "agent", "attributed to the agent, not a member");

  // the agent cannot invent a stage
  const badStage = await (await app.request("/v1/internal/case/update", { method: "POST", headers: H, body: JSON.stringify({ stage: "invented" }) })).json();
  assert.equal(badStage.ok, false);

  // and an unauthenticated caller gets nothing
  assert.equal((await app.request("/v1/internal/case", { headers: { authorization: "Bearer nope" } })).status, 401);

  // a run with no case says so rather than leaking someone else's
  const orphan = await registerActionGrant({ task_id: spawned.id, connectionIds: [] });
  assert.equal((await app.request("/v1/internal/case", { headers: { authorization: `Bearer ${orphan}` } })).status, 404);

  await domain.listCases(); // sanity: store still healthy
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
  await api(app, `cases/${a.id}`, { method: "PUT", body: JSON.stringify({ stage: "analysing" }) });

  assert.equal((await api(app, "cases")).json.length, before.all + 2);
  assert.equal((await api(app, "cases?wedge=invoice-chaser")).json.length, before.chaser + 1, "filters by wedge");
  const analysing = (await api(app, "cases?stage=analysing")).json;
  assert.deepEqual(analysing.map((k: { id: string }) => k.id), [a.id], "filters by stage");
  assert.equal((await api(app, "cases?status=closed")).json.length, before.closed, "filters by status");

  // a case in one wedge is never returned when filtering by another
  assert.ok(!(await api(app, `cases?wedge=${WEDGE}`)).json.some((k: { title: string }) => k.title === "filter-b"));
});
