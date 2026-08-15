// A "wedge" is a service the kernel can fulfill. The founder brings four things:
//   wedge.json  — definition (task types + output schema/rubric, tools, approvals, model)
//   skills/     — procedures / know-how (SKILL.md files: how to do the job well)
//   knowledge/  — documents that ground the agent (playbooks, policies, pricing, examples)
//   (per task)  — uploaded documents + connected accounts, passed in task.input
// At run time the harness mounts skills + knowledge (+ task documents) into the sandbox so
// OpenCode can actually do the work. This is how a service becomes solvable.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Risk } from "./contract";
import type { HarnessProfileSpec } from "./harness";
import type { IntakeQuestion } from "./intake";
import type { WorkspaceSpec } from "./workspace";

export interface WedgeTaskType {
  /**
   * How hard this job actually is: "fast" | "standard" | "deep".
   *
   * Declared per task_type because a wedge does several different things — classifying an inbound
   * message is not the same work as reconciling a month. Clamped by the org's plan at run time.
   *
   * Kept alongside `harness.tier` as the shorter spelling: wedges already use it, and forcing a
   * nesting level on every existing manifest to gain nothing would be a poor trade.
   */
  tier?: string;
  description?: string;
  input_schema?: unknown;
  output_schema?: unknown;
  /**
   * How to engineer the harness for THIS task type — tools, permissions, tier, budgets, whether
   * the run may hold the action token. See harness.ts; every field is a request, clamped by the
   * org's plan and the server's ceilings. Absent means the permissive `general` shape, i.e. exactly
   * what every task got before profiles existed.
   */
  harness?: HarnessProfileSpec;
  /**
   * What this task type starts from and hands back as a DIRECTORY. See workspace.ts.
   *
   * Absent for every wedge that existed before it — and that is the contract: a wedge saying
   * nothing here still produces exactly one `result.txt` and nothing about its run changes.
   */
  workspace?: WorkspaceSpec;
  /**
   * WHAT A SUCCESSFUL RUN OF THIS TYPE MUST HAVE ACTUALLY DONE. See promises.ts.
   *
   * `{ "send": { "unless": { "step": ["hold"], "channel": ["none"] } } }` means: this run must have
   * put an outward action in front of the approval gate before it may be called succeeded, unless
   * its own validated output says it decided to stay silent.
   *
   * Absent on every task type that does not declare it, and such a run is byte-for-byte unchanged.
   * Deliberately declared rather than inferred — the argument is in promises.ts, along with the
   * production run this exists because of.
   */
  promises?: unknown;
  /**
   * WHERE THIS TASK TYPE STOPS, and what picks it up again. See `armDeclaredWait` in waits.ts.
   *
   * ═══ WHY A MANIFEST FIELD AND NOT CODE ═══
   *
   * `waits.ts` shipped complete and nothing armed a wait, so the only way an engagement ever parked
   * was a founder knowing the capability existed and asking for it — a feature nobody triggers. The
   * alternative to this field was a `switch (wedge)` in the kernel, which makes waiting something the
   * KERNEL does to three named wedges rather than something a wedge declares about itself; vision.md
   * §7 is explicit that every new wedge should inherit waiting rather than have it reinvented for it.
   *
   * `on: "client_request"` is the only trigger, and deliberately so: a run asking the client for
   * something is the one place the kernel can SEE a run stop, with no model cooperation and no new
   * event. A task type that ends by sending (a dunning chase) is not eligible — see the "no second
   * ladder" section of `armDeclaredWait`.
   */
  waits_for?: {
    /** The observable end-of-run the kernel arms on. One value today; a union so it can grow. */
    on: "client_request";
    /**
     * The task type the resumed run spawns — the NEXT step, never this one.
     *
     * A resume that re-ran the task type which raised the ask would chase the client again the moment
     * they answered it. Validated against this wedge's own manifest at arm time.
     */
    resume: string;
    /** The founder-readable sentence on `/next` and the timeline. Required: "waiting" with no why is noise. */
    reason: string;
  };
}

export interface WedgeApproval {
  action: string;
  risk: Risk;
  required: boolean;
}

export interface WedgeManifest {
  /** Default tier for every task_type that does not declare one. */
  tier?: string;
  /** Wedge-wide harness defaults, overridden per task_type. See harness.ts. */
  harness?: HarnessProfileSpec;
  /** Wedge-wide workspace default, overridden per task_type — same two-level shape as `harness`. */
  workspace?: WorkspaceSpec;
  wedge: string;
  title?: string;
  /**
   * Machinery, not a service anybody sells. Absent means "a service", because that is what a wedge is.
   *
   * ─── THE FAILURE THIS EXISTS FOR ───
   *
   * `/knowledge` derives its tabs from the wedges that have schedules or tasks, which is the right
   * source — there is no list of "wedges this project uses" anywhere else. But `business-shaper` runs
   * during onboarding and `harness-operator` runs on the kernel's own reflection clock, so both leave
   * tasks behind, so both grew tabs. A founder was shown a tab called "Business Shaper" and invited to
   * teach it, next to a "Books Keeper" tab for a bookkeeping service he does not run.
   *
   * ─── WHY A FLAG HERE RATHER THAN A DENYLIST IN THE CONSOLE ───
   *
   * `/clock` already had one, inline, one entry long (`s.wedge !== "harness-operator"`), and it was
   * already incomplete — it never learned about `business-shaper`. That is the whole argument: a
   * denylist lives wherever somebody noticed the symptom, so the second surface gets a different
   * answer from the first and the third gets none. Whether a wedge is a service is a fact about the
   * wedge, so the wedge declares it once and every surface reads the same declaration.
   *
   * It cannot be INFERRED, and that is worth stating rather than leaving as an open question. Every
   * structural signal is a coincidence of the current set: "declares no connections" also describes a
   * real service that only drafts, and "declares no intake questions" is true of `invoice-chaser`,
   * the most complete service in the repo. Nothing separates machinery from work except intent, and
   * intent has to be stated.
   */
  internal?: boolean;
  /**
   * WHICH KERNEL-INITIATED JOBS THIS WEDGE HOLDS. See roles.ts for the closed set and the argument.
   *
   * ─── THE FAILURE THIS EXISTS FOR ───
   *
   * Seven places in the kernel named a wedge DIRECTORY as a string literal — `DUNNING_WEDGE =
   * "invoice-chaser"`, `GTM_WEDGE = "gtm-operator"`, `wedge: "harness-operator"` — which made "the
   * harness is general and a trade is configuration" half true. The worst of them was the invoice
   * sweep: it spawned a `chase_invoice` task for `invoice-chaser` whether or not that wedge was
   * installed, which is a run with no output schema, no policy envelope and no knowledge.
   *
   * Same shape as `internal` above, and for the same reason: a fact about the wedge belongs on the
   * wedge, stated once, read by every surface. Unlike `internal` it is validated — an unknown role,
   * or a role claimed by a wedge that does not declare the task types the kernel spawns against it,
   * refuses at load. `internal` can afford to be lax because a wrong answer shows a spare tab; a
   * role that silently does not take means the kernel quietly stops chasing invoices.
   */
  provides?: string[];
  model?: string;
  task_types?: Record<string, WedgeTaskType>;
  tools?: string[];
  approvals?: WedgeApproval[];
  /**
   * Connection names/ids this wedge's agent may act through (via the action proxy).
   *
   * NAMES A SPECIFIC ROW, so it is only correct where the thing is genuinely singular and genuinely
   * ours — `linkedin` (a captured member session behind our proxy, not a brokered app) and a
   * founder's own bespoke endpoint. It was also how `invoice-chaser` declared `"stripe"` and
   * `books-keeper` declared `"bank-feed"`, which meant a business paid through QuickBooks got an
   * agent that had been granted nothing, silently: the name matched no connection, the grant was
   * empty, and the run went ahead with no hands. Use `capabilities` for anything with alternatives.
   */
  connections?: string[];
  /**
   * What this wedge's agent needs to be able to DO, by capability rather than by vendor.
   *
   * Resolved per project at grant time against whatever the founder actually connected — see
   * `capabilityConnections` in runtime.ts. Validated at load: a capability this kernel does not know
   * is a refusal naming the typo, because a silently-dropped capability is a run with no hands that
   * still reports a clean finish.
   */
  capabilities?: string[];
  /** Long-lived engagements: the stage machine a Case moves through. */
  cases?: { stages: string[]; initial?: string };
  /** Deterministic functions the agent may call. Founder code — the agent picks which one and the
   *  args, never the logic. Implementation is EITHER a per-wedge file (`workflows/<name>.mjs`) OR,
   *  when `lib` is set, a kernel-owned SHARED primitive from the verified library (workflowLibDir()).
   *  A shared reference is how a GENERATED service gets real mechanics without authoring code. */
  workflows?: Array<{ name: string; description?: string; input_schema?: unknown; output_schema?: unknown; lib?: string }>;
  /**
   * Versioned packs this wedge may call (`name@version`). Disk wedges and authored services may
   * both declare these — packs are pinned digests the agent cannot rewrite. See packs.ts.
   */
  packs?: string[];
  /** Policy-bounded autonomy: envelopes inside which actions auto-approve (see policy.ts).
   *  Absent means every action is gated — the safe default. */
  policy?: { auto_approve?: Array<{ action: string; max_amount_usd?: number; max_per_task?: number; max_per_day?: number }> };
  /** What this wedge needs to be told before it can do the job well. Answered once per project;
   *  each answer becomes a knowledge file the agent is grounded on. See intake.ts. */
  intake?: IntakeQuestion[];
  /**
   * Post-close fulfillment glue for this trade — client connects, intake asks, money plan template,
   * outbound deliverable shapes. Read by `kickoff.ts` when a prospect converts or a case is
   * explicitly kicked off. Absent means convert still opens the case; kickoff is a no-op.
   */
  fulfillment?: {
    client_connections?: Array<{ toolkit: string; ask: string; detail?: string }>;
    intake_asks?: Array<{ kind: string; ask: string; detail?: string }>;
    money_plan?: {
      currency: string;
      lines: Array<{ label: string; amount_minor: number; kind: string }>;
    };
    deliverable_shapes?: Array<"document" | "file_set" | "link">;
  };
  /** Skill filenames under skills/ (with or without .md). Omit to load all. */
  skills?: string[];
  /** Knowledge filenames under knowledge/. Omit to load all. */
  knowledge?: string[];
  /**
   * Which shared-library domains reach this wedge — "web-dev", "design", "bookkeeping". A skill in
   * the kernel-owned library tagged with any of these is mounted alongside the wedge's own skills at
   * run time. The seam by which a generated web-dev service inherits web-dev procedure without every
   * founder writing it. Absent means the wedge draws on its own skills only. See skill-library.ts.
   */
  domains?: string[];
}

export interface WedgeFile {
  name: string;
  content: string;
}

export interface LoadedWedge {
  manifest: WedgeManifest;
  dir: string;
  skills: WedgeFile[];
  knowledge: WedgeFile[];
}

export function wedgesDir(): string {
  return process.env.MYCEL_WEDGES_DIR ?? join(process.cwd(), "wedges");
}

/**
 * The kernel-owned SHARED workflow library — verified, parameterized mechanics (dunning, reconcile,
 * prorate…) that any wedge, including a GENERATED one, may reference by name instead of shipping its
 * own executable file. This is the seam that lets the hardcoded catalogue dissolve into the
 * generator: a service is "these primitives, composed", and the primitives live here, not in a
 * per-business directory.
 */
export function workflowLibDir(): string {
  return process.env.MYCEL_WORKFLOW_LIB_DIR ?? join(process.cwd(), "workflows");
}

/**
 * The mark that says "this service was written for ONE business and does not exist on disk".
 *
 * ═══ WHY A RESERVED CHARACTER RATHER THAN A REGISTRY LOOKUP ═══
 *
 * `loadWedge(slug)` has ~50 callers and takes no project id. Once the kernel can author a service
 * per project, every one of those callers becomes a potential cross-tenant read: project B asks for
 * a slug, some shared cache or directory answers with project A's manifest, and B's agent runs A's
 * job with A's policy envelope. Two cross-tenant leaks have already shipped in this repo and both
 * were an identifier that was optional or defaulted, so "add an optional projectId to loadWedge" is
 * the exact shape of the bug, not the fix.
 *
 * The fix is to make the leak IMPOSSIBLE rather than guarded. An authored slug carries a character
 * that cannot occur in a directory name we create, `loadWedge` refuses it outright, and therefore
 * every existing caller answers "unknown service" for an authored slug — fail-closed by
 * construction, with no caller needing to be taught anything. Reaching an authored service requires
 * `loadProjectWedge(projectId, slug)` in authored.ts, whose project id is a REQUIRED positional
 * argument that throws when empty.
 *
 * The property is cheap to check (`isAuthoredSlug` is a string test, no I/O, no store) and it is
 * pinned by a test: for any authored slug, `loadWedge` returns null.
 */
export const AUTHORED_SLUG_PREFIX = "drafted:";

/** Is this the slug of a service the kernel wrote for one business? Lexical — no I/O, no store. */
export function isAuthoredSlug(slug: string | undefined): boolean {
  return !!slug && slug.startsWith(AUTHORED_SLUG_PREFIX);
}

/** `"invoice-chasing"` → `"drafted:invoice-chasing"`. The only place an authored slug is minted. */
export function authoredSlug(base: string): string {
  return `${AUTHORED_SLUG_PREFIX}${base}`;
}

/**
 * A slug that is safe to `join()` onto a directory root.
 *
 * Refuses the authored mark (see above) and, while we are here, refuses path traversal. `loadWedge`
 * previously did `join(root, slug)` on an unvalidated string, so a slug of `"../../etc"` read
 * outside `wedges/` — reachable from `POST /v1/tasks`, which passes `body.wedge` straight in. That
 * was only ever a read of a file named `wedge.json`, which is why it had not bitten, but "only
 * exploitable through a file called wedge.json" is not a security argument.
 */
function isDiskSlug(slug: string): boolean {
  if (!slug || isAuthoredSlug(slug)) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(slug) && !slug.includes("..");
}

/**
 * `root` exists so a caller can read a wedge from somewhere other than the install's own directory.
 *
 * `buildWedgeRoleIndex(dir)` documented itself as pointable at a fixture directory and was not:
 * it passed a slug to a reader that always resolved against `wedgesDir()`, so every fixture manifest
 * came back "could not be parsed as JSON" and the role-clash test appeared to pass for the wrong
 * reason. Defaulted rather than required, because every other caller genuinely means "this install".
 */
export function loadWedge(slug: string, root: string = wedgesDir()): LoadedWedge | null {
  // THE TENANCY GATE. An authored slug names a service that belongs to exactly one project and lives
  // in a project-scoped table, never on disk; answering here — with no project in hand — is the leak.
  // Returning null makes every existing caller say "unknown service", which is the honest answer for
  // a reader that cannot express which tenant is asking. See AUTHORED_SLUG_PREFIX above.
  if (!isDiskSlug(slug)) return null;
  const dir = join(root, slug);
  const manifestPath = join(dir, "wedge.json");
  if (!existsSync(manifestPath)) return null;
  let manifest: WedgeManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as WedgeManifest;
  } catch {
    return null;
  }
  const skills = readFiles(
    join(dir, "skills"),
    manifest.skills?.map((s) => (s.endsWith(".md") ? s : `${s}.md`)),
  );
  const knowledge = readFiles(join(dir, "knowledge"), manifest.knowledge);
  return { manifest, dir, skills, knowledge };
}

// ── "can this wedge be asked to do X" ────────────────────────────────────────────────────────────
//
// ═══ WHY THIS LIVES HERE AND NOT IN THE THREE PLACES THAT ASKED IT ═══
//
// The manifest is the SINGLE source of truth for what a wedge can be asked to do. A run spawned for
// a task type no manifest declares arrives with no output schema, no policy rules and no knowledge —
// an agent handed a verb nobody taught it, which is the "fully autonomous theater" vision.md refuses.
//
// Three modules had independently grown the same question. `wedgeCarriesNudge` in nudges.ts had the
// memo and the doc comment; `DeliverableDeps.wedgeCarries` in deliverables.ts declared itself, in
// its own comment, to be "the `wedgeCarriesNudge` question, asked of a verdict"; and adding a fourth
// caller for `check_in_case` would have been the third copy of a `Map<string, boolean>` over the
// same files. Copies of a cache are how one of them ends up stale after a test writes a manifest,
// and `_resetWedgeCache` only ever cleared one of them.
//
// So the lookup is here, next to `loadWedge`, and the callers keep their own names for it.

/** slug → (task type → declared). Wedges are files baked into the image; immutable for a process. */
const declaredTypes = new Map<string, Set<string>>();

function typesOf(wedge: string): Set<string> {
  const hit = declaredTypes.get(wedge);
  if (hit) return hit;
  const set = new Set(Object.keys(loadWedge(wedge)?.manifest?.task_types ?? {}));
  declaredTypes.set(wedge, set);
  return set;
}

/** Does this wedge declare this task type on disk? The gate every spawner consults. */
export function wedgeDeclares(wedge: string | undefined, taskType: string): boolean {
  if (!wedge) return false;
  return typesOf(wedge).has(taskType);
}

/**
 * Does ANY installed wedge declare this task type?
 *
 * The install-wide question, which is a different one and is asked by `upkeep.ts`: a sweep whose
 * every item would be refused for want of a carrier must not be given a clock. Answering it needs a
 * directory scan, so the result is memoised on the same argument the per-wedge memo makes.
 *
 * Reads the directory rather than the role index deliberately. A role is a job the KERNEL initiates
 * and holds exactly one claimant; "can somebody chase a client for a document" is neither — every
 * trade that asks a client for anything needs it, and roles.ts:31 explains at length why that makes
 * a cardinality-one role the wrong axis for it.
 */
const anyDeclares = new Map<string, boolean>();
export function anyWedgeDeclares(taskType: string): boolean {
  const hit = anyDeclares.get(taskType);
  if (hit !== undefined) return hit;
  let slugs: string[] = [];
  try {
    slugs = readdirSync(wedgesDir()).filter((d) => existsSync(join(wedgesDir(), d, "wedge.json")));
  } catch {
    // No wedges directory at all is a real install — `create-mycel-app` boots through it. Nothing
    // declares anything, which is the correct answer and not an error.
    slugs = [];
  }
  const ok = slugs.some((s) => wedgeDeclares(s, taskType));
  anyDeclares.set(taskType, ok);
  return ok;
}

/** Test seam — a test that writes a manifest must be able to invalidate BOTH memos. */
export function _resetWedgeDeclarations(): void {
  declaredTypes.clear();
  anyDeclares.clear();
}

function readFiles(dir: string, only?: string[]): WedgeFile[] {
  if (!existsSync(dir)) return [];
  const names = only ?? readdirSync(dir).filter((f) => !f.startsWith("."));
  const out: WedgeFile[] = [];
  for (const name of names) {
    const p = join(dir, name);
    if (existsSync(p)) {
      try {
        out.push({ name, content: readFileSync(p, "utf8") });
      } catch {
        /* skip unreadable */
      }
    }
  }
  return out;
}
