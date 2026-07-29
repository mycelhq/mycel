// Durable identity: orgs, projects, members, and product API keys. The in-memory IdentityStore
// keeps a read cache (auth is on every request, so lookups stay synchronous); this is the source
// of truth at boot and the write-through target. Sessions stay in-memory by design — they're
// short-lived tokens, and a restart should log members out.
import pg from "pg";
import type { Org, Project, Role, StoredMember } from "./identity";

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
    `);
    return self;
  }

  async loadAll(): Promise<{
    orgs: Org[];
    projects: Project[];
    members: StoredMember[];
    apiKeys: Map<string, { project_id: string; org_id: string }>;
  }> {
    const [o, p, m, k] = await Promise.all([
      this.pool.query(`SELECT * FROM orgs`),
      this.pool.query(`SELECT * FROM projects`),
      this.pool.query(`SELECT * FROM members`),
      this.pool.query(`SELECT * FROM api_keys`),
    ]);
    return {
      orgs: o.rows.map((r: any) => ({ id: r.id, name: r.name, created_at: iso(r.created_at) })),
      projects: p.rows.map((r: any) => ({ id: r.id, org_id: r.org_id, name: r.name, wedges: r.wedges ?? [], created_at: iso(r.created_at) })),
      members: m.rows.map((r: any) => ({
        id: r.id, org_id: r.org_id, email: r.email, role: r.role as Role,
        created_at: iso(r.created_at), salt: r.salt, hash: r.hash,
      })),
      apiKeys: new Map(k.rows.map((r: any) => [r.key, { project_id: r.project_id, org_id: r.org_id }])),
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
      `INSERT INTO members (id, org_id, email, role, salt, hash) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (id) DO UPDATE SET role=EXCLUDED.role, salt=EXCLUDED.salt, hash=EXCLUDED.hash`,
      [m.id, m.org_id, m.email, m.role, m.salt, m.hash],
    );
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
