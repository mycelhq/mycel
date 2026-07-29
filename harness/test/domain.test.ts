import { test } from "node:test";
import assert from "node:assert/strict";
import { api, makeApp } from "./helpers";

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
