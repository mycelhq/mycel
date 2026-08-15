// Durable identity: orgs, projects, members, and product API keys. The in-memory IdentityStore
// keeps a read cache (auth is on every request, so lookups stay synchronous); this is the source
// of truth at boot and the write-through target. Sessions stay in-memory by design — they're
// short-lived tokens, and a restart should log members out.
import pg from "pg";
import { getPool } from "./pool";
import { withSchemaLock } from "./schema-lock";
import { defaultPlan } from "./identity";
import type { Org, Project, Role, StoredInvite, StoredMember } from "./identity";

const { Pool } = pg;
const iso = (v: unknown) => new Date(v as string).toISOString();

// One mapper per table, shared by `loadAll` (boot) and `loadProjectScope` (cache miss). They used to
// be inline in `loadAll`, which was fine while boot was the only reader; a second reader mapping the
// same rows by hand is how a column gets dropped on one path only.
const rowToOrg = (r: any): Org => ({
  id: r.id, name: r.name, created_at: iso(r.created_at),
  plan: r.plan ?? defaultPlan(),
  plan_status: r.plan_status ?? "active",
  billing_ref: r.billing_ref ?? undefined,
  plan_renews_at: r.plan_renews_at ? iso(r.plan_renews_at) : undefined,
  last_digest_at: r.last_digest_at ? iso(r.last_digest_at) : undefined,
});
const rowToProject = (r: any): Project => ({
  id: r.id, org_id: r.org_id, name: r.name, wedges: r.wedges ?? [], created_at: iso(r.created_at),
  slug: r.slug ?? undefined,
  custom_domain: r.custom_domain ?? undefined,
  domain_verify_token: r.domain_verify_token ?? undefined,
  custom_domain_verified_at: r.custom_domain_verified_at ? iso(r.custom_domain_verified_at) : undefined,
  branding: r.branding ?? undefined,
});
const rowToMember = (r: any): StoredMember => ({
  id: r.id, org_id: r.org_id, email: r.email, role: r.role as Role,
  created_at: iso(r.created_at), salt: r.salt, hash: r.hash,
  last_provider: r.last_provider ?? undefined,
  providers: r.providers ?? [],
  reset_hash: r.reset_hash ?? undefined,
  prefs: r.prefs ?? undefined,
  email_verified_at: r.email_verified_at ? iso(r.email_verified_at) : undefined,
  verify_hash: r.verify_hash ?? undefined,
  // Same bigint-arrives-as-string trap as `reset_expires` two lines down. Without `Number()` every
  // expiry comparison is a string-vs-number `<` that answers false, and a verification link would
  // never expire — the exact bug this file already carries a comment about.
  verify_expires: r.verify_expires === null || r.verify_expires === undefined ? undefined : Number(r.verify_expires),
  verify_sends: Array.isArray(r.verify_sends) ? r.verify_sends.map(Number) : undefined,
  // bigint arrives as a string from pg; Number() here or every expiry comparison is false.
  reset_expires: r.reset_expires === null || r.reset_expires === undefined ? undefined : Number(r.reset_expires),
});

export class IdentityPg {
  private constructor(private pool: pg.Pool) {}

  static async connect(url: string): Promise<IdentityPg> {
    const pool = getPool(url);
    const self = new IdentityPg(pool);
      // Serialised across processes: `CREATE TABLE IF NOT EXISTS` is not concurrency-safe, and
      // four kernel containers boot together on every deploy. See schema-lock.ts.
    await withSchemaLock(pool, async (client) => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS orgs (
          id text PRIMARY KEY,
          name text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS projects (
          id text PRIMARY KEY,
          org_id text NOT NULL,
          name text NOT NULL,
          wedges jsonb NOT NULL DEFAULT '[]',
          created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS members (
          id text PRIMARY KEY,
          org_id text NOT NULL,
          email text NOT NULL UNIQUE,
          role text NOT NULL DEFAULT 'owner',
          salt text NOT NULL,
          hash text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS api_keys (
          key text PRIMARY KEY,
          project_id text NOT NULL,
          org_id text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS invites (
          id text PRIMARY KEY,
          org_id text NOT NULL,
          email text NOT NULL,
          role text NOT NULL,
          invited_by text NOT NULL,
          token_hash text NOT NULL,
          expires_at bigint NOT NULL,
          accepted_at timestamptz,
          created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS invites_org_idx ON invites (org_id);
      `);
      // Added after the first release, so additive and idempotent rather than a rewrite of the table.
      // Without these, a member's last-used provider and any in-flight password reset were lost on
      // every restart — the reset email a founder sent two minutes before a deploy stopped working.
      await client.query(`
        ALTER TABLE members ADD COLUMN IF NOT EXISTS last_provider text;
        ALTER TABLE members ADD COLUMN IF NOT EXISTS providers jsonb NOT NULL DEFAULT '[]';
        ALTER TABLE members ADD COLUMN IF NOT EXISTS reset_hash text;
        ALTER TABLE members ADD COLUMN IF NOT EXISTS reset_expires bigint;
        -- Per-person UI state (see MemberPrefs). Without this, "we will never ask you that again"
        -- was a promise that expired at the next deploy: onboarding would greet a returning founder
        -- as a stranger, which is the one thing an onboarding flow must never do.
        ALTER TABLE members ADD COLUMN IF NOT EXISTS prefs jsonb;
        -- Email verification. Additive and idempotent like everything above it. NULL means "not
        -- verified", which is the correct reading for every account that existed before this
        -- column: we genuinely do not know that those addresses receive mail, and back-filling
        -- them to verified would be asserting a fact nobody established.
        ALTER TABLE members ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;
        ALTER TABLE members ADD COLUMN IF NOT EXISTS verify_hash text;
        ALTER TABLE members ADD COLUMN IF NOT EXISTS verify_expires bigint;
        -- The resend rate window. jsonb rather than a counter column: see VERIFY_MAX_PER_WINDOW in
        -- identity.ts — a counter that resets on a boundary lets a burst through either side of it.
        ALTER TABLE members ADD COLUMN IF NOT EXISTS verify_sends jsonb;
        ALTER TABLE orgs ADD COLUMN IF NOT EXISTS plan text NOT NULL DEFAULT 'self_hosted';
        ALTER TABLE orgs ADD COLUMN IF NOT EXISTS plan_status text NOT NULL DEFAULT 'active';
        ALTER TABLE orgs ADD COLUMN IF NOT EXISTS billing_ref text;
        ALTER TABLE orgs ADD COLUMN IF NOT EXISTS plan_renews_at timestamptz;
        ALTER TABLE orgs ADD COLUMN IF NOT EXISTS last_digest_at timestamptz;
        ALTER TABLE projects ADD COLUMN IF NOT EXISTS slug text;
        ALTER TABLE projects ADD COLUMN IF NOT EXISTS custom_domain text;
        ALTER TABLE projects ADD COLUMN IF NOT EXISTS domain_verify_token text;
        ALTER TABLE projects ADD COLUMN IF NOT EXISTS custom_domain_verified_at timestamptz;
        ALTER TABLE projects ADD COLUMN IF NOT EXISTS branding jsonb;
        -- A hostname must resolve to at most one business. Enforced here rather than only in code,
        -- because two replicas can allocate the same slug at the same instant.
        CREATE UNIQUE INDEX IF NOT EXISTS projects_slug_key ON projects (slug) WHERE slug IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS projects_domain_key ON projects (custom_domain) WHERE custom_domain IS NOT NULL;
        -- Member sign-in sessions. Persisted so a deploy (or landing on another instance) no longer
        -- signs everyone out — the in-memory Map was a single-process store and could not scale past
        -- one replica. The PRIMARY KEY is the token's SHA-256 HASH, never the token: a leaked table
        -- hands out nothing usable, exactly as for invites/reset. expires_at slides forward on use.
        CREATE TABLE IF NOT EXISTS sessions (
          token_hash text PRIMARY KEY,
          member_id text NOT NULL,
          org_id text NOT NULL,
          expires_at bigint NOT NULL
        );
        CREATE INDEX IF NOT EXISTS sessions_member_idx ON sessions (member_id);
        CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions (expires_at);
      `);
      // Sweep expired rows at boot so the table does not grow without bound. Cheap, indexed, and a
      // logged-out session is worthless — this is not a security control, just housekeeping.
      await client.query(`DELETE FROM sessions WHERE expires_at < $1`, [Date.now()]);
    });
    return self;
  }

  async loadAll(): Promise<{
    orgs: Org[];
    projects: Project[];
    members: StoredMember[];
    apiKeys: Map<string, { project_id: string; org_id: string }>;
    invites: StoredInvite[];
  }> {
    const [o, p, m, k, inv] = await Promise.all([
      this.pool.query(`SELECT * FROM orgs`),
      this.pool.query(`SELECT * FROM projects`),
      this.pool.query(`SELECT * FROM members`),
      this.pool.query(`SELECT * FROM api_keys`),
      this.pool.query(`SELECT * FROM invites`),
    ]);
    return {
      orgs: o.rows.map(rowToOrg),
      projects: p.rows.map(rowToProject),
      members: m.rows.map(rowToMember),
      apiKeys: new Map(k.rows.map((r: any) => [r.key, { project_id: r.project_id, org_id: r.org_id }])),
      invites: inv.rows.map((r: any) => ({
        id: r.id, org_id: r.org_id, email: r.email, role: r.role as Role,
        invited_by: r.invited_by, token_hash: r.token_hash,
        expires_at: Number(r.expires_at),
        accepted_at: r.accepted_at ? iso(r.accepted_at) : undefined,
        created_at: iso(r.created_at),
      })),
    };
  }

  /**
   * One project, its org, and that org's members — the tenant facts a RUN needs.
   *
   * ═══ THE PRODUCTION FAILURE THIS EXISTS FOR ═══
   *
   * The in-memory IdentityStore is filled once, by `loadAll` at boot, and never again. That is fine
   * for the API container, which creates the org and therefore has it. It is wrong for the WORKER,
   * which is a separate process that booted before the signup happened: `getProject(task.project_id)`
   * answered undefined for every org created since the last deploy.
   *
   * Observed on app.mycelai.dev. Worker task started 18:41:12Z; project 3866e5f5 created 18:43:41Z;
   * its `draft_shape` at 18:44:51Z failed with "You didn't provide an API key … obtain an API key
   * from platform.openai.com" and cost $0.00. The chain: no project → no org id → `keyForOrg` never
   * called → no LiteLLM virtual key → the runtime fell back to calling OpenAI directly with the
   * empty string, and OpenAI's own 401 was shown to the founder as though the credential were his to
   * supply. Nothing reached LiteLLM at all: its log group had only health checks.
   *
   * The members matter as much as the org. `orgIsUnlimited` scans them, and `limitsFor` on an org
   * missing from the cache falls through to `PLAN_LIMITS[self_hosted]` — an UNMETERED budget. A
   * cache miss must not be able to mint an uncapped key for a stranger.
   */
  async loadProjectScope(projectId: string): Promise<{ project?: Project; org?: Org; members: StoredMember[] }> {
    const p = await this.pool.query(`SELECT * FROM projects WHERE id=$1`, [projectId]);
    const project = p.rows[0] ? rowToProject(p.rows[0]) : undefined;
    if (!project) return { members: [] };
    const [o, m] = await Promise.all([
      this.pool.query(`SELECT * FROM orgs WHERE id=$1`, [project.org_id]),
      this.pool.query(`SELECT * FROM members WHERE org_id=$1`, [project.org_id]),
    ]);
    return { project, org: o.rows[0] ? rowToOrg(o.rows[0]) : undefined, members: m.rows.map(rowToMember) };
  }

  async upsertOrg(o: Org): Promise<void> {
    await this.pool.query(
      `INSERT INTO orgs (id, name, plan, plan_status, billing_ref, plan_renews_at, last_digest_at) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, plan=EXCLUDED.plan,
         plan_status=EXCLUDED.plan_status, billing_ref=EXCLUDED.billing_ref,
         plan_renews_at=EXCLUDED.plan_renews_at, last_digest_at=EXCLUDED.last_digest_at`,
      [o.id, o.name, o.plan ?? "self_hosted", o.plan_status ?? "active", o.billing_ref ?? null, o.plan_renews_at ?? null, o.last_digest_at ?? null],
    );
  }
  async upsertProject(p: Project): Promise<void> {
    await this.pool.query(
      `INSERT INTO projects (id, org_id, name, wedges, slug, custom_domain, domain_verify_token, custom_domain_verified_at, branding)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, wedges=EXCLUDED.wedges, slug=EXCLUDED.slug,
         custom_domain=EXCLUDED.custom_domain, domain_verify_token=EXCLUDED.domain_verify_token,
         custom_domain_verified_at=EXCLUDED.custom_domain_verified_at, branding=EXCLUDED.branding`,
      [
        p.id, p.org_id, p.name, JSON.stringify(p.wedges ?? []),
        p.slug ?? null, p.custom_domain ?? null, p.domain_verify_token ?? null,
        p.custom_domain_verified_at ?? null, p.branding ? JSON.stringify(p.branding) : null,
      ],
    );
  }
  /**
   * COALESCE on `email_verified_at`, and EXCLUDED on everything else.
   *
   * Verification is a fact about the past, and the only write that may clear it is none. Every other
   * column here overwrites, which is right for them; a plain `email_verified_at=EXCLUDED...` would
   * mean any path that persisted a member object it had read BEFORE the verification landed would
   * silently un-verify them — and `issue()`, `setMemberPrefs` and `markEmailVerified` all fire
   * upserts fire-and-forget, so the ordering between them is not something this code controls. The
   * founder's symptom would be the banner reappearing after they had cleared it, with no action of
   * their own and nothing in any log.
   */
  async upsertMember(m: StoredMember): Promise<void> {
    await this.pool.query(
      `INSERT INTO members (id, org_id, email, role, salt, hash, last_provider, providers, reset_hash, reset_expires, prefs,
                            email_verified_at, verify_hash, verify_expires, verify_sends)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (id) DO UPDATE SET role=EXCLUDED.role, salt=EXCLUDED.salt, hash=EXCLUDED.hash,
         last_provider=EXCLUDED.last_provider, providers=EXCLUDED.providers,
         reset_hash=EXCLUDED.reset_hash, reset_expires=EXCLUDED.reset_expires,
         prefs=EXCLUDED.prefs,
         email_verified_at=COALESCE(members.email_verified_at, EXCLUDED.email_verified_at),
         verify_hash=EXCLUDED.verify_hash, verify_expires=EXCLUDED.verify_expires,
         verify_sends=EXCLUDED.verify_sends`,
      [
        m.id, m.org_id, m.email, m.role, m.salt, m.hash,
        m.last_provider ?? null, JSON.stringify(m.providers ?? []),
        m.reset_hash ?? null, m.reset_expires ?? null,
        m.prefs ? JSON.stringify(m.prefs) : null,
        m.email_verified_at ?? null, m.verify_hash ?? null, m.verify_expires ?? null,
        m.verify_sends ? JSON.stringify(m.verify_sends) : null,
      ],
    );
  }
  async deleteMember(id: string): Promise<void> {
    await this.pool.query(`DELETE FROM members WHERE id=$1`, [id]);
  }
  async upsertInvite(i: StoredInvite): Promise<void> {
    await this.pool.query(
      `INSERT INTO invites (id, org_id, email, role, invited_by, token_hash, expires_at, accepted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (id) DO UPDATE SET accepted_at=EXCLUDED.accepted_at`,
      [i.id, i.org_id, i.email, i.role, i.invited_by, i.token_hash, i.expires_at, i.accepted_at ?? null],
    );
  }
  async deleteInvite(id: string): Promise<void> {
    await this.pool.query(`DELETE FROM invites WHERE id=$1`, [id]);
  }

  // ─── Sessions ───
  // The read-through source of truth. resolveSession hits its in-process cache first and falls back
  // here on a miss, which is what makes a session valid on an instance that did not mint it.

  /** One session by token hash, or undefined. Callers must still check `expires_at`. */
  async getSession(tokenHash: string): Promise<{ member_id: string; org_id: string; expires_at: number } | undefined> {
    const r = await this.pool.query(
      `SELECT member_id, org_id, expires_at FROM sessions WHERE token_hash=$1`,
      [tokenHash],
    );
    const row = r.rows[0] as { member_id: string; org_id: string; expires_at: string } | undefined;
    return row ? { member_id: row.member_id, org_id: row.org_id, expires_at: Number(row.expires_at) } : undefined;
  }
  /** Mint or slide a session. Keyed by hash; the raw token never reaches Postgres. */
  async upsertSession(s: { token_hash: string; member_id: string; org_id: string; expires_at: number }): Promise<void> {
    await this.pool.query(
      `INSERT INTO sessions (token_hash, member_id, org_id, expires_at) VALUES ($1,$2,$3,$4)
       ON CONFLICT (token_hash) DO UPDATE SET expires_at=EXCLUDED.expires_at`,
      [s.token_hash, s.member_id, s.org_id, s.expires_at],
    );
  }
  async deleteSession(tokenHash: string): Promise<void> {
    await this.pool.query(`DELETE FROM sessions WHERE token_hash=$1`, [tokenHash]);
  }
  /** Revoke every session a member holds — password reset and member removal both need this, and
   * they cannot walk the cache because a read-through cache only holds the sessions it has seen. */
  async deleteSessionsForMember(memberId: string): Promise<void> {
    await this.pool.query(`DELETE FROM sessions WHERE member_id=$1`, [memberId]);
  }
  async upsertApiKey(key: string, v: { project_id: string; org_id: string }): Promise<void> {
    await this.pool.query(
      `INSERT INTO api_keys (key, project_id, org_id) VALUES ($1,$2,$3) ON CONFLICT (key) DO NOTHING`,
      [key, v.project_id, v.org_id],
    );
  }

  async close(): Promise<void> {
    // No-op: the pool is shared process-wide. See pool.ts — the first store to end
    // it would close the connections every other store is still using. Shutdown calls
    // closeAllPools() once.
  }
}
