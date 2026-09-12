import { test } from "node:test";
import assert from "node:assert/strict";
import { api, makeApp } from "./helpers";
import {
  inferResponsibilities,
  whoHandles,
  RESPONSIBILITY_LABEL,
  type ResponsibilityArea,
} from "../src/team";
import type { AuditAction, AuditEntry } from "../src/audit";
import { audit } from "../src/audit";
import { getIdentityStore } from "../src/identity";

// A minimal AuditEntry fixture. The hash chain fields are irrelevant to inference (it reads actor,
// action, entity, detail only), so they are filled with placeholders.
let seq = 0;
function entry(
  actor: string,
  action: AuditAction,
  entity = "task",
  entity_id = "x",
  detail: Record<string, unknown> = {},
): AuditEntry {
  seq += 1;
  return {
    seq,
    project_id: "p",
    at: new Date().toISOString(),
    actor,
    action,
    entity,
    entity_id,
    detail,
    prev_hash: "0".repeat(64),
    hash: "0".repeat(64),
  };
}

test("inferResponsibilities: maps each area from action + entity", () => {
  const inferred = inferResponsibilities([
    entry("alice", "approval.granted", "invoice", "inv_1"),
    entry("alice", "approval.rejected", "dunning", "d_1"),
    entry("bob", "approval.granted", "outreach", "o_1"),
    entry("bob", "connection.linked", "connection", "c_1"),
    entry("carol", "secret.written", "secret", "s_1"),
    entry("carol", "org.plan_changed", "org", "org_1"),
    entry("dave", "standing.granted", "grant", "g_1"),
    entry("dave", "case.closed", "case", "case_1"),
    entry("erin", "approval.granted", "case", "case_2"), // no money/outreach signal -> client_comms
    entry("frank", "action.executed", "member", "m_1"), // member touch -> team_admin
  ]);

  const areasOf = (id: string): ResponsibilityArea[] =>
    (inferred.get(id) ?? []).map((a) => a.area);

  assert.deepEqual(areasOf("alice"), ["collections"]);
  assert.deepEqual(new Set(areasOf("bob")), new Set(["outreach", "setup"]));
  assert.deepEqual(new Set(areasOf("carol")), new Set(["setup", "billing_admin"]));
  assert.deepEqual(new Set(areasOf("dave")), new Set(["team_admin", "client_comms"]));
  assert.deepEqual(areasOf("erin"), ["client_comms"]);
  assert.deepEqual(areasOf("frank"), ["team_admin"]);
});

test("inferResponsibilities: tallies weight and sorts descending", () => {
  const inferred = inferResponsibilities([
    entry("alice", "approval.granted", "invoice", "1"),
    entry("alice", "approval.granted", "invoice", "2"),
    entry("alice", "approval.granted", "invoice", "3"),
    entry("alice", "case.closed", "case", "1"),
  ]);
  const areas = inferred.get("alice")!;
  assert.equal(areas[0].area, "collections");
  assert.equal(areas[0].weight, 3);
  assert.equal(areas[1].area, "client_comms");
  assert.equal(areas[1].weight, 1);
});

test("inferResponsibilities: skips empty actor and non-human actors and unmapped actions", () => {
  const inferred = inferResponsibilities([
    entry("", "approval.granted", "invoice", "1"),
    entry("agent", "approval.granted", "invoice", "2"),
    entry("system", "case.closed", "case", "1"),
    entry("policy", "approval.auto_approved", "invoice", "3"),
    entry("alice", "project.created", "project", "1"), // unmapped -> skipped
    entry("alice", "trigger.subscribed", "trigger", "1"), // unmapped -> skipped
    entry("alice", "superadmin.session", "member", "alice"), // maps via member -> team_admin
  ]);
  assert.equal(inferred.has(""), false);
  assert.equal(inferred.has("agent"), false);
  assert.equal(inferred.has("system"), false);
  assert.equal(inferred.has("policy"), false);
  // alice only has the member-touching entry counted; the two unmapped ones are dropped.
  assert.deepEqual(
    (inferred.get("alice") ?? []).map((a) => a.area),
    ["team_admin"],
  );
});

test("whoHandles: returns top member, undefined when none", () => {
  const inferred = inferResponsibilities([
    entry("alice", "approval.granted", "invoice", "1"),
    entry("alice", "approval.granted", "invoice", "2"),
    entry("bob", "approval.granted", "invoice", "3"),
  ]);
  assert.equal(whoHandles(inferred, "collections"), "alice");
  assert.equal(whoHandles(inferred, "bookkeeping"), undefined);
});

test("every area has a label", () => {
  for (const [area, label] of Object.entries(RESPONSIBILITY_LABEL)) {
    assert.equal(typeof label, "string");
    assert.ok(label.length > 0, `${area} needs a label`);
  }
});

test("GET /v1/team/responsibilities: owner's audited decisions surface as areas", async () => {
  const { app } = makeApp();
  const login = await api(app, "auth/login", {
    method: "POST",
    body: JSON.stringify({
      email: process.env.MYCEL_OWNER_EMAIL || "owner@test.co",
      password: process.env.MYCEL_OWNER_PASSWORD || "secret",
    }),
  });
  assert.equal(login.status, 200);
  const token = login.json.token;
  const ownerId = login.json.member.id;
  const orgId = login.json.member.org_id;
  const projectId = getIdentityStore().listProjects(orgId)[0].id;

  // Seed a couple of consequential decisions for the owner.
  await audit({
    project_id: projectId,
    actor: ownerId,
    action: "approval.granted",
    entity: "invoice",
    entity_id: "inv_1",
    detail: {},
  });
  await audit({
    project_id: projectId,
    actor: ownerId,
    action: "connection.linked",
    entity: "connection",
    entity_id: "conn_1",
    detail: {},
  });

  const res = await api(app, "team/responsibilities", {}, token);
  assert.equal(res.status, 200);
  const me = res.json.members.find((m: any) => m.member_id === ownerId);
  assert.ok(me, "owner appears in the responsibility map");
  const areas = new Set(me.areas.map((a: any) => a.area));
  assert.ok(areas.has("collections"), "an invoice approval -> collections");
  assert.ok(areas.has("setup"), "a connection link -> setup");
  // Labels ride along and are the kernel's own.
  const collections = me.areas.find((a: any) => a.area === "collections");
  assert.equal(collections.label, RESPONSIBILITY_LABEL.collections);
});
