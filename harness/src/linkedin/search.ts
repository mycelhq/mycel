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
// Captured 2026-08-13 from a logged-in Brave people SRP (`Fil d’actualité` then `Recherche`):
//
//   · The web client no longer loads people results through `voyagerSearchDashClusters`. That
//     persisted query (and typeahead / reusable-typeahead) 302s onto path-only `/voyager/api/graphql`
//     or `/search/blended`. Three of those on one Find looked like an attack and LinkedIn
//     challenged the session. `/me` on the same cookies still 200s because it is not search.
//   · Proven 2026-08-13: `GET /search/results/people/?keywords=founder` with browser HTML headers
//     (no Rest.li, no csrf, no `origin=`) and only `li_at` + `JSESSIONID` is **200** ~905–912KB
//     flagship HTML on home IP and through Decodo-FR (`user-…-country-fr` @ isp.decodo.com:10001).
//     People are SSR `role="listitem"` cards (`/in/` + headline + location). No `bpr-guid`, no
//     `__NEXT_DATA__`, no Voyager GraphQL URL in that document. A later `/flagship-web/rsc-action/*`
//     is client hydration — we do not guess that hop. France is query text, not a geo URN.
//     A 302 to `/uas/login` or an HTML login form is a dead session. A 302 to `/checkpoint/` is a
//     challenge. Path-only `/graphql` is not followed as GET (see proxy.ts).
//   · Cookies `li_at` + `JSESSIONID`. Accept is HTML. Do not send csrf / Rest.li on this GET.
//   · `/voyager/api/search/blended` — DEAD. We do not call it. We do not fire GraphQL after this page.
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
import { isEmptyPeopleSearch, isPeopleSearchUrl } from "./proxy";
import { VOYAGER, voyagerCall, type LinkedInSession, type VoyagerCtx, type VoyagerResponse } from "./voyager";

/** People SRP the logged-in web client actually opens. GraphQL search is not this page. */
export const SEARCH_PAGE = "https://www.linkedin.com/search/results/people/";
export const GRAPHQL_URL = `${VOYAGER}/graphql`;

/** Document navigation, not Voyager JSON. `application/json` is the /me header and 302s this page. */
export const SEARCH_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
/** The XHR the people SRP fires after the document lands. */
export const XHR_ACCEPT = "application/vnd.linkedin.normalized+json+2.1";

/**
 * Headers that make this GET look like opening people search in the browser, not like `/me`.
 * No Origin, no csrf, no Rest.li — those 302 this URL while the same cookies 200 a document GET.
 */
export function searchHeaders(): Record<string, string> {
  return {
    accept: SEARCH_ACCEPT,
    "accept-language": "en-US,en;q=0.9",
    referer: "https://www.linkedin.com/feed/",
    "upgrade-insecure-requests": "1",
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "none",
    "sec-fetch-user": "?1",
  };
}

/** Headers for the one GraphQL/XHR the people page fires — not a document GET, not a spray. */
export function xhrSearchHeaders(referer = SEARCH_PAGE): Record<string, string> {
  return {
    accept: XHR_ACCEPT,
    "accept-language": "en-US,en;q=0.9",
    referer,
    origin: "https://www.linkedin.com",
  };
}

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
  /** Which surface answered — so a support question has an answer without a repro. */
  via: "page" | "graphql";
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
        "LinkedIn's Commercial Search Limit is in force on this account: it has run its month's " +
          "people searches and will return no more until the window rolls over. This is a monthly " +
          "quota, not a rate limit — retrying and waiting an hour will not help. Search is only the " +
          "seed: the pipeline keeps working from the connections this account already has, the " +
          "people engaging with its posts, and referrals, while the window resets. Narrow next " +
          "month's searches so each one returns people worth contacting.",
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

function decodeHtml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripTags(s: string): string {
  return decodeHtml(s.replace(/<[^>]+>/g, " "));
}

/** Flagship SSR often repeats the name in the profile-link text ("Ada Lovelace Ada Lovelace"). */
function collapseDoubledName(name?: string): string | undefined {
  if (!name) return undefined;
  const t = name.trim();
  const m = t.match(/^(.+?)\s+\1$/);
  return (m?.[1] ?? t) || undefined;
}

/**
 * People from the SSR people SRP. Brave 2026-08: `role="listitem"` cards with `/in/` hrefs,
 * hashed CSS, no `data-chameleon-result-urn`. Name is the profile-link text; the next two
 * `<p><span>` lines are headline and location.
 */
export function parseHtmlPeople(html: string): LiPerson[] {
  const merged = new Map<string, LiPerson>();
  const chunks = html.includes("role=\"listitem\"") ? html.split(/role="listitem"/i) : [html];
  for (const chunk of chunks) {
    const href = chunk.match(/linkedin\.com\/in\/([^"/?#]+)/i);
    if (!href) continue;
    let public_id: string;
    try {
      public_id = decodeURIComponent(href[1]).replace(/\/+$/, "");
    } catch {
      public_id = href[1].replace(/\/+$/, "");
    }
    if (!public_id || merged.has(public_id)) continue;

    const link = chunk.match(
      /href="https?:\/\/(?:www\.)?linkedin\.com\/in\/[^"]+"[^>]*>([\s\S]*?)<\/a>/i,
    );
    const name = collapseDoubledName(link ? stripTags(link[1]) : undefined);
    const lines = [...chunk.matchAll(/<p[^>]*>\s*<span>([^<]+)<\/span>\s*<\/p>/gi)].map((m) =>
      decodeHtml(m[1]),
    );
    const headline = lines[0] || undefined;
    const location = lines[1] || undefined;
    const urnHit = chunk.match(/id="SearchResults(ACo[A-Za-z0-9_-]+)"/);
    const urn = urnHit ? `urn:li:fsd_profile:${urnHit[1]}` : undefined;
    const guessed = splitHeadline(headline);
    merged.set(
      public_id,
      defined({
        public_id,
        urn,
        name: name || undefined,
        headline,
        title: guessed.title,
        company: guessed.company,
        location,
        profile_url: profileUrl(public_id),
      }) as LiPerson,
    );
  }
  return [...merged.values()];
}

const MAX_EMBEDDED_BLOBS = 40;
const MAX_BLOB_CHARS = 1_500_000;

function unescapeHtmlJson(s: string): string {
  return s
    .replace(/^\s*<!--/, "")
    .replace(/-->\s*$/, "")
    .replace(/&quot;/gi, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#x22;/gi, '"')
    .replace(/&amp;/gi, "&")
    .replace(/&#92;/g, "\\")
    .replace(/\\u0026/gi, "&")
    .replace(/\\\//g, "/")
    .trim();
}

function parseJsonBlob(raw: string): unknown | undefined {
  const sliced = raw.length > MAX_BLOB_CHARS ? raw.slice(0, MAX_BLOB_CHARS) : raw;
  const candidates = [sliced, unescapeHtmlJson(sliced)];
  for (const c of candidates) {
    if (!c || (c[0] !== "{" && c[0] !== "[")) continue;
    try {
      return JSON.parse(c);
    } catch {
      /* next encoding */
    }
  }
  return undefined;
}

function takeBlobs(html: string, re: RegExp): unknown[] {
  const out: unknown[] = [];
  for (const m of html.matchAll(re)) {
    if (out.length >= MAX_EMBEDDED_BLOBS) break;
    const parsed = parseJsonBlob(m[1] ?? "");
    if (parsed !== undefined) out.push(parsed);
  }
  return out;
}

/**
 * People from Voyager SSR: `<code id="bpr-guid-…">`, `__NEXT_DATA__`, and JSON script tags.
 * The listitem cards are client-rendered from this; walking only the markup misses them.
 */
export function parseEmbeddedPeople(html: string): LiPerson[] {
  if (!html) return [];
  const blobs = [
    ...takeBlobs(html, /<code[^>]*id="bpr-guid-[^"]+"[^>]*>([\s\S]*?)<\/code>/gi),
    ...takeBlobs(html, /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/gi),
    ...takeBlobs(html, /<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/gi),
  ];
  const merged = new Map<string, LiPerson>();
  for (const blob of blobs) {
    for (const p of parsePeople(blob)) {
      if (!p.public_id) continue;
      const prev = merged.get(p.public_id);
      merged.set(p.public_id, prev ? { ...prev, ...defined(p as Record<string, unknown>) } : p);
    }
  }
  return [...merged.values()];
}

/** JSON body, then embedded Voyager HTML, then listitem cards. */
export function peopleFromSearchBody(json: unknown, text: string): LiPerson[] {
  const fromJson = parsePeople(json);
  if (fromJson.length) return fromJson;
  const embedded = parseEmbeddedPeople(text ?? "");
  if (embedded.length) return embedded;
  return parseHtmlPeople(text ?? "");
}

/**
 * Empty HTML that is a login form, not a people SRP. A 200 here still means the session is dead.
 * Narrow: a normal SRP mentions "sign in" in chrome; it does not ship a password form.
 */
export function isLoginHtml(html: string): boolean {
  if (!html) return false;
  const s = html.slice(0, 80_000).toLowerCase();
  const form = /<form[\s>]/.test(s) && /password|session_password|session_key|login-email/.test(s);
  const uas = /\/uas\/login/.test(s) && /session_redirect|sign in|s['’]identifier/.test(s);
  return form || uas;
}

/** The one GraphQL URL the people SRP would fire next, copied from the HTML. */
export function graphqlXhrFromHtml(html: string): string | undefined {
  if (!html) return undefined;
  const patterns = [
    /https:\/\/(?:www\.)?linkedin\.com\/voyager\/api\/graphql\?[^"'\\\s<>]+/i,
    /\/voyager\/api\/graphql\?[^"'\\\s<>]*queryId=voyagerSearchDashClusters[^"'\\\s<>]*/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (!m) continue;
    let u = unescapeHtmlJson(m[0]);
    if (u.startsWith("/")) u = `https://www.linkedin.com${u}`;
    if (!/\/voyager\/api\/graphql/i.test(u)) continue;
    if (!/[?&](queryId|variables)=/i.test(u)) continue;
    return u;
  }
  return undefined;
}

export function clustersQueryIdFromHtml(html: string): string | undefined {
  const m = html.match(/voyagerSearchDashClusters\.[a-f0-9]{8,}/i);
  return m?.[0];
}

/** People SRP variables as JSON — used only when the HTML named a clusters queryId but not a URL. */
export function clustersVariables(keywords: string, start: number): Record<string, unknown> {
  return {
    start,
    origin: "GLOBAL_SEARCH_HEADER",
    query: {
      keywords,
      flagshipSearchIntent: "SEARCH_SRP",
      queryParameters: [{ key: "resultType", value: ["PEOPLE"] }],
      includeFiltersInResponse: false,
    },
  };
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
  return [q.query, q.title, q.company, q.location].map((s) => (s ?? "").trim()).filter(Boolean).join(" ");
}

/** One GET: the document URL that 200s people HTML on home IP and Decodo-FR. No `origin=`. */
export function peopleSearchUrl(keywords: string, start = 0): string {
  const params = new URLSearchParams({ keywords });
  if (start > 0) params.set("page", String(Math.floor(start / DEFAULT_LIMIT) + 1));
  return `${SEARCH_PAGE}?${params.toString()}`;
}

/** Path-only `/search/blended` or `/graphql` (or a 302 onto either) is not a people-search response. */
export function isDeadSearchRedirect(status: number, location?: string): boolean {
  if (status < 300 || status >= 400) return false;
  return /\/voyager\/api\/(graphql|search\/blended)\/?$/i.test(location ?? "");
}

/** @deprecated Prefer isDeadSearchRedirect — blended is not the only dead 302. */
export function isBlendedSearchRedirect(status: number, location?: string): boolean {
  if (status < 300 || status >= 400) return false;
  return /\/voyager\/api\/search\/blended/i.test(location ?? "");
}

function clampLimit(n?: number): number {
  if (!n || !Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(n)));
}

/** 302 to /uas/login on an otherwise-live /me session is missing cookies on this call, or the session died. */
export function isSessionRedirect(status: number, location?: string): boolean {
  if (status < 300 || status >= 400) return false;
  return /\/uas\/login/i.test(location ?? "");
}

/** Voyager (or the people GET) 302'd onto the HTML SRP — with or without query. */
export function isPeopleSrpRedirect(status: number, location?: string): boolean {
  if (status < 300 || status >= 400) return false;
  return isPeopleSearchUrl(location ?? "");
}

/**
 * The 302 that means "search is refused", distinguished from the 302 that means "follow me".
 *
 * We asked for `?keywords=…`; LinkedIn 302'd us onto a BARE `/search/results/people/` with the query
 * dropped. Following that just loads a keyword-less page, so it is not a hop — it is LinkedIn
 * declining the search. On a free account this is the monthly Commercial Search Limit surfacing as a
 * redirect rather than the upsell copy `isCommercialLimit()` looks for, which is exactly why a capped
 * account otherwise reads as "no results" (a targeting problem) instead of "you are out of searches".
 *
 * It keys on `r.redirectUrl` — the ABSOLUTE Location including the querystring — never `r.location`,
 * which is host+path only (the query is always stripped for logging) and so would look empty every
 * time. If we only have the stripped location, we cannot tell keyword-dropped from keyword-kept, so
 * we say no and let the ordinary follow path decide.
 */
export function isSearchRefusedRedirect(r: VoyagerResponse, keywords: string): boolean {
  if (!keywords) return false;
  const dest = r.redirectUrl ?? "";
  return !!dest && isPeopleSrpRedirect(r.status, dest) && isEmptyPeopleSearch(dest);
}

function finish(r: VoyagerResponse, found: number): void {
  if (isCommercialLimit(r.status, r.json, found)) throw new CommercialSearchLimitError();
}

function searchFail(r: VoyagerResponse, session = false): Error {
  const where = r.location ? ` → ${r.location}` : "";
  const why = session || isSessionRedirect(r.status, r.location) ? " (session)" : "";
  return new Error(`LinkedIn didn't return people (${r.status}${where}${why})`);
}

function sameUrl(a: string, b: string): boolean {
  try {
    const left = new URL(a);
    const right = new URL(b);
    left.hash = "";
    right.hash = "";
    return left.toString() === right.toString();
  } catch {
    return a === b;
  }
}

type Collected = { people: LiPerson[]; payload: unknown; via: "page" | "graphql" };

function collectPeople(r: VoyagerResponse): Collected {
  const fromJson = parsePeople(r.json);
  if (fromJson.length) return { people: fromJson, payload: r.json, via: "graphql" };
  const fromHtml = peopleFromSearchBody(undefined, r.text ?? "");
  return { people: fromHtml, payload: r.json, via: "page" };
}

/**
 * Search people. GET `/search/results/people/?keywords=…` as a document. Parse flagship SSR
 * listitem cards (and any embedded JSON). Do not fire Voyager GraphQL — that 302s and challenges.
 * A 302 onto the same people path is still the HTML SRP; follow it with the same browser headers.
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
  if (!keywords) return { people: [], via: "page" };

  const pageUrl = peopleSearchUrl(keywords, start);
  let r = await voyagerCall(pageUrl, session, ctx, "search", { headers: searchHeaders() });
  let found = collectPeople(r);

  // A 302 that DROPPED our keywords onto a bare SRP is LinkedIn refusing the search, not a page to
  // follow. Name it as the (already wired) commercial-limit condition so the founder is told the
  // truth and the loop leans on connections/engagement/referrals — never as "no people found".
  if (!found.people.length && isSearchRefusedRedirect(r, keywords)) throw new CommercialSearchLimitError();

  const dest = r.redirectUrl ?? "";
  if (!found.people.length && isPeopleSrpRedirect(r.status, dest || r.location) && dest && !sameUrl(dest, pageUrl)) {
    r = await voyagerCall(dest, session, ctx, "search", { headers: searchHeaders() });
    found = collectPeople(r);
    // The follow can itself land on a keyword-stripped SRP (the throttle appearing one hop late).
    if (!found.people.length && isSearchRefusedRedirect(r, keywords)) throw new CommercialSearchLimitError();
  }

  if (found.people.length) {
    finish(r, found.people.length);
    return page(found.people.slice(0, count), found.payload, start, count, found.via);
  }

  if (isLoginHtml(r.text ?? "") || isSessionRedirect(r.status, r.location)) {
    finish(r, 0);
    throw searchFail(r, true);
  }

  finish(r, 0);
  if (!r.ok && !found.people.length) throw searchFail(r);
  return page([], r.json, start, count, "page");
}

function page(
  people: LiPerson[],
  payload: unknown,
  start: number,
  count: number,
  via: "page" | "graphql",
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
