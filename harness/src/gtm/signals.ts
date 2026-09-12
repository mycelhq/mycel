// Signal-sourced graph ingest: tag people from hiring / job-change language, and send nothing.
//
// The smallest honest version of "why them". Everything in this subsystem so far answers "who
// matched the search"; none of it answers "and what makes now the moment". A hiring post or a new
// role is the difference between a cold message and a timely one, and the CRM can show the evidence
// verbatim rather than asserting relevance the founder has to take on trust.
//
// Deliberately text heuristics over copy we already hold, not a scraper: it costs nothing, it is
// testable, and it cannot be wrong in an expensive direction because it never causes a send.
// Voyager's notification APIs can feed the same writer later without changing the shape.
import { PEOPLE_COLLECTION } from "../linkedin/graph";
import type { DomainStore } from "../domain";
import { gtmWedge } from "./stages";

export type SignalKind = "hiring_mention" | "job_change" | "open_to_work";

export interface SignalHit {
  profile_id: string;
  name?: string;
  headline?: string;
  signal: SignalKind;
  /** The words that triggered it, so the CRM shows evidence rather than a verdict. */
  evidence: string;
}

const HIRING = /\b(we'?re hiring|now hiring|hiring for|looking for a|open role|join (our|the) team)\b/i;
const JOB_CHANGE = /\b(excited to (announce|share)|joined|starting (as|at)|new role as)\b/i;
const OPEN = /\b(open to work|open to opportunities|looking for (my )?next)\b/i;

/**
 * Which signal, if any, this text carries.
 *
 * Order is not arbitrary: "we're hiring, and I'm open to opportunities" is a hiring signal about
 * their company first. `open_to_work` outranks `job_change` because "excited to announce I'm open
 * to work" is a job LOSS, and congratulating someone on it is the worst message in outbound.
 */
export function detectSignals(text: string): { signal: SignalKind; evidence: string } | null {
  const t = text.trim();
  if (!t) return null;
  if (HIRING.test(t)) return { signal: "hiring_mention", evidence: t.slice(0, 200) };
  if (OPEN.test(t)) return { signal: "open_to_work", evidence: t.slice(0, 200) };
  if (JOB_CHANGE.test(t)) return { signal: "job_change", evidence: t.slice(0, 200) };
  return null;
}

/**
 * Write (or merge onto) people rows tagged with a signal. No Case, no campaign, no send.
 *
 * The existing rows are read ONCE for the whole batch. Reading them per hit — which is how this
 * started — is a full collection scan per person, so ingesting fifty people from one page of
 * notifications was fifty scans of a table that grows with every search the founder ever ran.
 */
export async function ingestSignals(
  domain: DomainStore,
  projectId: string,
  hits: SignalHit[],
): Promise<{ written: number }> {
  // REQUIRED, not defaulted. This writes into a tenant's graph; there is no sensible fallback for
  // "whose graph", and an empty string would be a shared one.
  if (!projectId) throw new Error("ingestSignals needs a project");
  if (!hits.length) return { written: 0 };

  const existing = new Map<string, Record<string, unknown>>();
  for (const r of await domain.queryRecords({
    project_id: projectId,
    wedge: gtmWedge(),
    collection: PEOPLE_COLLECTION,
    limit: 1000,
  })) {
    existing.set(r.key, (r.data as Record<string, unknown>) ?? {});
  }

  let written = 0;
  const at = new Date().toISOString();
  for (const hit of hits) {
    const id = hit.profile_id.trim();
    if (!id) continue;
    const prev = existing.get(id) ?? {};
    await domain.upsertRecord({
      project_id: projectId,
      wedge: gtmWedge(),
      collection: PEOPLE_COLLECTION,
      key: id,
      // Merge, never replace: a person found by search already carries a headline, a company and an
      // enrichment provenance that cost real money. A signal adds four fields to that row.
      data: {
        ...prev,
        profile_id: id,
        public_id: id,
        name: hit.name ?? prev.name,
        headline: hit.headline ?? prev.headline,
        source: prev.source ?? "signal",
        signal: hit.signal,
        signal_evidence: hit.evidence,
        signal_at: at,
      },
    });
    written++;
  }
  return { written };
}
