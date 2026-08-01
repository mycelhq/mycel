// Persistence behind an async interface, so the backend is swappable:
//   InMemoryStore  — zero setup, the default (tasks vanish on restart)
//   PostgresStore  — durable, selected when MYCEL_DATABASE_URL is set (see store.pg.ts)
import { randomUUID } from "node:crypto";
import { databaseUrl } from "./config";
import type {
  Approval,
  Artifact,
  EventType,
  Risk,
  Task,
  TaskEvent,
  TaskStatus,
} from "./contract";

export interface Store {
  createTask(t: Task): Promise<Task>;
  getTask(id: string): Promise<Task | undefined>;
  /** Most-recent-first list for the operator portal. */
  listTasks(filter?: { status?: TaskStatus; wedge?: string; client_id?: string; limit?: number }): Promise<Task[]>;
  /**
   * How many tasks these projects created since `sinceIso`.
   *
   * A COUNT, not a fetch. This is called on EVERY task creation to enforce the monthly plan limit,
   * and the previous implementation pulled 20,000 rows across all tenants and counted them in
   * JavaScript. That is a full scan per job on the hot path — and worse, it was WRONG above 20,000
   * tasks platform-wide: the limit took the most recent 20k across every tenant, so a small
   * customer's usage could read zero while a busy neighbour filled the window.
   */
  countTasksSince(projectIds: string[], sinceIso: string): Promise<number>;
  /** Model spend by these projects since `sinceIso`. Summed in the database, for the same reason. */
  sumCostSince(projectIds: string[], sinceIso: string): Promise<number>;
  /** Set status; on a failure/terminal state, pass the reason so it's persisted on the task. */
  setStatus(id: string, status: TaskStatus, error?: string): Promise<void>;
  /**
   * Patch the mutable routing/confidence fields. Keys absent from `patch` are left alone; pass an
   * explicit `null` (or `undefined` under a present key) to clear one. Deliberately narrow — status
   * has `setStatus`, cost has `addCost`, and `input`/`constraints` are fixed at creation because a
   * run already reading them must not have them changed underneath it.
   */
  updateTask(
    id: string,
    patch: Partial<Pick<Task, "assigned_to" | "confidence_score" | "source" | "client_id" | "case_id">>,
  ): Promise<Task | undefined>;
  addCost(id: string, delta: number): Promise<void>;
  appendEvent(taskId: string, type: EventType, data?: Record<string, unknown>): Promise<TaskEvent>;
  eventsAfter(taskId: string, afterId: number): Promise<TaskEvent[]>;
  createApproval(a: {
    task_id: string;
    action: string;
    risk: Risk;
    preview: Record<string, unknown>;
    ttlMs?: number;
  }): Promise<Approval>;
  getApproval(id: string): Promise<Approval | undefined>;
  setApproval(id: string, status: Approval["status"], policyReason?: string): Promise<Approval | undefined>;
  /** The approvals queue for the portal (optionally filtered by status, e.g. "pending"). */
  listApprovals(status?: Approval["status"]): Promise<Approval[]>;
  addArtifact(a: NewArtifact): Promise<Artifact>;
  getArtifact(id: string): Promise<Artifact | undefined>;
  /** A task's artifacts, metadata only — `content` is stripped, because a list of 30MB PDFs
   *  rendered into JSON is a way to run a server out of memory from a UI. */
  listArtifacts(taskId: string): Promise<Omit<Artifact, "content">[]>;
  /**
   * The same metadata-only list across several tasks in one round trip — how the client-context
   * façade answers "what have we already delivered to this client". Content stays stripped for the
   * same reason it is on `listArtifacts`: this fans out over a client's entire history.
   */
  listArtifactsForTasks(taskIds: string[]): Promise<Omit<Artifact, "content">[]>;
  /** Non-terminal tasks (queued/provisioning/running/awaiting_approval/validating). */
  listUnfinished(): Promise<Task[]>;
  /** Release resources (e.g. the pg pool) on graceful shutdown. Optional. */
  close?(): Promise<void>;
}

/** Everything an artifact needs at creation. `id` and `created_at` belong to the store. */
export type NewArtifact = Omit<Artifact, "id" | "created_at">;

/** Decoded size, whatever the encoding. Base64 length is a third larger and means nothing to anyone. */
export function sizeOf(a: { content: string; encoding?: "utf8" | "base64" }): number {
  return a.encoding === "base64"
    ? Buffer.from(a.content, "base64").byteLength
    : Buffer.byteLength(a.content, "utf8");
}

/** Metadata only. One helper so the memory and pg stores can't disagree about what "list" omits. */
export function stripContent(a: Artifact): Omit<Artifact, "content"> {
  const { content: _c, ...rest } = a;
  void _c;
  return rest;
}

const TERMINAL = new Set<TaskStatus>([
  "succeeded",
  "failed",
  "rejected",
  "expired",
  "cancelled",
]);

export class InMemoryStore implements Store {
  private tasks = new Map<string, Task>();
  private events = new Map<string, TaskEvent[]>();
  private counters = new Map<string, number>();
  private approvals = new Map<string, Approval>();
  private artifacts = new Map<string, Artifact>();

  async createTask(t: Task): Promise<Task> {
    this.tasks.set(t.id, t);
    this.events.set(t.id, []);
    this.counters.set(t.id, 0);
    return t;
  }

  async getTask(id: string): Promise<Task | undefined> {
    return this.tasks.get(id);
  }

  async listTasks(
    filter: { status?: TaskStatus; wedge?: string; client_id?: string; limit?: number } = {},
  ): Promise<Task[]> {
    let all = [...this.tasks.values()];
    if (filter.status) all = all.filter((t) => t.status === filter.status);
    if (filter.wedge) all = all.filter((t) => t.wedge === filter.wedge);
    if (filter.client_id) all = all.filter((t) => t.client_id === filter.client_id);
    all.sort((a, b) => (a.created_at < b.created_at ? 1 : -1)); // newest first
    return all.slice(0, filter.limit ?? 100);
  }

  async setStatus(id: string, status: TaskStatus, error?: string): Promise<void> {
    const t = this.tasks.get(id);
    if (t) {
      t.status = status;
      if (error !== undefined) t.error = error;
      t.updated_at = new Date().toISOString();
    }
  }

  async updateTask(
    id: string,
    patch: Partial<Pick<Task, "assigned_to" | "confidence_score" | "source" | "client_id" | "case_id">>,
  ): Promise<Task | undefined> {
    const t = this.tasks.get(id);
    if (!t) return undefined;
    // `"k" in patch` rather than `!== undefined` for the nullable fields: clearing a client link or
    // a confidence score is a real intent and must not be indistinguishable from not mentioning it.
    if (patch.assigned_to !== undefined) t.assigned_to = patch.assigned_to;
    if ("confidence_score" in patch) t.confidence_score = patch.confidence_score;
    if (patch.source !== undefined) t.source = patch.source;
    if ("client_id" in patch) t.client_id = patch.client_id;
    if ("case_id" in patch) t.case_id = patch.case_id;
    t.updated_at = new Date().toISOString();
    return t;
  }

  async addCost(id: string, delta: number): Promise<void> {
    const t = this.tasks.get(id);
    if (t) {
      t.cost_usd = Math.round((t.cost_usd + delta) * 1e6) / 1e6;
      t.updated_at = new Date().toISOString();
    }
  }

  async appendEvent(
    taskId: string,
    type: EventType,
    data: Record<string, unknown> = {},
  ): Promise<TaskEvent> {
    const seq = (this.counters.get(taskId) ?? 0) + 1;
    this.counters.set(taskId, seq);
    const ev: TaskEvent = {
      id: seq,
      task_id: taskId,
      seq,
      type,
      ts: new Date().toISOString(),
      data,
    };
    const list = this.events.get(taskId);
    if (list) list.push(ev);
    return ev;
  }

  async eventsAfter(taskId: string, afterId: number): Promise<TaskEvent[]> {
    return (this.events.get(taskId) ?? []).filter((e) => e.id > afterId);
  }

  async createApproval(a: {
    task_id: string;
    action: string;
    risk: Risk;
    preview: Record<string, unknown>;
    ttlMs?: number;
  }): Promise<Approval> {
    const approval: Approval = {
      approval_id: randomUUID(),
      task_id: a.task_id,
      action: a.action,
      risk: a.risk,
      preview: a.preview,
      status: "pending",
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + (a.ttlMs ?? 300000)).toISOString(),
    };
    this.approvals.set(approval.approval_id, approval);
    return approval;
  }

  async getApproval(id: string): Promise<Approval | undefined> {
    return this.approvals.get(id);
  }

  async setApproval(id: string, status: Approval["status"], policyReason?: string): Promise<Approval | undefined> {
    const a = this.approvals.get(id);
    if (a) {
      a.status = status;
      a.decided_at = new Date().toISOString();
      if (policyReason !== undefined) a.policy_reason = policyReason;
    }
    return a;
  }

  async listApprovals(status?: Approval["status"]): Promise<Approval[]> {
    let all = [...this.approvals.values()];
    if (status) all = all.filter((a) => a.status === status);
    return all;
  }

  async addArtifact(a: NewArtifact): Promise<Artifact> {
    const art: Artifact = {
      ...a,
      id: randomUUID(),
      created_at: new Date().toISOString(),
      // Derived when the caller didn't say. Only uploads were setting it, so every artifact the
      // agent produced showed a blank size in the UI — a column that is empty most of the time
      // reads as broken rather than as absent.
      size_bytes: a.size_bytes ?? sizeOf(a),
    };
    this.artifacts.set(art.id, art);
    return art;
  }

  async getArtifact(id: string): Promise<Artifact | undefined> {
    return this.artifacts.get(id);
  }

  async listArtifacts(taskId: string): Promise<Omit<Artifact, "content">[]> {
    return [...this.artifacts.values()]
      .filter((a) => a.task_id === taskId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map(stripContent);
  }

  async listArtifactsForTasks(taskIds: string[]): Promise<Omit<Artifact, "content">[]> {
    if (!taskIds.length) return [];
    const wanted = new Set(taskIds);
    return [...this.artifacts.values()]
      .filter((a) => wanted.has(a.task_id))
      .sort((a, b) => b.created_at.localeCompare(a.created_at)) // newest first, like every other list
      .map(stripContent);
  }

  async countTasksSince(projectIds: string[], sinceIso: string): Promise<number> {
    const wanted = new Set(projectIds);
    let n = 0;
    for (const t of this.tasks.values()) {
      if (t.project_id && wanted.has(t.project_id) && t.created_at >= sinceIso) n++;
    }
    return n;
  }

  async sumCostSince(projectIds: string[], sinceIso: string): Promise<number> {
    const wanted = new Set(projectIds);
    let n = 0;
    for (const t of this.tasks.values()) {
      if (t.project_id && wanted.has(t.project_id) && t.created_at >= sinceIso) n += t.cost_usd || 0;
    }
    return Number(n.toFixed(4));
  }

  async listUnfinished(): Promise<Task[]> {
    return [...this.tasks.values()].filter((t) => !TERMINAL.has(t.status));
  }
}

// Backend selection: Postgres when MYCEL_DATABASE_URL is set, else in-memory.
export async function createStore(): Promise<{ store: Store; backend: string }> {
  const url = databaseUrl();
  if (url) {
    const { PostgresStore } = await import("./store.pg");
    const store = await PostgresStore.connect(url);
    return { store, backend: "postgres" };
  }
  return { store: new InMemoryStore(), backend: "memory" };
}

// ───────────────────────────────────────────────────────────────────────────────
// Grants — the nonce-keyed capability rows behind proxygrants.ts and actiongrants.ts.
//
// These were plain in-process `Map`s, and that was not a degradation under multiple replicas, it
// was a break. `infra/main.tf` runs api_count = 2 and worker_count = 2, the queue hands a task to
// whichever worker claims it, and the worker service is not in the ALB target group at all — so a
// nonce minted inside a worker process is presented to an API replica that has never seen it. Every
// surface that authenticates with one (the action proxy, the read proxy, the case/gap/records APIs,
// workflows, and the LLM proxy) answered `401 invalid action token` for reasons no log explained.
//
// The store is deliberately dumb — an opaque jsonb payload under (kind, nonce) — so the two grant
// modules keep their own shapes and their own encryption decisions. See proxygrants.ts, which seals
// the provider key before it is ever handed here.
// ───────────────────────────────────────────────────────────────────────────────

/** Namespaces the nonce space. A proxy nonce must never resolve as an action grant. */
export type GrantKind = "proxy" | "action";

export interface GrantStore {
  /**
   * True when the payload leaves this process (i.e. is written to a database).
   *
   * Callers use it to decide whether a secret in the payload needs sealing. In memory the payload
   * never leaves the heap that produced it, so sealing there would buy nothing and would force
   * MYCEL_SECRET_KEY on every `npm run dev`.
   */
  readonly durable: boolean;
  put(kind: GrantKind, nonce: string, payload: Record<string, unknown>, expiresAt: Date): Promise<void>;
  /** The grant, or undefined if it is unknown OR expired. Expiry is part of the lookup. */
  get(kind: GrantKind, nonce: string): Promise<Record<string, unknown> | undefined>;
  del(kind: GrantKind, nonce: string): Promise<void>;
  close?(): Promise<void>;
}

/**
 * How long a grant may live if nothing revokes it.
 *
 * Revocation at the end of a run is the normal path; the TTL is the backstop for the run that died
 * with the process holding it. Twice the runtime ceiling, so a grant can never expire out from
 * under a run that is still legitimately inside its own budget, and never long enough that a
 * leaked nonce is useful tomorrow.
 */
export function grantTtlMs(): number {
  const ceilingS = Number(process.env.MYCEL_MAX_RUNTIME_S ?? 1800);
  return Math.max(Number.isFinite(ceilingS) ? ceilingS : 1800, 600) * 2 * 1000;
}

/** How often a store bothers to sweep. Correctness never depends on this — see `get`. */
const SWEEP_INTERVAL_MS = 60_000;

export class InMemoryGrantStore implements GrantStore {
  readonly durable = false;
  private rows = new Map<string, { payload: Record<string, unknown>; expiresAt: number }>();
  private lastSweep = 0;

  private k(kind: GrantKind, nonce: string): string {
    return `${kind} ${nonce}`;
  }

  async put(kind: GrantKind, nonce: string, payload: Record<string, unknown>, expiresAt: Date): Promise<void> {
    this.sweep();
    this.rows.set(this.k(kind, nonce), { payload, expiresAt: expiresAt.getTime() });
  }

  async get(kind: GrantKind, nonce: string): Promise<Record<string, unknown> | undefined> {
    const key = this.k(kind, nonce);
    const row = this.rows.get(key);
    if (!row) return undefined;
    // Expiry is checked on READ, not left to the sweeper. A grant that outlives its run because a
    // timer was late is precisely the hole this is meant to close.
    if (row.expiresAt <= Date.now()) {
      this.rows.delete(key);
      return undefined;
    }
    return row.payload;
  }

  async del(kind: GrantKind, nonce: string): Promise<void> {
    this.rows.delete(this.k(kind, nonce));
  }

  /**
   * Drop expired rows. Throttled and driven by writes rather than by a timer: a `setInterval` in a
   * module like this keeps the event loop alive, which turns a clean test-process exit into a hang.
   */
  private sweep(): void {
    const now = Date.now();
    if (now - this.lastSweep < SWEEP_INTERVAL_MS) return;
    this.lastSweep = now;
    for (const [k, v] of this.rows) if (v.expiresAt <= now) this.rows.delete(k);
  }

  /** Test hook: forces a sweep regardless of the throttle, and reports how many rows remain. */
  sweepNow(): number {
    this.lastSweep = 0;
    this.sweep();
    return this.rows.size;
  }
}

// The grant backend is a process-wide singleton resolved on first use, not at boot: `index.ts` owns
// boot and this has to work identically inside a worker, inside an API replica, and inside a test
// that never boots either.
let grantStore: GrantStore | null = null;
let grantStorePending: Promise<GrantStore> | null = null;

export function getGrantStore(): Promise<GrantStore> {
  if (grantStore) return Promise.resolve(grantStore);
  const url = databaseUrl();
  if (!url) {
    grantStore = new InMemoryGrantStore();
    return Promise.resolve(grantStore);
  }
  if (!grantStorePending) {
    grantStorePending = import("./store.pg")
      .then((m) => m.PostgresGrantStore.connect(url))
      .then((s) => {
        grantStore = s;
        return s;
      })
      .catch((e) => {
        // Do not memoize a rejection: a database that was briefly unreachable at first use would
        // otherwise poison every grant for the lifetime of the process.
        grantStorePending = null;
        throw e;
      });
  }
  return grantStorePending;
}

/** Test hook — drops the cached backend so a test can swap `MYCEL_DATABASE_URL` underneath it. */
export function resetGrantStoreForTests(): void {
  grantStore = null;
  grantStorePending = null;
}

// ───────────────────────────────────────────────────────────────────────────────
// Policy counters — the ceilings behind `max_per_task` / `max_per_day` in policy.ts.
//
// Also in-process `Map`s, and worse than the grants: this is a SECURITY control that failed OPEN.
// With 2 API replicas and 2 workers each holding their own counter, a `max_per_day: 40` envelope
// permitted roughly 160 auto-approved real-world actions per day. `perTask` was never evicted
// either — one entry per (task, rule) for the lifetime of the process.
// ───────────────────────────────────────────────────────────────────────────────

/** `task` counters are keyed by task id, `day` counters by calendar day. Both expire. */
export type PolicyScope = "task" | "day";

export interface PolicyCounterStore {
  /** Current value; 0 when absent or expired. Never consumes budget — used for the peek. */
  peek(projectId: string, scope: PolicyScope, key: string): Promise<number>;
  /**
   * Atomic `n = n + 1`, returning the NEW value.
   *
   * The value must be computed from the row's own current value so that under READ COMMITTED the
   * loser of the row lock re-evaluates against the winner's committed row. Never read-then-write.
   */
  bump(projectId: string, scope: PolicyScope, key: string, expiresAt: Date): Promise<number>;
  close?(): Promise<void>;
}

export class InMemoryPolicyCounters implements PolicyCounterStore {
  private rows = new Map<string, { n: number; expiresAt: number }>();
  private lastSweep = 0;

  private k(projectId: string, scope: PolicyScope, key: string): string {
    return `${projectId} ${scope} ${key}`;
  }

  async peek(projectId: string, scope: PolicyScope, key: string): Promise<number> {
    const row = this.rows.get(this.k(projectId, scope, key));
    if (!row || row.expiresAt <= Date.now()) return 0;
    return row.n;
  }

  async bump(projectId: string, scope: PolicyScope, key: string, expiresAt: Date): Promise<number> {
    this.sweep();
    const k = this.k(projectId, scope, key);
    const row = this.rows.get(k);
    // An expired row is a fresh window, not a continuation — same rule the SQL uses.
    const n = !row || row.expiresAt <= Date.now() ? 1 : row.n + 1;
    this.rows.set(k, { n, expiresAt: !row || row.expiresAt <= Date.now() ? expiresAt.getTime() : row.expiresAt });
    return n;
  }

  private sweep(): void {
    const now = Date.now();
    if (now - this.lastSweep < SWEEP_INTERVAL_MS) return;
    this.lastSweep = now;
    for (const [k, v] of this.rows) if (v.expiresAt <= now) this.rows.delete(k);
  }

  /** Test hook: forces a sweep regardless of the throttle, and reports how many rows remain. */
  sweepNow(): number {
    this.lastSweep = 0;
    this.sweep();
    return this.rows.size;
  }

  clear(): void {
    this.rows.clear();
    this.lastSweep = 0;
  }
}

let policyCounters: PolicyCounterStore | null = null;
let policyCountersPending: Promise<PolicyCounterStore> | null = null;

export function getPolicyCounters(): Promise<PolicyCounterStore> {
  if (policyCounters) return Promise.resolve(policyCounters);
  const url = databaseUrl();
  if (!url) {
    policyCounters = new InMemoryPolicyCounters();
    return Promise.resolve(policyCounters);
  }
  if (!policyCountersPending) {
    policyCountersPending = import("./store.pg")
      .then((m) => m.PostgresPolicyCounters.connect(url))
      .then((s) => {
        policyCounters = s;
        return s;
      })
      .catch((e) => {
        policyCountersPending = null;
        throw e;
      });
  }
  return policyCountersPending;
}

/**
 * Test hook — clears the IN-MEMORY counters, synchronously.
 *
 * Deliberately a no-op against Postgres. `resetPolicyCounters()` is called by tests that do not
 * await it, and more importantly a shared database is not something a test may truncate: a live-pg
 * test scopes itself with a unique project/task id instead (see `freshProjectId` in test/helpers).
 */
export function resetInMemoryPolicyCounters(): void {
  if (policyCounters instanceof InMemoryPolicyCounters) policyCounters.clear();
}

/** Test hook — drops the cached backend so a test can swap `MYCEL_DATABASE_URL` underneath it. */
export function resetPolicyCounterStoreForTests(): void {
  policyCounters = null;
  policyCountersPending = null;
}
