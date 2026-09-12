#!/usr/bin/env node
// TYPE-CHECKING THE TESTS, on a baseline that may only shrink.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// WHY THIS EXISTS RATHER THAN JUST TURNING IT ON
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// `tsconfig.json` includes `harness/src` and nothing else, so two thousand tests compiled as loose
// JavaScript. That is not a style question. `deploy.test.ts` called
// `supersedeDeployments(projectId, keepId)` after the signature grew a `slug` in the MIDDLE — the
// call went through with `slug = keepId` and `keepId = undefined`, nothing was superseded, and the
// test asserting that a failed row STAYS failed passed for exactly the opposite of the reason it
// claimed. A test that passes for the wrong reason is worse than no test, because it is counted.
//
// Turning the check on surfaces 64 pre-existing errors. Fixing all of them is a real piece of work
// and does not belong inside whatever change happens to notice them, but leaving the check off means
// the next arity change lands the same way. So: the same shape `check-unwired.mjs` uses for routes
// with no caller — a number that is allowed to fall and never to rise.
//
// The value is immediate even at 64. Any NEW test file, and any change that breaks a call that
// currently type-checks, pushes the count up and fails this. The debt is frozen where it is and the
// hole is closed against everything after it.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const BASELINE_FILE = join(ROOT, "scripts", "typecheck-tests.baseline");

let out = "";
try {
  execFileSync("npx", ["tsc", "--noEmit", "-p", "tsconfig.tests.json"], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
} catch (e) {
  out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
}

const errors = out.split("\n").filter((l) => / error TS\d+:/.test(l));
const count = errors.length;
const baseline = Number(readFileSync(BASELINE_FILE, "utf8").trim());

// Per-file, so a message can name where the debt actually is rather than only how much of it there
// is. A count alone tells somebody they made it worse and not where.
const byFile = new Map();
for (const line of errors) {
  const file = line.split("(")[0];
  byFile.set(file, (byFile.get(file) ?? 0) + 1);
}

if (process.argv.includes("--accept")) {
  writeFileSync(BASELINE_FILE, `${count}\n`);
  process.stdout.write(`baseline set to ${count}\n`);
  process.exit(0);
}

if (count > baseline) {
  process.stdout.write(`\n  Test type errors went UP: ${baseline} → ${count}.\n\n`);
  for (const [file, n] of [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    process.stdout.write(`    ${n}  ${file}\n`);
  }
  process.stdout.write(
    `\n  Every one of these is a test the compiler cannot check. The reason this baseline exists is\n` +
      `  in scripts/typecheck-tests.mjs: a call whose signature changed underneath it passed for the\n` +
      `  opposite of the reason it claimed. Fix the new ones — the number may fall, never rise.\n\n`,
  );
  process.stdout.write(`${errors.slice(0, 20).join("\n")}\n`);
  process.exit(1);
}

if (count < baseline) {
  process.stdout.write(
    `\n  ${baseline - count} fewer test type error(s) — ${baseline} → ${count}. Lock it in:\n` +
      `    node scripts/typecheck-tests.mjs --accept\n\n`,
  );
  process.exit(1);
}

process.stdout.write(`✓ test type errors holding at ${count} (baseline ${baseline}); none added.\n`);
