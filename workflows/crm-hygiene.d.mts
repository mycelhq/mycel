// Types for the CRM pass. Proposes; never writes — see the header in `crm-hygiene.mjs` on why a
// dedupe that acts on its own is the highest-regret automation in a CRM.

export interface CrmRecord {
  id?: string;
  name?: string;
  company?: string;
  company_domain?: string;
  email?: string;
  phone?: string;
  linkedin_url?: string;
  /** A stage from gtm/stages.ts. Human-owned stages are never proposed for revival. */
  stage?: string;
  last_touched_at?: string;
  updated_at?: string;
  [k: string]: unknown;
}

export interface CrmHygieneArgs {
  records: CrmRecord[];
  /** ISO date. Passed in, never read from a clock — the workflow is pure. Absent skips the dormant pass. */
  now?: string;
  /** Quiet for longer than this is dormant. Default 90. */
  dormant_after_days?: number;
}

export interface MergeProposal {
  keep: string;
  merge: string[];
  matched_on: string;
  evidence: string;
  /** An exact match on something only one person has. Safe to apply in bulk. */
  confident: boolean;
}

export interface CrmHygieneResult {
  total: number;
  confident_merges: MergeProposal[];
  /** Good guesses a human reads. Two people with one name at one company is rare, not impossible. */
  review_merges: MergeProposal[];
  fixes: Array<{ id: string; name: string; faults: string[] }>;
  dormant: Array<{ id: string; name: string; company?: string; stage: string; days_quiet: number; why: string }>;
  counts: { duplicates: number; needing_fixes: number; dormant: number };
  /** Said plainly when a pass could not run, so an empty list never reads as "none". */
  detail?: string;
}

export default function crmHygiene(args: CrmHygieneArgs): CrmHygieneResult;
