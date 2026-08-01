// People search over Voyager — the reason this whole approach is worth taking.
//
// ── THE STRATEGIC POINT, SINCE IT IS EASY TO MISS ────────────────────────────────────────────────
// LinkedIn's own web app runs its search through Voyager. We already hold a Voyager session for
// messaging (`li_at` + the `JSESSIONID` echoed as `csrf-token`), so search and profile reads are the
// SAME authenticated surface, with the same headers, the same proxy and the same meter. That means:
//
//   · no new vendor, no API key, no per-lead cost — the marginal cost of a prospect is bandwidth;
//   · a sequence of view → invite → DM needs no email address at all, which removes the need for an
//     email-enrichment provider from v1 entirely.
//
// That is the finding, and it is why `provenance.cost_usd` on every record this writes is literally
// 0 (see graph.ts). The cost is not hidden somewhere else; there isn't one.
//
// ── ENDPOINT CONFIDENCE, STATED HONESTLY ─────────────────────────────────────────────────────────
// We cannot call LinkedIn from CI, so this file distinguishes what is known from what is inferred:
//
//   · `/voyager/api/search/blended` — CONFIDENT on the path and the parameter names. It is the
//     oldest and most widely observed search endpoint and it needs no rotating query id, which is
//     why it is the default here.
//   · `/voyager/api/graphql?queryId=voyagerSearchDashClusters.<hash>` — CONFIDENT on the mechanism
//     (it is the same persisted-query idiom as the messaging GraphQL in voyager.ts), INFERRED on the
//     variable spelling, and the hash rotates with LinkedIn's deploys. So it is opt-in behind an env
//     var rather than the default: an unset query id must not mean a broken search.
//
// Both are parsed by ONE parser that walks the payload for profile-shaped nodes, rather than by two
// shape-specific readers. That is the design decision that survives LinkedIn changing its response:
// a rename of the cluster wrapper does not matter if the thing being looked for is "an object with a
// /in/ navigation url or a profile urn and a title".
import { touchFor } from "./capabilities";
import {
  asRecord,
  defined,
  numOf,
  pictureFrom,
  profileUrl,
  registrableDomain,
  splitHeadline,
  textOf,
  urnId,
  type LiPerson,
} from "./people";
import { VOYAGER, restliArgs, voyagerCall, type LinkedInSession, type VoyagerCtx } from "./voyager";

/**
 * The persisted-query id for the dash search cluster API. Rotates with LinkedIn's web deploys, so it
 * lives in the environment exactly like the messaging ones — re-capture from devtools, no redeploy.
 * UNSET means "use the blended endpoint", which is the safe default.
 */
const QID_SEARCH = process.env.MYCEL_LINKEDIN_QID_SEARCH ?? "";

/** A page cap. Search is the action LinkedIn throttles hardest; asking for 100 is asking for it. */
const MAX_LIMIT = 49;
const DEFAULT_LIMIT = 10;

export interface PeopleQuery {
  /** Free text. The single most effective filter; everything else narrows it. */
  query?: string;
  title?: string;
  company?: string;
  location?: string;
  /** Results wanted, capped at 49. */
  limit?: number;
  /** Offset for the next page. Voyager's search paging is offset-based, not cursor-based. */
  start?: number;
}

export interface PeopleSearchPage {
  people: LiPerson[];
  /** LinkedIn's own claimed total, when it reported one. Frequently rounded and often absent. */
  total?: number;
  /** Feed this back as `start` to page. Absent means there is no next page. */
  next_start?: number;
  /** Which endpoint answered — so a support question has an answer without a repro. */
  via: "graphql" | "blended";
}

/**
 * The Commercial Search Limit, as a named failure.
 *
 * LinkedIn meters profile searches on a rolling MONTHLY window for accounts it decides are searching
 * commercially, and when you cross it search simply stops returning people until the window rolls.
 * It is not a bug, not a bad session and not a rate limit that clears in a minute — it is a quota
 * with a calendar on it, and the only useful responses are human ones: wait, narrow the targeting,
 * or upgrade the account. A founder who sees "search failed" tries again in an hour, forever; a
 * founder who sees this sentence makes a decision. That difference is the entire reason this is its
 * own error class rather than a generic failure with a status code.
 */
export class CommercialSearchLimitError extends Error {
  readonly code = "linkedin_commercial_search_limit";
  constructor(message?: string) {
    super(
      message ??
        "LinkedIn's Commercial Search Limit is in force on this account: it has run too many profile " +
          "searches this month and will return no more until the monthly window rolls over. Nothing " +
          "is broken and retrying will not help. Narrow the targeting so each search returns people " +
          "worth contacting, work the prospects already in the CRM, or upgrade the account to Sales " +
          "Navigator — those are the only three things that change this.",
    );
    this.name = "CommercialSearchLimitError";
  }
}

/**
 * Does this response say "you have hit the commercial limit"?
 *
 * INFERRED, and worth saying plainly: LinkedIn signals this several ways and we cannot enumerate
 * them from here. Observed signals are a 429, an upsell/paywall entity in place of results, and the
 * literal "commercial use limit" copy the web app renders. So this matches on the union, and it is
 * deliberately checked BEFORE "no results" is reported — a throttled search and a search for someone
 * who does not exist both return zero people, and conflating them is how a founder concludes their
 * targeting is wrong when their account is actually capped.
 *
 * Narrow on purpose: it only fires when the search also produced no people. A payload that mentions
 * a premium upsell alongside twenty real results is LinkedIn selling, not LinkedIn throttling.
 */
const LIMIT_SIGNAL =
  /commercial[_\s-]*(use|search)?[_\s-]*limit|COMMERCIAL_SEARCH|monthly limit on profile searches|reached the (monthly )?limit|searchLimitReached/i;

export function isCommercialLimit(status: number, payload: unknown, foundPeople: number): boolean {
  if (foundPeople > 0) return false;
  if (status === 429) return true;
  let blob = "";
  try {
    // Capped: this is a substring test on a diagnostic, not a parse, and an unbounded stringify of a
    // large `included` graph on every empty search is a real cost for no extra signal.
    blob = JSON.stringify(payload ?? "").slice(0, 200_000);
  } catch {
    return false;
  }
  return LIMIT_SIGNAL.test(blob);
}

// ── the parser ───────────────────────────────────────────────────────────────────────────────────

/** Depth cap on the walk. Voyager graphs nest ~10 deep; 12 is slack without being unbounded. */
const MAX_DEPTH = 12;
/** Node cap. A pathological payload must not turn a parse into a hang inside a sequencer tick. */
const MAX_NODES = 20_000;

/** The /in/<publicId> segment of a navigation url, which is where the natural key actually lives. */
export function publicIdFromUrl(url: unknown): string | undefined {
  const s = typeof url === "string" ? url : "";
  const m = s.match(/linkedin\.com\/in\/([^/?#]+)/i);
  if (!m) return undefined;
  try {
    return decodeURIComponent(m[1]) || undefined;
  } catch {
    return m[1];
  }
}

/** Is this object a person-shaped search hit, rather than a job, a post or a wrapper? */
function looksLikePerson(n: Record<string, any>): boolean {
  const hasName = !!(textOf(n.title) || textOf(n.name) || n.firstName || n.lastName);
  if (!hasName) return false;
  if (publicIdFromUrl(n.navigationUrl) || publicIdFromUrl(n.publicIdentifier ? `linkedin.com/in/${n.publicIdentifier}` : "")) {
    return true;
  }
  const urn = String(n.targetUrn ?? n.entityUrn ?? n.trackingUrn ?? n.objectUrn ?? "");
  return /fsd_profile|fs_miniProfile|fsd_entityResultViewModel|member:/i.test(urn);
}

/**
 * Every person-shaped node in a payload, whatever wrapped it.
 *
 * A recursive walk rather than a path lookup, because the paths are what LinkedIn changes:
 * `data.elements[].elements[]` (blended), `data.data.searchDashClustersByAll.elements[].items[].item
 * .entityResultViewModel` (dash), and a flattened `included[]` alongside either. One walk reads all
 * three and keeps reading them after the next rename.
 */
export function personNodes(payload: unknown): Record<string, any>[] {
  const out: Record<string, any>[] = [];
  const seen = new Set<unknown>();
  let visited = 0;

  const walk = (v: unknown, depth: number): void => {
    if (visited++ > MAX_NODES || depth > MAX_DEPTH || !v || typeof v !== "object") return;
    if (seen.has(v)) return; // Voyager graphs are cyclic through `included` references
    seen.add(v);
    if (Array.isArray(v)) {
      for (const item of v) walk(item, depth + 1);
      return;
    }
    const n = v as Record<string, any>;
    if (looksLikePerson(n)) out.push(n);
    // Descend regardless: an entityResultViewModel is nested INSIDE a node that also looks like a
    // hit, and the inner one carries the better fields.
    for (const value of Object.values(n)) {
      if (value && typeof value === "object") walk(value, depth + 1);
    }
  };
  walk(payload, 0);
  return out;
}

/** One node → a person. Pure, total, and never throws — see the fail-soft rule in people.ts. */
export function personFromNode(n: Record<string, any>): LiPerson {
  const nav = n.navigationUrl ?? n.navigationContext?.url ?? n.publicProfileUrl;
  const public_id =
    (typeof n.publicIdentifier === "string" ? n.publicIdentifier : undefined) ??
    publicIdFromUrl(nav) ??
    (typeof n.miniProfile?.publicIdentifier === "string" ? n.miniProfile.publicIdentifier : undefined);

  const name =
    textOf(n.title) ??
    textOf(n.name) ??
    [textOf(n.firstName), textOf(n.lastName)].filter(Boolean).join(" ") ??
    undefined;

  // `primarySubtitle` (dash) and `headline`/`subline` (blended) are the same line under the name.
  const headline = textOf(n.primarySubtitle) ?? textOf(n.headline) ?? textOf(n.occupation) ?? textOf(n.subline);
  // `secondarySubtitle` is the location on a search card — NOT a second headline.
  const location = textOf(n.secondarySubtitle) ?? textOf(n.locationName) ?? textOf(n.geoRegion) ?? textOf(n.location);

  // A structured title/company always beats the headline split; the split is only a fallback.
  const guessed = splitHeadline(headline);
  const title = textOf(n.title_) ?? textOf(n.jobTitle) ?? textOf(n.currentPositionTitle) ?? guessed.title;
  const company =
    textOf(n.companyName) ??
    textOf(n.currentCompany?.name) ??
    textOf(n.company?.name) ??
    textOf(n.currentPositionCompanyName) ??
    guessed.company;

  const urnRaw = n.entityUrn ?? n.targetUrn ?? n.trackingUrn ?? n.objectUrn ?? n.miniProfile?.entityUrn;
  // Normalised to the fsd_ form the invitation endpoints want, from whichever urn flavour arrived.
  const id = urnId(urnRaw);
  const urn = id && /fsd_profile|fs_miniProfile|member/i.test(String(urnRaw)) ? `urn:li:fsd_profile:${id}` : undefined;

  return defined({
    public_id,
    urn,
    name: name || undefined,
    headline,
    title,
    company,
    company_domain: registrableDomain(n.companyWebsite ?? n.currentCompany?.website),
    photo_url: pictureFrom(n),
    location,
    profile_url: profileUrl(public_id),
  }) as LiPerson;
}

/**
 * A payload → people, deduped and ordered as LinkedIn ranked them.
 *
 * Deduped on the public identifier because the walk finds the same person twice by design (once in
 * the cluster, once in `included`), and the two copies carry different fields — so they are MERGED
 * rather than the first one kept. A person with a name from one node and a photo from another is
 * strictly better than either.
 *
 * A hit with no public identifier is dropped, and that is not laziness: the public id is the natural
 * key for the `people` collection. A row that cannot be keyed cannot be re-found, re-enriched or
 * de-duplicated, so writing it would corrupt the graph rather than enrich it.
 */
export function parsePeople(payload: unknown): LiPerson[] {
  const merged = new Map<string, LiPerson>();
  for (const node of personNodes(payload)) {
    const p = personFromNode(node);
    if (!p.public_id) continue;
    const prev = merged.get(p.public_id);
    merged.set(p.public_id, prev ? { ...prev, ...defined(p as Record<string, unknown>) } : p);
  }
  return [...merged.values()];
}

/** LinkedIn's claimed total, from whichever metadata envelope carried it. */
export function totalFrom(payload: unknown): number | undefined {
  const d = asRecord(payload);
  const data = asRecord(d.data);
  return (
    numOf(asRecord(data.metadata).totalResultCount) ??
    numOf(asRecord(asRecord(asRecord(data.data).searchDashClustersByAll).metadata).totalResultCount) ??
    numOf(asRecord(d.paging).total) ??
    numOf(asRecord(data.paging).total)
  );
}

// ── the calls ────────────────────────────────────────────────────────────────────────────────────

/** Free-text keywords: the user's query plus the filters that Voyager has no structured slot for. */
export function keywordsFor(q: PeopleQuery): string {
  return [q.query, q.title, q.company].map((s) => (s ?? "").trim()).filter(Boolean).join(" ");
}

/**
 * Rest.li's `List(a->b,c->d)` filter syntax. Distinct from `restliArgs`' `(k:v)` object syntax —
 * search uses the list-of-pairs form and mixing the two silently returns unfiltered results.
 */
export function searchFilters(q: PeopleQuery): string {
  const parts = ["resultType->PEOPLE"];
  // `geoUrn` wants an urn, and a city NAME is not one. Passing free-text location as a filter is a
  // 400 or, worse, a silent no-op — so it goes into the keywords where it actually does something.
  if (q.location?.trim()) parts.push(`keywords->${encodeURIComponent(q.location.trim())}`);
  return `List(${parts.join(",")})`;
}

function clampLimit(n?: number): number {
  if (!n || !Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(n)));
}

/**
 * Search people. One thin fetch per endpoint, all parsing delegated above.
 *
 * Throws `CommercialSearchLimitError` when LinkedIn says the account is capped, and returns an empty
 * page when it simply found nobody. Those are different answers and the caller is told which.
 */
export async function searchPeople(
  session: LinkedInSession,
  ctx: VoyagerCtx,
  q: PeopleQuery,
): Promise<PeopleSearchPage> {
  const count = clampLimit(q.limit);
  const start = Math.max(0, Math.floor(q.start ?? 0));
  const keywords = keywordsFor(q);
  if (!keywords) return { people: [], via: QID_SEARCH ? "graphql" : "blended" };

  // INFERRED PATH. The mechanism is certain (same persisted-query idiom as messaging), the variable
  // spelling is reconstructed from observation and the query id rotates. Opt-in for exactly that
  // reason: it is better than blended when it works, and must not be able to break search when the
  // hash goes stale.
  if (QID_SEARCH) {
    const variables =
      `(start:${start},count:${count},origin:GLOBAL_SEARCH_HEADER,` +
      `query:(keywords:${encodeURIComponent(keywords)},flagshipSearchIntent:SEARCH_SRP,` +
      `queryParameters:List((key:resultType,value:List(PEOPLE)))))`;
    const r = await voyagerCall(
      `${VOYAGER}/graphql?variables=${variables}&queryId=${QID_SEARCH}`,
      session,
      ctx,
      "search",
    );
    if (r.ok) {
      const people = parsePeople(r.json);
      if (isCommercialLimit(r.status, r.json, people.length)) throw new CommercialSearchLimitError();
      return page(people, r.json, start, count, "graphql");
    }
    if (isCommercialLimit(r.status, r.json, 0)) throw new CommercialSearchLimitError();
    // A stale query id 400s. Fall through to blended rather than failing the search — the same
    // decision voyager.ts makes for a rotated decorationId, for the same reason.
  }

  // CONFIDENT PATH. `q=all` + `filters=List(resultType->PEOPLE)` is the long-lived blended search.
  const params = new URLSearchParams({
    keywords,
    q: "all",
    origin: "GLOBAL_SEARCH_HEADER",
    count: String(count),
    start: String(start),
  });
  const url = `${VOYAGER}/search/blended?${params}&filters=${searchFilters(q)}&queryContext=${restliArgs({
    spellCorrectionEnabled: "true",
  })}`;
  const r = await voyagerCall(url, session, ctx, "search");
  const people = r.ok ? parsePeople(r.json) : [];
  if (isCommercialLimit(r.status, r.json, people.length)) throw new CommercialSearchLimitError();
  if (!r.ok) throw new Error(`voyager search ${r.status}`);
  return page(people, r.json, start, count, "blended");
}

function page(
  people: LiPerson[],
  payload: unknown,
  start: number,
  count: number,
  via: "graphql" | "blended",
): PeopleSearchPage {
  const total = totalFrom(payload);
  // A short page is the end of the results — LinkedIn's `total` is rounded and cannot be trusted to
  // decide this, but "it gave us fewer than we asked for" always can.
  const more = people.length >= count && (total === undefined || start + count < total);
  return { people, total, next_start: more ? start + count : undefined, via };
}

/** Search spends a touch (`touchFor("search_people")`), which today is nothing — but the budget is
 *  declared in capabilities.ts and read from there, so the day it costs something this is already
 *  correct. Exported so the gated wrapper in connect.ts cannot disagree with the table. */
export const SEARCH_TOUCH = touchFor("search_people");
