import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { getPool } from "../pool";
import { databaseUrl } from "../config";
import * as schema from "./schema";

export * as schema from "./schema";
export * from "./schema";

/**
 * A TYPED HANDLE ON THE SAME DATABASE THE RAW QUERIES USE.
 *
 * ═══ What this is, and what it is deliberately not ═══
 *
 * This kernel has 167 raw SQL queries across 17 `*.pg.ts` stores, and they are not going anywhere.
 * They carry real reasoning in their comments — compare-and-set semantics, why a particular lock is
 * taken, why a write is idempotent — and an ORM that hid the SQL would fight that rather than help
 * it. Rewriting them all would be a large, risky diff in exchange for nothing a reader gains.
 *
 * So this is **step one and it rewrites no queries**. What it adds is a schema the compiler knows
 * about (`./schema.ts`, generated from the DDL) and a `db` to write NEW queries against. The stores
 * keep their SQL; anything written from here on gets checked.
 *
 * ═══ The class of bug this exists to catch ═══
 *
 * Four queries written against this database in one afternoon referenced `tasks.output`,
 * `events.created_at`, the table `standing_grants`, and `rules.source`. None of those exist — the
 * real names are the artifact/event log, `events.ts`, `grants`, and `rules.provenance`. Every one of
 * them typechecked, because a query is a string, and every one failed when it reached Postgres.
 *
 * That is not carelessness that more care fixes. With 48 tables and 504 columns, the name of a
 * column is a fact nobody holds in their head, and a string containing it is a fact the compiler is
 * not allowed to check. `db.select().from(tasks)` is.
 *
 * ═══ It shares the pool, on purpose ═══
 *
 * `getPool` is the one place a `pg.Pool` is constructed in this process, for a reason written out at
 * length there: a Supabase nano session pooler allows 15 clients, every store used to open its own
 * pool, and four containers on a deploy asked for 240 connections. A second pool here — which is
 * what `drizzle(connectionString)` would create — would reintroduce exactly that, and it would do so
 * invisibly until a deploy under load.
 *
 * ═══ Null when there is no database, like every other store ═══
 *
 * The kernel runs against an in-memory backend when `MYCEL_DATABASE_URL` is unset — that is how the
 * test suite and a local `npm run demo` work (`initDomainStore`). `getDb()` answers `null` in that
 * case rather than throwing, so importing this module is always safe and a caller has to decide what
 * to do without one. A module-scope connection would make merely importing this file a hard
 * dependency on a configured database, which would break the suite.
 */
export type Db = NodePgDatabase<typeof schema>;

let cached: Db | null = null;
let cachedUrl: string | null = null;

/**
 * The handle, or `null` when this process has no database.
 *
 * Re-derives when the URL changes rather than caching unconditionally: the test suite sets
 * `MYCEL_DATABASE_URL` per-case in places, and a handle pinned to the first URL ever seen would
 * silently answer for the wrong database.
 */
export function getDb(): Db | null {
  const url = databaseUrl();
  if (!url) return null;
  if (cached && cachedUrl === url) return cached;
  cached = drizzle(getPool(url), { schema });
  cachedUrl = url;
  return cached;
}
