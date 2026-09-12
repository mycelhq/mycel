import { sql } from "drizzle-orm";
import { getTableColumns, getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { getDb } from "./index";
import * as schema from "./schema";

/**
 * DOES THE LIVE DATABASE LOOK LIKE THE SCHEMA WE DECLARE?
 *
 * ─── The gap this closes, and why it exists at all ────────────────────────────────────────────
 *
 * `src/db/schema.ts` is generated from the DDL in `src/*.pg.ts`, and `test/schema-is-current.test.ts`
 * keeps the two in step. That chain proves the declaration matches WHAT THE CODE WOULD CREATE. It
 * proves nothing about what is actually in the database.
 *
 * Those can differ, and not hypothetically:
 *
 *   · A column added by hand in the Supabase console, or dropped there.
 *   · An `ALTER TABLE … ADD COLUMN` that ran against a database which already had a column of the
 *     same name and a different type — `IF NOT EXISTS` succeeds and changes nothing.
 *   · A deploy where `initSchema` failed partway under the schema lock; every statement before the
 *     failure applied and every one after it did not.
 *   · A database restored from a backup older than a column.
 *
 * Generating the declaration from the DDL was the right call (introspection needs a live connection,
 * which a build does not have) and this is the price of it: the in-repo chain is airtight and ends
 * one step short of the thing that matters. So this closes the loop at boot, where a connection
 * exists.
 *
 * ─── It reports. It does not fix, and it does not refuse ──────────────────────────────────────
 *
 * No DDL, no migration, no throw. A kernel that refused to boot because a column it has never
 * queried is missing would turn a cosmetic drift into an outage, and the most likely reading of a
 * discrepancy is that somebody is mid-deploy. It logs, once, at boot, and the log names the columns.
 *
 * Extra columns in the database are NOT reported. Plenty exist legitimately — Supabase's own
 * machinery, and columns from features removed in code but left in the table because dropping a
 * column is the one schema change that loses data. Only the direction that breaks a query is worth a
 * line of output: something we declare, and therefore might select, that is not there.
 *
 * ─── A guard must be a reading, not a setting ─────────────────────────────────────────────────
 *
 * It queries `information_schema.columns` and compares names. It does not consult a version number,
 * a migration table, or a flag saying the schema is fine — all of which can be true while the
 * database is not. If there is no database (the in-memory backend the test suite runs on) it
 * answers `null`, which is "not checked", and the caller says nothing.
 */

export interface SchemaDrift {
  /** Declared and absent from the database. These are the ones that break a query. */
  missing: { table: string; column: string }[];
  /** Declared tables with no row in `information_schema` at all. */
  missingTables: string[];
  /** How much was compared, so "no drift" can be told apart from "nothing ran". */
  checked: { tables: number; columns: number };
}

/** Every `pgTable` in the generated schema, as `[name, columns]`. */
function declared(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const value of Object.values(schema)) {
    // `is(value, PgTable)` rather than a duck-type check: the module also re-exports its own
    // namespace, and `getTableColumns` on a non-table throws rather than returning nothing.
    if (!is(value, PgTable)) continue;
    out.set(
      getTableName(value),
      new Set(Object.values(getTableColumns(value)).map((c) => c.name)),
    );
  }
  return out;
}

/**
 * Compare, or `null` when this process has no database.
 *
 * One query for every column in the `public` schema, rather than one query per table: 48 round trips
 * at boot to answer a question nobody is waiting on would be a real cost for no benefit.
 */
export async function verifyLiveSchema(): Promise<SchemaDrift | null> {
  const db = getDb();
  if (!db) return null;

  const want = declared();

  const rows = await db.execute<{ table_name: string; column_name: string }>(
    sql`select table_name, column_name from information_schema.columns where table_schema = 'public'`,
  );

  const live = new Map<string, Set<string>>();
  // `db.execute` answers a driver result, not an array — node-postgres returns `{ rows }`.
  for (const row of rows.rows) {
    if (!live.has(row.table_name)) live.set(row.table_name, new Set());
    live.get(row.table_name)!.add(row.column_name);
  }

  const missing: { table: string; column: string }[] = [];
  const missingTables: string[] = [];
  let columns = 0;

  for (const [table, cols] of want) {
    const there = live.get(table);
    if (!there) {
      missingTables.push(table);
      continue;
    }
    for (const column of cols) {
      columns++;
      if (!there.has(column)) missing.push({ table, column });
    }
  }

  return { missing, missingTables, checked: { tables: want.size - missingTables.length, columns } };
}

/**
 * The boot-time call. Logs a discrepancy and otherwise says nothing.
 *
 * Silent on success on purpose: a line every boot saying the schema is fine is a line nobody reads,
 * and it is the line that makes the one saying otherwise easy to miss. Never throws — a failed
 * verification is a failed verification, not a failed boot.
 */
export async function reportSchemaDrift(): Promise<void> {
  try {
    const drift = await verifyLiveSchema();
    if (!drift) return;
    if (drift.missingTables.length) {
      console.error(`[mycel] schema: declared tables absent from the database: ${drift.missingTables.join(", ")}`);
    }
    if (drift.missing.length) {
      const named = drift.missing.map((m) => `${m.table}.${m.column}`).join(", ");
      console.error(`[mycel] schema: declared columns absent from the database: ${named}`);
    }
  } catch (e) {
    // A permissions error reading `information_schema`, a connection lost mid-boot. Worth a line,
    // never worth the process.
    console.error(`[mycel] schema: could not verify against the database: ${(e as Error).message}`);
  }
}
