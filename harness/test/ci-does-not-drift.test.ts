// The public repo's CI and the monorepo's must agree, or the public one breaks in front of
// strangers.
//
// `.github/workflows/ci.yml` in this directory is INERT upstream: GitHub only reads workflows from
// `.github/` at the repository root, and here that path is `kernel/.github/`. It becomes live the
// moment the publish snapshot lifts `kernel/` to the root. The monorepo's own equivalent is
// `.github/workflows/kernel.yml`, which runs the same steps with `working-directory: kernel`.
//
// Two files, one set of facts, and only one of them is exercised on every commit we make. Its
// header says "keep them in step" and nothing checked. They had already drifted: the published one
// still had the `push: ["**"]` + `pull_request:` pair the monorepo measured and removed, and no
// concurrency group — so every contributor's PR ran twice and no superseded run was ever cancelled.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));
const PUBLIC_CI = readFileSync(here("../../.github/workflows/ci.yml"), "utf8");

/**
 * The workflow with its comments removed.
 *
 * The first version of this test scanned the raw file for `branches: ["**"]` and failed on a file
 * that was already correct — the string was inside the comment explaining what had been REMOVED. A
 * guard on configuration must read configuration; prose that quotes a bad setting is documentation
 * doing its job, not the setting coming back.
 */
const config = (yaml: string): string =>
  yaml
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
const PUBLIC_CONFIG = config(PUBLIC_CI);

/**
 * The monorepo's copy, which is NOT in the published tree.
 *
 * `git archive HEAD kernel/` is the whole publish, so a stranger's clone has no `../.github`. This
 * skips with a reason rather than failing, matching every other test here that names a sibling
 * living in a private monorepo — a clone has to be green HONESTLY.
 */
const MONOREPO_CI = here("../../../.github/workflows/kernel.yml");

test("ci: the published workflow runs once per commit and cancels what it supersedes", () => {
  // True regardless of the monorepo, so it is asserted outside the skip.
  assert.match(PUBLIC_CONFIG, /concurrency:/, "superseded runs must be cancelled, not run to completion");
  assert.match(PUBLIC_CONFIG, /cancel-in-progress:\s*true/);
  assert.ok(
    !/branches:\s*\["\*\*"\]/.test(PUBLIC_CONFIG),
    'push on every branch plus pull_request runs each commit twice — a contributor\'s PR check takes twice as long as it needs to',
  );
  assert.match(PUBLIC_CONFIG, /pull_request:/, "a fork's PR is the only trigger that covers a contributor");
});

test("ci: the two workflows agree on what they run", { skip: existsSync(MONOREPO_CI) ? false : "monorepo .github/workflows/kernel.yml is not in the published tree" }, () => {
  const mono = readFileSync(MONOREPO_CI, "utf8");
  const nodeOf = (s: string): string | undefined => /node-version:\s*"([^"]+)"/.exec(config(s))?.[1];
  assert.equal(
    nodeOf(PUBLIC_CI),
    nodeOf(mono),
    "a stranger's CI would run on a different Node than the one we test on",
  );
  for (const step of ["npm ci", "npx tsc --noEmit", "npm test"]) {
    assert.ok(PUBLIC_CI.includes(step), `the published workflow does not run "${step}"`);
    assert.ok(mono.includes(step), `the monorepo workflow does not run "${step}"`);
  }
  // Both must actually supply Postgres, or the durability and two-backend-parity tests skip in the
  // one place their skipping is invisible.
  for (const [name, text] of [["published", PUBLIC_CI], ["monorepo", mono]] as const) {
    assert.match(text, /MYCEL_TEST_DATABASE_URL/, `${name} CI does not supply Postgres, so the durability tests silently skip`);
  }
});
