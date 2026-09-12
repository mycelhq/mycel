// What "good" means for knowledge work, in gradable terms.
//
// Anthropic's harness-design post (Mar 2026): agents "tend to respond by confidently praising the
// work—even when, to a human observer, the quality is obviously mediocre", and separating the
// generator from the judge is the lever. It also found the criteria pay BEFORE the evaluator
// exists — "outputs were noticeably better than a baseline with no prompting at all" — which is
// why the generator half ships first.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DELIVERABLE_CRITERIA, criteriaAsPromptLines, evaluatorPrompt } from "../src/deliverable-criteria";

test("the heaviest weight is on what actually fails, not what sounds most important", () => {
  // Anthropic weighted design and originality over craft because Claude "already scored well on
  // craft and functionality by default". The point of a weight is to move behaviour that needs
  // moving. Our measurement said the same thing about a different axis: on a real run, grounding
  // and trade fluency were excellent unprompted and the OBJECT was unusable.
  const byId = Object.fromEntries(DELIVERABLE_CRITERIA.map((c) => [c.id, c]));
  assert.equal(byId.artefact!.weight, 3, "the failure we measured is no longer weighted heaviest");
  assert.equal(byId.craft!.weight, 1, "craft is weighted up — models mostly get it right unprompted");
  assert.ok(byId.artefact!.weight > byId.craft!.weight);
});

test("every criterion is gradable about ONE artefact, and names who is disappointed", () => {
  // "Is this design beautiful?" is unanswerable; "does this follow our principles?" is not. A
  // criterion a model cannot picture failing is one it cannot grade.
  for (const c of DELIVERABLE_CRITERIA) {
    assert.ok(c.asks.includes("?"), `${c.id} does not ask a question`);
    assert.ok(c.fails.length > 60, `${c.id} does not describe failing concretely`);
    // Vague virtue words are the thing this file exists to avoid.
    for (const vague of ["high quality", "professional-grade", "best-in-class", "excellent"]) {
      assert.ok(!c.asks.toLowerCase().includes(vague), `${c.id} asks for "${vague}", which is not gradable`);
    }
  }
});

test("generator and evaluator grade against the IDENTICAL words", () => {
  // Two sets of criteria in one feedback loop is how the loop teaches drift.
  const gen = criteriaAsPromptLines().join("\n");
  const evalp = evaluatorPrompt();
  for (const c of DELIVERABLE_CRITERIA) {
    assert.ok(gen.includes(c.title), `generator is missing ${c.id}`);
    assert.ok(evalp.includes(c.title), `evaluator is missing ${c.id}`);
    assert.ok(evalp.includes(c.asks), `evaluator paraphrased ${c.id} instead of reusing it`);
  }
});

test("the evaluator is told to be skeptical, because an LLM grading an LLM is not by default", () => {
  const p = evaluatorPrompt();
  assert.match(p, /You did not write it/i, "the evaluator is not separated from the author");
  assert.match(p, /default is that it is not ready/i, "no skeptical prior");
  assert.match(p, /Do not average your way to a passing verdict/i, "averaging lets one fatal fault pass");
  // A score with no attached change cannot be acted on by the generator.
  assert.match(p, /what specifically would have to change/i);
});

test("a missing input is a named gap, never a filled one", () => {
  const gen = criteriaAsPromptLines().join("\n");
  assert.match(gen, /A named gap is a professional answer; a filled one is not/);
});

test("it is given to deliver runs, or it is another orphan", () => {
  const runtime = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "runtime.ts"),
    "utf8",
  );
  assert.match(runtime, /criteriaAsPromptLines\(\)/, "the criteria reach no run");
  const at = runtime.lastIndexOf("criteriaAsPromptLines()");
  assert.ok(
    runtime.slice(Math.max(0, at - 800), at).includes('profile.shape === "deliver"'),
    "the criteria are not scoped to deliver runs",
  );
});
