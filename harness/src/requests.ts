// Client requests — "what we need from you".
//
// Read the `ClientRequest` doc comment in contract.ts first; it is the design. The short version:
// a status page tells a customer to wait, this tells them what to do, and the agent is genuinely
// stopped until they do it. `thread_id` is what makes it a loop rather than a to-do list —
// answering posts into the client's thread, which spawns the run that was waiting.
//
// ── Why this is not `intake.ts` retargeted at the client ──
//
// It was the first thing tried, and it is the right instinct: intake.ts already has a ranked
// question queue with declared questions, discovered gaps, recurrence ranking and coverage, and a
// second queue is a cost. Three properties of that machinery are load-bearing there and wrong here.
//
//  1. AN ANSWER BECOMES GROUNDING. `recordAnswer` writes a KnowledgeItem named `intake/<id>.md`,
//     scoped to (project, wedge), which is then mounted into EVERY run of that wedge — for every
//     client. That is exactly right for "how do you phrase a chase"; it is a data-protection
//     incident for "here is my March bank statement". The one thing the intake loop exists to do is
//     the one thing this must never do.
//  2. THE KEY IS (project, wedge). An `OpenQuestion` has no client, no case, no thread and no due
//     date, because a founder's answer is true for the whole business. Every field this row needs to
//     be answerable BY A CLIENT is a field that queue deliberately does not have, and adding them
//     would make `buildCoverage`'s percentage meaningless: coverage of what a business knows cannot
//     be averaged with coverage of what nine customers have sent in.
//  3. RANKING IS BY RECURRENCE. `hits` — how many real jobs a gap has blocked — is the honest signal
//     for a founder deciding what to answer next. A client has one job. The signal here is a due
//     date and the fact that their work is stopped.
//
// What IS reused is the judgement, not the code: `rankRequests` below orders on the same principle
// as `buildCoverage` — unresolved first, then hard evidence (a deadline that has passed), then
// authored intent — so the two queues feel like one product. And the seam in the other direction is
// real: when an agent records a gap only the client can close, it should open one of these rather
// than a `KnowledgeGap`, because a founder cannot answer "where is your receipt".
import { randomUUID } from "node:crypto";
import { databaseUrl } from "./config";
import type { ClientRequest, ClientRequestKind, ClientRequestStatus } from "./contract";

const now = () => new Date().toISOString();

export const REQUEST_KINDS: readonly ClientRequestKind[] = [
  "document",
  "answer",
  "decision",
  "connection",
];

export const PARTY_ROLES = ["client", "candidate", "contractor", "assessor"] as const;

const TOOLKIT_RE = /^[a-z0-9_-]{1,64}$/;

/** Normalise and validate a connection toolkit slug. Empty string means "absent". */
export function normalizeToolkit(v: unknown): string | undefined {
  const s = String(v ?? "")
    .trim()
    .toLowerCase();
  if (!s) return undefined;
  if (!TOOLKIT_RE.test(s)) throw new Error("connection toolkit must be a short lowercase slug");
  return s;
}

export type NewClientRequest = Omit<
  ClientRequest,
  "id" | "created_at" | "updated_at" | "status" | "response" | "resolved_at"
> & { status?: ClientRequestStatus };

/**
 * Read/list filter.
 *
 * `project_id` is REQUIRED, and so is every by-id read below.
 *
 * That is the deliberate difference from `CaseFilter` and `RecordQuery`, where it is optional and
 * has to be defended by a fail-closed check in two separate backends to stay safe. This codebase
 * already leaked knowledge across tenants through exactly that kind of optional filter. A required
 * argument cannot be forgotten at a call site, and there is no operator-wide reader of this table
 * worth keeping — nobody needs "every client request in the fleet".
 */
export interface RequestFilter {
  project_id: string;
  client_id?: string;
  case_id?: string;
  thread_id?: string;
  status?: ClientRequestStatus;
  limit?: number;
}

export interface RequestStore {
  createRequest(r: NewClientRequest): Promise<ClientRequest>;
  /** Scoped by construction: an id from another tenant reads as "not found", not as a row. */
  getRequest(projectId: string, id: string): Promise<ClientRequest | undefined>;
  listRequests(f: RequestFilter): Promise<ClientRequest[]>;
  /**
   * Clear a request, atomically.
   *
   * `open → resolved` is part of the WHERE clause, exactly like `transitionInvoice`. Two tabs
   * answering the same request must not both spawn the run that was waiting: the second gets
   * undefined, and the caller does nothing rather than sending the agent off twice.
   */
  resolveRequest(
    projectId: string,
    id: string,
    response: string,
    artifactIds?: string[],
  ): Promise<ClientRequest | undefined>;
  /** The founder withdrawing an ask. Same atomicity, and equally terminal. */
  cancelRequest(projectId: string, id: string): Promise<ClientRequest | undefined>;
  /**
   * ATOMICALLY claim the right to nudge this request once. The twin of `claimInvoiceForChase`.
   *
   * ONE statement, and the whole pacing story lives inside it: the row is stamped only if it is
   * still `open`, has not been nudged since `notNudgedSince`, and has budget left under `maxNudges`.
   * Every one of those is a WHERE-clause guard rather than a caller-side check, because the failure
   * mode of a check-then-write here is a client receiving the same "we still need your March
   * statement" email from two replicas in the same second — the exact bug the dunning ladder's
   * compare-and-set was introduced to kill, arriving in the next subsystem along.
   *
   * Returns the row as it stands AFTER the claim (`nudge_count` already bumped), or `undefined` for
   * every loser. A loser must do nothing at all: it has not established the right to speak to
   * anybody's customer.
   */
  claimRequestForNudge(args: {
    project_id: string;
    id: string;
    notNudgedSince: string;
    maxNudges: number;
    at: string;
  }): Promise<ClientRequest | undefined>;
  close?(): Promise<void>;
}

/**
 * The order a blocked client should work through their list.
 *
 * Same principle as `buildCoverage` in intake.ts (see the header): unresolved first, then evidence,
 * then authored intent. "Evidence" here is a deadline that has already passed — the request that is
 * costing the business something right now — then the nearest deadline, then oldest first, because
 * a request that has been sitting for a fortnight is the one everybody has stopped seeing.
 */
export function rankRequests(rows: ClientRequest[], nowIso = now()): ClientRequest[] {
  const rank = (r: ClientRequest) => (r.status === "open" ? 0 : r.status === "cancelled" ? 2 : 1);
  return [...rows].sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    const aLate = !!a.due_at && a.due_at < nowIso;
    const bLate = !!b.due_at && b.due_at < nowIso;
    if (aLate !== bLate) return aLate ? -1 : 1;
    if (a.due_at !== b.due_at) return (a.due_at ?? "9999").localeCompare(b.due_at ?? "9999");
    return a.created_at.localeCompare(b.created_at);
  });
}

/** Trim and cap the free text a caller supplies. An `ask` is one sentence by design. */
export function normalizeAsk(v: unknown): string {
  return String(v ?? "").trim().slice(0, 500);
}

export class InMemoryRequestStore implements RequestStore {
  private rows = new Map<string, ClientRequest>();

  async createRequest(r: NewClientRequest): Promise<ClientRequest> {
    // Checked at the door rather than trusted from the caller, like `createDeployment`. A request
    // with no tenant is one every tenant's portal has to defend itself against on read, and one of
    // them will forget.
    if (!r.project_id) throw new Error("client request requires a project_id");
    if (!r.client_id) throw new Error("client request requires a client_id");
    const toolkit = r.kind === "connection" ? normalizeToolkit(r.connection_toolkit) : undefined;
    if (r.kind === "connection" && !toolkit) {
      throw new Error("a connection ask needs a toolkit (e.g. xero)");
    }
    const row: ClientRequest = {
      ...r,
      connection_toolkit: toolkit,
      party_role: r.party_role ?? "client",
      id: randomUUID(),
      status: r.status ?? "open",
      created_at: now(),
      updated_at: now(),
    };
    this.rows.set(row.id, row);
    return row;
  }

  async getRequest(projectId: string, id: string): Promise<ClientRequest | undefined> {
    const row = this.rows.get(id);
    return row && row.project_id === projectId ? row : undefined;
  }

  async listRequests(f: RequestFilter): Promise<ClientRequest[]> {
    if (!f.project_id) throw new Error("listRequests requires a project_id");
    const out = [...this.rows.values()].filter(
      (r) =>
        r.project_id === f.project_id &&
        (!f.client_id || r.client_id === f.client_id) &&
        (!f.case_id || r.case_id === f.case_id) &&
        (!f.thread_id || r.thread_id === f.thread_id) &&
        (!f.status || r.status === f.status),
    );
    return rankRequests(out).slice(0, f.limit ?? 200);
  }

  async resolveRequest(
    projectId: string,
    id: string,
    response: string,
    artifactIds?: string[],
  ): Promise<ClientRequest | undefined> {
    const row = this.rows.get(id);
    // No `await` between the read and the write — on a single-threaded event loop that makes this
    // indivisible, which is the memory-store equivalent of the SQL guard.
    if (!row || row.project_id !== projectId || row.status !== "open") return undefined;
    row.status = "resolved";
    row.response = response;
    if (artifactIds?.length) row.response_artifact_ids = artifactIds.slice(0, 20);
    row.resolved_at = now();
    row.updated_at = now();
    return row;
  }

  async cancelRequest(projectId: string, id: string): Promise<ClientRequest | undefined> {
    const row = this.rows.get(id);
    if (!row || row.project_id !== projectId || row.status !== "open") return undefined;
    row.status = "cancelled";
    row.updated_at = now();
    return row;
  }

  async claimRequestForNudge(args: {
    project_id: string;
    id: string;
    notNudgedSince: string;
    maxNudges: number;
    at: string;
  }): Promise<ClientRequest | undefined> {
    const row = this.rows.get(args.id);
    // NOT ONE `await` between the read and the write. An async function only yields at an await, so
    // a check-then-write with none of them is indivisible however many callers are in flight — the
    // memory-store equivalent of the SQL guard, exactly as `resolveRequest` above and
    // `claimInvoiceForChase` in billing.ts. Add an await here and the whole suite (which runs on
    // this backend) would keep passing while Postgres was the only thing holding the line.
    if (!row || !args.project_id || row.project_id !== args.project_id) return undefined;
    if (row.status !== "open") return undefined;
    if (row.last_nudged_at !== undefined && row.last_nudged_at > args.notNudgedSince) return undefined;
    if ((row.nudge_count ?? 0) >= args.maxNudges) return undefined;
    row.nudge_count = (row.nudge_count ?? 0) + 1;
    row.last_nudged_at = args.at;
    row.updated_at = now();
    return { ...row };
  }
}

// Process-wide singleton, the same shape as the domain, portal and billing stores: a synchronous
// accessor for the hot paths, one awaited init at boot to swap in the durable backend.
let cached: RequestStore | null = null;

export function getRequestStore(): RequestStore {
  if (!cached) cached = new InMemoryRequestStore();
  return cached;
}

export async function initRequestStore(): Promise<{ backend: string }> {
  const url = databaseUrl();
  // No `catch`, for the same reason as `initBillingStore`: a configured-but-unreachable database
  // must stop the boot, not degrade to a store that accepts a client's answer and forgets it on the
  // next deploy. The client would have no way to know, and the run would stay blocked for ever.
  if (url) {
    const { PostgresRequestStore } = await import("./requests.pg");
    cached = await PostgresRequestStore.connect(url);
    return { backend: "postgres" };
  }
  cached = new InMemoryRequestStore();
  return { backend: "memory" };
}

export async function closeRequestStore(): Promise<void> {
  await cached?.close?.();
}

/** Test seam — the singleton is process-local, exactly like the billing store's. */
export function _resetRequests(): void {
  cached = new InMemoryRequestStore();
}
