// WHERE A SERVICE THE KERNEL WROTE LIVES, AND WHO IS ALLOWED TO SEE IT.
//
// ═══ WHY NOT ON DISK ═══
//
// `loadWedge` reads `wedgesDir()`, a directory baked into the container image. That is exactly right
// for the seven services shipped with the kernel: they are the same for every business on the box,
// they are reviewed in a pull request, and `roles.ts` can memo the whole index for the life of the
// process because a file cannot change under a running server.
//
// None of that is true of a service written FOR ONE BUSINESS. It is tenant data. Writing it to
// `wedges/` would put one business's definition in a directory every other business's code path
// reads, on a box they share, with a memo that never expires — and the kernel runs more than one
// tenant per process. So it goes in a project-scoped table, next to that project's clients and
// invoices, and it is reached the way every other piece of tenant data is reached.
//
// ═══ THE TENANCY ARGUMENT, IN FULL ═══
//
// Two cross-tenant leaks have shipped in this repo and both were an identifier that was optional or
// defaulted. `loadWedge(slug)` takes no project id and has around fifty callers, so the tempting
// change — teach `loadWedge` to also look in the table, with an optional project — is precisely the
// shape of both of those bugs. It is not done. Instead there are two layers:
//
//   1. LEXICAL, and total. An authored slug carries `AUTHORED_SLUG_PREFIX` and `loadWedge` refuses
//      any slug carrying it (see wedge.ts). So every one of those fifty callers answers "unknown
//      service" for an authored slug — not "the wrong tenant's service", and not "sometimes". A
//      caller that has not been taught about project scoping cannot reach an authored service at
//      all, which is the fail-closed default this repo keeps having to relearn.
//   2. ARGUMENT, and required. `loadProjectWedge(projectId, slug)` takes the project first and
//      positionally, with no default and no overload that omits it, and throws on an empty string.
//      The store's reads take it too — `getAuthored(projectId, slug)`, not `getAuthored(slug)` —
//      so a row from another project reads as "not found" rather than as a row somebody must
//      remember to check.
//
// ═══ THE STATUS MACHINE ═══
//
// `drafted → promoted` or `drafted → rejected`, one way, and nothing runs until a human moves it.
// the self-improvement system (deleted in 59f1dd83 — 261 sandbox-hours, four proposals, nothing adopted)
// is the precedent: model output is a hypothesis until a person accepts it, and the
// reason is the same one — a system that promotes its own proposals teaches itself unsupported
// facts. Here the stake is higher than a knowledge file, because a promoted service is one a client
// eventually hears from.
import { randomUUID } from "node:crypto";
import { databaseUrl } from "./config";
import { isAuthoredSlug, loadWedge, withSpine, type LoadedWedge, type WedgeFile, type WedgeManifest } from "./wedge";
import { repairAuthoredManifest } from "./wedgeauthor";

export type AuthoredStatus = "drafted" | "promoted" | "rejected";

export interface AuthoredWedge {
  id: string;
  project_id: string;
  /** Carries `AUTHORED_SLUG_PREFIX`. Unique within a project; two projects may use the same one. */
  slug: string;
  title: string;
  manifest: WedgeManifest;
  skills: WedgeFile[];
  knowledge: WedgeFile[];
  status: AuthoredStatus;
  /** What the founder described, kept so a reviewer can check the draft against the ask. */
  described_as: string;
  /**
   * ═══ WHAT THE DRAFT ASKED FOR AND DID NOT GET ═══
   *
   * `repairAuthoredManifest` silently corrects things a written service may not have — a `policy`
   * it wrote for itself, an approval marked `required: false`, a claimed kernel role, its own
   * runnable code, a job that waits for a reply that could never restart it. Every repair is right.
   * All of them used to be invisible, and running the eval harness is what showed it.
   *
   * PERSISTED RATHER THAN RE-DERIVED, because it cannot be re-derived: the repaired manifest no
   * longer contains what was removed, so this is the only record that the thing writing this
   * founder's service tried to grant itself permission to send without asking. That is a fact about
   * the AUTHOR, it belongs on the review card, and it is gone the moment it is not written down.
   */
  notices?: string[];
  /** The task whose output this was parsed from. The audit trail back to a specific run. */
  source_task_id?: string;
  /** Who moved it out of `drafted`, and when. Absent while it is still a draft. */
  decided_by?: string;
  decided_at?: string;
  created_at: string;
  updated_at: string;
}

export type NewAuthoredWedge = Omit<AuthoredWedge, "id" | "status" | "decided_by" | "decided_at" | "created_at" | "updated_at">;

export interface AuthoredFilter {
  /** REQUIRED. See the tenancy note in the header — there is no listing without a project. */
  project_id: string;
  status?: AuthoredStatus;
  limit?: number;
}

export interface AuthoredStore {
  createDraft(row: NewAuthoredWedge): Promise<AuthoredWedge>;
  /** Scoped by construction: a slug from another tenant reads as "not found", never as a row. */
  getAuthored(projectId: string, slug: string): Promise<AuthoredWedge | undefined>;
  listAuthored(filter: AuthoredFilter): Promise<AuthoredWedge[]>;
  /**
   * Move a draft to `promoted` or `rejected`. Returns undefined when there is no such draft IN THIS
   * PROJECT, or when it has already been decided — the guard is in the write, not in a read before
   * it, so two founders clicking at once cannot both promote.
   */
  decide(projectId: string, slug: string, status: Exclude<AuthoredStatus, "drafted">, by: string): Promise<AuthoredWedge | undefined>;
  close?(): Promise<void>;
}

const now = () => new Date().toISOString();

export class InMemoryAuthoredStore implements AuthoredStore {
  /** Keyed by `project_id + "\u0000" + slug`, so a lookup cannot cross a project by accident. */
  private rows = new Map<string, AuthoredWedge>();

  private key(projectId: string, slug: string): string {
    return `${projectId}\u0000${slug}`;
  }

  async createDraft(row: NewAuthoredWedge): Promise<AuthoredWedge> {
    if (!row.project_id) throw new Error("a written service must belong to a project");
    if (!isAuthoredSlug(row.slug)) {
      // Storing one under a plain slug would leave a row that `loadWedge` might one day be taught to
      // read. The invariant is enforced at the door rather than trusted from the caller.
      throw new Error(`a written service must be filed under an authored slug, got "${row.slug}"`);
    }
    const existing = this.rows.get(this.key(row.project_id, row.slug));
    // Re-drafting is how a founder says "try again", and it must not silently overwrite a service
    // they have already agreed to run.
    if (existing && existing.status === "promoted") return existing;
    const saved: AuthoredWedge = { ...row, id: randomUUID(), status: "drafted", created_at: now(), updated_at: now() };
    this.rows.set(this.key(row.project_id, row.slug), saved);
    return saved;
  }

  async getAuthored(projectId: string, slug: string): Promise<AuthoredWedge | undefined> {
    if (!projectId) return undefined;
    return this.rows.get(this.key(projectId, slug));
  }

  async listAuthored(filter: AuthoredFilter): Promise<AuthoredWedge[]> {
    if (!filter.project_id) return [];
    return [...this.rows.values()]
      .filter((r) => r.project_id === filter.project_id && (!filter.status || r.status === filter.status))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, Math.min(Math.max(filter.limit ?? 50, 1), 500));
  }

  async decide(
    projectId: string,
    slug: string,
    status: Exclude<AuthoredStatus, "drafted">,
    by: string,
  ): Promise<AuthoredWedge | undefined> {
    const row = this.rows.get(this.key(projectId, slug));
    // NO `await` BETWEEN THE READ AND THE WRITE. That makes the transition indivisible on the event
    // loop, mirroring the `WHERE status='drafted'` guard the SQL uses. An await here would let the
    // whole suite pass while only Postgres held the line — the convention `requests.ts` documents.
    if (!row || row.status !== "drafted") return undefined;
    const next: AuthoredWedge = { ...row, status, decided_by: by, decided_at: now(), updated_at: now() };
    this.rows.set(this.key(projectId, slug), next);
    return next;
  }
}

// ═══════════════════════════ THE SINGLETON ═══════════════════════════

let cached: AuthoredStore | null = null;

export function getAuthoredStore(): AuthoredStore {
  if (!cached) cached = new InMemoryAuthoredStore();
  return cached;
}

export async function initAuthoredStore(): Promise<{ backend: string }> {
  const url = databaseUrl();
  if (url) {
    // No catch, deliberately, and for the reason `initRequestStore` gives: a database that is
    // configured and unreachable must stop the boot, not fall back to memory and lose every draft
    // the moment the process restarts.
    const { PostgresAuthoredStore } = await import("./authored.pg");
    cached = await PostgresAuthoredStore.connect(url);
    return { backend: "postgres" };
  }
  cached = new InMemoryAuthoredStore();
  return { backend: "memory" };
}

export async function closeAuthoredStore(): Promise<void> {
  await cached?.close?.();
}

/** Test seam. */
export function _resetAuthored(store?: AuthoredStore): void {
  cached = store ?? new InMemoryAuthoredStore();
}

// ═══════════════════════════ THE RESOLVER ═══════════════════════════

/**
 * The one way to reach a service — installed or written — WITH A TENANT IN HAND.
 *
 * This is the function that replaces `loadWedge` at every call site that knows whose work it is
 * running. It is async because the authored half is a database read; every site that needed
 * changing was already async.
 *
 * ═══ THE THREE ANSWERS, AND WHY EACH IS null RATHER THAN A THROW ═══
 *
 *   · A plain slug falls through to `loadWedge`, unchanged. Installed services are the same for
 *     every tenant — that is what makes them installed — and whether a project may USE one is a
 *     different question already answered by `projectAllowsWedge`. Folding the two together here
 *     would give one function two reasons to say no and callers no way to tell them apart.
 *   · An authored slug belonging to ANOTHER project reads as null. Not an error: from this project's
 *     point of view there is genuinely no such service, and saying "that exists but is not yours"
 *     would confirm the existence of another tenant's service to anyone who can guess a name.
 *   · An authored slug that is still `drafted` or has been `rejected` reads as null. This is the
 *     promotion gate, and it is HERE rather than at the routes on purpose: a gate at the route is a
 *     gate somebody forgets on the second route. Nothing can run an unpromoted draft because
 *     nothing can load one.
 *
 * Throws on a missing project id, because that is a programming error rather than a state — the
 * caller has lost track of whose work it is, and continuing would be a guess.
 */
export async function loadProjectWedge(projectId: string, slug: string): Promise<LoadedWedge | null> {
  if (!isAuthoredSlug(slug)) return loadWedge(slug);
  if (!projectId) throw new Error("loading a written service must be scoped to a project");
  const row = await getAuthoredStore().getAuthored(projectId, slug);
  if (!row || row.status !== "promoted") return null;
  return toLoaded(row);
}

/**
 * A stored row as the thing every consumer of `loadWedge` already understands.
 *
 * `dir` is empty and that is safe rather than lucky: nothing reads `LoadedWedge.dir` (the `ws.dir`
 * references in runtime.ts are workspace directories, a different field), and the one place that
 * builds a path from a slug — `runWorkflow` in workflows.ts — is unreachable for an authored service
 * because `authoredFaults` refuses a manifest that declares `workflows` at all. If that refusal is
 * ever lifted, this is the line that has to grow a real answer with it.
 */
export function toLoaded(row: AuthoredWedge): LoadedWedge {
  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════════════
   * THE SERVICE WE WROTE FOR THIS FOUNDER GETS THE SAME SPINE AS ONE WE SHIPPED
   * ═══════════════════════════════════════════════════════════════════════════════════════════════
   *
   * This returned `row.manifest` verbatim, and `loadWedge` — the other loader, the one for the ten
   * catalogue trades — is where the spine was merged in. So a WRITTEN service, which exists
   * precisely because the catalogue did not cover what this founder sells, was the only kind of
   * service in the product that could not chase a client for a missing document, could not check in
   * on a quiet engagement, and could not take a verdict on its own deliverable.
   *
   * Measured: three services written in production, one promoted and live. None had any of those
   * three jobs, and none had a `fulfillment` block either — so `draft_service` was producing
   * something that could think and could not trade.
   *
   * `repairAuthoredManifest` is the same derivation the authoring path runs, applied here as well
   * because the three rows already in the database were stored before it existed and would
   * otherwise stay broken for ever. It is idempotent: a manifest that already has a `fulfillment`
   * block is left exactly as it is.
   *
   * ORDER MATTERS. Repair first, spine second — `withSpine` keys off
   * `fulfillment.deliverable_shapes`, so running it before the repair would find nothing to merge
   * into and silently do nothing, which is the bug this line exists to fix.
   *
   * The row is not mutated: `repairAuthoredManifest` writes in place, so it gets a shallow copy.
   * Repairing the cached row would mean the database and memory disagree about what was authored.
   */
  const manifest = { ...row.manifest } as Record<string, unknown>;
  repairAuthoredManifest(manifest);
  // `exemplars: []` — an authored service ships no reference exemplar: the founder described this
  // trade to us, so there is no craft library behind it to draw a standard from. Their own upload
  // still mounts through the ordinary path.
  return {
    manifest: withSpine(manifest as unknown as WedgeManifest),
    dir: "",
    skills: row.skills,
    knowledge: row.knowledge,
    exemplars: [],
  };
}

/**
 * Which written services this project may run, as slugs. For the catalogue surfaces.
 *
 * Separate from `loadProjectWedge` because the surfaces that ask this — the services list, the
 * knowledge tabs — want the whole set and would otherwise do N round trips to find it.
 */
export async function promotedSlugs(projectId: string): Promise<string[]> {
  if (!projectId) return [];
  const rows = await getAuthoredStore().listAuthored({ project_id: projectId, status: "promoted" });
  return rows.map((r) => r.slug);
}
