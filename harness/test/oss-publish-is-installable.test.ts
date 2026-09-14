// THE FRONT DOOR OF THE OPEN-SOURCE REPO.
//
// The kernel depends on four in-repo packages by relative path (`file:../packages/linkedin`, …).
// Those paths are correct in this monorepo and meaningless in a repo containing only `kernel/`.
// What a stranger who cloned the published repo actually got:
//
//   npm install   → EXIT 0, and four DANGLING SYMLINKS into ../../../packages
//   node …        → Cannot find module '@mycel/sourcing'
//   docker build  → fails on `COPY packages /packages`
//
// The npm case is the dangerous one. It does not fail, so the first symptom is a crash at boot,
// and the obvious reading of that is "this project is broken" rather than "the tarball was
// incomplete". For a repo whose whole strategy is adoption, that is the worst possible bug.
//
// These assert the publisher still carries the packages and rewrites the paths. They read the
// script rather than run it, because running it pushes to GitHub.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const PUBLISHER = new URL("../../../scripts/publish-oss.sh", import.meta.url);
const publisher = () => readFileSync(PUBLISHER, "utf8");

/**
 * The publisher is a MONOREPO script and is not itself published — so in a clone these tests were
 * reading a file that is not there and failing, which is precisely the bug they exist to prevent,
 * reproduced by the fix for it. Caught by running the published tree, which is the only way this
 * class of thing is ever caught.
 */
const HERE = existsSync(PUBLISHER);
const skip = HERE ? false : "publish-oss.sh is a monorepo script, not part of the distribution";
const manifest = () => JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

test("every workspace dependency the kernel has is vendored by the publisher", { skip }, () => {
  const deps = { ...manifest().dependencies, ...manifest().devDependencies };
  const workspace = Object.entries(deps).filter(([, v]) => String(v).startsWith("file:"));
  assert.ok(workspace.length > 0, "no file: deps — if that is now true, this test can go");

  const sh = publisher();
  /**
   * ═══ THE LIST IS DERIVED, AND THAT IS WHAT IS ASSERTED ═══
   *
   * These three assertions used to pin the IMPLEMENTATION: `archive HEAD packages` (the whole
   * directory) and a hardcoded `-d "$STAGE/packages/linkedin"`. Both were satisfied by a publisher
   * that also shipped `rally` — our laptop LinkedIn runner, which no kernel dependency names — so the
   * test was green while the repo published something that is not the kernel.
   *
   * What matters is the property: the staged set equals the set the manifest declares. A publisher
   * that reads its list out of `package.json` has that property by construction, for packages that do
   * not exist yet as much as for these four.
   */
  assert.match(sh, /file:\.\.\/packages\//, "the publisher no longer derives its list from the kernel's own file: deps");
  assert.match(sh, /git -C "\$ROOT" archive HEAD "packages\/\$pkg"/, "packages are not staged one by one from the derived list");
  assert.match(
    sh,
    /\[ -f "\$STAGE\/packages\/\$pkg\/package\.json" \]/,
    "nothing asserts each derived package actually staged",
  );
  // And the other direction, which is the bug that shipped: nothing extra.
  assert.match(sh, /is staged and the kernel does not depend on it/, "a package the kernel does not need can still ship");
});

test("the publisher refuses rather than shipping a tree that cannot install", { skip }, () => {
  // A rewrite that silently no-ops is the same bug with an extra step, so the script has to check
  // its own work. `fail` is the publisher's abort.
  const sh = publisher();
  const guard = sh.slice(sh.indexOf("vendoring workspace packages"));
  assert.match(guard, /fail "kernel: a dependency still points outside the published tree"/);
});

test("the lockfile is rewritten too, not just the manifest", { skip }, () => {
  // npm resolves from the lockfile when one is present, so a fixed package.json beside a stale lock
  // reproduces the dangling symlinks with the fix apparently applied — the worst kind of green.
  const sh = publisher();
  assert.match(sh, /package-lock\.json/, "the lockfile is never rewritten");
  const loop = sh.slice(sh.indexOf("vendoring workspace packages"));
  assert.ok(
    loop.includes('"$STAGE/package.json"') && loop.includes('"$STAGE/package-lock.json"'),
    "the rewrite does not cover both files",
  );
});

test("the Dockerfile's packages COPY is satisfiable in the published tree", { skip }, () => {
  // `COPY packages /packages` builds here because the context is the monorepo. In the published
  // repo the context is the kernel directory, so the packages have to be inside it.
  const df = readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8");
  if (!/^COPY packages /m.test(df)) return;
  assert.match(
    publisher(),
    /archive HEAD "packages\/\$pkg"/,
    "the Dockerfile COPYs packages/ that the publisher never stages",
  );
});
