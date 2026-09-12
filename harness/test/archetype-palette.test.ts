import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveBrandKit } from "../src/brandkit";
import { designFor } from "../src/render/design";
import { designSystemFor, printPaletteFor } from "../src/design-systems";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * ONE MAPPING FROM IDENTITY TO LOOK, AND IT IS THE TWENTY-NINE FILES A DESIGNER WROTE
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * There were two. `ARCHETYPE_SYSTEM` points seven archetypes at the vendored design systems, whose
 * `tokens.css` the model reads while it writes. `brandkit.ts` kept a second hand-typed table of
 * hexes, and THAT is the one the PDF renderer used — so the artifact a client receives was dressed
 * by the copy rather than by the system the founder picked.
 *
 * The copy was also simply wrong. It had Editorial's accent as a near-black; the system says warm
 * brown `#9a5a2f`. It had Brutalism at `#111111`; the system says `#ffef5a`. It had Playful violet
 * where the system is orange. Nobody would have noticed, because nothing compared them.
 */
const kitFor = (archetype: string) =>
  resolveBrandKit({ display_name: "A firm", identity: { archetype } } as never, "A firm");

test("the palette comes from the design system the archetype maps to", () => {
  for (const archetype of ["editorial", "technical", "bold-brutalist", "playful", "corporate-trust"]) {
    const fromSystem = printPaletteFor(designSystemFor({ archetype }));
    const kit = kitFor(archetype);
    assert.equal(kit.accent, fromSystem.accent, `${archetype} is not wearing its system's accent`);
    assert.equal(kit.neutral, fromSystem.ink, `${archetype} is not wearing its system's ink`);
  }
});

test("a dark-themed system contributes its accent and NOT its ink", () => {
  /**
   * Four of the systems are dark — their `--fg` is nearly white because it belongs on a near-black
   * surface. A PDF prints on paper. `minimal-luxury` maps to `luxury`, so taking `--fg` blindly
   * would have produced a blank page for a real archetype, not a hypothetical one.
   */
  const luxury = printPaletteFor("luxury");
  assert.equal(luxury.ink, undefined, "a near-white ink was accepted for print");
  assert.ok(luxury.accent, "the accent was thrown away with it — gold reads fine on paper");

  const kit = kitFor("minimal-luxury");
  assert.equal(kit.accent, luxury.accent, "the identity's accent was lost");
  assert.match(kit.neutral, /^#[0-9a-f]{6}$/);
  assert.notEqual(kit.neutral, "#fff8ea", "white body text on white paper");
});

test("two identities do not render the same page", () => {
  const warm = designFor(kitFor("editorial"));
  const cool = designFor(kitFor("corporate-trust"));
  assert.notEqual(warm.surface.ink, cool.surface.ink, "body ink is identical across two identities");
  assert.notEqual(warm.surface.accent, cool.surface.accent);
});

test("the founder's own colour still beats the system", () => {
  // The rule `withBrandIdentity` already states: an accent is IDENTITY. The system is our guess at
  // what suits them; a hex they typed is a decision, and a guess may never overwrite a decision.
  const chosen = resolveBrandKit(
    { display_name: "A firm", identity: { archetype: "editorial" }, neutral: "#003366", accent: "#ff6600" } as never,
    "A firm",
  );
  assert.equal(chosen.neutral, "#003366");
  assert.equal(chosen.accent, "#ff6600");
});

test("no identity at all still renders", () => {
  const bare = resolveBrandKit(undefined, "A firm");
  assert.match(bare.neutral, /^#[0-9a-f]{6}$/);
  assert.match(bare.accent, /^#[0-9a-f]{6}$/);
  assert.ok(designFor(bare).surface.ink);
});
