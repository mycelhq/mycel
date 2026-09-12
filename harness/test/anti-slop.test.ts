// THE TASTE, TOLD TO THE AGENT BEFORE IT WRITES.
//
// The forbidden vocabularies have only ever been a GATE: the run finishes, the words are found, the
// work is held, and the founder waits while it is written again. That pays the full cost of a bad
// draft before rejecting it, and teaches the model nothing, because the model never saw the rule.
//
// A separate "now check your writing" pass is worse — another turn, another minute, and another
// chance to rewrite something that was fine. The cheapest place to not produce slop is before
// producing it.
import test from "node:test";
import assert from "node:assert/strict";
import { antiSlopRules, forbiddenPhrases } from "../src/ship-checks";

test("the rules carry the gate's own words, so the two cannot drift", () => {
  // One source, two consumers. A prompt holding its own copy of the list would disagree with the
  // gate within a month, and the failure is silent in the worst direction: work that reads fine to
  // the agent and is held by a check it was never told about.
  const text = antiSlopRules().join("\n");
  for (const phrase of forbiddenPhrases("brand_poetry")) {
    assert.ok(text.includes(phrase), `the prompt must name "${phrase}" — the gate rejects it`);
  }
  for (const phrase of forbiddenPhrases("placeholder")) {
    assert.ok(text.includes(phrase), `the prompt must name "${phrase}"`);
  }
});

test("the positive rules are the larger half", () => {
  // A model told only what NOT to say writes evasively — it swaps "leverage" for "utilise" and
  // produces the same empty sentence. What moves the writing is the instruction about what to do.
  const rules = antiSlopRules();
  const banIndex = rules.findIndex((l) => l.includes("Do not use these words"));
  assert.ok(banIndex > 0, "the ban list exists");
  const before = rules.slice(0, banIndex).join(" ");
  assert.ok(before.length > 400, "the positive rules should outweigh the ban list");
  assert.match(before, /Say the thing/);
  assert.match(before, /Be specific or say you cannot be/);
  assert.match(before, /Recommendations name the work/);
});

test("it names the one rule that ends a relationship", () => {
  // Everything else here is craft. This one is not.
  assert.match(antiSlopRules().join("\n"), /Never claim you did something you did not do/);
});

test("it tells the agent the output is checked, because a rule with no consequence is advice", () => {
  assert.match(antiSlopRules().join("\n"), /checked against this exact list/);
});
