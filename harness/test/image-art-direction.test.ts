// THE INSTRUCTION THAT ASKED THE AGENT TO DO THE WIRING.
//
// `imagetool.ts` used to say: "The house style is in `brand/tokens.css`. Name its accent and surface
// colours in the prompt." That is a correct instruction and it is not integration. It asks a model
// to open a CSS file, find the right custom property among thirty, translate an `oklch(0.62 0.19
// 256)` into words a diffusion model understands, and do it identically for every image in a set —
// on every run, from scratch, with nothing checking that it did.
//
// What comes back when it does not is a generic stock image beside a carefully tokenised page, which
// is the most obvious way a generated artefact announces itself. The kernel is holding the accent at
// the exact moment it writes those tokens; it can just say it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { artDirectionLines, imageToolDoc } from "../src/imagetool";

const provider = { kind: "fal", key: "k", model: "fal-ai/flux/dev" } as const;

test("the palette is named in the guidance, not left in a file to be looked up", () => {
  const doc = imageToolDoc(provider, {
    system: "quiet-authority",
    accent: "oklch(0.62 0.19 256)",
    neutral: "oklch(0.97 0.004 250)",
  }).join("\n");
  assert.match(doc, /oklch\(0\.62 0\.19 256\)/, "the accent must appear literally");
  assert.match(doc, /oklch\(0\.97 0\.004 250\)/);
  assert.match(doc, /quiet-authority/, "and the look it has to match, by name");
  // The pointer to `brand/` STAYS — a deployment with no brand kit still writes those files and the
  // agent still has to match them, so dropping it would be a regression wearing an improvement's
  // clothes. What changed is that the values no longer have to be looked up to be used.
  assert.match(doc, /brand\/tokens\.css/, "the file is still authoritative");
});

test("no brand means no art direction, rather than invented colours", () => {
  assert.deepEqual(artDirectionLines(undefined), []);
  assert.deepEqual(artDirectionLines({}), []);
  assert.deepEqual(artDirectionLines({ accent: "  " }), [], "whitespace is not a palette");
});

test("a partial brand says what it knows and invents nothing", () => {
  const only = artDirectionLines({ accent: "#2b6cb0" }).join("\n");
  assert.match(only, /accent — `#2b6cb0`/);
  assert.doesNotMatch(only, /surface —/, "a neutral nobody set must not be guessed at");

  const sys = artDirectionLines({ system: "editorial" }).join("\n");
  assert.match(sys, /editorial/);
  assert.doesNotMatch(sys, /Name these in the prompt/, "no colours, so nothing to name");
});

test("one treatment across a set is still required, brand or no brand", () => {
  assert.match(artDirectionLines({ system: "editorial" }).join("\n"), /Two images in different styles/);
});

test("the refusals still lead — art direction must not become permission", () => {
  // The expensive mistake with an image tool is decorating, not forgetting it exists. Adding a
  // palette must not move "when NOT to" out of the front of the doc.
  const doc = imageToolDoc(provider, { accent: "#111" }).join("\n");
  const notTo = doc.indexOf("When NOT to use it");
  const palette = doc.indexOf("#111");
  assert.ok(notTo > 0 && notTo < palette, "the refusals come before the house style");
  assert.match(doc, /Never in a report, a statement, an invoice/);
});

test("the model the agent is driving is named", () => {
  // "we need to specify the models" — an agent that does not know what it is prompting cannot
  // prompt it well; FLUX and gpt-image-1 want different language.
  assert.match(imageToolDoc(provider).join("\n"), /fal-ai\/flux\/dev/);
});
