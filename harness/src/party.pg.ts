// Durable party credentials: minted links and exchanged sessions for third-party counterparties.
//
// Same failure modes as portal credentials before they landed in Postgres: a deploy silently
// invalidated every candidate / contractor link sitting in an inbox, and on more than one replica a
// link minted by A could not be exchanged on B. Only hashes are stored — a stolen database yields
// no working links.
import pg from "pg";
import { getPool } from "./pool";
import { withSchemaLock } from "./schema-lock";

export interface PartyLinkRow {
  hash: string;
  project_id: string;
  client_id: string;
  request_id: string;
  party_role: string;
  party_label?: string | null;
  expires_at: number;
  used: boolean;
  used_at?: number | null;
  session_token?: string | null;
}

export interface PartySessionRow {
  token: string;
  project_id: string;
  client_id: string;
  request_id: string;
  party_role: string;
  party_label?: string | null;
  expires_at: number;
}

export class PartyPg {
  private constructor(private pool: pg.Pool) {}

  static async connect(url: string): Promise<PartyPg> {
    const pool = getPool(url);
    const self = new PartyPg(pool);
    await withSchemaLock(pool, async (client) => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS party_links (
          hash text PRIMARY KEY,
          project_id text NOT NULL,
          client_id text NOT NULL,
          request_id text NOT NULL,
          party_role text NOT NULL,
          party_label text,
          expires_at bigint NOT NULL,
          used boolean NOT NULL DEFAULT false,
          used_at bigint,
          session_token text,
          created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS party_sessions (
          token text PRIMARY KEY,
          project_id text NOT NULL,
          client_id text NOT NULL,
          request_id text NOT NULL,
          party_role text NOT NULL,
          party_label text,
          expires_at bigint NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS party_sessions_request_idx ON party_sessions (request_id);
        CREATE INDEX IF NOT EXISTS party_links_request_idx ON party_links (request_id);
      `);
    });
    return self;
  }

  async putLink(l: PartyLinkRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO party_links
         (hash, project_id, client_id, request_id, party_role, party_label, expires_at, used)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (hash) DO UPDATE SET used = EXCLUDED.used`,
      [
        l.hash,
        l.project_id,
        l.client_id,
        l.request_id,
        l.party_role,
        l.party_label ?? null,
        l.expires_at,
        l.used,
      ],
    );
  }

  async claimLink(hash: string, now: number): Promise<PartyLinkRow | undefined> {
    const r = await this.pool.query(
      `UPDATE party_links SET used = true
       WHERE hash = $1 AND used = false AND expires_at > $2
       RETURNING hash, project_id, client_id, request_id, party_role, party_label, expires_at, used`,
      [hash, now],
    );
    const row = r.rows[0];
    return row
      ? {
          ...row,
          expires_at: Number(row.expires_at),
          party_label: row.party_label ?? undefined,
        }
      : undefined;
  }

  async noteLinkExchanged(hash: string, usedAt: number, sessionToken: string): Promise<void> {
    await this.pool.query(`UPDATE party_links SET used_at = $2, session_token = $3 WHERE hash = $1`, [
      hash,
      usedAt,
      sessionToken,
    ]);
  }

  async replayLink(
    hash: string,
    now: number,
    graceFloor: number,
  ): Promise<{ link: PartyLinkRow; session: PartySessionRow } | undefined> {
    const r = await this.pool.query(
      `SELECT l.hash, l.project_id, l.client_id, l.request_id, l.party_role, l.party_label,
              l.expires_at, l.used, l.used_at, l.session_token,
              s.token AS s_token, s.expires_at AS s_expires_at
         FROM party_links l
         JOIN party_sessions s ON s.token = l.session_token
        WHERE l.hash = $1 AND l.used_at IS NOT NULL AND l.used_at >= $2 AND s.expires_at > $3`,
      [hash, graceFloor, now],
    );
    const row = r.rows[0];
    if (!row) return undefined;
    return {
      link: {
        hash: row.hash,
        project_id: row.project_id,
        client_id: row.client_id,
        request_id: row.request_id,
        party_role: row.party_role,
        party_label: row.party_label ?? undefined,
        expires_at: Number(row.expires_at),
        used: row.used,
        used_at: Number(row.used_at),
        session_token: row.session_token,
      },
      session: {
        token: row.s_token,
        project_id: row.project_id,
        client_id: row.client_id,
        request_id: row.request_id,
        party_role: row.party_role,
        party_label: row.party_label ?? undefined,
        expires_at: Number(row.s_expires_at),
      },
    };
  }

  async putSession(s: PartySessionRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO party_sessions
         (token, project_id, client_id, request_id, party_role, party_label, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (token) DO NOTHING`,
      [
        s.token,
        s.project_id,
        s.client_id,
        s.request_id,
        s.party_role,
        s.party_label ?? null,
        s.expires_at,
      ],
    );
  }

  async getSession(token: string, now: number): Promise<PartySessionRow | undefined> {
    const r = await this.pool.query(
      `SELECT token, project_id, client_id, request_id, party_role, party_label, expires_at
         FROM party_sessions WHERE token=$1 AND expires_at > $2`,
      [token, now],
    );
    const row = r.rows[0];
    return row
      ? {
          ...row,
          expires_at: Number(row.expires_at),
          party_label: row.party_label ?? undefined,
        }
      : undefined;
  }

  async close(): Promise<void> {
    // Shared pool — see portal.pg.ts.
  }
}
