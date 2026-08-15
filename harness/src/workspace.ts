/**
 * The workspace: what a run STARTS from, and what it HANDS BACK.
 *
 * Until this file existed the orchestrator persisted exactly one artifact — `result.txt`,
 * `text/plain` — and then destroyed the sandbox in its `finally`. Every other byte a run produced
 * died with the microVM. That is survivable for a wedge whose deliverable is a paragraph, and fatal
 * for the `build` shape, which exists specifically to construct a Next.js application: the run did
 * the work, wrote the files, and the files were deleted seconds later. `product-builder` has never
 * completed a run in production, and this is the primitive it was missing.
 *
 * Two halves of one idea, kept in one module because they share the same directory and the same
 * exclusion list:
 *
 *   SEED    — copy a repo-local scaffold (business-template) into the sandbox before the agent
 *             starts, so it edits a working app instead of inventing one from nothing.
 *   EXPORT  — tar + gzip that directory before `sandbox.destroy()` and store it as an artifact.
 *
 * Everything here is bounded on purpose. A Next.js build produces `node_modules` and a `.next`
 * cache — hundreds of megabytes — and an unbounded export is how one run takes down the artifact
 * store for every tenant on the box.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import type { ArtifactBackend } from "./artifacts";
import type { Sandbox } from "./sandbox";

// ---------------------------------------------------------------------------------------------
// What a manifest may declare
// ---------------------------------------------------------------------------------------------

/**
 * The `workspace` block in `wedge.json`, at the wedge level or under
 * `task_types.<name>.workspace` — the same two-level shape `harness` already uses, resolved the
 * same way (task type wins), so a founder learns one convention rather than two.
 */
export interface WorkspaceSpec {
  /** Directory, relative to the sandbox home, that IS the deliverable. */
  dir?: string;
  /** Repo-local scaffold copied into `dir` before the run. A directory name, never a path. */
  seed?: string;
  /** Extra exclusions, added to (never replacing) DEFAULT_EXCLUDES. */
  exclude?: string[];
  /** Requested ceiling for the exported tarball. Clamped by the server's — see `maxExportBytes`. */
  max_mb?: number;
  /**
   * A shell command, run by the KERNEL inside `dir` after the agent stops and before the export.
   * Non-zero exit fails the task. See `verifyWorkspace`.
   */
  verify?: string;
  /** Ceiling for that command. Clamped to `MAX_VERIFY_TIMEOUT_S`; a `next build` needs minutes. */
  verify_timeout_s?: number;
  /**
   * THE RUN MUST HAVE PROVED THE APP BUILDS, on the build plane, before it may hand anything back.
   *
   * `verify` above is a shell command in the sandbox. It is right for the cheap checks — a
   * typecheck, a `next dev` boot, a curl for a 200 — and it was wrong for `next build`: that is
   * heavy enough to OOM the microVM, and it ran after the agent had stopped, so its verdict reached
   * nobody who could act on it. See remotebuild.ts.
   *
   * With this flag the production build is a TOOL the agent calls mid-run (`mycel-build`), and the
   * kernel's post-run job is not to run the build but to CHECK THAT ONE SUCCEEDED — by reading the
   * run's own event log, which the agent cannot write to. That is what turns "the agent says it
   * builds" into "the kernel watched it build", and it is the strongest guarantee this system makes
   * about a delivered application.
   *
   * Enforced only when the kernel actually has a build plane (`remoteBuildConfig()`), because
   * otherwise the tool was never offered and failing the run would punish the agent for the
   * kernel's packaging. See `assertRemoteBuildSucceeded`.
   */
  require_remote_build?: boolean;
}

export interface ResolvedWorkspace {
  dir: string;
  seed?: string;
  exclude: string[];
  maxBytes: number;
  /** Artifact filename. Derived from `dir` so two exports on one task cannot collide silently. */
  artifactName: string;
  verify?: string;
  verifyTimeoutMs: number;
  requireRemoteBuild: boolean;
}

/**
 * Never exported, never seeded.
 *
 * `node_modules` and `.next` are the two that motivated the list: together they are ~700MB in this
 * repo's own `business-template`, against a source tree of 38 files. `.git` is here because a
 * packfile has no upper bound either. The env files are here for a different reason — an export is
 * a file a human downloads and a seed is a file that enters an agent's sandbox, and `.env.local` is
 * exactly where a key ends up. Neither direction should be carrying one.
 */
export const DEFAULT_EXCLUDES = [
  "node_modules",
  ".next",
  ".git",
  ".turbo",
  ".vercel",
  ".cache",
  "dist",
  "build",
  "out",
  "coverage",
  ".venv",
  "__pycache__",
  "target",
  ".DS_Store",
  "*.log",
  "tsconfig.tsbuildinfo",
  ".env",
  ".env.*",
];

// ---------------------------------------------------------------------------------------------
// Ceilings
// ---------------------------------------------------------------------------------------------

/**
 * `maxBuffer` on the child process that runs commands inside the sandbox (see `LocalSandbox.exec`
 * and `dockerExec`). It is not a policy choice, it is a fact about the transport, and it is
 * load-bearing here: the tarball comes back through that pipe as base64.
 */
export const EXEC_STDOUT_LIMIT_BYTES = 16 * 1024 * 1024;

/**
 * The largest tarball that can physically survive the trip, with slack.
 *
 * base64 inflates by 4/3, so anything above ~12MB of tarball would be TRUNCATED by the exec buffer
 * rather than rejected — and a truncated gzip is a corrupt download that looks like a successful
 * run. `exportDirectory` also verifies the decoded length against the size the sandbox reported, so
 * this is belt and braces; the ceiling is what makes the failure a clear message instead.
 */
export const TRANSPORT_MAX_BYTES = Math.floor((EXEC_STDOUT_LIMIT_BYTES * 3) / 4) - 64 * 1024;

/** Default ceiling: 10MB of gzipped source. A Next.js app minus its caches is well under 1MB. */
export function maxExportBytes(requestedMb?: number): number {
  const configured = Number(process.env.MYCEL_MAX_EXPORT_MB ?? 10) * 1024 * 1024;
  const asked = requestedMb && requestedMb > 0 ? requestedMb * 1024 * 1024 : configured;
  return Math.max(1024, Math.min(asked, configured, TRANSPORT_MAX_BYTES));
}

// ---------------------------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------------------------

/** A manifest, structurally — so `wedge.ts` and this file need not import each other. */
interface ManifestLike {
  workspace?: WorkspaceSpec;
  task_types?: Record<string, { workspace?: WorkspaceSpec } | undefined>;
}

/**
 * A directory name a shell command may safely interpolate and a sandbox may safely write into.
 *
 * The manifest is founder-supplied data that ends up inside a `tar` command line and inside
 * `sandbox.writeFile`. `../../etc` would read the host filesystem on the way in; a name with a
 * quote in it would end the shell word on the way out. Both are refused loudly, because a workspace
 * that cannot be addressed safely is a configuration bug and not something to paper over.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;
function assertSafeRelDir(dir: string, field: string): string {
  const clean = dir.trim().replace(/^\.\//, "").replace(/\/+$/, "");
  if (!clean) throw new Error(`workspace.${field} is empty`);
  if (clean.startsWith("/")) throw new Error(`workspace.${field} must be relative, got "${dir}"`);
  const parts = clean.split("/");
  for (const p of parts) {
    if (p === ".." || !SAFE_SEGMENT.test(p)) {
      throw new Error(`workspace.${field} contains an unsafe path segment: "${dir}"`);
    }
  }
  return clean;
}

/**
 * The workspace for THIS task type, or null when the wedge declares none.
 *
 * Null is the answer for every wedge that exists today, and that is the point: directory export is
 * ADDITIVE. A wedge that says nothing keeps producing exactly one `result.txt` and nothing about
 * its run changes.
 */
export function resolveWorkspace(
  manifest: ManifestLike | null | undefined,
  taskType: string,
): ResolvedWorkspace | null {
  const spec = manifest?.task_types?.[taskType]?.workspace ?? manifest?.workspace;
  if (!spec || !spec.dir) return null;
  const dir = assertSafeRelDir(spec.dir, "dir");
  const seed = spec.seed ? assertSafeRelDir(spec.seed, "seed") : undefined;
  const extra = (spec.exclude ?? []).filter((e) => typeof e === "string" && e.trim() && !e.includes("'"));
  const verify = typeof spec.verify === "string" && spec.verify.trim() ? spec.verify.trim().slice(0, 500) : undefined;
  return {
    dir,
    seed,
    exclude: [...DEFAULT_EXCLUDES, ...extra],
    maxBytes: maxExportBytes(spec.max_mb),
    artifactName: `${basename(dir)}.tar.gz`,
    verify,
    verifyTimeoutMs:
      Math.min(Math.max(spec.verify_timeout_s ?? DEFAULT_VERIFY_TIMEOUT_S, 30), MAX_VERIFY_TIMEOUT_S) * 1000,
    requireRemoteBuild: spec.require_remote_build === true,
  };
}

/** `next build` on a cold cache is minutes, not seconds. */
export const DEFAULT_VERIFY_TIMEOUT_S = 900;
export const MAX_VERIFY_TIMEOUT_S = 1800;

/**
 * A repo tarball must never be stuffed inline into Postgres.
 *
 * The inline backend stores artifact content in the Store row. That is the right default for a
 * paragraph of text and completely wrong for megabytes of gzip: it puts the deliverable in the
 * same table every list query touches, and Postgres is not an object store. So a wedge that
 * declares a workspace REQUIRES `MYCEL_ARTIFACTS=fs|s3`.
 *
 * Checked BEFORE the sandbox is provisioned as well as after the work is done — the whole point is
 * that a build costs dollars and half an hour, and discovering the deliverable has nowhere to live
 * at the end of that is the most expensive possible moment to find out.
 */
export function assertExportableBackend(backend: Pick<ArtifactBackend, "inline">): void {
  if (!backend.inline) return;
  throw new Error(
    "workspace export needs an object store: this wedge hands back a directory, and the inline " +
      "artifact backend keeps content in the database. Set MYCEL_ARTIFACTS=fs (with " +
      "MYCEL_ARTIFACTS_DIR) or MYCEL_ARTIFACTS=s3 (with MYCEL_ARTIFACTS_BUCKET).",
  );
}

// ---------------------------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------------------------

export interface DirectoryExport {
  name: string;
  content_type: string;
  /** base64 of the gzipped tar. Artifact `content` is a string in every backend — see contract.ts. */
  base64: string;
  /** DECODED bytes, i.e. what a human means by "how big is that file". */
  bytes: number;
}

/** Single-quote for `bash -lc`. The same helper the runtime uses on env values, for the same reason. */
function q(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

/**
 * Tar the workspace inside the sandbox and bring it back as base64.
 *
 * Deliberately NOT a stream: `Sandbox` has `readFile(path): string`, which decodes as UTF-8 and
 * would silently corrupt a gzip. base64 over stdout is the one channel all three sandbox backends
 * (local, docker, Daytona) already speak identically.
 *
 * The order of operations is the interesting part, and it is the order that bounds the blast radius:
 *
 *   1. tar with exclusions      — never walk `node_modules` at all
 *   2. measure the tarball      — one number over the wire
 *   3. REFUSE if over ceiling   — before a single byte of content is transferred
 *   4. only then, base64 it
 *
 * Measuring before transferring is what stops a 300MB `.next` cache from being pulled into the
 * harness process's heap to then be rejected. A rejection that has already happened in memory is
 * not a rejection.
 */
export async function exportDirectory(
  sandbox: Pick<Sandbox, "exec">,
  ws: ResolvedWorkspace,
): Promise<DirectoryExport> {
  const tarPath = `/tmp/mycel-export-${Math.random().toString(36).slice(2)}.tgz`;
  const excludes = ws.exclude.map((e) => `--exclude=${q(e)}`).join(" ");
  // `cd ~` rather than a hardcoded home: LocalSandbox's home is a temp dir, Daytona's is /root, and
  // the docker image sets its own WORKDIR. All three export HOME.
  const build = [
    "set -o pipefail",
    "cd ~",
    `test -d ${q(ws.dir)} || { echo MYCEL_EXPORT_NO_DIR; exit 3; }`,
    `rm -f ${tarPath}`,
    // `--exclude` must precede the path operand for BSD tar (macOS dev) as well as GNU tar.
    `tar -czf ${tarPath} ${excludes} ${q(ws.dir)}`,
    /**
     * HOW MANY FILES ARE ACTUALLY IN IT.
     *
     * `test -d` above only proves the directory exists, and a directory is not a deliverable. The
     * two ways to get an existing-but-worthless one are both real: the agent `mkdir`s the workspace
     * and then builds somewhere else, or everything it left behind is on the exclusion list
     * (`node_modules` and nothing but). Either way `tar` succeeds, the archive is ~100 bytes, the
     * artifact is stored, and the run reports success while the customer downloads an empty box.
     *
     * `grep -cv '/$'` counts non-directory entries. `|| true` because grep exits 1 on zero matches
     * and `pipefail` is on — an empty archive must reach the check below as the number 0, not as a
     * tar failure whose message says nothing about emptiness.
     */
    `echo MYCEL_EXPORT_FILES=$(tar -tzf ${tarPath} | grep -cv '/$' || true)`,
    // `wc -c` rather than `stat`: `stat -c` is GNU-only and `stat -f` is BSD-only.
    `wc -c < ${tarPath}`,
  ].join(" && ");

  const made = await sandbox.exec(build, 300_000);
  if (made.code !== 0) {
    if (made.stdout.includes("MYCEL_EXPORT_NO_DIR")) {
      // The single most likely real-world failure: the agent worked somewhere else. Say which
      // directory was expected, because "export failed" alone sends someone reading tar man pages.
      throw new Error(
        `workspace export: the run produced no ~/${ws.dir} directory. The deliverable is that ` +
          `directory; anything written elsewhere in the sandbox is discarded when it is destroyed.`,
      );
    }
    throw new Error(`workspace export: tar failed (${(made.stderr || made.stdout).trim().slice(-400)})`);
  }

  const bytes = Number(made.stdout.trim().split(/\s+/).pop());
  if (!Number.isFinite(bytes) || bytes <= 0) {
    throw new Error(`workspace export: could not size the archive (${made.stdout.trim().slice(0, 200)})`);
  }

  const fileCount = Number(made.stdout.match(/MYCEL_EXPORT_FILES=(\d+)/)?.[1] ?? "-1");
  if (fileCount === 0) {
    await sandbox.exec(`rm -f ${tarPath}`, 30_000).catch(() => undefined);
    throw new Error(
      `workspace export: ~/${ws.dir} contains no files. The deliverable is that directory and it is ` +
        `empty — either the work was done somewhere else in the sandbox (everything outside ` +
        `~/${ws.dir} is discarded when it is destroyed), or everything left in it is on the ` +
        `exclusion list.`,
    );
  }

  if (bytes > ws.maxBytes) {
    // Name the offenders. A ceiling that fires without saying WHAT blew it turns into a support
    // conversation; `du` costs one command and usually answers it outright (a stray build cache,
    // a committed video, a log file the exclusions didn't know about).
    const worst = await sandbox
      .exec(`cd ~ && du -sk ${q(ws.dir)}/* 2>/dev/null | sort -rn | head -5`, 60_000)
      .then((r) => r.stdout.trim().replace(/\s+/g, " ").slice(0, 300))
      .catch(() => "");
    await sandbox.exec(`rm -f ${tarPath}`, 30_000).catch(() => undefined);
    throw new Error(
      `workspace export: ${mb(bytes)}MB archive exceeds the ${mb(ws.maxBytes)}MB ceiling` +
        (worst ? ` — largest directories (KB): ${worst}` : "") +
        `. Exclude what does not belong in the deliverable (workspace.exclude in wedge.json), or ` +
        `raise MYCEL_MAX_EXPORT_MB.`,
    );
  }

  // `tr -d` because BSD base64 wraps at 76 columns and GNU's `-w0` does not exist on BSD.
  const read = await sandbox.exec(`base64 < ${tarPath} | tr -d '\\n'; rm -f ${tarPath}`, 300_000);
  if (read.code !== 0) {
    throw new Error(`workspace export: could not read the archive (${read.stderr.trim().slice(-200)})`);
  }
  const b64 = read.stdout.trim();
  const decoded = Buffer.from(b64, "base64").byteLength;
  if (decoded !== bytes) {
    // The failure this guard exists to prevent: stdout hit the exec `maxBuffer` and was TRUNCATED.
    // A truncated gzip still downloads, still has a plausible size, and only fails when the
    // customer tries to open it — days later, with no trace connecting it to this run.
    throw new Error(
      `workspace export: archive truncated in transit (${decoded} of ${bytes} bytes). This is the ` +
        `${mb(TRANSPORT_MAX_BYTES)}MB transport limit; lower MYCEL_MAX_EXPORT_MB or exclude more.`,
    );
  }

  return { name: ws.artifactName, content_type: "application/gzip", base64: b64, bytes };
}

const mb = (n: number) => (n / 1024 / 1024).toFixed(1);

// ---------------------------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------------------------

export interface SeedFile {
  /** Path relative to the workspace directory. */
  name: string;
  content: string;
}

export interface SeedResult {
  /** Where the scaffold was found, or null when it isn't on disk. */
  root: string | null;
  files: SeedFile[];
  /** Files skipped because they were binary, oversized, or past the budget. */
  skipped: number;
}

const MAX_SEED_FILES = 500;
const MAX_SEED_BYTES = 8 * 1024 * 1024;
const MAX_SEED_FILE_BYTES = 512 * 1024;

/**
 * Where a scaffold lives.
 *
 * `MYCEL_TEMPLATES_DIR` wins. Otherwise we look beside the wedges (`<cwd>/templates/<name>`) and
 * then one level up (`<cwd>/../<name>`), which is where `business-template` sits in this repo when
 * the kernel runs from `kernel/`.
 *
 * Returns null rather than throwing when nothing is found — the decision about what a missing
 * scaffold MEANS belongs to `seedWorkspace`, which knows whether the wedge actually declared one.
 * (It fails the run: see the header there.)
 */
export function seedCandidates(name: string): string[] {
  const safe = assertSafeRelDir(name, "seed");
  const env = process.env.MYCEL_TEMPLATES_DIR;
  return env
    ? [join(env, safe)]
    : [join(process.cwd(), "templates", safe), join(process.cwd(), "..", safe), join(process.cwd(), safe)];
}

export function seedRoot(name: string): string | null {
  const candidates = seedCandidates(name);
  for (const c of candidates) {
    try {
      if (existsSync(c) && statSync(c).isDirectory()) return c;
    } catch {
      /* unreadable candidate is not a candidate */
    }
  }
  return null;
}

/** Does any exclusion pattern match this path segment? Supports the `*.log` / `.env.*` globs only. */
function excluded(segment: string, patterns: string[]): boolean {
  return patterns.some((p) => {
    if (!p.includes("*")) return segment === p;
    const rx = new RegExp(`^${p.split("*").map(escapeRx).join(".*")}$`);
    return rx.test(segment);
  });
}
const escapeRx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Read a scaffold off disk, bounded.
 *
 * TEXT ONLY, detected by a NUL byte rather than by extension. `Sandbox.writeFile` takes a string;
 * a PNG pushed through it is silently corrupt — a broken favicon in a delivered app, with nothing
 * anywhere saying why. Skipping is honest; the count is reported on the run.
 *
 * The budgets exist because seeding is one upload per file on the Daytona backend. This repo's
 * `business-template` is 38 files without its caches and 700MB with them, which is the whole
 * argument for sharing the export exclusion list.
 */
export function readSeed(name: string, exclude: string[] = DEFAULT_EXCLUDES): SeedResult {
  const root = seedRoot(name);
  if (!root) return { root: null, files: [], skipped: 0 };

  const files: SeedFile[] = [];
  let skipped = 0;
  let total = 0;
  const walk = (dir: string): void => {
    if (files.length >= MAX_SEED_FILES || total >= MAX_SEED_BYTES) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (excluded(entry, exclude)) continue;
      const full = join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
        continue;
      }
      if (!st.isFile()) continue;
      if (st.size > MAX_SEED_FILE_BYTES || total + st.size > MAX_SEED_BYTES || files.length >= MAX_SEED_FILES) {
        skipped++;
        continue;
      }
      let buf: Buffer;
      try {
        buf = readFileSync(full);
      } catch {
        skipped++;
        continue;
      }
      if (buf.includes(0)) {
        skipped++;
        continue;
      }
      // POSIX separators: the sandbox is Linux even when the kernel runs on a Mac.
      files.push({ name: relative(root, full).split(sep).join("/"), content: buf.toString("utf8") });
      total += st.size;
    }
  };
  walk(root);
  return { root, files, skipped };
}

/**
 * Put the scaffold INSIDE the sandbox. The half of seeding that did not exist.
 *
 * `readSeed` above has been in this file since it was written and had NO CALLER. Nothing anywhere
 * turned its `SeedFile[]` into files in a microVM, so `product-builder` — the one wedge that
 * declares `seed: "business-template"` — started every run against an empty home directory. The
 * agent, given a build task and nothing to build on, did the reasonable thing: it created files
 * wherever it happened to be (`/root`), `~/app` never came into existence, and the export failed
 * with "the run produced no ~/app directory". Task e4dbc13f still reported `succeeded`.
 *
 * So this is bug #2 and bug #3 in one function: the agent now opens a working Next.js app, and the
 * directory it must work in exists before it takes its first turn, which is what makes the
 * instruction in AGENTS.md checkable rather than aspirational.
 *
 * FAILS LOUDLY, IN THE FIRST SECONDS, when a declared scaffold is not on disk.
 *
 * This used to degrade: `seedRoot` returns null when `business-template` is not packaged, and the
 * function created an empty `~/app` and let the run proceed. The reasoning was that a packaging
 * fault should not take out every build run. In practice it did take them out — just half an hour
 * later and with the wrong diagnosis. Run 49fa00bb is the whole argument: the agent booted into an
 * empty home, spent thirty minutes grepping opencode's own SQLite database looking for the project
 * it had been told it had, and expired. Nothing in that run named the cause, because the cause was
 * that the bytes were never shipped.
 *
 * A wedge that declares `seed` is asserting the agent starts from a working application. If that is
 * false, EVERY minute the run spends afterwards is wasted and every dollar it costs buys nothing.
 * Refusing here costs seconds and says exactly which scaffold, where it was looked for, and how to
 * point at it. A manifest that declares no seed is untouched — it just gets its directory.
 *
 * The same reasoning covers a scaffold that resolves but yields zero files (a stray empty directory
 * of the right name, an exclusion list that ate everything): an empty seed is a missing seed with a
 * more confusing shape.
 */
export interface SeedOutcome extends SeedResult {
  /** Files actually written into the sandbox. Below `files.length` only if a write failed. */
  written: number;
}

export async function seedWorkspace(
  sandbox: Pick<Sandbox, "exec" | "writeFile">,
  ws: ResolvedWorkspace,
): Promise<SeedOutcome> {
  // The directory exists either way. An agent told "work in ~/app" that finds no ~/app cannot tell
  // "empty" from "wrong path", and the run that motivated this file spent its budget finding out.
  await sandbox.exec(`cd ~ && mkdir -p ${q(ws.dir)}`, 60_000);
  if (!ws.seed) return { root: null, files: [], skipped: 0, written: 0 };

  const seed = readSeed(ws.seed, ws.exclude);
  if (!seed.root) {
    // Name every path that was tried. The fix is always one of "package it" or "point at it", and
    // which one is obvious the moment you can see where the kernel looked.
    throw new Error(
      `workspace seed: the "${ws.seed}" scaffold is not on this kernel. The wedge declares it, so ` +
        `the run would start from an empty ~/${ws.dir} and could not succeed. Looked in: ` +
        `${seedCandidates(ws.seed).join(", ")} (cwd ${process.cwd()}). Ship the scaffold in the ` +
        `image or set MYCEL_TEMPLATES_DIR.`,
    );
  }
  if (seed.files.length === 0) {
    throw new Error(
      `workspace seed: the "${ws.seed}" scaffold at ${seed.root} contains no seedable files` +
        (seed.skipped ? ` (${seed.skipped} were binary or oversized)` : "") +
        `. An empty scaffold starts the agent from nothing just as a missing one does.`,
    );
  }
  let written = 0;
  for (const f of seed.files) {
    // Relative, like every other `writeFile` call in runtime.ts — the sandbox resolves against
    // HOME, which differs per backend (a temp dir locally, /root on Daytona).
    await sandbox.writeFile(`${ws.dir}/${f.name}`, f.content);
    written++;
  }
  return { ...seed, written };
}

/**
 * PROVE IT BUILDS, from the kernel, not from the agent's report.
 *
 * "Verify it works" has been in the build prompt for as long as the build shape has existed, and it
 * is an instruction to the thing being verified. An agent that believes it ran `npm run build` and
 * an agent that ran it produce the same final message. The only claim worth putting a customer's
 * name on is one the kernel made itself, so the kernel runs the command.
 *
 * FATAL BY DESIGN — the caller throws on `ok: false`. A Next.js app that does not compile is not a
 * partial deliverable, it is a broken one, and shipping it as `succeeded` is the same failure mode
 * as the empty export: a green run and nothing usable at the end of it.
 *
 * Bounded, and the tail is what gets reported: a failing `next build` prints its diagnosis in the
 * last few lines and its progress bars in the first few thousand.
 */
export interface VerifyOutcome {
  ok: boolean;
  code: number;
  /** Last few KB of combined output — enough to name the file and line that failed. */
  tail: string;
}

export async function verifyWorkspace(
  sandbox: Pick<Sandbox, "exec">,
  ws: ResolvedWorkspace,
): Promise<VerifyOutcome | null> {
  if (!ws.verify) return null;
  // `set -o pipefail` is not decoration. Without it the exit status of `cmd | tail` is TAIL'S, which
  // is 0 whatever the build did — a verification step that can only ever pass, which is worse than
  // none because it looks like proof.
  const r = await sandbox.exec(
    `set -o pipefail; cd ~/${ws.dir} && { ${ws.verify}; } 2>&1 | tail -c 4000`,
    ws.verifyTimeoutMs,
  );
  return { ok: r.code === 0, code: r.code, tail: (r.stdout || r.stderr || "").trim().slice(-4000) };
}
