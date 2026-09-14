/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * WHERE THE RUNTIME LIBRARY LIVES — ONE ANSWER, NOT SEVEN
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Seven directories are DATA this kernel reads off disk while it runs: blueprints, packs, workflows,
 * service-skills, design-systems, craft, templates. They sat at the repository root beside the
 * source, each with its own resolver, and the Dockerfile needed a separate `COPY` for every one.
 *
 * It forgot six times. Each omission is a comment in that file, and each was found the same way —
 * by running the built image rather than by building it, because every one of these resolvers fails
 * SOFT. The directory is missing, the resolver returns nothing, the container passes its health
 * check, and the product is quietly worse in a way no error surface mentions:
 *
 *   · wedges / blueprints — "unknown wedge" to every task, 404 to every blueprint
 *   · workflows / service-skills — a `lib` workflow 404s and the skill library seeds EMPTY
 *   · design-systems — every deliverable degrades to no house style at all
 *   · craft — every client-facing run produced without the rules it is supposed to be held to
 *   · packs — 4,442 `workflow:*` calls in production and ZERO `pack:*`, ever, while four shipped
 *     wedges declared packs in their manifests
 *
 * So the grouping is not tidying. One `COPY library ./library` cannot be forgotten the way six
 * separate lines were, and the eighth directory added under it is carried without anybody
 * remembering to say so.
 *
 * ═══ EVERY RESOLVER KEEPS ITS OWN ENV OVERRIDE ═══
 *
 * `MYCEL_WORKFLOW_LIB_DIR`, `MYCEL_PACKS_DIR`, `MYCEL_CRAFT_DIR` and the rest still win, unchanged.
 * A deployment that points one of them somewhere else — and the tests do exactly this — must not
 * care where the default moved to. `MYCEL_LIBRARY_DIR` moves the whole set at once, which is the
 * thing that was previously impossible.
 *
 * `wedges/` is deliberately NOT in here. It is the repository's headline concept, it is the first
 * thing the README explains, and burying the answer to "what is a wedge" one level down to make a
 * directory listing shorter would be tidying at the cost of the thing being tidied.
 */
import { join } from "node:path";

export function libraryDir(): string {
  return process.env.MYCEL_LIBRARY_DIR ?? join(process.cwd(), "library");
}

/** One entry in the runtime library, honouring that entry's own override first. */
export function libraryPath(name: string, override?: string): string {
  const env = override?.trim();
  return env || join(libraryDir(), name);
}


/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * AND THE PART THAT MAKES A MISSING DIRECTORY LOUD
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Grouping stops the Dockerfile forgetting. It does not stop a bad mount, a bad `MYCEL_*_DIR`, a
 * partial image, or a self-hoster who copied six of seven — and every one of those reproduces the
 * original bug, because every resolver here fails SOFT. `listPacks()` returns `[]`. `sharedCraft()`
 * returns `[]`. `designSystemIds()` returns `[]`. The container is healthy and the product is
 * quietly worse.
 *
 * All six were found by somebody eventually running the built image and looking. This is that look,
 * done at boot, by the process that knows where it expects things to be.
 *
 * ═══ IT WARNS, IT DOES NOT REFUSE ═══
 *
 * `sandboxReachability` refuses to start, and is right to: without it EVERY task fails at its first
 * callback, so a green target is a lie about everything. This is different. A deployment with no
 * `templates/` builds nothing and serves every other request correctly, and a kernel that will not
 * boot without a directory some installations have no use for is a worse product than one that says
 * what it is missing. So: one block on stderr, naming each gap and its cost, and the same list on
 * `/health` so it can be read from outside without a shell.
 */
export interface LibraryGap {
  entry: string;
  path: string;
  /** What is silently absent while this is. Written for whoever is reading a container log at 2am. */
  cost: string;
}

/**
 * What each entry is for, in the words of the bug that proved it.
 *
 * Every line here was written after the directory went missing in production, which is why they say
 * what BREAKS rather than what the directory contains.
 */
const ENTRIES: ReadonlyArray<{ name: string; env: string; cost: string }> = [
  { name: "blueprints", env: "MYCEL_BLUEPRINTS_DIR", cost: "every blueprint answers 404, so nothing can be provisioned from one" },
  { name: "packs", env: "MYCEL_PACKS_DIR", cost: "every declared pack is unreachable — the deterministic arithmetic a model must not do by hand" },
  { name: "workflows", env: "MYCEL_WORKFLOW_LIB_DIR", cost: "a wedge that references a shared workflow by `lib` 404s mid-run" },
  { name: "service-skills", env: "MYCEL_SERVICE_SKILLS_DIR", cost: "the curated skill library seeds EMPTY and every run is ungrounded" },
  { name: "design-systems", env: "MYCEL_DESIGN_SYSTEMS_DIR", cost: "every deliverable degrades to no house style at all" },
  { name: "craft", env: "MYCEL_CRAFT_DIR", cost: "every client-facing run is produced without the rules it is supposed to be held to" },
  { name: "templates", env: "MYCEL_TEMPLATES_DIR", cost: "every build run starts the agent from an empty directory" },
];

/** Which library entries are not where this process expects them. Empty is the healthy answer. */
export function libraryGaps(exists: (p: string) => boolean): LibraryGap[] {
  const out: LibraryGap[] = [];
  for (const e of ENTRIES) {
    const path = libraryPath(e.name, process.env[e.env]);
    if (!exists(path)) out.push({ entry: e.name, path, cost: e.cost });
  }
  return out;
}

/** The block that goes on stderr at boot. Empty string when there is nothing to say. */
export function libraryGapReport(gaps: readonly LibraryGap[]): string {
  if (!gaps.length) return "";
  return [
    "",
    `  ! ${gaps.length} of the kernel's runtime library ${gaps.length === 1 ? "directory is" : "directories are"} missing.`,
    "    The API will answer normally and these features will be silently absent:",
    "",
    ...gaps.map((g) => `      ${g.entry.padEnd(15)} ${g.cost}\n      ${" ".repeat(15)} looked in ${g.path}`),
    "",
  ].join("\n");
}
