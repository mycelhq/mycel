// One profile, and one company, in detail.
//
// ── ENDPOINT CONFIDENCE ──────────────────────────────────────────────────────────────────────────
//   · `GET /voyager/api/identity/profiles/{publicId}/profileView` — CONFIDENT. The longest-lived
//     profile endpoint on Voyager, needs no rotating decoration or query id, and returns the whole
//     profile in one document (`profile`, `positionView`, `skillView`, …).
//   · `GET /voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity={publicId}` — INFERRED
//     on the decoration id, confident on the mechanism. It is the newer shape and it is what the web
//     app uses now, but a decoration id rotates. Tried FIRST only when one is configured, exactly
//     like the messaging decoration in voyager.ts, and never allowed to be the reason a read fails.
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
  textOf,
  urnId,
  type LiCompany,
  type LiPerson,
} from "./people";
import { VOYAGER, voyagerCall, type LinkedInSession, type VoyagerCtx } from "./voyager";

/** A profile, in more detail than a search card carries. */
export interface LiProfile extends LiPerson {
  summary?: string;
  industry?: string;
  /** The employer's LinkedIn slug, when the current position named one — the key for `get_company`. */
  company_slug?: string;
  /** Best-effort: the employer's urn, for callers that want to follow the edge. */
  company_urn?: string;
}

/** Optional named response shape for the dash profile read. Rotates; empty disables the dash path. */
const PROFILE_DECORATION = process.env.MYCEL_LINKEDIN_PROFILE_DECORATION ?? "";

// ── pure parsers ─────────────────────────────────────────────────────────────────────────────────

/**
 * The current position, out of a `positionView`.
 *
 * "Current" is the one with no end date. Falling back to the first element is right rather than lazy:
 * LinkedIn returns positions newest-first, so element zero is the current role in every payload where
 * the date is simply missing — which is common, because people do not fill it in.
 */
export function currentPosition(payload: unknown): Record<string, any> | undefined {
  const d = asRecord(payload);
  const elements: any[] =
    asRecord(d.positionView).elements ?? asRecord(d.positionGroupView).elements ?? d.positions?.elements ?? [];
  if (!Array.isArray(elements) || !elements.length) return undefined;
  const open = elements.map(asRecord).find((p) => !asRecord(p.timePeriod).endDate && !p.endDate);
  return open ?? asRecord(elements[0]);
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

/**
 * A profileView payload → a profile. Pure and total.
 *
 * Reads both the legacy shape (`profile.firstName`, `positionView`) and the dash shape (`elements[0]`
 * with attributed strings), because which one an account is served is LinkedIn's decision, not ours —
 * the same reason `inboundMessages` in voyager.ts reads two shapes.
 */
export function parseProfile(payload: unknown): LiProfile | null {
  const root = asRecord(payload);
  // dash serves the profile as `elements[0]`; legacy nests it under `profile`.
  const p = asRecord(root.profile ?? (Array.isArray(root.elements) ? root.elements[0] : undefined) ?? root);
  const public_id =
    (typeof p.publicIdentifier === "string" ? p.publicIdentifier : undefined) ??
    (typeof asRecord(p.miniProfile).publicIdentifier === "string" ? asRecord(p.miniProfile).publicIdentifier : undefined);
  const name = [textOf(p.firstName), textOf(p.lastName)].filter(Boolean).join(" ");
  // No public identifier and no name means this is not a profile document — say so rather than
  // returning a hollow object the caller will happily write to the graph.
  if (!public_id && !name) return null;

  const pos = currentPosition(root);
  const company = asRecord(pos?.company);
  const urnRaw = p.entityUrn ?? asRecord(p.miniProfile).entityUrn ?? p.objectUrn;
  const id = urnId(urnRaw);

  return defined({
    public_id,
    urn: id ? `urn:li:fsd_profile:${id}` : undefined,
    name: name || undefined,
    headline: textOf(p.headline) ?? textOf(asRecord(p.miniProfile).occupation),
    title: pos ? textOf(pos.title) : undefined,
    company: pos ? textOf(pos.companyName) ?? textOf(company.name) : undefined,
    company_domain: registrableDomain(company.companyPageUrl ?? company.website ?? pos?.companyWebsite),
    company_slug: companySlugFrom(pos),
    company_urn: typeof pos?.companyUrn === "string" ? pos.companyUrn : undefined,
    photo_url: pictureFrom(p) ?? pictureFrom(asRecord(p.miniProfile)),
    location: textOf(p.geoLocationName) ?? textOf(p.locationName) ?? textOf(p.location),
    industry: textOf(p.industryName) ?? textOf(p.industry),
    summary: textOf(p.summary),
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

/** Set once when the configured decoration is rejected, so a rotated id costs one 400 in total. */
let profileDecorationRejected = false;

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
  const id = safeProfileId(profileId);
  if (!id) throw new Error(`"${profileId}" is not a LinkedIn public identifier`);

  if (PROFILE_DECORATION && !profileDecorationRejected) {
    const params = new URLSearchParams({
      q: "memberIdentity",
      memberIdentity: id,
      decorationId: PROFILE_DECORATION,
    });
    const r = await voyagerCall(`${VOYAGER}/identity/dash/profiles?${params}`, session, ctx, op);
    if (r.ok) {
      const parsed = parseProfile(r.json);
      if (parsed) return parsed;
    } else if (r.status === 400 || r.status === 404) {
      profileDecorationRejected = true;
    }
  }

  const r = await voyagerCall(
    `${VOYAGER}/identity/profiles/${encodeURIComponent(id)}/profileView`,
    session,
    ctx,
    op,
  );
  // 404 is "no such profile", 403 is "not visible to you". Both are answers, not failures.
  if (r.status === 404 || r.status === 403) return null;
  if (!r.ok) throw new Error(`voyager profile ${r.status}`);
  return parseProfile(r.json);
}

/** The outcome of a warm-up view. `seen` is a claim about LinkedIn's settings we cannot verify. */
export interface ViewResult {
  ok: boolean;
  profile: LiProfile | null;
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
  const profile = await getProfile(session, ctx, profileId, "view");
  if (!profile) return { ok: false, profile: null, detail: "that profile is not visible to this account" };
  return {
    ok: true,
    profile,
    detail:
      "viewed — this only shows up in their notifications if the account's own profile-viewing " +
      "setting is public",
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

/** Test hook: forget that a profile decoration id was rejected. */
export function _resetProfileDecoration(): void {
  profileDecorationRejected = false;
}
