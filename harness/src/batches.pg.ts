// Batches, in Postgres — because a fan-out that lives in one process's memory is a fan-out that
// silently never joins.
//
// ═══ THE STALL THIS FIXES ═══
//
// The day `/v1/internal/batches` was finally published through the ALB, the first real fan-out
// worked: twelve `probe_mention` children spawned, sixteen runs succeeded, and the parent
// `weekly_report` sat in `awaiting_batch` for two hours and never woke up.
//
// `batches.ts` kept every batch in `new Map()` behind a module-level `let`, with a comment saying
// "Postgres backing can swap this later the same way DomainStore does". `setBatchStore` was never
// called from anywhere — grep it — so `later` never came, and the in-memory store WAS the store in
// production.
//
// Two ways that loses a batch, and both are ordinary:
//
//   A RESTART. The worker redeploys, or ECS replaces the task, and every open batch evaporates.
//   The children are rows in Postgres and keep running perfectly; the parent is a row in Postgres
//   and stays `awaiting_batch` forever. Nothing errors. Nothing logs. The engagement simply stops.
//
//   A SECOND REPLICA. Worker desired count is 1 today and autoscaling does not cover it — which is
//   the only reason the join ever fired in a test. The moment it is 2, `onChildFinished` runs in
//   whichever replica finished the child, looks up a batch the OTHER replica is holding, gets
//   undefined, and does nothing. A scaling event would break fulfilment with no code change.
//
// A stuck parent is the worst failure this system has, because it is invisible. A failed run is on
// the founder's screen in red. A parked one looks exactly like patience.
//
// ═══ WHY `tryJoin` IS ONE STATEMENT ═══
//
// Two children can finish in the same instant. Both call `onChildFinished`, both see every sibling
// terminal, and both try to join — and a parent resumed twice runs the aggregate twice and can
// produce two deliverables from one week's work. So the transition to `joined` is a compare-and-set
// in the WHERE clause, exactly like `transitionInvoice` and `claimRequestForNudge`: the second
// caller updates zero rows and reads back the row the winner wrote. Same answer, one resume.

import { randomUUID } from "node:crypto";
import { getPool } from "./pool";
import { withSchemaLock } from "./schema-lock";
import type { Batch, BatchStatus, Task } from "./contract";
import type { BatchStore } from "./batches";

export interface Queryable {
  query: (text: string, values?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>;
}

const nowIso = () => new Date().toISOString();

function rowToBatch(r: any): Batch {
  return {
    id: String(r.id),
    project_id: String(r.project_id),
    parent_task_id: String(r.parent_task_id),
    wedge: String(r.wedge ?? ""),
    case_id: r.case_id ? String(r.case_id) : undefined,
    client_id: r.client_id ? String(r.client_id) : undefined,
    status: String(r.status) as BatchStatus,
    join: r.join_mode === "quorum" ? "quorum" : "all",
    quorum: r.quorum == null ? undefined : Number(r.quorum),
    child_task_ids: Array.isArray(r.child_task_ids) ? r.child_task_ids.map(String) : [],
    aggregate: r.aggregate ?? undefined,
    created_at: new Date(r.created_at).toISOString(),
    updated_at: new Date(r.updated_at).toISOString(),
    joined_at: r.joined_at ? new Date(r.joined_at).toISOString() : undefined,
  };
}

/**
 * `join` is a reserved word in SQL, so the column is `join_mode`.
 *
 * Named differently from the field on purpose rather than quoting `"join"` everywhere: a quoted
 * reserved word is a trap that survives review and then breaks the one query somebody writes by
 * hand at three in the morning.
 */
export async function initBatchSchema(pool: Queryable): Promise<void> {
  // Serialised across processes, exactly as `requests.pg` does it: `CREATE TABLE IF NOT EXISTS` is
  // not concurrency-safe and every container boots together on a deploy.
  await withSchemaLock(pool as never, async (client) => {
    // `text`, not `uuid`, for every id — matching `client_requests` and `tasks`. Mixing the two is
    // how `operator does not exist: uuid = text` shows up months later in whichever join somebody
    // writes first, and the ids arriving here come from those tables.
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.batches (
        id             text PRIMARY KEY,
        project_id     text NOT NULL,
        parent_task_id text NOT NULL,
        wedge          text NOT NULL DEFAULT '',
        case_id        text,
        client_id      text,
        status         text NOT NULL DEFAULT 'open',
        join_mode      text NOT NULL DEFAULT 'all',
        quorum         integer,
        child_task_ids text[] NOT NULL DEFAULT '{}',
        aggregate      jsonb,
        created_at     timestamptz NOT NULL DEFAULT now(),
        updated_at     timestamptz NOT NULL DEFAULT now(),
        joined_at      timestamptz
      )`);
    // One open batch per parent is the invariant the route enforces with its 409; the index makes it
    // true even when two requests race past that check.
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS batches_one_open_per_parent
         ON public.batches (parent_task_id) WHERE status = 'open'`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS batches_project ON public.batches (project_id, created_at DESC)`,
    );
  });
}

export class PgBatchStore implements BatchStore {
  constructor(private db: Queryable) {}

  static async connect(url: string): Promise<PgBatchStore> {
    const pool = getPool(url);
    await initBatchSchema(pool);
    return new PgBatchStore(pool);
  }

  /** Test seam — the same one every other pg store here exposes. */
  static _withQueryable(db: Queryable): PgBatchStore {
    return new PgBatchStore(db);
  }

  async createBatch(
    b: Omit<Batch, "id" | "created_at" | "updated_at" | "child_task_ids" | "status"> & {
      child_task_ids?: string[];
      status?: BatchStatus;
    },
  ): Promise<Batch> {
    // The same three refusals the in-memory store makes, restated rather than shared: a store that
    // accepts a batch with no parent writes a row nothing can ever join.
    if (!b.project_id) throw new Error("batch requires a project_id");
    if (!b.parent_task_id) throw new Error("batch requires a parent_task_id");
    if (b.join === "quorum" && !(b.quorum && b.quorum > 0)) {
      throw new Error("quorum join requires quorum > 0");
    }
    const res = await this.db.query(
      `INSERT INTO public.batches
         (id, project_id, parent_task_id, wedge, case_id, client_id, status, join_mode, quorum, child_task_ids)
       VALUES ($10, $1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        b.project_id,
        b.parent_task_id,
        b.wedge ?? "",
        b.case_id ?? null,
        b.client_id ?? null,
        b.status ?? "open",
        b.join,
        b.quorum ?? null,
        b.child_task_ids ?? [],
        randomUUID(),
      ],
    );
    return rowToBatch(res.rows[0]);
  }

  async getBatch(id: string): Promise<Batch | undefined> {
    if (!id) return undefined;
    const res = await this.db.query(`SELECT * FROM public.batches WHERE id = $1`, [id]);
    return res.rows[0] ? rowToBatch(res.rows[0]) : undefined;
  }

  async listBatches(projectId: string, limit = 50): Promise<Batch[]> {
    const res = await this.db.query(
      `SELECT * FROM public.batches WHERE project_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [projectId, Math.max(1, Math.min(500, limit))],
    );
    return res.rows.map(rowToBatch);
  }

  /**
   * `array_append` rather than read-modify-write, so two children registering at once both land.
   * The read-modify-write version loses one silently, and a batch missing a child never joins —
   * which is the exact stall this file exists to remove, reintroduced one layer down.
   */
  async addChild(batchId: string, taskId: string): Promise<Batch | undefined> {
    const res = await this.db.query(
      `UPDATE public.batches
          SET child_task_ids = CASE WHEN $2 = ANY(child_task_ids)
                                    THEN child_task_ids
                                    ELSE array_append(child_task_ids, $2) END,
              updated_at = now()
        WHERE id = $1
      RETURNING *`,
      [batchId, taskId],
    );
    return res.rows[0] ? rowToBatch(res.rows[0]) : undefined;
  }

  /**
   * The in-memory version's semantics, restated against SQL — and they are NOT the obvious ones, so
   * they are mirrored deliberately rather than reinvented:
   *
   *   - Terminal statuses are `succeeded | failed | cancelled`. A batch already in one is returned
   *     unchanged (idempotent), and `undefined` is never the answer for a batch that exists.
   *   - `failed` on a CHILD counts `rejected` and `expired` too. Those are terminal for a task and
   *     a join that waits for them waits for ever.
   *   - A child not present in `children` means the caller has not loaded them all. Return the batch
   *     UNJOINED rather than joining on a partial set — joining early is how a report gets written
   *     from four of twelve probes and looks entirely correct.
   *   - Outputs come from `input.__batch_output`, which is where the child runner puts them.
   *   - The batch ends `succeeded` if ANY child succeeded, `failed` only if none did.
   */
  async tryJoin(batchId: string, children: readonly Task[]): Promise<Batch | undefined> {
    const batch = await this.getBatch(batchId);
    if (!batch) return undefined;
    if (batch.status === "succeeded" || batch.status === "failed" || batch.status === "cancelled") return batch;

    const byId = new Map(children.map((t) => [t.id, t]));
    const kids = batch.child_task_ids.map((id) => byId.get(id)).filter((t): t is Task => !!t);
    if (kids.length !== batch.child_task_ids.length) return batch;

    const succeeded = kids.filter((t) => t.status === "succeeded").length;
    const failed = kids.filter((t) => t.status === "failed" || t.status === "rejected" || t.status === "expired").length;
    const cancelled = kids.filter((t) => t.status === "cancelled").length;
    const TERMINAL = new Set(["succeeded", "failed", "cancelled", "rejected", "expired"]);
    const done = kids.every((t) => TERMINAL.has(t.status));
    const quorumMet = batch.join === "quorum" && succeeded >= (batch.quorum ?? 0);
    if (!done && !quorumMet) return batch;

    const aggregate = {
      succeeded,
      failed,
      cancelled,
      outputs: kids
        .filter((t) => t.status === "succeeded")
        .map((t) => (t.input as Record<string, unknown> | undefined)?.__batch_output ?? null),
    };

    // COMPARE-AND-SET, which the in-memory store did not need and this one does. Two children can
    // finish in the same instant; both see every sibling terminal and both try to join. A parent
    // resumed twice runs the aggregate twice and can produce two deliverables from one week's work.
    // `status = 'open'` in the WHERE settles it: the loser updates nothing and reads back the row
    // the winner wrote, so both callers get the same answer and the parent resumes once.
    const res = await this.db.query(
      `UPDATE public.batches
          SET status = $2, joined_at = now(), updated_at = now(), aggregate = $3
        WHERE id = $1 AND status = 'open'
      RETURNING *`,
      [batchId, succeeded > 0 ? "succeeded" : "failed", JSON.stringify(aggregate)],
    );
    if (res.rows[0]) return rowToBatch(res.rows[0]);
    return this.getBatch(batchId);
  }
}
