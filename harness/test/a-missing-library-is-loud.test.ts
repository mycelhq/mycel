/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * SIX SILENT FAILURES BECOME ONE LINE IN THE LOG
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Grouping the runtime library under `library/` stops the DOCKERFILE forgetting. It does not stop a
 * bad mount, a wrong `MYCEL_*_DIR`, a partial image, or a self-hoster who copied six of seven — and
 * every one of those reproduces the original bug, because every resolver in `library.ts` fails SOFT.
 * `listPacks()` returns `[]`. `sharedCraft()` returns `[]`. `designSystemIds()` returns `[]`. The
 * container is healthy and the product is quietly worse.
 *
 * All six instances were found by somebody eventually running the built image and looking. This is
 * that look, performed at boot by the process that knows where it expects things to be, and readable
 * from `/health` by a deployment nobody can exec into.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { libraryGapReport, libraryGaps, libraryPath } from "../src/library";

const NONE = () => false;
const ALL = () => true;

test("a healthy install reports nothing", () => {
  assert.deepEqual(libraryGaps(ALL), []);
  assert.equal(libraryGapReport(libraryGaps(ALL)), "", "a healthy kernel prints a block at every boot");
});

test("EVERY ENTRY IS CHECKED — the list cannot quietly shrink", () => {
  /*
    The guard this file exists to be. `craft-ships.test.ts` used to assert seven hardcoded COPY lines
    and said "the list is the point"; `packs` was the eighth, never on it, and the guard stayed green
    while four shipped wedges declared a pack they could never reach. A hand-maintained population
    fails the same way as the thing it guards.

    So this cross-checks the report against the RESOLVERS in the source: anything `libraryPath("x")`
    names must appear in the boot check.
  */
  const src = ["blueprints", "craft", "design-systems", "packs", "skill-library", "wedge", "workspace"]
    .map((f) => readFileSync(new URL(`../src/${f}.ts`, import.meta.url), "utf8"))
    .join("\n");
  const resolved = new Set([...src.matchAll(/libraryPath\(\s*"([a-z-]+)"/g)].map((m) => m[1]!));
  assert.ok(resolved.size >= 6, `the resolver scan found ${resolved.size} entries — it stopped working`);

  const checked = new Set(libraryGaps(NONE).map((g) => g.entry));
  for (const name of resolved) {
    assert.ok(checked.has(name), `\`${name}\` is resolved from the library and the boot check never looks for it`);
  }
});

test("the report names the COST, not the directory", () => {
  /**
   * Written for whoever is reading a container log at 2am. "packs/ not found" is a fact about our
   * filesystem; "every declared pack is unreachable" is what it means for the business, and it is the
   * sentence that gets somebody to act on it.
   */
  const report = libraryGapReport(libraryGaps(NONE));
  assert.match(report, /every declared pack is unreachable/);
  assert.match(report, /degrades to no house style/);
  assert.match(report, /seeds EMPTY/);
  // And the path it actually looked in, because "missing" with no location is unactionable.
  assert.match(report, /looked in .*packs/);
});

test("an env override moves where it looks", () => {
  // A gap must be reported against the path this process will really read, not against the default —
  // otherwise a deployment that redirects one entry is told its correct install is broken.
  const before = process.env.MYCEL_PACKS_DIR;
  try {
    process.env.MYCEL_PACKS_DIR = "/somewhere/else/packs";
    const gap = libraryGaps(NONE).find((g) => g.entry === "packs")!;
    assert.equal(gap.path, "/somewhere/else/packs");
  } finally {
    if (before === undefined) delete process.env.MYCEL_PACKS_DIR;
    else process.env.MYCEL_PACKS_DIR = before;
  }
});

test("MYCEL_LIBRARY_DIR moves the whole set at once", () => {
  // The thing that was previously impossible: seven `join(process.cwd(), ...)` calls had no common
  // handle, so relocating the library meant setting seven variables and remembering all seven.
  const before = process.env.MYCEL_LIBRARY_DIR;
  try {
    process.env.MYCEL_LIBRARY_DIR = "/mnt/mycel-library";
    assert.equal(libraryPath("craft"), "/mnt/mycel-library/craft");
    assert.equal(libraryPath("workflows"), "/mnt/mycel-library/workflows");
  } finally {
    if (before === undefined) delete process.env.MYCEL_LIBRARY_DIR;
    else process.env.MYCEL_LIBRARY_DIR = before;
  }
});

test("IT IS WIRED — boot prints it and /health serves it", () => {
  /*
    The "built but never invoked" guard. A perfect report that nothing calls is the same silence it
    was written to break, and this repo has shipped exactly that before — `propose_reply` was
    declared, routed, and never once run.
  */
  const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(index, /libraryGaps\(/, "boot does not check the library");
  assert.match(index, /libraryGapReport\(/, "boot checks the library and prints nothing");

  const server = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  const health = server.slice(server.indexOf('app.get("/health"'), server.indexOf('app.get("/health"') + 600);
  assert.match(health, /libraryGaps\(/, "/health cannot be asked whether the library is there");
});

test("a missing library does not make /health say the API is down", () => {
  // `ok` stays true and that is deliberate: the API genuinely works, which is the entire problem
  // being reported. Flipping it would take the container out of service for a degradation that a
  // restart cannot fix, turning a quiet fault into an outage.
  const server = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  const health = server.slice(server.indexOf('app.get("/health"'), server.indexOf('app.get("/health"') + 600);
  assert.match(health, /ok: true/);
});
