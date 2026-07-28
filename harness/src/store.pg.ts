// Durable Postgres backend. One canonical store, raw SQL, created on connect. Selected via
// MYCEL_DATABASE_URL. node-pg parses jsonb columns into JS objects, so rows map cleanly to the
// contract types.
import { randomUUID } from "node:crypto";
import pg from "pg";
import type {
  Approval,
  Artifact,
  EventType,
  Risk,
  Task,
  TaskEvent,
  TaskStatus,
} from "./contract";
import type { Store } from "./store";

const { Pool } = pg;

export class PostgresStore implements Store {
  private constructor(private pool: pg.Pool) {}

  static async connect(url: string): Promise<PostgresStore> {
    const pool = new Pool({ connectionString: url });
    const self = new PostgresStore(pool);
    await self.init();
    return self;
  }

  private async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS tasks (
        id uuid PRIMARY KEY,
        wedge text NOT NULL,
        task_type text NOT NULL,
        actor jsonb NOT NULL DEFAULT '{}',
        input jsonb NOT NULL DEFAULT '{}',
        constraints jsonb NOT NULL DEFAULT '{}',
        tools jsonb NOT NULL DEFAULT '[]',
        output_schema jsonb,
        status text NOT NULL DEFAULT 'queued',
        cost_usd numeric NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS events (
        task_id uuid NOT NULL REFERENCES tasks(id),
        seq int NOT NULL,
        type text NOT NULL,
        data jsonb NOT NULL DEFAULT '{}',
        ts timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (task_id, seq)
      );
      CREATE TABLE IF NOT EXISTS approvals (
        approval_id uuid PRIMARY KEY,
        task_id uuid NOT NULL REFERENCES tasks(id),
        action text NOT NULL,
        risk text NOT NULL DEFAULT 'medium',
        preview jsonb NOT NULL DEFAULT '{}',
        status text NOT NULL DEFAULT 'pending',
        expires_at timestamptz
      );
      CREATE TABLE IF NOT EXISTS artifacts (
        id uuid PRIMARY KEY,
        task_id uuid NOT NULL REFERENCES tasks(id),
        name text NOT NULL,
        content_type text NOT NULL DEFAULT 'application/json',
        content text NOT NULL DEFAULT '',
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
  }

  private rowToTask(r: any): Task {
    return {
      id: r.id,
      wedge: r.wedge,
      task_type: r.task_type,
      actor: r.actor,
      input: r.input,
      constraints: r.constraints,
      tools: r.tools ?? [],
      output_schema: r.output_schema ?? undefined,
      status: r.status,
      cost_usd: Number(r.cost_usd),
      created_at: new Date(r.created_at).toISOString(),
      updated_at: new Date(r.updated_at).toISOString(),
    };
  }

  async createTask(t: Task): Promise<Task> {
    await this.pool.query(
      `INSERT INTO tasks (id, wedge, task_type, actor, input, constraints, tools, output_schema, status, cost_usd, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        t.id,
        t.wedge,
        t.task_type,
        JSON.stringify(t.actor),
        JSON.stringify(t.input),
        JSON.stringify(t.constraints),
        JSON.stringify(t.tools),
        t.output_schema === undefined ? null : JSON.stringify(t.output_schema),
        t.status,
        t.cost_usd,
        t.created_at,
        t.updated_at,
      ],
    );
    return t;
  }

  async getTask(id: string): Promise<Task | undefined> {
    const r = await this.pool.query(`SELECT * FROM tasks WHERE id=$1`, [id]);
    return r.rows[0] ? this.rowToTask(r.rows[0]) : undefined;
  }

  async setStatus(id: string, status: TaskStatus): Promise<void> {
    await this.pool.query(`UPDATE tasks SET status=$2, updated_at=now() WHERE id=$1`, [id, status]);
  }

  async addCost(id: string, delta: number): Promise<void> {
    await this.pool.query(`UPDATE tasks SET cost_usd = cost_usd + $2, updated_at=now() WHERE id=$1`, [
      id,
      delta,
    ]);
  }

  async appendEvent(
    taskId: string,
    type: EventType,
    data: Record<string, unknown> = {},
  ): Promise<TaskEvent> {
    const r = await this.pool.query(
      `INSERT INTO events (task_id, seq, type, data)
       VALUES ($1, (SELECT COALESCE(MAX(seq),0)+1 FROM events WHERE task_id=$1), $2, $3)
       RETURNING seq, ts`,
      [taskId, type, JSON.stringify(data)],
    );
    const row = r.rows[0];
    return {
      id: row.seq,
      task_id: taskId,
      seq: row.seq,
      type,
      ts: new Date(row.ts).toISOString(),
      data,
    };
  }

  async eventsAfter(taskId: string, afterId: number): Promise<TaskEvent[]> {
    const r = await this.pool.query(
      `SELECT seq, type, data, ts FROM events WHERE task_id=$1 AND seq > $2 ORDER BY seq`,
      [taskId, afterId],
    );
    return r.rows.map((row: any) => ({
      id: row.seq,
      task_id: taskId,
      seq: row.seq,
      type: row.type as EventType,
      ts: new Date(row.ts).toISOString(),
      data: row.data,
    }));
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
    await this.pool.query(
      `INSERT INTO approvals (approval_id, task_id, action, risk, preview, status, expires_at)
       VALUES ($1,$2,$3,$4,$5,'pending',$6)`,
      [
        approval.approval_id,
        approval.task_id,
        approval.action,
        approval.risk,
        JSON.stringify(approval.preview),
        approval.expires_at,
      ],
    );
    return approval;
  }

  private rowToApproval(r: any): Approval {
    return {
      approval_id: r.approval_id,
      task_id: r.task_id,
      action: r.action,
      risk: r.risk,
      preview: r.preview,
      status: r.status,
      expires_at: r.expires_at ? new Date(r.expires_at).toISOString() : "",
    };
  }

  async getApproval(id: string): Promise<Approval | undefined> {
    const r = await this.pool.query(`SELECT * FROM approvals WHERE approval_id=$1`, [id]);
    return r.rows[0] ? this.rowToApproval(r.rows[0]) : undefined;
  }

  async setApproval(id: string, status: Approval["status"]): Promise<Approval | undefined> {
    const r = await this.pool.query(
      `UPDATE approvals SET status=$2 WHERE approval_id=$1 RETURNING *`,
      [id, status],
    );
    return r.rows[0] ? this.rowToApproval(r.rows[0]) : undefined;
  }

  async addArtifact(a: {
    task_id: string;
    name: string;
    content_type: string;
    content: string;
  }): Promise<Artifact> {
    const art: Artifact = {
      id: crypto.randomUUID(),
      task_id: a.task_id,
      name: a.name,
      content_type: a.content_type,
      content: a.content,
      created_at: new Date().toISOString(),
    };
    await this.pool.query(
      `INSERT INTO artifacts (id, task_id, name, content_type, content) VALUES ($1,$2,$3,$4,$5)`,
      [art.id, art.task_id, art.name, art.content_type, art.content],
    );
    return art;
  }

  async getArtifact(id: string): Promise<Artifact | undefined> {
    const r = await this.pool.query(`SELECT * FROM artifacts WHERE id=$1`, [id]);
    const row = r.rows[0];
    if (!row) return undefined;
    return {
      id: row.id,
      task_id: row.task_id,
      name: row.name,
      content_type: row.content_type,
      content: row.content,
      created_at: new Date(row.created_at).toISOString(),
    };
  }

  async listUnfinished(): Promise<Task[]> {
    const r = await this.pool.query(
      `SELECT * FROM tasks WHERE status NOT IN ('succeeded','failed','rejected','expired','cancelled')`,
    );
    return r.rows.map((row: any) => this.rowToTask(row));
  }
}
