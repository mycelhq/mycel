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
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const PUBLISHER = new URL("../../../scripts/publish-oss.sh", import.meta.url);
const publisher = () => readFileSync(PUBLISHER, "utf8");

/**
 * The publisher is a MONOREPO script and is not itself published — so in a clone these tests were
 * reading a file that is not there and failing, which is precisely the bug they exist to prevent,
 * reproduced by the fix for it. Caught by running the published tree, which is the only way this
 * class of thing is ever caught.
 */
const REWRITE = fileURLToPath(new URL("../../../scripts/oss-rewrite-paths.sh", import.meta.url));
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

test("the rewrite refuses rather than passing on a tree that cannot install", { skip }, () => {
  /**
   * A rewrite that silently no-ops is the same bug with an extra step, so it checks its own work.
   *
   * Asserted by RUNNING it on a file it cannot fix, not by matching its abort message — this used
   * to pin the literal `fail "kernel: a dependency still points outside…"` string, and moving that
   * check into `scripts/oss-rewrite-paths.sh` broke the test while the behaviour was intact.
   */
  const dir = mkdtempSync(join(tmpdir(), "oss-rewrite-bad-"));

  // A spelling no rule knows: a bare `../packages/` in a RUN, with no `file:` and no leading quote.
  // It must ABORT rather than travel — "the rewrite did not recognise it" and "there was nothing to
  // rewrite" look identical from inside the script, and only one of them is safe.
  const bad = join(dir, "Dockerfile");
  writeFileSync(bad, "FROM node:22\nWORKDIR /app\nRUN ln -s ../packages/ghost /app/ghost\n");
  assert.throws(
    () => execFileSync(REWRITE, [bad], { stdio: "pipe" }),
    /still points outside the published tree/,
    "a path the rewrite could not fix must abort the publish, not travel with it",
  );

  // The same path in a COMMENT is documentation and must NOT abort — the Dockerfile's own header
  // quotes `file:../packages/linkedin` to explain why the destination is absolute, and a check that
  // cannot tell an instruction from a sentence about one gets deleted the first time it misfires.
  const fine = join(dir, "Dockerfile.commented");
  writeFileSync(fine, "FROM node:22\n# see file:../packages/linkedin for why\nCOPY packages /packages\n");
  execFileSync(REWRITE, [fine], { stdio: "pipe" });
  assert.match(readFileSync(fine, "utf8"), /^COPY packages \.\/packages$/m, "the directive is still rewritten");
});

/**
 * Run the publisher's ACTUAL rewrite, on a throwaway copy, and look at what comes out.
 *
 * The first version of this parsed `sed` invocations out of the shell script with a regex — which
 * is the brittle-anchor mistake this repo keeps finding, applied to the tool that checks for it. It
 * matched nothing, and only a floor assertion turned that into a failure instead of a pass.
 *
 * `scripts/oss-rewrite-paths.sh` exists so there is ONE definition. Running it is safe: it takes a
 * single file and edits it in place, and every call here passes a copy under `os.tmpdir()`.
 */
function asPublished(source: URL): string {
  const copy = join(mkdtempSync(join(tmpdir(), "oss-rewrite-")), basename(fileURLToPath(source)));
  copyFileSync(source, copy);
  execFileSync(fileURLToPath(new URL("../../../scripts/oss-rewrite-paths.sh", import.meta.url)), [copy]);
  return readFileSync(copy, "utf8");
}

test("the lockfile is rewritten too — every spelling of the path, not just `file:`", { skip }, () => {
  // npm resolves from the lockfile when one is present, so a fixed package.json beside a stale lock
  // reproduces the dangling symlinks with the fix apparently applied — the worst kind of green.
  const src = new URL("../../package-lock.json", import.meta.url);
  assert.match(readFileSync(src, "utf8"), /\.\.\/packages\//, "nothing to rewrite — if that is now true, this test can go");

  const published = asPublished(src);
  assert.ok(
    !published.includes("../packages/"),
    "a path still climbs out of the published tree. npm stores a local package THREE ways — the " +
      "`file:` dep, a standalone entry keyed by a bare relative path, and a `resolved` on the link — " +
      "and rewriting only the first makes `npm ci` fail with 'Missing: @mycel/… from lock file'.",
  );
  // And the rewrite must be real, not a delete: the packages are still there under the new path.
  const lock = JSON.parse(published) as { packages: Record<string, { resolved?: string }> };
  const links = Object.entries(lock.packages).filter(([k]) => k.startsWith("node_modules/@mycel/"));
  assert.ok(links.length > 0, "the workspace links vanished from the lockfile");
  for (const [name, entry] of links) {
    assert.match(entry.resolved ?? "", /^packages\//, `${name} resolves to ${entry.resolved}`);
  }
});

test("the Dockerfile puts the packages where the published manifest looks for them", { skip }, () => {
  /**
   * `COPY packages /packages` is an ABSOLUTE destination so `file:../packages/x` resolves from the
   * `/app` workdir — correct for the monorepo, and wrong the instant the manifest becomes
   * `file:./packages/x`, which means `/app/packages/x`.
   *
   * Getting this wrong does not fail the build. `npm ci` exits 0, writes four dangling symlinks,
   * and the container dies at import — the outage the Dockerfile's own header records.
   */
  const copy = /^COPY packages (\S+)$/m.exec(asPublished(new URL("../../Dockerfile", import.meta.url)));
  if (!copy) return; // no such COPY any more

  const manifest = JSON.parse(asPublished(new URL("../../package.json", import.meta.url))) as {
    dependencies?: Record<string, string>;
  };
  const dep = Object.values(manifest.dependencies ?? {}).find((v) => String(v).startsWith("file:"));
  assert.ok(dep, "no file: dependency to check against");

  // Where npm looks from the `/app` workdir, and where the COPY actually lands.
  const norm = (p: string): string => `/app/${p.replace(/^file:/, "").replace(/^\.\//, "").replace(/\/+$/, "")}`;
  assert.ok(
    norm(String(dep)).startsWith(`${norm(copy[1]!)}/`),
    `the image copies packages to ${copy[1]} but the manifest resolves ${dep} under ${norm(String(dep))} — ` +
      "npm ci will exit 0, leave dangling symlinks, and the container dies at import",
  );
});
