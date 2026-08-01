// Message intake: the adapters, the dedupe key, and the tenant scoping the key depends on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { api, makeApp } from "./helpers";
import { getDomainStore } from "../src/domain";
import {
  intakeDedupeKey,
  intakeSourceForChannelKind,
  lookupIntakeReplay,
  normalizeIntake,
  rememberIntake,
  resetIntakeReplay,
} from "../src/intake-normalize";

test("email adapter: required fields, pass-through metadata", () => {
  const ok = normalizeIntake("email", {
    from: { handle: "Ada@Example.com", name: "Ada" },
    body: "  my licence expired  ",
    subject: "help",
    message_id: "<abc@postmark>",
  });
  assert.ok(ok.ok);
  assert.equal(ok.value.source, "email");
  assert.equal(ok.value.client.handle, "Ada@Example.com");
  assert.equal(ok.value.body, "my licence expired", "trimmed");
  assert.deepEqual(ok.value.metadata, { message_id: "<abc@postmark>" }, "unclaimed fields survive");
});

test("intake fails CLOSED — no anonymous sender, no empty body, no unknown source", () => {
  // The old inbound route defaulted a missing sender to the literal handle "anonymous", which
  // merged every unidentifiable stranger into one shared client and threaded them together.
  assert.equal((normalizeIntake("email", { body: "hi" }) as { error: { code: string } }).error.code, "intake.missing_sender");
  assert.equal((normalizeIntake("email", { from: { handle: "a@b.c" }, body: "   " }) as { error: { code: string } }).error.code, "intake.missing_body");
  assert.equal((normalizeIntake("email", "not an object") as { error: { code: string } }).error.code, "intake.malformed");
  assert.equal((normalizeIntake("slack", {}) as { error: { code: string } }).error.code, "intake.unknown_source");
  assert.equal(intakeSourceForChannelKind("email"), "email");
  assert.equal(intakeSourceForChannelKind("webhook"), undefined);
});

test("form adapter: sender and body can come from fields", () => {
  const ok = normalizeIntake("form", { fields: { email: "b@c.d", message: "quote please", subject: "hi" } });
  assert.ok(ok.ok);
  assert.equal(ok.value.client.handle, "b@c.d");
  assert.equal(ok.value.body, "quote please");
  assert.equal(ok.value.subject, "hi");
  assert.equal((normalizeIntake("form", { message: "no fields" }) as { error: { code: string } }).error.code, "intake.malformed");
  assert.equal((normalizeIntake("form", { fields: { message: "who?" } }) as { error: { code: string } }).error.code, "intake.missing_sender");
});

test("the dedupe key is PROJECT-SCOPED — the same message in two projects is two keys", () => {
  const n = normalizeIntake("email", { from: { handle: "a@b.c" }, body: "same words" });
  assert.ok(n.ok);
  const inA = intakeDedupeKey("project-a", n.value);
  const inB = intakeDedupeKey("project-b", n.value);
  assert.notEqual(inA, inB, "without this, one tenant can seed a key another tenant then matches");
  assert.ok(inA.startsWith("project-a:"));

  // Same for a vendor message id, which is the path an attacker would actually control.
  const withId = normalizeIntake("email", { from: { handle: "a@b.c" }, body: "x", message_id: "<same@vendor>" });
  assert.ok(withId.ok);
  assert.notEqual(intakeDedupeKey("project-a", withId.value), intakeDedupeKey("project-b", withId.value));

  // …and identical input in the SAME project still collides, which is the point of dedupe.
  assert.equal(intakeDedupeKey("project-a", n.value), intakeDedupeKey("project-a", n.value));
});

test("the intake replay window is its own store, bounded and TTL'd", () => {
  resetIntakeReplay();
  rememberIntake("k1", "task-1");
  assert.equal(lookupIntakeReplay("k1"), "task-1");
  // Past the TTL it is gone rather than answering forever.
  assert.equal(lookupIntakeReplay("k1", Date.now() + 25 * 60 * 60 * 1000), undefined);
  assert.equal(lookupIntakeReplay("never-seen"), undefined);
});

/** An email channel wired to a real wedge/task_type in the given project — the intake surface. */
async function channelIn(projectId: string) {
  const domain = getDomainStore();
  const conn = await domain.createConnection({
    project_id: projectId, kind: "email", name: "support", owner: { kind: "founder", id: "f" },
    config: { api_url: "http://127.0.0.1:1", from: "s@x.test" },
  });
  const channel = await domain.createChannel({
    project_id: projectId, connection_id: conn.id, kind: "email",
    address: "support@x.test", wedge: "enrollment-operator", task_type: "reply_to_lead",
  });
  return channel;
}

test("inbound: a provider retry replays the same task instead of running the work twice", async () => {
  resetIntakeReplay();
  const { app } = makeApp();
  const channel = await channelIn((await api(app, "me")).json.projects[0].id);
  const payload = JSON.stringify({
    from: { handle: "lead@x.test", name: "Lead" },
    body: "do you have Saturday slots?",
    message_id: "<retry-me@postmark>",
  });

  const first = await api(app, `channels/${channel.id}/inbound`, { method: "POST", body: payload });
  assert.equal(first.status, 201);
  const again = await api(app, `channels/${channel.id}/inbound`, { method: "POST", body: payload });
  assert.equal(again.status, 200, "a replay, not a new run");
  assert.equal(again.json.task_id, first.json.task_id);
  assert.equal(again.json.replayed, true);

  // The task carries where it came from and who it is for.
  const task = (await api(app, `tasks/${first.json.task_id}`)).json;
  assert.equal(task.source, "email");
  assert.equal(task.client_id, first.json.client_id);
  assert.equal(task.assigned_to, "agent");
});

test("inbound: one project CANNOT pre-seed a dedupe key that hijacks another project's email", async () => {
  resetIntakeReplay();
  const { app } = makeApp();
  const ownerLogin = await app.request("/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: process.env.MYCEL_OWNER_EMAIL || "owner@test.co",
      password: process.env.MYCEL_OWNER_PASSWORD || "secret",
    }),
  });
  const tok = (await ownerLogin.json()).token as string;
  const keyA = process.env.MYCEL_API_KEY || "testkey";
  const projectA = (await api(app, "me", {}, keyA)).json.projects[0].id as string;
  const newProject = (await api(app, "projects", { method: "POST", body: JSON.stringify({ name: "attacker" }) }, tok)).json;
  const keyB = newProject.api_key as string;

  const a = { channel: await channelIn(projectA) };
  const b = { channel: await channelIn(newProject.project.id as string) };

  // The attacker knows (or guesses) the message id the victim is about to receive and sends it to
  // their OWN channel first. With an unscoped key, the victim's delivery would then hit the replay
  // branch and be answered with the attacker's task id and client id.
  const forged = JSON.stringify({
    from: { handle: "victim-lead@x.test" },
    body: "identical content",
    message_id: "<guessable@vendor>",
  });
  const seeded = await api(app, `channels/${b.channel.id}/inbound`, { method: "POST", body: forged }, keyB);
  assert.equal(seeded.status, 201);

  const victim = await api(app, `channels/${a.channel.id}/inbound`, { method: "POST", body: forged }, keyA);
  assert.equal(victim.status, 201, "the victim's mail ran, it was not swallowed as a replay");
  assert.notEqual(victim.json.task_id, seeded.json.task_id);
  assert.notEqual(victim.json.client_id, seeded.json.client_id);
  // And neither project can read the other's task.
  assert.equal((await api(app, `tasks/${seeded.json.task_id}`, {}, keyA)).status, 404);
  assert.equal((await api(app, `tasks/${victim.json.task_id}`, {}, keyB)).status, 404);
});

test("form intake spawns a task without a channel, and rejects a body with no sender", async () => {
  resetIntakeReplay();
  const { app } = makeApp();
  const ok = await api(app, "intake/form", {
    method: "POST",
    body: JSON.stringify({
      wedge: "enrollment-operator",
      task_type: "reply_to_lead",
      fields: { email: "web@x.test", message: "how much for 10 lessons?" },
    }),
  });
  assert.equal(ok.status, 201);
  const task = (await api(app, `tasks/${ok.json.task_id}`)).json;
  assert.equal(task.source, "form");
  assert.equal(task.input.thread_id, undefined, "no channel, so no conversation to thread onto");
  // Routing keys are ours, not the form's — they must not surface as submitted fields.
  assert.deepEqual(task.input.intake_metadata.fields, { email: "web@x.test", message: "how much for 10 lessons?" });

  const bad = await api(app, "intake/form", {
    method: "POST",
    body: JSON.stringify({ wedge: "enrollment-operator", task_type: "reply_to_lead", fields: { message: "anon" } }),
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.code, "intake.missing_sender");
});
