// A written service's day-one allowances survive only in their clamped form.
//
// The author of these rules is the same model that benefits from them, which is why every test
// here is about the sanitiser being unimpressed: wildcards deleted, money deleted, ceilings
// halved relative to what a person may write, and the whole block gone when nothing survives.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AUTHORED_POLICY_MAX_PER_DAY,
  AUTHORED_POLICY_MAX_RULES,
  sanitiseAuthoredPolicy,
} from "../src/wedgeauthor";

const withPolicy = (rules: unknown[]): Record<string, unknown> => ({
  wedge: "test-svc",
  policy: { auto_approve: rules },
});

test("an exact bounded rule survives, clamped to the authored ceiling", () => {
  const m = withPolicy([{ action: "email:send_email", max_per_day: 25 }]);
  sanitiseAuthoredPolicy(m);
  assert.deepEqual(m.policy, { auto_approve: [{ action: "email:send_email", max_per_day: AUTHORED_POLICY_MAX_PER_DAY }] });
});

test("wildcards and prefixes are deleted — an authored prefix covers verbs that do not exist yet", () => {
  const m = withPolicy([
    { action: "*", max_per_day: 5 },
    { action: "email:*", max_per_day: 5 },
    { action: "email:", max_per_day: 5 },
  ]);
  sanitiseAuthoredPolicy(m);
  assert.equal(m.policy, undefined);
});

test("a money rule is dropped whole — 'auto-approve up to $X' is autonomy nobody demonstrated", () => {
  const m = withPolicy([{ action: "stripe:refund", max_per_day: 2, max_amount_usd: 10 }]);
  sanitiseAuthoredPolicy(m);
  assert.equal(m.policy, undefined);
});

test("no max_per_day, no rule — an unbounded allowance is not an allowance", () => {
  const m = withPolicy([{ action: "email:send_email" }]);
  sanitiseAuthoredPolicy(m);
  assert.equal(m.policy, undefined);
});

test("at most three rules, in declared order", () => {
  const m = withPolicy(
    ["a:one", "a:two", "a:three", "a:four"].map((action) => ({ action, max_per_day: 2 })),
  );
  sanitiseAuthoredPolicy(m);
  const rules = (m.policy as { auto_approve: { action: string }[] }).auto_approve;
  assert.equal(rules.length, AUTHORED_POLICY_MAX_RULES);
  assert.deepEqual(rules.map((r) => r.action), ["a:one", "a:two", "a:three"]);
});

test("garbage shapes vanish rather than throw", () => {
  for (const junk of [null, 42, "policy", { auto_approve: "yes" }, { auto_approve: [null, 7] }]) {
    const m = { wedge: "x", policy: junk } as Record<string, unknown>;
    sanitiseAuthoredPolicy(m);
    assert.equal(m.policy, undefined);
  }
});
