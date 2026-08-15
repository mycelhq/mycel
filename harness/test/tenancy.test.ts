import { test } from "node:test";
import assert from "node:assert/strict";
import { api, makeApp, KEY } from "./helpers";

const OWNER_EMAIL = process.env.MYCEL_OWNER_EMAIL || "owner@test.co";
const OWNER_PW = process.env.MYCEL_OWNER_PASSWORD || "secret";

test("per-project isolation: keys can't see each other's data; a member sees the org", async () => {
  const { app } = makeApp();

  // member login → session token; discover project A id
  const login = await app.request("/v1/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PW }) });
  assert.equal(login.status, 200);
  const tok = (await login.json()).token as string;
  const me = await api(app, "me", {}, tok);
  const projectA = me.json.projects[0].id;

  // create project B (+ its own key) as the owner member
  const pb = await api(app, "projects", { method: "POST", body: JSON.stringify({ name: "project-b" }) }, tok);
  assert.equal(pb.status, 201);
  const keyB = pb.json.api_key as string;

  // a task in each project (keys have a fixed project → no header needed)
  const ta = (await api(app, "tasks", { method: "POST", body: JSON.stringify({ wedge: "books-keeper", task_type: "daily_sync", input: {} }) })).json;
  const tb = (await api(app, "tasks", { method: "POST", body: JSON.stringify({ wedge: "books-keeper", task_type: "daily_sync", input: {} }) }, keyB)).json;

  // key A sees only its task; key B only its; cross-access is 404
  assert.deepEqual((await api(app, "tasks")).json.map((t: any) => t.id), [ta.id]);
  assert.deepEqual((await api(app, "tasks", {}, keyB)).json.map((t: any) => t.id), [tb.id]);
  assert.equal((await api(app, `tasks/${tb.id}`)).status, 404);
  assert.equal((await api(app, `tasks/${ta.id}`, {}, keyB)).status, 404);

  // the org member sees BOTH projects' tasks
  const memberList = await api(app, "tasks", {}, tok);
  assert.equal(memberList.json.length, 2);

  // with >1 project, a member must name the target project on writes
  const noProject = await api(app, "tasks", { method: "POST", body: JSON.stringify({ wedge: "books-keeper", task_type: "daily_sync", input: {} }) }, tok);
  assert.equal(noProject.status, 400);
  const withProject = await api(app, "tasks", { method: "POST", headers: { "x-mycel-project": projectA }, body: JSON.stringify({ wedge: "books-keeper", task_type: "daily_sync", input: {} }) }, tok);
  assert.equal(withProject.status, 201);
});

test("project scope: X-Mycel-Project narrows reads, and fails closed on a project you can't see", async () => {
  const { app } = makeApp();
  const login = await app.request("/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PW }),
  });
  const tok = (await login.json()).token as string;
  const projectA = (await api(app, "me", {}, tok)).json.projects[0].id;

  const pb = await api(app, "projects", { method: "POST", body: JSON.stringify({ name: "project-b" }) }, tok);
  const projectB = pb.json.project.id as string;

  const spawn = (project: string) =>
    api(
      app,
      "tasks",
      {
        method: "POST",
        headers: { "x-mycel-project": project },
        body: JSON.stringify({ wedge: "books-keeper", task_type: "daily_sync", input: {} }),
      },
      tok,
    );
  const ta = (await spawn(projectA)).json;
  const tb = (await spawn(projectB)).json;

  const ids = (r: { json: { id: string }[] }) => r.json.map((t) => t.id).sort();

  // No header: the whole org, which is what a fleet-wide view wants.
  assert.deepEqual(ids(await api(app, "tasks", {}, tok)), [ta.id, tb.id].sort());

  // With the header: exactly one business. Before this, a founder running two businesses saw both
  // blended into a single timeline with nothing marking which client a row belonged to.
  const scoped = (project: string) => api(app, "tasks", { headers: { "x-mycel-project": project } }, tok);
  assert.deepEqual(ids(await scoped(projectA)), [ta.id]);
  assert.deepEqual(ids(await scoped(projectB)), [tb.id]);

  // Fails closed. Naming a project outside your scope returns NOTHING — it must never widen access
  // back to the full set, which is what a `??`-style fallback would have quietly done.
  const outsider = "00000000-0000-4000-8000-000000000000";
  assert.deepEqual((await scoped(outsider)).json, [], "an unknown project yields no data");
  assert.equal((await api(app, `tasks/${ta.id}`, { headers: { "x-mycel-project": projectB } }, tok)).status, 404,
    "a single fetch is scoped too — project B cannot read project A's task by id");

  // And the narrowing applies to every read route, because they all filter through one function.
  for (const path of ["schedules", "connections", "clients"]) {
    assert.equal((await api(app, path, { headers: { "x-mycel-project": outsider } }, tok)).status, 200);
    assert.deepEqual((await api(app, path, { headers: { "x-mycel-project": outsider } }, tok)).json, [], path);
  }
});
