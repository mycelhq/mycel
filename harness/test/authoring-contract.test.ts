// The service authoring contract is the ONE shapeable source of the shaper's rules. These tests keep
// it honest: the skill the shaper actually reads must equal what the code renders (no drift), every
// rule is well-formed, and the rule that cost us the build_website magic-moment failure is present.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SERVICE_AUTHORING_RULES, renderAuthoringContract } from "../src/authoring-contract";

const skillPath = fileURLToPath(new URL("../../wedges/business-shaper/skills/service-authoring-contract.md", import.meta.url));

test("contract: the committed skill the shaper reads is EXACTLY what the code renders — no drift", () => {
  const onDisk = readFileSync(skillPath, "utf8");
  assert.equal(
    onDisk,
    renderAuthoringContract(),
    "service-authoring-contract.md is stale — regenerate it from authoring-contract.ts so the shaper is given the current rules",
  );
});

test("contract: every rule is well-formed and ids are unique", () => {
  const ids = new Set<string>();
  for (const r of SERVICE_AUTHORING_RULES) {
    assert.ok(r.id && /^[a-z0-9-]+$/.test(r.id), `bad id: ${JSON.stringify(r.id)}`);
    assert.ok(!ids.has(r.id), `duplicate rule id: ${r.id}`);
    ids.add(r.id);
    assert.ok(r.guidance.trim().length > 10, `rule ${r.id} has no real guidance`);
    assert.ok(r.why.trim().length > 10, `rule ${r.id} has no reason`);
  }
});

test("contract: the delivery-shape rules that fix iterative work are present", () => {
  const ids = new Set(SERVICE_AUTHORING_RULES.map((r) => r.id));
  // These three are the class of bug that killed a real design-agency signup — they must not be
  // dropped from the contract by a future edit.
  for (const id of ["no-self-resume", "resume-exists", "job-output-schema"]) {
    assert.ok(ids.has(id), `the contract lost the "${id}" rule`);
  }
  const render = renderAuthoringContract();
  assert.match(render, /NEXT stage — never itself/, "the self-resume guidance must reach the shaper verbatim");
});
