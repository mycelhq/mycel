// One profile, and one company, in detail.
//
// ── WHY THIS FILE IS A LADDER AND NOT AN ENDPOINT ────────────────────────────────────────────────
// On 2026-08-18 `GET /voyager/api/identity/profiles/{publicId}/profileView` started answering 410
// Gone. It had been the CONFIDENT endpoint here for years, and its retirement took `get_profile`,
// `view_profile` and the urn resolution inside `send_invite` with it — i.e. all LinkedIn outbound,
// for every account, at once. health.ts made that failure quiet; this file makes it survivable.
//
// The lesson of that incident is not "pick the next endpoint". It is that we cannot verify ANY
// profile endpoint from here — nobody in this repo has a live session — so a single guessed endpoint
// is a single point of failure dressed up as a decision. What we can do is try the candidates the
// web app is known to use, in cheapest-first order, LATCH onto whichever one answers with a shape we
// can parse, and — when none of them do — fail with a permanent code and the exact devtools capture
// that would fix it, instead of a status code nobody can act on.
//
// ── THE CANDIDATES, AND THE EVIDENCE FOR EACH ────────────────────────────────────────────────────
//   1. `dash-profiles` — `GET /voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=
//      {publicId}`. INFERRED, but on the same mechanism as `getCompany`'s CONFIDENT
//      `?q=universalName` finder below: a Rest.li dash collection addressed by a named finder. It is
//      the resource the modern web app's profile queries are built on, it needs no rotating hash,
//      and it is by far the cheapest of the three. `decorationId` is an OPTIMISATION here and never
//      a requirement — which is the bug in the version this replaces: that code only ever issued
//      this request when `MYCEL_LINKEDIN_PROFILE_DECORATION` was set, and it is set nowhere, so the
//      "dash probe" a reader sees in the git history never actually left the building in production.
//      It also latched itself OFF for the process on the first 400/404, which for an unset decoration
//      means the endpoint was blamed for a parameter we chose. Both are fixed: undecorated first-
//      class, decoration only added when configured, and a decoration rejection drops the DECORATION
//      rather than the candidate.
//   2. `graphql-dash-profiles` — `GET /voyager/api/graphql?includeWebMetadata=true&variables=(…)
//      &queryId=voyagerIdentityDashProfiles.<hash>`. The URL FORM is confident: `discover.ts` builds
//      exactly it for the company People tab and voyager.ts for the inbox. The `<hash>` is the part
//      we refuse to invent — a persisted-query id is a content hash of LinkedIn's own query document
//      and a made-up one is a guaranteed 400 plus a request that looks like probing. So this
//      candidate is SKIPPED unless a hash is known, from `MYCEL_LINKEDIN_QID_PROFILE` or harvested
//      out of the profile page HTML the way search.ts harvests the clusters id.
//   3. `profile-page` — `GET https://www.linkedin.com/in/{publicId}/` as a browser DOCUMENT, parsing
//      the SSR JSON islands (`bpr-guid` / `__NEXT_DATA__` / `application/json`) and then the markup.
//      This is the highest-evidence candidate in the file: search.ts PROVED on 2026-08-13 that this
//      exact manoeuvre — document accept, no csrf, no Rest.li, no origin, just `li_at` +
//      `JSESSIONID` — returns 200 flagship HTML on a home IP and through a residential proxy, while
//      the JSON APIs 302. It is also the only candidate that cannot be retired by an API change,
//      because it is the page a human loads. It is last because it is ~900KB against ~20KB.
//      A bonus that matters for `view_profile`: loading the profile page is *literally* what makes
//      LinkedIn record a profile view, so this candidate is the most honest version of that action.
//   4. `legacy-profile-view` — the 410'd endpoint. OFF unless `MYCEL_LINKEDIN_LEGACY_PROFILEVIEW=1`,
//      kept only so that a founder whose account is still served the old surface can switch it back
//      on without a deploy. It is never first: a 410 stamps the connection inside voyager.ts.
//
// ── ENDPOINT CONFIDENCE (companies) ──────────────────────────────────────────────────────────────
//   · `GET /voyager/api/organization/companies?q=universalName&universalName={slug}` — CONFIDENT on
//     the path and the `q` parameter.
//
// ── WHY `view_profile` IS A PROFILE FETCH ────────────────────────────────────────────────────────
// There is no "register a view" action on LinkedIn, and inventing an endpoint for one would be
// guessing. A profile view is a SIDE EFFECT of loading the profile while authenticated: LinkedIn
// records it and shows it in the target's "who viewed your profile", subject to the *viewer's* own
// privacy setting. So `viewProfile` is `getProfile` with a different name, a different touch cost and
// a different risk class — and that is the honest implementation, not a shortcut.
//
// The consequence is worth stating because it surprises people: an account in anonymous or
// semi-private viewing mode produces no notification, so the warm-up touch is spent for nothing. The
// founder has to set their profile-viewing option to public for this step to do anything at all,
// which capabilities.ts already says in its `caution` and which the return value reports here.
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
  type LiCompany,
  type LiPerson,
} from "./people";
import {
  LinkedInGoneError,
  LinkedInProfileEndpointUnknownError,
  clearLinkedInStop,
  ENDPOINT_GONE_CODE,
} from "./health";
import { embeddedJsonBlobs, searchHeaders } from "./search";
import { VOYAGER, voyagerCall, type LinkedInSession, type VoyagerCtx, type VoyagerResponse } from "./voyager";

/** A profile, in more detail than a search card carries. */
export interface LiProfile extends LiPerson {
  summary?: string;
  industry?: string;
  /** The employer's LinkedIn slug, when the current position named one — the key for `get_company`. */
  company_slug?: string;
  /** Best-effort: the employer's urn, for callers that want to follow the edge. */
  company_urn?: string;
  /**
   * Whatever skills the payload happened to carry.
   *
   * Harvested from the read we already do rather than fetched: `endorseSkill` needs a URN off the
   * member's own profile, and adding a call for it would spend requests on an account we are
   * trying not to spend. Empty is the common case and is not an error — the caller reports "no
   * craft skill listed" and skips, which is the whole difference from the silent skip this
   * replaces.
   */
  skills?: LiSkill[];
}

/** Optional named response shape for the dash profile read. Rotates; empty = undecorated (fine). */
const PROFILE_DECORATION = process.env.MYCEL_LINKEDIN_PROFILE_DECORATION ?? "";
/** A captured `voyagerIdentityDashProfiles.<hash>`. Empty disables the GraphQL candidate entirely. */
const PROFILE_QID = process.env.MYCEL_LINKEDIN_QID_PROFILE ?? "";
/** Re-enable the 410'd legacy endpoint for an account LinkedIn still serves it to. */
const LEGACY_PROFILE_VIEW = process.env.MYCEL_LINKEDIN_LEGACY_PROFILEVIEW === "1";

// ── pure parsers ─────────────────────────────────────────────────────────────────────────────────

/** Depth/node caps on the walks. Same reasoning as search.ts: a parse must never become a hang. */
const MAX_DEPTH = 12;
const MAX_NODES = 20_000;

/** Every object in a payload, bounded and cycle-safe. Voyager graphs are cyclic through `included`. */
function walkNodes(payload: unknown, keep: (n: Record<string, any>) => boolean): Record<string, any>[] {
  const out: Record<string, any>[] = [];
  const seen = new Set<unknown>();
  let visited = 0;
  const walk = (v: unknown, depth: number): void => {
    if (visited++ > MAX_NODES || depth > MAX_DEPTH || !v || typeof v !== "object") return;
    if (seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) {
      for (const item of v) walk(item, depth + 1);
      return;
    }
    const n = v as Record<string, any>;
    if (keep(n)) out.push(n);
    for (const value of Object.values(n)) if (value && typeof value === "object") walk(value, depth + 1);
  };
  walk(payload, 0);
  return out;
}

/** Does this node look like a POSITION (a job), rather than a person or a wrapper? */
function looksLikePosition(n: Record<string, any>): boolean {
  const hasEmployer = !!(n.companyName || n.companyUrn || asRecord(n.company).name || asRecord(n.company).universalName);
  const hasRole = !!(n.title || n.jobTitle);
  if (!hasEmployer && !hasRole) return false;
  // A profile node carries `firstName`; a position never does. Without this the walk happily calls
  // the member their own employer on payloads that inline `companyName` at the top level.
  if (n.firstName || n.lastName || n.publicIdentifier) return false;
  return hasEmployer || (hasRole && !!n.timePeriod);
}

/**
 * The current position, wherever the payload happened to put jobs.
 *
 * Three shapes are in the wild: legacy `positionView.elements`, `positionGroupView.elements`, and the
 * dash shape where positions are separate entities in `included` (`profileTopPosition`,
 * `profilePositionGroups`, or just loose `*ProfilePosition` nodes). The explicit containers are
 * checked first because their ORDER is meaningful — LinkedIn returns positions newest-first — and the
 * walk is the fallback for the shape where there is no container to order.
 *
 * "Current" is the one with no end date. Falling back to the first element is right rather than lazy:
 * element zero is the current role in every payload where the date is simply missing — which is
 * common, because people do not fill it in.
 */
export function currentPosition(payload: unknown): Record<string, any> | undefined {
  const d = asRecord(payload);
  const containers: any[] = [
    asRecord(d.positionView).elements,
    asRecord(d.positionGroupView).elements,
    asRecord(d.positions).elements,
    asRecord(d.profileTopPosition).elements,
    asRecord(d.profilePositionGroups).elements,
    Array.isArray(d.positions) ? d.positions : undefined,
  ];
  for (const elements of containers) {
    if (!Array.isArray(elements) || !elements.length) continue;
    const open = elements.map(asRecord).find((p) => !asRecord(p.timePeriod).endDate && !p.endDate);
    return open ?? asRecord(elements[0]);
  }
  const found = walkNodes(payload, looksLikePosition);
  if (!found.length) return undefined;
  return found.find((p) => !asRecord(p.timePeriod).endDate && !p.endDate) ?? found[0];
}

/** The `/company/<slug>` segment, wherever the position happened to carry it. */
export function companySlugFrom(pos: Record<string, any> | undefined): string | undefined {
  if (!pos) return undefined;
  const direct = asRecord(pos.company).universalName ?? asRecord(asRecord(pos.company).miniCompany).universalName;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const url = String(pos.companyUrl ?? asRecord(pos.company).url ?? "");
  const m = url.match(/linkedin\.com\/company\/([^/?#]+)/i);
  return m ? decodeURIComponent(m[1]) : undefined;
}

/** The public identifier a node carries, wherever it carries it. */
function publicIdOf(n: Record<string, any>): string | undefined {
  const direct = n.publicIdentifier ?? asRecord(n.miniProfile).publicIdentifier;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const nav = String(n.navigationUrl ?? n.publicProfileUrl ?? n.profileUrl ?? "");
  const m = nav.match(/linkedin\.com\/in\/([^/?#]+)/i);
  if (!m) return undefined;
  try {
    return decodeURIComponent(m[1]) || undefined;
  } catch {
    return m[1];
  }
}

/** The name a node carries: `firstName`/`lastName`, or the single `title`/`name` a card uses. */
function nameOf(n: Record<string, any>): string | undefined {
  const parts = [textOf(n.firstName), textOf(n.lastName)].filter(Boolean).join(" ");
  return parts || textOf(n.name) || undefined;
}

/** Is this node the MEMBER — as opposed to a job, a school, a company or a wrapper? */
function looksLikeProfile(n: Record<string, any>): boolean {
  if (n.publicIdentifier || asRecord(n.miniProfile).publicIdentifier) return true;
  if (n.firstName || n.lastName) return true;
  // A `/in/` navigation url plus a name is a person card ("people also viewed", the page header).
  return !!(publicIdOf(n) && nameOf(n));
}

/** The trailing id of any profile-flavoured urn on this node. */
function profileUrnId(n: Record<string, any>): string | undefined {
  const raw = n.entityUrn ?? asRecord(n.miniProfile).entityUrn ?? n.objectUrn ?? n.dashEntityUrn ?? n.targetUrn;
  if (typeof raw !== "string") return undefined;
  if (raw.includes(":") && !/fsd_profile|fs_miniProfile|fs_profile|member:/i.test(raw)) return undefined;
  return urnId(raw);
}

/**
 * The member nodes in a payload, best candidate first.
 *
 * `wantPublicId` is not cosmetic. A profile PAGE carries a dozen people — "people also viewed",
 * recommenders, the viewer themself — and picking the first person-shaped node out of that document
 * would silently return the wrong human, which is worse than returning nothing: it is a stranger
 * written into the CRM under someone else's key and, downstream, an invitation to the wrong person.
 */
export function profileNodes(payload: unknown, wantPublicId?: string): Record<string, any>[] {
  const all = walkNodes(payload, looksLikeProfile);
  const want = wantPublicId?.toLowerCase();
  if (!want) return all;
  const mine = all.filter((n) => publicIdOf(n)?.toLowerCase() === want);
  if (mine.length) return mine;
  // No node claimed the slug. Nodes with no public identifier at all can still be the member (the
  // dash Profile entity often carries only an entityUrn); nodes claiming a DIFFERENT slug cannot.
  return all.filter((n) => !publicIdOf(n));
}

/**
 * A profile payload → a profile. Pure, total, and tolerant.
 *
 * Reads the legacy shape (`profile.firstName`, `positionView`), the dash shape (`elements[0]` with
 * attributed strings), the GraphQL envelope and the SSR page bootstrap, because which one an account
 * is served is LinkedIn's decision, not ours — the same reason `inboundMessages` reads two shapes.
 *
 * TOLERANCE, precisely. Fields are extracted where they exist and OMITTED where they do not:
 * `defined()` drops undefined and empty strings, so a missing headline is an absent key and never an
 * empty one. That distinction is load-bearing — graph.ts merges these records, so an empty string
 * would overwrite a good value a previous read had already learned. Nothing here throws on a missing
 * optional field; the only thing that can fail is the identity check below.
 *
 * The one refusal: a document with neither a public identifier nor a name is NOT a profile, and
 * saying so is what lets the strategy ladder tell "unrecognised shape" apart from "read worked".
 */
export function parseProfile(payload: unknown, wantPublicId?: string): LiProfile | null {
  const root = asRecord(payload);
  const nodes = profileNodes(payload, wantPublicId);
  // Legacy first: `profile` / `elements[0]` are the containers whose position IS the answer, so they
  // win over anything the walk turned up in `included`.
  const explicit = asRecord(root.profile ?? (Array.isArray(root.elements) ? root.elements[0] : undefined));
  const wanted = wantPublicId?.toLowerCase();
  const isWanted = (n: Record<string, any>): boolean => {
    const slug = publicIdOf(n)?.toLowerCase();
    return !wanted || !slug || slug === wanted;
  };
  const primary = looksLikeProfile(explicit) && isWanted(explicit) ? explicit : (nodes[0] ?? explicit);
  if (!looksLikeProfile(primary) && !looksLikeProfile(asRecord(root))) return null;
  const p = looksLikeProfile(primary) ? primary : asRecord(root);
  // Skills come off the WHOLE payload, not the profile node: LinkedIn returns them as siblings in
  // `included[]` rather than nested under the person.
  const skills = parseSkills(payload);

  const public_id = publicIdOf(p) ?? wantPublicId;
  const id = profileUrnId(p);
  // The dash shape SPLITS one member across several entities in `included` — the name on one, the
  // photo on another, the headline on a third. Merging the fragments that are provably the same
  // person (same slug, or same urn id) is the difference between a full row and a name.
  // Fragments are looked for among ALL member nodes, not just the ones that claimed the slug: the
  // dash/GraphQL shapes put the name and the photo on `included` entities that carry an entityUrn
  // and no publicIdentifier at all, so slug-filtering first is how a full profile becomes a slug.
  const parts = walkNodes(payload, looksLikeProfile).filter((n) => {
    if (n === p) return false;
    const slug = publicIdOf(n);
    if (slug && public_id) return slug.toLowerCase() === public_id.toLowerCase();
    const nid = profileUrnId(n);
    return !!nid && !!id && nid === id;
  });
  const pick = <T>(read: (n: Record<string, any>) => T | undefined): T | undefined => {
    const own = read(p);
    if (own !== undefined) return own;
    for (const n of parts) {
      const v = read(n);
      if (v !== undefined) return v;
    }
    return undefined;
  };

  const name = pick(nameOf);
  // No public identifier and no name means this is not a profile document — say so rather than
  // returning a hollow object the caller will happily write to the graph.
  if (!public_id && !name) return null;

  // Positions can live on the member node (legacy) or anywhere in the document (dash `included`).
  const pos = currentPosition(p) ?? currentPosition(root);
  const company = asRecord(pos?.company);
  const headline = pick((n) => textOf(n.headline) ?? textOf(asRecord(n.miniProfile).occupation) ?? textOf(n.occupation));
  // A guess, and only ever a fallback — a structured title/company in the payload always wins. Same
  // rule, and the same reasoning, as `personFromNode` in search.ts.
  const guessed = splitHeadline(headline);

  return defined({
    public_id,
    urn: id ? `urn:li:fsd_profile:${id}` : undefined,
    name,
    headline,
    title: (pos ? textOf(pos.title) : undefined) ?? guessed.title,
    company: (pos ? (textOf(pos.companyName) ?? textOf(company.name)) : undefined) ?? guessed.company,
    company_domain: registrableDomain(company.companyPageUrl ?? company.website ?? pos?.companyWebsite),
    company_slug: companySlugFrom(pos),
    company_urn: typeof pos?.companyUrn === "string" ? pos.companyUrn : undefined,
    // Undefined rather than [] when there are none, so a caller can tell "we looked and there were
    // none" from "this shape does not carry skills" only by asking parseSkills directly.
    skills: skills.length > 0 ? skills : undefined,
    photo_url: pick((n) => pictureFrom(n) ?? pictureFrom(asRecord(n.miniProfile))),
    location: pick(
      (n) =>
        textOf(n.geoLocationName) ??
        textOf(n.locationName) ??
        textOf(asRecord(n.geoLocation).defaultLocalizedName) ??
        textOf(asRecord(n.profileGeoLocation).defaultLocalizedName) ??
        textOf(asRecord(n.location).defaultLocalizedName) ??
        textOf(n.location) ??
        textOf(n.secondarySubtitle),
    ),
    industry: pick((n) => textOf(n.industryName) ?? textOf(n.industry) ?? textOf(asRecord(n.industry).name)),
    summary: pick((n) => textOf(n.summary) ?? textOf(n.about)),
    profile_url: profileUrl(public_id),
  }) as LiProfile;
}

/** A companies payload → a company. Pure and total. */
export function parseCompany(payload: unknown): LiCompany | null {
  const root = asRecord(payload);
  const c = asRecord(Array.isArray(root.elements) ? root.elements[0] : root.company ?? root);
  const name = textOf(c.name) ?? textOf(c.localizedName);
  const universal_name = typeof c.universalName === "string" ? c.universalName : undefined;
  if (!name && !universal_name) return null;

  // The website is the ONLY field here that can produce the natural key, so it is worth reading from
  // every place it hides. A company with no resolvable domain is still returned — the caller decides
  // whether an unkeyable company is worth writing (graph.ts says no, and explains why there).
  const website = textOf(c.companyPageUrl) ?? textOf(c.website) ?? textOf(asRecord(c.callToAction).url);
  const industries = Array.isArray(c.industries) ? c.industries : [];

  return defined({
    universal_name,
    name,
    domain: registrableDomain(website),
    website,
    industry: textOf(industries[0]) ?? textOf(c.industryName) ?? textOf(c.industry),
    // `staffCount` is LinkedIn's own headcount; `employeeCountRange` is a bucket, not a number, so it
    // is deliberately not coerced into one.
    headcount: numOf(c.staffCount) ?? numOf(c.employeeCount),
    logo_url: pictureFrom(c) ?? pictureFrom(asRecord(c.logo)),
    description: textOf(c.description) ?? textOf(c.tagline),
    urn: typeof c.entityUrn === "string" ? c.entityUrn : undefined,
  }) as LiCompany;
}

// ── the calls ────────────────────────────────────────────────────────────────────────────────────

/** A public identifier, safe to put in a path. Rejects anything that could escape the segment. */
export function safeProfileId(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  // Accept a full profile URL as a convenience — an agent will paste one sooner or later.
  const fromUrl = s.match(/linkedin\.com\/in\/([^/?#]+)/i);
  const id = fromUrl ? decodeURIComponent(fromUrl[1]) : s;
  // A public identifier is a slug. Anything with a slash, a dot-dot or whitespace is not one, and
  // this string is about to be concatenated into a URL path.
  if (!/^[A-Za-z0-9À-ɏ%_-]{1,120}$/.test(id)) return null;
  return id;
}

/** Same rule for a company slug. */
export function safeCompanySlug(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  const fromUrl = s.match(/linkedin\.com\/company\/([^/?#]+)/i);
  const id = fromUrl ? decodeURIComponent(fromUrl[1]) : s;
  if (!id || !/^[A-Za-z0-9À-ɏ%._-]{1,120}$/.test(id)) return null;
  return id;
}

// ── the strategy ladder ──────────────────────────────────────────────────────────────────────────

export const PROFILE_STRATEGIES = [
  "dash-profiles",
  "graphql-dash-profiles",
  "profile-page",
  "legacy-profile-view",
] as const;

export type ProfileStrategyName = (typeof PROFILE_STRATEGIES)[number];

/** What one candidate did, in one line — the diagnosis a founder or an issue needs. */
export interface ProfileAttempt {
  strategy: ProfileStrategyName;
  status?: number;
  outcome: "parsed" | "not-found" | "unrecognised-shape" | "gone" | "skipped" | "error";
  note?: string;
}

export interface ProfileRead {
  profile: LiProfile | null;
  /** Which candidate answered. Undefined when the answer was "no such profile" from all of them. */
  via?: ProfileStrategyName;
  attempts: ProfileAttempt[];
}

/** Set once the configured decoration is rejected — a rotated id then costs one 400 in total, and
 *  costs the DECORATION rather than the candidate, which is the bug in the version this replaces. */
let profileDecorationRejected = false;
/** The candidate that last returned a parsable profile. Tried first from then on. */
let latched: ProfileStrategyName | undefined;
/** Candidates LinkedIn has permanently refused (410) or that answered a shape we cannot read. */
const retired = new Set<ProfileStrategyName>();
/** A queryId harvested out of profile-page HTML, when the env var did not supply one. */
let harvestedQid: string | undefined;

/** What the ladder currently believes. Read by `send_invite` and by the verify script. */
export function profileStrategyState(): {
  latched?: ProfileStrategyName;
  retired: ProfileStrategyName[];
  queryId?: string;
} {
  return { latched, retired: [...retired], queryId: PROFILE_QID || harvestedQid || undefined };
}

/** Test hook: forget everything the ladder learned. */
export function _resetProfileStrategies(): void {
  latched = undefined;
  retired.clear();
  harvestedQid = undefined;
  profileDecorationRejected = false;
}

/** A persisted-query id for profiles, if the HTML named one. Never invented — see the header. */
export function profileQueryIdFromHtml(html: string): string | undefined {
  const m = (html ?? "").match(/voyagerIdentityDash(?:Profiles|ProfileCards)\.[a-f0-9]{8,}/i);
  return m?.[0];
}

/** The dash finder URL. `decorationId` is an optimisation; its absence is a working request. */
export function dashProfileUrl(id: string): string {
  const params = new URLSearchParams({ q: "memberIdentity", memberIdentity: id });
  if (PROFILE_DECORATION && !profileDecorationRejected) params.set("decorationId", PROFILE_DECORATION);
  return `${VOYAGER}/identity/dash/profiles?${params}`;
}

/** The GraphQL URL, in the exact form discover.ts proved for the company People tab. */
export function graphqlProfileUrl(id: string, queryId: string): string {
  const variables = `(vanityName:${encodeURIComponent(id)})`;
  return `${VOYAGER}/graphql?includeWebMetadata=true&variables=${variables}&queryId=${queryId}`;
}

/** The page a human opens. Trailing slash and `/` accept: this is a document GET, not an API call. */
export function profilePageUrl(id: string): string {
  return `https://www.linkedin.com/in/${encodeURIComponent(id)}/`;
}

/** Browser document headers, borrowed wholesale from the search path that proved they 200. */
function profilePageHeaders(): Record<string, string> {
  return { ...searchHeaders(), referer: "https://www.linkedin.com/feed/" };
}

/**
 * A profile out of a flagship profile document: the SSR JSON islands first, the markup as a floor.
 *
 * The markup floor is deliberately thin — name, headline, location, photo, and the slug we asked for.
 * It exists so that a LinkedIn deploy which changes the bootstrap format still yields a row a founder
 * can act on rather than nothing at all.
 */
export function parseProfilePage(html: string, publicId: string): LiProfile | null {
  for (const blob of embeddedJsonBlobs(html)) {
    const parsed = parseProfile(blob, publicId);
    // A blob that only knew the slug (the page's own breadcrumb) is not a profile read.
    if (parsed?.name || parsed?.urn || parsed?.headline) return parsed;
  }
  const head = html.slice(0, 400_000);
  const og = (prop: string): string | undefined => {
    const m = head.match(new RegExp(`<meta[^>]+property="og:${prop}"[^>]*content="([^"]*)"`, "i"));
    const v = m?.[1]?.trim();
    return v || undefined;
  };
  const title = og("title");
  // og:title is "Dana Okafor - VP Engineering - Acme | LinkedIn" on a profile page.
  const bits = (title ?? "").replace(/\s*\|\s*LinkedIn\s*$/i, "").split(/\s+[-–—]\s+/);
  const name = bits[0]?.trim() || undefined;
  const headline = bits.slice(1).join(" - ").trim() || undefined;
  const image = og("image");
  // A member id, not merely "something after the colon". The looser pattern matched an ESCAPED
  // occurrence nested inside the page's own JSON (`urn:li:fsd_profile:urn:li:fsd_profile:…`) and
  // captured the literal string "urn", which then became `urn:li:fsd_profile:urn` — a value that
  // parses, latches this rung, lands in the graph, and is handed to send_invite. Real ids are
  // base64url and start ACoAA; requiring that shape turns a plausible-looking forgery into a miss.
  const urnHit = head.match(/urn:li:fsd?_(?:profile|miniProfile):(ACoAA[A-Za-z0-9_-]{6,})/);
  // A urn with no name is an interstitial, not a profile — the flagship document always carries
  // og:title. Latching on it would retire the rung that actually works.
  if (!name) return null;
  const guessed = splitHeadline(headline);
  return defined({
    public_id: publicId,
    urn: urnHit ? `urn:li:fsd_profile:${urnHit[1]}` : undefined,
    name,
    headline,
    title: guessed.title,
    company: guessed.company,
    photo_url: image && image.startsWith("https://") ? image : undefined,
    profile_url: profileUrl(publicId),
  }) as LiProfile;
}

interface Candidate {
  name: ProfileStrategyName;
  /** False = do not spend a request on this one at all (no queryId, opt-in flag unset, retired). */
  enabled: () => boolean;
  why?: string;
  run: (session: LinkedInSession, ctx: VoyagerCtx, id: string, op: string) => Promise<VoyagerResponse>;
  parse: (r: VoyagerResponse, id: string) => LiProfile | null;
}

const CANDIDATES: Candidate[] = [
  {
    name: "dash-profiles",
    enabled: () => true,
    run: (s, ctx, id, op) => voyagerCall(dashProfileUrl(id), s, ctx, op),
    parse: (r, id) => parseProfile(r.json, id),
  },
  {
    name: "graphql-dash-profiles",
    enabled: () => !!(PROFILE_QID || harvestedQid),
    why: "no profile queryId is known — set MYCEL_LINKEDIN_QID_PROFILE or let the page candidate harvest one",
    run: (s, ctx, id, op) => voyagerCall(graphqlProfileUrl(id, (PROFILE_QID || harvestedQid) as string), s, ctx, op),
    parse: (r, id) => parseProfile(r.json, id),
  },
  {
    name: "profile-page",
    enabled: () => true,
    run: (s, ctx, id, op) => voyagerCall(profilePageUrl(id), s, ctx, op, { headers: profilePageHeaders() }),
    parse: (r, id) => {
      // Harvest a queryId on the way past, so the cheap GraphQL candidate becomes available for the
      // NEXT read even though we could never have invented its hash.
      if (!PROFILE_QID && !harvestedQid) harvestedQid = profileQueryIdFromHtml(r.text ?? "");
      return parseProfile(r.json, id) ?? parseProfilePage(r.text ?? "", id);
    },
  },
  {
    name: "legacy-profile-view",
    enabled: () => LEGACY_PROFILE_VIEW,
    why: "the legacy profileView endpoint answered 410 Gone on 2026-08-18; set MYCEL_LINKEDIN_LEGACY_PROFILEVIEW=1 to try it anyway",
    run: (s, ctx, id, op) => voyagerCall(`${VOYAGER}/identity/profiles/${encodeURIComponent(id)}/profileView`, s, ctx, op),
    parse: (r, id) => parseProfile(r.json, id),
  },
];

/** The order to try: whatever worked last, then everything not retired, in cheapest-first order. */
function ladder(): Candidate[] {
  const live = CANDIDATES.filter((c) => !retired.has(c.name));
  const first = live.filter((c) => c.name === latched);
  return [...first, ...live.filter((c) => c.name !== latched)];
}

/**
 * Read one profile, trying each candidate until one answers with a shape we can parse.
 *
 * The contract, stated precisely, because every branch here is a decision someone will want to
 * revisit:
 *   · a PARSED profile latches the candidate and returns. Subsequent reads go straight to it, so the
 *     ladder costs extra requests once per process, not once per prospect;
 *   · 404/403 is an ANSWER — "no such profile" / "not visible to this account" — and it is recorded
 *     as one. If every candidate says that, the answer is null and nothing is stopped. Private and
 *     out-of-network profiles are ordinary;
 *   · 410 retires that candidate for the process and clears the stop it stamped on the connection,
 *     but only while another candidate remains. A dead endpoint is a fact about the endpoint;
 *   · 429/5xx/timeouts are thrown immediately. They are about the ACCOUNT, and walking three more
 *     endpoints while LinkedIn is telling us to slow down is how the next incident starts;
 *   · a challenge, or the breaker refusing, is rethrown untouched — that is the account, not us;
 *   · and when everything is spent, `LinkedInProfileEndpointUnknownError` — permanent, named, and
 *     carrying the devtools capture that is the only thing that can actually fix it.
 */
export async function readProfile(
  session: LinkedInSession,
  ctx: VoyagerCtx,
  profileId: string,
  op = "profile",
  /** Probe exactly ONE candidate, ignoring the latch. Used by scripts/verify-profile.ts and tests —
   *  never by the product, which always wants the cheapest thing that works. */
  only?: ProfileStrategyName,
): Promise<ProfileRead> {
  const id = safeProfileId(profileId);
  if (!id) throw new Error(`"${profileId}" is not a LinkedIn public identifier`);

  const attempts: ProfileAttempt[] = [];
  let answeredNotFound = false;
  const order = only ? CANDIDATES.filter((c) => c.name === only) : ladder();
  /** Is there anything left AFTER this one? The only question the stop-clearing decision asks. */
  const remaining = (i: number) => order.slice(i + 1).some((c) => !retired.has(c.name) && c.enabled());

  for (let i = 0; i < order.length; i++) {
    const candidate = order[i];
    if (!candidate.enabled()) {
      attempts.push({ strategy: candidate.name, outcome: "skipped", note: candidate.why });
      continue;
    }
    let r: VoyagerResponse;
    try {
      r = await candidate.run(session, ctx, id, op);
    } catch (e) {
      if (e instanceof LinkedInGoneError) {
        retired.add(candidate.name);
        if (latched === candidate.name) latched = undefined;
        attempts.push({ strategy: candidate.name, status: e.status, outcome: "gone" });
        // Un-stamp the connection ONLY while there is still something to try. If this was the last
        // candidate the stop stands, and the ladder's own permanent failure replaces it below.
        if (remaining(i)) clearLinkedInStop(ctx.connectionId, ENDPOINT_GONE_CODE);
        continue;
      }
      // A challenge, the breaker, a timeout, a proxy failure: none of these are evidence about
      // which endpoint is right, and all of them mean stop asking.
      throw e;
    }

    if (r.status === 404 || r.status === 403) {
      answeredNotFound = true;
      attempts.push({ strategy: candidate.name, status: r.status, outcome: "not-found" });
      continue;
    }
    if (r.status === 429 || r.status >= 500) {
      attempts.push({ strategy: candidate.name, status: r.status, outcome: "error" });
      throw new Error(`voyager ${op} ${r.status}`);
    }
    if (r.status === 400 && candidate.name === "dash-profiles" && PROFILE_DECORATION && !profileDecorationRejected) {
      // A rotated decorationId 400s. That is a parameter WE chose, so it costs the parameter and one
      // retry — never the candidate, and never the read.
      profileDecorationRejected = true;
      attempts.push({ strategy: candidate.name, status: 400, outcome: "error", note: "decorationId rejected; retrying undecorated" });
      const bare = await candidate.run(session, ctx, id, op);
      const parsed = bare.ok ? candidate.parse(bare, id) : null;
      if (parsed) {
        latched = candidate.name;
        attempts.push({ strategy: candidate.name, status: bare.status, outcome: "parsed" });
        return { profile: parsed, via: candidate.name, attempts };
      }
      attempts.push({ strategy: candidate.name, status: bare.status, outcome: bare.ok ? "unrecognised-shape" : "error" });
      continue;
    }
    if (!r.ok) {
      attempts.push({ strategy: candidate.name, status: r.status, outcome: "error" });
      continue;
    }

    const parsed = candidate.parse(r, id);
    if (parsed) {
      latched = candidate.name;
      attempts.push({ strategy: candidate.name, status: r.status, outcome: "parsed" });
      return { profile: parsed, via: candidate.name, attempts };
    }
    // A 200 whose body we cannot read is the shape having moved. Retiring it for the process stops
    // us paying for the same unreadable body on every prospect for the rest of the day.
    retired.add(candidate.name);
    if (latched === candidate.name) latched = undefined;
    attempts.push({ strategy: candidate.name, status: r.status, outcome: "unrecognised-shape" });
  }

  // Every candidate that ran said "no such profile". That IS an answer, and a common one.
  if (answeredNotFound) return { profile: null, attempts };
  throw new LinkedInProfileEndpointUnknownError(
    attempts.map((a) => `${a.strategy}: ${a.outcome}${a.status ? ` (${a.status})` : ""}${a.note ? ` — ${a.note}` : ""}`),
    ctx.connectionId,
  );
}

/**
 * Fetch one profile. Returns null when LinkedIn has no such profile (or hides it from this account),
 * which is a normal answer and not an error — private and out-of-network profiles are common.
 */
export async function getProfile(
  session: LinkedInSession,
  ctx: VoyagerCtx,
  profileId: string,
  op = "profile",
): Promise<LiProfile | null> {
  return (await readProfile(session, ctx, profileId, op)).profile;
}

/** The outcome of a warm-up view. `seen` is a claim about LinkedIn's settings we cannot verify. */
export interface ViewResult {
  ok: boolean;
  profile: LiProfile | null;
  /** Which candidate answered — the page read is the one LinkedIn certainly records as a view. */
  via?: ProfileStrategyName;
  detail?: string;
}

/**
 * View a profile as a warm-up touch.
 *
 * Deliberately the same request as `getProfile`, under a different op label so the byte meter can
 * tell warm-up traffic apart from enrichment traffic. Whether the view is visible to the target
 * depends on the ACCOUNT's profile-viewing setting, which Voyager does not report on this response —
 * so nothing here claims it landed. It reports that the request succeeded, and capabilities.ts warns
 * about the rest.
 */
export async function viewProfile(
  session: LinkedInSession,
  ctx: VoyagerCtx,
  profileId: string,
): Promise<ViewResult> {
  const read = await readProfile(session, ctx, profileId, "view");
  if (!read.profile) return { ok: false, profile: null, detail: "that profile is not visible to this account" };
  return {
    ok: true,
    profile: read.profile,
    via: read.via,
    detail:
      "viewed — this only shows up in their notifications if the account's own profile-viewing " +
      "setting is public" +
      // Worth saying, because it changes what the touch was worth: the profile PAGE is the request a
      // browser makes, so it is the one LinkedIn certainly records. A JSON read may not register.
      (read.via && read.via !== "profile-page"
        ? ` (read via ${read.via} — LinkedIn records a view most reliably from the profile page itself)`
        : ""),
  };
}

/** Fetch one company by its LinkedIn slug. Null when there is no such page. */
export async function getCompany(
  session: LinkedInSession,
  ctx: VoyagerCtx,
  slug: string,
): Promise<LiCompany | null> {
  const universalName = safeCompanySlug(slug);
  if (!universalName) throw new Error(`"${slug}" is not a LinkedIn company slug`);
  // No decoration on this one: the undecorated company response is already small, and a decoration
  // id is a rotating string that can only make a working read fail.
  const params = new URLSearchParams({ q: "universalName", universalName });
  const r = await voyagerCall(`${VOYAGER}/organization/companies?${params}`, session, ctx, "company");
  if (r.status === 404 || r.status === 403) return null;
  if (!r.ok) throw new Error(`voyager company ${r.status}`);
  return parseCompany(r.json);
}

/** Test hook: forget that a profile decoration id was rejected (and everything else the ladder learned). */
export function _resetProfileDecoration(): void {
  _resetProfileStrategies();
}

// ═══ SKILLS, FOR THE ONE WARM TOUCH THAT COSTS NOTHING AND IS NOTICED ═══
//
// `endorseSkill` has existed and worked for weeks and has never run once, because it needs a skill
// URN and nothing in this system produced one. Read in one place, written in none — the third time
// that shape has shown up (see `latest_post_url`).
//
// This is the cheap half of the fix: pull whatever skills are ALREADY in a profile payload we are
// already fetching, rather than adding a call. If LinkedIn's profile response carries them, the
// endorsement costs zero extra requests against an account we are trying not to spend. If it does
// not, this returns nothing and the caller says so out loud instead of skipping in silence.

export interface LiSkill {
  /** `urn:li:fsd_skill:…` — the only thing the endorse endpoint accepts. */
  urn: string;
  /** What it is called, so we can decide whether it is their craft or their Excel proficiency. */
  name: string;
}

/**
 * Every skill URN anywhere in a profile payload, paired with the nearest name.
 *
 * Deliberately shape-agnostic. LinkedIn moves this between `included[]`, `elements[]` and nested
 * `*.skills` across responses, and a parser that knows only today's shape is a parser that silently
 * returns nothing after the next release — which is indistinguishable from a person with no skills.
 * So: walk the whole tree, take anything that looks like a skill node.
 */
export function parseSkills(payload: unknown): LiSkill[] {
  const out = new Map<string, string>();
  const seen = new Set<unknown>();

  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const v of node) walk(v);
      return;
    }
    const o = node as Record<string, unknown>;
    // A skill node is one that carries a skill urn and a human-readable name near it.
    for (const key of ["entityUrn", "skillUrn", "urn", "*skill"]) {
      const urn = asSkillUrnLike(o[key]);
      if (!urn) continue;
      const name = firstString(o.name, o.skillName, o.title, (o.localizedName as unknown));
      if (name) out.set(urn, name);
    }
    for (const v of Object.values(o)) walk(v);
  };

  walk(payload);
  return [...out].map(([urn, name]) => ({ urn, name }));
}

const asSkillUrnLike = (v: unknown): string | undefined => {
  const s = typeof v === "string" ? v.trim() : "";
  return /^urn:li:(fsd_skill|fs_skill|skill):[A-Za-z0-9_:()%-]+$/.test(s) ? s : undefined;
};

function firstString(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
    // LinkedIn's localised strings: { text: "…" } or { localized: { en_US: "…" } }
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (typeof o.text === "string" && o.text.trim()) return o.text.trim();
      const loc = o.localized as Record<string, unknown> | undefined;
      const hit = loc && Object.values(loc).find((x) => typeof x === "string" && x.trim());
      if (typeof hit === "string") return hit.trim();
    }
  }
  return undefined;
}
