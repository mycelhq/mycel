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
  const ta = (await api(app, "tasks", { method: "POST", body: JSON.stringify({ wedge: "enrollment-operator", task_type: "reply_to_lead", input: {} }) })).json;
  const tb = (await api(app, "tasks", { method: "POST", body: JSON.stringify({ wedge: "enrollment-operator", task_type: "reply_to_lead", input: {} }) }, keyB)).json;

  // key A sees only its task; key B only its; cross-access is 404
  assert.deepEqual((await api(app, "tasks")).json.map((t: any) => t.id), [ta.id]);
  assert.deepEqual((await api(app, "tasks", {}, keyB)).json.map((t: any) => t.id), [tb.id]);
  assert.equal((await api(app, `tasks/${tb.id}`)).status, 404);
  assert.equal((await api(app, `tasks/${ta.id}`, {}, keyB)).status, 404);

  // the org member sees BOTH projects' tasks
  const memberList = await api(app, "tasks", {}, tok);
  assert.equal(memberList.json.length, 2);

  // with >1 project, a member must name the target project on writes
  const noProject = await api(app, "tasks", { method: "POST", body: JSON.stringify({ wedge: "enrollment-operator", task_type: "reply_to_lead", input: {} }) }, tok);
  assert.equal(noProject.status, 400);
  const withProject = await api(app, "tasks", { method: "POST", headers: { "x-mycel-project": projectA }, body: JSON.stringify({ wedge: "enrollment-operator", task_type: "reply_to_lead", input: {} }) }, tok);
  assert.equal(withProject.status, 201);
});
