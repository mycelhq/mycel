// THE SHELF HAS TO BE VISIBLE FROM THE RUN THAT MAKES THE THING.
//
// The library was mounted on exactly one task type — `draft_service`, which writes the DEFINITION
// of a service and produces nothing a client opens. Every run that actually delivered saw only the
// skills its wedge named, and no wedge names how to lay out a deck. 205 skills on the shelf, zero
// of them reachable at the moment they were needed.
//
// This is the "built but never invoked" shape, and a grep for `arsenalSkillsForBrief` finding one
// call site is not enough to catch it coming back: the call can survive while the condition around
// it narrows. So these assert on BEHAVIOUR — give it a real brief, get real bodies.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { arsenalSkillsForBrief, pickArsenalBodies } from "../src/skill-arsenal";

test("a brief about a landing page reaches the design shelf, not just the wedge's own skills", () => {
  const got = arsenalSkillsForBrief({
    wedge: "web-development",
    task_type: "build_site",
    input: { brief: "design and build a landing page for a law firm that fights red light camera tickets" },
  });
  assert.ok(got.length > 0, "a site build matched nothing on a 205-skill shelf");
  assert.ok(
    got.some((s) => s.name.startsWith("arsenal/design/") || s.name.startsWith("arsenal/web-development/")),
    `expected design or web craft, got: ${got.map((s) => s.name).join(", ")}`,
  );
});

test("a brief about a report reaches the deliverables shelf", () => {
  const got = arsenalSkillsForBrief({
    wedge: "digital-marketing",
    task_type: "produce_deliverable",
    input: { brief: "quarterly SEO report with charts and a dashboard summarising traffic and rankings" },
  });
  assert.ok(got.length > 0, "a report matched nothing");
});

test("runbooks are mounted WHOLE — a truncated design skill is a run that cannot execute it", () => {
  // The specifics are the value: type scales, spacing rules, the fixed-height chart container that
  // stops Chart.js looping. Those live past the opening paragraph. If a cap is ever reintroduced,
  // this fails rather than the output quietly getting worse.
  const picked = pickArsenalBodies("design a landing page with brand colours and typography", 4);
  assert.ok(picked.length > 0);
  for (const s of picked) {
    const mounted = arsenalSkillsForBrief({
      wedge: "web-development",
      task_type: "build_site",
      input: { brief: "design a landing page with brand colours and typography" },
    }).find((m) => m.name.endsWith(`/${s.name}`));
    if (!mounted) continue;
    assert.equal(mounted.content.length, s.body.length, `${s.name} was mounted truncated`);
    assert.ok(!mounted.content.includes("TRUNCATED at"), `${s.name} carries a truncation marker`);
  }
});

test("the delivery mount is actually wired into runtime.ts, on deliverable shapes", () => {
  // Cheap, and it is the check that would have caught the original bug: the function existed and
  // was correct, and the only condition that reached it was `draft_service`.
  const src = readFileSync(new URL("../src/runtime.ts", import.meta.url), "utf8");
  assert.match(src, /arsenalSkillsForBrief\(task\)/, "runtime.ts never calls arsenalSkillsForBrief");
  assert.match(
    src,
    /profile\.shape === "deliver" \|\| profile\.shape === "build"[\s\S]{0,200}arsenalSkillsForBrief/,
    "arsenalSkillsForBrief is not gated on the deliverable shapes",
  );
});
