// THE DOMINANT DEFECT IN THIS REPO, MADE UNADDABLE.
//
// Every serious bug found by auditing this codebase has had one shape: a mechanism built,
// documented at length, tested, and connected to nothing. In a single day: the starvation watchdog
// (a backstop for a silently-stalled queue, itself silently never started), `sitequality` (which
// could see the template on a founder's live domain), `research-quality` (a trade body and four
// landing pages arriving at the author labelled the same), `process-mining`, the `observations`
// table, `fetchWithDeadline` (the fix for an outage that took the engine dark for a day, sitting one
// import away from the code still causing it), `evaluatorPrompt`, and the live preview.
//
// Every one was found by LUCK, during an audit somebody happened to run. That is not a process.
//
// `boot-completeness.test.ts` covers two narrow slices of this — a durable store whose `init` boot
// forgot, and a daemon nothing starts. This is the general case, and it is deliberately cruder: it
// cannot know whether a symbol SHOULD be reachable, only whether it IS. What it can do is make the
// number go one direction.
//
// ═══ WHY A RATCHET RATHER THAN A GATE ═══
//
// Sixty-six symbols are unreachable today. Failing on all of them means either a sixty-six-symbol
// refactor in one commit or a skipped test, and both end with nobody running it. This fails when the
// number goes UP. Debt is paid down at whatever pace it can be reviewed; the count only moves one
// way; and — the part that matters — the next mechanism built and left unwired fails CI on the
// commit that builds it, not in an audit six weeks later.
//
// ═══ THE TWO CATEGORIES ARE NOT THE SAME BUG ═══
//
// DEAD is honest waste: nothing anywhere refers to it. Cheap to delete, and deleting it is the fix.
//
// TEST-ONLY is the expensive one, and it is why this file exists. A symbol with tests and no callers
// looks MORE finished than dead code, not less — it has a spec, it has assertions, it passes CI, and
// the tests prove the thing works while proving nothing about whether it runs. That is exactly how
// `starvation.ts` read: a complete, tested watchdog that had never once swept.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ONLY_IN_MONOREPO, inMonorepo } from "./_monorepo";

const SRC = new URL("../src/", import.meta.url).pathname;
const TEST = new URL("./", import.meta.url).pathname;

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) tsFiles(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

const read = (f: string) => readFileSync(f, "utf8");

/**
 * Comments stripped before anything is called reachable.
 *
 * A name written in prose is not a caller. This file learned that on itself: documenting WHY nine
 * shadcn exports are exempt meant writing `RADIUS_CSS` and `fontStack` in a comment, and the scan
 * promptly reclassified both from dead to test-only — a symbol became "covered" because someone
 * described it. Every explanatory comment in the suite was doing some quieter version of this, so
 * the count was always slightly kinder than the truth.
 *
 * TESTS ONLY, and that boundary was measured rather than chosen. Running the same strip over `src/`
 * deleted half of server.ts — a `/*` sequence inside a string or regex literal opens a block the
 * matcher then closes thousands of lines later, and `mountGtm` and seventeen other plainly-wired
 * symbols were reported dead. A regex cannot lex TypeScript. Test files are prose-heavy and
 * literal-light, which is why it is safe here and was not there.
 *
 * The residual gap is known: a source comment naming a symbol still counts as a reference, so the
 * "reachable from another source file" check stays slightly generous. That direction is survivable
 * for a ratchet whose job is to catch the count going UP.
 */
const stripComments = (t: string) =>
  t.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, " ");
const EXPORTED = /^export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z_$][\w$]*)/gm;

/**
 * Symbols that exist FOR the tests, and are therefore correctly unreachable from production.
 *
 * A naming convention rather than a list, so adding a seam does not mean editing this file — and so
 * the convention is worth following. `_resetFooForTests`, `__setCatalogue`, `setDeployClient` are
 * all saying "a test needs to reach inside here", which is a real need and a different thing from
 * an unwired feature.
 */
const SEAM = /(ForTest$|ForTests$|^__|^_reset|^reset[A-Z]|^set[A-Z][A-Za-z]*(Client|Fn|Spawn|Execute)$)/;

/**
 * ═══ THE ONE CATEGORY WHERE "DELETE IT" IS THE WRONG ADVICE ═══
 *
 * `shadcn-preset.ts` is copied BYTE-FOR-BYTE into `cloud/lib/` and `business-template/lib/`, because
 * the three build contexts are separate Docker roots and a shared package one level up is not
 * reachable from any of them. `cloud/test/shared-source.test.ts` holds the reasoning and fails if
 * the copies ever differ.
 *
 * The kernel only validates and stores a preset, so it uses a fraction of the file: nine exports —
 * `RADIUS_CSS`, `fontStack`, and the seven `isPresetX` guards — are referenced from nowhere IN THIS
 * TREE and are load-bearing in the other two. `RADIUS_CSS` is what turns a founder picking "large"
 * into an actual `--radius`.
 *
 * Without this exemption the scan reports them as dead and the failure message says "this one is
 * honest waste and deleting it is the whole fix" — advice that is confidently wrong and whose
 * result is a byte-identity test going red in a tree the deleter was not looking at, or worse,
 * three trees quietly disagreeing about what a preset means.
 *
 * SCOPED TO THE FILE, not to the symbol names, so the exemption cannot rot into a general excuse:
 * anything else built and left unwired in this file still has to answer for itself, because the
 * sibling has to be present for the exemption to apply at all. The kernel ships as its own repo
 * where `cloud/` does not exist — there the file is genuinely kernel-only and the scan judges it
 * normally, which is correct.
 */
const COPIED: { src: string; sibling: string }[] = [
  { src: "shadcn-preset.ts", sibling: "../../../cloud/lib/shadcn-preset.ts" },
];
const copiedElsewhere = (relPath: string): boolean =>
  COPIED.some((c) => c.src === relPath && existsSync(new URL(c.sibling, import.meta.url).pathname));

/**
 * ═══ THE SECOND CATEGORY: CONSUMED BY NAMESPACE ITERATION, WHICH THIS SCAN CANNOT SEE ═══
 *
 * This scan matches identifiers. A module that consumes a whole namespace —
 * `for (const t of Object.values(schema))` — references none of its members by name, so every one of
 * them reads as zero references and lands in `dead`.
 *
 * `src/db/schema.ts` is exactly that: 48 `pgTable` declarations, generated from the DDL in
 * `src/*.pg.ts`, and `src/db/verify.ts` walks all of them at boot to compare the declaration against
 * `information_schema`. Every table IS load-bearing, and `auditLog` is as load-bearing as `tasks`;
 * what the scan is seeing is its own mechanism, not waste.
 *
 * And the failure message's advice — "this one is honest waste and deleting it is the whole fix" — is
 * actively wrong here in a way that costs something. Deleting `auditLog` from the declaration does
 * not remove a table from the database; it removes the only thing that would notice if that table
 * changed shape underneath us. A declaration's correctness IS its completeness.
 *
 * THREE CONDITIONS, all required, so this cannot become a general excuse:
 *
 *   1. The file is one named here. Scoped to the file, like `COPIED` above.
 *   2. It carries the generated banner, so a hand-edited file loses the exemption. Nobody maintains
 *      48 declarations by hand, and if somebody starts, the scan should judge them normally.
 *   3. A file in `src/` actually iterates the namespace. If `verify.ts` is deleted or stops walking
 *      the schema, the declaration really is unreferenced and this stops applying — which is the
 *      honest answer, because then nothing reads it.
 */
const ITERATED: { src: string; consumer: string; walk: RegExp }[] = [
  { src: "db/schema.ts", consumer: "db/verify.ts", walk: /Object\.values\(schema\)/ },
];
const iteratedWholesale = (relPath: string, src: Map<string, string>): boolean =>
  ITERATED.some((i) => {
    if (i.src !== relPath) return false;
    if (!/GENERATED BY/.test(src.get(join(SRC, i.src)) ?? "")) return false;
    return i.walk.test(src.get(join(SRC, i.consumer)) ?? "");
  });

interface Unreachable {
  testOnly: { file: string; name: string }[];
  dead: { file: string; name: string }[];
}

function scan(): Unreachable {
  const src = new Map(tsFiles(SRC).map((f) => [f, read(f)]));
  const tests = tsFiles(TEST).map((f) => stripComments(read(f)));
  const testOnly: { file: string; name: string }[] = [];
  const dead: { file: string; name: string }[] = [];

  for (const [file, text] of src) {
    if (copiedElsewhere(file.slice(SRC.length))) continue;
    if (iteratedWholesale(file.slice(SRC.length), src)) continue;
    for (const m of text.matchAll(EXPORTED)) {
      const name = m[1]!;
      if (SEAM.test(name)) continue;
      const word = new RegExp(`\\b${name.replace(/\$/g, "\\$")}\\b`);

      // Reachable from another source file: wired, and the common case.
      if ([...src].some(([g, v]) => g !== file && word.test(v))) continue;

      const inTests = tests.some((v) => word.test(v));
      // More than one occurrence in its own file means it is used internally and merely exported
      // too broadly — untidy, not the bug this is about.
      const selfUses = (text.match(new RegExp(word.source, "g")) ?? []).length;
      if (selfUses > 1) continue;

      (inTests ? testOnly : dead).push({ file: file.slice(SRC.length), name });
    }
  }
  return { testOnly, dead };
}

/**
 * Today's count. LOWER THESE WHEN YOU WIRE OR DELETE SOMETHING. They may never rise.
 *
 * Measured, not chosen — the output of this same scan on the day it was written.
 */
const BUDGET = { testOnly: 28, dead: 0 };

const report = (rows: { file: string; name: string }[]) =>
  rows.map((r) => `  ${r.file}: ${r.name}`).join("\n");

test("no new mechanism may be built and left unwired", { skip: inMonorepo() ? false : ONLY_IN_MONOREPO }, () => {
  const { testOnly } = scan();
  assert.ok(
    testOnly.length <= BUDGET.testOnly,
    `symbols reachable only from tests rose to ${testOnly.length} (budget ${BUDGET.testOnly}).\n\n` +
      `A symbol with tests and no callers looks MORE finished than dead code, not less: it has a\n` +
      `spec, it passes CI, and its tests prove the thing works while proving nothing about whether\n` +
      `it RUNS. That is how a watchdog for a stalled queue shipped having never swept.\n\n` +
      `Wire it, delete it, or — if a test genuinely needs to reach inside — name it so the seam\n` +
      `convention recognises it (\`_resetX\`, \`setXClient\`, \`xForTests\`).\n\n` +
      report(testOnly),
  );
});

test("dead exports do not accumulate", { skip: inMonorepo() ? false : ONLY_IN_MONOREPO }, () => {
  const { dead } = scan();
  assert.ok(
    dead.length <= BUDGET.dead,
    `symbols referenced from nowhere at all rose to ${dead.length} (budget ${BUDGET.dead}).\n` +
      `This one is honest waste and deleting it is the whole fix.\n\n` + report(dead),
  );
});

test("the budgets follow the work down, or the ratchet goes slack", { skip: inMonorepo() ? false : ONLY_IN_MONOREPO }, () => {
  // Without this the numbers stay at their original value for ever, a later regression hides inside
  // the slack, and the test passes while the thing it guards gets worse. Same rule as the type
  // scale's off-scale budget.
  const { testOnly, dead } = scan();
  const slack = 8;
  assert.ok(
    testOnly.length > BUDGET.testOnly - slack,
    `test-only is down to ${testOnly.length} — lower BUDGET.testOnly to ${testOnly.length}.`,
  );
  assert.ok(
    dead.length > BUDGET.dead - slack,
    `dead is down to ${dead.length} — lower BUDGET.dead to ${dead.length}.`,
  );
});

test("the scan actually resolves this codebase, rather than finding nothing", { skip: inMonorepo() ? false : ONLY_IN_MONOREPO }, () => {
  // A matcher that has drifted reports zero unreachable symbols and passes every assertion above.
  // Silence from a linter must never be indistinguishable from a clean bill of health.
  const { testOnly, dead } = scan();
  assert.ok(testOnly.length + dead.length > 10, "the scan found almost nothing — the regex drifted");
  assert.ok(tsFiles(SRC).length > 200, "the source sweep is not seeing the kernel");
});
