// The 29 style systems were vendored and read by nothing — the same shape as `service-skills/`
// shipping without a COPY line. These assert the bytes are reachable and that a deliverable run
// actually mounts them, because "it is on disk" was already true when every deliverable was ugly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DEFAULT_DESIGN_SYSTEM,
  designSystem,
  designSystemFilesFor,
  designSystemForArchetype,
  designSystemIds,
} from "../src/design-systems";

test("the systems are on disk and readable", () => {
  const ids = designSystemIds();
  assert.ok(ids.length >= 20, `expected the vendored shelf, found ${ids.length}`);
  assert.ok(ids.includes(DEFAULT_DESIGN_SYSTEM), `${DEFAULT_DESIGN_SYSTEM} is the fallback and must exist`);
});

test("every archetype the founder can pick resolves to a system that exists", () => {
  // A mapping entry naming a directory nobody vendored degrades to the fallback in silence, which
  // is how "the founder picked bold and got the neutral" happens without anything logging.
  for (const a of ["editorial", "technical", "warm-organic", "bold-brutalist", "minimal-luxury", "playful", "corporate-trust"]) {
    const id = designSystemForArchetype(a);
    assert.ok(designSystem(id), `${a} resolved to "${id}", which is not on disk`);
    assert.notEqual(id, DEFAULT_DESIGN_SYSTEM, `${a} fell through to the fallback — its mapping is broken`);
  }
});

test("an unknown or absent archetype gets a neutral, never our own brand", () => {
  assert.equal(designSystemForArchetype(undefined), DEFAULT_DESIGN_SYSTEM);
  assert.equal(designSystemForArchetype("no-such-archetype"), DEFAULT_DESIGN_SYSTEM);
});

test("an id that is not a slug cannot walk out of the directory", () => {
  assert.equal(designSystem("../../package"), undefined);
  assert.equal(designSystem("a/b"), undefined);
});

test("mounted files carry real token values, not an empty shell", () => {
  const files = designSystemFilesFor("editorial");
  const tokens = files.find((f) => f.name === "brand/tokens.css");
  assert.ok(tokens, "no tokens.css mounted");
  assert.match(tokens!.content, /:root\s*\{/, "tokens.css has no :root block to paste");
  assert.match(tokens!.content, /--accent\s*:/, "tokens.css names no accent");
  assert.ok(files.some((f) => f.name === "brand/DESIGN.md"), "the reasoning did not come with the values");
});

test("designSystemFilesFor is wired into runtime on deliverable shapes", () => {
  // The bug this whole file exists for is unreachable-but-correct code. A behavioural assertion is
  // not available here without booting a run, so assert the wire, and assert it is gated right.
  const src = readFileSync(new URL("../src/runtime.ts", import.meta.url), "utf8");
  assert.match(src, /designSystemFilesFor\(/, "runtime.ts never mounts a design system");
  assert.match(src, /\.\.\.brandFiles,/, "brandFiles is computed but never added to mountedSkills");
  assert.match(
    src,
    /profile\.shape === "deliver" \|\| profile\.shape === "build"[\s\S]{0,120}designSystemFilesFor/,
    "the mount is not gated on deliverable shapes",
  );
});
