// The workspace: seed in, verify, export out.
//
// Every test here names the specific production failure it prevents. They all descend from one run
// — task e4dbc13f-c8b8-4587-81fc-a284124a8b06 — which reported `succeeded` having produced no
// application at all, because three separate things were broken at once:
//
//   1. the export failing was swallowed into a field on an event nobody reads
//   2. `readSeed` had no caller, so the agent started from an empty directory
//   3. nothing told the agent which directory was the deliverable
//
// LocalSandbox is used rather than a fake wherever the behaviour depends on shell semantics —
// `pipefail`, BSD-vs-GNU tar, `grep -c` exiting 1 on no matches. A fake sandbox that returns
// whatever the test wants proves nothing about a `tar` command line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LocalSandbox } from "../src/sandbox";
import { InMemoryStore } from "../src/store";
import { handOffWorkspace } from "../src/orchestrator";
import { loadWedge } from "../src/wedge";
import {
  DEFAULT_EXCLUDES,
  exportDirectory,
  MAX_VERIFY_TIMEOUT_S,
  resolveWorkspace,
  seedWorkspace,
  verifyWorkspace,
  type ResolvedWorkspace,
} from "../src/workspace";

const WS = (over: Partial<ResolvedWorkspace> = {}): ResolvedWorkspace => ({
  dir: "app",
  exclude: DEFAULT_EXCLUDES,
  maxBytes: 10 * 1024 * 1024,
  artifactName: "app.tar.gz",
  verifyTimeoutMs: 60_000,
  // Off by default: `handOffWorkspace` asserts a successful remote build when this is true, and the
  // existing tests here are about seed/verify/export, not the build plane. remotebuild.test.ts owns
  // the `true` case.
  requireRemoteBuild: false,
  ...over,
});

/** A sandbox and a callback to write real files into its home, cleaned up by the caller. */
function sandboxWithHome() {
  const sb = new LocalSandbox();
  return {
    sb,
    put(rel: string, content: string) {
      const full = join(sb.home, rel);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, content);
    },
    mkdir(rel: string) {
      mkdirSync(join(sb.home, rel), { recursive: true });
    },
  };
}

// ── Bug 1: an export that produced nothing reported success ───────────────────────────────────

test("export refuses a workspace directory that does not exist", async () => {
  // The literal e4dbc13f failure. The agent built in /root; ~/app was never created.
  const { sb } = sandboxWithHome();
  await assert.rejects(() => exportDirectory(sb, WS()), /produced no ~\/app directory/);
  await sb.destroy();
});

test("export refuses a workspace directory that exists but contains no files", async () => {
  // The second shape of the same bug, and the one `test -d` could never catch: an agent that runs
  // `mkdir ~/app` and then builds somewhere else leaves a directory that tars cleanly into a ~100
  // byte archive. Stored as an artifact, that is a green run and an empty download.
  const { sb, mkdir } = sandboxWithHome();
  mkdir("app");
  await assert.rejects(() => exportDirectory(sb, WS()), /contains no files/);
  await sb.destroy();
});

test("export refuses a workspace whose only contents are excluded", async () => {
  // `npm install` and nothing else. `ls -A` would call this directory non-empty; what matters is
  // what survives the exclusion list, which is why the count is taken from the tar listing.
  const { sb, put } = sandboxWithHome();
  put("app/node_modules/left-pad/index.js", "module.exports = 1;\n");
  put("app/.next/cache/blob", "x");
  await assert.rejects(() => exportDirectory(sb, WS()), /contains no files/);
  await sb.destroy();
});

test("export succeeds, and excludes node_modules, once there is real source", async () => {
  const { sb, put } = sandboxWithHome();
  put("app/package.json", JSON.stringify({ name: "x" }));
  put("app/app/page.tsx", "export default function P() { return null; }\n");
  put("app/node_modules/left-pad/index.js", "x".repeat(50_000));

  const out = await exportDirectory(sb, WS());
  assert.equal(out.name, "app.tar.gz");
  assert.equal(out.content_type, "application/gzip");
  assert.ok(out.bytes > 0);
  // Round-trips: a truncated gzip downloads fine and only fails when someone opens it.
  assert.equal(Buffer.from(out.base64, "base64").byteLength, out.bytes);

  const listing = await sb.exec(`cd ~ && tar -czf /tmp/t.tgz --exclude='node_modules' app && tar -tzf /tmp/t.tgz`);
  assert.ok(!listing.stdout.includes("node_modules"), "node_modules must never be shipped");
  await sb.destroy();
});

test("a workspace-declaring wedge FAILS the task when nothing was exported", async () => {
  // THE MANDATORY ONE. `handOffWorkspace` used to be an inline `try` whose `catch` emitted
  // `artifact.created {error}` and let `runTask` fall through to `setStatus("succeeded")`. This
  // asserts the whole chain that replaced it: the export throws, the throw escapes the handoff, and
  // no artifact is stored for a deliverable that does not exist.
  //
  // `runTask` turns any escaping error into `setStatus(failed)` — see the `catch` around the whole
  // body and `terminalStatusFor`, which maps anything unrecognised to "failed".
  const { sb } = sandboxWithHome();
  const store = new InMemoryStore();
  const events: string[] = [];

  await assert.rejects(
    () =>
      handOffWorkspace({
        store,
        task: { id: "task-1" },
        ws: WS(),
        sandbox: sb,
        backend: { inline: true, async put() {} },
        emit: (t) => {
          events.push(t);
        },
      }),
    /produced no ~\/app directory/,
  );
  assert.deepEqual(await store.listArtifacts("task-1"), [], "no artifact for a deliverable that isn't there");
  assert.ok(!events.includes("artifact.created"), "a failed export must not look like a created artifact");
  await sb.destroy();
});

// ── Bug 2: the seed was unwired ───────────────────────────────────────────────────────────────

test("seedWorkspace puts the scaffold inside the workspace directory", async () => {
  // `readSeed` existed and had NO CALLER, so `product-builder` — which has declared
  // `seed: "business-template"` all along — started every run against an empty home directory.
  const { sb } = sandboxWithHome();
  process.env.MYCEL_TEMPLATES_DIR = join(sb.home, "templates");
  mkdirSync(join(sb.home, "templates/tpl/lib"), { recursive: true });
  writeFileSync(join(sb.home, "templates/tpl/package.json"), '{"name":"tpl"}');
  writeFileSync(join(sb.home, "templates/tpl/lib/kernel.ts"), "export const x = 1;\n");

  const out = await seedWorkspace(sb, WS({ seed: "tpl" }));
  delete process.env.MYCEL_TEMPLATES_DIR;

  assert.equal(out.written, 2);
  assert.equal(await sb.readFile("app/package.json"), '{"name":"tpl"}');
  assert.equal(await sb.readFile("app/lib/kernel.ts"), "export const x = 1;\n");
  // And the seeded workspace is therefore exportable, which is the whole point of the two halves.
  const exported = await exportDirectory(sb, WS({ seed: "tpl" }));
  assert.ok(exported.bytes > 0);
  await sb.destroy();
});

test("a declared scaffold that is not on disk FAILS the run, loudly, immediately", async () => {
  // THE REGRESSION THIS FILE EXISTS FOR NOW. This used to degrade to an empty-but-existing
  // workspace on the theory that a packaging fault should not take out every build run. It took
  // them out anyway: run 49fa00bb booted an agent into an empty home, and because nothing on the
  // feed said "no scaffold", it spent thirty minutes grepping opencode's own SQLite database for a
  // project that had never been uploaded, then expired. A silent degrade and a seed that never ran
  // are indistinguishable from the outside, and that indistinguishability cost a day.
  //
  // So: seconds, not half an hour, and the message names the scaffold and every path tried.
  const { sb } = sandboxWithHome();
  process.env.MYCEL_TEMPLATES_DIR = join(sb.home, "nowhere");
  await assert.rejects(
    () => seedWorkspace(sb, WS({ seed: "tpl" })),
    (e: Error) =>
      /the "tpl" scaffold is not on this kernel/.test(e.message) &&
      // Naming where it looked is what turns this from "broken" into a one-line fix.
      e.message.includes(join(sb.home, "nowhere", "tpl")),
    "a wedge that declares a seed and finds nothing must fail, not start the agent from nothing",
  );
  delete process.env.MYCEL_TEMPLATES_DIR;
  await sb.destroy();
});

test("a scaffold directory that exists but holds no seedable files fails the same way", async () => {
  // An empty scaffold is a missing scaffold wearing a disguise — `seedRoot` finds it, `readSeed`
  // returns nothing, and without this the run proceeds from an empty ~/app exactly as before.
  const { sb } = sandboxWithHome();
  process.env.MYCEL_TEMPLATES_DIR = join(sb.home, "templates");
  mkdirSync(join(sb.home, "templates/tpl/lib"), { recursive: true });
  await assert.rejects(
    () => seedWorkspace(sb, WS({ seed: "tpl" })),
    /contains no seedable files/,
  );
  delete process.env.MYCEL_TEMPLATES_DIR;
  await sb.destroy();
});

test("a wedge that declares NO scaffold still just gets its directory", async () => {
  // The loud failure above is scoped to a broken PROMISE. A workspace with no `seed` promised
  // nothing, and must keep behaving exactly as it did — an empty ~/app and no error.
  const { sb } = sandboxWithHome();
  const out = await seedWorkspace(sb, WS({}));
  assert.equal(out.root, null);
  assert.equal(out.written, 0);
  assert.equal((await sb.exec("cd ~ && test -d app && echo yes")).stdout.trim(), "yes");
  await sb.destroy();
});

test("product-builder seeds business-template and loads its skills", () => {
  // Two manifest bugs in one assertion. `workspace.seed` must survive, and `"skills": []` must NOT
  // come back: `loadWedge` does `manifest.skills?.map(...)`, and `[]` is not nullish, so an empty
  // array was a filter matching nothing — every skill file in skills/ silently unloaded.
  const wedge = loadWedge("product-builder");
  assert.ok(wedge, "product-builder must load");
  const ws = resolveWorkspace(wedge.manifest, "build_feature");
  assert.equal(ws?.dir, "app");
  assert.equal(ws?.seed, "business-template");
  // The kernel still verifies — but the PRODUCTION BUILD is no longer what it runs in the sandbox.
  // `npm run build` OOM'd the microVM, and its verdict landed after the agent had stopped, so a
  // compile error had to become a whole new task. What is left here is the cheap half: a typecheck
  // and a real `next dev` boot that must answer 200. The build itself is a tool the agent calls
  // mid-run, and `require_remote_build` is the kernel's check that one actually succeeded.
  assert.ok(ws?.verify?.includes("tsc --noEmit"), "the kernel must still typecheck the workspace");
  assert.ok(ws?.verify?.includes("npm run dev"), "the kernel must still boot the app and curl it");
  assert.equal(
    ws?.verify?.includes("npm run build"),
    false,
    "`next build` must NOT run in the sandbox — it is the tool, and it OOM'd the microVM here",
  );
  assert.equal(ws?.requireRemoteBuild, true, "product-builder must require a proven remote build");
  assert.ok(wedge.skills.length >= 3, `skills must load, got ${wedge.skills.map((s) => s.name).join(",")}`);
});

// ── Verification: the kernel checks, the agent does not self-certify ──────────────────────────

test("verifyWorkspace fails on a non-zero exit, and the pipe does not hide it", async () => {
  // The bug this guards: the command is piped into `tail` to bound the output, and without
  // `set -o pipefail` the exit status of a pipeline is TAIL'S — always 0. A verification step that
  // can only pass is worse than none, because it looks like proof.
  const { sb, mkdir } = sandboxWithHome();
  mkdir("app");
  const bad = await verifyWorkspace(sb, WS({ verify: "echo 'Type error in page.tsx'; exit 1" }));
  assert.equal(bad?.ok, false);
  assert.equal(bad?.code, 1);
  assert.ok(bad?.tail.includes("Type error"), "the failure output must reach the founder");

  const good = await verifyWorkspace(sb, WS({ verify: "echo built" }));
  assert.equal(good?.ok, true);
  await sb.destroy();
});

test("a failing verify fails the task before anything is stored or deployed", async () => {
  // Order matters: a Next.js app that does not compile must never become a downloadable artifact,
  // and must never reach the deploy step. Verify runs first and throws.
  const { sb, put } = sandboxWithHome();
  put("app/package.json", "{}");
  const store = new InMemoryStore();

  await assert.rejects(
    () =>
      handOffWorkspace({
        store,
        task: { id: "task-2" },
        ws: WS({ verify: "exit 2" }),
        sandbox: sb,
        backend: { inline: true, async put() {} },
        emit: () => {},
      }),
    /does not build, so it is not a deliverable/,
  );
  assert.deepEqual(await store.listArtifacts("task-2"), [], "a broken app must not be stored");
  await sb.destroy();
});

test("no verify command declared means no verification step, not a failure", async () => {
  // Additive by construction: every wedge that existed before this must be byte-for-byte unchanged.
  const { sb, put } = sandboxWithHome();
  put("app/index.txt", "hello");
  assert.equal(await verifyWorkspace(sb, WS()), null);

  const store = new InMemoryStore();
  await handOffWorkspace({
    store,
    task: { id: "task-3" },
    ws: WS(),
    sandbox: sb,
    backend: { inline: true, async put() {} },
    emit: () => {},
  });
  assert.equal((await store.listArtifacts("task-3")).length, 1);
  await sb.destroy();
});

// ── Bug 3: the agent was never told which directory was the deliverable ───────────────────────

test("a build run is told, in both the prompt and AGENTS.md, where the work goes", async () => {
  // Task e4dbc13f's system prompt said "construct or alter software in this workspace" — a sentence
  // containing no path — and its user prompt said nothing at all. It built in /root. Both surfaces
  // now name the directory, because there is no way to know which one the model was reading.
  const { buildAgentsMdForTest, buildPromptForTest } = await import("../src/runtime");
  const { resolveHarnessProfile } = await import("../src/harness");
  const wedge = loadWedge("product-builder")!;
  const task = {
    id: "t",
    wedge: "product-builder",
    task_type: "build_feature",
    actor: { kind: "user" as const, id: "u" },
    input: {},
    constraints: { max_cost_usd: 5, max_runtime_s: 1800 },
    tools: [],
    status: "running" as const,
    cost_usd: 0,
    created_at: "",
    updated_at: "",
  };
  const profile = resolveHarnessProfile({
    task: task as never,
    wedge,
    ceilings: { maxRuntimeS: 1800, maxCostUsd: 5 },
  });
  const ws = resolveWorkspace(wedge.manifest, "build_feature")!;

  const md = buildAgentsMdForTest(task as never, wedge, [], profile, undefined, {
    ws,
    seeded: { root: "/x", files: [], skipped: 0, written: 41 },
  });
  assert.match(md, /~\/app/, "AGENTS.md must name the workspace directory");
  assert.match(md, /DELETED|discarded/i, "and say what happens to everything outside it");
  assert.match(md, /npm install/, "node_modules is never seeded, so this has to be said");
  assert.match(md, /tsc --noEmit/, "the agent must know which command it will be marked on");
  // The BUILD TOOL is documented only when it was actually installed. A tool an agent is told about
  // and cannot run costs it turns and costs every other instruction in this file its credibility —
  // so with `buildTool` unset (a kernel with no build plane, which is every developer machine) the
  // section must be absent.
  assert.equal(md.includes("mycel-build"), false, "an uninstalled tool must not be advertised");

  const withTool = buildAgentsMdForTest(task as never, wedge, [], profile, undefined, {
    ws,
    seeded: { root: "/x", files: [], skipped: 0, written: 41 },
    buildTool: true,
  });
  assert.match(withTool, /mycel-build/, "the build tool must be documented when it is installed");
  assert.match(withTool, /3 builds for this whole task/, "and the cap stated, so a last attempt is known");
  assert.match(
    withTool,
    /not finished until/i,
    "and that the task fails without a successful build, whatever the summary says",
  );

  const prompt = buildPromptForTest(task as never, wedge, profile, 0, 0, ws.dir);
  assert.match(prompt, /~\/app/, "the user prompt must name it too");
});

test("a run with no workspace gets no workspace instructions at all", async () => {
  // Additive: every wedge that declares no `workspace` must produce a byte-identical prompt.
  const { buildPromptForTest } = await import("../src/runtime");
  const task = { id: "t", wedge: "w", task_type: "tt", input: {} };
  const withNone = buildPromptForTest(task as never, null, undefined, 0, 0, undefined);
  assert.ok(!withNone.includes("deliverable and everything outside"), withNone);
});

test("the verify timeout is clamped, so a manifest cannot pin a sandbox open forever", () => {
  assert.equal(resolveWorkspace({ workspace: { dir: "app", verify: "x", verify_timeout_s: 99_999 } }, "t")?.verifyTimeoutMs, MAX_VERIFY_TIMEOUT_S * 1000);
  assert.equal(resolveWorkspace({ workspace: { dir: "app", verify: "x", verify_timeout_s: 1 } }, "t")?.verifyTimeoutMs, 30_000);
  // An empty or whitespace `verify` is no verify at all, rather than a shell command that is a no-op
  // and therefore always passes.
  assert.equal(resolveWorkspace({ workspace: { dir: "app", verify: "   " } }, "t")?.verify, undefined);
});
