// Durable published pages. An in-memory Map dies on deploy, which would 404 every URL a client
// already opened — the exact silent failure portal links paid for before they landed in Postgres.
import pg from "pg";
import { getPool } from "./pool";
import { withSchemaLock } from "./schema-lock";
import type { PublishedPage } from "./pages";

export class PagesPg {
  private constructor(private pool: pg.Pool) {}

  static async connect(url: string): Promise<PagesPg> {
    const pool = getPool(url);
    await withSchemaLock(pool, async (client) => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS published_pages (
          token text PRIMARY KEY,
          id text NOT NULL,
          project_id text NOT NULL,
          html text NOT NULL,
          title text NOT NULL DEFAULT '',
          created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS published_pages_project_idx ON published_pages (project_id);
      `);
    });
    return new PagesPg(pool);
  }

  async put(p: PublishedPage): Promise<void> {
    await this.pool.query(
      `INSERT INTO published_pages (token, id, project_id, html, title, created_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (token) DO UPDATE SET html = EXCLUDED.html, title = EXCLUDED.title`,
      [p.token, p.id, p.project_id, p.html, p.title, p.created_at],
    );
  }

  async get(token: string): Promise<PublishedPage | undefined> {
    const r = await this.pool.query(
      `SELECT token, id, project_id, html, title, created_at FROM published_pages WHERE token = $1`,
      [token],
    );
    const row = r.rows[0];
    if (!row) return undefined;
    return {
      token: String(row.token),
      id: String(row.id),
      project_id: String(row.project_id),
      html: String(row.html),
      title: String(row.title ?? ""),
      created_at: new Date(row.created_at).toISOString(),
    };
  }

  async close(): Promise<void> {
    // No-op: the pool is shared process-wide. See pool.ts.
  }
}
