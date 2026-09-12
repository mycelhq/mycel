// Reading a pairing's track record out of the rows that already describe it.
//
// ═══ WHY THERE IS NO NEW LEDGER ═══
//
// The obvious build is a `release_record` table written on every verdict. It would also be a second
// source of truth that can drift from the first, and drift here is not cosmetic: a record that
// disagrees with reality is either gating work that has earned its way out, or — much worse —
// auto-releasing on a clean run that did not happen.
//
// `deliverables` already carries everything the policy needs. A deliverable's final status is the
// client's verdict. Its version count says whether getting there took a revision. The pairing is its
// wedge and its client. Deriving the record from those rows means the policy and the history cannot
// disagree, because they are the same rows.
//
// The one thing the existing schema could NOT answer is whether a given deliverable went out without
// a human looking, and that distinction is the entire safety mechanism — changes requested on
// reviewed work is ordinary service business, changes requested on work we chose to skip reviewing
// is the system telling us the threshold was wrong. So exactly one column is added, and it is a
// fact about what we did rather than a copy of anything.

import type { Outcome, Record as ReleaseRecord } from "./release-policy";
import { withSchemaLock } from "./schema-lock";

export interface Queryable {
  query: (text: string, values?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>;
}

/**
 * One boolean, on the deliverable, recording whether it reached the client without review.
 *
 * On the DELIVERABLE and not the version, because that is the grain the client experiences: they
 * were sent a piece of work, and either a person had checked it or not. A per-version flag would be
 * more precise and would answer a question nobody asks.
 */
export async function initReleasePolicySchema(pool: Queryable): Promise<void> {
  await withSchemaLock(pool as never, async (client) => {
    await client.query(
      `ALTER TABLE public.deliverables ADD COLUMN IF NOT EXISTS auto_released boolean NOT NULL DEFAULT false`,
    );
    // The policy reads by pairing, newest first, on every release decision.
    await client.query(
      `CREATE INDEX IF NOT EXISTS deliverables_pairing
         ON public.deliverables (project_id, client_id, case_id, created_at DESC)`,
    );
  });
}

/**
 * Everything this wedge has delivered to this client, newest first, as outcomes.
 *
 * ═══ WHY IT JOINS ON THE CASE'S WEDGE ═══
 *
 * A deliverable does not carry a wedge; its case does. Joining is the price of not denormalising,
 * and the alternative — copying the wedge onto every deliverable — is the drift problem this file
 * exists to avoid, in miniature.
 *
 * ═══ WHY UNRESOLVED WORK IS SKIPPED, NOT COUNTED AS BAD ═══
 *
 * A deliverable sitting in review is not evidence of anything yet. Counting it as a failure would
 * mean a business that delivers faster than its clients respond can never earn the gate, which
 * penalises exactly the pairing that is working well.
 */
export async function readRecord(
  db: Queryable,
  args: { project_id: string; client_id: string; wedge: string },
): Promise<ReleaseRecord> {
  const empty: ReleaseRecord = { wedge: args.wedge, client_id: args.client_id, outcomes: [] };
  if (!args.project_id || !args.client_id || !args.wedge) return empty;

  const res = await db.query(
    `SELECT d.status,
            d.auto_released,
            (SELECT count(*) FROM public.deliverable_versions v WHERE v.deliverable_id = d.id) AS versions
       FROM public.deliverables d
       -- k.id::text, and the cast is load-bearing rather than defensive.
       --
       -- cases.id is uuid and deliverables.case_id is text, so this join threw
       -- "operator does not exist: uuid = text" on EVERY call. Sentry counted 14 in seven days and
       -- it never surfaced as a feature being broken: mayAutoRelease has therefore never once seen
       -- a track record in production, so auto-release could not be earned by anybody. A whole
       -- shipped feature dead, reported to the founder as "no history yet".
       --
       -- The schema is split down the middle: twelve tables carry uuid ids (cases, clients, tasks,
       -- threads) and the deliverable family carries text. Unifying them is a migration with a
       -- rollback story and it is not this fix; casting here is correct today and costs an index
       -- probe on a set already bounded by project_id and client_id.
       JOIN public.cases k ON k.id::text = d.case_id
      WHERE d.project_id = $1
        AND d.client_id  = $2
        AND k.wedge      = $3
        AND d.status IN ('accepted', 'changes_requested')
      ORDER BY d.created_at DESC
      LIMIT 50`,
    [args.project_id, args.client_id, args.wedge],
  );

  const outcomes: Outcome[] = [];
  for (const r of res.rows ?? []) {
    const versions = Number(r.versions ?? 1);
    const auto = r.auto_released === true;
    if (r.status === "changes_requested") {
      outcomes.push(auto ? "auto_released_then_changes" : "changes_requested");
    } else {
      // More than one version means the client sent it back at least once on the way to yes.
      outcomes.push(versions > 1 ? "accept_after_changes" : "clean_accept");
    }
  }
  return { ...empty, outcomes };
}

/** Stamp that this deliverable went out without a human looking. */
export async function markAutoReleased(db: Queryable, deliverableId: string): Promise<void> {
  if (!deliverableId) return;
  await db.query(`UPDATE public.deliverables SET auto_released = true WHERE id = $1`, [deliverableId]);
}

/**
 * Whether a client's changes-requested landed on work nobody reviewed.
 *
 * Read at verdict time rather than inferred, because by then the deliverable's status has already
 * moved and the only durable record of how it left the building is this column.
 */
export async function wasAutoReleased(db: Queryable, deliverableId: string): Promise<boolean> {
  const res = await db.query(`SELECT auto_released FROM public.deliverables WHERE id = $1`, [deliverableId]);
  return res.rows[0]?.auto_released === true;
}
