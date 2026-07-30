import { test } from "node:test";
import assert from "node:assert/strict";
import { api, makeApp } from "./helpers";
import { initSecretStore, _resetKeyCache } from "../src/secrets";

test("connections: created, listed, secret never returned", async () => {
  const { app } = makeApp();
  const c = await api(app, "connections", { method: "POST", body: JSON.stringify({ kind: "email", name: "billing", config: { from: "a@b.c" }, secret_ref: "env:X" }) });
  assert.equal(c.status, 201);
  assert.equal(c.json.owner.kind, "founder");
  assert.ok(!JSON.stringify(c.json).includes("SECRETVALUE"));
  // store a vault secret — the response is just { ok }, never the value
  const s = await api(app, `connections/${c.json.id}/secret`, { method: "POST", body: JSON.stringify({ value: "SECRETVALUE" }) });
  assert.equal(s.json.ok, true);
  assert.ok(!JSON.stringify(s.json).includes("SECRETVALUE"));
});

test("knowledge: add, list, and feedback becomes a grounding example", async () => {
  const { app } = makeApp();
  const add = await api(app, "wedges/enrollment-operator/knowledge", { method: "POST", body: JSON.stringify({ name: "pricing.md", content: "£1450/mo", kind: "fact" }) });
  assert.equal(add.status, 201);
  const list = await api(app, "wedges/enrollment-operator/knowledge");
  assert.ok(list.json.some((k: any) => k.name === "pricing.md"));

  // a task, then feedback with a correction → new knowledge item
  const t = (await api(app, "tasks", { method: "POST", body: JSON.stringify({ wedge: "enrollment-operator", task_type: "reply_to_lead", input: {} }) })).json;
  const fb = await api(app, `tasks/${t.id}/feedback`, { method: "POST", body: JSON.stringify({ rating: "bad", correction: "always offer a tour" }) });
  assert.equal(fb.json.ok, true);
  assert.ok(fb.json.knowledge_id, "correction stored as knowledge");
  const after = await api(app, "wedges/enrollment-operator/knowledge");
  assert.ok(after.json.some((k: any) => k.source === "feedback"));
});

test("unknown wedge knowledge is 404", async () => {
  const { app } = makeApp();
  assert.equal((await api(app, "wedges/ghost/knowledge", { method: "POST", body: JSON.stringify({ name: "x", content: "y" }) })).status, 404);
});

test("connections: the API reports that a credential EXISTS, and never leaks it", async () => {
  process.env.MYCEL_SECRET_KEY = Buffer.alloc(32, 9).toString("base64");
  _resetKeyCache();
  await initSecretStore();
  const { app } = makeApp();

  const created = (
    await api(app, "connections", {
      method: "POST",
      body: JSON.stringify({ kind: "email", name: "flagged-conn", config: {} }),
    })
  ).json as { id: string };

  const before = ((await api(app, "connections")).json as { id: string; has_secret: boolean }[]).find(
    (c) => c.id === created.id,
  )!;
  assert.equal(before.has_secret, false, "a fresh connection owes a credential, and says so");

  const SECRET = "sk-live-must-never-appear-in-a-response";
  await api(app, `connections/${created.id}/secret`, { method: "POST", body: JSON.stringify({ value: SECRET }) });

  const after = ((await api(app, "connections")).json as { id: string; has_secret: boolean }[]).find(
    (c) => c.id === created.id,
  )!;
  assert.equal(after.has_secret, true, "once stored, the UI can tell it's connected");
  assert.equal((await api(app, `connections/${created.id}`)).json.has_secret, true, "single fetch agrees");

  // The whole point: presence is public, the value is not. Not the value, not a prefix, not a length.
  for (const path of ["connections", `connections/${created.id}`]) {
    const body = JSON.stringify((await api(app, path)).json);
    assert.ok(!body.includes(SECRET), `${path} must not contain the secret`);
    assert.ok(!body.includes(SECRET.slice(0, 12)), `${path} must not contain a prefix of it`);
  }
});

test("schedules: pausing a schedule must not erase the rest of it", async () => {
  const { app } = makeApp();
  const created = (
    await api(app, "schedules", {
      method: "POST",
      body: JSON.stringify({
        name: "nightly close",
        wedge: "enrollment-operator",
        task_type: "reply_to_lead",
        cadence: { kind: "daily", hour: 6, minute: 30 },
        input: { message: "all" },
      }),
    })
  ).json as { id: string; next_run_at: string };

  // The narrowest possible patch — exactly what a pause switch sends.
  const paused = (
    await api(app, `schedules/${created.id}`, { method: "PUT", body: JSON.stringify({ enabled: false }) })
  ).json;

  assert.equal(paused.enabled, false, "it paused");
  // …and everything else survived. A route that builds {enabled, name: undefined, cadence: undefined}
  // used to blank these, leaving a schedule that could never fire again.
  assert.equal(paused.name, "nightly close");
  assert.equal(paused.task_type, "reply_to_lead");
  assert.deepEqual(paused.cadence, { kind: "daily", hour: 6, minute: 30 });
  assert.deepEqual(paused.input, { message: "all" });
  assert.equal(paused.next_run_at, created.next_run_at, "the next run time is untouched by a pause");

  const reread = (await api(app, `schedules/${created.id}`)).json;
  assert.deepEqual(reread, paused, "and it's persisted, not just echoed back");
});
