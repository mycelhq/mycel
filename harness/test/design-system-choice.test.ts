// A founder could pick a FEELING ("editorial", "bold") and never a LOOK. The archetype implied a
// design system through a seven-entry mapping, so two businesses that both said "editorial" got a
// byte-identical house style with no way to differ, and the 29 vendored systems were unreachable
// from the product entirely.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_DESIGN_SYSTEM,
  designSystemFor,
  designSystemForArchetype,
  designSystemSummaries,
} from "../src/design-systems";

test("an explicit choice wins over the archetype's implication", () => {
  const implied = designSystemForArchetype("editorial");
  assert.equal(designSystemFor({ archetype: "editorial" }), implied);
  assert.equal(designSystemFor({ archetype: "editorial", design_system: "brutalism" }), "brutalism");
});

test("a stored id that no longer exists falls back to the archetype, not to nothing", () => {
  // A system can be renamed or a vendored set trimmed after a founder chose from it. Honouring the
  // dead id would leave a delivering run with no house style at all — worse than the older look.
  assert.equal(designSystemFor({ archetype: "bold-brutalist", design_system: "deleted-system" }), designSystemForArchetype("bold-brutalist"));
  assert.equal(designSystemFor({ design_system: "deleted-system" }), DEFAULT_DESIGN_SYSTEM);
});

test("a design_system that is not a string cannot reach the filesystem", () => {
  // `validIdentity` size-caps a plain object and does not type its fields — it carries design
  // direction between two models. A number would pass a coercing regex test and then throw inside
  // join(), turning a bad stored value into a FAILED RUN rather than a missing house style.
  for (const bad of [5, true, {}, [], "../../package", "a/b", "UPPER"] as unknown[]) {
    const got = designSystemFor({ archetype: "technical", design_system: bad as string });
    assert.equal(got, designSystemForArchetype("technical"), `${JSON.stringify(bad)} was not rejected`);
  }
});

test("every system can be shown in a chooser — a swatch and a sentence", () => {
  // A founder cannot judge a look from its name, and `editorial` / `warm-editorial` / `publication`
  // differ in ways only a picture explains. If a system has no paintable accent it renders as a
  // blank card, which reads as a broken option rather than a subtle one.
  const s = designSystemSummaries();
  assert.ok(s.length >= 20, `expected the shelf, got ${s.length}`);
  for (const x of s) {
    assert.ok(x.swatch.accent, `${x.id} has no accent to paint`);
    assert.ok(x.swatch.paper, `${x.id} has no page colour`);
    assert.match(String(x.swatch.accent), /^#|^rgb|^oklch|^hsl/, `${x.id} accent is not a paintable colour: ${x.swatch.accent}`);
    assert.ok(x.label && x.label !== x.id, `${x.id} has no human label`);
  }
});

test("the chooser payload stays small enough to be a list", () => {
  // The full tokens.css + DESIGN.md is what a RUN mounts. Sending all of it so a browser can paint
  // 29 swatches would be ~250KB to draw four colours each.
  const bytes = JSON.stringify(designSystemSummaries()).length;
  assert.ok(bytes < 30_000, `summaries are ${bytes} bytes — that is a body, not a summary`);
});
