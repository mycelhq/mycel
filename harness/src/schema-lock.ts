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
  // A dedicated client, not `pool.query`: a session-level advisory lock belongs to the connection
  // that took it, and the pool is free to hand the release to a different one.
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [SCHEMA_LOCK_ID]);
    try {
      // The callback runs its DDL on THIS client, not on the pool. Taking a second connection
      // while holding the lock doubles the connection cost of a boot and starves a small pool:
      // with six containers and a pool of five, two of them never get a client at all.
      return await fn(client);
    } finally {
      // Best effort. If this throws, the lock dies with the session anyway.
      await client.query("SELECT pg_advisory_unlock($1)", [SCHEMA_LOCK_ID]).catch(() => {});
    }
  } finally {
    client.release();
  }
}
