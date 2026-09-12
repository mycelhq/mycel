// THE VALIDATOR KNEW ABOUT A FIELD THE AUTHOR WAS NEVER TOLD TO WRITE.
//
// Measured, not guessed: every draft_service run in the breadth eval came back with `stages: []`.
// `wedgeauthor.ts` faults when `cases.stages` is missing — but only inside `if (cases !== undefined)`,
// so a manifest that omits the block entirely passes validation with no pipeline at all. And no skill
// in `wedges/business-shaper/skills/` mentioned stages, so the author had no reason to write one.
//
// Two halves of one bug: a check that cannot fire, and an instruction that was never given. This
// asserts the instruction exists, because that is the half that actually changes the output.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const SKILLS = new URL("../../wedges/business-shaper/skills/", import.meta.url);
const allSkills = () =>
  readdirSync(SKILLS)
    .filter((f) => f.endsWith(".md"))
    .map((f) => readFileSync(new URL(f, SKILLS), "utf8"))
    .join("\n\n");

test("the author is told to write cases.stages", () => {
  const text = allSkills();
  assert.match(text, /`cases`/, "no skill mentions the cases block");
  assert.match(text, /stages/, "no skill mentions stages");
  assert.match(text, /initial/, "no skill mentions the initial stage, which the validator checks");
});

test("it says what a stage IS, not just that one is required", () => {
  // The failure mode of a bare requirement is the model listing its jobs again as stages, which
  // produces a pipeline that tells the founder nothing they cannot read above it.
  const text = allSkills();
  assert.match(text, /where work SITS|where a single piece of work actually sits/i, "no guidance on what a stage is");
});

test("every manifest field the validator can fault on is named somewhere in the contract", () => {
  // The general form of this bug. A validator rule for a field no skill mentions is a rule the
  // author can only satisfy by luck.
  const validator = readFileSync(new URL("../src/wedgeauthor.ts", import.meta.url), "utf8");
  const text = allSkills();
  const faulted = new Set<string>();
  for (const m of validator.matchAll(/fault\(\s*`"?([a-z_]+)"?/g)) {
    const field = m[1]!;
    if (field.length > 2) faulted.add(field);
  }
  /**
   * Fields a service may simply not have. The validator faults on them only when the author
   * VOLUNTEERS one and gets it wrong, so silence about them is correct and teaching them would add
   * a field a founder's service does not need.
   *
   * `cases` was in this shape too and did NOT belong here: omitting it is not "this service has no
   * pipeline", it is "the founder cannot see their pipeline". That is the distinction to apply
   * before adding anything to this list.
   */
  const OPTIONAL_BY_DESIGN = new Set(["packs"]);
  const missing = [...faulted].filter((f) => !OPTIONAL_BY_DESIGN.has(f) && !text.includes(f));
  assert.deepEqual(
    missing,
    [],
    `the validator faults on fields no authoring skill mentions: ${missing.join(", ")} — the author cannot satisfy a rule it was never given`,
  );
});
