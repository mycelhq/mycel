import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { distillFromOnboarding, type Rule } from "../src/knowledge";
import { toRow } from "../src/knowledge.store";
import {
  RULE_HOLD_POINTS,
  applyStatedRules,
  appliedRuleIds,
  matchRuleToMove,
} from "../src/rules.rank";
import type { Move } from "../src/moves";

function ruleFrom(answer: string, extra: Partial<Rule> = {}): Rule {
  return toRow({
    ...distillFromOnboarding({
      project_id: extra.project_id ?? "p1",
      wedge: extra.wedge ?? "invoice-chaser",
      question_id: extra.subject ?? "q1",
      question: extra.provenance?.question ?? "Anything we should never do?",
      answer,
    }),
    ...extra,
  });
}

function chase(label: string, clientId = "c1"): Move {
  return {
    id: `chase_invoice:${randomUUID()}`,
    project_id: "p1",
    kind: "chase_invoice",
    entity: { kind: "invoice", id: "inv1", label },
    client_id: clientId,
    why: `${label} is 23 days overdue`,
    signals: { money_at_stake: 145_000, currency: "GBP", minor_unit_exponent: 2, days_overdue: 23 },
    score: 12,
    score_terms: [
      { term: "money", points: 8, because: "1450 GBP is outstanding" },
      { term: "deadline", points: 4, because: "the due date passed 23 days ago" },
    ],
    takeable: true,
    proposed_at: new Date().toISOString(),
    carrier: { wedge: "invoice-chaser", task_type: "chase_invoice", input: {} },
  };
}

test("a never-chase rule that names the client holds that chase and shows itself", () => {
  const r = ruleFrom("Never chase anyone at Ravel Systems — they are our biggest retainer.");
  const move = chase("Invoice INV-0001");
  const hit = matchRuleToMove(r, move, "Ravel Systems");
  assert.ok(hit, "the rule must match a chase against Ravel Systems");
  const held = applyStatedRules(move, [r], "Ravel Systems");
  assert.equal(held.takeable, false);
  assert.match(held.unavailable_reason ?? "", /Ravel Systems/);
  const term = held.score_terms.find((t) => t.term === "rule");
  assert.ok(term);
  assert.equal(term.points, RULE_HOLD_POINTS);
  assert.match(term.because, /you said/);
  assert.match(term.because, /Never chase anyone at Ravel Systems/);
  assert.ok(held.score < move.score);
  assert.equal(held.score, move.score + RULE_HOLD_POINTS);
  // Money and deadline stay — hiding them would hide the debt along with the rule.
  assert.ok(held.score_terms.some((t) => t.term === "money"));
  assert.ok(held.score_terms.some((t) => t.term === "deadline"));
  assert.deepEqual(appliedRuleIds(held, [r], "Ravel Systems"), [r.id]);
});

test("the same rule does not hold a chase against a different client", () => {
  const r = ruleFrom("Never chase anyone at Ravel Systems — they are our biggest retainer.");
  const move = chase("Invoice INV-0002");
  assert.equal(matchRuleToMove(r, move, "Northwind Ltd"), undefined);
  const held = applyStatedRules(move, [r], "Northwind Ltd");
  assert.equal(held.takeable, true);
  assert.equal(held.score_terms.some((t) => t.term === "rule"), false);
});

test("a vague rule matches nothing and stays unused", () => {
  const r = ruleFrom("Be polite, and reply quickly.");
  const move = chase("Invoice INV-0001");
  assert.equal(matchRuleToMove(r, move, "Ravel Systems"), undefined);
});

test("a prohibition with no named party does not halt the whole book", () => {
  const r = ruleFrom("Never chase anyone.");
  const move = chase("Invoice INV-0001");
  assert.equal(matchRuleToMove(r, move, "Ravel Systems"), undefined);
});

test("kind: never is enough prohibit-language even without the word never in the text", () => {
  const r = ruleFrom("Ravel Systems is our biggest retainer — leave them alone.", { kind: "never" });
  const move = chase("Invoice INV-0001");
  // Still needs an action verb. This answer has none, so it stays vague — kind alone is not a
  // hunting licence. The next test covers kind + chase.
  assert.equal(matchRuleToMove(r, move, "Ravel Systems"), undefined);
});

test("kind: never plus a chase verb holds the named client", () => {
  const r = ruleFrom("Do not chase Ravel Systems.", { kind: "never" });
  const move = chase("Invoice INV-0001");
  assert.ok(matchRuleToMove(r, move, "Ravel Systems"));
});

test("a prohibition that only names the entity kind does not halt the whole book", () => {
  // "invoice" is on every chase label. Matching it as a party would hold every row.
  const r = ruleFrom("Never chase invoices.");
  const move = chase("Invoice INV-0001");
  assert.equal(matchRuleToMove(r, move, "Ravel Systems"), undefined);
});

test("a named invoice number holds that row", () => {
  const r = ruleFrom("Never chase INV-0001 — they pay on their own cycle.");
  const move = chase("Invoice INV-0001");
  assert.ok(matchRuleToMove(r, move, "Ravel Systems"));
});

test("an inactive rule matches nothing", () => {
  const r = ruleFrom("Never chase anyone at Ravel Systems.", { status: "superseded" });
  const move = chase("Invoice INV-0001");
  assert.equal(matchRuleToMove(r, move, "Ravel Systems"), undefined);
});

test("appliedRuleIds is empty when nothing holds", () => {
  const r = ruleFrom("Be polite.");
  const move = chase("Invoice INV-0001");
  assert.deepEqual(appliedRuleIds(move, [r], "Ravel Systems"), []);
});
