// Unmetered discovery — finding people without spending the people-search quota.
//
// ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────────────────────────
// `search.ts` is the one discovery surface LinkedIn METERS: a free account gets a small monthly
// people-search budget (the Commercial Search Limit) and then search simply stops. Verified live on
// 2026-08-14 through a residential ISP proxy: two searches, then every further one 302s onto a
// keyword-stripped SRP. Pacing does not help — it is a monthly quota, not a rate limit.
//
// But an SDR does not need people-SEARCH. It needs PEOPLE, and LinkedIn exposes those through
// surfaces that are ordinary browsing, not commercial search:
//
//   · the People tab of a company page — everyone who works there;
//   · (to come) the reactors and commenters on a post — warm signal, warmer than any cold hit;
//   · (to come) a first-degree connection's connections — second-degree expansion.
//
// This file starts with company employees. The endpoint the linkedin.com company People tab fires
// is `voyagerSearchDashClusters` with `flagshipSearchIntent:ORGANIZATIONS_PEOPLE_ALUMNI` and a
// `currentCompany` facet — the SAME cluster shape the people SRP returns, which is why the existing
// `parsePeople` walker reads it with no new parser. Captured 2026-08-14 from a logged-in Brave on
// `/company/stripe/people/`; 12 employees parsed clean.
//
// ── IS THIS METERED TOO? ─────────────────────────────────────────────────────────────────────────
// It is a `voyagerSearchDashClusters` call, so the honest answer is "verify, do not assume". The
// intent and facet differ from the people SRP, and browsing a company's staff is a far more common
// human action than commercial search — but if LinkedIn ever meters it, the same
// `CommercialSearchLimitError` surfaces here, so the caller degrades identically. The one thing we
// do NOT do is pretend to know; `search.ts` shipped broken repeatedly by assuming an endpoint's
// behaviour instead of watching it.
import { parsePeople, CommercialSearchLimitError, isSearchRefusedRedirect } from "./search";
import type { LiPerson } from "./people";
import { VOYAGER, voyagerCall, type LinkedInSession, type VoyagerCtx } from "./voyager";

/**
 * The persisted-query id for the company People tab. Like every Voyager queryId it is a content hash
 * that ROTATES with LinkedIn's web deploys — when company discovery stops returning people, re-capture
 * it from a browser devtools network log on any `/company/<name>/people/` page and set the env var.
 */
const COMPANY_PEOPLE_QID =
  process.env.MYCEL_LINKEDIN_QID_COMPANY_PEOPLE ?? "voyagerSearchDashClusters.a7a0567fa66c52d645b5ff2f960b92aa";

/** A page cap. The People tab pages 12 at a time; asking for hundreds is the scraping pattern. */
const MAX_LIMIT = 49;
const DEFAULT_LIMIT = 12;

export interface CompanyPeopleQuery {
  /** The numeric organization id (from the company entityUrn, e.g. 2135371 for Stripe). */
  companyId: string | number;
  /** How many to return, capped at 49. */
  limit?: number;
  /** Offset for the next page. Cluster paging is offset-based. */
  start?: number;
}

export interface CompanyPeoplePage {
  people: LiPerson[];
  next_start?: number;
  via: "company";
}

function clampLimit(n?: number): number {
  if (!n || !Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(n)));
}

/**
 * The company People-tab URL. Rest.li 2.0 encodes the `variables` object with parens, colons and
 * `List(...)` sent LITERALLY (that is how the browser sends it) — percent-encoding them, the way an
 * ordinary query value would be, produces a 400. Only the caller-supplied company id is interpolated
 * and it is coerced to digits first, so nothing a caller passes can break out of the structure.
 */
export function companyPeopleUrl(companyId: string | number, start = 0, count = DEFAULT_LIMIT): string {
  const id = String(companyId).replace(/[^0-9]/g, "");
  if (!id) throw new Error("companyPeopleUrl needs a numeric organization id");
  const variables =
    `(start:${Math.max(0, Math.floor(start))},origin:FACETED_SEARCH,` +
    `query:(flagshipSearchIntent:ORGANIZATIONS_PEOPLE_ALUMNI,` +
    `queryParameters:List((key:currentCompany,value:List(${id})),(key:resultType,value:List(ORGANIZATION_ALUMNI))),` +
    `includeFiltersInResponse:true),count:${count})`;
  return `${VOYAGER}/graphql?includeWebMetadata=true&variables=${variables}&queryId=${COMPANY_PEOPLE_QID}`;
}

/**
 * People who work at a company, without spending the people-search quota.
 *
 * Throws `CommercialSearchLimitError` if LinkedIn ever meters this surface too (same class the SRP
 * throws, so the pipeline reacts identically). Returns an empty page when the company simply has no
 * public employees to show.
 */
export async function companyPeople(
  session: LinkedInSession,
  ctx: VoyagerCtx,
  q: CompanyPeopleQuery,
): Promise<CompanyPeoplePage> {
  const count = clampLimit(q.limit);
  const start = Math.max(0, Math.floor(q.start ?? 0));
  const url = companyPeopleUrl(q.companyId, start, count);

  // Default (JSON) headers — this is the authenticated XHR, NOT the document GET, so csrf-token and
  // the Rest.li version must stay on. `voyagerCall` throws LinkedInChallengeError on 401/403/999.
  const r = await voyagerCall(url, session, ctx, "search", {});
  const people = parsePeople(r.json);

  // If it ever degrades to the search-refused redirect, name it — same signal, same handling.
  if (!people.length && isSearchRefusedRedirect(r, String(q.companyId))) {
    throw new CommercialSearchLimitError();
  }

  const more = people.length >= count;
  return {
    people: people.slice(0, count),
    next_start: more ? start + count : undefined,
    via: "company",
  };
}
