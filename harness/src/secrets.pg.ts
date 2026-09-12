// Durable vault. Stores ONLY sealed envelopes (AES-256-GCM ciphertext + iv + tag) — the plaintext
// never reaches this layer, so a database dump is useless without MYCEL_SECRET_KEY.
import pg from "pg";
import { getPool } from "./pool";
import { withSchemaLock } from "./schema-lock";
import type { SealedSecret, SecretStore } from "./secrets";

const { Pool } = pg;

export class PostgresSecretStore implements SecretStore {
  private constructor(private pool: pg.Pool) {}

  static async connect(url: string): Promise<PostgresSecretStore> {
    const pool = getPool(url);
    const self = new PostgresSecretStore(pool);
      // Serialised across processes: `CREATE TABLE IF NOT EXISTS` is not concurrency-safe, and
      // four kernel containers boot together on every deploy. See schema-lock.ts.
    await withSchemaLock(pool, async (client) => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS secrets (
          key text PRIMARY KEY,
          v int NOT NULL,
          kid text NOT NULL,
          iv text NOT NULL,
          tag text NOT NULL,
          ct text NOT NULL,
          updated_at timestamptz NOT NULL DEFAULT now()
        );
      `);
    });
    return self;
  }

  async put(key: string, s: SealedSecret): Promise<void> {
    await this.pool.query(
      `INSERT INTO secrets (key, v, kid, iv, tag, ct) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (key) DO UPDATE SET v=EXCLUDED.v, kid=EXCLUDED.kid, iv=EXCLUDED.iv,
         tag=EXCLUDED.tag, ct=EXCLUDED.ct, updated_at=now()`,
      [key, s.v, s.kid, s.iv, s.tag, s.ct],
    );
  }

  async get(key: string): Promise<SealedSecret | undefined> {
    const r = await this.pool.query(`SELECT v, kid, iv, tag, ct FROM secrets WHERE key=$1`, [key]);
    const row = r.rows[0];
    return row ? { v: row.v, kid: row.kid, iv: row.iv, tag: row.tag, ct: row.ct } : undefined;
  }

  async del(key: string): Promise<void> {
    await this.pool.query(`DELETE FROM secrets WHERE key=$1`, [key]);
  }

  async close(): Promise<void> {
    // No-op: the pool is shared process-wide. See pool.ts — the first store to end
    // it would close the connections every other store is still using. Shutdown calls
    // closeAllPools() once.
  }
}
