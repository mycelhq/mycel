// Durable Postgres backing for the service surface (clients, connections, channels, threads,
// messages, knowledge). Mirrors store.pg.ts: raw SQL, tables created on connect, jsonb columns
// parsed by node-pg. Selected automatically when MYCEL_DATABASE_URL is set.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { getPool } from "./pool";
import { withSchemaLock } from "./schema-lock";
import type { KnowledgeGap } from "./intake";
import type { Cadence, Case, CaseEvent, CaseWait, Deployment, Record_, Channel, Client, Connection, ConnectionKind, ConnectionOwner, KnowledgeItem, Message, Schedule, Thread, TriggerSub, WaitCondition, WaitMode, WaitPart, WaitResume, WaitStatus } from "./contract";
import { normalizeHandle, type CaseClaimMarker, type CaseFilter, type DeploymentQuery, type DomainStore, type NewWait, type PacingBump, type RecordQuery, type WaitFilter } from "./domain";

const { Pool } = pg;
const iso = (v: unknown) => new Date(v as string).toISOString();
/** Postgres uuid columns throw 22P02 on junk like `prod-probe`. Treat that as a miss, not a 500. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(id: string): boolean {
  return UUID_RE.test(id);
}

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
        CREATE TABLE IF NOT EXISTS case_waits (
          id uuid PRIMARY KEY,
          -- NOT NULL, like deployments.project_id and for the same reason. This table is new, so
          -- there is no legacy unscoped row to accommodate, and every read below can fail closed
          -- with no exception for NULL. A wait with no tenant is a resume that could spawn a run
          -- against the wrong founder's connections.
          project_id text NOT NULL,
          case_id uuid NOT NULL,
          wedge text NOT NULL,
          reason text NOT NULL,
          -- THE WAYS OUT. A jsonb ARRAY of conditions since waits learned to express OR; rows
          -- written by the kernel that predates that hold a bare object, and toWait normalises the
          -- two into CaseWait.conditions. One column rather than a new conditions column alongside a
          -- legacy condition one, because two columns is two answers to "what is this engagement
          -- blocked on", and the day a migration touches one of them the sweep resumes on the stale
          -- one.
          condition jsonb NOT NULL,
          resume jsonb NOT NULL,
          status text NOT NULL DEFAULT 'waiting',
          nudge_at timestamptz,
          nudge_count int NOT NULL DEFAULT 0,
          max_nudges int NOT NULL DEFAULT 3,
          expires_at timestamptz,
          -- How the conditions combine, and which one won. See WaitMode in contract.ts.
          wait_mode text NOT NULL DEFAULT 'any',
          parts jsonb NOT NULL DEFAULT '[]',
          satisfied_by text,
          satisfied_index int,
          satisfied_at timestamptz,
          resumed_task_id uuid,
          error text,
          -- See CaseWait.rearm_count in contract.ts. Bounded in the re-arm's own WHERE clause, so a wait whose
          -- resume keeps dying stops being re-armable rather than becoming a retry button.
          rearm_count int NOT NULL DEFAULT 0,
          rearmed_at timestamptz,
          rearmed_by text,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        -- AT MOST ONE LIVE WAIT PER CASE, enforced by the database rather than by the code path
        -- that arms one. Two live waits on one engagement means two resumes racing to advance the
        -- same stage and bill the same work — the double-invoice bug arriving from inside the
        -- house, and unlike a race between replicas it would survive every retry.
        CREATE UNIQUE INDEX IF NOT EXISTS case_waits_one_live
          ON case_waits (case_id) WHERE status IN ('waiting','resuming');
        -- The sweep's only query: this project's live waits, oldest first. Without project_id
        -- leading, it is a sequential scan over every tenant's blocked engagements.
        CREATE INDEX IF NOT EXISTS case_waits_sweep_idx
          ON case_waits (project_id, status, created_at);
        CREATE TABLE IF NOT EXISTS records (
          id uuid PRIMARY KEY,
          project_id text,
          wedge text NOT NULL,
          collection text NOT NULL,
          key text NOT NULL,
          data jsonb NOT NULL DEFAULT '{}',
          case_id uuid,
          -- Empty string = point-in-time (replace on upsert). ISO instant = one sample in a series.
          -- NOT NULL so the unique index can include it without NULL-distinct surprises.
          --
          -- Indexes that mention observed_at are deliberately NOT here. CREATE TABLE IF NOT EXISTS
          -- is a no-op on an install whose records table predates the column; a CREATE INDEX on
          -- observed_at in the same statement then aborts boot with "column does not exist" and
          -- the ALTER below never runs — observed as a kernel crash loop on 2026-08-11 (image
          -- 43ad19a). Column + natural key + observed index are applied after this block.
          observed_at text NOT NULL DEFAULT '',
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        -- Pre-observed_at natural key (4 columns). Fresh installs get the 5-column key from the
        -- ALTER block below; existing installs keep this until that block drops and rebuilds it.
        CREATE UNIQUE INDEX IF NOT EXISTS records_natural_key
          ON records (COALESCE(project_id,'-'), wedge, collection, key);
        CREATE INDEX IF NOT EXISTS records_query_idx ON records (wedge, collection);
        CREATE INDEX IF NOT EXISTS records_data_idx ON records USING gin (data);
        CREATE TABLE IF NOT EXISTS deployments (
          id uuid PRIMARY KEY,
          -- NOT NULL, unlike records.project_id. This table is new, so there is no legacy
          -- unscoped row to accommodate, and a deployment with no owner is a live URL nobody
          -- can be shown and nobody can revoke. The constraint is the cheapest place to say so.
          project_id text NOT NULL,
          task_id uuid,
          slug text NOT NULL,
          url text NOT NULL,
          status text NOT NULL,
          build_id text,
          source_key text,
          error text,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        -- Every read is "this project's deployments, newest first". Without the project_id leading
        -- this index, that query is a sequential scan over every tenant's history.
        CREATE INDEX IF NOT EXISTS deployments_project_idx
          ON deployments (project_id, created_at DESC);
        -- At most ONE live deployment per project, enforced by the database rather than by the
        -- code path that supersedes. Two racing builds that both finish is not hypothetical, and
        -- the failure it causes — "what is my URL" having two answers — is silent.
        CREATE UNIQUE INDEX IF NOT EXISTS deployments_one_live
          ON deployments (project_id) WHERE status = 'live';
      `);
      // Idempotent migration for installs that predate Client.preferences. Nullable, so an existing
      // row reads as "no preferences captured" rather than as an empty set of them.
      await client.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS preferences jsonb;`);
      // The engagement a conversation is about. See `Thread.case_id`.
      //
      // Nullable, and deliberately NOT backfilled. There is no honest way to infer which of a
      // client's cases an existing thread was about — every candidate rule (newest open case, the
      // case whose window contains the thread) is a guess, and a wrong guess here is worse than a
      // NULL: it would put one engagement's message history in front of a portal reader asking
      // about another, and there is no evidence left afterwards to undo it with. NULL already has
      // the right meaning for a legacy row — "the general conversation with this client" — and any
      // thread whose case actually matters gets one the next time work is attached to it.
      await client.query(`ALTER TABLE threads ADD COLUMN IF NOT EXISTS case_id uuid;`);
      // Idempotent migration for installs whose case_waits table predates the re-arm. The DEFAULT 0
      // is what makes an existing stuck wait re-armable at all: without it every legacy row would
      // read NULL, `rearm_count < maxRearms` would be NULL, and the WHERE clause would refuse
      // exactly the waits that have been stuck the longest.
      await client.query(`ALTER TABLE case_waits ADD COLUMN IF NOT EXISTS rearm_count int NOT NULL DEFAULT 0;`);
      await client.query(`ALTER TABLE case_waits ADD COLUMN IF NOT EXISTS rearmed_at timestamptz;`);
      await client.query(`ALTER TABLE case_waits ADD COLUMN IF NOT EXISTS rearmed_by text;`);
      // Time-series observations on records. Empty string is the point-in-time sentinel so the
      // unique index can include the column without PG treating two NULLs as distinct rows.
      await client.query(`ALTER TABLE records ADD COLUMN IF NOT EXISTS observed_at text NOT NULL DEFAULT '';`);
      // Rebuild the natural key to include observed_at. DROP IF EXISTS + CREATE IF NOT EXISTS is
      // safe across boots: a fresh install already has the new index from CREATE TABLE above, and
      // an old install loses the 4-column unique and gains the 5-column one.
      await client.query(`DROP INDEX IF EXISTS records_natural_key`);
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS records_natural_key
           ON records (COALESCE(project_id,'-'), wedge, collection, key, observed_at)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS records_observed_idx ON records (wedge, collection, observed_at)
           WHERE observed_at <> ''`,
      );
      // Idempotent migration for installs whose case_waits predate OR and the join. Every default is
      // the old behaviour exactly: a legacy row is a one-condition `any` wait with no progress, which
      // is what it was. `condition` itself is NOT migrated from object to array — `toWait` reads both
      // — because an UPDATE that rewrote every tenant's live waits at boot is a migration that runs
      // while the sweep is running, and the one row it corrupts is an engagement nobody can resume.
      await client.query(`ALTER TABLE case_waits ADD COLUMN IF NOT EXISTS wait_mode text NOT NULL DEFAULT 'any';`);
      await client.query(`ALTER TABLE case_waits ADD COLUMN IF NOT EXISTS parts jsonb NOT NULL DEFAULT '[]';`);
      await client.query(`ALTER TABLE case_waits ADD COLUMN IF NOT EXISTS satisfied_index int;`);
      // The lookup `findOrCreateThread` does on literally every inbound message.
      await client.query(
        `CREATE INDEX IF NOT EXISTS threads_identity_idx ON threads (client_id, channel_id, status, case_id);`,
      );
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
  async deleteConnection(id: string): Promise<boolean> {
    if (!isUuid(id)) return false;
    await this.pool.query(`DELETE FROM trigger_subs WHERE connection_id=$1`, [id]);
    await this.pool.query(`DELETE FROM channels WHERE connection_id=$1`, [id]);
    const r = await this.pool.query(`DELETE FROM connections WHERE id=$1`, [id]);
    return (r.rowCount ?? 0) > 0;
  }
  /**
   * The atomic pacing increment (see the interface for the guarantee).
   *
   * ONE statement, on purpose. Every value it writes is computed from the row's OWN current value
   * inside the same UPDATE, so this is `n = n + 1` wearing a jsonb costume: when two replicas send
   * for the same account at the same instant, the second blocks on the row lock and then
   * re-evaluates its SET expression against the first one's committed row. Read the state into JS
   * and merge it there — which is what `updateConnection` does — and the second write silently
   * erases the first, which for a LinkedIn budget means sends the safety check never sees.
   *
   * The CASE on `windows->>kind` is the rollover: a counter whose window opened longer ago than the
   * caller's `windowResetBefore` restarts at 1 under a fresh window instead of accumulating for
   * ever. Doing it here rather than in a sweeper means there is no state that goes stale between
   * jobs.
   */
  async bumpPacing(connectionId: string, bump: PacingBump): Promise<Connection | undefined> {
    const e = bump.engagement ?? {};
    // Built against a parameter offset because the two branches below bind different lead
    // parameters, and an UPDATE that binds a parameter it never references is a bind error.
    const engagementSql = (n: number) => `jsonb_build_object(
        'sent',     coalesce((config->'pacing'->'engagement'->>'sent')::int, 0)     + $${n}::int,
        'accepted', coalesce((config->'pacing'->'engagement'->>'accepted')::int, 0) + $${n + 1}::int,
        'replied',  coalesce((config->'pacing'->'engagement'->>'replied')::int, 0)  + $${n + 2}::int,
        'flagged',  coalesce((config->'pacing'->'engagement'->>'flagged')::int, 0)  + $${n + 3}::int)`;
    const engVals = [e.sent ?? 0, e.accepted ?? 0, e.replied ?? 0, e.flagged ?? 0];

    // Engagement-only bump (a reply landed, an invitation was accepted): no counter, no window.
    if (!bump.kind) {
      const r = await this.pool.query(
        `UPDATE connections SET config = coalesce(config, '{}'::jsonb) || jsonb_build_object('pacing',
           coalesce(config->'pacing', '{}'::jsonb) || jsonb_build_object('engagement', ${engagementSql(2)}))
         WHERE id=$1 RETURNING *`,
        [connectionId, ...engVals],
      );
      return r.rows[0] ? this.toConn(r.rows[0]) : undefined;
    }

    // `$8` is the window-reset cutoff; a missing window start reads as -infinity, i.e. expired.
    const expired = `coalesce((config->'pacing'->'windows'->>$7)::timestamptz, '-infinity'::timestamptz) <= $8::timestamptz`;
    const r = await this.pool.query(
      `UPDATE connections SET config = coalesce(config, '{}'::jsonb) || jsonb_build_object('pacing',
         coalesce(config->'pacing', '{}'::jsonb) || jsonb_build_object(
           'used', coalesce(config->'pacing'->'used', '{}'::jsonb) || jsonb_build_object($7::text,
             CASE WHEN ${expired} THEN 1
                  ELSE coalesce((config->'pacing'->'used'->>$7)::int, 0) + 1 END),
           'windows', coalesce(config->'pacing'->'windows', '{}'::jsonb) || jsonb_build_object($7::text,
             CASE WHEN ${expired} THEN $9::text
                  ELSE coalesce(config->'pacing'->'windows'->>$7, $9::text) END),
           'last_at', coalesce(config->'pacing'->'last_at', '{}'::jsonb) || jsonb_build_object($7::text, $2::text),
           'engagement', ${engagementSql(3)}))
       WHERE id=$1 RETURNING *`,
      [connectionId, bump.at, ...engVals, bump.kind, bump.windowResetBefore ?? bump.at, bump.windowStart ?? bump.at],
    );
    return r.rows[0] ? this.toConn(r.rows[0]) : undefined;
  }

  /**
   * The polling claim (see the guarantee on the interface).
   *
   * ONE statement, and the whole point is the WHERE: the condition that decides whether the poll is
   * due is evaluated by the same UPDATE that arms the next window, under the row lock. Two replicas
   * ticking the same project at the same instant therefore see one `rowCount: 1` and one
   * `rowCount: 0`, rather than both reading a stale cursor and both polling LinkedIn.
   *
   * The SET only merges the `polling` key, so a poll cursor can never clobber `config.pacing` —
   * which a read-modify-write of the whole config absolutely can, and that would be the account's
   * safety counter being erased by a read.
   */
  async claimPoll(connectionId: string, kind: string, nowIso: string, nextAtIso: string): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE connections SET config = coalesce(config, '{}'::jsonb) || jsonb_build_object('polling',
         coalesce(config->'polling', '{}'::jsonb) || jsonb_build_object($2::text, $4::text))
       WHERE id=$1
         AND coalesce((config->'polling'->>$2)::timestamptz, '-infinity'::timestamptz) <= $3::timestamptz
       RETURNING id`,
      [connectionId, kind, nowIso, nextAtIso],
    );
    return (r.rowCount ?? 0) > 0;
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
    case_id: r.case_id ?? undefined,
    subject: r.subject ?? undefined, status: r.status, created_at: iso(r.created_at), updated_at: iso(r.updated_at),
  });
  async createThread(t: Omit<Thread, "id" | "created_at" | "updated_at">): Promise<Thread> {
    const r = await this.pool.query(
      `INSERT INTO threads (id, project_id, client_id, channel_id, case_id, subject, status) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [randomUUID(), t.project_id ?? null, t.client_id, t.channel_id, t.case_id ?? null, t.subject ?? null, t.status ?? "open"],
    );
    return this.toThread(r.rows[0]);
  }
  async getThread(id: string): Promise<Thread | undefined> {
    const r = await this.pool.query(`SELECT * FROM threads WHERE id=$1`, [id]);
    return r.rows[0] ? this.toThread(r.rows[0]) : undefined;
  }
  async findOrCreateThread(
    clientId: string,
    channelId: string,
    projectId?: string,
    subject?: string,
    caseId?: string,
  ): Promise<Thread> {
    // `IS NOT DISTINCT FROM` rather than `=`, because `case_id = NULL` is NULL, not true — the
    // no-case lookup would match nothing and mint a brand new general thread on EVERY inbound
    // message from a lead. Backfilled rows are NULL by design, so this is the common path.
    const r = await this.pool.query(
      `SELECT * FROM threads
        WHERE client_id=$1 AND channel_id=$2 AND status='open' AND case_id IS NOT DISTINCT FROM $3
        ORDER BY created_at LIMIT 1`,
      [clientId, channelId, caseId ?? null],
    );
    if (r.rows[0]) return this.toThread(r.rows[0]);
    return this.createThread({ project_id: projectId, client_id: clientId, channel_id: channelId, case_id: caseId, subject, status: "open" });
  }
  async updateThread(
    id: string,
    patch: Partial<Pick<Thread, "case_id" | "subject" | "status">>,
  ): Promise<Thread | undefined> {
    // `case_id = COALESCE(case_id, $2)` IS the write-once rule, in the statement rather than around
    // it: two runs attaching the same general thread to two different cases cannot both win, and
    // the loser gets the row that actually exists back rather than a stale read of its own write.
    const r = await this.pool.query(
      `UPDATE threads SET
         case_id    = COALESCE(case_id, $2),
         subject    = COALESCE($3, subject),
         status     = COALESCE($4, status),
         updated_at = now()
       WHERE id=$1 RETURNING *`,
      [id, patch.case_id ?? null, patch.subject ?? null, patch.status ?? null],
    );
    return r.rows[0] ? this.toThread(r.rows[0]) : undefined;
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
    observed_at: r.observed_at && r.observed_at !== "" ? r.observed_at : undefined,
    created_at: iso(r.created_at), updated_at: iso(r.updated_at),
  });
  async upsertRecord(r: Omit<Record_, "id" | "created_at" | "updated_at">): Promise<Record_> {
    // Merge on conflict so a partial re-ingest enriches rather than truncates.
    // observed_at '' = point-in-time replace; a non-empty instant is one series sample.
    const observed = r.observed_at?.trim() || "";
    const res = await this.pool.query(
      `INSERT INTO records (id, project_id, wedge, collection, key, data, case_id, observed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (COALESCE(project_id,'-'), wedge, collection, key, observed_at) DO UPDATE
         SET data = records.data || EXCLUDED.data,
             case_id = COALESCE(EXCLUDED.case_id, records.case_id),
             updated_at = now()
       RETURNING *`,
      [randomUUID(), r.project_id ?? null, r.wedge, r.collection, r.key, JSON.stringify(r.data ?? {}), r.case_id ?? null, observed],
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
    if (q.observed_from || q.observed_to) {
      // Point-in-time rows (empty observed_at) are current state, not history — exclude them.
      where.push(`observed_at <> ''`);
      if (q.observed_from) { vals.push(q.observed_from); where.push(`observed_at >= $${vals.length}`); }
      if (q.observed_to) { vals.push(q.observed_to); where.push(`observed_at <= $${vals.length}`); }
    }
    if (q.where && Object.keys(q.where).length) { vals.push(JSON.stringify(q.where)); where.push(`data @> $${vals.length}::jsonb`); }
    return { clause: where.length ? "WHERE " + where.join(" AND ") : "", vals };
  }
  async queryRecords(q: RecordQuery & { limit?: number }): Promise<Record_[]> {
    const { clause, vals } = this.recWhere(q);
    const order = `ORDER BY CASE WHEN observed_at = '' THEN created_at ELSE observed_at::timestamptz END DESC`;
    if (q.latest_per_key) {
      // DISTINCT ON keeps the newest row per key within the filtered set.
      vals.push(q.limit ?? 200);
      const r = await this.pool.query(
        `SELECT DISTINCT ON (key) * FROM records ${clause}
         ORDER BY key, CASE WHEN observed_at = '' THEN created_at ELSE observed_at::timestamptz END DESC
         LIMIT $${vals.length}`,
        vals,
      );
      // Re-sort newest-first for the caller — DISTINCT ON forced key-first ordering.
      return r.rows.map(this.toRec).sort((a, b) => {
        const aT = a.observed_at ?? a.created_at;
        const bT = b.observed_at ?? b.created_at;
        return aT < bT ? 1 : -1;
      });
    }
    vals.push(q.limit ?? 200);
    const r = await this.pool.query(`SELECT * FROM records ${clause} ${order} LIMIT $${vals.length}`, vals);
    return r.rows.map(this.toRec);
  }
  async findRecordByNaturalKey(q: { wedge: string; collection: string; key: string }): Promise<Record_ | undefined> {
    if (!q.wedge || !q.collection || !q.key) return undefined;
    // Point-in-time rows only (empty observed_at) — AgentMail thread links are not a time series.
    const r = await this.pool.query(
      `SELECT * FROM records
       WHERE wedge = $1 AND collection = $2 AND key = $3 AND observed_at = ''
       ORDER BY updated_at DESC
       LIMIT 1`,
      [q.wedge, q.collection, q.key],
    );
    return r.rows[0] ? this.toRec(r.rows[0]) : undefined;
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

  // ── deployments ──
  private toDep = (d: any): Deployment => ({
    id: d.id, project_id: d.project_id, task_id: d.task_id ?? undefined, slug: d.slug, url: d.url,
    status: d.status, build_id: d.build_id ?? undefined, source_key: d.source_key ?? undefined,
    error: d.error ?? undefined, created_at: iso(d.created_at), updated_at: iso(d.updated_at),
  });
  async createDeployment(d: Omit<Deployment, "id" | "created_at" | "updated_at">): Promise<Deployment> {
    if (!d.project_id) throw new Error("deployment requires a project_id");
    const r = await this.pool.query(
      `INSERT INTO deployments (id, project_id, task_id, slug, url, status, build_id, source_key, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [randomUUID(), d.project_id, d.task_id ?? null, d.slug, d.url, d.status,
       d.build_id ?? null, d.source_key ?? null, d.error ?? null],
    );
    return this.toDep(r.rows[0]);
  }
  async getDeployment(id: string, projectId: string): Promise<Deployment | undefined> {
    // The tenant is in the WHERE clause, not in an `if` after the fetch. Same rule as everywhere
    // else in this file: a filter enforced one level up is a filter waiting to be bypassed.
    if (!projectId) return undefined;
    const r = await this.pool.query(`SELECT * FROM deployments WHERE id=$1 AND project_id=$2`, [id, projectId]);
    return r.rows[0] ? this.toDep(r.rows[0]) : undefined;
  }
  async listDeployments(q: DeploymentQuery): Promise<Deployment[]> {
    if (!q.project_id) return [];
    const vals: unknown[] = [q.project_id];
    let clause = `WHERE project_id=$1`;
    if (q.status) { vals.push(q.status); clause += ` AND status=$${vals.length}`; }
    vals.push(q.limit ?? 50);
    const r = await this.pool.query(
      `SELECT * FROM deployments ${clause} ORDER BY created_at DESC LIMIT $${vals.length}`, vals);
    return r.rows.map(this.toDep);
  }
  async listInFlightDeployments(limit = 50): Promise<Deployment[]> {
    const r = await this.pool.query(
      `SELECT * FROM deployments WHERE status IN ('building','queued')
       ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
    return r.rows.map(this.toDep);
  }
  async updateDeployment(
    id: string,
    projectId: string,
    patch: Partial<Pick<Deployment, "status" | "build_id" | "url" | "error">>,
  ): Promise<Deployment | undefined> {
    if (!projectId) return undefined;
    // COALESCE so an absent key leaves the column alone. Writing the patch verbatim would let a
    // reconciler that only knows the status erase the build id — the one handle that leads to the
    // log explaining the failure it just recorded. The in-memory store gets this from `defined()`;
    // the two must agree or memory-backed tests stop catching real bugs.
    const r = await this.pool.query(
      `UPDATE deployments SET
         status   = COALESCE($3, status),
         build_id = COALESCE($4, build_id),
         url      = COALESCE($5, url),
         error    = COALESCE($6, error),
         updated_at = now()
       WHERE id=$1 AND project_id=$2 RETURNING *`,
      [id, projectId, patch.status ?? null, patch.build_id ?? null, patch.url ?? null, patch.error ?? null],
    );
    return r.rows[0] ? this.toDep(r.rows[0]) : undefined;
  }
  async supersedeDeployments(projectId: string, keepId: string): Promise<number> {
    if (!projectId) return 0;
    // Only rows that were actually serving. A `failed` row is history and must stay failed —
    // rewriting it to `superseded` erases the evidence that a deploy broke.
    //
    // Call this BEFORE marking the new row live: `deployments_one_live` is a partial unique index,
    // so the other order raises a constraint violation. That violation is the desired outcome under
    // a genuine race between two workers — the second one fails loudly instead of producing a
    // project with two live URLs.
    const r = await this.pool.query(
      `UPDATE deployments SET status='superseded', updated_at=now()
       WHERE project_id=$1 AND id<>$2 AND status='live'`,
      [projectId, keepId],
    );
    return r.rowCount ?? 0;
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
    if (!isUuid(id)) return undefined;
    const r = await this.pool.query(`SELECT * FROM cases WHERE id=$1`, [id]);
    return r.rows[0] ? this.toCase(r.rows[0]) : undefined;
  }
  async listCases(filter: CaseFilter): Promise<Case[]> {
    const where: string[] = []; const vals: unknown[] = [];
    // Same fail-closed tenant scope as records: NULL project_id never equals a supplied id.
    vals.push(filter.project_id); where.push(`project_id=$${vals.length}`);
    for (const [col, val] of [["wedge", filter.wedge], ["status", filter.status], ["client_id", filter.client_id], ["stage", filter.stage]] as const) {
      if (val) { vals.push(val); where.push(`${col}=$${vals.length}`); }
    }
    const r = await this.pool.query(
      `SELECT * FROM cases ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC`, vals);
    return r.rows.map(this.toCase);
  }
  async updateCase(
    id: string,
    patch: Partial<Pick<Case, "stage" | "status" | "data" | "title" | "due_at" | "closed_at" | "client_id">>,
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
         -- COALESCE, so an absent client_id leaves an existing link alone. Unlinking is not a thing
         -- this route offers: a case that was somebody's work does not stop having been.
         client_id = COALESCE($9, client_id),
         history   = CASE WHEN $8::jsonb IS NULL THEN history ELSE history || $8::jsonb END,
         updated_at = now()
       WHERE id=$1 RETURNING *`,
      [id, patch.stage ?? null, patch.status ?? null, patch.data ? JSON.stringify(patch.data) : null,
       patch.title ?? null, patch.due_at ?? null, patch.closed_at ?? null,
       event ? JSON.stringify([event]) : null, patch.client_id ?? null],
    );
    return r.rows[0] ? this.toCase(r.rows[0]) : undefined;
  }

  async claimCaseMarker(args: {
    project_id: string; id: string; marker: CaseClaimMarker; notSince: string; at: string;
  }): Promise<Case | undefined> {
    // Fail closed on an unscoped call rather than letting a null tenant match by luck.
    if (!args.project_id) return undefined;
    // ONE statement. The cooldown is INSIDE the WHERE — see `claimCaseMarker` in domain.ts for why a
    // read-then-write here puts two identical "just checking in" emails in one client's inbox.
    //
    // The marker is a BOUND PARAMETER ($3), never interpolated, so even though `CaseClaimMarker`
    // already closes the set at compile time the statement is safe against a caller that reaches it
    // with an unchecked string from JavaScript.
    //
    // The stored value is an ISO-8601 UTC string, so lexical `<` IS chronological `<` — true of every
    // timestamp this kernel writes (`toISOString()`). Compared as text rather than cast on purpose: a
    // cast would make one legacy non-date value throw for the whole statement instead of simply
    // failing the predicate, which is a refusal rather than an outage.
    const r = await this.pool.query(
      `UPDATE cases
          SET data = COALESCE(data, '{}'::jsonb) || jsonb_build_object($3::text, $5::text),
              updated_at = now()
        WHERE id=$1 AND project_id=$2 AND status='open'
          AND (data->>$3::text IS NULL OR data->>$3::text < $4)
        RETURNING *`,
      [args.id, args.project_id, args.marker, args.notSince, args.at],
    );
    return r.rows[0] ? this.toCase(r.rows[0]) : undefined;
  }

  // ── waits ──
  //
  // Every mutation below is ONE statement whose WHERE clause carries the precondition. That is the
  // entire multi-replica story: the row lock the UPDATE takes is what serialises two replicas that
  // both believe a wait is satisfied, and `rowCount` tells the loser it lost. A `SELECT` followed by
  // an `UPDATE` would let both pass the check before either writes — which, on a wait whose resume
  // raises an invoice, is the client charged twice.
  private toWait = (r: any): CaseWait => ({
    id: r.id, project_id: r.project_id, case_id: r.case_id, wedge: r.wedge, reason: r.reason,
    // ONE COLUMN, TWO SHAPES, normalised here and nowhere else. A row written before waits could
    // express OR holds a bare condition object; everything since holds an array. Reading it as
    // `[r.condition]` is what makes a five-month-old parked engagement resume under the new sweep
    // instead of falling into `unknown condition kind: undefined` and failing closed on a wait that
    // was never broken.
    conditions: (Array.isArray(r.condition) ? r.condition : [r.condition]) as WaitCondition[],
    mode: (r.wait_mode as WaitMode) ?? "any",
    parts: (Array.isArray(r.parts) ? r.parts : []) as WaitPart[],
    resume: r.resume as WaitResume, status: r.status as WaitStatus,
    nudge_at: r.nudge_at ? iso(r.nudge_at) : undefined,
    nudge_count: r.nudge_count ?? 0, max_nudges: r.max_nudges ?? 0,
    expires_at: r.expires_at ? iso(r.expires_at) : undefined,
    satisfied_by: r.satisfied_by ?? undefined,
    // `?? undefined` and NOT `|| undefined`: condition 0 is a real winner, and `||` would report the
    // first condition of every OR wait as "we do not know which one fired".
    satisfied_index: r.satisfied_index ?? undefined,
    satisfied_at: r.satisfied_at ? iso(r.satisfied_at) : undefined,
    resumed_task_id: r.resumed_task_id ?? undefined,
    error: r.error ?? undefined,
    rearm_count: r.rearm_count ?? 0,
    rearmed_at: r.rearmed_at ? iso(r.rearmed_at) : undefined,
    rearmed_by: r.rearmed_by ?? undefined,
    created_at: iso(r.created_at), updated_at: iso(r.updated_at),
  });

  async createWait(w: NewWait): Promise<CaseWait> {
    if (!w.project_id) throw new Error("a wait requires a project_id");
    if (!w.case_id) throw new Error("a wait requires a case_id");
    // See the in-memory twin: a wait with no way out can only expire, and every read assumes
    // `conditions[0]` exists.
    if (!w.conditions?.length) throw new Error("a wait requires at least one condition");
    const r = await this.pool.query(
      `INSERT INTO case_waits (id, project_id, case_id, wedge, reason, condition, wait_mode, resume, nudge_at, nudge_count, max_nudges, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [randomUUID(), w.project_id, w.case_id, w.wedge, w.reason, JSON.stringify(w.conditions), w.mode,
       JSON.stringify(w.resume), w.nudge_at ?? null, w.nudge_count ?? 0, w.max_nudges, w.expires_at ?? null],
    );
    return this.toWait(r.rows[0]);
  }
  async getWait(projectId: string, id: string): Promise<CaseWait | undefined> {
    if (!projectId) return undefined;
    const r = await this.pool.query(`SELECT * FROM case_waits WHERE id=$1 AND project_id=$2`, [id, projectId]);
    return r.rows[0] ? this.toWait(r.rows[0]) : undefined;
  }
  async listWaits(f: WaitFilter): Promise<CaseWait[]> {
    if (!f.project_id) return [];
    const vals: unknown[] = [f.project_id];
    const where = [`project_id=$1`];
    if (f.case_id) { vals.push(f.case_id); where.push(`case_id=$${vals.length}`); }
    if (f.status) { vals.push(f.status); where.push(`status=$${vals.length}`); }
    vals.push(f.limit ?? 200);
    const r = await this.pool.query(
      `SELECT * FROM case_waits WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT $${vals.length}`, vals);
    return r.rows.map(this.toWait);
  }
  async claimWait(
    projectId: string, id: string, satisfiedBy: string, nowIso: string, satisfiedIndex?: number,
  ): Promise<CaseWait | undefined> {
    if (!projectId) return undefined;
    const r = await this.pool.query(
      `UPDATE case_waits
          SET status='resuming', satisfied_by=$3, satisfied_index=$5, satisfied_at=$4::timestamptz, updated_at=now()
        WHERE id=$1 AND project_id=$2 AND status='waiting'
        RETURNING *`,
      [id, projectId, satisfiedBy, nowIso, satisfiedIndex ?? null],
    );
    return r.rows[0] ? this.toWait(r.rows[0]) : undefined;
  }
  async recordWaitPart(projectId: string, id: string, part: WaitPart): Promise<CaseWait | undefined> {
    if (!projectId) return undefined;
    // Append-if-absent in ONE statement. The `@>` containment test on the INDEX ALONE is the
    // idempotency: `client_reply` cites a different message id each sweep, so testing the whole part
    // would append a new row every five minutes and a seven-part join would report "19 of 7 in".
    const r = await this.pool.query(
      `UPDATE case_waits
          SET parts = parts || $3::jsonb, updated_at = now()
        WHERE id=$1 AND project_id=$2 AND status='waiting'
          AND NOT (parts @> $4::jsonb)
        RETURNING *`,
      [id, projectId, JSON.stringify([part]), JSON.stringify([{ index: part.index }])],
    );
    return r.rows[0] ? this.toWait(r.rows[0]) : undefined;
  }
  async settleWait(
    projectId: string,
    id: string,
    to: Exclude<WaitStatus, "waiting" | "resuming">,
    patch?: { resumed_task_id?: string; error?: string },
    from: readonly WaitStatus[] = ["waiting", "resuming"],
  ): Promise<CaseWait | undefined> {
    if (!projectId) return undefined;
    const r = await this.pool.query(
      `UPDATE case_waits
          SET status=$3,
              resumed_task_id = COALESCE($4, resumed_task_id),
              error           = COALESCE($5, error),
              updated_at = now()
        WHERE id=$1 AND project_id=$2 AND status = ANY($6::text[])
        RETURNING *`,
      [id, projectId, to, patch?.resumed_task_id ?? null, patch?.error ?? null, [...from]],
    );
    return r.rows[0] ? this.toWait(r.rows[0]) : undefined;
  }
  async claimWaitNudge(projectId: string, id: string, nowIso: string, nextNudgeIso: string | undefined): Promise<CaseWait | undefined> {
    if (!projectId) return undefined;
    // The budget check (`nudge_count < max_nudges`) is INSIDE the WHERE, not read beforehand, so a
    // client on their last allowed nudge cannot receive two because two replicas both read "2 of 3".
    const r = await this.pool.query(
      `UPDATE case_waits
          SET nudge_count = nudge_count + 1,
              nudge_at    = CASE WHEN nudge_count + 1 >= max_nudges THEN NULL ELSE $4::timestamptz END,
              updated_at  = now()
        WHERE id=$1 AND project_id=$2 AND status='waiting'
          AND nudge_at IS NOT NULL AND nudge_at <= $3::timestamptz
          AND nudge_count < max_nudges
        RETURNING *`,
      [id, projectId, nowIso, nextNudgeIso ?? null],
    );
    return r.rows[0] ? this.toWait(r.rows[0]) : undefined;
  }
  async growWait(
    projectId: string, id: string, condition: WaitCondition, maxConditions: number,
  ): Promise<CaseWait | undefined> {
    if (!projectId) return undefined;
    // `jsonb_typeof(condition)='array'` is not belt-and-braces: a wait written before OR holds a
    // bare object, and `object || array` in jsonb is a silent nonsense value rather than an error.
    // A legacy single-condition row is an `any` wait anyway, so `wait_mode='all'` would already
    // refuse it — this is the guard that survives somebody relaxing that one.
    const subject = Object.entries(condition).find(([k]) => k !== "kind" && k !== "label");
    const probe = JSON.stringify([{ kind: condition.kind, ...(subject ? { [subject[0]]: subject[1] } : {}) }]);
    const r = await this.pool.query(
      `UPDATE case_waits
          SET condition = condition || $3::jsonb, updated_at = now()
        WHERE id=$1 AND project_id=$2 AND status='waiting' AND wait_mode='all'
          AND jsonb_typeof(condition) = 'array'
          AND jsonb_array_length(condition) < $4
          AND NOT (condition @> $5::jsonb)
        RETURNING *`,
      [id, projectId, JSON.stringify([condition]), maxConditions, probe],
    );
    return r.rows[0] ? this.toWait(r.rows[0]) : undefined;
  }
  async rearmWait(args: {
    projectId: string; id: string; stuckBefore: string; maxRearms: number; by: string; nowIso: string;
  }): Promise<CaseWait | undefined> {
    if (!args.projectId) return undefined;
    // EVERY guard is in the WHERE clause and none is read first — see `DomainStore.rearmWait` for
    // what each one is protecting against. A `SELECT` then `UPDATE` here would let two founders (or a
    // double-clicked button) both move one wait back to `waiting`, and the sweep would then resume it
    // once for each — which is precisely the duplicate the never-releasing claim was chosen to avoid.
    const r = await this.pool.query(
      // `parts` is deliberately untouched — see the in-memory twin. The receipts really did arrive.
      `UPDATE case_waits
          SET status='waiting',
              satisfied_by=NULL, satisfied_index=NULL, satisfied_at=NULL,
              rearm_count = rearm_count + 1,
              rearmed_at  = $4::timestamptz,
              rearmed_by  = $5,
              updated_at  = $4::timestamptz
        WHERE id=$1 AND project_id=$2 AND status='resuming'
          AND resumed_task_id IS NULL
          AND updated_at <= $3::timestamptz
          AND rearm_count < $6
        RETURNING *`,
      [args.id, args.projectId, args.stuckBefore, args.nowIso, args.by, args.maxRearms],
    );
    return r.rows[0] ? this.toWait(r.rows[0]) : undefined;
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
  async listKnowledge(wedge: string, projectId: string): Promise<KnowledgeItem[]> {
    // See DomainStore.listKnowledge. `project_id=$2` never matches NULL, which gives the
    // fail-closed semantics for free: an unscoped legacy row is in nobody's scope.
    if (!projectId) return [];
    const r = await this.pool.query(
      `SELECT * FROM knowledge WHERE wedge=$1 AND project_id=$2 ORDER BY created_at`,
      [wedge, projectId],
    );
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
