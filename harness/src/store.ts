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
  listTasks(filter?: { status?: TaskStatus; wedge?: string; limit?: number }): Promise<Task[]>;
  /** Set status; on a failure/terminal state, pass the reason so it's persisted on the task. */
  setStatus(id: string, status: TaskStatus, error?: string): Promise<void>;
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

  async listTasks(filter: { status?: TaskStatus; wedge?: string; limit?: number } = {}): Promise<Task[]> {
    let all = [...this.tasks.values()];
    if (filter.status) all = all.filter((t) => t.status === filter.status);
    if (filter.wedge) all = all.filter((t) => t.wedge === filter.wedge);
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
