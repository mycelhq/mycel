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
import {
  classifyChange,
  resolveSubstantive,
  sizesFromWc,
  treeFromSeed,
  treeFromSums,
  type ChangeReport,
  type SubstantiveRule,
  type SubstantiveSpec,
} from "./substantive";
import type { SiteFile } from "./sitequality";

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
  /**
   * WHOSE SITE THIS BUILD PUBLISHES — `"project"` (the default) or `"case"`.
   *
   * `"project"` means the founder's own product: one address per agency, which is what
   * `product-builder` has always meant and what every existing manifest keeps meaning without
   * changing a line.
   *
   * `"case"` means a site per client engagement, which is what a web studio SELLS. It gives each
   * case its own hostname and its own Lambda, so an agency's second client going live does not
   * overwrite their first — the failure the whole of `site-identity.ts` exists to describe.
   *
   * DECLARED, NEVER INFERRED. The tempting rule is "if the task has a case, the site is the case",
   * and it fails in the direction that costs most: a `product-builder` run filed under a case would
   * silently start publishing the founder's own product to a new address, orphaning the old one with
   * no error anywhere.
   */
  site?: "project" | "case";
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
  /**
   * THE RUN MUST HAVE CHANGED SOMETHING REAL, measured against the seed.
   *
   * `verify` asks whether the exported app works. `require_remote_build` asks whether it compiled.
   * This asks whether it is a BUILD — whether the agent authored structure, or merely recoloured
   * the scaffold it was handed and gave it back. See substantive.ts for the evidence that made this
   * necessary and for what counts as cosmetic.
   *
   * `true` takes the defaults, which are the ones a Next.js site build wants. An object tunes them.
   * Absent or `false` means no opinion, which is the right answer for every wedge that seeds nothing
   * and the reason this is additive: a wedge that does not ask keeps its old behaviour exactly.
   *
   * Only meaningful alongside `seed` — with no scaffold there is nothing to be unchanged from, and
   * `classifyChange` says so rather than failing a run it cannot judge.
   */
  require_substantive_change?: SubstantiveSpec | boolean;
  /**
   * Minimum `scoreSite` result, 0-100. Absent means the score is ADVISORY and only template residue
   * can fail a build.
   *
   * A knob rather than a constant because sitequality.ts asks for exactly that: "Report first, gate
   * once the distribution is known — and `minScore` exists so gating is a manifest change rather
   * than a code change." Nothing in this repo has seen the distribution yet, so no wedge sets it.
   */
  min_site_quality?: number;
}

export interface ResolvedWorkspace {
  dir: string;
  /** See `WorkspaceSpec.site`. Resolved here so the orchestrator never re-reads the manifest. */
  site: "project" | "case";
  seed?: string;
  exclude: string[];
  maxBytes: number;
  /** Artifact filename. Derived from `dir` so two exports on one task cannot collide silently. */
  artifactName: string;
  verify?: string;
  verifyTimeoutMs: number;
  requireRemoteBuild: boolean;
  /** Undefined when the wedge expressed no opinion. See `WorkspaceSpec.require_substantive_change`. */
  substantive?: SubstantiveRule;
  /** See `WorkspaceSpec.min_site_quality`. Undefined leaves the score advisory. */
  minSiteQuality?: number;
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
 * How long a `verify` script may be. Generous, because it is founder-authored, not user input.
 *
 * IT WAS 500, AND THAT CAP SILENTLY BROKE EVERY BUILD FOR WEEKS. `product-builder`'s verify grew
 * past 500 characters as gates were added to it — the dev-server probe, the Tailwind byte check,
 * the component-library count. `slice(0, 500)` then cut it in the middle of a double-quoted string,
 * and what reached the sandbox was not a shorter script but a SYNTACTICALLY INVALID one:
 *
 *     /root/.mycel-verify.sh: line 3: unexpected EOF while looking for matching `"'   (exit 2)
 *
 * Which reads exactly like a quoting bug in the transport, and is not one. Two days went into the
 * transport — it is genuinely also broken on Daytona, see `verifyWorkspace` below — while the
 * actual cause was one number in this file. Twenty-one builds failed, none of them for a reason
 * the agent could have fixed.
 *
 * TRUNCATION IS NEVER RIGHT FOR A SHELL SCRIPT. A prefix of a valid script is not a valid script,
 * so quietly shortening one converts a manifest the founder can fix into a runtime error nobody can
 * read. Over the limit is therefore a REFUSAL, named at resolve time, pointing at the field.
 */
export const MAX_VERIFY_CHARS = 8000;

function resolveVerify(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const verify = raw.trim();
  if (verify.length > MAX_VERIFY_CHARS) {
    throw new Error(
      `workspace.verify is ${verify.length} characters, over the ${MAX_VERIFY_CHARS} limit. ` +
        `It is run as a shell script, so it cannot be truncated to fit — shorten it, or move the ` +
        `checks into a script file committed in the seed directory and call that instead.`,
    );
  }
  return verify;
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
  const verify = resolveVerify(spec.verify);
  return {
    dir,
    seed,
    exclude: [...DEFAULT_EXCLUDES, ...extra],
    maxBytes: maxExportBytes(spec.max_mb),
    // Defaulted, never inferred — a manifest that says nothing means the founder's own product,
    // which is what every manifest written before sites existed meant.
    site: spec.site === "case" ? "case" : "project",
    artifactName: `${basename(dir)}.tar.gz`,
    verify,
    verifyTimeoutMs:
      Math.min(Math.max(spec.verify_timeout_s ?? DEFAULT_VERIFY_TIMEOUT_S, 30), MAX_VERIFY_TIMEOUT_S) * 1000,
    requireRemoteBuild: spec.require_remote_build === true,
    substantive: resolveSubstantive(spec.require_substantive_change),
    minSiteQuality:
      typeof spec.min_site_quality === "number" && Number.isFinite(spec.min_site_quality)
        ? Math.max(0, Math.min(100, spec.min_site_quality))
        : undefined,
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
  /** Files skipped because they were binary or individually oversized. Each one is a KNOWN loss. */
  skipped: number;
  /**
   * TRUE WHEN THE WALK RAN OUT OF BUDGET AND STOPPED — which is a different failure from `skipped`,
   * and the difference cost a week of production builds.
   *
   * `skipped` means "this particular file could not come" and the rest of the scaffold is intact.
   * Truncation means "we stopped partway and everything after this point is missing", and WHICH
   * files are missing depends on directory order, which nobody chose.
   *
   * It was not distinguished, and it was not reported. `business-template` grew to 620 files against
   * a cap of 500 — 470 of them the component library — so the walk spent its budget and stopped at
   * `component-library/shadcn/spinner.json`. Everything after that, including all of `scripts/`,
   * silently never reached the sandbox. The app still compiled, because those scripts are tooling
   * rather than source, so the remote build reported success and then the kernel's own verify gate
   * died on `Cannot find module '/root/app/scripts/check-styles.mjs'`. Every build that got that far
   * failed at the last step for a reason that was nowhere near the last step.
   */
  truncated: boolean;
}

/**
 * The seed budget.
 *
 * BYTES ARE THE REAL GUARD; the file count is a sanity bound on the walk. That was backwards in
 * practice: the shipped template is 3MB against an 8MB ceiling and 620 files against 500, so the
 * only limit that ever bound was the one measuring the least interesting thing.
 *
 * 2000 leaves the template room to roughly triple while the byte ceiling — which is what actually
 * protects the sandbox and the exec buffer — stays where it is. And `truncated` above means the day
 * either is hit, somebody is told, rather than finding out from a MODULE_NOT_FOUND three stages later.
 */
const MAX_SEED_FILES = 2000;
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
  if (!root) return { root: null, files: [], skipped: 0, truncated: false };

  const files: SeedFile[] = [];
  let skipped = 0;
  let total = 0;
  let truncated = false;
  const walk = (dir: string): void => {
    if (files.length >= MAX_SEED_FILES || total >= MAX_SEED_BYTES) {
      truncated = true;
      return;
    }
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
      // One file too big to carry is a SKIP: the rest of the scaffold is unaffected. Running out of
      // total budget is TRUNCATION: everything after this point is missing and which files those are
      // depends on directory order. Conflating them is what made the failure invisible.
      if (st.size > MAX_SEED_FILE_BYTES) {
        skipped++;
        continue;
      }
      if (total + st.size > MAX_SEED_BYTES || files.length >= MAX_SEED_FILES) {
        truncated = true;
        return;
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
  return { root, files, skipped, truncated };
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
  if (!ws.seed) return { root: null, files: [], skipped: 0, truncated: false, written: 0 };

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
  /**
   * A TRUNCATED SCAFFOLD IS A FAILED RUN, said here rather than discovered three stages later.
   *
   * This is the check whose absence produced the production failure written up on `SeedResult.
   * truncated`: the walk stopped at its file cap, `scripts/` never reached the sandbox, the app
   * compiled anyway because those scripts are tooling, the remote build reported success, and the
   * kernel's own verify gate then died on `Cannot find module '/root/app/scripts/check-styles.mjs'`.
   * The message named a missing file with no hint that the kernel had failed to put it there.
   *
   * Failing HERE costs a run that had not started. Failing there cost an hour of model spend, an
   * OpenNext build, and an error that pointed at the agent for something the kernel did.
   */
  if (seed.truncated) {
    throw new Error(
      `workspace seed: the "${ws.seed}" scaffold did not fit the seed budget — ${seed.files.length} ` +
        `files were carried and the walk then stopped, so an unknown remainder is missing from ` +
        `~/${ws.dir}. Which files are missing depends on directory order, so the run would fail ` +
        `later somewhere unrelated. Raise MAX_SEED_FILES/MAX_SEED_BYTES in workspace.ts, or shrink ` +
        `the scaffold.`,
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

/**
 * Where the verify script is written, RELATIVE TO THE SANDBOX HOME.
 *
 * Every backend resolves `writeFile` through its own `abs()`, so an absolute `/tmp/...` would be
 * re-rooted under the sandbox home by some backends and taken literally by others — the one path
 * shape guaranteed to behave differently per backend, which is exactly what this fix exists to
 * stop. Relative here, and `~/` at the point of execution, where a tilde is the only expansion and
 * there is nothing to quote.
 */
/**
 * ═══ ONE npm AT A TIME IN THE WORKSPACE ═══
 *
 * THE BUG. `product-builder`'s verify begins `npm install --no-audit --no-fund && npx tsc …`, and
 * `startPreview` in runtime.ts ran `cd ~/app && npm install` too. Same directory, same
 * `node_modules`, no coordination between them — and the second one is triggered by a HUMAN OPENING
 * A TAB, at a moment nobody chose.
 *
 * So the founder watching their site get built could, by looking at it, corrupt the tree the verify
 * was about to check, and the run would fail with a verdict about the agent's work that was really
 * about two package managers writing the same directory. npm does not lock across processes in any
 * way that survives this.
 *
 * THE LOCK. `mkdir` is atomic on every filesystem this runs on, which is the whole reason it is the
 * classic shell mutex: the process that creates the directory holds it, everyone else spins. No
 * `flock` — it is not in the slim sandbox image, and discovering that at runtime would be one more
 * silent failure in a file that exists because of silent failures.
 *
 * STALE LOCKS ARE RECLAIMED. A holder killed mid-install (the sandbox dies with its run, and runs
 * are cancelled) would otherwise leave a directory that blocks everything after it for ever. Ten
 * minutes is comfortably longer than any install here and shorter than any human's patience.
 *
 * IT IS A SCRIPT, NEVER AN INTERPOLATED COMMAND. Same argument as `verifyWorkspace` below, and it is
 * not theoretical: `DaytonaSandbox.exec` hands its string to a shell we do not control, so every
 * quote below would close Daytona's own wrapper and the whole thing would exit 2 without running.
 * Callers write this to a file and run `bash <path>`.
 */
export const WORKSPACE_LOCK_DIR = "/tmp/mycel-workspace-npm.lock";

/** Wrap a shell body so it holds the workspace lock for its whole life, and always releases it. */
export function lockedScript(body: string, opts: { waitSeconds?: number } = {}): string {
  const wait = opts.waitSeconds ?? 900;
  return [
    "set -o pipefail",
    `__lock=${WORKSPACE_LOCK_DIR}`,
    "__n=0",
    'while ! mkdir "$__lock" 2>/dev/null; do',
    // Reclaim a lock whose holder died. `find -mmin +10` is POSIX-ish and present on both the slim
    // Debian image and a developer's macOS, which `stat` is not (GNU vs BSD flags).
    '  if [ -n "$(find "$__lock" -maxdepth 0 -mmin +10 2>/dev/null)" ]; then rm -rf "$__lock"; continue; fi',
    "  __n=$((__n+1))",
    `  if [ "$__n" -gt ${wait} ]; then echo "mycel: timed out waiting for the workspace lock" >&2; exit 75; fi`,
    "  sleep 1",
    "done",
    // The trap is the only release path, so an `exit` anywhere in the body — including the caller's
    // own `exit 2` on a missing directory — still frees the lock for whoever is spinning on it.
    `trap 'rm -rf "$__lock"' EXIT`,
    body,
  ].join("\n");
}

export const VERIFY_SCRIPT_PATH = ".mycel-verify.sh";

export async function verifyWorkspace(
  sandbox: Pick<Sandbox, "exec" | "writeFile">,
  ws: ResolvedWorkspace,
): Promise<VerifyOutcome | null> {
  if (!ws.verify) return null;

  // ── THE SCRIPT IS WRITTEN TO A FILE AND RUN BY PATH. IT IS NEVER INTERPOLATED INTO A COMMAND. ──
  //
  // This used to pass the whole thing to `sandbox.exec` as one string. Under the LOCAL and DOCKER
  // backends that works — docker gets `["bash","-lc",command]` and argv keeps the quoting intact.
  // Production runs `MYCEL_SANDBOX=daytona`, and DaytonaSandbox.exec calls
  // `process.executeCommand(command)`, which hands the string to a shell WE DO NOT CONTROL. Every
  // double quote in the verify then closes Daytona's own wrapper, and bash reports:
  //
  //     /usr/bin/bash: line 1: unexpected EOF while looking for matching `"'   (exit 2)
  //
  // So verification never ran in production. It exited 2 before executing a single check, on every
  // build, and the run was failed with "the app does not build, so it is not a deliverable" — a
  // verdict about the agent's work that was never actually reached. TWENTY-ONE consecutive builds
  // failed this way, including one whose only fault was that the gate could not parse itself.
  //
  // The fix is to stop shipping quotes through somebody else's shell. `writeFile` is on every
  // backend, the payload is bytes rather than syntax, and `bash <path>` has nothing to escape.
  //
  // `set -o pipefail` stays and is not decoration: without it the exit status of `cmd | tail` is
  // TAIL's, which is 0 whatever the build did — a verification that can only ever pass, which is
  // worse than none because it looks like proof.
  // The lock, and `set -o pipefail` comes with it (see `lockedScript`). Without the lock a preview
  // boot triggered by the founder opening a tab can be running `npm install` in this very directory
  // while the line below runs another one — see WORKSPACE_LOCK_DIR for what that costs.
  const script = lockedScript(
    [`cd ~/${ws.dir} || exit 2`, `{ ${ws.verify}; } 2>&1 | tail -c 4000`].join("\n"),
  );

  await sandbox.writeFile(VERIFY_SCRIPT_PATH, script);

  // ── PARSE BEFORE RUNNING, SO A BROKEN GATE NEVER READS AS A BROKEN BUILD ──────────────────────
  //
  // `bash -n` compiles the script without executing it. It costs milliseconds and it separates two
  // failures that are indistinguishable in the output and opposite in meaning: "the agent's app is
  // wrong" (exit non-zero, the verdict we want) and "OUR gate is malformed" (exit 2 before a single
  // check runs, a verdict about nothing). Both previously surfaced as `the app does not build, so
  // it is not a deliverable` — a sentence about the agent's work, printed when the gate had not
  // looked at it. That is the worst kind of error message: confidently wrong about whose fault it
  // is, and it sent the investigation into the transport for two days while the real cause was a
  // `slice(0, 500)` in this file (see MAX_VERIFY_CHARS).
  //
  // Thrown, not returned as a failed verification, because it is OUR bug and no amount of agent
  // retrying can fix it. It must page us, not fail the task's work.
  const syntax = await sandbox.exec(`bash -n ~/${VERIFY_SCRIPT_PATH}`, 30_000);
  if (syntax.code !== 0) {
    throw new Error(
      `workspace.verify is not a valid shell script and was never run — this is a kernel/manifest ` +
        `bug, not a fault in the task's work: ${(syntax.stderr || syntax.stdout || "").trim().slice(0, 500)}`,
    );
  }

  const r = await sandbox.exec(`bash ~/${VERIFY_SCRIPT_PATH}`, ws.verifyTimeoutMs);
  return { ok: r.code === 0, code: r.code, tail: (r.stdout || r.stderr || "").trim().slice(-4000) };
}

// ---------------------------------------------------------------------------------------------
// Did it actually build anything?
// ---------------------------------------------------------------------------------------------

/**
 * Hash every exportable file in the workspace, from inside the sandbox.
 *
 * ONE exec, not one per file: this runs against a tree the agent may have filled with a few hundred
 * source files, and a round trip each would cost more than the export it precedes.
 *
 * `find -type f` walks everything and the exclusion list is applied HERE, in Node, by the same
 * `excluded()` the seed and the export use. Pushing the exclusions into `find`'s own predicate
 * would mean maintaining the glob dialect twice, in two languages, and the two drifting is exactly
 * how `node_modules` ends up in a comparison — 30,000 files that are in neither the seed nor the
 * deliverable, every one of them reported as authored by the agent.
 *
 * Sizes come from a separate `wc -c` rather than `stat`, for the reason `exportDirectory` gives:
 * `stat -c` is GNU-only and `stat -f` is BSD-only, and this has to run on a developer's macOS as
 * well as in the microVM.
 *
 * NUL-delimited (`-print0`, `xargs -0`) so a path with a space in it survives the trip. Returns an
 * empty tree when the command fails outright, which `assertSubstantiveChange` treats as "cannot
 * judge" rather than "changed nothing" — see there.
 */
export async function collectTree(
  sandbox: Pick<Sandbox, "exec">,
  ws: ResolvedWorkspace,
): Promise<{ tree: import("./substantive").Tree; ok: boolean }> {
  const cmd =
    `cd ~/${ws.dir} 2>/dev/null || exit 3; ` +
    `find . -type f -print0 | xargs -0 -r sha256sum 2>/dev/null; ` +
    `echo MYCEL_TREE_SPLIT; ` +
    `find . -type f -print0 | xargs -0 -r wc -c 2>/dev/null`;
  const r = await sandbox.exec(cmd, 300_000);
  if (r.code !== 0) return { tree: new Map(), ok: false };
  const [sums = "", wc = ""] = (r.stdout || "").split("MYCEL_TREE_SPLIT");
  const sizes = sizesFromWc(wc);
  const raw = treeFromSums(sums, sizes);

  const tree: import("./substantive").Tree = new Map();
  for (const [path, stat] of raw) {
    if (path.split("/").some((seg) => excluded(seg, ws.exclude))) continue;
    tree.set(path, stat);
  }
  return { tree, ok: true };
}

/** One delimiter line per file. Chosen to be something no source file contains. */
const SITE_FILE_MARK = "===MYCEL_SITE_FILE ";

/**
 * The TEXT of the site's source files, for `scoreSite`.
 *
 * `collectTree` above hashes the workspace and is the right shape for the effort gate, which only
 * needs to know whether bytes changed. Quality needs the bytes themselves: template residue is a
 * string match, hardcoded hex is a string match, and the signature motif is counted across files.
 *
 * NARROW ON PURPOSE. Only `.tsx`, `.ts` and `.css`, never `node_modules`, `.next` or `.git`, and
 * nothing over 200KB — a generated lockfile or a bundled asset contributes nothing to any of the
 * four measures and would blow the exec's stdout limit, at which point the sweep silently returns a
 * PREFIX of the site and every count is quietly wrong. Bounded at 500 files for the same reason.
 *
 * A truncated read is reported as a failure to read rather than as a smaller site, because "we saw
 * 300 of your files and found no template copy" is not the same claim as "there is no template
 * copy" and only one of them is safe to act on.
 */
export async function collectSiteFiles(
  sandbox: Pick<Sandbox, "exec">,
  ws: ResolvedWorkspace,
): Promise<{ files: SiteFile[]; ok: boolean }> {
  const cmd =
    `cd ~/${ws.dir} 2>/dev/null || exit 3; ` +
    `find . -type f \\( -name '*.tsx' -o -name '*.ts' -o -name '*.css' \\) ` +
    `! -path './node_modules/*' ! -path './.next/*' ! -path './.git/*' -size -200k ` +
    `| sed 's|^\\./||' | LC_ALL=C sort | head -n 500 ` +
    `| while IFS= read -r f; do printf '${SITE_FILE_MARK}%s===\\n' "$f"; cat "$f" 2>/dev/null; printf '\\n'; done`;

  const r = await sandbox.exec(cmd, 300_000);
  if (r.code !== 0) return { files: [], ok: false };
  const out = r.stdout || "";
  // The exec layer truncates at EXEC_STDOUT_LIMIT_BYTES. A prefix of the site would under-count
  // residue and read as a clean result, so it is reported as unreadable instead.
  if (out.length >= EXEC_STDOUT_LIMIT_BYTES) return { files: [], ok: false };

  const files: SiteFile[] = [];
  for (const chunk of out.split(SITE_FILE_MARK).slice(1)) {
    const end = chunk.indexOf("===\n");
    if (end < 0) continue;
    const path = chunk.slice(0, end).trim();
    if (!path) continue;
    files.push({ path, text: chunk.slice(end + 4) });
  }
  return { files, ok: true };
}

/**
 * FAIL THE RUN IF IT ONLY RECOLOURED THE TEMPLATE.
 *
 * Runs after the app has been proved to compile and boot, and before the export, so a run that gets
 * here has produced something that WORKS and the only remaining question is whether it is the thing
 * that was asked for. That order is deliberate: a build that is both broken and trivial should be
 * reported as broken, because that is the more actionable of the two failures.
 *
 * ─── Every way this declines to judge ─────────────────────────────────────────────────────────
 *
 * All three of these return without an opinion, and all three are cases where a failure would be
 * the kernel punishing an agent for the kernel's own situation:
 *
 *   · the wedge asked for no check (`ws.substantive` undefined) — the default, for every wedge.
 *   · the wedge seeded no scaffold, or the seed came back empty — nothing to be unchanged from.
 *   · the hash sweep itself failed — an unreadable tree is a transport problem, and a transport
 *     problem must not be reported to a founder as "your agent did nothing". The export that runs
 *     immediately after will produce the real diagnosis.
 *
 * That bias is the same one substantive.ts argues for in its header: never throw away a run that
 * did real work. The check is here to make an invisible failure visible, not to add a new way to
 * lose a build.
 *
 * The `seed` argument is the outcome of `seedWorkspace` for THIS run — the exact bytes the kernel
 * wrote, not a re-read of the template directory. See `treeFromSeed`.
 */
export async function assertSubstantiveChange(args: {
  sandbox: Pick<Sandbox, "exec">;
  ws: ResolvedWorkspace;
  seed: { files: SeedFile[] } | null | undefined;
  emit?: (type: "progress", data: Record<string, unknown>) => Promise<void> | void;
}): Promise<ChangeReport | null> {
  const { sandbox, ws, seed, emit } = args;
  const rule = ws.substantive;
  if (!rule) return null;
  if (!ws.seed || !seed?.files?.length) {
    await emit?.("progress", {
      note: "substantive-change check skipped: this run seeded no scaffold, so there is nothing to compare against",
    });
    return null;
  }

  const { tree, ok } = await collectTree(sandbox, ws);
  if (!ok) {
    await emit?.("progress", {
      note: `substantive-change check skipped: could not read ~/${ws.dir} to hash it`,
    });
    return null;
  }

  const report = classifyChange(treeFromSeed(seed.files), tree, rule);
  await emit?.("progress", {
    note: report.ok
      ? `substantive change confirmed: ${report.structuralAdded.length} new and ` +
        `${report.structural.length - report.structuralAdded.length} rewritten source file(s), ` +
        `${report.changedBytes} bytes authored`
      : `substantive-change check FAILED: ${report.reason}`,
    added: report.added.slice(0, 40),
    modified: report.modified.slice(0, 40),
    removed: report.removed.slice(0, 40),
  });

  if (!report.ok) {
    throw new Error(
      `workspace verification failed: the build produced no substantive change. ${report.reason}\n` +
        `--- files added ---\n${report.added.join("\n") || "(none)"}\n` +
        `--- files modified ---\n${report.modified.join("\n") || "(none)"}`,
    );
  }
  return report;
}
