// THE LOOK A CLIENT WAS SHOWN, AND WHY IT MUST NOT MOVE UNDER THEM.
//
// openwork separates execution, scheduling, DATA and PRESENTATION; a run there produces data and a
// receipt, and the renderer is a separate versioned artifact an automation may never regenerate.
// Ours re-derived the look on every run from whatever the brand said at that instant, so a founder
// restyling between a client accepting v1 and asking for one change got v2 back looking like a
// different firm — on the single interaction where the client was already unhappy enough to ask.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describeStyle, resolveStyle, styleDigest, styleForVersion } from "../src/house-style";

const src = (rel: string) => readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), "utf8");

test("house style: the founder naming a look is a choice; us mapping their archetype is not", () => {
  // The distinction is the whole reason `evidence` exists. Collapsing them would report a
  // seven-entry mapping WE wrote back to the founder as their own decision, which is the same class
  // of error as reading derived evidence as observed.
  const chosen = resolveStyle({ identity: { design_system: "brutalism", archetype: "editorial" } });
  assert.equal(chosen.evidence, "chosen");
  assert.equal(chosen.system, "brutalism", "an explicit choice beats the archetype mapping");

  /**
   * AND AN ID WE NO LONGER SHIP IS NOT A CHOICE THEY GOT.
   *
   * `designSystemFor` ignores a stored id that is not on disk and falls back to the archetype, which
   * is right. Labelling that "chosen" would tell a founder they picked a look they were never given
   * — a false statement about their own decision, and worse than the substitution it describes.
   */
  const stale = resolveStyle({ identity: { design_system: "system-we-deleted", archetype: "bold-brutalist" } });
  assert.equal(stale.system, "brutalism");
  assert.equal(stale.evidence, "derived");

  const derived = resolveStyle({ identity: { archetype: "editorial" } });
  assert.equal(derived.evidence, "derived", "an archetype is an inference about them, not a decision by them");

  const fallback = resolveStyle({ identity: {} });
  assert.equal(fallback.evidence, "default");
  assert.equal(resolveStyle(undefined).evidence, "default", "no brand at all is still an honest answer");
});

test("house style: a measurement only wins once the founder has confirmed it", () => {
  // `measured` is the only evidence value that is a claim about somebody ELSE'S brand — made by
  // counting hex codes in a stylesheet we did not write. It is usually right and it is occasionally
  // a third-party widget's palette read as a firm's identity.
  //
  // So an unconfirmed reading must not win. A measurement that silently repainted work a founder was
  // about to send a client is the strongest possible version of the failure `evidence` prevents.
  const unread = resolveStyle({
    identity: { archetype: "bold-brutalist" },
    measured: { colors: ["#c8102e"] },
  });
  assert.equal(unread.evidence, "derived", "an unconfirmed reading was treated as their brand");
  assert.notEqual(unread.accent, "#c8102e");

  const accepted = resolveStyle({
    identity: { archetype: "bold-brutalist" },
    measured: { colors: ["#c8102e", "#00a3ad"], accepted_at: "2026-09-07T00:00:00.000Z" },
  });
  assert.equal(accepted.evidence, "measured");
  // The most frequent chromatic value on the site is the accent by definition. The shelf system
  // stays as the layout and the type; only the colour it wears becomes theirs.
  assert.equal(accepted.accent, "#c8102e");
  assert.equal(accepted.system, "brutalism");
  assert.match(describeStyle(accepted), /measured from your own site/);

  // An accepted reading that found no colour has nothing to contribute and must not claim to.
  const empty = resolveStyle({
    identity: { archetype: "bold-brutalist" },
    measured: { colors: [], accepted_at: "2026-09-07T00:00:00.000Z" },
  });
  assert.equal(empty.evidence, "derived");
});

test("house style: the digest is stable across absent-vs-undefined, so an unchanged look never looks changed", () => {
  const a = styleDigest({ system: "swiss-report", accent: undefined, neutral: undefined });
  const b = styleDigest({ system: "swiss-report" });
  assert.equal(a, b);
  assert.notEqual(a, styleDigest({ system: "swiss-report", accent: "#c33" }), "the accent is part of the look");
  assert.notEqual(a, styleDigest({ system: "other" }));
});

test("house style: a pin always wins, including when it names a system we no longer ship", () => {
  const today = resolveStyle({ identity: { design_system: "brutalism" } });
  const pinned = { system: "system-we-deleted", evidence: "chosen" as const, digest: "x", at: "2026-01-01T00:00:00.000Z" };

  assert.equal(styleForVersion(pinned, today).system, "system-we-deleted");
  // Substituting a system we still have would make the archive quietly untrue rather than visibly
  // incomplete. `designSystemFilesFor` already degrades to no house style for an unknown id.
  assert.equal(styleForVersion(undefined, today).system, "brutalism", "a new deliverable takes today's look");
});

test("house style: the founder is told whose decision the look was", () => {
  assert.match(describeStyle(resolveStyle({ identity: { design_system: "brutalism" } })), /you picked it/);
  assert.match(describeStyle(resolveStyle({ identity: { archetype: "bold-brutalist" } })), /look you described/);
  // An invitation to fix it, not a field name. "default" alone tells a founder nothing to act on.
  assert.match(describeStyle(resolveStyle({ identity: {} })), /you have not chosen one/);
  assert.match(describeStyle(undefined), /No house style pinned/);
});

// ── the wiring, which is the part that has never survived on its own here ────────────────────────

test("house style: a deliverable is pinned at creation, at every place one is created", () => {
  // Two creation sites in the route file. One pinned and one not is worse than neither: it makes the
  // guarantee true for most deliverables, which is exactly how nobody notices the exception.
  const routes = src("deliverables.routes.ts");
  const creates = [...routes.matchAll(/createDeliverable\(\{/g)].length;
  const pins = [...routes.matchAll(/style: resolveStyle\(getIdentityStore\(\)\.brandKit\(/g)].length;
  assert.ok(creates > 0, "the scan found no creation sites — it has drifted");
  assert.equal(pins, creates, `${creates} deliverables created, ${pins} pinned`);
});

test("house style: the runtime renders the pin, not today's brand", () => {
  // THE REGRESSION THIS CATCHES. `designSystemFor(kit?.identity)` inside the mount path is the old
  // behaviour — it re-derives the look every run, which is the bug. It must be reached through
  // `resolveStyle`/`styleForVersion` so a pin can win.
  const rt = src("runtime.ts");
  assert.match(rt, /const style = styleForVersion\(pinned, resolveStyle\(kit\)\)/);
  assert.match(rt, /designSystemFilesFor\(style\.system, \{ accent: style\.accent, neutral: style\.neutral \}\)/);
  assert.ok(
    !/designSystemFilesFor\(designSystemFor\(/.test(rt),
    "the mount still resolves the system fresh — a restyle will change work already in flight",
  );
});

test("house style: the pin is read from the field a regenerating run actually carries", () => {
  // `deliverable_id` is what the regenerate branch passes. Inferring the deliverable from the case
  // instead would guess wrong exactly when a client has two open on one engagement, which is the
  // normal state of a retainer.
  const rt = src("runtime.ts");
  assert.match(rt, /input as \{ deliverable_id\?: unknown \}/);
  const routes = src("deliverables.routes.ts");
  assert.match(routes, /deliverable_id: d\.id, regenerate: true/, "the regenerate path stopped passing the id");
});
