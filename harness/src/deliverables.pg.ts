// Durable Postgres backing for the fulfilment loop. Mirrors billing.pg.ts / domain.pg.ts: raw SQL,
// tables created on connect under the schema lock, one shared pool. Selected automatically when
// MYCEL_DATABASE_URL is set.
//
// Read the `DeliverableStore` docs in deliverables.ts before changing anything here. This backend
// owns three guarantees, and each one is a single statement rather than a read followed by a write:
//
//   1. `submitVersion` allocates the version number, inserts the row, supersedes the previous one
//      and moves the status in ONE statement. Two retried runs revising the same deliverable cannot
//      both become "version 3".
//   2. `transitionDeliverable` puts the legal-source allowlist in the WHERE clause, so a client
//      double-clicking "Accept" and "Request changes" cannot both win. This is what makes
//      acceptance idempotent rather than last-write-wins.
//   3. `settleVersion` requires `released_at IS NOT NULL` in the WHERE clause, so the founder's gate
//      holds at the write as well as at the read. A verdict cannot be recorded against a version
//      that was never released, whatever route calls it.
//
// Everything mechanical — the WHERE builder, the row mappers, the two guarded statements — is a pure
// exported function rather than a method, because there is no Postgres in the test environment and
// the parts that get tenancy and exactly-once wrong are exactly those parts. Same reasoning, and the
// same seam, as billing.pg.ts. See test/deliverables-pg.test.ts.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { getPool } from "./pool";
import { withSchemaLock } from "./schema-lock";
import type { Deliverable, DeliverableKind, DeliverableStatus, DeliverableVersion } from "./contract";
import type { DeliverableFilter, DeliverableStore, NewDeliverable, NewVersion } from "./deliverables";
import { OPEN_DELIVERABLE_STATUSES, isDeliverableKind, isDeliverableStatus } from "./deliverables";

/** The narrow slice of `pg.Pool` this store uses — the fake seam. See billing.pg.ts's `Queryable`. */
export interface Queryable {
  query(sql: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

const iso = (v: unknown) => new Date(v as string).toISOString();

/**
 * The schema.
 *
 * `id`, `case_id`, `client_id` and `deliverable_id` are `text`, NOT `uuid`, for the reason
 * billing.pg.ts spells out: they are looked up straight from a URL path, and `WHERE id = $1` against
 * a `uuid` column raises 22P02 on a malformed id — a 500 where the in-memory store returns undefined
 * and the route returns 404. A miss must be a miss, on both backends, or the tests lie.
 *
 * `project_id` is NOT NULL on BOTH tables. On the version table that is redundant with the parent
 * and deliberately so: every version read takes the project as a positional argument and pushes it
 * into the WHERE clause, so a version can be authorised without a join to its parent. A read that
 * needs a join to be safe is a read somebody will one day write without the join.
 *
 * `artifact_ids` is `text[]`, not a join table. There is no query anywhere that asks "which
 * deliverables contain artifact X" — the only question is the other direction, and it is always
 * asked with the version already in hand. A join table would be a second place to write the payload
 * and a second place for it to be empty while the version says it is not.
 *
 * `deliverable_versions_no_dup` is the index that makes `submitVersion` safe even if the CTE below
 * is ever refactored into something less careful. Belt and braces, on the one invariant a client
 * would actually notice breaking.
 */
async function initSchema(pool: pg.Pool): Promise<void> {
  await withSchemaLock(pool, async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS deliverables (
        id text PRIMARY KEY,
        project_id text NOT NULL,
        case_id text NOT NULL,
        client_id text NOT NULL,
        title text NOT NULL,
        kind text NOT NULL,
        status text NOT NULL,
        current_version integer NOT NULL DEFAULT 0,
        accepted_at timestamptz,
        withdrawn_reason text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS deliverable_versions (
        id text PRIMARY KEY,
        project_id text NOT NULL,
        deliverable_id text NOT NULL REFERENCES deliverables(id) ON DELETE CASCADE,
        version integer NOT NULL,
        summary text NOT NULL DEFAULT '',
        artifact_ids text[] NOT NULL DEFAULT '{}',
        url text,
        task_id text,
        released_at timestamptz,
        change_request text,
        change_requested_at timestamptz,
        accepted_at timestamptz,
        accepted_note text,
        superseded_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    // Idempotent migrations for installs that predate a column. Nullable-or-defaulted, always, so
    // old rows stay valid — the convention every other .pg.ts file in here follows.
    for (const sql of [
      `CREATE INDEX IF NOT EXISTS deliverables_scope_idx ON deliverables (project_id, updated_at DESC)`,
      `CREATE INDEX IF NOT EXISTS deliverables_client_idx ON deliverables (project_id, client_id)`,
      `CREATE INDEX IF NOT EXISTS deliverables_case_idx ON deliverables (project_id, case_id)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS deliverable_versions_no_dup ON deliverable_versions (deliverable_id, version)`,
      `CREATE INDEX IF NOT EXISTS deliverable_versions_scope_idx ON deliverable_versions (project_id, deliverable_id, version)`,
    ]) {
      await client.query(sql);
    }
  });
}

// ── pure: row mapping ────────────────────────────────────────────────────────────────────────────

/**
 * Row → contract. Every "absent means X" default is applied HERE, once, exactly as `rowToInvoice`
 * does — and `kind`/`status` are re-validated on the way OUT, not only on the way in. Those columns
 * are plain `text` and can hold whatever a previous deploy or a hand-run UPDATE put there; handing
 * an unrecognised string back typed as `DeliverableStatus` would push the lie into every caller,
 * including the portal's "what may this client see" check.
 */
export function rowToDeliverable(r: any): Deliverable {
  return {
    id: r.id,
    project_id: r.project_id,
    case_id: r.case_id,
    client_id: r.client_id,
    title: r.title,
    kind: (isDeliverableKind(r.kind) ? r.kind : "document") as DeliverableKind,
    // An unreadable status falls back to `drafting`, which is the state with NO client sentence at
    // all. Failing closed here means a corrupt row is invisible to a client rather than accidentally
    // presented as accepted work.
    status: (isDeliverableStatus(r.status) ? r.status : "drafting") as DeliverableStatus,
    current_version: Number(r.current_version ?? 0),
    accepted_at: r.accepted_at ? iso(r.accepted_at) : undefined,
    withdrawn_reason: r.withdrawn_reason ?? undefined,
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
  };
}

export function rowToVersion(r: any): DeliverableVersion {
  return {
    id: r.id,
    project_id: r.project_id,
    deliverable_id: r.deliverable_id,
    version: Number(r.version),
    summary: r.summary ?? "",
    artifact_ids: Array.isArray(r.artifact_ids) ? r.artifact_ids.map(String) : [],
    url: r.url ?? undefined,
    task_id: r.task_id ?? undefined,
    released_at: r.released_at ? iso(r.released_at) : undefined,
    change_request: r.change_request ?? undefined,
    change_requested_at: r.change_requested_at ? iso(r.change_requested_at) : undefined,
    accepted_at: r.accepted_at ? iso(r.accepted_at) : undefined,
    accepted_note: r.accepted_note ?? undefined,
    superseded_at: r.superseded_at ? iso(r.superseded_at) : undefined,
    created_at: iso(r.created_at),
  };
}

// ── pure: the statements ─────────────────────────────────────────────────────────────────────────

/**
 * The list query.
 *
 * `project_id = $1` is pushed in ALWAYS and first, never appended conditionally, and the `limit`
 * goes on the SQL rather than on the result. A post-filtered list with a LIMIT returns the wrong
 * rows the moment the limit truncates — the argument `InvoiceFilter` and `CaseFilter` both make, and
 * the mechanism behind one of the two cross-tenant leaks this repo has shipped.
 */
export function listDeliverablesSql(f: DeliverableFilter): { sql: string; vals: unknown[] } {
  const where = ["project_id = $1"];
  const vals: unknown[] = [f.project_id];
  const put = (v: unknown) => `$${vals.push(v)}`;
  if (f.client_id) where.push(`client_id = ${put(f.client_id)}`);
  if (f.case_id) where.push(`case_id = ${put(f.case_id)}`);
  if (f.status) where.push(`status = ${put(f.status)}`);
  if (f.open) where.push(`status = ANY(${put(OPEN_DELIVERABLE_STATUSES)})`);
  const limit = f.limit && f.limit > 0 ? ` LIMIT ${Math.min(Math.trunc(f.limit), 1000)}` : "";
  return {
    sql: `SELECT * FROM deliverables WHERE ${where.join(" AND ")} ORDER BY updated_at DESC, id ASC${limit}`,
    vals,
  };
}

/**
 * Add version N+1, supersede N, move the status — ONE statement.
 *
 * Read the CTE bottom-up. `parent` is the guarded read: it selects the deliverable only when the
 * tenant matches AND the current status is in the caller's allowlist, so every branch below it is
 * empty for an illegal submit. `ins` computes `version` as `parent.current_version + 1` from that
 * same locked read rather than from a `max()` over the version table — the two can disagree, and
 * when they do it is because a previous insert failed halfway, which is exactly when you least want
 * to reuse a number. `sup` stamps the outgoing version. `upd` moves the parent.
 *
 * `FOR UPDATE` on `parent` is what serialises two concurrent submits: the second waits, then re-reads
 * a `current_version` that has already moved, and allocates N+2. Without it both read N and both
 * insert N+1, and the unique index turns a race into a 500 instead of a queue.
 */
export function submitVersionSql(args: {
  project_id: string;
  deliverable_id: string;
  allowedFrom: readonly DeliverableStatus[];
  version: NewVersion;
  at: string;
  new_id: string;
}): { sql: string; vals: unknown[] } {
  return {
    sql: `
      WITH parent AS (
        SELECT id, current_version FROM deliverables
        WHERE id = $2 AND project_id = $1 AND status = ANY($3)
        FOR UPDATE
      ),
      ins AS (
        INSERT INTO deliverable_versions
          (id, project_id, deliverable_id, version, summary, artifact_ids, url, task_id, created_at)
        SELECT $4, $1, parent.id, parent.current_version + 1, $5, $6::text[], $7, $8, $9
        FROM parent
        RETURNING *
      ),
      sup AS (
        UPDATE deliverable_versions v
        SET superseded_at = $9
        FROM parent
        WHERE v.deliverable_id = parent.id
          AND v.project_id = $1
          AND v.version = parent.current_version
          AND v.superseded_at IS NULL
        RETURNING 1
      ),
      upd AS (
        UPDATE deliverables d
        SET status = 'in_review', current_version = parent.current_version + 1, updated_at = $9
        FROM parent
        WHERE d.id = parent.id
        RETURNING d.*
      )
      SELECT
        (SELECT row_to_json(upd) FROM upd) AS deliverable,
        (SELECT row_to_json(ins) FROM ins) AS version
    `,
    vals: [
      args.project_id,
      args.deliverable_id,
      args.allowedFrom,
      args.new_id,
      args.version.summary ?? "",
      args.version.artifact_ids ?? [],
      args.version.url ?? null,
      args.version.task_id ?? null,
      args.at,
    ],
  };
}

/**
 * Move status with the allowlist in the WHERE clause. The exact shape of `transitionInvoice`.
 *
 * `accepted_at = COALESCE(deliverables.accepted_at, $5)` rather than `= $5`: the field is written
 * once and never moved. An invoice may already have been raised against that date.
 */
export function transitionSql(args: {
  project_id: string;
  id: string;
  to: DeliverableStatus;
  allowedFrom: readonly DeliverableStatus[];
  at: string;
  accepted_at?: string;
  withdrawn_reason?: string;
}): { sql: string; vals: unknown[] } {
  return {
    sql: `
      UPDATE deliverables SET
        status = $3,
        updated_at = $4,
        accepted_at = COALESCE(deliverables.accepted_at, $5),
        withdrawn_reason = COALESCE($6, deliverables.withdrawn_reason)
      WHERE id = $2 AND project_id = $1 AND status = ANY($7)
      RETURNING *
    `,
    vals: [
      args.project_id,
      args.id,
      args.to,
      args.at,
      args.accepted_at ?? null,
      args.withdrawn_reason ?? null,
      args.allowedFrom,
    ],
  };
}

/**
 * The founder's gate, as a statement. `released_at IS NULL` in the WHERE clause makes a second
 * release a no-op rather than a re-stamp: the date a client was first shown something is evidence,
 * and a second approval click must not move it.
 */
export function releaseSql(args: { project_id: string; deliverable_id: string; version: number; at: string }): {
  sql: string;
  vals: unknown[];
} {
  return {
    sql: `
      UPDATE deliverable_versions SET released_at = $4
      WHERE project_id = $1 AND deliverable_id = $2 AND version = $3 AND released_at IS NULL
      RETURNING *
    `,
    vals: [args.project_id, args.deliverable_id, args.version, args.at],
  };
}

/**
 * The client's verdict, as a statement.
 *
 * THREE guards in the WHERE clause, and each one is a real failure:
 *   · `project_id = $1` — the cross-tenant write. A client id from a session, a deliverable id from
 *     a URL: the leak shape this whole file is careful about.
 *   · `released_at IS NOT NULL` — a verdict on something never released. The founder's gate, held at
 *     the write as well as at the read, so no future route can route around it.
 *   · `accepted_at IS NULL AND change_requested_at IS NULL` — the double submit. A client who
 *     double-clicks must not have their acceptance overwritten by a second, identical acceptance,
 *     and a client whose two tabs disagree must have the first answer stand.
 */
export function settleSql(args: {
  project_id: string;
  deliverable_id: string;
  version: number;
  at: string;
  verdict: { kind: "accepted"; note?: string } | { kind: "changes_requested"; request: string };
}): { sql: string; vals: unknown[] } {
  const accepted = args.verdict.kind === "accepted";
  return {
    sql: `
      UPDATE deliverable_versions SET
        accepted_at = $4,
        accepted_note = $5,
        change_request = $6,
        change_requested_at = $7
      WHERE project_id = $1 AND deliverable_id = $2 AND version = $3
        AND released_at IS NOT NULL
        AND accepted_at IS NULL
        AND change_requested_at IS NULL
      RETURNING *
    `,
    vals: [
      args.project_id,
      args.deliverable_id,
      args.version,
      accepted ? args.at : null,
      accepted ? ((args.verdict as { note?: string }).note ?? null) : null,
      accepted ? null : (args.verdict as { request: string }).request,
      accepted ? null : args.at,
    ],
  };
}

// ── the store ────────────────────────────────────────────────────────────────────────────────────

export class PostgresDeliverableStore implements DeliverableStore {
  private constructor(private db: Queryable) {}

  static async connect(url: string): Promise<PostgresDeliverableStore> {
    const pool = getPool(url);
    await initSchema(pool);
    return new PostgresDeliverableStore(pool);
  }

  /** Test seam — see billing.pg.ts's `_withQueryable`. There is no Postgres in the test environment. */
  static _withQueryable(db: Queryable): PostgresDeliverableStore {
    return new PostgresDeliverableStore(db);
  }

  async createDeliverable(d: NewDeliverable): Promise<Deliverable> {
    if (!d.project_id) throw new Error("a deliverable must be scoped to a project");
    if (!d.case_id) throw new Error("a deliverable must belong to a case");
    if (!d.client_id) throw new Error("a deliverable must be for a client");
    const r = await this.db.query(
      `INSERT INTO deliverables (id, project_id, case_id, client_id, title, kind, status, current_version)
       VALUES ($1,$2,$3,$4,$5,$6,'drafting',0) RETURNING *`,
      [randomUUID(), d.project_id, d.case_id, d.client_id, d.title, d.kind],
    );
    return rowToDeliverable(r.rows[0]);
  }

  async getDeliverable(projectId: string, id: string): Promise<Deliverable | undefined> {
    if (!projectId) throw new Error("getDeliverable requires a project_id");
    const r = await this.db.query(`SELECT * FROM deliverables WHERE id=$1 AND project_id=$2`, [id, projectId]);
    return r.rows[0] ? rowToDeliverable(r.rows[0]) : undefined;
  }

  async listDeliverables(f: DeliverableFilter): Promise<Deliverable[]> {
    if (!f.project_id) throw new Error("listDeliverables requires a project_id");
    const { sql, vals } = listDeliverablesSql(f);
    const r = await this.db.query(sql, vals);
    return r.rows.map(rowToDeliverable);
  }

  async listVersions(projectId: string, deliverableId: string): Promise<DeliverableVersion[]> {
    if (!projectId) throw new Error("listVersions requires a project_id");
    const r = await this.db.query(
      `SELECT * FROM deliverable_versions WHERE project_id=$1 AND deliverable_id=$2 ORDER BY version ASC`,
      [projectId, deliverableId],
    );
    return r.rows.map(rowToVersion);
  }

  async getVersion(projectId: string, deliverableId: string, version: number): Promise<DeliverableVersion | undefined> {
    if (!projectId) throw new Error("getVersion requires a project_id");
    const r = await this.db.query(
      `SELECT * FROM deliverable_versions WHERE project_id=$1 AND deliverable_id=$2 AND version=$3`,
      [projectId, deliverableId, version],
    );
    return r.rows[0] ? rowToVersion(r.rows[0]) : undefined;
  }

  async submitVersion(args: {
    project_id: string;
    deliverable_id: string;
    allowedFrom: readonly DeliverableStatus[];
    version: NewVersion;
    at: string;
  }): Promise<{ deliverable: Deliverable; version: DeliverableVersion } | undefined> {
    const { sql, vals } = submitVersionSql({ ...args, new_id: randomUUID() });
    const r = await this.db.query(sql, vals);
    const row = r.rows[0];
    // The CTE always returns exactly one row; its two columns are null when `parent` matched
    // nothing. Both are checked, not just one — a shape where only the version came back would mean
    // the parent update silently did not run, which is the "reported success" failure by definition.
    if (!row?.deliverable || !row?.version) return undefined;
    return { deliverable: rowToDeliverable(row.deliverable), version: rowToVersion(row.version) };
  }

  async transitionDeliverable(
    projectId: string,
    id: string,
    to: DeliverableStatus,
    allowedFrom: readonly DeliverableStatus[],
    at: string,
    stamps?: { accepted_at?: string; withdrawn_reason?: string },
  ): Promise<Deliverable | undefined> {
    const { sql, vals } = transitionSql({ project_id: projectId, id, to, allowedFrom, at, ...stamps });
    const r = await this.db.query(sql, vals);
    return r.rows[0] ? rowToDeliverable(r.rows[0]) : undefined;
  }

  async releaseVersion(
    projectId: string,
    deliverableId: string,
    version: number,
    at: string,
  ): Promise<DeliverableVersion | undefined> {
    const { sql, vals } = releaseSql({ project_id: projectId, deliverable_id: deliverableId, version, at });
    const r = await this.db.query(sql, vals);
    return r.rows[0] ? rowToVersion(r.rows[0]) : undefined;
  }

  async settleVersion(args: {
    project_id: string;
    deliverable_id: string;
    version: number;
    at: string;
    verdict: { kind: "accepted"; note?: string } | { kind: "changes_requested"; request: string };
  }): Promise<DeliverableVersion | undefined> {
    const { sql, vals } = settleSql(args);
    const r = await this.db.query(sql, vals);
    return r.rows[0] ? rowToVersion(r.rows[0]) : undefined;
  }
}
