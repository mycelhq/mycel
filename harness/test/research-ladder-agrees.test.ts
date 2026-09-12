// TWO GATES, ONE DEFINITION — again.
//
// `research-a-service.md` tells the run where to look. `research-quality.ts` scores where it looked.
// If the ladder in the skill and the ranking in the scorer disagree, a run that follows its
// instructions exactly gets marked down for it — which is the same failure that cost this repo three
// days of sending on the copy gate, arriving in a different file.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classifySource } from "../src/research-quality";

const skill = () =>
  readFileSync(new URL("../../wedges/business-shaper/skills/research-a-service.md", import.meta.url), "utf8");

test("the ladder in the skill is the ranking in the scorer", () => {
  const t = skill();
  // Rung order, top to bottom, must match SOURCE_WEIGHT's order.
  const rungs = [
    { re: /1 — The trade defining itself/, kind: "primary" },
    { re: /2 — The software the trade lives in/, kind: "vendor_docs" },
    { re: /3 — Practitioners writing at length/, kind: "practitioner" },
    { re: /5 — Sales pages/, kind: "marketing" },
  ];
  let last = -1;
  for (const r of rungs) {
    const at = t.search(r.re);
    assert.ok(at > 0, `the skill has no rung for ${r.kind}`);
    assert.ok(at > last, `${r.kind} is out of order against the scorer's ranking`);
    last = at;
  }
});

test("every kind the scorer can return is somewhere on the ladder", () => {
  // A source kind the skill never mentions is one the run will only find by accident.
  const t = skill().toLowerCase();
  for (const [kind, word] of [
    ["primary", "regulator"],
    ["vendor_docs", "documentation"],
    ["practitioner", "practitioner"],
    ["marketing", "sales page"],
  ] as const) {
    assert.ok(t.includes(word), `${kind} is scored but the skill never tells the run to look there`);
  }
});

test("the search shapes the skill suggests actually classify where it claims", () => {
  // The concrete check: a URL of the shape each rung describes must score as that rung. Otherwise the
  // instruction sends the run somewhere the scorer marks down.
  assert.equal(classifySource("https://www.gov.uk/guidance/x"), "primary");
  assert.equal(classifySource("https://docs.vendor.com/claims"), "vendor_docs");
  assert.equal(classifySource("https://www.reddit.com/r/dentistry/comments/x"), "practitioner");
  assert.equal(classifySource("https://github.com/org/repo"), "practitioner", "rung 4 scores as practitioner, not primary");
  assert.equal(classifySource("https://acme.com/services"), "marketing");
});

test("the run is told the exception path is what is scarce", () => {
  // Every measured miss on a written service was the exception path — the denial, the resubmission,
  // the chase. The happy path is easy to find and is the part that already works.
  const t = skill();
  assert.match(t, /exception path/i);
  assert.match(t, /denial|rejection|resubmission/i);
});

test("the run is told an uncheckable finding is worse than none", () => {
  // `researchQuality` scores an unsourced finding zero. The skill has to say so, or the run will
  // report what it half-remembers and be marked down for honesty it was never asked for.
  assert.match(skill(), /cannot cite it|nobody can check|blocked_by/i);
});
