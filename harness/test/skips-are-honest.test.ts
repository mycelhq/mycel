// A published clone is green. This asserts it is green HONESTLY.
//
// A handful of guards read directories that live OUTSIDE the kernel — `infra/`, `cloud/`, the
// publisher — and are deliberately absent from the distribution. `_monorepo.ts` exists so those
// skip BY NAME, with a reason `node:test` prints, and it argues the case in full: "a guard that
// reports success when it measured nothing is the failure mode this repo keeps writing tests to
// avoid."
//
// Two files had drifted off it, in the two shapes that drift:
//
//   memory-loop.test.ts     `const tf = try { read } catch { return "" }`, then
//                           `if (tf) assert.match(…)` — a silent PARTIAL skip. The test printed a
//                           pass while three of its four assertions ran.
//   one-database-url.test.ts  `if (!existsSync(infra)) return;` — the whole body skipped, silently,
//                           on a test whose entire subject is that file.
//
// Neither is catchable by reading a test report, which is the point. Both are trivial to catch here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DIR = fileURLToPath(new URL(".", import.meta.url));

/** Anything climbing above the kernel root is by definition not in the distribution. */
const READS_A_SIBLING = /new URL\("(\.\.\/){3,}/;

test("a test that reads outside the kernel skips by name, not by returning early", () => {
  const offenders: string[] = [];

  for (const entry of readdirSync(DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".test.ts")) continue;
    const src = readFileSync(`${DIR}${entry.name}`, "utf8");
    if (!READS_A_SIBLING.test(src)) continue;

    // Either the shared helper, or a `skip` computed once and spread into the tests — both make
    // node:test print the skip with a reason. What is not acceptable is neither.
    const declared = src.includes("ONLY_IN_MONOREPO") || /\{\s*skip\s*[},]/.test(src);
    if (!declared) offenders.push(entry.name);
  }

  assert.deepEqual(
    offenders,
    [],
    "these read a directory the published kernel does not ship and do not declare a skip, so in a " +
      "stranger's clone they either go red or pass having measured nothing:\n" +
      offenders.map((f) => `  ${f}`).join("\n"),
  );
});

test("the sweep is actually finding the files it is meant to police", () => {
  // The floor. A regex that stops matching turns this whole file into a green that checks nothing —
  // which is the exact failure it was written to prevent, and it has happened twice in this repo
  // already during this pass.
  const reading = readdirSync(DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".test.ts"))
    .filter((e) => READS_A_SIBLING.test(readFileSync(`${DIR}${e.name}`, "utf8")));

  assert.ok(reading.length >= 4, `only ${reading.length} files read a sibling — the scan stopped resolving`);
});
