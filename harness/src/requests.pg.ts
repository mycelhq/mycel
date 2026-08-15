// Durable Postgres backing for client requests. Mirrors billing.pg.ts: raw SQL, the table created
// on connect under the schema lock, one shared pool, selected automatically when
// MYCEL_DATABASE_URL is set.
//
// The two guarantees this backend owns, both of which are single statements on purpose:
//
//   1. `resolveRequest` carries `AND status = 'open'` in its WHERE. Answering a request spawns the
//      run that was waiting; two tabs answering the same request must not spawn it twice, and a
//      read-check-write here lets them.
//   2. Every read names `project_id` in the WHERE clause, including the by-id ones. Not a filter
//      applied to a result — a filter the row never escapes.
//
// The mechanical parts (row mapping, the WHERE builder) are pure exported functions rather than
// methods, because there is no Postgres in the test environment and tenancy is exactly the part
// worth verifying without one. See test/requests-pg.test.ts.
import { randomUUID } from "node:crypto";
import { getPool } from "./pool";
import { withSchemaLock } from "./schema-lock";
import type { ClientRequest, ClientRequestKind, ClientRequestStatus } from "./contract";
import type { NewClientRequest, RequestFilter, RequestStore } from "./requests";
import { normalizeToolkit, rankRequests } from "./requests";

/** The narrow slice of `pg.Pool` this store uses — see the identical seam in billing.pg.ts. */
export interface Queryable {
  query(sql: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

const iso = (v: unknown) => (v === null || v === undefined ? undefined : new Date(v as string).toISOString());

/**
 * The schema.
 *
 * `id`/`client_id`/`case_id`/`thread_id`/`task_id` are `text`, not `uuid`, for the reason spelled
 * out in billing.pg.ts: these ids arrive straight from a URL path, and `WHERE id = $1` against a
 * `uuid` column raises 22P02 on a malformed id — a 500 where the in-memory store returns undefined
 * and the route returns 404. A probe for someone else's request must look exactly like a typo.
 *
 * `project_id` is NOT NULL. `ClientRequest.project_id` is required in the contract precisely so the
 * tenant filter can fail closed with no legacy-NULL exception; the column says the same thing.
 */
async function initSchema(pool: Queryable): Promise<void> {
  // Serialised across processes: `CREATE TABLE IF NOT EXISTS` is not concurrency-safe, and four
  // kernel containers boot together on every deploy. See schema-lock.ts.
  await withSchemaLock(pool as never, async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS client_requests (
        id text PRIMARY KEY,
        project_id text NOT NULL,
        client_id text NOT NULL,
        case_id text,
        thread_id text,
        task_id text,
        kind text NOT NULL,
        ask text NOT NULL,
        detail text,
        status text NOT NULL DEFAULT 'open',
        due_at timestamptz,
        response text,
        resolved_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      -- Every portal read is "this client's requests, in this project". project_id leads so the
      -- query never touches another tenant's rows on its way to finding none of them.
      CREATE INDEX IF NOT EXISTS client_requests_portal_idx
        ON client_requests (project_id, client_id, status, created_at DESC);
    `);
    /**
     * The nudge pacing columns, added to a table that already exists in production.
     *
     * `ADD COLUMN IF NOT EXISTS` and not a change to the CREATE above: every deployed kernel already
     * has this table, and `CREATE TABLE IF NOT EXISTS` is a no-op against it — so a column only
     * declared up there would exist on fresh databases and be missing on every real one, which is
     * the shape of outage that reaches production and not staging.
     *
     * `nudge_count` is NOT NULL DEFAULT 0 so `nudge_count < $max` in the claim can never be NULL,
     * which in SQL is not false — it is unknown, and an unknown in a WHERE clause silently refuses
     * every row. A pacing guard that quietly refuses everything looks exactly like a pacing guard
     * that works.
     */
    await client.query(`
      ALTER TABLE client_requests ADD COLUMN IF NOT EXISTS last_nudged_at timestamptz;
      ALTER TABLE client_requests ADD COLUMN IF NOT EXISTS nudge_count integer NOT NULL DEFAULT 0;
      ALTER TABLE client_requests ADD COLUMN IF NOT EXISTS response_artifact_ids jsonb;
      ALTER TABLE client_requests ADD COLUMN IF NOT EXISTS connection_toolkit text;
      ALTER TABLE client_requests ADD COLUMN IF NOT EXISTS party_role text;
      ALTER TABLE client_requests ADD COLUMN IF NOT EXISTS party_label text;
      ALTER TABLE client_requests ADD COLUMN IF NOT EXISTS party_email text;
    `);
  });
}

export function rowToRequest(r: any): ClientRequest {
  return {
    id: r.id,
    project_id: r.project_id,
    client_id: r.client_id,
    case_id: r.case_id ?? undefined,
    thread_id: r.thread_id ?? undefined,
    task_id: r.task_id ?? undefined,
    kind: r.kind as ClientRequestKind,
    ask: r.ask,
    detail: r.detail ?? undefined,
    status: r.status as ClientRequestStatus,
    due_at: iso(r.due_at),
    response: r.response ?? undefined,
    response_artifact_ids: Array.isArray(r.response_artifact_ids)
      ? r.response_artifact_ids.map(String)
      : typeof r.response_artifact_ids === "string"
        ? (JSON.parse(r.response_artifact_ids) as unknown[]).map(String)
        : undefined,
    connection_toolkit: r.connection_toolkit ?? undefined,
    party_role: r.party_role ?? undefined,
    party_label: r.party_label ?? undefined,
    party_email: r.party_email ?? undefined,
    resolved_at: iso(r.resolved_at),
    last_nudged_at: iso(r.last_nudged_at),
    nudge_count: Number(r.nudge_count ?? 0),
    created_at: new Date(r.created_at).toISOString(),
    updated_at: new Date(r.updated_at).toISOString(),
  };
}

/**
 * The list WHERE clause.
 *
 * `project_id` is always `$1` and is never conditional. Every other predicate is optional; that one
 * is structural, so there is no arrangement of caller input that produces a query without it.
 */
export function buildListQuery(f: RequestFilter): { sql: string; values: unknown[] } {
  const where = ["project_id = $1"];
  const values: unknown[] = [f.project_id];
  const add = (col: string, v: unknown) => {
    values.push(v);
    where.push(`${col} = $${values.length}`);
  };
  if (f.client_id) add("client_id", f.client_id);
  if (f.case_id) add("case_id", f.case_id);
  if (f.thread_id) add("thread_id", f.thread_id);
  if (f.status) add("status", f.status);
  values.push(Math.max(1, Math.min(500, f.limit ?? 200)));
  return {
    sql: `SELECT * FROM client_requests WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT $${values.length}`,
    values,
  };
}

/**
 * The nudge claim, as a pure function of its arguments.
 *
 * Exported and pure for the same reason `buildListQuery` is: there is no Postgres in the test
 * environment, and the part worth verifying without one is that the tenant and both pacing guards
 * are in the WHERE clause rather than in a caller's `if`. See test/requests-pg.test.ts.
 *
 * Every guard is structural. `project_id` is never conditional; `status='open'` stops a nudge about
 * something the client already sent; `last_nudged_at IS NULL OR last_nudged_at <= $` is the pacing
 * compare-and-set; `nudge_count < $` is the budget. A row that fails any of them is not returned,
 * and a caller that gets nothing back sends nothing.
 */
export function nudgeClaimUpdate(a: {
  project_id: string;
  id: string;
  notNudgedSince: string;
  maxNudges: number;
  at: string;
}): { sql: string; values: unknown[] } {
  return {
    sql: `UPDATE client_requests
             SET last_nudged_at = $5, nudge_count = nudge_count + 1, updated_at = now()
           WHERE id = $1
             AND project_id = $2
             AND status = 'open'
             AND (last_nudged_at IS NULL OR last_nudged_at <= $3)
             AND nudge_count < $4
           RETURNING *`,
    values: [a.id, a.project_id, a.notNudgedSince, a.maxNudges, a.at],
  };
}

export class PostgresRequestStore implements RequestStore {
  private constructor(private readonly pool: Queryable) {}

  static async connect(url: string): Promise<PostgresRequestStore> {
    const pool = getPool(url);
    await initSchema(pool);
    return new PostgresRequestStore(pool);
  }

  /** Test seam — see billing.pg.ts's `_withQueryable` for why this exists. */
  static _withQueryable(db: Queryable): PostgresRequestStore {
    return new PostgresRequestStore(db);
  }

  async createRequest(r: NewClientRequest): Promise<ClientRequest> {
    if (!r.project_id) throw new Error("client request requires a project_id");
    if (!r.client_id) throw new Error("client request requires a client_id");
    const toolkit = r.kind === "connection" ? (normalizeToolkit(r.connection_toolkit) ?? null) : null;
    if (r.kind === "connection" && !toolkit) {
      throw new Error("a connection ask needs a toolkit (e.g. xero)");
    }
    const res = await this.pool.query(
      `INSERT INTO client_requests
         (id, project_id, client_id, case_id, thread_id, task_id, kind, ask, detail, status, due_at,
          connection_toolkit, party_role, party_label, party_email)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [
        randomUUID(),
        r.project_id,
        r.client_id,
        r.case_id ?? null,
        r.thread_id ?? null,
        r.task_id ?? null,
        r.kind,
        r.ask,
        r.detail ?? null,
        r.status ?? "open",
        r.due_at ?? null,
        toolkit,
        r.party_role ?? "client",
        r.party_label ?? null,
        r.party_email ?? null,
      ],
    );
    return rowToRequest(res.rows[0]);
  }

  async getRequest(projectId: string, id: string): Promise<ClientRequest | undefined> {
    // The tenant is in the WHERE, not in a check afterwards. A post-read `if (row.project_id …)` is
    // one early return away from being skipped; this one cannot be.
    const res = await this.pool.query(`SELECT * FROM client_requests WHERE id=$1 AND project_id=$2`, [id, projectId]);
    return res.rows[0] ? rowToRequest(res.rows[0]) : undefined;
  }

  async listRequests(f: RequestFilter): Promise<ClientRequest[]> {
    if (!f.project_id) throw new Error("listRequests requires a project_id");
    const { sql, values } = buildListQuery(f);
    const res = await this.pool.query(sql, values);
    // Ranked in JS so both backends order identically — the SQL orders only enough to make LIMIT
    // deterministic. See `rankRequests`.
    return rankRequests(res.rows.map(rowToRequest));
  }

  async resolveRequest(
    projectId: string,
    id: string,
    response: string,
    artifactIds?: string[],
  ): Promise<ClientRequest | undefined> {
    const res = await this.pool.query(
      `UPDATE client_requests
          SET status='resolved', response=$3, response_artifact_ids=$4::jsonb,
              resolved_at=now(), updated_at=now()
        WHERE id=$1 AND project_id=$2 AND status='open'
        RETURNING *`,
      [id, projectId, response, JSON.stringify(artifactIds?.length ? artifactIds.slice(0, 20) : null)],
    );
    return res.rows[0] ? rowToRequest(res.rows[0]) : undefined;
  }

  async cancelRequest(projectId: string, id: string): Promise<ClientRequest | undefined> {
    const res = await this.pool.query(
      `UPDATE client_requests SET status='cancelled', updated_at=now()
        WHERE id=$1 AND project_id=$2 AND status='open' RETURNING *`,
      [id, projectId],
    );
    return res.rows[0] ? rowToRequest(res.rows[0]) : undefined;
  }

  async claimRequestForNudge(args: {
    project_id: string;
    id: string;
    notNudgedSince: string;
    maxNudges: number;
    at: string;
  }): Promise<ClientRequest | undefined> {
    if (!args.project_id) return undefined;
    const { sql, values } = nudgeClaimUpdate(args);
    const res = await this.pool.query(sql, values);
    return res.rows[0] ? rowToRequest(res.rows[0]) : undefined;
  }

  async close(): Promise<void> {
    // The pool is shared and ended once, in index.ts's `closeAllPools`.
  }
}
