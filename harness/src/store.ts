// Persistence behind an async interface, so the backend is swappable:
//   InMemoryStore  — zero setup, the default (tasks vanish on restart)
//   PostgresStore  — durable, selected when MYCEL_DATABASE_URL is set (see store.pg.ts)
import { randomUUID } from "node:crypto";
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
  setStatus(id: string, status: TaskStatus): Promise<void>;
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
  setApproval(id: string, status: Approval["status"]): Promise<Approval | undefined>;
  addArtifact(a: {
    task_id: string;
    name: string;
    content_type: string;
    content: string;
  }): Promise<Artifact>;
  getArtifact(id: string): Promise<Artifact | undefined>;
}

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

  async setStatus(id: string, status: TaskStatus): Promise<void> {
    const t = this.tasks.get(id);
    if (t) {
      t.status = status;
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
      expires_at: new Date(Date.now() + (a.ttlMs ?? 300000)).toISOString(),
    };
    this.approvals.set(approval.approval_id, approval);
    return approval;
  }

  async getApproval(id: string): Promise<Approval | undefined> {
    return this.approvals.get(id);
  }

  async setApproval(id: string, status: Approval["status"]): Promise<Approval | undefined> {
    const a = this.approvals.get(id);
    if (a) a.status = status;
    return a;
  }

  async addArtifact(a: {
    task_id: string;
    name: string;
    content_type: string;
    content: string;
  }): Promise<Artifact> {
    const art: Artifact = {
      id: randomUUID(),
      task_id: a.task_id,
      name: a.name,
      content_type: a.content_type,
      content: a.content,
      created_at: new Date().toISOString(),
    };
    this.artifacts.set(art.id, art);
    return art;
  }

  async getArtifact(id: string): Promise<Artifact | undefined> {
    return this.artifacts.get(id);
  }
}

// Backend selection: Postgres when MYCEL_DATABASE_URL is set, else in-memory.
export async function createStore(): Promise<{ store: Store; backend: string }> {
  const url = process.env.MYCEL_DATABASE_URL;
  if (url) {
    const { PostgresStore } = await import("./store.pg");
    const store = await PostgresStore.connect(url);
    return { store, backend: "postgres" };
  }
  return { store: new InMemoryStore(), backend: "memory" };
}
