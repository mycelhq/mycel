// Durable Postgres backing for the service surface (clients, connections, channels, threads,
// messages, knowledge). Mirrors store.pg.ts: raw SQL, tables created on connect, jsonb columns
// parsed by node-pg. Selected automatically when MYCEL_DATABASE_URL is set.
import { randomUUID } from "node:crypto";
import pg from "pg";
import type { Cadence, Case, CaseEvent, Record_, Channel, Client, Connection, ConnectionKind, ConnectionOwner, KnowledgeItem, Message, Schedule, Thread } from "./contract";
import { normalizeHandle, type DomainStore } from "./domain";

const { Pool } = pg;
const iso = (v: unknown) => new Date(v as string).toISOString();

export class PostgresDomainStore implements DomainStore {
  private constructor(private pool: pg.Pool) {}

  static async connect(url: string): Promise<PostgresDomainStore> {
    const pool = new Pool({ connectionString: url });
    const self = new PostgresDomainStore(pool);
    await self.init();
    return self;
  }

  private async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS connections (
        id uuid PRIMARY KEY,
        project_id text,
        kind text NOT NULL,
        name text NOT NULL,
        owner jsonb NOT NULL DEFAULT '{}',
        config jsonb NOT NULL DEFAULT '{}',
        secret_ref text,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS channels (
        id uuid PRIMARY KEY,
        project_id text,
        connection_id uuid NOT NULL,
        kind text NOT NULL,
        address text NOT NULL,
        wedge text NOT NULL,
        task_type text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS clients (
        id uuid PRIMARY KEY,
        project_id text,
        display_name text,
        handles jsonb NOT NULL DEFAULT '[]',
        metadata jsonb NOT NULL DEFAULT '{}',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS threads (
        id uuid PRIMARY KEY,
        project_id text,
        client_id uuid NOT NULL,
        channel_id uuid NOT NULL,
        subject text,
        status text NOT NULL DEFAULT 'open',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS messages (
        id uuid PRIMARY KEY,
        thread_id uuid NOT NULL,
        direction text NOT NULL,
        author text NOT NULL,
        body text NOT NULL DEFAULT '',
        status text,
        task_id uuid,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS messages_thread_idx ON messages (thread_id, created_at);
      CREATE TABLE IF NOT EXISTS knowledge (
        id uuid PRIMARY KEY,
        project_id text,
        wedge text NOT NULL,
        name text NOT NULL,
        content text NOT NULL DEFAULT '',
        kind text NOT NULL DEFAULT 'document',
        source text NOT NULL DEFAULT 'uploaded',
        metadata jsonb NOT NULL DEFAULT '{}',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS knowledge_wedge_idx ON knowledge (wedge);
      CREATE TABLE IF NOT EXISTS schedules (
        id uuid PRIMARY KEY,
        project_id text,
        name text NOT NULL,
        wedge text NOT NULL,
        task_type text NOT NULL,
        input jsonb NOT NULL DEFAULT '{}',
        cadence jsonb NOT NULL,
        enabled boolean NOT NULL DEFAULT true,
        next_run_at timestamptz NOT NULL,
        last_run_at timestamptz,
        last_task_id uuid,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS schedules_due_idx ON schedules (enabled, next_run_at);
      CREATE TABLE IF NOT EXISTS cases (
        id uuid PRIMARY KEY,
        project_id text,
        wedge text NOT NULL,
        title text NOT NULL,
        client_id uuid,
        stage text NOT NULL,
        status text NOT NULL DEFAULT 'open',
        data jsonb NOT NULL DEFAULT '{}',
        due_at timestamptz,
        history jsonb NOT NULL DEFAULT '[]',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        closed_at timestamptz
      );
      CREATE INDEX IF NOT EXISTS cases_lookup_idx ON cases (wedge, status);
      CREATE TABLE IF NOT EXISTS records (
        id uuid PRIMARY KEY,
        project_id text,
        wedge text NOT NULL,
        collection text NOT NULL,
        key text NOT NULL,
        data jsonb NOT NULL DEFAULT '{}',
        case_id uuid,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      -- the natural key: re-ingesting the same transaction updates it, never double-posts
      CREATE UNIQUE INDEX IF NOT EXISTS records_natural_key
        ON records (COALESCE(project_id,'-'), wedge, collection, key);
      CREATE INDEX IF NOT EXISTS records_query_idx ON records (wedge, collection);
      CREATE INDEX IF NOT EXISTS records_data_idx ON records USING gin (data);
    `);
  }

  // ── connections ──
  private toConn = (r: any): Connection => ({
    id: r.id, project_id: r.project_id ?? undefined, kind: r.kind as ConnectionKind, name: r.name,
    owner: r.owner as ConnectionOwner, config: r.config, secret_ref: r.secret_ref ?? undefined,
    created_at: iso(r.created_at),
  });

  async createConnection(c: Omit<Connection, "id" | "created_at">): Promise<Connection> {
    const r = await this.pool.query(
      `INSERT INTO connections (id, project_id, kind, name, owner, config, secret_ref)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [randomUUID(), c.project_id ?? null, c.kind, c.name, JSON.stringify(c.owner), JSON.stringify(c.config ?? {}), c.secret_ref ?? null],
    );
    return this.toConn(r.rows[0]);
  }
  async getConnection(id: string): Promise<Connection | undefined> {
    const r = await this.pool.query(`SELECT * FROM connections WHERE id=$1`, [id]);
    return r.rows[0] ? this.toConn(r.rows[0]) : undefined;
  }
  async listConnections(): Promise<Connection[]> {
    const r = await this.pool.query(`SELECT * FROM connections ORDER BY created_at`);
    return r.rows.map(this.toConn);
  }

  // ── channels ──
  private toChan = (r: any): Channel => ({
    id: r.id, project_id: r.project_id ?? undefined, connection_id: r.connection_id, kind: r.kind as ConnectionKind,
    address: r.address, wedge: r.wedge, task_type: r.task_type, created_at: iso(r.created_at),
  });
  async createChannel(c: Omit<Channel, "id" | "created_at">): Promise<Channel> {
    const r = await this.pool.query(
      `INSERT INTO channels (id, project_id, connection_id, kind, address, wedge, task_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [randomUUID(), c.project_id ?? null, c.connection_id, c.kind, c.address, c.wedge, c.task_type],
    );
    return this.toChan(r.rows[0]);
  }
  async getChannel(id: string): Promise<Channel | undefined> {
    const r = await this.pool.query(`SELECT * FROM channels WHERE id=$1`, [id]);
    return r.rows[0] ? this.toChan(r.rows[0]) : undefined;
  }
  async listChannels(): Promise<Channel[]> {
    const r = await this.pool.query(`SELECT * FROM channels ORDER BY created_at`);
    return r.rows.map(this.toChan);
  }

  // ── clients ──
  private toClient = (r: any): Client => ({
    id: r.id, project_id: r.project_id ?? undefined, display_name: r.display_name ?? undefined,
    handles: r.handles ?? [], metadata: r.metadata ?? {}, created_at: iso(r.created_at), updated_at: iso(r.updated_at),
  });
  async createClient(c: Omit<Client, "id" | "created_at" | "updated_at">): Promise<Client> {
    const handles = (c.handles ?? []).map(normalizeHandle);
    const r = await this.pool.query(
      `INSERT INTO clients (id, project_id, display_name, handles, metadata) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [randomUUID(), c.project_id ?? null, c.display_name ?? null, JSON.stringify(handles), JSON.stringify(c.metadata ?? {})],
    );
    return this.toClient(r.rows[0]);
  }
  async getClient(id: string): Promise<Client | undefined> {
    const r = await this.pool.query(`SELECT * FROM clients WHERE id=$1`, [id]);
    return r.rows[0] ? this.toClient(r.rows[0]) : undefined;
  }
  async listClients(): Promise<Client[]> {
    const r = await this.pool.query(`SELECT * FROM clients ORDER BY created_at`);
    return r.rows.map(this.toClient);
  }
  async findClientByHandle(handle: string): Promise<Client | undefined> {
    const r = await this.pool.query(`SELECT * FROM clients WHERE handles @> $1::jsonb LIMIT 1`, [JSON.stringify([normalizeHandle(handle)])]);
    return r.rows[0] ? this.toClient(r.rows[0]) : undefined;
  }

  // ── threads + messages ──
  private toThread = (r: any): Thread => ({
    id: r.id, project_id: r.project_id ?? undefined, client_id: r.client_id, channel_id: r.channel_id,
    subject: r.subject ?? undefined, status: r.status, created_at: iso(r.created_at), updated_at: iso(r.updated_at),
  });
  async createThread(t: Omit<Thread, "id" | "created_at" | "updated_at">): Promise<Thread> {
    const r = await this.pool.query(
      `INSERT INTO threads (id, project_id, client_id, channel_id, subject, status) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [randomUUID(), t.project_id ?? null, t.client_id, t.channel_id, t.subject ?? null, t.status ?? "open"],
    );
    return this.toThread(r.rows[0]);
  }
  async getThread(id: string): Promise<Thread | undefined> {
    const r = await this.pool.query(`SELECT * FROM threads WHERE id=$1`, [id]);
    return r.rows[0] ? this.toThread(r.rows[0]) : undefined;
  }
  async findOrCreateThread(clientId: string, channelId: string, projectId?: string, subject?: string): Promise<Thread> {
    const r = await this.pool.query(
      `SELECT * FROM threads WHERE client_id=$1 AND channel_id=$2 AND status='open' ORDER BY created_at LIMIT 1`,
      [clientId, channelId],
    );
    if (r.rows[0]) return this.toThread(r.rows[0]);
    return this.createThread({ project_id: projectId, client_id: clientId, channel_id: channelId, subject, status: "open" });
  }
  async listThreadsForClient(clientId: string): Promise<Thread[]> {
    const r = await this.pool.query(`SELECT * FROM threads WHERE client_id=$1 ORDER BY created_at`, [clientId]);
    return r.rows.map(this.toThread);
  }
  async addMessage(m: Omit<Message, "id" | "created_at">): Promise<Message> {
    const r = await this.pool.query(
      `INSERT INTO messages (id, thread_id, direction, author, body, status, task_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [randomUUID(), m.thread_id, m.direction, m.author, m.body ?? "", m.status ?? null, m.task_id ?? null],
    );
    await this.pool.query(`UPDATE threads SET updated_at=now() WHERE id=$1`, [m.thread_id]);
    const row = r.rows[0];
    return {
      id: row.id, thread_id: row.thread_id, direction: row.direction, author: row.author, body: row.body,
      status: row.status ?? undefined, task_id: row.task_id ?? undefined, created_at: iso(row.created_at),
    };
  }
  async listMessages(threadId: string): Promise<Message[]> {
    const r = await this.pool.query(`SELECT * FROM messages WHERE thread_id=$1 ORDER BY created_at`, [threadId]);
    return r.rows.map((row: any) => ({
      id: row.id, thread_id: row.thread_id, direction: row.direction, author: row.author, body: row.body,
      status: row.status ?? undefined, task_id: row.task_id ?? undefined, created_at: iso(row.created_at),
    }));
  }

  // ── records ──
  private toRec = (r: any): Record_ => ({
    id: r.id, project_id: r.project_id ?? undefined, wedge: r.wedge, collection: r.collection,
    key: r.key, data: r.data ?? {}, case_id: r.case_id ?? undefined,
    created_at: iso(r.created_at), updated_at: iso(r.updated_at),
  });
  async upsertRecord(r: Omit<Record_, "id" | "created_at" | "updated_at">): Promise<Record_> {
    // Merge on conflict so a partial re-ingest enriches rather than truncates.
    const res = await this.pool.query(
      `INSERT INTO records (id, project_id, wedge, collection, key, data, case_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (COALESCE(project_id,'-'), wedge, collection, key) DO UPDATE
         SET data = records.data || EXCLUDED.data,
             case_id = COALESCE(EXCLUDED.case_id, records.case_id),
             updated_at = now()
       RETURNING *`,
      [randomUUID(), r.project_id ?? null, r.wedge, r.collection, r.key, JSON.stringify(r.data ?? {}), r.case_id ?? null],
    );
    return this.toRec(res.rows[0]);
  }
  async getRecord(id: string): Promise<Record_ | undefined> {
    const r = await this.pool.query(`SELECT * FROM records WHERE id=$1`, [id]);
    return r.rows[0] ? this.toRec(r.rows[0]) : undefined;
  }
  private recWhere(q: { wedge?: string; collection?: string; case_id?: string; where?: Record<string, unknown> }) {
    const where: string[] = []; const vals: unknown[] = [];
    for (const [col, val] of [["wedge", q.wedge], ["collection", q.collection], ["case_id", q.case_id]] as const) {
      if (val) { vals.push(val); where.push(`${col}=$${vals.length}`); }
    }
    if (q.where && Object.keys(q.where).length) { vals.push(JSON.stringify(q.where)); where.push(`data @> $${vals.length}::jsonb`); }
    return { clause: where.length ? "WHERE " + where.join(" AND ") : "", vals };
  }
  async queryRecords(q: { wedge?: string; collection?: string; case_id?: string; where?: Record<string, unknown>; limit?: number }): Promise<Record_[]> {
    const { clause, vals } = this.recWhere(q);
    vals.push(q.limit ?? 200);
    const r = await this.pool.query(`SELECT * FROM records ${clause} ORDER BY created_at DESC LIMIT $${vals.length}`, vals);
    return r.rows.map(this.toRec);
  }
  async deleteRecord(id: string): Promise<boolean> {
    const r = await this.pool.query(`DELETE FROM records WHERE id=$1`, [id]);
    return (r.rowCount ?? 0) > 0;
  }
  async countRecords(q: { wedge?: string; collection?: string; case_id?: string; where?: Record<string, unknown> }): Promise<number> {
    const { clause, vals } = this.recWhere(q);
    const r = await this.pool.query(`SELECT COUNT(*)::int AS n FROM records ${clause}`, vals);
    return r.rows[0]?.n ?? 0;
  }

  // ── cases ──
  private toCase = (r: any): Case => ({
    id: r.id, project_id: r.project_id ?? undefined, wedge: r.wedge, title: r.title,
    client_id: r.client_id ?? undefined, stage: r.stage, status: r.status, data: r.data ?? {},
    due_at: r.due_at ? iso(r.due_at) : undefined, history: r.history ?? [],
    created_at: iso(r.created_at), updated_at: iso(r.updated_at),
    closed_at: r.closed_at ? iso(r.closed_at) : undefined,
  });
  async createCase(c: Omit<Case, "id" | "created_at" | "updated_at" | "history"> & { history?: CaseEvent[] }): Promise<Case> {
    const r = await this.pool.query(
      `INSERT INTO cases (id, project_id, wedge, title, client_id, stage, status, data, due_at, history)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [randomUUID(), c.project_id ?? null, c.wedge, c.title, c.client_id ?? null, c.stage,
       c.status ?? "open", JSON.stringify(c.data ?? {}), c.due_at ?? null, JSON.stringify(c.history ?? [])],
    );
    return this.toCase(r.rows[0]);
  }
  async getCase(id: string): Promise<Case | undefined> {
    const r = await this.pool.query(`SELECT * FROM cases WHERE id=$1`, [id]);
    return r.rows[0] ? this.toCase(r.rows[0]) : undefined;
  }
  async listCases(filter: { wedge?: string; status?: Case["status"]; client_id?: string; stage?: string } = {}): Promise<Case[]> {
    const where: string[] = []; const vals: unknown[] = [];
    for (const [col, val] of [["wedge", filter.wedge], ["status", filter.status], ["client_id", filter.client_id], ["stage", filter.stage]] as const) {
      if (val) { vals.push(val); where.push(`${col}=$${vals.length}`); }
    }
    const r = await this.pool.query(
      `SELECT * FROM cases ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC`, vals);
    return r.rows.map(this.toCase);
  }
  async updateCase(
    id: string,
    patch: Partial<Pick<Case, "stage" | "status" | "data" | "title" | "due_at" | "closed_at">>,
    event?: CaseEvent,
  ): Promise<Case | undefined> {
    const r = await this.pool.query(
      `UPDATE cases SET
         stage     = COALESCE($2, stage),
         status    = COALESCE($3, status),
         data      = COALESCE($4::jsonb, data),
         title     = COALESCE($5, title),
         due_at    = COALESCE($6::timestamptz, due_at),
         closed_at = COALESCE($7::timestamptz, closed_at),
         history   = CASE WHEN $8::jsonb IS NULL THEN history ELSE history || $8::jsonb END,
         updated_at = now()
       WHERE id=$1 RETURNING *`,
      [id, patch.stage ?? null, patch.status ?? null, patch.data ? JSON.stringify(patch.data) : null,
       patch.title ?? null, patch.due_at ?? null, patch.closed_at ?? null,
       event ? JSON.stringify([event]) : null],
    );
    return r.rows[0] ? this.toCase(r.rows[0]) : undefined;
  }

  // ── schedules ──
  private toSched = (r: any): Schedule => ({
    id: r.id, project_id: r.project_id ?? undefined, name: r.name, wedge: r.wedge,
    task_type: r.task_type, input: r.input ?? {}, cadence: r.cadence as Cadence,
    enabled: r.enabled, next_run_at: iso(r.next_run_at),
    last_run_at: r.last_run_at ? iso(r.last_run_at) : undefined,
    last_task_id: r.last_task_id ?? undefined, created_at: iso(r.created_at),
  });
  async createSchedule(s: Omit<Schedule, "id" | "created_at">): Promise<Schedule> {
    const r = await this.pool.query(
      `INSERT INTO schedules (id, project_id, name, wedge, task_type, input, cadence, enabled, next_run_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [randomUUID(), s.project_id ?? null, s.name, s.wedge, s.task_type, JSON.stringify(s.input ?? {}), JSON.stringify(s.cadence), s.enabled, s.next_run_at],
    );
    return this.toSched(r.rows[0]);
  }
  async getSchedule(id: string): Promise<Schedule | undefined> {
    const r = await this.pool.query(`SELECT * FROM schedules WHERE id=$1`, [id]);
    return r.rows[0] ? this.toSched(r.rows[0]) : undefined;
  }
  async listSchedules(): Promise<Schedule[]> {
    const r = await this.pool.query(`SELECT * FROM schedules ORDER BY created_at`);
    return r.rows.map(this.toSched);
  }
  async listDueSchedules(nowIso: string): Promise<Schedule[]> {
    const r = await this.pool.query(
      `SELECT * FROM schedules WHERE enabled AND next_run_at <= $1 ORDER BY next_run_at`,
      [nowIso],
    );
    return r.rows.map(this.toSched);
  }
  async updateSchedule(
    id: string,
    patch: Partial<Pick<Schedule, "enabled" | "next_run_at" | "last_run_at" | "last_task_id" | "input" | "cadence" | "name">>,
  ): Promise<Schedule | undefined> {
    const r = await this.pool.query(
      `UPDATE schedules SET
         enabled      = COALESCE($2, enabled),
         next_run_at  = COALESCE($3::timestamptz, next_run_at),
         last_run_at  = COALESCE($4::timestamptz, last_run_at),
         last_task_id = COALESCE($5::uuid, last_task_id),
         input        = COALESCE($6::jsonb, input),
         cadence      = COALESCE($7::jsonb, cadence),
         name         = COALESCE($8, name)
       WHERE id=$1 RETURNING *`,
      [
        id,
        patch.enabled ?? null,
        patch.next_run_at ?? null,
        patch.last_run_at ?? null,
        patch.last_task_id ?? null,
        patch.input ? JSON.stringify(patch.input) : null,
        patch.cadence ? JSON.stringify(patch.cadence) : null,
        patch.name ?? null,
      ],
    );
    return r.rows[0] ? this.toSched(r.rows[0]) : undefined;
  }
  async deleteSchedule(id: string): Promise<boolean> {
    const r = await this.pool.query(`DELETE FROM schedules WHERE id=$1`, [id]);
    return (r.rowCount ?? 0) > 0;
  }

  // ── knowledge ──
  private toK = (r: any): KnowledgeItem => ({
    id: r.id, project_id: r.project_id ?? undefined, wedge: r.wedge, name: r.name, content: r.content,
    kind: r.kind, source: r.source, metadata: r.metadata ?? {}, created_at: iso(r.created_at), updated_at: iso(r.updated_at),
  });
  async createKnowledge(k: Omit<KnowledgeItem, "id" | "created_at" | "updated_at">): Promise<KnowledgeItem> {
    const r = await this.pool.query(
      `INSERT INTO knowledge (id, project_id, wedge, name, content, kind, source, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [randomUUID(), k.project_id ?? null, k.wedge, k.name, k.content, k.kind, k.source, JSON.stringify(k.metadata ?? {})],
    );
    return this.toK(r.rows[0]);
  }
  async getKnowledge(id: string): Promise<KnowledgeItem | undefined> {
    const r = await this.pool.query(`SELECT * FROM knowledge WHERE id=$1`, [id]);
    return r.rows[0] ? this.toK(r.rows[0]) : undefined;
  }
  async listKnowledge(wedge: string): Promise<KnowledgeItem[]> {
    const r = await this.pool.query(`SELECT * FROM knowledge WHERE wedge=$1 ORDER BY created_at`, [wedge]);
    return r.rows.map(this.toK);
  }
  async updateKnowledge(id: string, patch: Partial<Pick<KnowledgeItem, "name" | "content" | "metadata">>): Promise<KnowledgeItem | undefined> {
    const r = await this.pool.query(
      `UPDATE knowledge SET
         name = COALESCE($2, name),
         content = COALESCE($3, content),
         metadata = COALESCE($4::jsonb, metadata),
         updated_at = now()
       WHERE id=$1 RETURNING *`,
      [id, patch.name ?? null, patch.content ?? null, patch.metadata ? JSON.stringify(patch.metadata) : null],
    );
    return r.rows[0] ? this.toK(r.rows[0]) : undefined;
  }
  async deleteKnowledge(id: string): Promise<boolean> {
    const r = await this.pool.query(`DELETE FROM knowledge WHERE id=$1`, [id]);
    return (r.rowCount ?? 0) > 0;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
