import type pg from "pg";

/**
 * Serialise schema creation across every process that shares a database.
 *
 * `CREATE TABLE IF NOT EXISTS` is NOT concurrency-safe in Postgres. Two connections both check,
 * both find nothing, both create, and the loser gets
 *
 *   duplicate key value violates unique constraint "pg_type_typname_nsp_index"
 *
 * because a table creates a row type and that index has no idea about IF NOT EXISTS. The same is
 * true of CREATE INDEX and ALTER TABLE ADD COLUMN.
 *
 * This is not theoretical here: the deployment runs two API replicas and two workers, so four
 * kernels call their init at once on every deploy, against one Supabase database. Found the first
 * time the suite ran against real Postgres rather than the in-memory store — the failure is a boot
 * crash on some fraction of containers, which reads as a flaky deploy rather than as a bug.
 *
 * An advisory lock is the right tool: it costs one round trip, it is released automatically if the
 * process dies holding it, and it serialises only the boot path.
 */

/**
 * The lock id. Arbitrary but must be identical in every process — a per-store id would let two
 * different stores race on the same `ALTER TABLE`, which is exactly the case that bit.
 */
const SCHEMA_LOCK_ID = 0x6d7963_65; // "myce"

export async function withSchemaLock<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  // A dedicated client, not `pool.query`: the lock and the DDL must be the same connection, and the
  // pool is free to hand two `pool.query` calls to two different ones.
  const client = await pool.connect();
  try {
    // TRANSACTION-scoped, and the DDL runs inside that same transaction.
    //
    // This was `pg_advisory_lock` + `pg_advisory_unlock`, which is session-scoped. That is correct
    // against a direct connection and quietly wrong through a transaction-mode pooler, where the
    // backend is returned to the pool at COMMIT: the lock would be released early, or released on
    // behalf of a different client, and the concurrent-DDL crash this exists to prevent would come
    // back on exactly the boots it was written for.
    //
    // The transaction-scoped form has no such ambiguity — the lock is released by COMMIT or
    // ROLLBACK, by definition, in either pooling mode. Postgres runs DDL transactionally, so
    // wrapping it costs nothing; a failed migration now rolls back whole rather than leaving half a
    // schema behind. (No `CREATE INDEX CONCURRENTLY` anywhere, which is the one thing that could
    // not live inside this transaction.)
    await client.query("BEGIN");
    try {
      await client.query("SELECT pg_advisory_xact_lock($1)", [SCHEMA_LOCK_ID]);
      // The callback runs its DDL on THIS client, not on the pool. Taking a second connection while
      // holding the lock doubles the connection cost of a boot and starves a small pool: with six
      // containers and a pool of five, two of them never get a client at all.
      const out = await fn(client);
      await client.query("COMMIT");
      return out;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    }
  } finally {
    client.release();
  }
}
