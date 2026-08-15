// Durable, append-only audit chain. There is no UPDATE and no DELETE here by design — the table is
// insert-only, and the per-project sequence is allocated under a row lock so two replicas can't
// fork the chain.
import pg from "pg";
import { getPool } from "./pool";
import { withSchemaLock } from "./schema-lock";
import { entryHash, GENESIS, type AuditEntry, type AuditStore } from "./audit";

const { Pool } = pg;

export class PostgresAuditStore implements AuditStore {
  private constructor(private pool: pg.Pool) {}

  static async connect(url: string): Promise<PostgresAuditStore> {
    const pool = getPool(url);
      // Serialised across processes: `CREATE TABLE IF NOT EXISTS` is not concurrency-safe, and
      // four kernel containers boot together on every deploy. See schema-lock.ts.
    await withSchemaLock(pool, async (client) => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS audit_log (
          project_id text NOT NULL,
          seq int NOT NULL,
          at timestamptz NOT NULL DEFAULT now(),
          actor text NOT NULL,
          action text NOT NULL,
          entity text NOT NULL,
          entity_id text NOT NULL,
          detail jsonb NOT NULL DEFAULT '{}',
          prev_hash text NOT NULL,
          hash text NOT NULL,
          PRIMARY KEY (project_id, seq)
        );
        CREATE TABLE IF NOT EXISTS audit_heads (
          project_id text PRIMARY KEY,
          seq int NOT NULL DEFAULT 0,
          hash text NOT NULL
        );
      `);
    });
    return new PostgresAuditStore(pool);
  }

  async append(e: Omit<AuditEntry, "seq" | "prev_hash" | "hash" | "at"> & { at?: string }): Promise<AuditEntry> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Lock the project's head so concurrent replicas serialize instead of forking the chain.
      const head = await client.query(
        `INSERT INTO audit_heads (project_id, seq, hash) VALUES ($1, 0, $2)
         ON CONFLICT (project_id) DO UPDATE SET project_id = audit_heads.project_id
         RETURNING seq, hash`,
        [e.project_id, GENESIS],
      );
      const prevSeq: number = head.rows[0].seq;
      const prevHash: string = head.rows[0].hash;
      const base = {
        seq: prevSeq + 1,
        project_id: e.project_id,
        at: e.at ?? new Date().toISOString(),
        actor: e.actor,
        action: e.action,
        entity: e.entity,
        entity_id: e.entity_id,
        detail: e.detail ?? {},
        prev_hash: prevHash,
      };
      const hash = entryHash(base);
      await client.query(
        `INSERT INTO audit_log (project_id, seq, at, actor, action, entity, entity_id, detail, prev_hash, hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [base.project_id, base.seq, base.at, base.actor, base.action, base.entity, base.entity_id,
         JSON.stringify(base.detail), base.prev_hash, hash],
      );
      await client.query(`UPDATE audit_heads SET seq=$2, hash=$3 WHERE project_id=$1`, [e.project_id, base.seq, hash]);
      await client.query("COMMIT");
      return { ...base, hash };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async list(projectId: string, limit = 500): Promise<AuditEntry[]> {
    const r = await this.pool.query(
      `SELECT * FROM audit_log WHERE project_id=$1 ORDER BY seq LIMIT $2`,
      [projectId, limit],
    );
    return r.rows.map((row: any) => ({
      seq: row.seq, project_id: row.project_id, at: new Date(row.at).toISOString(),
      actor: row.actor, action: row.action, entity: row.entity, entity_id: row.entity_id,
      detail: row.detail ?? {}, prev_hash: row.prev_hash, hash: row.hash,
    }));
  }

  async close(): Promise<void> {
    // No-op: the pool is shared process-wide. See pool.ts — the first store to end
    // it would close the connections every other store is still using. Shutdown calls
    // closeAllPools() once.
  }
}
