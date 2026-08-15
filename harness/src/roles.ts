// WHICH WEDGE DOES THE THING — resolved from what a wedge DECLARES, never from its name.
//
// ═══ THE FAILURE THIS EXISTS FOR ═══
//
// The kernel's central claim is that the harness is general and a trade is configuration. The
// manifest was general; the kernel around it was not. Seven places named a specific wedge directory
// as a string literal:
//
//   dunning.ts          `DUNNING_WEDGE = "invoice-chaser"`     — who chases an overdue invoice
//   gtm/stages.ts       `GTM_WEDGE = "gtm-operator"`           — whose cases the sequencer walks
//   gtm/routes.ts       `wedge: "gtm-operator"`                — the campaign proposal task
//   server.ts           `wedge: "harness-operator"`            — the reflection schedules
//   server.ts           `SHAPER_WEDGE_SLUG = "business-shaper"` — who drafted the onboarding questions
//   orchestrator.ts     `task.wedge === "harness-operator"`    — whose output is an improvement proposal
//   moves.ts            `wedge: "product-builder"`             — who would rewrite the losing hero
//
// Every one of them means "a wedge is a directory name the kernel knows". Rename a directory, ship a
// second dunning wedge with a better ladder, or install a trade that has no GTM at all, and the
// kernel is either silently wrong or crashes. The `invoice-chaser` case was the worst shape: the
// invoice sweep spawned a `chase_invoice` task for a wedge that may not exist on this install, which
// is a run with no output schema, no policy envelope and no knowledge — an agent handed a verb
// nobody taught it, reported as a started chase.
//
// ═══ THE VOCABULARY, AND WHAT IT IS NOT ═══
//
// A wedge declares `provides: ["dunning"]` — a ROLE, from the closed set below. A role is a JOB THE
// KERNEL ITSELF INITIATES: the invoice sweep starts a chase, the sequencer walks outreach cases,
// onboarding asks for a shape, the reflection clock asks for a review. Those four sentences are
// exactly the seven hardcodes, and the reason the axis is "role" rather than anything narrower:
//
//   · NOT capability-per-task-type. That mechanism already exists and is already used —
//     `wedgeCarriesNudge` asks `manifest.task_types["nudge_client_request"]` and needs no new field.
//     It answers "can this wedge be asked to do X", which is the right question when you already
//     have the wedge (from a Case, from a Task). It cannot answer "who do I ask", because two
//     wedges may both declare `chase_invoice` and the sweep must pick exactly one.
//
//   · NOT a `MoveKind` a wedge claims to carry. Tempting, because `TAKEABLE_KINDS` and
//     `carriersFor` are shaped like it. But it only covers the three hardcodes that are moves and
//     cannot express the other four: `business-shaper` carries no move (it runs during onboarding)
//     and neither does `harness-operator` (it runs on the reflection clock). A vocabulary that
//     leaves four of seven hardcodes in place is not the mechanism.
//
//   · NOT inferred from structure. The same argument `WedgeManifest.internal` makes: "declares
//     `chase_invoice`" would be true of a wedge that chases receipts, "declares no connections" is
//     true of a real service that only drafts. Intent has to be stated.
//
// A role therefore carries BOTH halves: a name, and the task types the kernel will actually spawn
// against it. Declaring a role you cannot perform is refused at load — see `buildWedgeRoleIndex`.
//
// ═══ CARDINALITY IS PART OF THE ROLE ═══
//
// Every role today is a singleton: there is ONE shaper, ONE thing the invoice sweep hands a chase
// to. Two wedges claiming one singleton is a configuration error and it FAILS LOUDLY at index
// build — it does not sort the slugs and take the first. Arbitrary selection is this repo's
// recurring bug: `nudgeWedgeFor` shipped with `scope.wedges[0] ?? DUNNING_WEDGE`, which would have
// chased a client for a bank statement in the invoice-chaser's dunning voice. `cardinality` is
// declared per role rather than assumed globally so that the day a role is genuinely many-valued
// (several wedges that can all answer an inbound email, say) it is a field and not a rewrite.
//
// ═══ ZERO CLAIMANTS IS A LEGITIMATE INSTALL, NOT AN ERROR ═══
//
// A bookkeeping-only install has no dunning wedge. `wedgeForRole` returns undefined, `whyNoWedge`
// gives the sentence to print, and the caller does NOTHING and says why. It must not crash the
// invoice sweep and it must not spawn a task for a wedge that is not there.
//
// ═══ WHY THIS IS NOT PROJECT-SCOPED, AND WHAT IS ═══
//
// Two questions get confused here and separating them is the whole safety argument:
//
//   1. "Which wedge on this INSTALL implements dunning?" — a fact about `wedges/` on disk, which is
//      baked into the image. Not tenant data. That is what this module answers, and giving it an
//      optional `projectId` would be a parameter every caller could forget.
//
//   2. "Is that wedge enabled for THIS project?" — tenant data, and already answered by
//      `ChaseDeps.wedgeEnabled(projectId, wedge)`, whose project id is a required argument of a
//      required object precisely because a defaulted scope here mails another tenant's clients.
//
// Both gates still run, in that order, at every call site. If availability ever becomes per-project
// the change is to add a REQUIRED `projectId` to a new resolver alongside this one — never an
// optional one to this one. Two cross-tenant leaks have shipped in this repo and both were a scope
// that defaulted.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadWedge, wedgesDir, type WedgeManifest } from "./wedge";
import { capabilityFault } from "./capabilities";

/**
 * The roles the kernel itself initiates work for.
 *
 * Closed on purpose. An open string set would let a manifest declare `provides: ["dunnign"]` and be
 * silently ignored, which is strictly worse than the hardcode it replaces: the hardcode was at least
 * visible in a grep. Adding a role means adding a line here, next to the task types that prove it.
 */
export const WEDGE_ROLES = {
  /** Chases overdue invoices. `sweepOverdueInvoices` hands every due debt to this wedge. */
  dunning: {
    cardinality: "one",
    task_types: ["chase_invoice"],
    /** Printed to a founder when nothing claims the role. Says what is missing and what stops. */
    absent: "no wedge in this install declares the `dunning` role, so overdue invoices are not chased automatically",
  },
  /**
   * Confirms received money to the client. `startReceipt` hands every settled invoice to this wedge.
   *
   * A SEPARATE ROLE FROM `dunning`, and the separation is the point. Chasing and thanking are the two
   * ends of the same conversation, but they are not the same job and a business can want one without
   * the other: a bookkeeping-only install issues receipts and never chases, and a firm that chases
   * hard may settle everything through a portal that already emails its own confirmations. Folding
   * receipts into `dunning` would mean a business gets both or neither, and — worse, given
   * `cardinality: "one"` — that installing a chaser would silently appoint it to speak to clients
   * about money it had nothing to do with.
   */
  receipts: {
    cardinality: "one",
    task_types: ["send_receipt"],
    absent: "no wedge in this install declares the `receipts` role, so a client is not sent confirmation when their payment is recorded",
  },
  /** Outbound: prospects, campaigns, sequence steps, replies. The whole `gtm/` subtree is its. */
  outreach: {
    cardinality: "one",
    task_types: ["find_prospects", "propose_campaign", "advance_sequences", "outreach_touch", "propose_reply"],
    absent: "no wedge in this install declares the `outreach` role, so there is no outbound machinery to run",
  },
  /**
   * Onboarding's only agent: drafts the shape of a business, the questions worth asking, and — when
   * nothing installed fits — the SERVICE ITSELF.
   *
   * `draft_service` is on this role rather than on a new one because it is the same job the shaper
   * already does, carried one step further. `draft_shape` reads a business and answers "which of the
   * installed services fits"; `draft_service` is what happens when the honest answer is "none", and
   * it is asked of the same agent, with the same knowledge of how to read a business, in the same
   * conversation. A second role would mean a second wedge that has to be taught all of that again.
   */
  business_shaping: {
    cardinality: "one",
    task_types: ["draft_shape", "draft_questions", "draft_service"],
    absent: "no wedge in this install declares the `business_shaping` role, so onboarding has no drafted questions to offer",
  },
  /** The kernel's reflection clock: reviews its own memory, work and artifacts. */
  self_improvement: {
    cardinality: "one",
    task_types: ["reflect_memory", "review_work", "review_artifacts"],
    absent: "no wedge in this install declares the `self_improvement` role, so the kernel does not review its own work",
  },
  /** Builds and ships the founder's own app. The carrier of `rewrite_losing_arm`. */
  app_building: {
    cardinality: "one",
    task_types: ["build_feature"],
    absent: "no wedge in this install declares the `app_building` role, so nothing here can change the founder's site",
  },
} as const satisfies Record<string, RoleSpec>;

interface RoleSpec {
  cardinality: "one";
  /** Task types the kernel spawns against this role. A claimant must declare every one of them. */
  task_types: readonly string[];
  absent: string;
}

export type WedgeRole = keyof typeof WEDGE_ROLES;

export const ALL_WEDGE_ROLES = Object.keys(WEDGE_ROLES) as WedgeRole[];

export const isWedgeRole = (s: string): s is WedgeRole => Object.hasOwn(WEDGE_ROLES, s);

/**
 * Every key a `wedge.json` may carry, mirroring `WedgeManifest`.
 *
 * ═══ WHY UNKNOWN KEYS ARE AN ERROR AND NOT A SHRUG ═══
 *
 * `loadWedge` does `JSON.parse` and casts. There is no schema, so a manifest that says `"provide":
 * ["dunning"]` or `"Provides"` parses fine, declares nothing, and the wedge quietly stops being the
 * dunning wedge — the sweep then finds zero claimants and correctly does nothing, while the founder
 * who just edited the file believes he wired it up. A role declaration that silently does not take
 * is worse than the hardcode it replaced, because the hardcode at least worked.
 *
 * So the check is on the KEY and not just the value: any top-level key that is not in this list is a
 * refusal naming the typo and the nearest legal key. This is also why the list has to be kept in
 * sync with the interface by hand — `contract-surface`-style tests do exactly that (see
 * `roles.test.ts`), so adding a field to `WedgeManifest` without adding it here fails a test rather
 * than rejecting every founder's manifest at boot.
 */
export const WEDGE_MANIFEST_KEYS: readonly string[] = [
  "wedge",
  "title",
  "internal",
  "provides",
  "tier",
  "harness",
  "workspace",
  "model",
  "task_types",
  "tools",
  "approvals",
  "connections",
  "capabilities",
  "cases",
  "workflows",
  "packs",
  "policy",
  "intake",
  "fulfillment",
  "skills",
  "knowledge",
  "domains",
];

/** A manifest problem, as a sentence a founder can act on. Never thrown one at a time — see below. */
export interface ManifestFault {
  wedge: string;
  message: string;
}

/**
 * Everything wrong with one manifest, as sentences.
 *
 * ALL of them, not the first: a founder who mistyped two things should be told twice rather than
 * made to re-run the kernel to discover the second. Pure — takes the parsed object, touches no disk
 * — so the malformed cases are unit-testable without writing files.
 */
export function manifestFaults(slug: string, raw: unknown): ManifestFault[] {
  const faults: ManifestFault[] = [];
  const fault = (message: string) => faults.push({ wedge: slug, message });
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fault(`${slug}/wedge.json is not a JSON object`);
    return faults;
  }
  const m = raw as Record<string, unknown>;

  for (const key of Object.keys(m)) {
    if (WEDGE_MANIFEST_KEYS.includes(key)) continue;
    // JSON has no comments, so three of the shipped manifests carry `_comment_internal` /
    // `_comment_skills` explaining a decision to the next person to open the file. That is a good
    // convention and the first draft of this check rejected all of it — which is the argument for
    // one explicit escape hatch rather than a lenient rule: `_comment_provides` is obviously prose,
    // `provide` is obviously a typo, and nothing in between is silently accepted.
    if (key.startsWith("_comment")) continue;
    const near = WEDGE_MANIFEST_KEYS.find((k) => looksLike(k, key));
    fault(
      `${slug}/wedge.json has an unknown field "${key}"` +
        (near ? ` — did you mean "${near}"?` : ` (known fields: ${WEDGE_MANIFEST_KEYS.join(", ")})`),
    );
  }

  const provides = m.provides;
  if (provides !== undefined) {
    if (!Array.isArray(provides) || provides.some((r) => typeof r !== "string")) {
      fault(`${slug}/wedge.json: "provides" must be an array of role names, e.g. ["dunning"]`);
    } else {
      const taskTypes = (m.task_types ?? {}) as Record<string, unknown>;
      for (const role of provides as string[]) {
        if (!isWedgeRole(role)) {
          const near = ALL_WEDGE_ROLES.find((r) => looksLike(r, role));
          fault(
            `${slug}/wedge.json declares an unknown role "${role}"` +
              (near ? ` — did you mean "${near}"?` : ` (known roles: ${ALL_WEDGE_ROLES.join(", ")})`),
          );
          continue;
        }
        // Declaring a role you cannot perform is the same failure as not declaring it, except it
        // reads as wired up. The kernel spawns these exact task types against the claimant; a run
        // for a task type with no manifest entry gets no output schema, no policy and no knowledge.
        const missing = WEDGE_ROLES[role].task_types.filter((t) => !Object.hasOwn(taskTypes, t));
        if (missing.length) {
          fault(
            `${slug}/wedge.json claims the "${role}" role but declares no task_types.${missing.join(", task_types.")} — ` +
              `the kernel spawns ${missing.length === 1 ? "that" : "those"} against whichever wedge holds the role`,
          );
        }
      }
    }
  }

  /**
   * `capabilities` gets the same treatment as `provides`, and for the same reason one step along.
   *
   * A wedge that declares `["read_payment"]` would otherwise resolve to no connections at grant
   * time, and `selectGrantableConnections` returning an empty list is indistinguishable from a
   * business that has connected nothing. The run then goes ahead with no hands, drafts something,
   * and reports success. That is this repo's most expensive bug shape, reached by a missing "s".
   */
  const capabilities = m.capabilities;
  if (capabilities !== undefined) {
    if (!Array.isArray(capabilities) || capabilities.some((x) => typeof x !== "string")) {
      fault(`${slug}/wedge.json: "capabilities" must be an array of capability names, e.g. ["read_payments"]`);
    } else {
      for (const cap of capabilities as string[]) {
        const problem = capabilityFault(cap);
        if (problem) fault(`${slug}/wedge.json declares a capability it cannot have: ${problem}`);
      }
    }
  }
  return faults;
}

/** Same letters, different spelling — enough to say "did you mean" without a Levenshtein table. */
function looksLike(known: string, given: string): boolean {
  const norm = (s: string) => [...s.toLowerCase().replace(/[^a-z]/g, "")].sort().join("");
  return known !== given && (norm(known) === norm(given) || known.toLowerCase() === given.toLowerCase());
}

export interface WedgeRoleIndex {
  /** Resolved singleton holders. A role absent from this map has no claimant on this install. */
  byRole: Map<WedgeRole, string>;
  /** Slugs scanned, in directory order. Exposed so `/v1/wedge-roles` can report what it looked at. */
  scanned: string[];
}

/**
 * Read every `wedge.json` under `dir` and resolve the role → wedge index, or throw.
 *
 * Pure-ish and exported so a test can point it at a fixture directory without touching the process
 * memo. `loadWedge` is the reader so that a manifest which fails to parse is one code path, not two.
 *
 * THROWS on: any manifest fault (unknown field, unknown role, role claimed without its task types)
 * and on two wedges claiming one singleton role. All faults are collected and reported together for
 * the same reason `manifestFaults` returns a list.
 */
export function buildWedgeRoleIndex(dir: string = wedgesDir()): WedgeRoleIndex {
  let scanned: string[] = [];
  try {
    scanned = readdirSync(dir).filter((d) => existsSync(join(dir, d, "wedge.json"))).sort();
  } catch {
    // No wedges directory at all is a real answer — a kernel with no wedges installed runs, serves
    // its API, and claims no roles. It is not a crash, and `create-mycel-app` boots through here.
    return { byRole: new Map(), scanned: [] };
  }

  const faults: ManifestFault[] = [];
  const claims = new Map<WedgeRole, string[]>();
  for (const slug of scanned) {
    const loaded = loadWedge(slug, dir);
    if (!loaded) {
      // `loadWedge` returns null for unparseable JSON. Silence here would mean a wedge that
      // vanishes from the catalogue with no explanation, which is the fail-while-reporting-success
      // shape this whole module is against.
      faults.push({ wedge: slug, message: `${slug}/wedge.json could not be parsed as JSON` });
      continue;
    }
    const own = manifestFaults(slug, loaded.manifest as unknown);
    if (own.length) {
      faults.push(...own);
      continue;
    }
    for (const role of loaded.manifest.provides ?? []) {
      if (!isWedgeRole(role)) continue; // already reported by `manifestFaults`
      claims.set(role, [...(claims.get(role) ?? []), slug]);
    }
  }

  const byRole = new Map<WedgeRole, string>();
  for (const [role, slugs] of claims) {
    if (slugs.length > 1) {
      faults.push({
        wedge: slugs.join(" + "),
        message:
          `the "${role}" role is claimed by ${slugs.length} wedges (${slugs.join(", ")}) and it holds exactly one. ` +
          `Remove "${role}" from provides[] in all but one wedge.json — the kernel will not pick for you, because ` +
          `picking would mean an invoice chased in the wrong wedge's voice with the wrong wedge's policy envelope.`,
      });
      continue;
    }
    byRole.set(role, slugs[0]);
  }

  if (faults.length) {
    throw new Error(
      `[mycel] ${faults.length} problem(s) in wedge manifests under ${dir}:\n` +
        faults.map((f) => `  · ${f.message}`).join("\n"),
    );
  }
  return { byRole, scanned };
}

/**
 * The process memo, and its staleness story.
 *
 * WHERE IT LIVES: nowhere durable. `wedgesDir()` is a directory baked into the container image (or a
 * checkout on a developer's laptop), so within one process the answer cannot change — the same
 * argument `wedgeCarriesNudge` in nudges.ts already makes for its own memo, and this deliberately
 * mirrors it rather than inventing a second caching style. A registry table would have to be
 * migrated and kept in sync with a filesystem that is the actual truth.
 *
 * WHEN IT IS BUILT: on first use, and at boot via `assertWedgeRolesValid` so a malformed manifest is
 * a startup failure rather than a surprise at 03:00 when the sweep fires.
 *
 * THE ERROR IS MEMOISED TOO, and that is the point rather than an accident. A build that throws must
 * throw for every subsequent caller; caching only the success would mean the first request 500s and
 * the second silently re-scans, so an operator watching a dashboard sees one blip instead of a hard,
 * repeatable configuration error.
 *
 * A deployment that edits `wedges/` under a running process gets the old answer until restart. That
 * is stated rather than solved: it is how skills, knowledge and blueprints already behave here, and
 * a role index that reloaded on a timer would change which wedge chases invoices halfway through a
 * sweep.
 */
let memo: { index: WedgeRoleIndex } | { error: Error } | null = null;

function index(): WedgeRoleIndex {
  if (memo === null) {
    try {
      memo = { index: buildWedgeRoleIndex() };
    } catch (e) {
      memo = { error: e instanceof Error ? e : new Error(String(e)) };
    }
  }
  if ("error" in memo) throw memo.error;
  return memo.index;
}

/** Test seam. A test that writes a manifest must be able to invalidate the memo. */
export function _resetWedgeRoleIndex(): void {
  memo = null;
}

/**
 * Which wedge holds this role on this install, or undefined if nothing claims it.
 *
 * Throws only on a CONFIGURATION ERROR (a malformed manifest, or two claimants) — never on "nobody
 * claims it", which is a legitimate install. Callers that can carry on without the role call this
 * and print `whyNoWedge(role)`; callers that are already inside the role's own machinery call
 * `requireWedgeForRole`.
 */
export function wedgeForRole(role: WedgeRole): string | undefined {
  return index().byRole.get(role);
}

/**
 * The same lookup, for code that is already inside the role's machinery.
 *
 * Throws rather than returning undefined, and the two live side by side on purpose: reaching
 * `advanceSequences` means an outreach Case exists, so a missing outreach wedge there is a broken
 * install and not an install without outbound. The distinction is entry point vs interior — a
 * boundary degrades and says why, an interior refuses loudly.
 */
export function requireWedgeForRole(role: WedgeRole): string {
  const w = wedgeForRole(role);
  if (!w) throw new Error(`[mycel] ${WEDGE_ROLES[role].absent}`);
  return w;
}

/** The founder-readable sentence for a role nothing claims. One wording, every surface. */
export function whyNoWedge(role: WedgeRole): string {
  return WEDGE_ROLES[role].absent;
}

/** Does this wedge hold this role? Used where code has a wedge in hand and asks about it. */
export function wedgeHasRole(wedge: string | undefined, role: WedgeRole): boolean {
  return !!wedge && wedgeForRole(role) === wedge;
}

/**
 * Boot gate. Called once from `createServer` so a bad manifest stops the kernel starting.
 *
 * Deliberately NOT swallowed. A kernel that boots with two wedges claiming `dunning` would run for
 * weeks and then chase somebody's client in the wrong voice; a kernel that refuses to boot gets
 * looked at in the first minute.
 */
export function assertWedgeRolesValid(): void {
  index();
}

/** Role → wedge, as a plain object. What `GET /v1/wedge-roles` serves; see that route for why. */
export function wedgeRoleMap(): Record<WedgeRole, string | null> {
  const idx = index();
  return Object.fromEntries(ALL_WEDGE_ROLES.map((r) => [r, idx.byRole.get(r) ?? null])) as Record<
    WedgeRole,
    string | null
  >;
}

/** Roles this manifest declares, narrowed to the known ones. For `/v1/wedges`. */
export function declaredRoles(manifest: WedgeManifest): WedgeRole[] {
  return (manifest.provides ?? []).filter(isWedgeRole);
}
