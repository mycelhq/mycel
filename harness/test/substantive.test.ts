// A BUILD THAT CHANGED NOTHING MUST BE A FAILURE, NOT A SUCCESS.
//
// ── Why this file exists ──
//
// `product-builder` seeds `business-template` and exports what comes back. Every guard around that
// hand-off asked whether the result WORKS — it compiles (`assertRemoteBuildSucceeded`), it boots and
// serves a styled page (`verifyWorkspace`). None asked whether it is DIFFERENT from the scaffold.
//
// So the cheapest green run was: swap the strings in `content/marketing.ts`, nudge the tokens in
// `app/globals.css`, `npx shadcn add` two components to clear the component count, stop. Production
// agrees — completed `build_feature` runs finished in two to three minutes for about a cent of model
// spend against a budget of an hour and five dollars (1c8e93db, 8a90c16f, f3a5e16f, e4dbc13f). The
// founder's words for the result were "it never builds anything new, it just updates global CSS at
// most and deploys the template".
//
// The tests below are that run, reconstructed. Each one is a shape a real build has taken and each
// one must now be reported as a FAILURE whose reason names the files. The last few are the other
// half of the contract and matter just as much: a run that DID author something, and every case
// where the kernel cannot fairly judge, must still pass.
//
//     cd kernel && npx tsx --test harness/test/substantive.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SUBSTANTIVE,
  classifyChange,
  isCosmetic,
  matchesGlob,
  resolveSubstantive,
  sha256,
  sizesFromWc,
  treeFromSeed,
  treeFromSums,
  type Tree,
} from "../src/substantive";

// ── the seed, as the kernel writes it ────────────────────────────────────────────────────────

/** A stand-in for `business-template`: the files a recolour-only run touches, plus one it doesn't. */
const SEED_FILES = [
  { name: "app/page.tsx", content: "export default function Home() {\n  return null;\n}\n" },
  { name: "app/layout.tsx", content: "export default function Layout() {\n  return null;\n}\n" },
  { name: "app/globals.css", content: "@import 'tailwindcss';\n:root { --business-accent: #111; }\n" },
  { name: "content/marketing.ts", content: "export const marketing = { hero: 'before' };\n" },
  { name: "components/marketing.tsx", content: "export function Section() {\n  return null;\n}\n" },
  { name: "package.json", content: '{ "name": "app" }\n' },
];

const seed = () => treeFromSeed(SEED_FILES);

/** The seed, plus/minus whatever this case is about. Mutating a copy keeps each test self-contained. */
function after(changes: Record<string, string | null>): Tree {
  const t: Tree = new Map(seed());
  for (const [path, content] of Object.entries(changes)) {
    if (content === null) t.delete(path);
    else t.set(path, { sha: sha256(content), bytes: Buffer.byteLength(content, "utf8") });
  }
  return t;
}

/** Enough TSX to clear `minChangedBytes`, so a size floor never confuses a structural assertion. */
const REAL_COMPONENT = "export function X() {\n  return null;\n}\n".padEnd(2500, "/");

// ── the failures this was written for ────────────────────────────────────────────────────────

test("a run that changed nothing at all FAILS", () => {
  const r = classifyChange(seed(), seed(), DEFAULT_SUBSTANTIVE);
  assert.equal(r.ok, false);
  assert.match(r.reason!, /changed NOTHING/);
  assert.deepEqual(r.added, []);
  assert.deepEqual(r.modified, []);
});

test("THE BUG: only globals.css touched is a FAILURE, not a success", () => {
  const r = classifyChange(
    seed(),
    after({ "app/globals.css": "@import 'tailwindcss';\n:root { --business-accent: #c2410c; }\n" }),
    DEFAULT_SUBSTANTIVE,
  );
  assert.equal(r.ok, false);
  // The reason has to be readable by the founder reading a failed run, not just true.
  assert.match(r.reason!, /only cosmetic files/);
  assert.match(r.reason!, /app\/globals\.css/);
  assert.match(r.reason!, /recoloured/);
  assert.deepEqual(r.structural, []);
});

test("globals.css plus a copy swap in content/ is still only a recolour, and still FAILS", () => {
  const r = classifyChange(
    seed(),
    after({
      "app/globals.css": "@import 'tailwindcss';\n:root { --business-accent: #0f766e; }\n",
      "content/marketing.ts": "export const marketing = { hero: 'after, at considerable length' };\n",
    }),
    DEFAULT_SUBSTANTIVE,
  );
  assert.equal(r.ok, false);
  assert.match(r.reason!, /only cosmetic files/);
});

test("`npx shadcn add` does not count as authorship — components/ui is not a build", () => {
  // The exact shape that satisfied the manifest's `.mycel-components.json` count check while
  // authoring nothing: two library components dropped in, the theme recoloured, copy swapped.
  const r = classifyChange(
    seed(),
    after({
      "app/globals.css": "@import 'tailwindcss';\n:root { --business-accent: #0f766e; }\n",
      "content/marketing.ts": "export const marketing = { hero: 'after' };\n",
      "components/ui/card.tsx": REAL_COMPONENT,
      "components/ui/marquee.tsx": REAL_COMPONENT,
      "components/.mycel-components.json": '["card","marquee"]',
    }),
    DEFAULT_SUBSTANTIVE,
  );
  assert.equal(r.ok, false);
  assert.match(r.reason!, /only cosmetic files/);
});

test("editing the scaffold's own files without authoring one FAILS on require_new_file", () => {
  const r = classifyChange(
    seed(),
    after({
      "app/page.tsx": REAL_COMPONENT,
      "components/marketing.tsx": REAL_COMPONENT,
      "app/layout.tsx": REAL_COMPONENT,
    }),
    DEFAULT_SUBSTANTIVE,
  );
  assert.equal(r.ok, false);
  assert.match(r.reason!, /no new source file/);
  assert.equal(r.structuralAdded.length, 0);
});

test("one new component is below the file floor and FAILS with the count in the reason", () => {
  const r = classifyChange(seed(), after({ "components/hero-band.tsx": REAL_COMPONENT }), DEFAULT_SUBSTANTIVE);
  assert.equal(r.ok, false);
  assert.match(r.reason!, /only 1 substantive file/);
  assert.match(r.reason!, /components\/hero-band\.tsx/);
});

test("three new but empty files are below the byte floor and FAIL", () => {
  const r = classifyChange(
    seed(),
    after({ "components/a.tsx": "//\n", "components/b.tsx": "//\n", "components/c.tsx": "//\n" }),
    DEFAULT_SUBSTANTIVE,
  );
  assert.equal(r.ok, false);
  assert.match(r.reason!, /bytes across 3 file\(s\)/);
});

// ── and the runs that must still pass ────────────────────────────────────────────────────────

test("a real build — bespoke sections authored and the page restructured — PASSES", () => {
  const r = classifyChange(
    seed(),
    after({
      "components/sections/index-rail.tsx": REAL_COMPONENT,
      "components/sections/specimen-band.tsx": REAL_COMPONENT,
      "components/sections/duotone-work.tsx": REAL_COMPONENT,
      "app/page.tsx": REAL_COMPONENT,
      "app/globals.css": "@import 'tailwindcss';\n:root { --business-accent: #0f766e; }\n",
      "content/marketing.ts": "export const marketing = { hero: 'after' };\n",
    }),
    DEFAULT_SUBSTANTIVE,
  );
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.structuralAdded.length, 3);
  assert.ok(r.changedBytes > 2000);
});

test("no seed means no opinion — the check cannot fire on a wedge that scaffolds nothing", () => {
  const r = classifyChange(new Map(), new Map(), DEFAULT_SUBSTANTIVE);
  assert.equal(r.ok, true);
  assert.equal(r.reason, undefined);
});

test("a deleted seed file is reported but does not on its own make a run substantive", () => {
  const r = classifyChange(seed(), after({ "components/marketing.tsx": null }), DEFAULT_SUBSTANTIVE);
  assert.deepEqual(r.removed, ["components/marketing.tsx"]);
  assert.equal(r.ok, false);
  assert.match(r.reason!, /only cosmetic files|no new source file|substantive file/);
});

// ── the knobs ────────────────────────────────────────────────────────────────────────────────

test("a wedge can relax require_new_file for builds that are genuinely edits", () => {
  const rule = resolveSubstantive({ require_new_file: false, min_changed_files: 2 })!;
  const r = classifyChange(
    seed(),
    after({ "app/page.tsx": REAL_COMPONENT, "components/marketing.tsx": REAL_COMPONENT }),
    rule,
  );
  assert.equal(r.ok, true, r.reason);
});

test("absent, false and true resolve the way the manifest reads", () => {
  assert.equal(resolveSubstantive(undefined), undefined);
  assert.equal(resolveSubstantive(false), undefined);
  assert.deepEqual(resolveSubstantive(true), DEFAULT_SUBSTANTIVE);
  // Extra cosmetic paths are ADDED to the defaults, never replace them — a wedge that names one
  // more file to ignore must not thereby start counting `components/ui` as authorship.
  const r = resolveSubstantive({ cosmetic: ["lib/generated/**"] })!;
  assert.ok(r.cosmetic.includes("components/ui/**"));
  assert.ok(r.cosmetic.includes("lib/generated/**"));
});

// ── the glob dialect and the parsers, because a key mismatch is a silent pass ─────────────────

test("glob-lite matches per segment, with ** spanning them", () => {
  assert.ok(matchesGlob("app/globals.css", "app/globals.css"));
  assert.ok(matchesGlob("content/marketing.ts", "content/**"));
  assert.ok(matchesGlob("content/deep/nested.ts", "content/**"));
  assert.ok(matchesGlob("components/ui/card.tsx", "components/ui/**"));
  assert.ok(matchesGlob("package.json", "**/*.json"));
  assert.ok(matchesGlob("components/.mycel-components.json", "**/*.json"));
  // and the ones that must NOT be cosmetic, or the whole check is decorative
  assert.ok(!matchesGlob("components/hero.tsx", "components/ui/**"));
  assert.ok(!matchesGlob("app/page.tsx", "content/**"));
  assert.ok(!isCosmetic("app/work/page.tsx", DEFAULT_SUBSTANTIVE.cosmetic));
  assert.ok(isCosmetic("app/globals.css", DEFAULT_SUBSTANTIVE.cosmetic));
});

test("sha256sum and wc output parse to keys that match the seed's", () => {
  // `./`-prefixed, as a find-driven invocation produces. If the prefix survived, every file would
  // be both added and removed — which classifies as a PASS, for the worst possible reason.
  const sums = `${sha256("a")}  ./app/page.tsx\n${sha256("b")} *./components/x.tsx\n`;
  const sizes = sizesFromWc("     12 ./app/page.tsx\n    34 ./components/x.tsx\n    46 total\n");
  const t = treeFromSums(sums, sizes);
  assert.deepEqual([...t.keys()].sort(), ["app/page.tsx", "components/x.tsx"]);
  assert.equal(t.get("app/page.tsx")!.bytes, 12);
  assert.equal(t.get("app/page.tsx")!.sha, sha256("a"));
  assert.equal(sizes.has("total"), false);
});

test("an unchanged seed file hashes identically through treeFromSeed and treeFromSums", () => {
  const content = SEED_FILES[0]!.content;
  const t = treeFromSums(`${sha256(content)}  ./app/page.tsx\n`, new Map([["app/page.tsx", 1]]));
  assert.equal(t.get("app/page.tsx")!.sha, seed().get("app/page.tsx")!.sha);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// AND THE SAME THING THROUGH THE REAL PATH.
//
// Everything above is the classifier in isolation. These two use a real LocalSandbox, a real seed
// written by `seedWorkspace`, and the real `find | sha256sum | wc -c` sweep — because the classifier
// being correct proves nothing if the two sides of the comparison are keyed differently. A `./`
// prefix surviving on one side would report the entire tree as added AND removed, which classifies
// as a PASS. That is the failure this pair exists to catch, and it can only be caught against a
// real shell (macOS BSD userland here, busybox in the microVM).
// ─────────────────────────────────────────────────────────────────────────────────────────────
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LocalSandbox } from "../src/sandbox";
import {
  DEFAULT_EXCLUDES,
  assertSubstantiveChange,
  collectTree,
  readSeed,
  resolveWorkspace,
  seedWorkspace,
  type ResolvedWorkspace,
} from "../src/workspace";

const WS = (over: Partial<ResolvedWorkspace> = {}): ResolvedWorkspace => ({
  dir: "app",
  seed: "tpl",
  exclude: DEFAULT_EXCLUDES,
  maxBytes: 10 * 1024 * 1024,
  artifactName: "app.tar.gz",
  verifyTimeoutMs: 60_000,
  requireRemoteBuild: false,
  substantive: DEFAULT_SUBSTANTIVE,
  ...over,
});

/** A template on disk that `readSeed`/`seedWorkspace` will find via MYCEL_TEMPLATES_DIR. */
function templateIn(home: string) {
  for (const f of SEED_FILES) {
    const full = join(home, "templates/tpl", f.name);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, f.content);
  }
  return join(home, "templates");
}

test("END TO END: a run that only recoloured globals.css is FAILED by the hand-off", async () => {
  const sb = new LocalSandbox();
  const prev = process.env.MYCEL_TEMPLATES_DIR;
  process.env.MYCEL_TEMPLATES_DIR = templateIn(sb.home);
  try {
    const ws = WS();
    await seedWorkspace(sb, ws);

    // The agent's entire contribution, faithfully reproduced: new accent, new words. Nothing else.
    await sb.writeFile("app/app/globals.css", "@import 'tailwindcss';\n:root { --business-accent: #c2410c; }\n");
    await sb.writeFile("app/content/marketing.ts", "export const marketing = { hero: 'brand new words' };\n");

    await assert.rejects(
      () => assertSubstantiveChange({ sandbox: sb, ws, seed: readSeed(ws.seed!, ws.exclude) }),
      (e: Error) => {
        // The prefix is load-bearing: the orchestrator's repair loop only retries on it.
        assert.match(e.message, /^workspace verification failed/);
        assert.match(e.message, /only cosmetic files/);
        assert.match(e.message, /app\/globals\.css/);
        return true;
      },
    );
  } finally {
    if (prev === undefined) delete process.env.MYCEL_TEMPLATES_DIR;
    else process.env.MYCEL_TEMPLATES_DIR = prev;
    await sb.destroy();
  }
});

test("END TO END: an untouched seed hashes as unchanged on both sides", async () => {
  const sb = new LocalSandbox();
  const prev = process.env.MYCEL_TEMPLATES_DIR;
  process.env.MYCEL_TEMPLATES_DIR = templateIn(sb.home);
  try {
    const ws = WS();
    await seedWorkspace(sb, ws);

    // The real sweep against the real seed. If the keys or the hashing disagreed at all, this would
    // report files as added or removed — and the whole check would be decorative.
    const { tree, ok } = await collectTree(sb, ws);
    assert.equal(ok, true);
    const report = classifyChange(treeFromSeed(readSeed(ws.seed!, ws.exclude).files), tree, DEFAULT_SUBSTANTIVE);
    assert.deepEqual(report.added, [], "seeding must not invent files");
    assert.deepEqual(report.modified, [], "a byte-identical seed must not read as modified");
    assert.deepEqual(report.removed, [], "every seeded file must be found again");
    assert.equal(report.ok, false);
    assert.match(report.reason!, /changed NOTHING/);

    // And a wedge that never asked for the check is untouched by all of this.
    const quiet = await assertSubstantiveChange({
      sandbox: sb,
      ws: WS({ substantive: undefined }),
      seed: readSeed(ws.seed!, ws.exclude),
    });
    assert.equal(quiet, null);
  } finally {
    if (prev === undefined) delete process.env.MYCEL_TEMPLATES_DIR;
    else process.env.MYCEL_TEMPLATES_DIR = prev;
    await sb.destroy();
  }
});

test("the product-builder manifest actually turns the check on", async () => {
  // A manifest field nobody resolved is the failure mode this whole module was written after, so
  // the wiring is asserted rather than assumed. See `_comment_require_substantive_change`.
  const { loadWedge } = await import("../src/wedge");
  const wedge = loadWedge("product-builder");
  const ws = resolveWorkspace(wedge?.manifest, "build_feature");
  assert.ok(ws, "product-builder build_feature must declare a workspace");
  assert.equal(ws!.seed, "business-template");
  assert.ok(ws!.substantive, "require_substantive_change must resolve to a rule");
  assert.equal(ws!.substantive!.requireNewFile, true);
  assert.equal(ws!.substantive!.minChangedFiles, 3);
  // Cosmetic defaults must survive a manifest that only tuned the numbers.
  assert.ok(ws!.substantive!.cosmetic.includes("components/ui/**"));
  assert.ok(ws!.substantive!.cosmetic.includes("app/globals.css"));
});
