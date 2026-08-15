// Durable Postgres backend. One canonical store, raw SQL, created on connect. Selected via
// MYCEL_DATABASE_URL. node-pg parses jsonb columns into JS objects, so rows map cleanly to the
// contract types.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { getPool } from "./pool";
import { withSchemaLock } from "./schema-lock";

/**
 * How long a task must be SILENT before a booting process may declare it dead.
 *
 * Longer than any single model call plus a sandbox cold start, so a slow-but-alive run is never
 * mistaken for an abandoned one. Recovering a live task destroys real work and real spend; leaving
 * a dead one a few minutes longer costs a row that reads `running` for slightly too long. Those are
 * not symmetric, so this errs toward doing nothing.
 */
export const STALE_TASK_MS = Number(process.env.MYCEL_STALE_TASK_MS ?? 10 * 60 * 1000);
import type {
  Approval,
  Artifact,
  EventType,
  Risk,
  Task,
  TaskEvent,
  TaskStatus,
} from "./contract";
import { sizeOf, stripContent } from "./store";
import type { GrantKind, GrantStore, NewArtifact, PolicyCounterStore, PolicyScope, Store } from "./store";

const { Pool } = pg;

export class PostgresStore implements Store {
  private constructor(private pool: pg.Pool) {}

  static async connect(url: string): Promise<PostgresStore> {
    const pool = getPool(url);
    const self = new PostgresStore(pool);
    await self.init();
    return self;
  }

  private async init(): Promise<void> {
      // Serialised across processes: `CREATE TABLE IF NOT EXISTS` is not concurrency-safe, and
      // four kernel containers boot together on every deploy. See schema-lock.ts.
    await withSchemaLock(this.pool, async (client) => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS tasks (
          id uuid PRIMARY KEY,
          project_id text,
          case_id uuid,
          wedge text NOT NULL,
          task_type text NOT NULL,
          actor jsonb NOT NULL DEFAULT '{}',
          input jsonb NOT NULL DEFAULT '{}',
          constraints jsonb NOT NULL DEFAULT '{}',
          tools jsonb NOT NULL DEFAULT '[]',
          output_schema jsonb,
          status text NOT NULL DEFAULT 'queued',
          error text,
          cost_usd numeric NOT NULL DEFAULT 0,
          event_seq int NOT NULL DEFAULT 0,
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
          policy_reason text,
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
      // Idempotent migrations for pre-existing installs.
      await client.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS error text;`);
      await client.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS event_seq int NOT NULL DEFAULT 0;`);
      await client.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS project_id text;`);
      await client.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS case_id uuid;`);
      // Phase-1 routing columns: which customer the work is for, which surface it came in on, who
      // owns the next move, and how sure the agent was. Nullable and additive, so every existing
      // row stays valid and reads as "unknown" rather than as a wrong default.
      await client.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS client_id text;`);
      await client.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS source text;`);
      await client.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS assigned_to text;`);
      await client.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS confidence_score double precision;`);
      await client.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS batch_id text;`);
      await client.query(`CREATE INDEX IF NOT EXISTS tasks_batch_idx ON tasks (batch_id) WHERE batch_id IS NOT NULL;`);
      await client.query(`CREATE INDEX IF NOT EXISTS tasks_client_idx ON tasks (client_id);`);
      // Uploads. Additive so an existing install keeps every artifact it already has, and the
      // defaults are what those rows always were: agent-written UTF-8 text.
      await client.query(`
        ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS encoding text NOT NULL DEFAULT 'utf8';
        ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS size_bytes bigint;
        ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'agent';
        ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS client_id text;
        ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS uploaded_by text;
        CREATE INDEX IF NOT EXISTS artifacts_task_idx ON artifacts (task_id);
      `);
      await client.query(`ALTER TABLE approvals ADD COLUMN IF NOT EXISTS policy_reason text;`);
      // Additive migrations, so an existing deployment keeps its approvals. Rows that predate this
      // simply have a null created_at and are excluded from the latency stat rather than skewing it.
      await client.query(`ALTER TABLE approvals ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();`);
      await client.query(`ALTER TABLE approvals ADD COLUMN IF NOT EXISTS decided_at timestamptz;`);
    });
  }

  private rowToTask(r: any): Task {
    return {
      id: r.id,
      project_id: r.project_id ?? undefined,
      case_id: r.case_id ?? undefined,
      batch_id: r.batch_id ?? undefined,
      client_id: r.client_id ?? undefined,
      source: r.source ?? undefined,
      assigned_to: r.assigned_to ?? undefined,
      // pg returns double precision as a number already, but null must stay null rather than
      // becoming 0 — "no confidence reported" and "zero confidence" are different answers.
      confidence_score: r.confidence_score === null || r.confidence_score === undefined ? undefined : Number(r.confidence_score),
      wedge: r.wedge,
      task_type: r.task_type,
      actor: r.actor,
      input: r.input,
      constraints: r.constraints,
      tools: r.tools ?? [],
      output_schema: r.output_schema ?? undefined,
      status: r.status,
      error: r.error ?? undefined,
      cost_usd: Number(r.cost_usd),
      created_at: new Date(r.created_at).toISOString(),
      updated_at: new Date(r.updated_at).toISOString(),
    };
  }

  async createTask(t: Task): Promise<Task> {
    await this.pool.query(
      `INSERT INTO tasks (id, project_id, case_id, client_id, source, assigned_to, confidence_score, batch_id, wedge, task_type, actor, input, constraints, tools, output_schema, status, cost_usd, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [
        t.id,
        t.project_id ?? null,
        t.case_id ?? null,
        t.client_id ?? null,
        t.source ?? null,
        t.assigned_to ?? null,
        t.confidence_score ?? null,
        t.batch_id ?? null,
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

  async listTasks(
    filter: { status?: TaskStatus; wedge?: string; client_id?: string; limit?: number } = {},
  ): Promise<Task[]> {
    const where: string[] = [];
    const vals: unknown[] = [];
    if (filter.status) { vals.push(filter.status); where.push(`status=$${vals.length}`); }
    if (filter.wedge) { vals.push(filter.wedge); where.push(`wedge=$${vals.length}`); }
    if (filter.client_id) { vals.push(filter.client_id); where.push(`client_id=$${vals.length}`); }
    vals.push(filter.limit ?? 100);
    const sql =
      `SELECT * FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""} ` +
      `ORDER BY created_at DESC LIMIT $${vals.length}`;
    const r = await this.pool.query(sql, vals);
    return r.rows.map((row: any) => this.rowToTask(row));
  }

  async setStatus(id: string, status: TaskStatus, error?: string): Promise<void> {
    if (error !== undefined) {
      await this.pool.query(
        `UPDATE tasks SET status=$2, error=$3, updated_at=now() WHERE id=$1`,
        [id, status, error],
      );
    } else {
      await this.pool.query(`UPDATE tasks SET status=$2, updated_at=now() WHERE id=$1`, [id, status]);
    }
  }

  async updateTask(
    id: string,
    patch: Partial<Pick<Task, "assigned_to" | "confidence_score" | "source" | "client_id" | "case_id" | "batch_id">>,
  ): Promise<Task | undefined> {
    // Built column by column rather than with COALESCE, because COALESCE cannot express "set this
    // to NULL" — and clearing a client link or a confidence score is a legitimate patch.
    const sets: string[] = [];
    const vals: unknown[] = [];
    const set = (col: string, val: unknown) => {
      vals.push(val);
      sets.push(`${col}=$${vals.length}`);
    };
    if (patch.assigned_to !== undefined) set("assigned_to", patch.assigned_to);
    if ("confidence_score" in patch) set("confidence_score", patch.confidence_score ?? null);
    if (patch.source !== undefined) set("source", patch.source);
    if ("client_id" in patch) set("client_id", patch.client_id ?? null);
    if ("case_id" in patch) set("case_id", patch.case_id ?? null);
    if ("batch_id" in patch) set("batch_id", patch.batch_id ?? null);
    if (!sets.length) return this.getTask(id);
    vals.push(id);
    await this.pool.query(
      `UPDATE tasks SET ${sets.join(", ")}, updated_at=now() WHERE id=$${vals.length}`,
      vals,
    );
    return this.getTask(id);
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
    // Atomic per-task sequence: bump a counter on the task row (which takes a row lock, so
    // concurrent appends serialize) and use the returned value as seq. No MAX()+1 race, no
    // duplicate-seq PK violation, no dropped event.
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const s = await client.query(
        `UPDATE tasks SET event_seq = event_seq + 1 WHERE id=$1 RETURNING event_seq`,
        [taskId],
      );
      if (!s.rows[0]) throw new Error(`appendEvent: unknown task ${taskId}`);
      const seq: number = s.rows[0].event_seq;
      const r = await client.query(
        `INSERT INTO events (task_id, seq, type, data) VALUES ($1,$2,$3,$4) RETURNING ts`,
        [taskId, seq, type, JSON.stringify(data)],
      );
      await client.query("COMMIT");
      return { id: seq, task_id: taskId, seq, type, ts: new Date(r.rows[0].ts).toISOString(), data };
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
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
      created_at: new Date().toISOString(),
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
      policy_reason: r.policy_reason ?? undefined,
      expires_at: r.expires_at ? new Date(r.expires_at).toISOString() : "",
      created_at: r.created_at ? new Date(r.created_at).toISOString() : "",
      decided_at: r.decided_at ? new Date(r.decided_at).toISOString() : undefined,
    };
  }

  async getApproval(id: string): Promise<Approval | undefined> {
    const r = await this.pool.query(`SELECT * FROM approvals WHERE approval_id=$1`, [id]);
    return r.rows[0] ? this.rowToApproval(r.rows[0]) : undefined;
  }

  async setApproval(id: string, status: Approval["status"], policyReason?: string): Promise<Approval | undefined> {
    const r = await this.pool.query(
      `UPDATE approvals SET status=$2, policy_reason=COALESCE($3, policy_reason), decided_at=now() WHERE approval_id=$1 RETURNING *`,
      [id, status, policyReason ?? null],
    );
    return r.rows[0] ? this.rowToApproval(r.rows[0]) : undefined;
  }

  async listApprovals(status?: Approval["status"]): Promise<Approval[]> {
    const r = status
      ? await this.pool.query(`SELECT * FROM approvals WHERE status=$1 ORDER BY expires_at`, [status])
      : await this.pool.query(`SELECT * FROM approvals ORDER BY expires_at`);
    return r.rows.map((row: any) => this.rowToApproval(row));
  }

  async addArtifact(a: NewArtifact): Promise<Artifact> {
    const art: Artifact = {
      ...a,
      id: crypto.randomUUID(),
      created_at: new Date().toISOString(),
      size_bytes: a.size_bytes ?? sizeOf(a),
    };
    await this.pool.query(
      `INSERT INTO artifacts (id, task_id, name, content_type, content, encoding, size_bytes, source, client_id, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        art.id, art.task_id, art.name, art.content_type, art.content,
        art.encoding ?? "utf8", art.size_bytes ?? sizeOf(art),
        art.source ?? "agent", art.client_id ?? null, art.uploaded_by ?? null,
      ],
    );
    return art;
  }

  async getArtifact(id: string): Promise<Artifact | undefined> {
    const r = await this.pool.query(`SELECT * FROM artifacts WHERE id=$1`, [id]);
    const row = r.rows[0];
    return row ? this.rowToArtifact(row) : undefined;
  }

  async listArtifacts(taskId: string): Promise<Omit<Artifact, "content">[]> {
    // Content is excluded in SQL, not stripped afterwards: reading a 30MB column out of the
    // database and throwing it away is the same cost as serving it.
    const r = await this.pool.query(
      `SELECT id, task_id, name, content_type, created_at, encoding, size_bytes, source, client_id, uploaded_by
       FROM artifacts WHERE task_id=$1 ORDER BY created_at`,
      [taskId],
    );
    return r.rows.map((row: any) => stripContent(this.rowToArtifact({ ...row, content: "" })));
  }

  async listArtifactsForTasks(taskIds: string[]): Promise<Omit<Artifact, "content">[]> {
    // An empty list must not become an unfiltered scan of every artifact in the database.
    if (!taskIds.length) return [];
    const r = await this.pool.query(
      `SELECT id, task_id, name, content_type, created_at, encoding, size_bytes, source, client_id, uploaded_by
       FROM artifacts WHERE task_id = ANY($1::uuid[]) ORDER BY created_at DESC`,
      [taskIds],
    );
    return r.rows.map((row: any) => stripContent(this.rowToArtifact({ ...row, content: "" })));
  }

  private rowToArtifact(row: any): Artifact {
    return {
      id: row.id,
      task_id: row.task_id,
      name: row.name,
      content_type: row.content_type,
      content: row.content ?? "",
      created_at: new Date(row.created_at).toISOString(),
      encoding: (row.encoding ?? "utf8") as Artifact["encoding"],
      size_bytes: row.size_bytes === null || row.size_bytes === undefined ? undefined : Number(row.size_bytes),
      source: (row.source ?? "agent") as Artifact["source"],
      client_id: row.client_id ?? undefined,
      uploaded_by: row.uploaded_by ?? undefined,
    };
  }

  async countTasksSince(projectIds: string[], sinceIso: string): Promise<number> {
    if (!projectIds.length) return 0;
    // `= ANY($1)` rather than a built IN list: one plan, one parameter, and no statement whose
    // shape changes with the number of projects a member happens to own.
    const r = await this.pool.query(
      `SELECT count(*)::int AS n FROM tasks WHERE project_id = ANY($1) AND created_at >= $2`,
      [projectIds, sinceIso],
    );
    return r.rows[0]?.n ?? 0;
  }

  async sumCostSince(projectIds: string[], sinceIso: string): Promise<number> {
    if (!projectIds.length) return 0;
    const r = await this.pool.query(
      `SELECT COALESCE(sum(cost_usd), 0)::float8 AS n FROM tasks WHERE project_id = ANY($1) AND created_at >= $2`,
      [projectIds, sinceIso],
    );
    return Number((r.rows[0]?.n ?? 0).toFixed(4));
  }

  /**
   * Tasks that look abandoned — non-terminal AND silent for `staleAfterMs`.
   *
   * The silence check is the whole point. This used to return every non-terminal task, and
   * `recoverTasks` marks each one failed on boot. That is correct for a single-process kernel, where
   * a restart really does destroy the only sandbox. It is catastrophic for this deployment: with two
   * API replicas and two workers, ANY container booting killed every run in flight across the entire
   * fleet — a rolling deploy, a scale-up, or one ECS health check restarting one task, and every
   * customer's work died with `interrupted by a restart`. Across tenants.
   *
   * A live run is noisy: `token.delta`, `tool.called`, `cost.charged` land continuously, and each
   * bumps `updated_at`. So "no write for several minutes" separates a run whose process is gone from
   * one another replica is still driving, without needing a lease column, a heartbeat, or an owner
   * id — none of which exist, and all of which would need a migration to add.
   *
   * The window is deliberately generous. Recovering a live task destroys real work and real spend;
   * leaving a dead one for a few more minutes costs a row that says `running` slightly too long.
   * Those are not symmetric, so the default errs toward doing nothing.
   */
  async listUnfinished(staleAfterMs = STALE_TASK_MS): Promise<Task[]> {
    const r = await this.pool.query(
      `SELECT * FROM tasks
        WHERE status NOT IN ('succeeded','failed','rejected','expired','cancelled')
          AND updated_at < now() - ($1::int * interval '1 millisecond')`,
      [staleAfterMs],
    );
    return r.rows.map((row: any) => this.rowToTask(row));
  }

  async close(): Promise<void> {
    // No-op: the pool is shared process-wide. See pool.ts — the first store to end
    // it would close the connections every other store is still using. Shutdown calls
    // closeAllPools() once.
  }
}

/**
 * Grants, in Postgres, so a nonce minted by a worker validates on an API replica.
 *
 * The row is short-lived by construction: `expires_at` is set at mint time and is part of every
 * lookup's WHERE clause, so an expired grant is refused by the QUERY. The sweep below only reclaims
 * space — if it never ran, nothing would authorise that should not. The other way round (a sweeper
 * that must be on time for the security property to hold) is the bug this design avoids.
 */
export class PostgresGrantStore implements GrantStore {
  readonly durable = true;
  private lastSweep = 0;

  private constructor(private pool: pg.Pool) {}

  static async connect(url: string): Promise<PostgresGrantStore> {
    const pool = getPool(url);
    const self = new PostgresGrantStore(pool);
    await self.init();
    return self;
  }

  private async init(): Promise<void> {
    // Same reason as every other init here: four kernels boot together on a deploy and
    // `CREATE TABLE IF NOT EXISTS` is not concurrency-safe. See schema-lock.ts.
    await withSchemaLock(this.pool, async (client) => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS grants (
          kind text NOT NULL,
          nonce text NOT NULL,
          payload jsonb NOT NULL DEFAULT '{}',
          expires_at timestamptz NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (kind, nonce)
        );
      `);
      // The lookup is the hot path — every model call in proxy mode presents a grant — so it must
      // be an index probe on the primary key and nothing else. (kind, nonce) is the PK, both are
      // supplied, so this is a single unique-index lookup, not a scan with a filter.
      await client.query(`ALTER TABLE grants ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();`);
      // Only for the sweep. Nothing on the hot path uses it.
      await client.query(`CREATE INDEX IF NOT EXISTS grants_expiry_idx ON grants (expires_at);`);
    });
  }

  async put(kind: GrantKind, nonce: string, payload: Record<string, unknown>, expiresAt: Date): Promise<void> {
    await this.pool.query(
      `INSERT INTO grants (kind, nonce, payload, expires_at) VALUES ($1,$2,$3,$4)
       ON CONFLICT (kind, nonce) DO UPDATE SET payload=EXCLUDED.payload, expires_at=EXCLUDED.expires_at`,
      [kind, nonce, JSON.stringify(payload), expiresAt.toISOString()],
    );
    void this.maybeSweep();
  }

  async get(kind: GrantKind, nonce: string): Promise<Record<string, unknown> | undefined> {
    // `expires_at > now()` is in the query, not in JavaScript, and not delegated to the sweeper:
    // the clock that decides whether a capability is still live is the database's, shared by every
    // replica, and it is consulted on the same round trip that fetches the row.
    const r = await this.pool.query(
      `SELECT payload FROM grants WHERE kind=$1 AND nonce=$2 AND expires_at > now()`,
      [kind, nonce],
    );
    return r.rows[0]?.payload ?? undefined;
  }

  async del(kind: GrantKind, nonce: string): Promise<void> {
    await this.pool.query(`DELETE FROM grants WHERE kind=$1 AND nonce=$2`, [kind, nonce]);
  }

  /**
   * Reclaim expired rows. Throttled per process, fired off a write, and its failure is ignored —
   * it is housekeeping, not enforcement. No `setInterval`: a timer in a module every test imports
   * keeps the event loop alive and turns a passing suite into one that never exits.
   */
  private async maybeSweep(): Promise<void> {
    const now = Date.now();
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    await this.pool.query(`DELETE FROM grants WHERE expires_at <= now() - interval '1 hour'`).catch(() => {});
  }

  async close(): Promise<void> {
    // No-op — the pool is shared. See pool.ts.
  }
}

/**
 * Policy counters, in Postgres, incremented atomically.
 *
 * The ceiling is the point. Two API replicas and two workers each counting to 40 in their own heap
 * is a `max_per_day: 40` envelope that permits 160 — a security control that fails open by four
 * times, silently, and only in production.
 */
export class PostgresPolicyCounters implements PolicyCounterStore {
  private lastSweep = 0;

  private constructor(private pool: pg.Pool) {}

  static async connect(url: string): Promise<PostgresPolicyCounters> {
    const pool = getPool(url);
    const self = new PostgresPolicyCounters(pool);
    await self.init();
    return self;
  }

  private async init(): Promise<void> {
    await withSchemaLock(this.pool, async (client) => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS policy_counters (
          project_id text NOT NULL,
          scope text NOT NULL,
          key text NOT NULL,
          n int NOT NULL DEFAULT 0,
          expires_at timestamptz NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (project_id, scope, key)
        );
      `);
      await client.query(`ALTER TABLE policy_counters ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();`);
      await client.query(`CREATE INDEX IF NOT EXISTS policy_counters_expiry_idx ON policy_counters (expires_at);`);
    });
  }

  async peek(projectId: string, scope: PolicyScope, key: string): Promise<number> {
    // `project_id` is NOT NULL and carries a "-" sentinel for "no project" rather than a NULL,
    // because tenant scoping in this codebase fails CLOSED: `project_id=$1` never matches NULL, so
    // an unscoped counter stored as NULL would read as zero forever and the ceiling would vanish.
    const r = await this.pool.query(
      `SELECT n FROM policy_counters WHERE project_id=$1 AND scope=$2 AND key=$3 AND expires_at > now()`,
      [projectId, scope, key],
    );
    return r.rows[0]?.n ?? 0;
  }

  async bump(projectId: string, scope: PolicyScope, key: string, expiresAt: Date): Promise<number> {
    // One statement, and every written value is computed from the row's OWN current value
    // (`policy_counters.n + 1`) — the rule `bumpPacing` in domain.pg.ts establishes. `ON CONFLICT
    // DO UPDATE` takes the row lock and, under READ COMMITTED, re-reads the winner's committed row
    // before evaluating the SET, so two replicas incrementing at the same instant produce n and
    // n+1. A SELECT followed by an UPDATE would lose one of them.
    const r = await this.pool.query(
      `INSERT INTO policy_counters (project_id, scope, key, n, expires_at)
       VALUES ($1,$2,$3,1,$4)
       ON CONFLICT (project_id, scope, key) DO UPDATE SET
         -- An expired row is a new window, not a continuation: reset to 1 and re-stamp the expiry.
         n = CASE WHEN policy_counters.expires_at <= now() THEN 1 ELSE policy_counters.n + 1 END,
         expires_at = CASE WHEN policy_counters.expires_at <= now() THEN EXCLUDED.expires_at
                           ELSE policy_counters.expires_at END
       RETURNING n`,
      [projectId, scope, key, expiresAt.toISOString()],
    );
    void this.maybeSweep();
    return r.rows[0].n;
  }

  private async maybeSweep(): Promise<void> {
    const now = Date.now();
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    // A day behind the expiry, so a counter is never reclaimed while anything could still be
    // reasoning about it. Housekeeping only — `peek`/`bump` already ignore expired rows.
    await this.pool
      .query(`DELETE FROM policy_counters WHERE expires_at <= now() - interval '1 day'`)
      .catch(() => {});
  }

  async close(): Promise<void> {
    // No-op — the pool is shared. See pool.ts.
  }
}
