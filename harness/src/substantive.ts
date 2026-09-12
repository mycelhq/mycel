/**
 * DID THE RUN ACTUALLY BUILD ANYTHING?
 *
 * ─── The bug this exists to make visible ──────────────────────────────────────────────────────
 *
 * `product-builder` seeds `business-template` into the sandbox and exports whatever comes back.
 * Every other guard in the hand-off asks whether that thing WORKS: `assertRemoteBuildSucceeded`
 * asks whether it compiled, `verifyWorkspace` asks whether it boots and serves a styled page.
 * Nothing asked whether it is DIFFERENT from the scaffold it started as.
 *
 * So the cheapest path to a green run was: swap the strings in `content/marketing.ts`, nudge the
 * tokens in `app/globals.css`, `npx shadcn add` two components to satisfy the component count, stop.
 * That compiles, boots, serves a 200, ships an 80KB stylesheet and two library components — a
 * perfect score against every existing check — and it is the founder's complaint verbatim: "it
 * never builds anything new, it just updates global CSS at most and deploys the template."
 *
 * Production bears it out. Completed `build_feature` runs finished in two to three minutes for
 * about a cent of model spend, against a budget of an hour and five dollars (runs 1c8e93db,
 * 8a90c16f, f3a5e16f, e4dbc13f). That is not a build. That is a few turns of copy editing, and it
 * was reported as `succeeded` because success was defined as "the app still runs".
 *
 * ─── What this module adds ────────────────────────────────────────────────────────────────────
 *
 * One more question, asked by the kernel, from outside the sandbox, against the seed the kernel
 * itself wrote: WHICH FILES CHANGED, and is that change substantive or cosmetic?
 *
 * A build that changed nothing is now a visible FAILURE with a reason that names the files, rather
 * than a success nobody looks at. That is the whole point — this check earns its keep the first
 * time it fails, because the failure is the thing that has been invisible for months.
 *
 * ─── Why the classification is what it is ─────────────────────────────────────────────────────
 *
 * "Cosmetic" is not a judgement about importance, it is a judgement about AUTHORSHIP. These are the
 * paths an agent can change without designing anything:
 *
 *   · `app/globals.css`   — the token block. Recolouring. The literal thing the founder named.
 *   · `content/**`        — the copy. Real work, but it is filling a form the template already
 *                           printed; two businesses that differ only here have the same silhouette.
 *   · `components/ui/**`  — shadcn's own output. `npx shadcn add card` writes files nobody authored.
 *   · `*.json`, `*.md`, lockfiles, `public/**` — configuration and install residue.
 *
 * Everything else — a new `.tsx` under `components/`, a new route under `app/`, a rewritten
 * `app/page.tsx` — is structure somebody decided on. `require_new_file` is the sharpest of the
 * knobs and the one that targets the complaint most directly: it demands the run leave behind at
 * least one source file the template does not ship. You cannot satisfy that by editing strings.
 *
 * ─── The direction the failure modes point ────────────────────────────────────────────────────
 *
 * Deliberately biased AGAINST false failure. Hashes come back over the same exec transport that
 * carries the export, and if that transport ever mangled content systematically then every file
 * would read as modified — which makes the gate PASS wrongly, never fail wrongly. A run that did
 * real work must never be thrown away by this check; a run that did nothing must never be shipped
 * by it. When the two risks conflict, the first one wins.
 *
 * Pure and transport-free on purpose: `classifyChange` takes two maps and a rule, so the
 * interesting behaviour is testable without a sandbox. See `substantive.test.ts`.
 */

import { createHash } from "node:crypto";

/**
 * The knobs, as a wedge declares them.
 *
 * Every one is optional and the defaults below are the ones `product-builder` wants, because a
 * wedge that turns this on has already said the interesting thing and should not have to restate
 * the numbers.
 */
export interface SubstantiveSpec {
  /** Structural (non-cosmetic) files that must have been added or modified. */
  min_changed_files?: number;
  /** Total bytes across those files, counted on the NEW content. Guards a one-character edit. */
  min_changed_bytes?: number;
  /**
   * At least one structural file must be NEW — not present in the seed at all.
   *
   * The strongest signal that somebody authored rather than filled in, and the one that cannot be
   * faked by a copy swap. Set false for a wedge whose builds are genuinely edits to existing files.
   */
  require_new_file?: boolean;
  /** Added to (never replacing) `DEFAULT_COSMETIC`. Same glob-lite dialect. */
  cosmetic?: string[];
}

export interface SubstantiveRule {
  minChangedFiles: number;
  minChangedBytes: number;
  requireNewFile: boolean;
  cosmetic: string[];
}

/** See the header: authorship, not importance. */
export const DEFAULT_COSMETIC = [
  "app/globals.css",
  "content/**",
  "components/ui/**",
  "public/**",
  "**/*.json",
  "**/*.md",
  "**/*.lock",
  "**/*.txt",
  "**/.mycel-*",
];

/**
 * Enough to be a build, low enough that an honest small feature still passes.
 *
 * Three structural files is roughly "a component, the page that renders it, and one more" — the
 * shape of the smallest change that is actually a change in the page's structure. 2000 bytes is
 * about sixty lines of TSX. Neither is delicate; the recolour-only run scores zero on both.
 */
export const DEFAULT_SUBSTANTIVE: SubstantiveRule = {
  minChangedFiles: 3,
  minChangedBytes: 2000,
  requireNewFile: true,
  cosmetic: DEFAULT_COSMETIC,
};

export function resolveSubstantive(spec: SubstantiveSpec | boolean | undefined | null): SubstantiveRule | undefined {
  if (spec === undefined || spec === null || spec === false) return undefined;
  if (spec === true) return { ...DEFAULT_SUBSTANTIVE };
  const n = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : d);
  return {
    minChangedFiles: n(spec.min_changed_files, DEFAULT_SUBSTANTIVE.minChangedFiles),
    minChangedBytes: n(spec.min_changed_bytes, DEFAULT_SUBSTANTIVE.minChangedBytes),
    requireNewFile: spec.require_new_file !== false,
    cosmetic: [
      ...DEFAULT_COSMETIC,
      ...(Array.isArray(spec.cosmetic) ? spec.cosmetic.filter((c) => typeof c === "string" && c.trim()) : []),
    ],
  };
}

/** One file, as either side of the comparison knows it. */
export interface FileStat {
  sha: string;
  bytes: number;
}

export type Tree = Map<string, FileStat>;

/**
 * Glob-lite, matched per path segment, with `**` spanning segments.
 *
 * The same dialect `DEFAULT_EXCLUDES` uses in workspace.ts, extended with `**` because these
 * patterns address a tree rather than a filename. Kept tiny and dependency-free deliberately: a
 * pattern language nobody can predict is worse than one that only does prefixes.
 */
export function matchesGlob(path: string, pattern: string): boolean {
  const rx = new RegExp(
    "^" +
      pattern
        .split(/(\*\*\/|\*\*|\*)/)
        .map((part) => {
          if (part === "**/") return "(?:[^/]+/)*";
          if (part === "**") return ".*";
          if (part === "*") return "[^/]*";
          return part.replace(/[.+^${}()|[\]\\?]/g, "\\$&");
        })
        .join("") +
      "$",
  );
  return rx.test(path);
}

export function isCosmetic(path: string, cosmetic: string[]): boolean {
  return cosmetic.some((p) => matchesGlob(path, p));
}

export interface ChangeReport {
  ok: boolean;
  /** Present exactly when `ok` is false. Written to be read by a human in a failed run's reason. */
  reason?: string;
  added: string[];
  modified: string[];
  removed: string[];
  /** The subset of added+modified that is not cosmetic — the files somebody had to decide on. */
  structural: string[];
  /** The subset of `added` that is not cosmetic. */
  structuralAdded: string[];
  /** Bytes of the NEW content of every structural file. */
  changedBytes: number;
}

/** A short, quoted file list for a failure message. Bounded, because a reason is not a manifest. */
function list(paths: string[], max = 8): string {
  if (!paths.length) return "none";
  const head = paths.slice(0, max).map((p) => `\`${p}\``).join(", ");
  return paths.length > max ? `${head} (+${paths.length - max} more)` : head;
}

/**
 * Compare what came back against what was seeded.
 *
 * `seed` is what the kernel wrote into the sandbox before the first turn; `current` is what the
 * sandbox holds after the agent stopped. Both are keyed by path relative to the workspace dir.
 *
 * A seed of size zero means the wedge declared no scaffold — there is nothing to be "the same as",
 * so every file is authored and the check has no opinion. Returning ok is the honest answer, not a
 * dodge: this gate exists to catch "you shipped the template back", and without a template it
 * cannot fire.
 */
export function classifyChange(seed: Tree, current: Tree, rule: SubstantiveRule): ChangeReport {
  const added: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];

  for (const [path, stat] of current) {
    const before = seed.get(path);
    if (!before) added.push(path);
    else if (before.sha !== stat.sha) modified.push(path);
  }
  for (const path of seed.keys()) if (!current.has(path)) removed.push(path);

  added.sort();
  modified.sort();
  removed.sort();

  const structuralAdded = added.filter((p) => !isCosmetic(p, rule.cosmetic));
  const structural = [...structuralAdded, ...modified.filter((p) => !isCosmetic(p, rule.cosmetic))].sort();
  const changedBytes = structural.reduce((n, p) => n + (current.get(p)?.bytes ?? 0), 0);

  const base: Omit<ChangeReport, "ok" | "reason"> = {
    added,
    modified,
    removed,
    structural,
    structuralAdded,
    changedBytes,
  };

  // No scaffold to differ from. See the header on this function.
  if (seed.size === 0) return { ok: true, ...base };

  const cosmeticChanged = [...added, ...modified].filter((p) => isCosmetic(p, rule.cosmetic));

  if (!added.length && !modified.length && !removed.length) {
    return {
      ok: false,
      reason:
        "the run changed NOTHING — the exported application is byte-for-byte the seed template. " +
        "Whatever the agent reported, no file it was asked to build was written.",
      ...base,
    };
  }

  if (!structural.length) {
    return {
      ok: false,
      reason:
        `the run changed only cosmetic files (${list(cosmeticChanged)}) — this is the template ` +
        "recoloured and re-worded, not a site that was built. Nothing under `components/` or " +
        "`app/` was authored or restructured, so every business built this way ships the same " +
        "silhouette. Author real sections: new components, a page structure that follows the " +
        "approved identity's section plan and signature motif.",
      ...base,
    };
  }

  if (rule.requireNewFile && !structuralAdded.length) {
    return {
      ok: false,
      reason:
        "the run added no new source file. It edited " +
        `${list(structural)} but authored nothing the template does not already ship, and a build ` +
        "that only edits the scaffold's own files cannot express a structure the scaffold does not " +
        "already have. Write at least one new component or route of your own.",
      ...base,
    };
  }

  if (structural.length < rule.minChangedFiles) {
    return {
      ok: false,
      reason:
        `only ${structural.length} substantive file(s) changed (${list(structural)}), below the ` +
        `${rule.minChangedFiles} this wedge requires. A real build touches the sections it authors, ` +
        "the page that composes them, and the content that feeds them.",
      ...base,
    };
  }

  if (changedBytes < rule.minChangedBytes) {
    return {
      ok: false,
      reason:
        `the substantive change is only ${changedBytes} bytes across ${structural.length} file(s) ` +
        `(${list(structural)}), below the ${rule.minChangedBytes} this wedge requires. That is a ` +
        "tweak, not a build.",
      ...base,
    };
  }

  return { ok: true, ...base };
}

export function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * The seed side of the comparison, built from the same bytes `seedWorkspace` wrote.
 *
 * Taking it from `readSeed`'s output rather than re-reading the disk matters: the sandbox only ever
 * received the files that survived `readSeed`'s exclusions and its binary skip, so those are the
 * only files that can possibly be "unchanged". Hashing the whole template directory instead would
 * report every skipped binary as `removed` on every run.
 */
export function treeFromSeed(files: { name: string; content: string }[]): Tree {
  const t: Tree = new Map();
  for (const f of files) t.set(f.name, { sha: sha256(f.content), bytes: Buffer.byteLength(f.content, "utf8") });
  return t;
}

/**
 * Parse `sha256sum`'s output into a tree.
 *
 * GNU coreutils prints `<64 hex><space><space-or-*><path>`; busybox prints the same. Paths come out
 * `./`-prefixed from a `find`-driven invocation, which is stripped here so both sides of the
 * comparison are keyed identically — a leading `./` on one side and not the other would report the
 * entire tree as added AND removed, which is a passing verdict for the worst possible reason.
 */
export function treeFromSums(stdout: string, sizes: Map<string, number>): Tree {
  const t: Tree = new Map();
  for (const line of stdout.split("\n")) {
    const m = /^([0-9a-f]{64})\s[\s*](.+)$/.exec(line.trim() ? line : "");
    if (!m) continue;
    const path = m[2]!.replace(/^\.\//, "");
    if (!path) continue;
    t.set(path, { sha: m[1]!, bytes: sizes.get(path) ?? 0 });
  }
  return t;
}

/** `wc -c` output (`<bytes> <path>`) into a map, same `./` normalisation as above. */
export function sizesFromWc(stdout: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const line of stdout.split("\n")) {
    const hit = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!hit) continue;
    const path = hit[2]!.replace(/^\.\//, "");
    // `wc -c` on multiple files ends with a `total` line that is not a path.
    if (!path || path === "total") continue;
    m.set(path, Number(hit[1]));
  }
  return m;
}
