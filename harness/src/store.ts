// Storage behind an interface so Postgres/SQLite swap in without touching the runtime.
// v0.1 ships an in-memory implementation: zero external services, runs instantly.
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
  createTask(t: Task): Task;
  getTask(id: string): Task | undefined;
  setStatus(id: string, status: TaskStatus): void;
  addCost(id: string, delta: number): void;
  appendEvent(taskId: string, type: EventType, data?: Record<string, unknown>): TaskEvent;
  eventsAfter(taskId: string, afterId: number): TaskEvent[];
  createApproval(a: {
    task_id: string;
    action: string;
    risk: Risk;
    preview: Record<string, unknown>;
    ttlMs?: number;
  }): Approval;
  getApproval(id: string): Approval | undefined;
  setApproval(id: string, status: Approval["status"]): Approval | undefined;
  addArtifact(a: {
    task_id: string;
    name: string;
    content_type: string;
    content: string;
  }): Artifact;
  getArtifact(id: string): Artifact | undefined;
}

export class InMemoryStore implements Store {
  private tasks = new Map<string, Task>();
  private events = new Map<string, TaskEvent[]>();
  private counters = new Map<string, number>();
  private approvals = new Map<string, Approval>();
  private artifacts = new Map<string, Artifact>();

  createTask(t: Task): Task {
    this.tasks.set(t.id, t);
    this.events.set(t.id, []);
    this.counters.set(t.id, 0);
    return t;
  }

  getTask(id: string) {
    return this.tasks.get(id);
  }

  setStatus(id: string, status: TaskStatus) {
    const t = this.tasks.get(id);
    if (t) {
      t.status = status;
      t.updated_at = new Date().toISOString();
    }
  }

  addCost(id: string, delta: number) {
    const t = this.tasks.get(id);
    if (t) {
      t.cost_usd = Math.round((t.cost_usd + delta) * 1e6) / 1e6;
      t.updated_at = new Date().toISOString();
    }
  }

  appendEvent(taskId: string, type: EventType, data: Record<string, unknown> = {}): TaskEvent {
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

  eventsAfter(taskId: string, afterId: number): TaskEvent[] {
    return (this.events.get(taskId) ?? []).filter((e) => e.id > afterId);
  }

  createApproval(a: {
    task_id: string;
    action: string;
    risk: Risk;
    preview: Record<string, unknown>;
    ttlMs?: number;
  }): Approval {
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

  getApproval(id: string) {
    return this.approvals.get(id);
  }

  setApproval(id: string, status: Approval["status"]) {
    const a = this.approvals.get(id);
    if (a) a.status = status;
    return a;
  }

  addArtifact(a: {
    task_id: string;
    name: string;
    content_type: string;
    content: string;
  }): Artifact {
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

  getArtifact(id: string) {
    return this.artifacts.get(id);
  }
}
