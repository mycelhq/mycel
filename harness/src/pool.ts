import pg from "pg";

const { Pool } = pg;

/**
 * One Postgres pool per process.
 *
 * Every store used to construct its own — tasks, domain, identity, secrets, audit, portal — so a
 * single kernel opened six pools, each defaulting to node-pg's max of 10. Four containers on a
 * deploy could therefore ask for 240 connections.
 *
 * A Supabase nano session pooler allows 15. The failure is not subtle and it is not graceful:
 *
 *   (EMAXCONNSESSION) max clients reached in session mode - max clients are limited to pool_size: 15
 *
 * Found by pointing the test suite at the real database. Against the in-memory store, and against a
 * local Postgres with a 100-connection default, six pools looks exactly like one.
 *
 * `MYCEL_PG_POOL_MAX` is deliberately small. These are mostly-idle connections serving short
 * queries; the scaling lever is the number of workers, not the depth of one worker's pool.
 */
const POOL_MAX = Number(process.env.MYCEL_PG_POOL_MAX ?? 5);

const pools = new Map<string, pg.Pool>();

export function getPool(url: string): pg.Pool {
  const hit = pools.get(url);
  if (hit) return hit;
  const pool = new Pool({
    connectionString: url,
    max: POOL_MAX,
    // A connection that has been idle for half a minute is cheaper to re-open than to hold against
    // a pooler with a hard client ceiling shared by every replica.
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
  });
  // node-pg emits `error` on idle clients killed server-side (a pooler restart, a failover). With
  // no listener that is an unhandled 'error' event, which takes the whole process down.
  pool.on("error", (e) => console.error("[mycel] idle pg client error:", e.message));
  pools.set(url, pool);
  return pool;
}

/**
 * Close every pool. Called once at shutdown.
 *
 * Individual stores must NOT call `pool.end()` — they share this, and the first one to close would
 * take the others down with it. Their `close()` methods are no-ops for exactly that reason.
 */
export async function closeAllPools(): Promise<void> {
  await Promise.all([...pools.values()].map((p) => p.end().catch(() => {})));
  pools.clear();
}
