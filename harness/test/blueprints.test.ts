import { test } from "node:test";
import assert from "node:assert/strict";
import { api, makeApp } from "./helpers";
import { loadBlueprint, listBlueprints } from "../src/blueprints";
import { setSecret, initSecretStore, _resetKeyCache } from "../src/secrets";
import { getDomainStore } from "../src/domain";

const BP = "books-keeper";

test("blueprints: only real slugs load — no path traversal", () => {
  assert.ok(loadBlueprint(BP));
  for (const bad of ["../../etc/passwd", "a/b", "x.json", ""]) {
    assert.equal(loadBlueprint(bad), null, `should reject: ${bad}`);
  }
  assert.ok(listBlueprints().length >= 2, "the shipped blueprints are discoverable");
});

test("blueprints: a blueprint file is safe to commit — it carries no secrets", () => {
  for (const b of listBlueprints()) {
    const text = JSON.stringify(b);
    assert.ok(!/sk_live|sk-ant|secret_value|"password"/i.test(text), `${b.blueprint} must not embed credentials`);
    for (const conn of b.requires_connections ?? []) {
      assert.ok(conn.why, `${b.blueprint}/${conn.name} must explain WHY it needs the connection`);
      assert.ok(!("secret" in conn), "a blueprint declares the need for a credential, never the value");
    }
  }
});

test("blueprints: provisioning creates a whole business and reports what's missing", async () => {
  process.env.MYCEL_SECRET_KEY = Buffer.alloc(32, 5).toString("base64");
  _resetKeyCache();
  await initSecretStore();
  const { app } = makeApp();

  assert.equal((await api(app, "blueprints/ghost/provision", { method: "POST" })).status, 404);

  const res = await api(app, `blueprints/${BP}/provision`, { method: "POST" });
  assert.equal(res.status, 201);
  const r = res.json;
  assert.equal(r.blueprint, BP);
  assert.deepEqual(r.created.connections.sort(), ["bank-feed", "books-email"]);
  assert.equal(r.created.schedules.length, 3, "daily sync + receipt chase + month-end close");
  assert.ok(r.created.knowledge.length >= 1, "seed knowledge written");

  // it is NOT ready — the founder still owes credentials, and we say so precisely
  assert.equal(r.ready, false);
  const missing = r.checklist.filter((i: { done: boolean }) => !i.done);
  assert.equal(missing.length, 2, "both credentials outstanding");
  assert.ok(missing[0].action?.startsWith("POST /v1/connections/"), "the checklist tells you exactly how to finish");
  assert.ok(missing[0].why, "and why it's needed");

  // the crux: schedules must NOT be live yet, or a credential-less business starts failing on a timer
  const scheds = (await api(app, "schedules")).json;
  assert.equal(scheds.length, 3);
  assert.ok(scheds.every((s: { enabled: boolean }) => s.enabled === false), "provisioned disabled");
});

test("blueprints: provisioning twice does not create a second business", async () => {
  // The domain store is a process singleton, so an earlier test in this file may already have
  // provisioned. Assert the ORDER-INDEPENDENT invariant: after N provisions the business exists
  // exactly once, and the last call created nothing.
  const { app } = makeApp();
  await api(app, `blueprints/${BP}/provision`, { method: "POST" });
  const second = (await api(app, `blueprints/${BP}/provision`, { method: "POST" })).json;

  assert.equal(second.created.connections.length, 0, "nothing new created on a repeat provision");
  assert.equal(second.created.schedules.length, 0);
  assert.deepEqual(second.reused.connections.sort(), ["bank-feed", "books-email"]);
  assert.equal(second.reused.schedules.length, 3);

  const conns = (await api(app, "connections")).json as { name: string }[];
  const scheds = (await api(app, "schedules")).json as { name: string }[];
  assert.equal(conns.filter((c) => c.name === "bank-feed").length, 1, "exactly one bank-feed, not two");
  assert.equal(conns.filter((c) => c.name === "books-email").length, 1);
  assert.equal(scheds.filter((s) => s.name === "month-end close").length, 1, "exactly one close schedule");
});

test("blueprints: activation is REFUSED until the checklist is satisfied, then goes live", async () => {
  process.env.MYCEL_SECRET_KEY = Buffer.alloc(32, 6).toString("base64");
  _resetKeyCache();
  await initSecretStore();
  const { app } = makeApp();
  await api(app, `blueprints/${BP}/provision`, { method: "POST" });

  // refused while credentials are missing — a business that would fail on its first tick
  const refused = await api(app, `blueprints/${BP}/activate`, { method: "POST" });
  assert.equal(refused.status, 409);
  assert.equal(refused.json.error, "not ready");
  assert.equal(refused.json.missing.length, 2);

  // supply the credentials the way a founder would
  const conns = (await api(app, "connections")).json as { id: string; name: string }[];
  for (const conn of conns) {
    const r = await api(app, `connections/${conn.id}/secret`, { method: "POST", body: JSON.stringify({ value: `tok-${conn.name}` }) });
    assert.equal(r.json.ok, true);
  }

  const readiness = await api(app, `blueprints/${BP}/readiness`);
  assert.equal(readiness.json.ready, true, "checklist now satisfied");

  const live = await api(app, `blueprints/${BP}/activate`, { method: "POST" });
  assert.equal(live.status, 200);
  assert.equal(live.json.activated.length, 3);

  const scheds = (await api(app, "schedules")).json;
  assert.ok(scheds.every((s: { enabled: boolean }) => s.enabled), "the business is now running on its own clock");
});

test("blueprints: provisioning is recorded in the tamper-evident audit chain", async () => {
  const { app } = makeApp();
  const me = (await api(app, "me")).json;
  const projectId = me.projects[0].id;
  await api(app, `blueprints/${BP}/provision`, { method: "POST" });

  const chain = (await api(app, `audit?project_id=${projectId}`)).json as { action: string; entity_id: string }[];
  assert.ok(chain.some((e) => e.action === "project.created" && e.entity_id === BP), "provisioning is auditable");
  assert.equal((await api(app, `audit/verify?project_id=${projectId}`)).json.ok, true);
});
