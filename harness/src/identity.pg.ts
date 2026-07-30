// Durable identity: orgs, projects, members, and product API keys. The in-memory IdentityStore
// keeps a read cache (auth is on every request, so lookups stay synchronous); this is the source
// of truth at boot and the write-through target. Sessions stay in-memory by design — they're
// short-lived tokens, and a restart should log members out.
import pg from "pg";
import type { Org, Project, Role, StoredInvite, StoredMember } from "./identity";

const { Pool } = pg;
const iso = (v: unknown) => new Date(v as string).toISOString();

export class IdentityPg {
  private constructor(private pool: pg.Pool) {}

  static async connect(url: string): Promise<IdentityPg> {
    const pool = new Pool({ connectionString: url });
    const self = new IdentityPg(pool);
    await self.pool.query(`
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
    await self.pool.query(`
      ALTER TABLE members ADD COLUMN IF NOT EXISTS last_provider text;
      ALTER TABLE members ADD COLUMN IF NOT EXISTS providers jsonb NOT NULL DEFAULT '[]';
      ALTER TABLE members ADD COLUMN IF NOT EXISTS reset_hash text;
      ALTER TABLE members ADD COLUMN IF NOT EXISTS reset_expires bigint;
    `);
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
      orgs: o.rows.map((r: any) => ({ id: r.id, name: r.name, created_at: iso(r.created_at) })),
      projects: p.rows.map((r: any) => ({ id: r.id, org_id: r.org_id, name: r.name, wedges: r.wedges ?? [], created_at: iso(r.created_at) })),
      members: m.rows.map((r: any) => ({
        id: r.id, org_id: r.org_id, email: r.email, role: r.role as Role,
        created_at: iso(r.created_at), salt: r.salt, hash: r.hash,
        last_provider: r.last_provider ?? undefined,
        providers: r.providers ?? [],
        reset_hash: r.reset_hash ?? undefined,
        // bigint arrives as a string from pg; Number() here or every expiry comparison is false.
        reset_expires: r.reset_expires === null || r.reset_expires === undefined ? undefined : Number(r.reset_expires),
      })),
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

  async upsertOrg(o: Org): Promise<void> {
    await this.pool.query(
      `INSERT INTO orgs (id, name) VALUES ($1,$2) ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name`,
      [o.id, o.name],
    );
  }
  async upsertProject(p: Project): Promise<void> {
    await this.pool.query(
      `INSERT INTO projects (id, org_id, name, wedges) VALUES ($1,$2,$3,$4)
       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, wedges=EXCLUDED.wedges`,
      [p.id, p.org_id, p.name, JSON.stringify(p.wedges ?? [])],
    );
  }
  async upsertMember(m: StoredMember): Promise<void> {
    await this.pool.query(
      `INSERT INTO members (id, org_id, email, role, salt, hash, last_provider, providers, reset_hash, reset_expires)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO UPDATE SET role=EXCLUDED.role, salt=EXCLUDED.salt, hash=EXCLUDED.hash,
         last_provider=EXCLUDED.last_provider, providers=EXCLUDED.providers,
         reset_hash=EXCLUDED.reset_hash, reset_expires=EXCLUDED.reset_expires`,
      [
        m.id, m.org_id, m.email, m.role, m.salt, m.hash,
        m.last_provider ?? null, JSON.stringify(m.providers ?? []),
        m.reset_hash ?? null, m.reset_expires ?? null,
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
  async upsertApiKey(key: string, v: { project_id: string; org_id: string }): Promise<void> {
    await this.pool.query(
      `INSERT INTO api_keys (key, project_id, org_id) VALUES ($1,$2,$3) ON CONFLICT (key) DO NOTHING`,
      [key, v.project_id, v.org_id],
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
