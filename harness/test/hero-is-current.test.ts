// The first image on the README is the product, not a picture of it.
//
// ═══ WHAT THIS REPLACED ═══
//
// The hero was a GIF of the hosted console, filmed against a seed that no longer exists —
// "Ridgeline Books", "Harborline Ceramics", founder@ridgeline.example — none of which `demo:seed`
// has produced since it was renamed. It also showed a UI that IS NOT IN THIS REPOSITORY.
//
// For a project whose whole claim is that its claims are checkable, the first thing on the page was
// neither current nor available. A headless kernel's honest hero is its terminal.
//
// `scripts/render-demo-svg.mjs` runs the demo and draws exactly what it printed. These assert the
// committed SVG is still that — not by re-rendering (that needs a kernel and 6 seconds, which does
// not belong in a unit suite) but by checking it against the code that produces the output.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (p: string): string => readFileSync(fileURLToPath(new URL(`../../${p}`, import.meta.url)), "utf8");
const SVG = read("design/brand/demo.svg");
const README = read("README.md");
const RENDERER = read("harness/scripts/demo.ts");
const SEED = read("harness/scripts/seed-demo.ts");

test("hero: the README points at the generated terminal, not at the retired GIF", () => {
  assert.match(README, /design\/brand\/demo\.svg/, "the README no longer shows the generated hero");
  assert.ok(
    !/next-moves\.gif/.test(README),
    "the GIF is of a seed that no longer exists and a console this repo does not contain",
  );
  // The caption has to say where it came from, or it is just another picture somebody has to trust.
  assert.match(README, /render-demo-svg\.mjs/, "the README must say how to regenerate the hero");
});

test("hero: it shows the business the seed actually builds", () => {
  // The exact failure the GIF had. Read from the seed rather than hardcoded, so renaming the demo
  // business fails this instead of silently making the image wrong again.
  const business = /const BUSINESS_NAME = "([^"]+)"/.exec(SEED)?.[1];
  assert.ok(business, "could not read the seed's business name");
  assert.ok(SVG.includes(business!), `the hero shows a business other than ${business}`);
  assert.ok(!/Ridgeline|Harborline/i.test(SVG), "the retired seed's names are back in the hero");
});

test("hero: it is the demo's own output, in the demo's own shape", () => {
  /**
   * Anchored on the parts of the render that are decisions rather than data: the heading, the
   * score-term join, and the blocked marker. If `demo.ts` changes any of them the image is stale,
   * and the message says to regenerate rather than leaving somebody to guess.
   */
  assert.match(RENDERER, /RANKED NEXT MOVES/, "the renderer no longer prints that heading");
  assert.ok(SVG.includes("RANKED NEXT MOVES"), "the hero does not show the ranking — regenerate it");

  assert.match(RENDERER, /\$\{t\.term\} \+\$\{t\.points\}/, "the score-term format changed");
  assert.match(SVG, /money \+\d/, "the hero shows no score arithmetic — regenerate it");

  assert.match(RENDERER, /⏸/, "the blocked marker changed");
  assert.ok(SVG.includes("⏸"), "the hero shows no blocked move — regenerate it");
});

test("hero: it is a drawing of text, so a reviewer can read the diff", () => {
  // The argument for SVG over a GIF or a cast: no player, no binary blob, and a pull request shows
  // that the numbers moved. If it ever stops being text this stops being true.
  assert.match(SVG, /^<svg /, "the hero is no longer an SVG");
  assert.ok(SVG.length < 60_000, `the hero is ${SVG.length} bytes — too large to review as a diff`);
  assert.ok(!/data:image|<image /.test(SVG), "the hero embeds a raster, which is a blob with an SVG wrapper");
});
