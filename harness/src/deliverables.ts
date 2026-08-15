// THE FULFILMENT LOOP — the work goes out, the client answers, the work goes out again.
//
// ═══ THE FAILURE THIS EXISTS FOR ═══
//
// Every part of a service business was in this kernel except the part the business is actually paid
// for. A client could ask (`Thread`, `Message`), the kernel could work (`Task`, `Artifact`), the
// founder could gate (`Approval`), the client could be chased (`ClientRequest`, `nudges.ts`) and
// the money could be tracked (`Invoice`). What did not exist was the thing in the middle that all
// of those are about: an offer of finished work, and a client's verdict on it.
//
// So the loop terminated in an artifact. `runTask` wrote `statement-of-work.pdf`, the run went
// green, and there it stopped — a file keyed to a task id, with no counterparty, no version after
// it, no record of whether anyone had ever looked at it, and nothing that could tell a founder the
// difference between work that had been accepted and work that had been sent into silence three
// weeks ago. The two failures that produced, both of them expensive and both of them quiet:
//
//   1. WORK DONE AND NEVER BILLED. A deliverable a client accepted verbally is indistinguishable,
//      to every query in this codebase, from one they never opened. There was no `accepted_at` to
//      join an invoice to, so `moves.ts` — the surface whose whole job is "what is worth doing
//      next" — could not name the highest-value move a small business ever has, which is invoicing
//      for something it has already finished.
//
//   2. REVISION AS OVERWRITE. The one thing a client reliably does is ask for changes. With the
//      output modelled as a file, round two overwrote round one, the ask that caused it lived in a
//      thread message forty lines up, and "what did you change?" — the single question a client
//      asks on receiving a revision — could not be answered by anything except a human's memory.
//
// ═══ THE STATE MACHINE ═══
//
// One machine, on the deliverable. Versions carry facts; the deliverable carries state. Two status
// columns would be two things to write and one day they disagree, and the shape of that
// disagreement is a version marked live that the portal filters out — work the client cannot see
// and the founder believes was delivered.
//
//     drafting ──submit──▶ in_review ──release──▶ with_client ──accept──▶ accepted ▪
//        ▲                     │                       │
//        └──── reject ─────────┘                       └──request_changes──▶ changes_requested
//        ▲                                                                        │
//        └────────────────────────── submit (v+1) ─────────────────────────────────┘
//
//   · Anything not terminal can be withdrawn. `accepted` and `withdrawn` are terminal.
//   · The founder owns exactly one edge: `in_review → with_client`. The CLIENT owns the two that
//     leave `with_client`. Nothing in the business can move a deliverable to `accepted` — see below.
//   · `drafting` and `changes_requested` are both "no version is out there" and are deliberately
//     distinct: `changes_requested` means a client is owed something, which is a different sentence
//     on a founder's screen and a different urgency in `moves.ts`.
//
// ═══ THE FOUNDER'S GATE IS STRUCTURAL, NOT PROCEDURAL ═══
//
// "The client must not see it before the founder approves" is enforced in TWO places and the
// important one is not the approval:
//
//   1. STRUCTURAL. `released_at` is the portal's read filter. `visibleVersions` drops every version
//      without it, and it is the only function any portal route uses to decide what a client may
//      see or download. A version that was never released is not "hidden from the list", it is
//      unreachable by id, unreadable, and its artifacts 404 — because a filter applied at the list
//      route and forgotten at the by-id route is precisely how this repo has leaked twice.
//
//   2. PROCEDURAL. `releaseVersion` is reachable only from the founder plane, and submitting a
//      version raises an `Approval` with `requireHuman: true`. `requireHuman` is not decoration: it
//      is what stops a wedge's `policy.auto_approve` envelope from ever auto-approving a release.
//      A trade could otherwise ship a manifest that quietly hands unreviewed work to clients, which
//      is the one autonomy no founder asked for.
//
// A procedural gate alone is a promise about call order. A structural one is a property of the
// data, and it survives the next route somebody adds in a hurry.
//
// ═══ TRADE-AGNOSTIC, AND WHERE THAT IS ENFORCED ═══
//
// Nothing here names a trade, a wedge directory or a template, and there is no switch statement
// over any of those. A contract, a month-end close, a set of renders and a reconciliation report
// differ in what bytes they are and not at all in what happens to them. `DeliverableKind` is the
// only branch in the whole loop and it branches on SHAPE — is this a file, several files, or a
// place — which is a rendering question. The payload itself is `Artifact` ids, the content
// primitive that already exists, already has three backends and already streams with the right
// download headers.
//
// The one place a trade DOES get a say is revision, because writing version two is real work in a
// real voice. That wedge is resolved the way `nudges.ts` resolves a chasing voice — from the
// engagement's own `Case.wedge`, then checked against what that wedge declares it can do — and
// never from a directory name in this file. See `reviseTaskFor`.
import { randomUUID } from "node:crypto";
import { databaseUrl } from "./config";
import type { Deliverable, DeliverableKind, DeliverableStatus, DeliverableVersion } from "./contract";

// ── the vocabulary ───────────────────────────────────────────────────────────────────────────────

/**
 * WHAT SHAPE THE WORK IS. Closed, and three entries long on purpose.
 *
 * Closed for the reason `WEDGE_ROLES` and `CAPABILITIES` are closed: an open string would let a
 * caller write `kind: "docuemnt"` and be silently rendered as nothing at all, which is strictly
 * worse than a refusal because the deliverable still exists, still shows in the founder's list, and
 * still reads as delivered.
 *
 * Three entries because these are the only distinctions the portal has to MAKE. It is tempting to
 * add `report`, `design`, `website`, `contract` — and every one of those is a trade wearing a
 * costume. A contract and a month-end close are both one file you open; a set of renders and a
 * folder of reconciled statements are both several; a deployed site and a shared dashboard are both
 * somewhere you go. The test for adding a fourth is not "is there a new sort of work" — there
 * always is — it is "does the client have to DO something different with it".
 */
export const DELIVERABLE_KINDS = {
  document: {
    title: "A document",
    /** What the client is offered. One artifact, downloaded. */
    payload: "artifact",
    hint: "one file the client opens — a contract, a report, a set of accounts",
  },
  file_set: {
    title: "A set of files",
    payload: "artifacts",
    hint: "several files delivered together — renders, statements, exports",
  },
  link: {
    title: "Somewhere to go",
    payload: "url",
    hint: "a place rather than a file — a published site, a shared dashboard",
  },
} as const satisfies Record<DeliverableKind, DeliverableKindSpec>;

interface DeliverableKindSpec {
  title: string;
  /**
   * WHAT MUST BE PRESENT on a version of this kind. Validated at submit, so a `link` deliverable
   * with no URL is refused at the moment it is created rather than discovered by a client clicking
   * a card that does nothing. An empty deliverable that reports success is this repo's named bug.
   */
  payload: "artifact" | "artifacts" | "url";
  hint: string;
}

export type { DeliverableKind, DeliverableStatus };
export const ALL_DELIVERABLE_KINDS = Object.keys(DELIVERABLE_KINDS) as DeliverableKind[];
export const isDeliverableKind = (s: unknown): s is DeliverableKind =>
  typeof s === "string" && Object.hasOwn(DELIVERABLE_KINDS, s);

/**
 * The state of an offer of work. Closed, with the sentence each state means to each side.
 *
 * TWO SENTENCES PER STATE, not one, and that is the whole reason this is a table rather than a
 * union. `in_review` means "waiting for you" to a founder and means NOTHING AT ALL to a client —
 * they must not learn that a version exists before it is released, because "your architect has
 * something they are not showing you" is worse than silence. `client_sees: null` is that fact
 * written down once, next to the state, instead of being an `if` in each of the four surfaces that
 * render a deliverable and drifting the first time one of them is edited.
 */
export const DELIVERABLE_STATES = {
  drafting: {
    founder_sees: "being worked on — nothing has been offered yet",
    client_sees: null,
    terminal: false,
  },
  in_review: {
    founder_sees: "waiting for you to approve it — your client cannot see it yet",
    client_sees: null,
    terminal: false,
  },
  with_client: {
    founder_sees: "sent — waiting on your client to accept it or ask for changes",
    client_sees: "Ready for you to review",
    terminal: false,
  },
  changes_requested: {
    founder_sees: "your client asked for changes",
    client_sees: "You asked for changes — being worked on",
    terminal: false,
  },
  accepted: {
    founder_sees: "accepted by your client — this can be invoiced",
    client_sees: "Accepted",
    terminal: true,
  },
  withdrawn: {
    founder_sees: "withdrawn before it was accepted",
    client_sees: "Withdrawn",
    terminal: true,
  },
} as const satisfies Record<DeliverableStatus, DeliverableStateSpec>;

interface DeliverableStateSpec {
  founder_sees: string;
  /** `null` means THE CLIENT IS NEVER TOLD THIS STATE EXISTS. See the note above; it is load-bearing. */
  client_sees: string | null;
  terminal: boolean;
}

export const ALL_DELIVERABLE_STATUSES = Object.keys(DELIVERABLE_STATES) as DeliverableStatus[];
export const isDeliverableStatus = (s: unknown): s is DeliverableStatus =>
  typeof s === "string" && Object.hasOwn(DELIVERABLE_STATES, s);

/**
 * Every legal move, in one table. Modelled on `INVOICE_TRANSITIONS` deliberately — a second,
 * differently-shaped state machine in the same codebase is a second set of rules to get wrong.
 *
 * The table is also the AUTHORITY model, and this is the part worth reading twice. `accepted` is
 * reachable from exactly one state by exactly one actor, and no founder-plane route calls the
 * transition that produces it. The business genuinely cannot mark its own work accepted — not
 * "should not", cannot, because the only caller of `acceptDeliverable` is a portal route behind a
 * `ClientScope`. That is what makes `accepted_at` worth joining an invoice to.
 */
export const DELIVERABLE_TRANSITIONS: Record<DeliverableStatus, readonly DeliverableStatus[]> = {
  drafting: ["in_review", "withdrawn"],
  in_review: ["with_client", "drafting", "withdrawn"],
  with_client: ["accepted", "changes_requested", "withdrawn"],
  changes_requested: ["in_review", "drafting", "withdrawn"],
  accepted: [],
  withdrawn: [],
};

export const canTransition = (from: DeliverableStatus, to: DeliverableStatus): boolean =>
  (DELIVERABLE_TRANSITIONS[from] ?? []).includes(to);

/**
 * Same letters, different spelling. A third copy of `looksLike` — see the note in capabilities.ts
 * that argues for the duplication: each copy answers for its own vocabulary and a shared one would
 * be a utility module three unrelated files import for four lines.
 */
function looksLike(known: string, given: string): boolean {
  const norm = (s: string) => [...s.toLowerCase().replace(/[^a-z]/g, "")].sort().join("");
  return known !== given && (norm(known) === norm(given) || known.toLowerCase() === given.toLowerCase());
}

/** A sentence naming the typo, or undefined. Returns rather than throws, so a route can 400 with it. */
export function deliverableKindFault(given: unknown): string | undefined {
  if (isDeliverableKind(given)) return undefined;
  const s = typeof given === "string" ? given : "";
  const near = ALL_DELIVERABLE_KINDS.find((k) => looksLike(k, s));
  return (
    `"${s}" is not a kind of deliverable this kernel knows` +
    (near ? ` — did you mean "${near}"?` : ` (known kinds: ${ALL_DELIVERABLE_KINDS.join(", ")})`)
  );
}

/**
 * Does this version carry what its kind promised? Returns a sentence, or undefined when it is fine.
 *
 * THE BUG THIS PREVENTS is the one named at the top of every file in this repo: something failing
 * while reporting success. A `link` deliverable released with no URL is a card in a client's portal
 * with a button that goes nowhere, and every surface upstream of it — the run, the approval, the
 * founder's list — says the work was delivered.
 */
export function payloadFault(kind: DeliverableKind, v: { artifact_ids?: string[]; url?: string }): string | undefined {
  const artifacts = v.artifact_ids ?? [];
  const url = (v.url ?? "").trim();
  switch (DELIVERABLE_KINDS[kind].payload) {
    case "artifact":
      if (artifacts.length !== 1) {
        return `a "${kind}" deliverable is exactly one file, and this version has ${artifacts.length} — use "file_set" for several`;
      }
      return undefined;
    case "artifacts":
      return artifacts.length ? undefined : `a "${kind}" deliverable needs at least one file`;
    case "url":
      if (!url) return `a "${kind}" deliverable needs a url — that is the whole payload`;
      return /^https:\/\/\S+$/.test(url) ? undefined : `a "${kind}" deliverable's url must be https`;
  }
}

// ── the store ────────────────────────────────────────────────────────────────────────────────────

export interface DeliverableFilter {
  /**
   * TENANT SCOPE, REQUIRED, failing closed — the same contract as `InvoiceFilter.project_id` and
   * `CaseFilter.project_id`, and required for the same reason: "the caller will remember" is the
   * assumption behind both cross-tenant leaks this repo has shipped. A client fetching a deliverable
   * belonging to another project is the exact shape, and it is foreclosed by every read below taking
   * the project as a positional argument rather than an optional field.
   */
  project_id: string;
  client_id?: string;
  case_id?: string;
  status?: DeliverableStatus;
  /** `true` selects the states that are neither `accepted` nor `withdrawn`. */
  open?: boolean;
  limit?: number;
}

export type NewDeliverable = Omit<
  Deliverable,
  "id" | "created_at" | "updated_at" | "status" | "current_version" | "accepted_at" | "withdrawn_reason"
>;

/** What a caller supplies for a version. `version`, `id` and the timestamps are the store's. */
export type NewVersion = Omit<
  DeliverableVersion,
  | "id"
  | "project_id"
  | "deliverable_id"
  | "version"
  | "created_at"
  | "released_at"
  | "change_request"
  | "change_requested_at"
  | "accepted_at"
  | "accepted_note"
  | "superseded_at"
>;

export interface DeliverableStore {
  createDeliverable(d: NewDeliverable): Promise<Deliverable>;
  /**
   * By id AND project. The project is a positional argument, not an optional filter, so that "wrong
   * tenant" and "does not exist" are the same answer at every call site and no caller can forget to
   * ask the question. `getWait` and `getRequest` take the tenant for the same reason.
   */
  getDeliverable(projectId: string, id: string): Promise<Deliverable | undefined>;
  listDeliverables(f: DeliverableFilter): Promise<Deliverable[]>;
  /** Newest last. Always the full history — the point of the row is that nothing is dropped. */
  listVersions(projectId: string, deliverableId: string): Promise<DeliverableVersion[]>;
  getVersion(projectId: string, deliverableId: string, version: number): Promise<DeliverableVersion | undefined>;

  /**
   * Add version N+1 and move the deliverable to `in_review`, ATOMICALLY.
   *
   * THE GUARANTEE, and why this is one store method rather than three service-layer calls: version
   * numbers are contiguous and no two versions ever share one. Allocating the number with a read
   * (`max(version) + 1`) and then inserting leaves a window that two runs revising the same
   * deliverable — which is exactly what a retried task does — both fit through. Both then write
   * version 3, the unique index catches one of them if you remembered to add it, and if you did not
   * the client's portal shows two cards both labelled "Version 3" with different files in them.
   *
   * So the allocation, the insert, the supersede of the previous version and the status move are one
   * statement on Postgres and one un-awaited block in memory. `allowedFrom` goes into the WHERE
   * clause exactly as `transitionInvoice`'s does: submitting against an already-accepted deliverable
   * returns undefined rather than reopening it.
   */
  submitVersion(args: {
    project_id: string;
    deliverable_id: string;
    allowedFrom: readonly DeliverableStatus[];
    version: NewVersion;
    at: string;
  }): Promise<{ deliverable: Deliverable; version: DeliverableVersion } | undefined>;

  /**
   * Move status, atomically, with `allowedFrom` in the WHERE clause. Returns undefined for an
   * illegal transition, a lost race, or a row in another project — the caller re-reads to say which.
   *
   * `stamps` covers the three fields that only ever move with a status: acceptance, withdrawal, and
   * the pointer to which version the verdict was about.
   */
  transitionDeliverable(
    projectId: string,
    id: string,
    to: DeliverableStatus,
    allowedFrom: readonly DeliverableStatus[],
    at: string,
    stamps?: { accepted_at?: string; withdrawn_reason?: string },
  ): Promise<Deliverable | undefined>;

  /**
   * Stamp `released_at` on one version — the founder's gate, written down.
   *
   * Guarded on `released_at IS NULL` so a second approval of the same version is a no-op rather than
   * a re-release that moves the timestamp. The date a client was first shown something is evidence.
   */
  releaseVersion(projectId: string, deliverableId: string, version: number, at: string): Promise<DeliverableVersion | undefined>;

  /**
   * Write the client's verdict onto the version they were looking at.
   *
   * Guarded on the version being RELEASED and not already settled, so a client cannot leave a verdict
   * on a draft they should never have seen, and a double-submitted form does not overwrite the first
   * answer with the second. Both halves matter: the second is how "I accept" becomes "please change
   * the logo" when someone double-clicks.
   */
  settleVersion(args: {
    project_id: string;
    deliverable_id: string;
    version: number;
    at: string;
    verdict: { kind: "accepted"; note?: string } | { kind: "changes_requested"; request: string };
  }): Promise<DeliverableVersion | undefined>;

  close?(): Promise<void>;
}

const nowIso = () => new Date().toISOString();

/** The states that are not terminal — the `open: true` filter, derived from the table, never listed twice. */
export const OPEN_DELIVERABLE_STATUSES = ALL_DELIVERABLE_STATUSES.filter((s) => !DELIVERABLE_STATES[s].terminal);

export class InMemoryDeliverableStore implements DeliverableStore {
  private rows = new Map<string, Deliverable>();
  /** Keyed by deliverable id. Append-only, in version order — the same invariant Postgres enforces. */
  private versions = new Map<string, DeliverableVersion[]>();

  async createDeliverable(d: NewDeliverable): Promise<Deliverable> {
    if (!d.project_id) throw new Error("a deliverable must be scoped to a project");
    if (!d.case_id) throw new Error("a deliverable must belong to a case");
    if (!d.client_id) throw new Error("a deliverable must be for a client");
    const row: Deliverable = {
      ...d,
      id: randomUUID(),
      status: "drafting",
      // 0, not 1: there is no version yet. A deliverable that claimed `current_version: 1` before
      // anything had been submitted would make every "fetch the current version" read return
      // undefined and be indistinguishable from a store failure.
      current_version: 0,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    this.rows.set(row.id, row);
    this.versions.set(row.id, []);
    return row;
  }

  async getDeliverable(projectId: string, id: string): Promise<Deliverable | undefined> {
    const d = this.rows.get(id);
    return d && d.project_id === projectId ? d : undefined;
  }

  async listDeliverables(f: DeliverableFilter): Promise<Deliverable[]> {
    if (!f.project_id) throw new Error("listDeliverables requires a project_id");
    const out = [...this.rows.values()]
      .filter((d) => d.project_id === f.project_id)
      .filter((d) => (f.client_id ? d.client_id === f.client_id : true))
      .filter((d) => (f.case_id ? d.case_id === f.case_id : true))
      .filter((d) => (f.status ? d.status === f.status : true))
      .filter((d) => (f.open ? !DELIVERABLE_STATES[d.status].terminal : true))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id));
    return f.limit ? out.slice(0, f.limit) : out;
  }

  async listVersions(projectId: string, deliverableId: string): Promise<DeliverableVersion[]> {
    const d = await this.getDeliverable(projectId, deliverableId);
    if (!d) return [];
    return [...(this.versions.get(deliverableId) ?? [])].sort((a, b) => a.version - b.version);
  }

  async getVersion(projectId: string, deliverableId: string, version: number): Promise<DeliverableVersion | undefined> {
    return (await this.listVersions(projectId, deliverableId)).find((v) => v.version === version);
  }

  async submitVersion(args: {
    project_id: string;
    deliverable_id: string;
    allowedFrom: readonly DeliverableStatus[];
    version: NewVersion;
    at: string;
  }): Promise<{ deliverable: Deliverable; version: DeliverableVersion } | undefined> {
    const d = this.rows.get(args.deliverable_id);
    // No `await` from here to the end: indivisible on a single-threaded event loop, which is the
    // memory store's equivalent of the CTE. Same reasoning as `claimInvoiceForChase`.
    if (!d || d.project_id !== args.project_id) return undefined;
    if (!args.allowedFrom.includes(d.status)) return undefined;
    const list = this.versions.get(d.id) ?? [];
    const previous = list.find((v) => v.version === d.current_version);
    if (previous && !previous.superseded_at) previous.superseded_at = args.at;
    const version: DeliverableVersion = {
      ...args.version,
      id: randomUUID(),
      project_id: d.project_id,
      deliverable_id: d.id,
      version: d.current_version + 1,
      created_at: args.at,
    };
    list.push(version);
    this.versions.set(d.id, list);
    d.current_version = version.version;
    d.status = "in_review";
    d.updated_at = args.at;
    return { deliverable: d, version };
  }

  async transitionDeliverable(
    projectId: string,
    id: string,
    to: DeliverableStatus,
    allowedFrom: readonly DeliverableStatus[],
    at: string,
    stamps?: { accepted_at?: string; withdrawn_reason?: string },
  ): Promise<Deliverable | undefined> {
    const d = this.rows.get(id);
    if (!d || d.project_id !== projectId) return undefined;
    if (!allowedFrom.includes(d.status)) return undefined;
    d.status = to;
    // `accepted_at` is written once and never cleared — see the field's comment. `??=` rather than
    // `=` so that a withdrawal after acceptance (which the transition table forbids anyway) could
    // not erase the fact an invoice may already have been raised against.
    if (stamps?.accepted_at) d.accepted_at ??= stamps.accepted_at;
    if (stamps?.withdrawn_reason) d.withdrawn_reason = stamps.withdrawn_reason;
    d.updated_at = at;
    return d;
  }

  async releaseVersion(projectId: string, deliverableId: string, version: number, at: string): Promise<DeliverableVersion | undefined> {
    const v = await this.getVersion(projectId, deliverableId, version);
    if (!v || v.released_at) return undefined;
    v.released_at = at;
    return v;
  }

  async settleVersion(args: {
    project_id: string;
    deliverable_id: string;
    version: number;
    at: string;
    verdict: { kind: "accepted"; note?: string } | { kind: "changes_requested"; request: string };
  }): Promise<DeliverableVersion | undefined> {
    const v = await this.getVersion(args.project_id, args.deliverable_id, args.version);
    if (!v || !v.released_at) return undefined;
    if (v.accepted_at || v.change_requested_at) return undefined;
    if (args.verdict.kind === "accepted") {
      v.accepted_at = args.at;
      v.accepted_note = args.verdict.note;
    } else {
      v.change_request = args.verdict.request;
      v.change_requested_at = args.at;
    }
    return v;
  }
}

// Process-wide singleton, the same shape as the domain, portal and billing stores: a synchronous
// accessor for the hot paths and one awaited init at boot that swaps in the durable backend.
let cached: DeliverableStore | null = null;

export function getDeliverableStore(): DeliverableStore {
  if (!cached) cached = new InMemoryDeliverableStore();
  return cached;
}

export async function initDeliverableStore(): Promise<{ backend: string }> {
  const url = databaseUrl();
  // No `catch`, and no fallback when a database IS configured — the identical argument
  // `initBillingStore` makes. A process that accepts deliverables, answers reads correctly for its
  // own lifetime and loses them on the next deploy is worse than one that refuses to boot: the loss
  // here is a client's accepted work, which is the evidence an invoice rests on.
  if (url) {
    const { PostgresDeliverableStore } = await import("./deliverables.pg");
    cached = await PostgresDeliverableStore.connect(url);
    return { backend: "postgres" };
  }
  cached = new InMemoryDeliverableStore();
  return { backend: "memory" };
}

export async function closeDeliverableStore(): Promise<void> {
  await cached?.close?.();
}

/** Test seam — the singleton is process-local, exactly like the billing store's. */
export function _resetDeliverables(): void {
  cached = new InMemoryDeliverableStore();
}

// ── what crosses to the client ───────────────────────────────────────────────────────────────────

/**
 * THE ONLY FUNCTION ANY PORTAL SURFACE MAY USE TO DECIDE WHAT A CLIENT SEES.
 *
 * One implementation, deliberately, and every portal route goes through it — the list, the detail,
 * the download, and the two action routes. The failure it forecloses is the specific one this repo
 * has shipped: a filter applied where the rows are listed and forgotten where a single row is
 * fetched by id, so the client who guesses a URL gets what the list was careful to hide.
 */
export const visibleVersions = (versions: DeliverableVersion[]): DeliverableVersion[] =>
  versions.filter((v) => !!v.released_at);

/**
 * The client's view of a deliverable. A projection, not the row.
 *
 * DROPPED ON PURPOSE, each for its own reason: `project_id` and `case_id` (internal identifiers a
 * client has no use for and every use for not seeing), `task_id` on each version (the client did not
 * hire a task runner), and — the one worth stating — the status is REPLACED by
 * `DELIVERABLE_STATES[...].client_sees` rather than passed through. A raw `in_review` crossing to a
 * portal would tell a client that finished work is being withheld from them.
 */
export function toPortalDeliverable(d: Deliverable, versions: DeliverableVersion[]) {
  const shown = visibleVersions(versions);
  const label = DELIVERABLE_STATES[d.status].client_sees;
  const current = shown[shown.length - 1];
  return {
    id: d.id,
    title: d.title,
    kind: d.kind,
    /**
     * Never the raw status. `in_review` and `drafting` have no client sentence at all, and the
     * honest thing to say about a deliverable whose only version is unreleased is that we are
     * working on it — which is true, and is what `drafting` means to a client.
     */
    state: label ?? "Being worked on",
    /** Whether the two client verbs are live right now. The portal renders buttons off this, not off state strings. */
    can_act: d.status === "with_client" && !!current,
    accepted_at: d.accepted_at,
    updated_at: d.updated_at,
    quality: qualitySignals(d, versions),
    versions: shown.map(toPortalVersion),
  };
}

/** One version, as a client sees it. `task_id` is the field this exists to drop. */
export function toPortalVersion(v: DeliverableVersion) {
  return {
    version: v.version,
    summary: v.summary,
    artifact_ids: v.artifact_ids,
    url: v.url,
    released_at: v.released_at,
    /** Their own words, handed back. "You asked: make the logo bigger" is what makes a revision legible. */
    change_request: v.change_request,
    change_requested_at: v.change_requested_at,
    accepted_at: v.accepted_at,
    accepted_note: v.accepted_note,
    superseded_at: v.superseded_at,
  };
}

/**
 * Soft cap on how many versions a piece of work should go through before a founder steps in.
 *
 * Not a hard stop — a client who is still unhappy on round five still gets to say so, and the
 * loop still records it. The number is what makes "this is revision 3" a bounded sentence rather
 * than an unbounded counter a founder has to notice themselves.
 */
export const MAX_DELIVERABLE_REVISIONS = 5;

/** "First version" / "Revision 3" — the sentence a founder reads, never "v3". */
export function revisionLabel(version: number): string {
  if (!Number.isFinite(version) || version <= 1) return "First version";
  return `Revision ${version}`;
}

/** One pin on a file, folded into the change-request brief the next run reads. */
export type ChangeComment = {
  artifact_id?: string;
  file?: string;
  note: string;
};

/**
 * The brief a revision run actually receives.
 *
 * File-scoped notes go first, then the overall ask, so an agent that only reads the first
 * paragraph still sees what was wrong with the artefact they are looking at. Empty notes are
 * dropped; the overall request can stand alone.
 */
export function formatChangeBrief(request: string, comments?: ChangeComment[]): string {
  const body = request.trim();
  const lines: string[] = [];
  for (const c of (comments ?? []).slice(0, 20)) {
    const note = String(c.note ?? "").trim().slice(0, 1000);
    if (!note) continue;
    const where = String(c.file ?? "").trim().slice(0, 200) || String(c.artifact_id ?? "").trim().slice(0, 80);
    lines.push(where ? `On ${where}: ${note}` : note);
  }
  if (!lines.length) return body;
  if (!body) return lines.join("\n");
  return `${lines.join("\n")}\n\n${body}`;
}

export function qualitySignals(d: Deliverable, versions: DeliverableVersion[]) {
  const firstReleased = versions
    .map((v) => v.released_at)
    .filter((x): x is string => !!x)
    .sort()[0];
  const changeRequests = versions.filter((v) => !!v.change_requested_at).length;
  const hoursBetween = (a?: string, b?: string): number | null => {
    if (!a || !b) return null;
    const ms = Date.parse(b) - Date.parse(a);
    if (!Number.isFinite(ms) || ms < 0) return null;
    return Math.round((ms / 3_600_000) * 10) / 10;
  };
  return {
    revision_count: d.current_version,
    revision_cap: MAX_DELIVERABLE_REVISIONS,
    change_request_count: changeRequests,
    hours_to_first_release: hoursBetween(d.created_at, firstReleased),
    hours_to_accept: hoursBetween(d.created_at, d.accepted_at),
  };
}

/**
 * May this client download this artifact, on account of a deliverable?
 *
 * ═══ WHY THE CHECK IS NOT "DOES THE ARTIFACT'S TASK BELONG TO THIS CLIENT" ═══
 *
 * That is how `GET /v1/portal/artifacts/:id` authorises, and it is right there and wrong here. An
 * artifact produced by an internal run — a draft the founder rejected, a working file, a version
 * that was never released — belongs to a task in the client's project and may well carry their
 * `client_id`, and would therefore pass that check while being something they must never see.
 *
 * So the grant runs the other way: an artifact is downloadable ONLY because a RELEASED version of a
 * deliverable owned by this client lists it. The deliverable is the authority, the release is the
 * gate, and an artifact nobody has released is unreachable no matter which task produced it.
 */
export function artifactReleasedTo(versions: DeliverableVersion[], artifactId: string): boolean {
  return visibleVersions(versions).some((v) => v.artifact_ids.includes(artifactId));
}

// ── the loop ─────────────────────────────────────────────────────────────────────────────────────

/**
 * The task type a wedge declares to say "I can pick this engagement back up when the client answers".
 *
 * ═══ ONE TASK TYPE FOR BOTH VERDICTS, AND WHY THAT IS NOT LAZINESS ═══
 *
 * The obvious design is two: `revise_deliverable` when they ask for changes, something else when
 * they accept. It was the first one written and it is wrong for a mechanical reason. The client's
 * verdict is delivered by a `CaseWait` resuming, a wait carries exactly ONE `resume.task_type`, and
 * the wait has to be armed at RELEASE time — before anybody knows which way the client will go. Two
 * task types would mean either two live waits on one case (the one-live-wait index forbids it, and
 * rightly: an engagement is blocked on one thing) or arming the wait after the verdict, which is
 * after the only moment the chasing was needed.
 *
 * So one type, and the run reads which verdict it got from its own input. That is also the honest
 * shape of the work: "the client has come back on the statement of work — here is what they said"
 * is one job, and whether it ends in a new version or a thank-you is a judgement the run is
 * competent to make and the kernel is not.
 */
export const DELIVERABLE_VERDICT_TASK_TYPE = "deliverable_verdict";

/**
 * What the loop needs from the outside. INJECTED, never imported — the same contract `WaitDeps` and
 * `NudgeDeps` use, so a test hands this module two fakes and no singleton leaks between test files.
 *
 * NULL DEPS MEAN THE LOOP DOES NOTHING AND SAYS SO. Fail closed: an install that has not wired this
 * up must not silently swallow a client's acceptance.
 */
export interface DeliverableDeps {
  /** Is this wedge installed AND enabled for this project? Both gates, in that order — see roles.ts. */
  wedgeEnabled(projectId: string, wedge: string): boolean;
  /** Does this wedge declare this task type? The `wedgeCarriesNudge` question, asked of a verdict. */
  wedgeCarries(wedge: string, taskType: string): boolean;
}

let deps: DeliverableDeps | null = null;
export function setDeliverableDeps(d: DeliverableDeps): void {
  deps = d;
}
/** Test seam. */
export function _resetDeliverableDeps(): void {
  deps = null;
}

/**
 * Can this engagement's own wedge pick the work back up when the client answers?
 *
 * RESOLVED FROM THE CASE, NEVER FROM A DIRECTORY NAME. This is `nudgeWedgeFor`'s rule applied to the
 * fulfilment loop, and roles.ts:31 says why it is the right mechanism here rather than a new role:
 * we already HAVE the wedge — it is on the engagement — so the question is "can this wedge be asked
 * to do X", which is answered by what its manifest declares. A `provides` role would be the wrong
 * axis anyway, because every trade that delivers anything needs this, and a cardinality-one role
 * would let exactly one of them have it.
 *
 * Returns the wedge, or a sentence saying what will not happen. Never guesses.
 */
export function verdictCarrier(args: { project_id: string; wedge: string }): { wedge: string } | { why: string } {
  if (!deps) return { why: "the fulfilment loop is not wired up in this deployment" };
  if (!args.wedge) return { why: "this engagement has no service attached, so nothing can pick it back up" };
  if (!deps.wedgeEnabled(args.project_id, args.wedge)) {
    return { why: `the "${args.wedge}" service is not enabled for this business` };
  }
  if (!deps.wedgeCarries(args.wedge, DELIVERABLE_VERDICT_TASK_TYPE)) {
    // NOT an error, and not silent either. A trade that does not declare the verdict type still gets
    // the whole loop — the client is still shown the work, still accepts it, the acceptance is still
    // billable — it just does not get an automatic next run. Saying so on the timeline is the
    // difference between a deliberate limit and the failure this repo keeps having.
    return {
      why:
        `the "${args.wedge}" service does not declare a "${DELIVERABLE_VERDICT_TASK_TYPE}" task type, ` +
        `so nothing will pick this up automatically when your client answers — you will see their answer here`,
    };
  }
  return { wedge: args.wedge };
}

/**
 * The input a resumed run receives when the client has answered.
 *
 * The verdict is stated in a FIELD, not left to be derived from the deliverable's status. A run that
 * had to re-read the row to find out what happened would be reading it at resume time, which is up
 * to five minutes after the fact and — on a client who accepts and then immediately asks for
 * something else — potentially a different answer than the one it was woken for. `resumeInput`
 * makes exactly this argument about `satisfied_condition`.
 */
export function verdictInput(d: Deliverable, v: DeliverableVersion): Record<string, unknown> {
  const verdict = v.accepted_at ? "accepted" : v.change_requested_at ? "changes_requested" : "none";
  return {
    deliverable_id: d.id,
    title: d.title,
    kind: d.kind,
    client_id: d.client_id,
    version: v.version,
    verdict,
    /** Their words, verbatim. The single most important string in the whole loop. */
    change_request: v.change_request,
    accepted_note: v.accepted_note,
    /** What was in front of them when they said it, so a revision can diff against the right thing. */
    reviewed: { summary: v.summary, artifact_ids: v.artifact_ids, url: v.url },
  };
}

/**
 * One sentence for the case timeline. Every write in this loop leaves one, because an engagement
 * whose deliverable moved and whose timeline did not is an engagement a founder cannot reconstruct.
 */
export function timelineNote(kind: "submitted" | "released" | "changes" | "accepted" | "withdrawn", d: Deliverable, detail?: string): string {
  switch (kind) {
    case "submitted":
      return `"${d.title}" v${d.current_version} is ready for your review`;
    case "released":
      return `sent "${d.title}" v${d.current_version} to your client${detail ? ` — ${detail}` : ""}`;
    case "changes":
      return `your client asked for changes to "${d.title}" v${d.current_version}${detail ? `: ${detail}` : ""}`;
    case "accepted":
      return `your client accepted "${d.title}" v${d.current_version} — this can be invoiced`;
    case "withdrawn":
      return `"${d.title}" was withdrawn${detail ? `: ${detail}` : ""}`;
  }
}
