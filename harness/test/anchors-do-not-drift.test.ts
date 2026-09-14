// A guard that windows the wrong text is worse than no guard.
//
// See `helpers/anchor.ts` for the failure in full. In short: `src.slice(src.indexOf("…"), …)` reads
// a missing anchor as -1, and `slice` treats a negative start as an offset from the END — so a
// renamed function or heading moves the window instead of failing, and the assertion goes on
// passing against a different part of the file.
//
// This is a RATCHET, in the style of connectivity.test.ts's budgets. There are 60 of these and
// rewriting them all at once would be a large mechanical diff across tests that are otherwise
// correct. The number may fall and may not rise.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { between, after } from "./helpers/anchor";

const DIR = fileURLToPath(new URL(".", import.meta.url));

/** `something.slice(something.indexOf(` — the shape that can silently window from -1. */
const RAW = /\.slice\(\s*[A-Za-z_$][A-Za-z0-9_$]*\.indexOf\(/g;

/**
 * The count when this landed. LOWER IT when you convert call sites; never raise it.
 *
 * Converting one means replacing `x.slice(x.indexOf(a), x.indexOf(b))` with `between(x, a, b)`,
 * which asserts both anchors exist and that the window runs forwards.
 *
 * A shell `grep -o` said 60. It was wrong, because several of these wrap across lines and the
 * pattern only matches when the whitespace is allowed for — which is a small illustration of the
 * same lesson: measure with the thing that will do the checking, not with something that looks
 * close enough.
 */
const BUDGET = 63;

function rawAnchors(): Array<{ file: string; count: number }> {
  return readdirSync(DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".test.ts"))
    .map((e) => ({ file: e.name, count: (readFileSync(`${DIR}${e.name}`, "utf8").match(RAW) ?? []).length }))
    .filter((r) => r.count > 0);
}

test("anchors: the raw slice-on-indexOf count does not grow", () => {
  const found = rawAnchors();
  const total = found.reduce((s, r) => s + r.count, 0);
  assert.ok(
    total <= BUDGET,
    `raw slice(x.indexOf(…)) rose to ${total} (budget ${BUDGET}).\n` +
      `A missing anchor slices from -1 and the assertion moves instead of failing.\n` +
      `Use between()/after() from ./helpers/anchor instead, in:\n` +
      found.map((r) => `  ${r.file}: ${r.count}`).join("\n"),
  );
});

test("anchors: the budget follows the work down, or the ratchet goes slack", () => {
  const total = rawAnchors().reduce((s, r) => s + r.count, 0);
  assert.ok(total > BUDGET - 5, `raw anchors are down to ${total} — lower BUDGET to ${total}.`);
});

// ── The helper itself, because a guard nobody checked is the thing this file is about ──

test("anchors: a missing opening anchor fails instead of windowing from the end", () => {
  const src = "alpha beta gamma";
  // The exact bug: `src.slice(src.indexOf("nope"), 5)` is `src.slice(-1, 5)` — silently "".
  assert.equal(src.slice(src.indexOf("nope"), 5), "", "this is what the raw form does, and why it is banned");
  assert.throws(() => between(src, "nope"), /anchor not found/);
  assert.throws(() => after(src, "nope", 5), /anchor not found/);
});

test("anchors: a missing closing anchor fails too", () => {
  assert.throws(() => between("alpha beta", "alpha", "omega"), /closing anchor not found/);
});

test("anchors: a closing anchor BEFORE the opening one is a missing one", () => {
  // `indexOf(to)` unqualified would find the earlier "alpha" and produce a backwards, empty window.
  // Searching from `start` makes that a stated failure instead.
  assert.throws(() => between("alpha beta alpha-end", "beta", "alpha "), /closing anchor not found/);
});

test("anchors: a found window is exactly the text between them", () => {
  const src = "prefix<<START>>the middle<<END>>suffix";
  assert.equal(between(src, "<<START>>", "<<END>>"), "<<START>>the middle");
  assert.equal(between(src, "<<END>>"), "<<END>>suffix", "no closing anchor means to the end");
  assert.equal(after(src, "<<START>>", 12), "<<START>>the");
});
