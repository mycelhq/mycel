import { test } from "node:test";
import assert from "node:assert/strict";
import { api, makeApp, waitTask, KEY } from "./helpers";

test("health is open; /v1 requires auth", async () => {
  const { app } = makeApp();
  assert.equal((await app.request("/health")).status, 200);
  const noauth = await app.request("/v1/tasks", { method: "POST", body: "{}" });
  assert.equal(noauth.status, 401);
  const bad = await api(app, "tasks", { method: "POST", body: "{}" }, "wrong-key");
  assert.equal(bad.status, 401);
});

test("task: validation, clamp, and a successful mock run", async () => {
  const { app } = makeApp();

  // unknown wedge / task_type rejected at the boundary
  assert.equal((await api(app, "tasks", { method: "POST", body: JSON.stringify({ wedge: "ghost", task_type: "x" }) })).status, 400);
  assert.equal((await api(app, "tasks", { method: "POST", body: JSON.stringify({ wedge: "enrollment-operator", task_type: "nope" }) })).status, 400);

  // constraints clamped to server ceilings
  const created = await api(app, "tasks", {
    method: "POST",
    body: JSON.stringify({ wedge: "enrollment-operator", task_type: "reply_to_lead", input: { message: "hi" }, constraints: { max_cost_usd: 99999 } }),
  });
  assert.equal(created.status, 201);
  assert.ok(created.json.constraints.max_cost_usd <= 50);
  assert.ok(created.json.project_id, "task is stamped with a project");

  // it runs to success under the mock runtime, with an artifact + persisted cost
  const done = await waitTask(app, created.json.id);
  assert.equal(done.status, "succeeded");
  assert.ok(done.cost_usd > 0);
});

test("SSE replays the ordered event stream to a terminal event", async () => {
  const { app } = makeApp();
  const { json: task } = await api(app, "tasks", { method: "POST", body: JSON.stringify({ wedge: "enrollment-operator", task_type: "reply_to_lead", input: { message: "hi" } }) });
  await waitTask(app, task.id);
  // reconnect after the fact: replay from the start, must end with task.finished
  const res = await app.request(`/v1/tasks/${task.id}/events`, { headers: { authorization: `Bearer ${KEY}`, "Last-Event-ID": "0" } });
  const body = await res.text();
  const types = [...body.matchAll(/event:\s*([\w.]+)/g)].map((m) => m[1]);
  assert.ok(types.includes("task.created"));
  assert.equal(types.at(-1), "task.finished");
});

test("unknown task id is 404", async () => {
  const { app } = makeApp();
  assert.equal((await api(app, "tasks/does-not-exist")).status, 404);
});

test("SSE tells a reconnecting client the run is over, even with no task.finished", async () => {
  // Not every terminal task has a `task.finished` in its log — one cancelled before its execution
  // loop starts never emits one. Closing silently is indistinguishable from a dropped connection,
  // so EventSource reconnects, gets the same silent close, and retries forever against a run that
  // will never say anything again.
  const { app, store } = makeApp();
  const projectId = (await api(app, "me")).json.projects[0].id;
  const now = new Date().toISOString();
  await store.createTask({
    id: "silent-terminal", project_id: projectId, wedge: "books-keeper", task_type: "daily_sync",
    actor: { kind: "system", id: "test" }, input: {}, constraints: {}, tools: [],
    status: "cancelled", cost_usd: 0, created_at: now, updated_at: now,
  } as never);

  const res = await app.request(`/v1/tasks/silent-terminal/events`, {
    headers: { authorization: `Bearer ${KEY}`, "Last-Event-ID": "0" },
  });
  const body = await res.text();
  const types = [...body.matchAll(/event:\s*([\w.]+)/g)].map((m) => m[1]);
  assert.ok(!types.includes("task.finished"), "this task never emitted one");
  assert.equal(types.at(-1), "closed", "so the stream says so explicitly instead of just hanging up");
  assert.match(body, /"status":"cancelled"/, "and says which terminal state it reached");
});
