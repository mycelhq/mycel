// Durable Postgres backing for services the kernel wrote. Mirrors requests.pg.ts exactly: raw SQL,
// the table created on connect under the schema lock, one shared pool, selected automatically when
// MYCEL_DATABASE_URL is set.
//
// The two guarantees this backend owns, both single statements on purpose:
//
//   1. `decide` carries `AND status = 'drafted'` in its WHERE. Promotion is the human gate; two tabs
//      clicking "run this" must not both promote, and — worse — a promote racing a reject must not
//      leave a service running that somebody declined. A read-check-write here lets both happen.
//   2. Every read names `project_id` in the WHERE clause, including the by-slug one. Not a filter
//      applied to a result — a filter the row never escapes. `slug` is NOT unique on its own: two
//      businesses may both have a service called `drafted:proposal-desk`, and they are different
//      services. The primary key is therefore the pair.
//
// The mechanical parts (row mapping, the WHERE builder) are pure exported functions rather than
// methods, because there is no Postgres in the test environment and tenancy is exactly the part
// worth verifying without one. See test/authored-pg.test.ts.
import { randomUUID } from "node:crypto";
import { getPool } from "./pool";
import { withSchemaLock } from "./schema-lock";
import { isAuthoredSlug, type WedgeFile, type WedgeManifest } from "./wedge";
import type { AuthoredFilter, AuthoredStatus, AuthoredStore, AuthoredWedge, NewAuthoredWedge } from "./authored";

/** The narrow slice of `pg.Pool` this store uses — see the identical seam in requests.pg.ts. */
export interface Queryable {
  query(sql: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

const iso = (v: unknown) => (v === null || v === undefined ? undefined : new Date(v as string).toISOString());

/**
 * The schema.
 *
 * `slug` is `text` and the key is `(project_id, slug)` — see guarantee 2 above. `manifest`, `skills`
 * and `knowledge` are `jsonb` because they are exactly the JSON documents `loadWedge` would have
 * read off disk; shredding them into relational columns would mean this table needs a migration
 * every time `WedgeManifest` grows a field, and `WEDGE_MANIFEST_KEYS` already validates the shape.
 *
 * `status` has no CHECK constraint and that is deliberate rather than sloppy: the vocabulary lives
 * in `AuthoredStatus` and is enforced by the only two writers in this file, and a CHECK would be a
 * second copy that has to be migrated in lockstep with a TypeScript union. What the column DOES
 * carry is `NOT NULL DEFAULT 'drafted'`, so a row inserted by any future writer that forgot to say
 * is a draft — the fail-closed direction.
 */
async function initSchema(pool: Queryable): Promise<void> {
  // Serialised across processes: `CREATE TABLE IF NOT EXISTS` is not concurrency-safe, and several
  // kernel containers boot together on every deploy. See schema-lock.ts.
  await withSchemaLock(pool as never, async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS authored_wedges (
        id text NOT NULL,
        project_id text NOT NULL,
        slug text NOT NULL,
        title text NOT NULL,
        manifest jsonb NOT NULL,
        skills jsonb NOT NULL DEFAULT '[]'::jsonb,
        knowledge jsonb NOT NULL DEFAULT '[]'::jsonb,
        status text NOT NULL DEFAULT 'drafted',
        described_as text NOT NULL DEFAULT '',
        source_task_id text,
        decided_by text,
        decided_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (project_id, slug)
      );
      CREATE INDEX IF NOT EXISTS authored_wedges_scope_idx
        ON authored_wedges (project_id, status, created_at DESC);
    `);
  });
}

/**
 * A row as the domain object.
 *
 * `manifest` comes back from `jsonb` already parsed by `pg`, but a row written by an older shape —
 * or by a hand-run `INSERT` — can carry a string. Parsing tolerantly and falling back to an EMPTY
 * manifest rather than throwing is the honest failure here: an unreadable definition must read as a
 * service that declares no jobs (so nothing can be spawned against it) rather than as a 500 that
 * takes the whole services list down for the tenant.
 */
export function rowToAuthored(row: any): AuthoredWedge {
  return {
    id: String(row.id),
    project_id: String(row.project_id),
    slug: String(row.slug),
    title: String(row.title ?? ""),
    manifest: json<WedgeManifest>(row.manifest, { wedge: String(row.slug) } as WedgeManifest),
    skills: json<WedgeFile[]>(row.skills, []),
    knowledge: json<WedgeFile[]>(row.knowledge, []),
    status: String(row.status ?? "drafted") as AuthoredStatus,
    described_as: String(row.described_as ?? ""),
    source_task_id: row.source_task_id ?? undefined,
    decided_by: row.decided_by ?? undefined,
    decided_at: iso(row.decided_at),
    created_at: iso(row.created_at) ?? new Date().toISOString(),
    updated_at: iso(row.updated_at) ?? new Date().toISOString(),
  };
}

function json<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "string") return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/**
 * The list query. Pure and exported so a test without Postgres can assert that `project_id` is `$1`.
 *
 * `LIMIT` is clamped to [1, 500] here rather than trusted from the caller, matching every other
 * list builder in this codebase: a `limit=0` that reads as "no limit" is how one tenant's list route
 * becomes a full table scan.
 */
export function buildAuthoredListQuery(f: AuthoredFilter): { sql: string; values: unknown[] } {
  const values: unknown[] = [f.project_id];
  let sql = `SELECT * FROM authored_wedges WHERE project_id = $1`;
  if (f.status) {
    values.push(f.status);
    sql += ` AND status = $${values.length}`;
  }
  values.push(Math.min(Math.max(f.limit ?? 50, 1), 500));
  sql += ` ORDER BY created_at DESC LIMIT $${values.length}`;
  return { sql, values };
}

export class PostgresAuthoredStore implements AuthoredStore {
  private constructor(private readonly pool: Queryable) {}

  static async connect(url: string): Promise<PostgresAuthoredStore> {
    const pool = getPool(url);
    await initSchema(pool);
    return new PostgresAuthoredStore(pool);
  }

  /** Test seam — see requests.pg.ts's `_withQueryable` for why this exists. */
  static _withQueryable(db: Queryable): PostgresAuthoredStore {
    return new PostgresAuthoredStore(db);
  }

  async createDraft(r: NewAuthoredWedge): Promise<AuthoredWedge> {
    if (!r.project_id) throw new Error("a written service must belong to a project");
    if (!isAuthoredSlug(r.slug)) {
      throw new Error(`a written service must be filed under an authored slug, got "${r.slug}"`);
    }
    // Re-drafting replaces a previous DRAFT and leaves a promoted service alone — the `WHERE
    // authored_wedges.status = 'drafted'` on the conflict clause. A founder asking us to try again
    // must not silently rewrite the definition of something already running for their clients.
    const res = await this.pool.query(
      `INSERT INTO authored_wedges
         (id, project_id, slug, title, manifest, skills, knowledge, status, described_as, source_task_id)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,'drafted',$8,$9)
       ON CONFLICT (project_id, slug) DO UPDATE
         SET title=EXCLUDED.title, manifest=EXCLUDED.manifest, skills=EXCLUDED.skills,
             knowledge=EXCLUDED.knowledge, described_as=EXCLUDED.described_as,
             source_task_id=EXCLUDED.source_task_id, updated_at=now()
         WHERE authored_wedges.status = 'drafted'
       RETURNING *`,
      [
        randomUUID(), r.project_id, r.slug, r.title,
        JSON.stringify(r.manifest), JSON.stringify(r.skills), JSON.stringify(r.knowledge),
        r.described_as ?? "", r.source_task_id ?? null,
      ],
    );
    if (res.rows[0]) return rowToAuthored(res.rows[0]);
    // The conflict clause declined, which means a promoted row is already there. Returning it is the
    // in-memory store's behaviour too, and it is the truthful answer: this is the service you have.
    const existing = await this.getAuthored(r.project_id, r.slug);
    if (!existing) throw new Error(`could not file the written service "${r.slug}"`);
    return existing;
  }

  async getAuthored(projectId: string, slug: string): Promise<AuthoredWedge | undefined> {
    if (!projectId) return undefined;
    // The tenant is in the WHERE, not in a check afterwards. A post-read `if (row.project_id …)` is
    // one early return away from being skipped; this one cannot be.
    const res = await this.pool.query(`SELECT * FROM authored_wedges WHERE project_id=$1 AND slug=$2`, [projectId, slug]);
    return res.rows[0] ? rowToAuthored(res.rows[0]) : undefined;
  }

  async listAuthored(f: AuthoredFilter): Promise<AuthoredWedge[]> {
    if (!f.project_id) throw new Error("listing written services requires a project_id");
    const { sql, values } = buildAuthoredListQuery(f);
    const res = await this.pool.query(sql, values);
    return res.rows.map(rowToAuthored);
  }

  async decide(
    projectId: string,
    slug: string,
    status: Exclude<AuthoredStatus, "drafted">,
    by: string,
  ): Promise<AuthoredWedge | undefined> {
    const res = await this.pool.query(
      `UPDATE authored_wedges
          SET status=$3, decided_by=$4, decided_at=now(), updated_at=now()
        WHERE project_id=$1 AND slug=$2 AND status='drafted'
        RETURNING *`,
      [projectId, slug, status, by],
    );
    return res.rows[0] ? rowToAuthored(res.rows[0]) : undefined;
  }

  async close(): Promise<void> {
    // The pool is shared and ended once, in index.ts's `closeAllPools`.
  }
}
