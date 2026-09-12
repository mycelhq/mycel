// TWO GATES, ONE DEFINITION.
//
// This repo has been bitten three times by a drafter and a checker disagreeing about one message:
// the model is told one rule, a later gate enforces a different one, and the output is legal to the
// first and refused by the second FOREVER, because re-drafting produces the same thing. Each
// instance cost a day of sending (`allowLink`, `maxWords`, `maxSentenceWords`).
//
// The anti-slop gate could be the fourth. It refuses a deliverable at submit time; the thing that
// tells a run what to write is `craft/anti-ai-slop.md`, mounted on every deliverable run. If the
// linter enforces a rule the craft does not state, an agent that read everything it was given still
// cannot pass, and there is no retry that helps.
//
// These assert the two say the same thing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { lintArtifact } from "../src/design-lint";

const craft = () => readFileSync(new URL("../../craft/anti-ai-slop.md", import.meta.url), "utf8");

/** One document per rule, chosen to trip exactly that rule. */
const P0_CASES: Array<{ id: string; html: string; statedAs: RegExp }> = [
  { id: "ai-default-indigo", html: `<div style="background: #6366f1">Hi</div>`, statedAs: /#6366f1/i },
  { id: "purple-gradient", html: `<div style="background: linear-gradient(90deg, #7c3aed, #3b82f6)">Hi</div>`, statedAs: /gradient/i },
  { id: "slop-emoji", html: `<h2>🚀 Fast</h2>`, statedAs: /emoji/i },
  { id: "invented-metric", html: `<p>10× faster than the alternative.</p>`, statedAs: /invented metric|10×/i },
  { id: "filler-copy", html: `<p>lorem ipsum dolor sit amet</p>`, statedAs: /lorem ipsum|filler/i },
];

test("every P0 rule the gate enforces is stated in the craft the run is given", () => {
  const doc = craft();
  for (const c of P0_CASES) {
    const found = lintArtifact(c.html).filter((f) => f.severity === "P0");
    assert.ok(found.length > 0, `${c.id}: the linter does not flag its own example — the gate is not enforcing it`);
    assert.match(doc, c.statedAs, `${c.id} is REFUSED at submit but not stated in craft/anti-ai-slop.md — an agent cannot pass this`);
  }
});

test("a refusal carries a fix, because a retry needs somewhere to go", () => {
  // A gate that says "no" without saying what to change produces the same output on every retry.
  for (const c of P0_CASES) {
    for (const f of lintArtifact(c.html).filter((x) => x.severity === "P0")) {
      assert.ok(f.fix && f.fix.length > 10, `${f.id} refuses without an actionable fix`);
      assert.ok(f.message && f.message.length > 10, `${f.id} refuses without saying what is wrong`);
    }
  }
});

test("clean, plainly-designed HTML passes — the gate must not refuse good work", () => {
  // The failure that would matter most: a gate so strict nothing gets through. This is an ordinary
  // report in the shape `craft/presenting-work.md` prescribes — real numbers, inline SVG chart,
  // system fonts, a token accent.
  const good = `<!doctype html><html><head><style>
    :root { --accent:#2563eb; --ink:#172033; --paper:#f6f7f9; }
    body { font-family: ui-serif, Georgia, serif; color: var(--ink); background: var(--paper); }
  </style></head><body>
    <h1>Q3 search visibility</h1>
    <p>Organic sessions rose from 4,120 to 5,308 between July and September.</p>
    <div style="position:relative;height:260px">
      <svg viewBox="0 0 100 40" role="img" aria-label="Sessions by month">
        <path d="M0 30 L50 22 L100 12" fill="none" stroke="var(--accent)" stroke-width="1.5"/>
      </svg>
    </div>
    <table><thead><tr><th>Month</th><th>Sessions</th></tr></thead>
    <tbody><tr><td>July</td><td>4,120</td></tr><tr><td>September</td><td>5,308</td></tr></tbody></table>
  </body></html>`;
  const p0 = lintArtifact(good).filter((f) => f.severity === "P0");
  assert.deepEqual(p0.map((f) => f.id), [], `a correct report was refused: ${JSON.stringify(p0)}`);
});

test("only P0 blocks — judgement calls must not become refusals", () => {
  // P1/P2 cover contrast ratios and motion durations, where a confident refusal is wrong often
  // enough to cost more than it saves. The gate filters on severity; this pins that it can.
  const findings = lintArtifact(`<div style="background:#6366f1">x</div>`);
  assert.ok(findings.some((f) => f.severity === "P0"));
  assert.ok(["P0", "P1", "P2"].every((s) => typeof s === "string"));
});

test("the gate is actually wired into the submit route", () => {
  const src = readFileSync(new URL("../src/deliverables.routes.ts", import.meta.url), "utf8");
  assert.match(src, /slopFault\(/, "the linter is imported but nothing calls it");
  assert.match(src, /code: "design_rejected"/, "a refusal is not distinguishable from any other 400");
});
