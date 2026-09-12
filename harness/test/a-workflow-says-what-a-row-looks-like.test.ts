// AN ARRAY INPUT WITH NO ITEM SHAPE IS A CONTRACT THE AGENT HAS TO GUESS.
//
// ═══ HOW THIS WAS FOUND ═══
//
// `review_pipeline` scored 0.6 against a 0.7 floor on a hand-written prospect list. The judge said
// it "fails to identify the duplicate pairs" and "fails to identify any dormant prospects".
//
// The agent had done everything right. The trace shows `workflow:crm_hygiene` called correctly.
// Running that library directly on the same records explained it:
//
//   · it reads `email`, `linkedin_url`, `phone` — the records said `contact`, so all eight came back
//     "no way to reach them at all" and the confident-merge path (an exact email match) could not
//     fire at all;
//   · it reads `last_touched_at` or `updated_at` — the records said `last_touch`, so every row
//     scored `undefined` and `dormant` returned `[]`.
//
// The declared schema was `records: { type: "array" }`. Nothing else. So there was no way for the
// caller to know, the workflow read nothing, and it returned empty sections that the run reported —
// faithfully — as measured zeros.
//
// ═══ WHY THIS IS THE GUARD, AND NOT A WORD LIST ═══
//
// The first cut of this audit scanned the .mjs for `r.<field>` and compared against the schema. It
// found the three real cases and then a tail of false positives — `computed`, `movement`, `n` — which
// are internal accumulators on objects that happen to be named `r`. A guard with noise in it is one
// people learn to skip.
//
// The property is structural instead: an array of OBJECTS in a workflow's input schema must say what
// an object looks like. That is checkable without reading the implementation, it cannot drift, and it
// is exactly the information the agent is missing.

import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const WEDGES = join(import.meta.dirname, "..", "..", "wedges");

/**
 * Arrays that are plainly scalars — a list of names, a list of ids — need no item shape. Keyed on
 * the description saying so, rather than on a hardcoded list of property names that would go stale.
 */
const SCALAR_HINT = /\b(names?|ids?|slugs?|strings?|urls?|domains?|emails?|words?|tags?)\b/i;

test("every array of objects a workflow accepts declares what a row looks like", () => {
  const offenders: string[] = [];
  let checked = 0;

  for (const w of readdirSync(WEDGES)) {
    const p = join(WEDGES, w, "wedge.json");
    if (!existsSync(p)) continue;
    const manifest = JSON.parse(readFileSync(p, "utf8"));
    for (const wf of manifest.workflows ?? []) {
      const props = wf?.input_schema?.properties ?? {};
      for (const [name, spec] of Object.entries<Record<string, unknown>>(props)) {
        if (spec?.type !== "array") continue;
        checked++;
        const items = spec.items as Record<string, unknown> | undefined;
        // A declared scalar array is fine and complete.
        if (items && items.type && items.type !== "object") continue;
        if (!items && SCALAR_HINT.test(String(spec.description ?? ""))) continue;
        const shape = (items?.properties ?? undefined) as Record<string, unknown> | undefined;
        if (!shape || Object.keys(shape).length === 0) {
          offenders.push(`${w}/${wf.name}.${name}`);
        }
      }
    }
  }

  assert.ok(checked >= 5, `only ${checked} array inputs found — this guard is measuring nothing`);
  assert.deepEqual(
    offenders,
    [],
    "these workflows take rows and never say what a row looks like, so a caller must guess the field " +
      "names — and a wrong guess returns an empty section that reads as a measured zero:\n  " +
      offenders.join("\n  "),
  );
});

test("the three that caused this name the fields their library actually reads", () => {
  /**
   * Pinned by FIELD, not by "has an items block", because the failure was specific: `email` is what
   * makes a merge confident, and `last_touched_at` is the only thing the dormant pass reads. A schema
   * that declared `items: { type: "object" }` with a vague blob would satisfy the structural test
   * above and still leave the caller guessing these two.
   */
  const want: Record<string, string[]> = {
    "gtm-operator|crm_hygiene|records": ["email", "last_touched_at", "linkedin_url", "phone", "stage"],
    "books-keeper|close_figures|transactions": ["amount_minor", "category", "date"],
    "gtm-operator|win_patterns|leads": ["stage", "attributes"],
  };

  for (const [key, fields] of Object.entries(want)) {
    const [wedge, wfName, prop] = key.split("|");
    const manifest = JSON.parse(readFileSync(join(WEDGES, wedge, "wedge.json"), "utf8"));
    const wf = (manifest.workflows ?? []).find((x: { name: string }) => x.name === wfName);
    assert.ok(wf, `${wedge} no longer declares a ${wfName} workflow — this guard is measuring nothing`);
    const shape = wf.input_schema?.properties?.[prop]?.items?.properties ?? {};
    for (const f of fields) {
      assert.ok(f in shape, `${key} does not name \`${f}\`, which its library reads literally`);
    }
  }
});
