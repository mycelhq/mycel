/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * THE REPAIR LOOP RESTORED THE FAULT IT WAS REPAIRING, TWICE, AND CALLED IT A DAY
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A production build, 13 September, from `public.events`:
 *
 *     06:50:06  workspace ~/app: seeded from business-template — 634 files
 *     07:00:25  verification failed — repair round 1 of 2: handing the verify output back
 *     07:02:13  workspace ~/app: seeded from business-template — 634 files      <- wiped
 *     07:08:56  verification failed — repair round 2 of 2
 *     07:10:44  workspace ~/app: seeded from business-template — 634 files      <- wiped again
 *     07:16:57  failed: the deployed site still carries the template's own copy
 *                        (Email from Ana, Sunset Provisions)
 *
 * The fault under repair was TEMPLATE COPY LEFT ON THE PAGE. `orchestrator.ts` re-enters
 * `runOpenCodeTask` against the same live sandbox, `seedWorkspace` overwrote all 634 scaffold files
 * unconditionally, and the agent was then handed a prompt reading:
 *
 *     "Your previous session already built the application in ~/app — do NOT start over and do NOT
 *      scaffold anything new. ... your ONLY job now is to fix the fault below and stop."
 *
 * The one instruction the kernel had just made impossible to obey. Files the agent CREATED survived
 * (the scaffold has nothing at those paths); files it EDITED did not — and the residue lives in
 * exactly those. So the loop could only ever reproduce the fault, and it spent sixteen minutes of
 * sandbox doing so.
 *
 * And it was invisible, because the progress note said the same words all three times.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedWorkspace, type ResolvedWorkspace } from "../src/workspace";

/** A sandbox that is just a directory, so "did the file survive" is a real question with a real answer. */
function fakeSandbox(home: string) {
  const writes: string[] = [];
  return {
    writes,
    async exec(command: string) {
      // Only two shapes are ever run here: `mkdir -p` and the seed-marker probe.
      const mk = /mkdir -p '?([^'\s]+)'?/.exec(command);
      if (mk) {
        mkdirSync(join(home, mk[1]!), { recursive: true });
        return { stdout: "", stderr: "", code: 0 };
      }
      const probe = /test -f ~\/(\S+) &&/.exec(command);
      if (probe) {
        try {
          readFileSync(join(home, probe[1]!));
          return { stdout: "SEEDED\n", stderr: "", code: 0 };
        } catch {
          return { stdout: "", stderr: "", code: 0 };
        }
      }
      return { stdout: "", stderr: "", code: 0 };
    },
    async writeFile(path: string, content: string) {
      const abs = join(home, path);
      mkdirSync(join(abs, ".."), { recursive: true });
      writeFileSync(abs, content);
      writes.push(path);
    },
  };
}

/**
 * A scaffold on disk, reached the way the kernel reaches one: a RELATIVE name under
 * `MYCEL_TEMPLATES_DIR`. `assertSafeRelDir` rejects an absolute seed, which is the check that
 * stopped the first version of this test — worth keeping rather than working around, because the
 * path shape is exactly what `seedCandidates` documents.
 */
function scaffold(): { dir: string; ws: ResolvedWorkspace } {
  const templates = mkdtempSync(join(tmpdir(), "seed-templates-"));
  const root = join(templates, "business-template");
  mkdirSync(join(root, "app"), { recursive: true });
  // The two shapes that matter: a file the agent will EDIT, and one it will leave alone.
  writeFileSync(join(root, "app", "page.tsx"), "export default () => <p>Email from Ana</p>;\n");
  writeFileSync(join(root, "package.json"), '{"name":"business-template"}\n');
  process.env.MYCEL_TEMPLATES_DIR = templates;
  return { dir: templates, ws: { dir: "app", seed: "business-template", exclude: [] } as unknown as ResolvedWorkspace };
}

test("THE SECOND SEED DOES NOT WIPE THE FIRST SESSION'S WORK", async () => {
  const home = mkdtempSync(join(tmpdir(), "seed-home-"));
  const { dir, ws } = scaffold();
  try {
    const sandbox = fakeSandbox(home);

    const first = await seedWorkspace(sandbox, ws);
    assert.ok(first.written >= 2, "the first seed wrote nothing");
    assert.ok(!first.reused, "a fresh workspace reported itself as already seeded");

    // The agent does its work: the template copy is replaced in the file that carries it.
    writeFileSync(join(home, "app", "app", "page.tsx"), "export default () => <p>Northgate Studio</p>;\n");
    writeFileSync(join(home, "app", "app", "pricing.tsx"), "// authored, not in the scaffold\n");

    // The repair round re-enters against the same sandbox.
    const second = await seedWorkspace(sandbox, ws);
    assert.equal(second.written, 0, "the repair round wrote scaffold files over the agent's build");
    assert.equal(second.reused, true, "the reuse is not reported, so the feed cannot say what happened");

    const page = readFileSync(join(home, "app", "app", "page.tsx"), "utf8");
    assert.match(page, /Northgate Studio/, "the agent's edit was reverted");
    assert.doesNotMatch(page, /Email from Ana/, "THE TEMPLATE COPY THE REPAIR WAS ABOUT CAME BACK");
    // And a file the agent created is untouched either way — it was never the part at risk.
    assert.match(readFileSync(join(home, "app", "app", "pricing.tsx"), "utf8"), /authored/);

    /*
      AND THE MARKER IS NOT IN THE WORKSPACE. `substantive.ts` diffs the seeded tree against the
      built one to decide whether the run authored anything; a marker inside ~/app counts as a file
      the AGENT added, inflating the change report and weakening that gate. The first version of
      this put it there and `substantive.test.ts` failed with "seeding must not invent files".
    */
    assert.ok(
      !sandbox.writes.some((w) => /^app\/.*mycel-seeded/.test(w)),
      "the seed marker was written inside the workspace, where it reads as authored work",
    );
    assert.ok(sandbox.writes.some((w) => /mycel-seeded/.test(w)), "no marker was written at all");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a reused workspace still reports the scaffold, so the prompt can describe it", async () => {
  const home = mkdtempSync(join(tmpdir(), "seed-home-"));
  const { dir, ws } = scaffold();
  try {
    const sandbox = fakeSandbox(home);
    const first = await seedWorkspace(sandbox, ws);
    const second = await seedWorkspace(sandbox, ws);
    /**
     * `runtime.ts` writes AGENTS.md from `seeded.files` a few lines after this call — "so the prompt
     * can say what is actually there". Returning an empty file list on reuse would tell the repair
     * session the workspace is bare, which is the same lie in the other direction.
     */
    assert.deepEqual(
      second.files.map((f) => f.name).sort(),
      first.files.map((f) => f.name).sort(),
      "the reused seed forgot what the scaffold contains",
    );
    assert.equal(second.root, first.root);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("A HALF-WRITTEN SEED IS NOT REMEMBERED AS FINISHED", async () => {
  const home = mkdtempSync(join(tmpdir(), "seed-home-"));
  const { dir, ws } = scaffold();
  try {
    const sandbox = fakeSandbox(home);
    const boom = {
      ...sandbox,
      async writeFile(path: string, content: string) {
        if (path.endsWith("package.json")) throw new Error("sandbox died mid-seed");
        return sandbox.writeFile(path, content);
      },
    };
    await assert.rejects(() => seedWorkspace(boom, ws), /sandbox died mid-seed/);
    /*
      The marker is written LAST for this case. Marking first would remember a partial scaffold as
      complete, and every later attempt would skip it — a run starting from half a template, which
      is worse than the bug this whole file is about.
    */
    const retry = await seedWorkspace(sandbox, ws);
    assert.ok(!retry.reused, "a seed that crashed halfway was remembered as finished");
    assert.ok(retry.written >= 2, "the retry did not complete the scaffold");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the feed says which of the three things happened", () => {
  const runtime = readFileSync(new URL("../src/runtime.ts", import.meta.url).pathname, "utf8");
  /**
   * This note already existed because "a seed that silently no-ops and a seed that never ran leave
   * identical feeds". Reuse was a third case it could not say, and printing the first-seed sentence
   * for it is how a loop that wiped the agent's work three times read as normal.
   */
  assert.match(runtime, /seeded\.reused/, "the feed cannot distinguish a reuse from a fresh seed");
  assert.match(runtime, /left exactly as the previous session left it/);
  assert.match(runtime, /created empty — this wedge declares no scaffold/, "the empty case was lost");
});
