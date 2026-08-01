// Durable Postgres backing for the service surface (clients, connections, channels, threads,
// messages, knowledge). Mirrors store.pg.ts: raw SQL, tables created on connect, jsonb columns
// parsed by node-pg. Selected automatically when MYCEL_DATABASE_URL is set.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { getPool } from "./pool";
import { withSchemaLock } from "./schema-lock";
import type { KnowledgeGap } from "./intake";
import type { Cadence, Case, CaseEvent, Record_, Channel, Client, Connection, ConnectionKind, ConnectionOwner, KnowledgeItem, Message, Schedule, Thread, TriggerSub } from "./contract";
import { normalizeHandle, type CaseFilter, type DomainStore, type RecordQuery } from "./domain";

const { Pool } = pg;
const iso = (v: unknown) => new Date(v as string).toISOString();

export class PostgresDomainStore implements DomainStore {
  private constructor(private pool: pg.Pool) {}

  static async connect(url: string): Promise<PostgresDomainStore> {
    const pool = getPool(url);
    const self = new PostgresDomainStore(pool);
    await self.init();
    return self;
  }

  private async init(): Promise<void> {
      // Serialised across processes: `CREATE TABLE IF NOT EXISTS` is not concurrency-safe, and
      // four kernel containers boot together on every deploy. See schema-lock.ts.
    await withSchemaLock(this.pool, async (client) => {
      await client.query(`
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
        CREATE TABLE IF NOT EXISTS trigger_subs (
          id uuid PRIMARY KEY,
          project_id text,
          connection_id uuid NOT NULL,
          trigger_slug text NOT NULL,
          trigger_id text,
          owner jsonb NOT NULL DEFAULT '{}',
          wedge text NOT NULL,
          task_type text NOT NULL,
          config jsonb NOT NULL DEFAULT '{}',
          enabled boolean NOT NULL DEFAULT true,
          last_event_at timestamptz,
          last_task_id uuid,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        -- Every inbound webhook does exactly one lookup, by this. Unique because two rows claiming
        -- the same Composio trigger instance would make routing ambiguous, and a webhook that could
        -- land in either of two projects is a tenancy bug waiting for a busy day.
        CREATE UNIQUE INDEX IF NOT EXISTS trigger_subs_trigger_id ON trigger_subs (trigger_id)
          WHERE trigger_id IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS trigger_subs_conn_slug
          ON trigger_subs (connection_id, trigger_slug);
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
          preferences jsonb,
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
        -- What the agent discovered it did not know, on real jobs. The hit count is the ranking
        -- signal, so the key is (project, id) and a repeat is an increment, not a new row.
        CREATE TABLE IF NOT EXISTS knowledge_gaps (
          id text NOT NULL,
          project_id text NOT NULL,
          wedge text NOT NULL,
          question text NOT NULL,
          fallback text,
          hits int NOT NULL DEFAULT 1,
          task_ids text[] NOT NULL DEFAULT '{}',
          status text NOT NULL DEFAULT 'open',
          first_seen timestamptz NOT NULL DEFAULT now(),
          last_seen timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (project_id, id)
        );
        CREATE INDEX IF NOT EXISTS knowledge_gaps_wedge_idx ON knowledge_gaps (project_id, wedge, status);
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
      // Idempotent migration for installs that predate Client.preferences. Nullable, so an existing
      // row reads as "no preferences captured" rather than as an empty set of them.
      await client.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS preferences jsonb;`);
    });
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
  async updateConnection(
    id: string,
    patch: Partial<Pick<Connection, "name" | "config" | "secret_ref">>,
  ): Promise<Connection | undefined> {
    // COALESCE so a partial patch preserves the columns it doesn't mention — the same discipline the
    // schedule update needs (a patch that passes `undefined` must not blank a column).
    const r = await this.pool.query(
      `UPDATE connections SET
         name       = COALESCE($2, name),
         config     = COALESCE($3::jsonb, config),
         secret_ref = COALESCE($4, secret_ref)
       WHERE id=$1 RETURNING *`,
      [id, patch.name ?? null, patch.config ? JSON.stringify(patch.config) : null, patch.secret_ref ?? null],
    );
    return r.rows[0] ? this.toConn(r.rows[0]) : undefined;
  }
  async recordGap(
    g: Omit<KnowledgeGap, "hits" | "task_ids" | "status" | "first_seen" | "last_seen"> & { task_id?: string },
  ): Promise<KnowledgeGap> {
    // One statement so two replicas hitting the same gap can't race into two rows or a lost hit.
    // A gap resurfacing after it was answered reopens it: the answer evidently didn't cover this.
    const r = await this.pool.query(
      `INSERT INTO knowledge_gaps (id, project_id, wedge, question, fallback, task_ids)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (project_id, id) DO UPDATE SET
         hits      = knowledge_gaps.hits + 1,
         last_seen = now(),
         fallback  = COALESCE(EXCLUDED.fallback, knowledge_gaps.fallback),
         task_ids  = (SELECT ARRAY(SELECT DISTINCT unnest(knowledge_gaps.task_ids || EXCLUDED.task_ids))),
         status    = CASE WHEN knowledge_gaps.status = 'answered' THEN 'open' ELSE knowledge_gaps.status END
       RETURNING *`,
      [g.id, g.project_id, g.wedge, g.question, g.fallback ?? null, g.task_id ? [g.task_id] : []],
    );
    return this.toGap(r.rows[0]);
  }
  async listGaps(projectId: string, wedge: string): Promise<KnowledgeGap[]> {
    const r = await this.pool.query(
      `SELECT * FROM knowledge_gaps WHERE project_id=$1 AND wedge=$2 ORDER BY hits DESC`,
      [projectId, wedge],
    );
    return r.rows.map((x) => this.toGap(x));
  }
  async setGapStatus(id: string, projectId: string, status: KnowledgeGap["status"]): Promise<KnowledgeGap | undefined> {
    const r = await this.pool.query(
      `UPDATE knowledge_gaps SET status=$3 WHERE project_id=$2 AND id=$1 RETURNING *`,
      [id, projectId, status],
    );
    return r.rows[0] ? this.toGap(r.rows[0]) : undefined;
  }
  private toGap(r: Record<string, unknown>): KnowledgeGap {
    return {
      id: String(r.id),
      project_id: String(r.project_id),
      wedge: String(r.wedge),
      question: String(r.question),
      fallback: (r.fallback as string) ?? undefined,
      hits: Number(r.hits),
      task_ids: (r.task_ids as string[]) ?? [],
      status: r.status as KnowledgeGap["status"],
      first_seen: new Date(r.first_seen as string).toISOString(),
      last_seen: new Date(r.last_seen as string).toISOString(),
    };
  }
  async listConnections(): Promise<Connection[]> {
    const r = await this.pool.query(`SELECT * FROM connections ORDER BY created_at`);
    return r.rows.map(this.toConn);
  }

  // ── trigger subscriptions ──
  private toSub = (r: any): TriggerSub => ({
    id: r.id,
    project_id: r.project_id ?? undefined,
    connection_id: r.connection_id,
    trigger_slug: r.trigger_slug,
    trigger_id: r.trigger_id ?? undefined,
    owner: r.owner as ConnectionOwner,
    wedge: r.wedge,
    task_type: r.task_type,
    config: r.config,
    enabled: !!r.enabled,
    last_event_at: r.last_event_at ? iso(r.last_event_at) : undefined,
    last_task_id: r.last_task_id ?? undefined,
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
  });
  async createTriggerSub(t: Omit<TriggerSub, "id" | "created_at" | "updated_at">): Promise<TriggerSub> {
    // Upsert on (connection, slug): subscribing twice to the same event on the same account is one
    // subscription, not two runs per delivery. Mirrors Composio's own upsert on the far side.
    const r = await this.pool.query(
      `INSERT INTO trigger_subs (id, project_id, connection_id, trigger_slug, trigger_id, owner, wedge, task_type, config, enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (connection_id, trigger_slug) DO UPDATE
         SET trigger_id = COALESCE(EXCLUDED.trigger_id, trigger_subs.trigger_id),
             wedge = EXCLUDED.wedge,
             task_type = EXCLUDED.task_type,
             config = EXCLUDED.config,
             enabled = EXCLUDED.enabled,
             updated_at = now()
       RETURNING *`,
      [
        randomUUID(), t.project_id ?? null, t.connection_id, t.trigger_slug.toUpperCase(),
        t.trigger_id ?? null, JSON.stringify(t.owner), t.wedge, t.task_type,
        JSON.stringify(t.config ?? {}), t.enabled,
      ],
    );
    return this.toSub(r.rows[0]);
  }
  async getTriggerSub(id: string): Promise<TriggerSub | undefined> {
    const r = await this.pool.query(`SELECT * FROM trigger_subs WHERE id=$1`, [id]);
    return r.rows[0] ? this.toSub(r.rows[0]) : undefined;
  }
  async listTriggerSubs(): Promise<TriggerSub[]> {
    const r = await this.pool.query(`SELECT * FROM trigger_subs ORDER BY created_at`);
    return r.rows.map(this.toSub);
  }
  async findTriggerSub(q: {
    trigger_id?: string;
    connection_id?: string;
    trigger_slug?: string;
  }): Promise<TriggerSub | undefined> {
    if (q.trigger_id) {
      const r = await this.pool.query(`SELECT * FROM trigger_subs WHERE trigger_id=$1`, [q.trigger_id]);
      if (r.rows[0]) return this.toSub(r.rows[0]);
    }
    if (q.connection_id && q.trigger_slug) {
      const r = await this.pool.query(
        `SELECT * FROM trigger_subs WHERE connection_id=$1 AND upper(trigger_slug)=upper($2)`,
        [q.connection_id, q.trigger_slug],
      );
      if (r.rows[0]) return this.toSub(r.rows[0]);
    }
    return undefined;
  }
  async updateTriggerSub(
    id: string,
    patch: Partial<Pick<TriggerSub, "enabled" | "trigger_id" | "wedge" | "task_type" | "config" | "last_event_at" | "last_task_id">>,
  ): Promise<TriggerSub | undefined> {
    const r = await this.pool.query(
      `UPDATE trigger_subs SET
         enabled       = COALESCE($2, enabled),
         trigger_id    = COALESCE($3, trigger_id),
         wedge         = COALESCE($4, wedge),
         task_type     = COALESCE($5, task_type),
         config        = COALESCE($6::jsonb, config),
         last_event_at = COALESCE($7::timestamptz, last_event_at),
         last_task_id  = COALESCE($8::uuid, last_task_id),
         updated_at    = now()
       WHERE id=$1 RETURNING *`,
      [
        id, patch.enabled ?? null, patch.trigger_id ?? null, patch.wedge ?? null,
        patch.task_type ?? null, patch.config ? JSON.stringify(patch.config) : null,
        patch.last_event_at ?? null, patch.last_task_id ?? null,
      ],
    );
    return r.rows[0] ? this.toSub(r.rows[0]) : undefined;
  }
  async deleteTriggerSub(id: string): Promise<boolean> {
    const r = await this.pool.query(`DELETE FROM trigger_subs WHERE id=$1`, [id]);
    return (r.rowCount ?? 0) > 0;
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
    handles: r.handles ?? [], metadata: r.metadata ?? {},
    preferences: r.preferences ?? undefined,
    created_at: iso(r.created_at), updated_at: iso(r.updated_at),
  });
  async createClient(c: Omit<Client, "id" | "created_at" | "updated_at">): Promise<Client> {
    const handles = (c.handles ?? []).map(normalizeHandle);
    const r = await this.pool.query(
      `INSERT INTO clients (id, project_id, display_name, handles, metadata, preferences) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [
        randomUUID(), c.project_id ?? null, c.display_name ?? null,
        JSON.stringify(handles), JSON.stringify(c.metadata ?? {}),
        c.preferences === undefined ? null : JSON.stringify(c.preferences),
      ],
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
  async updateClient(
    id: string,
    patch: Partial<Pick<Client, "display_name" | "handles" | "metadata" | "preferences">>,
  ): Promise<Client | undefined> {
    // COALESCE leaves an omitted key at its current value, which is what the in-memory `defined()`
    // does — the two backends must agree here or memory-backed tests can't catch a divergence.
    const handles = patch.handles !== undefined ? patch.handles.map(normalizeHandle) : undefined;
    const r = await this.pool.query(
      `UPDATE clients SET
         display_name = COALESCE($2, display_name),
         handles      = COALESCE($3::jsonb, handles),
         metadata     = COALESCE($4::jsonb, metadata),
         preferences  = COALESCE($5::jsonb, preferences),
         updated_at   = now()
       WHERE id=$1 RETURNING *`,
      [
        id,
        patch.display_name ?? null,
        handles === undefined ? null : JSON.stringify(handles),
        patch.metadata === undefined ? null : JSON.stringify(patch.metadata),
        patch.preferences === undefined ? null : JSON.stringify(patch.preferences),
      ],
    );
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
  private recWhere(q: RecordQuery) {
    const where: string[] = []; const vals: unknown[] = [];
    // Tenant scope, fail-closed: `project_id=$n` never matches a NULL project_id in SQL, which is
    // exactly what we want — an unscoped legacy row does not belong to whoever happens to ask.
    if (q.project_id !== undefined) { vals.push(q.project_id); where.push(`project_id=$${vals.length}`); }
    for (const [col, val] of [["wedge", q.wedge], ["collection", q.collection], ["case_id", q.case_id]] as const) {
      if (val) { vals.push(val); where.push(`${col}=$${vals.length}`); }
    }
    if (q.where && Object.keys(q.where).length) { vals.push(JSON.stringify(q.where)); where.push(`data @> $${vals.length}::jsonb`); }
    return { clause: where.length ? "WHERE " + where.join(" AND ") : "", vals };
  }
  async queryRecords(q: RecordQuery & { limit?: number }): Promise<Record_[]> {
    const { clause, vals } = this.recWhere(q);
    vals.push(q.limit ?? 200);
    const r = await this.pool.query(`SELECT * FROM records ${clause} ORDER BY created_at DESC LIMIT $${vals.length}`, vals);
    return r.rows.map(this.toRec);
  }
  async deleteRecord(id: string): Promise<boolean> {
    const r = await this.pool.query(`DELETE FROM records WHERE id=$1`, [id]);
    return (r.rowCount ?? 0) > 0;
  }
  async countRecords(q: RecordQuery): Promise<number> {
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
  async listCases(filter: CaseFilter = {}): Promise<Case[]> {
    const where: string[] = []; const vals: unknown[] = [];
    // Same fail-closed tenant scope as records: NULL project_id never equals a supplied id.
    if (filter.project_id !== undefined) { vals.push(filter.project_id); where.push(`project_id=$${vals.length}`); }
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

  /**
   * The multi-instance guarantee. `FOR UPDATE SKIP LOCKED` means replica A locks the due rows and
   * replica B *skips them entirely* rather than blocking — so exactly one replica claims each
   * schedule, and `next_run_at` is advanced inside the same transaction before anything fires.
   * Without this, N replicas each fire the same schedule and the client gets N duplicate emails.
   */
  async claimDueSchedules(
    nowIso: string,
    advance: (s: Schedule, now: Date) => string,
    limit = 50,
  ): Promise<Schedule[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const due = await client.query(
        `SELECT * FROM schedules
           WHERE enabled AND next_run_at <= $1
           ORDER BY next_run_at
           LIMIT $2
           FOR UPDATE SKIP LOCKED`,
        [nowIso, limit],
      );
      const now = new Date(nowIso);
      const claimed: Schedule[] = [];
      for (const row of due.rows) {
        const s = this.toSched(row);
        const next = advance(s, now);
        await client.query(`UPDATE schedules SET next_run_at=$2, last_run_at=$3 WHERE id=$1`, [s.id, next, nowIso]);
        claimed.push({ ...s, next_run_at: next, last_run_at: nowIso });
      }
      await client.query("COMMIT");
      return claimed;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
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
    // No-op: the pool is shared process-wide. See pool.ts — the first store to end
    // it would close the connections every other store is still using. Shutdown calls
    // closeAllPools() once.
  }
}
