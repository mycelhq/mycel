// Persistence behind an async interface, so the backend is swappable:
//   InMemoryStore  — zero setup, the default (tasks vanish on restart)
//   PostgresStore  — durable, selected when MYCEL_DATABASE_URL is set (see store.pg.ts)
import { randomUUID } from "node:crypto";
import { databaseUrl, loadConfig } from "./config";
import type {
  Approval,
  Artifact,
  EventType,
  Risk,
  Task,
  TaskEvent,
  TaskStatus,
} from "./contract";

/** One human decision, with the task context a suggester groups by. */
export interface DecidedApproval {
  action: string;
  risk: Risk;
  status: "approved" | "rejected";
  edited: boolean;
  decided_at: string;
  client_id?: string;
  wedge?: string;
  task_type?: string;
}

/** A task reduced to what an aggregate needs. See `listTaskFacts`. */
export interface TaskFact {
  id: string;
  project_id?: string;
  wedge: string;
  status: TaskStatus;
  cost_usd: number;
  created_at: string;
}

/**
 * One week of "how much of this still needed a person".
 *
 * `alone` counts approvals a standing rule cleared without the founder; `stopped` counts every
 * other disposition — approved, rejected, expired, still pending. A week with neither is NOT a
 * zero and must not be plotted as one: it is a week nothing was asked, which says nothing about
 * how much a founder is needed. The route omits those weeks and the chart draws a gap.
 */
export interface InvolvementWeek {
  /** Monday of the week, `YYYY-MM-DD`. */
  week: string;
  /** Cleared by a standing rule — the business acting without its owner. */
  alone: number;
  /** Everything that reached a person, or is still waiting on one. */
  stopped: number;
}

export interface Store {
  createTask(t: Task): Promise<Task>;
  getTask(id: string): Promise<Task | undefined>;
  /** Most-recent-first list for the operator portal. */
  listTasks(filter?: {
    status?: TaskStatus;
    wedge?: string;
    client_id?: string;
    /**
     * Scope in the QUERY, not afterwards. Without this a caller fetches the newest N rows across
     * EVERY tenant and filters in JavaScript — which is slow, and is also wrong: a busy neighbour
     * fills the window and a small customer's own rows never appear in it. `countTasksSince` above
     * carries the same warning about the same bug, fixed there and not here.
     */
    project_ids?: readonly string[];
    /** ISO. Windowed in the query for the same two reasons. */
    since?: string;
    limit?: number;
  }): Promise<Task[]>;
  /**
   * How many tasks these projects created since `sinceIso`.
   *
   * A COUNT, not a fetch. This is called on EVERY task creation to enforce the monthly plan limit,
   * and the previous implementation pulled 20,000 rows across all tenants and counted them in
   * JavaScript. That is a full scan per job on the hot path — and worse, it was WRONG above 20,000
   * tasks platform-wide: the limit took the most recent 20k across every tenant, so a small
   * customer's usage could read zero while a busy neighbour filled the window.
   */
  /**
   * The six columns an aggregate reads, and no payload.
   *
   * `tasks` averages ~3KB a row because `input`, `constraints`, `tools` and `output` are JSON.
   * `/v1/analytics` counted rows and summed a float and pulled five thousand whole tasks to do it —
   * about fifteen megabytes per load of Home, measured at 9.5 seconds. Same reasoning as
   * `countTasksSince` below: do it in the database, and move only what the answer needs.
   */
  listTaskFacts(filter?: {
    project_ids?: readonly string[];
    since?: string;
    limit?: number;
  }): Promise<TaskFact[]>;
  /**
   * Several tasks by id, in ONE query.
   *
   * `/v1/approvals` resolved `getTask` inside a sequential `for` loop — one database round trip per
   * approval, in series, on the endpoint Home calls first. `/v1/analytics` did the same. A list of
   * ids is one `= ANY`, and the caller reads a Map.
   */
  getTasksByIds(ids: readonly string[]): Promise<Map<string, Task>>;
  countTasksSince(projectIds: string[], sinceIso: string): Promise<number>;
  /**
   * The involvement series, grouped and scoped IN THE QUERY.
   *
   * Not `listApprovals()` plus a filter: that method takes every tenant's rows and has no window,
   * which is the bug `countTasksSince` carries a warning about and `/v1/analytics` was fixed for.
   * `approvals` has no `project_id` of its own — it reaches one through `tasks` — so the scope is
   * a join, and an empty project list matches nothing, which is the right answer.
   */
  involvementByWeek(projectIds: string[], sinceIso: string): Promise<InvolvementWeek[]>;
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
    patch: Partial<Pick<Task, "assigned_to" | "confidence_score" | "source" | "client_id" | "case_id" | "batch_id">>,
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
  setApproval(id: string, status: Approval["status"], policyReason?: string, edited?: boolean): Promise<Approval | undefined>;
  /**
   * The human decision stream for one project: decided approvals joined to their tasks, most
   * recent first. `auto_approved` is EXCLUDED — those are the policy engine's decisions, and a
   * suggester that counted them would be learning from itself, which is the check-confirming-its-
   * own-answer failure this repo keeps finding. Read by the standing-grant suggester.
   */
  decidedApprovalsForProject(projectId: string, sinceIso: string): Promise<DecidedApproval[]>;
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
  /**
   * Non-terminal tasks untouched for `staleAfterMs`.
   *
   * The argument was on the Postgres implementation and NOT on this interface, so every caller got
   * the default and no caller could ask a different question. `starvation.ts` needs its own window,
   * and a method whose signature is narrower than its implementation is a capability nobody can
   * reach without reading the concrete class.
   */
  listUnfinished(staleAfterMs?: number): Promise<Task[]>;
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

/**
 * How long a non-terminal row must sit untouched before anything reclaims it.
 *
 * HERE, not in `store.pg.ts`, so both stores read the same number. It lived in the Postgres module
 * and the memory store could not import it without dragging in the `pg` driver — so the memory store
 * simply had no default, the two answered different questions, and the dead-run reaper cancelled
 * live runs on every install without Postgres. See `MemoryStore.listUnfinished`.
 */
export const STALE_TASK_MS = Number(process.env.MYCEL_STALE_TASK_MS ?? 10 * 60 * 1000);

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
    filter: {
    status?: TaskStatus;
    wedge?: string;
    client_id?: string;
    /**
     * Scope in the QUERY, not afterwards. Without this a caller fetches the newest N rows across
     * EVERY tenant and filters in JavaScript — which is slow, and is also wrong: a busy neighbour
     * fills the window and a small customer's own rows never appear in it. `countTasksSince` above
     * carries the same warning about the same bug, fixed there and not here.
     */
    project_ids?: readonly string[];
    /** ISO. Windowed in the query for the same two reasons. */
    since?: string;
    limit?: number;
  } = {},
  ): Promise<Task[]> {
    let all = [...this.tasks.values()];
    if (filter.status) all = all.filter((t) => t.status === filter.status);
    if (filter.wedge) all = all.filter((t) => t.wedge === filter.wedge);
    if (filter.client_id) all = all.filter((t) => t.client_id === filter.client_id);
    if (filter.project_ids) {
      const want = new Set(filter.project_ids);
      all = all.filter((t) => !!t.project_id && want.has(t.project_id));
    }
    if (filter.since) {
      const from = Date.parse(filter.since);
      all = all.filter((t) => (Date.parse(t.created_at) || 0) >= from);
    }
    all.sort((a, b) => (a.created_at < b.created_at ? 1 : -1)); // newest first
    return all.slice(0, filter.limit ?? 100);
  }

  async getTasksByIds(ids: readonly string[]): Promise<Map<string, Task>> {
    const out = new Map<string, Task>();
    for (const id of ids) {
      const t = this.tasks.get(id);
      if (t) out.set(id, t);
    }
    return out;
  }

  async listTaskFacts(
    filter: { project_ids?: readonly string[]; since?: string; limit?: number } = {},
  ): Promise<TaskFact[]> {
    const rows = await this.listTasks({ ...filter, limit: filter.limit ?? 5000 });
    return rows.map((t) => ({
      id: t.id,
      project_id: t.project_id,
      wedge: t.wedge,
      status: t.status,
      cost_usd: t.cost_usd,
      created_at: t.created_at,
    }));
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
    patch: Partial<Pick<Task, "assigned_to" | "confidence_score" | "source" | "client_id" | "case_id" | "batch_id">>,
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
    if ("batch_id" in patch) t.batch_id = patch.batch_id;
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

  async setApproval(id: string, status: Approval["status"], policyReason?: string, edited?: boolean): Promise<Approval | undefined> {
    const a = this.approvals.get(id);
    if (a) {
      a.status = status;
    if (edited !== undefined) a.edited = edited;
      a.decided_at = new Date().toISOString();
      if (policyReason !== undefined) a.policy_reason = policyReason;
    }
    return a;
  }

  async involvementByWeek(projectIds: string[], sinceIso: string): Promise<InvolvementWeek[]> {
    const scope = new Set(projectIds);
    const weeks = new Map<string, InvolvementWeek>();
    for (const a of this.approvals.values()) {
      if (a.created_at < sinceIso) continue;
      const task = this.tasks.get(a.task_id);
      if (!task?.project_id || !scope.has(task.project_id)) continue;
      // Monday, to agree with Postgres `date_trunc('week', …)`.
      const d = new Date(a.created_at);
      const day = (d.getUTCDay() + 6) % 7;
      d.setUTCDate(d.getUTCDate() - day);
      const week = d.toISOString().slice(0, 10);
      const row = weeks.get(week) ?? { week, alone: 0, stopped: 0 };
      if (a.status === "auto_approved") row.alone += 1;
      else row.stopped += 1;
      weeks.set(week, row);
    }
    return [...weeks.values()].sort((x, y) => x.week.localeCompare(y.week));
  }

  async listApprovals(status?: Approval["status"]): Promise<Approval[]> {
    let all = [...this.approvals.values()];
    if (status) all = all.filter((a) => a.status === status);
    return all;
  }

  async decidedApprovalsForProject(projectId: string, sinceIso: string): Promise<DecidedApproval[]> {
    const out: DecidedApproval[] = [];
    for (const a of this.approvals.values()) {
      if (a.status !== "approved" && a.status !== "rejected") continue;
      if (!a.decided_at || a.decided_at < sinceIso) continue;
      const t = this.tasks.get(a.task_id);
      if (!t || t.project_id !== projectId) continue;
      out.push({
        action: a.action,
        risk: a.risk,
        status: a.status,
        edited: !!a.edited,
        decided_at: a.decided_at,
        client_id: t.client_id,
        wedge: t.wedge,
        task_type: t.task_type,
      });
    }
    return out.sort((x, y) => (x.decided_at < y.decided_at ? 1 : -1));
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

  /**
   * ═══ THE DEFAULT IS LOAD-BEARING, AND ITS ABSENCE KILLED LIVE RUNS ═══
   *
   * This took `staleAfterMs?: number` with NO default while `store.pg.ts` had
   * `staleAfterMs = STALE_TASK_MS`. Both satisfy the interface — `staleAfterMs?: number` — and both
   * typecheck, which is exactly why it survived.
   *
   * `recovery.ts` calls `listUnfinished()` with no argument. On Postgres that means ten minutes. On
   * memory it meant `cutoff === undefined`, so the filter passed EVERY non-terminal task, and the
   * dead-run reaper — which runs every two minutes — cancelled runs that had started seconds earlier.
   *
   * Measured on a real-key run: the job lived 65 seconds, its largest internal gap was 8.9 seconds,
   * and it was closed with "This run went silent while running — nothing has driven it for over ten
   * minutes." Both halves wrong, and the founder-facing message confidently so.
   *
   * It hits exactly the installs that have no Postgres: `npm run demo`, the test suite, and every
   * stranger who clones the open repo and runs a job. The reaper's own note says "a live run is never
   * a candidate" — true of the store it was reasoned against, and false of this one.
   */
  async listUnfinished(staleAfterMs: number = STALE_TASK_MS): Promise<Task[]> {
    const cutoff = Date.now() - staleAfterMs;
    return [...this.tasks.values()].filter(
      (t) =>
        !TERMINAL.has(t.status) &&
        // Honoured here too, or the memory store answers a different question from the Postgres one
        // and a test passes for a reason production does not share.
        Date.parse(t.updated_at) < cutoff,
    );
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

/**
 * Namespaces the nonce space. A proxy nonce must never resolve as an action grant.
 *
 * `build` is the third: a `build`-shape run holds no action grant at all (harness.ts,
 * `grants_actions: false`), so the build tool needed a credential of its own rather than a flag on
 * a token that also opens the records, case and knowledge-gap endpoints. See buildgrants.ts.
 *
 * `preview_target` is the odd one out and is NOT a credential. It is keyed by task id rather than by
 * a nonce, and it holds an ADDRESS (which dev server a live preview is on) so that any replica can
 * proxy to it. It rides this table because this table is already the shared, TTL'd, cross-replica
 * place — the same reason sandbox callback nonces were moved here out of process-local `Map`s. It
 * grants nothing: possessing it lets you reach a sandbox only if you already hold the `preview`
 * grant that the proxy route checks first. See preview-target.ts.
 */
/**
 * `action_idem` namespaces the send-deduplication keys away from `idem`, which is task
 * creation's. Two different questions ("has this task been created" / "has this exact message
 * already gone") must not be able to answer each other by colliding on a nonce.
 */
export type GrantKind = "proxy" | "action" | "build" | "preview" | "preview_target" | "idem" | "action_idem";

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
  /**
   * Take the key if nobody has it. Returns the EXISTING payload when somebody already did.
   *
   * `put` is last-write-wins, which is right for a grant (one minter, one nonce) and useless for a
   * CLAIM. Two retries of the same request race: both `get` nothing, both `put`, both proceed, and
   * the thing the claim existed to make single happens twice. The check and the write have to be
   * one operation, so they are.
   *
   * Returning the existing payload rather than a boolean is what lets the loser answer with the
   * winner's result instead of an error. A caller who retried a timeout wants their task id, not a
   * 409 telling them the request they are not sure they made was made.
   */
  putIfAbsent(
    kind: GrantKind,
    nonce: string,
    payload: Record<string, unknown>,
    expiresAt: Date,
  ): Promise<Record<string, unknown> | undefined>;
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
  /**
   * READ THE CEILING, DO NOT RE-DERIVE IT.
   *
   * This used to compute `process.env.MYCEL_MAX_RUNTIME_S ?? 1800` — its own default for a number
   * config.ts also defaults, and grants.test.ts defaults a third time. Three copies of one value,
   * and the moment the real ceiling moved to three hours the other two did not: the TTL stayed at
   * one hour, so every grant a long run holds — the action proxy, the build plane, the LLM proxy,
   * the preview target — would have expired out from under a run still inside its own budget.
   *
   * The test that exists to prevent exactly that passed, because it compared against its own stale
   * copy rather than against the ceiling. A duplicated constant does not just drift; it disables
   * the check that would have caught the drift.
   */
  const ceilingS = loadConfig().maxRuntimeCeilingS;
  return Math.max(Number.isFinite(ceilingS) ? ceilingS : 1800, 600) * 2 * 1000;
}

/** How often a store bothers to sweep. Correctness never depends on this — see `get`. */
const SWEEP_INTERVAL_MS = 60_000;

export class InMemoryGrantStore implements GrantStore {
  readonly durable = false;
  private rows = new Map<string, { payload: Record<string, unknown>; expiresAt: number }>();
  private lastSweep = 0;

  private k(kind: GrantKind, nonce: string): string {
    return `${kind}\u0000${nonce}`;
  }

  async put(kind: GrantKind, nonce: string, payload: Record<string, unknown>, expiresAt: Date): Promise<void> {
    this.sweep();
    this.rows.set(this.k(kind, nonce), { payload, expiresAt: expiresAt.getTime() });
  }

  /**
   * Atomic by construction: this is one synchronous block on a single-threaded event loop, so no
   * other caller can observe the gap between the read and the write. The Postgres version has to
   * say so explicitly with ON CONFLICT DO NOTHING.
   */
  async putIfAbsent(
    kind: GrantKind,
    nonce: string,
    payload: Record<string, unknown>,
    expiresAt: Date,
  ): Promise<Record<string, unknown> | undefined> {
    const key = this.k(kind, nonce);
    const row = this.rows.get(key);
    // An EXPIRED claim is not a claim. Same rule as `get` and for the same reason: a key that
    // outlived its window must not block a genuinely new request forever.
    if (row && row.expiresAt > Date.now()) return row.payload;
    this.rows.set(key, { payload, expiresAt: expiresAt.getTime() });
    return undefined;
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

/**
 * `task` counters are keyed by task id, `day` by calendar day, `month` by calendar month.
 *
 * `month` is the plan-period scope — an org's image allowance, which resets when their month does
 * rather than at midnight. The column is unconstrained text, so this needs no migration; what it
 * needs is to be a NAMED scope rather than a `day` row with a month-shaped key, because the next
 * person reading a `day` counter that expires in three weeks would reasonably assume a bug.
 */
export type PolicyScope = "task" | "day" | "month";

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
    return `${projectId}\u0000${scope}\u0000${key}`;
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
