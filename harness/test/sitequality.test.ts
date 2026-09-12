// The site quality metric. The point of these tests is that the score cannot be gamed by the two
// cheapest paths a run will take: recolour and stop, or add files that are not design.

import { test } from "node:test";
import assert from "node:assert/strict";
import { SEED_RESIDUE, scoreSite, siteQualityFault } from "../src/sitequality";

const f = (path: string, text: string) => ({ path, text });

/** A page that reuses one arbitrary class as a system, authors components, and uses tokens. */
const designed = [
  f("components/sections/hero.tsx", 'export const Hero = () => <div className="border-l-[3px] bg-surface" />;'),
  f("components/sections/proof.tsx", 'export const Proof = () => <div className="border-l-[3px]" />;'),
  f("components/sections/pricing.tsx", 'export const Pricing = () => <div className="border-l-[3px]" />;'),
  f("app/page.tsx", "export default function Page() { return null; }"),
];

test("quality: a designed page scores well", () => {
  const q = scoreSite(designed, new Set(["app/page.tsx"]));
  assert.equal(q.authored, 3);
  assert.equal(q.hardcodedColors, 0);
  assert.equal(q.motif?.uses, 3);
  assert.ok(q.score >= 80, `expected a high score, got ${q.score}`);
  assert.equal(siteQualityFault(q, 60), undefined);
});

test("quality: template residue fails regardless of how good the rest is", () => {
  // The exact failure the founder described: a beautiful reskin that is still the seed underneath,
  // deployed under their own domain with a fictional customer's testimonial on it.
  const withResidue = [...designed, f("content/marketing.ts", 'export const quote = "Daniel Osei, Operations lead, Sunset Provisions";')];
  const q = scoreSite(withResidue, new Set(["app/page.tsx"]));
  assert.ok(q.score >= 80, "the rest of the page is still good");
  assert.ok(q.residue.length > 0);
  const fault = siteQualityFault(q, 60);
  assert.match(fault ?? "", /template's own copy/);
  // And it fails even with NO minimum configured — this is a wrong answer, not a low score.
  assert.match(siteQualityFault(q) ?? "", /template's own copy/);
});

test("quality: a recolour-and-stop run scores near zero", () => {
  // globals.css and content/ are the cosmetic paths; neither authors a component, and there is no
  // motif because nothing was composed.
  const reskin = [
    f("app/globals.css", ":root { --accent: oklch(0.7 0.1 150); }"),
    f("content/marketing.ts", 'export const headline = "A real headline";'),
  ];
  const q = scoreSite(reskin, new Set(["app/globals.css", "content/marketing.ts"]));
  assert.equal(q.authored, 0);
  assert.equal(q.motif, null);
  // Token discipline alone is worth 30 and that is correct — it is not nothing, it is just not design.
  assert.ok(q.score <= 30, `a reskin must not clear a real bar, got ${q.score}`);
  assert.match(siteQualityFault(q, 60) ?? "", /below the 60/);
});

test("quality: shadcn output is not authored surface", () => {
  // `npx shadcn add card` writes files nobody designed. Counting them would make the cheapest
  // possible action look like the most productive one.
  const shadcn = [
    f("components/ui/card.tsx", "export const Card = () => null;"),
    f("components/ui/button.tsx", "export const Button = () => null;"),
    f("components/ui/input.tsx", "export const Input = () => null;"),
  ];
  assert.equal(scoreSite(shadcn).authored, 0);
});

test("quality: seed files do not count as authored", () => {
  // Editing a file the template already shipped is filling a form, not designing a page.
  const seed = new Set(["components/sections/hero.tsx"]);
  const edited = [f("components/sections/hero.tsx", 'export const Hero = () => <div className="p-4" />;')];
  assert.equal(scoreSite(edited, seed).authored, 0);
});

test("quality: one hardcoded colour costs the whole token score", () => {
  // "Mostly themed" is not a state worth part-crediting: one hex is one place the dark theme is
  // already wrong, and nobody toggles to find it.
  const withHex = [...designed, f("components/sections/cta.tsx", 'export const Cta = () => <div style={{ color: "#1a1a1a" }} />;')];
  const q = scoreSite(withHex, new Set(["app/page.tsx"]));
  assert.equal(q.hardcodedColors, 1);
  assert.ok(q.notes.some((n) => /hardcoded colour/.test(n)));
});

test("quality: a motif used twice is a decoration, not a system", () => {
  const twice = [
    f("components/sections/a.tsx", 'const A = () => <div className="border-l-[3px]" />;'),
    f("components/sections/b.tsx", 'const B = () => <div className="border-l-[3px]" />;'),
  ];
  assert.equal(scoreSite(twice).motif, null);
});

test("quality: residue strings are distinctive, never generic", () => {
  // A generic phrase would fire on legitimate copy and train everyone to ignore the check.
  for (const s of SEED_RESIDUE) {
    assert.ok(s.length > 12, `"${s}" is too short to be distinctive`);
  }
  const legit = [f("content/marketing.ts", 'export const c = "Get started today. Contact us for a quote.";')];
  assert.equal(scoreSite(legit).residue.length, 0);
});

// ── Sameness across builds ──────────────────────────────────────────────────
//
// Everything above compares one site to the TEMPLATE. These compare two sites to EACH OTHER, which
// is the founder's actual complaint: two builds can each score well against the seed and still be
// the same site with different words.

import { repeatWarning } from "../src/sitequality";

const site = (motif: string, sections: string[], picks: string[] = []) => [
  ...sections.map((n) => f(`components/sections/${n}.tsx`, `const X = () => <div className="${motif}" /><div className="${motif}" /><div className="${motif}" />;`)),
  ...picks.map((n) => f(`components/ui/${n}.tsx`, "export const C = () => null;")),
];

test("variety: two builds with the same decisions fingerprint identically", () => {
  const a = scoreSite(site("border-l-[3px]", ["hero", "proof", "pricing"], ["bento-grid"]));
  const b = scoreSite(site("border-l-[3px]", ["hero", "proof", "pricing"], ["bento-grid"]));
  assert.equal(a.fingerprint, b.fingerprint);
  assert.match(repeatWarning(b.fingerprint, [a.fingerprint]) ?? "", /same motif, sections/);
});

test("variety: a different motif or section plan is a different site", () => {
  const base = scoreSite(site("border-l-[3px]", ["hero", "proof", "pricing"]));
  const otherMotif = scoreSite(site("bg-[oklch(0.2_0_0)]", ["hero", "proof", "pricing"]));
  const otherPlan = scoreSite(site("border-l-[3px]", ["hero", "index", "manifesto"]));
  assert.notEqual(base.fingerprint, otherMotif.fingerprint);
  assert.notEqual(base.fingerprint, otherPlan.fingerprint);
  assert.equal(repeatWarning(otherPlan.fingerprint, [base.fingerprint]), undefined);
});

test("variety: copy is deliberately NOT part of the fingerprint", () => {
  // Two businesses always have different words. Including copy would make every fingerprint unique
  // and the whole check useless — it must compare DECISIONS, not content.
  const one = [f("components/sections/hero.tsx", 'const H = () => <div className="border-l-[3px]">Acme roofing</div>;')];
  const two = [f("components/sections/hero.tsx", 'const H = () => <div className="border-l-[3px]">Sunset dental</div>;')];
  assert.equal(scoreSite(one).fingerprint, scoreSite(two).fingerprint);
});

test("variety: a repeat is a warning, never a hard failure", () => {
  // Two genuinely similar businesses can legitimately want a similar shape. Refusing that is worse
  // than allowing it; what must not happen is the SILENT version.
  const q = scoreSite(site("border-l-[3px]", ["hero", "proof", "pricing"]));
  assert.equal(siteQualityFault(q, 0), undefined);
  assert.ok(repeatWarning(q.fingerprint, [q.fingerprint]));
});
