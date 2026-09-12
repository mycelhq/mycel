// The shape that makes this a back office rather than a report generator. The other three can
// decide, draft and compute; none of them can log in to anything, and most knowledge work in a
// service business happens inside somebody else's authenticated software.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isShape, SHAPE_DEFAULTS } from "../src/harness";

test("operate is a real shape", () => {
  assert.equal(isShape("operate"), true);
  assert.ok(SHAPE_DEFAULTS.operate);
});

test("IT CAN NEVER HOLD THE SEND TOKEN — the load-bearing line", () => {
  // A run with a live browser session can already reach a lot on the customer's behalf. Handing it
  // the send grant would mean one compromised page could both read a mailbox and mail from it.
  assert.equal(SHAPE_DEFAULTS.operate.grants_actions, false);
  assert.equal(SHAPE_DEFAULTS.build.grants_actions, false, "same principle as build");
  // The two shapes that CAN act are the two that cannot write code or drive a session.
  assert.equal(SHAPE_DEFAULTS.decide.grants_actions, true);
  assert.equal(SHAPE_DEFAULTS.general.grants_actions, true);
});

test("it works in a browser, not in a source tree", () => {
  const p = SHAPE_DEFAULTS.operate.permission as Record<string, unknown>;
  assert.equal(p.edit, "deny");
  assert.equal(p.apply_patch, "deny");
  assert.equal(p.task, "deny", "no subagents to supervise");
  assert.equal(p["*"], "deny", "deny by default, allow by name");
});

test("it is slower and dearer than a text decision, on purpose", () => {
  // A budget sized for `decide` would kill these halfway through a multi-step job — logged in,
  // partway through changing something, with no record of how far it got.
  assert.ok(SHAPE_DEFAULTS.operate.max_runtime_s > SHAPE_DEFAULTS.decide.max_runtime_s);
  assert.ok(SHAPE_DEFAULTS.operate.max_cost_usd > SHAPE_DEFAULTS.decide.max_cost_usd);
});

test("the sandbox stays warm — sessions are expensive to establish", () => {
  assert.equal(SHAPE_DEFAULTS.operate.long_lived, true);
});

test("it is held to its output contract", () => {
  // Operating without a definition of done is how a run wanders around somebody's accounting
  // software and stops when it feels finished.
  assert.equal(SHAPE_DEFAULTS.operate.strict_output, true);
});
