// Durable portal credentials: minted links and exchanged client sessions.
//
// These were in-process Maps, which was wrong in two ways that only show up in production. A deploy
// signed out every customer, silently — they'd click the link in their email and be told it was no
// longer valid. And on more than one replica, a link minted by A could not be exchanged on B, so the
// portal worked or didn't depending on which box the load balancer picked.
//
// Only hashes are stored, exactly as before: a stolen database yields no working links.
import pg from "pg";
import { getPool } from "./pool";
import { withSchemaLock } from "./schema-lock";

export interface PortalLinkRow {
  hash: string;
  project_id: string;
  client_id: string;
  expires_at: number;
  used: boolean;
}
export interface PortalSessionRow {
  token: string;
  project_id: string;
  client_id: string;
  expires_at: number;
}

export class PortalPg {
  private constructor(private pool: pg.Pool) {}

  static async connect(url: string): Promise<PortalPg> {
    const pool = getPool(url);
    const self = new PortalPg(pool);
      // Serialised across processes: `CREATE TABLE IF NOT EXISTS` is not concurrency-safe, and
      // four kernel containers boot together on every deploy. See schema-lock.ts.
    await withSchemaLock(pool, async (client) => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS portal_links (
          hash text PRIMARY KEY,
          project_id text NOT NULL,
          client_id text NOT NULL,
          expires_at bigint NOT NULL,
          used boolean NOT NULL DEFAULT false,
          created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS portal_sessions (
          token text PRIMARY KEY,
          project_id text NOT NULL,
          client_id text NOT NULL,
          expires_at bigint NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS portal_sessions_client_idx ON portal_sessions (client_id);
        CREATE INDEX IF NOT EXISTS portal_links_client_idx ON portal_links (client_id);
      `);
    });
    return self;
  }

  async putLink(l: PortalLinkRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO portal_links (hash, project_id, client_id, expires_at, used) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (hash) DO UPDATE SET used = EXCLUDED.used`,
      [l.hash, l.project_id, l.client_id, l.expires_at, l.used],
    );
  }

  /**
   * Claim a link, atomically.
   *
   * The single-use guarantee has to hold across replicas, so the check and the write are one
   * statement. Read-then-write would let two simultaneous clicks on the same emailed link both
   * succeed — which is exactly the race a forwarded email produces.
   */
  async claimLink(hash: string, now: number): Promise<PortalLinkRow | undefined> {
    const r = await this.pool.query(
      `UPDATE portal_links SET used = true
       WHERE hash = $1 AND used = false AND expires_at > $2
       RETURNING hash, project_id, client_id, expires_at, used`,
      [hash, now],
    );
    const row = r.rows[0];
    return row ? { ...row, expires_at: Number(row.expires_at) } : undefined;
  }

  async putSession(s: PortalSessionRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO portal_sessions (token, project_id, client_id, expires_at) VALUES ($1,$2,$3,$4)
       ON CONFLICT (token) DO NOTHING`,
      [s.token, s.project_id, s.client_id, s.expires_at],
    );
  }

  async getSession(token: string, now: number): Promise<PortalSessionRow | undefined> {
    const r = await this.pool.query(
      `SELECT token, project_id, client_id, expires_at FROM portal_sessions WHERE token=$1 AND expires_at > $2`,
      [token, now],
    );
    const row = r.rows[0];
    return row ? { ...row, expires_at: Number(row.expires_at) } : undefined;
  }

  /** Revoke everything for a client: sessions, and any link still sitting unexchanged in an inbox. */
  async revokeClient(clientId: string): Promise<number> {
    const s = await this.pool.query(`DELETE FROM portal_sessions WHERE client_id=$1`, [clientId]);
    await this.pool.query(`DELETE FROM portal_links WHERE client_id=$1 AND used=false`, [clientId]);
    return s.rowCount ?? 0;
  }

  async close(): Promise<void> {
    // No-op: the pool is shared process-wide. See pool.ts — the first store to end
    // it would close the connections every other store is still using. Shutdown calls
    // closeAllPools() once.
  }
}
