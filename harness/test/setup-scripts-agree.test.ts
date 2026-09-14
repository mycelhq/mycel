// Windows gets the same product as everyone else.
//
// `setup.sh` and `setup.ps1` are the same onboarding written twice, and the second one drifts
// because nobody on a Mac runs it. It had: "Start the harness: npm run dev / Then POST to
// http://localhost:4000/v1/tasks" — pointing a Windows user at an EMPTY kernel, never mentioning
// `npm run demo`, the no-keys path that is the entire first look. They finished setup and were told
// to POST to a business with nothing in it, while every Unix user was handed a seeded one.
//
// Two scripts, one set of facts, and only one of them is ever exercised here. The same argument as
// `ci-does-not-drift.test.ts` makes about the two CI files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { directives } from "./helpers/directives";

const read = (p: string): string => readFileSync(fileURLToPath(new URL(`../../${p}`, import.meta.url)), "utf8");
// Comments stripped: a comment EXPLAINING a rule satisfies a grep for it. See the helper.
const SH = directives(read("setup.sh"));
const PS = directives(read("setup.ps1"));

test("setup: both scripts offer the same ways in", () => {
  // The entry points a reader is given. Not the wording — the commands.
  for (const command of ["npm run dev", "npm run demo"]) {
    assert.ok(SH.includes(command), `setup.sh no longer offers ${command}`);
    assert.ok(PS.includes(command), `setup.ps1 does not offer ${command}, so Windows gets a lesser first run`);
  }
});

test("setup: both require the same Node, and say where to get it", () => {
  // A floor that differs by platform is a support question nobody can answer from the docs.
  const floor = (s: string): string | undefined => /(?:-ge|-ge |>=\s*|\bge\s+)(\d\d)\b/.exec(s)?.[1];
  // Both undefined compares equal, which would make this pass having read nothing.
  assert.ok(floor(SH), "could not read a Node floor out of setup.sh");
  assert.equal(floor(SH), floor(PS), "the two scripts demand different Node versions");
  assert.match(SH, /nodejs\.org/);
  assert.match(PS, /nodejs\.org/);
});

test("setup: neither tells the reader to paste a variable their shell does not have", () => {
  // The bug from setup.sh, which shipped for months: `-H "authorization: Bearer $MYCEL_API_KEY"`,
  // a variable the script never exports, so the header goes out empty and the request 401s.
  for (const [name, text] of [["setup.sh", SH], ["setup.ps1", PS]] as const) {
    for (const line of text.split("\n")) {
      if (!/\bcurl\b/.test(line)) continue;
      assert.ok(
        !/Bearer\s+\\?\$\{?[A-Za-z_]/.test(line),
        `${name} prints a curl using a shell variable the reader does not have:\n  ${line.trim()}`,
      );
    }
  }
});

test("setup: the ps1 is not a stub of the sh", () => {
  /**
   * A size floor, and it is the cheapest possible proxy for the real property.
   *
   * setup.ps1 was 98 lines against setup.sh's 227 — less than half — and the missing half was
   * exactly the part that tells you what to do next. This does not catch a subtle omission, but it
   * catches the shape the drift actually took, and the three assertions above cover the specifics.
   */
  const ratio = PS.split("\n").length / SH.split("\n").length;
  assert.ok(ratio > 0.4, `setup.ps1 is ${(ratio * 100).toFixed(0)}% the length of setup.sh — something is missing`);
});
