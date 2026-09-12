// Whose accent does a deliverable wear?
//
// Two independent sources of styling truth met on every deliver run and neither yielded.
// `editorial/tokens.css` ships `--accent: #9a5a2f`; the brand kit holds whatever the founder chose
// in /settings/brand. Both were mounted, nothing said which was authoritative, and the model
// picked — so an agency's white-labelled report came out in our reference brown about as often as
// in their own colour.
//
// The layering was already written down correctly in `landing/lib/brand/tokens.ts`, adapted from
// open-design's schema: an accent is IDENTITY, and "no fallback can substitute — an agency's accent
// is the whole point of white-labelling, and guessing one is worse than refusing." It was simply
// never applied to the design-system mount.

import { test } from "node:test";
import assert from "node:assert/strict";

import { designSystemFilesFor, designSystemIds } from "../src/design-systems";

const tokensOf = (files: { name: string; content: string }[]) =>
  files.find((f) => f.name === "brand/tokens.css")?.content ?? "";

const someSystem = () => designSystemIds().find((id) => id === "editorial") ?? designSystemIds()[0]!;

test("the business's accent replaces the system's", () => {
  const plain = tokensOf(designSystemFilesFor(someSystem()));
  const branded = tokensOf(designSystemFilesFor(someSystem(), { accent: "#1F4D3A" }));

  assert.match(branded, /--accent:\s*#1F4D3A/, "the founder's accent is not in the tokens");
  // And the system's own is GONE, not merely outranked. A second value left in the file relies on
  // cascade order to resolve it, and an agent reading the file sees two answers to one question.
  const systemAccent = plain.match(/--accent:\s*(#[0-9a-fA-F]{3,8})/)?.[1];
  assert.ok(systemAccent, "the reference system has no literal accent to displace");
  assert.ok(
    !new RegExp(`--accent:\\s*${systemAccent}`).test(branded),
    `the system's own ${systemAccent} survived alongside the brand's`,
  );
});

test("only ONE :root survives — the overlay substitutes, it does not append", () => {
  const branded = tokensOf(designSystemFilesFor(someSystem(), { accent: "#1F4D3A" }));
  assert.equal((branded.match(/:root\s*\{/g) ?? []).length, 1, "a second :root block was appended");
});

test("derived tokens keep deriving, so a brand accent flows through its own hover state", () => {
  // `--accent-hover: color-mix(in oklab, var(--accent), black 8%)`. Freezing that into a literal
  // would leave the hover state the wrong colour — the exact bug a naive find-and-replace creates.
  const branded = tokensOf(designSystemFilesFor("editorial", { accent: "#1F4D3A" }));
  if (/--accent-hover/.test(branded)) {
    assert.match(branded, /--accent-hover:[^;]*var\(--accent\)/, "a derived token stopped deriving");
  }
});

test("the shape of the system is untouched — only identity is overlaid", () => {
  const plain = tokensOf(designSystemFilesFor(someSystem()));
  const branded = tokensOf(designSystemFilesFor(someSystem(), { accent: "#1F4D3A" }));
  // Type scale, spacing and radii are what make it a SYSTEM. Overwriting those would leave the
  // founder with a palette rather than a design system.
  for (const tok of ["--text-base", "--font-display", "--text-xl"]) {
    const before = plain.match(new RegExp(`${tok}:\\s*([^;]+)`))?.[1];
    const after = branded.match(new RegExp(`${tok}:\\s*([^;]+)`))?.[1];
    if (before) assert.equal(after, before, `${tok} was changed by a brand overlay`);
  }
});

test("no brand is not a broken brand — the system stands alone", () => {
  // A project with no accent set must get the reference system intact, not an empty var().
  const none = tokensOf(designSystemFilesFor(someSystem()));
  const empty = tokensOf(designSystemFilesFor(someSystem(), { accent: "  " }));
  assert.equal(empty, none, "a blank accent corrupted the tokens");
  assert.ok(!/--accent:\s*;/.test(none), "an empty accent declaration would drop every rule using it");
});

test("the file says whose colours these are", () => {
  // The agent is told the colours are deliberate and the business's own, so it does not "improve"
  // them back toward the reference system it also knows.
  const branded = tokensOf(designSystemFilesFor(someSystem(), { accent: "#1F4D3A" }));
  assert.match(branded, /THIS BUSINESS'S OWN/, "nothing tells the run the colours are deliberate");
});
