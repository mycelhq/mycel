// The shapes a person and a company take once they are out of Voyager, and the pure extractors that
// get them there.
//
// WHY THIS FILE IS SEPARATE FROM THE CALLS
// Everything here is a pure function of a JSON blob. That is the only part of the LinkedIn surface
// that can be tested without a session, and it is also the part that BREAKS — endpoints are stable
// for years, response shapes drift with every web deploy. So the split is deliberate: a thin fetch
// that we cannot verify from here, and a parser that we can, exhaustively, against fixtures.
//
// THE FAIL-SOFT RULE, STATED ONCE
// Every extractor below returns `undefined` rather than throwing. A LinkedIn deploy that renames
// `miniProfile` to something else must produce a person record with a name and no headline — an
// incomplete row the founder can still act on — and never an exception that kills a sequencer tick
// and parks twenty-five cases with "sequencer error: cannot read property of undefined".
//
// THE FIELD LIST IS NOT ARBITRARY. It is exactly what `cloud/lib/gtm.ts` `readPerson`/`readCompany`
// copy out on the way to the DOM. Anything else we could scrape would be written to a column no
// screen reads, which is storage of a stranger's personal data for no purpose.

/** A person, as the CRM's `readPerson` wants them. Every field optional: see the fail-soft rule. */
export interface LiPerson {
  /** LinkedIn public identifier ("islam-hachimi"). THE natural key for the `people` collection. */
  public_id?: string;
  /** urn:li:fsd_profile:… — what the invitation endpoints address. Not a display field. */
  urn?: string;
  name?: string;
  /** The line under the name. Usually richer than title+company and the better personalisation hook. */
  headline?: string;
  title?: string;
  company?: string;
  /** Registrable domain of the current employer, when the payload carried one. Links person→company. */
  company_domain?: string;
  photo_url?: string;
  location?: string;
  profile_url?: string;
}

/** A company page, as `readCompany` wants it. */
export interface LiCompany {
  /** The slug in /company/<x>/ — LinkedIn's own key, kept for re-fetching. */
  universal_name?: string;
  /** Registrable domain. THE natural key for the `companies` collection. */
  domain?: string;
  name?: string;
  website?: string;
  industry?: string;
  headcount?: number;
  logo_url?: string;
  description?: string;
  urn?: string;
}

// ── primitives ───────────────────────────────────────────────────────────────────────────────────

export const asRecord = (v: unknown): Record<string, any> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : {};

/**
 * A string, if there is one in there.
 *
 * Voyager serves the same logical field three ways depending on the endpoint's age: a bare string, an
 * attributed `{ text }`, and a `{ text: { text } }` double wrap in the newer dash shapes. Reading
 * only one of them is how a parser silently returns empty names for half the fleet.
 */
export function textOf(v: unknown): string | undefined {
  if (typeof v === "string") return v.trim() || undefined;
  const r = asRecord(v);
  if (typeof r.text === "string") return r.text.trim() || undefined;
  if (r.text) return textOf(r.text);
  return undefined;
}

export function numOf(v: unknown): number | undefined {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

/** urn:li:fsd_profile:ACoAAB… → ACoAAB…. Also the identity function for a bare id. */
export function urnId(urn: unknown): string | undefined {
  const s = typeof urn === "string" ? urn : undefined;
  if (!s) return undefined;
  return s.includes(":") ? s.split(":").pop() || undefined : s;
}

/**
 * Rebuild a photo URL from LinkedIn's VectorImage.
 *
 * LinkedIn does not serve an image URL. It serves `{ rootUrl, artifacts: [{ width,
 * fileIdentifyingUrlPathSegment }] }` and expects the client to concatenate — which is why naive
 * scrapers show broken avatars. The largest artifact is picked because these render as 96-200px
 * faces in the CRM and the small artifact is 100px, which is visibly soft on a retina screen.
 *
 * Only https survives. These strings are third-party input on their way to an `img src`.
 */
export function vectorImageUrl(v: unknown): string | undefined {
  const img = asRecord(asRecord(v).com_linkedin_common_VectorImage ?? v);
  const root = typeof img.rootUrl === "string" ? img.rootUrl : undefined;
  const artifacts = Array.isArray(img.artifacts) ? img.artifacts : [];
  if (!root || !artifacts.length) return undefined;
  const best = artifacts
    .map((a: unknown) => asRecord(a))
    .filter((a) => typeof a.fileIdentifyingUrlPathSegment === "string")
    .sort((a, b) => (numOf(b.width) ?? 0) - (numOf(a.width) ?? 0))[0];
  if (!best) return undefined;
  const url = `${root}${best.fileIdentifyingUrlPathSegment}`;
  return url.startsWith("https://") ? url : undefined;
}

/** Any of the several places a profile picture hides, tried in order of how current the shape is. */
export function pictureFrom(node: Record<string, any>): string | undefined {
  return (
    vectorImageUrl(node.profilePicture?.displayImageReference?.vectorImage) ??
    vectorImageUrl(node.profilePicture?.displayImage?.["com.linkedin.common.VectorImage"]) ??
    vectorImageUrl(node.picture) ??
    vectorImageUrl(node.logo?.vectorImage) ??
    vectorImageUrl(node.logoResolutionResult?.vectorImage) ??
    vectorImageUrl(node.image?.attributes?.[0]?.detailData?.vectorImage) ??
    undefined
  );
}

/**
 * The registrable domain of a URL or bare hostname — the natural key for a company.
 *
 * A natural key has to be stable across the ways the same company arrives: `https://Acme.com/about`,
 * `www.acme.com`, `acme.com`. All three must key one row or re-running enrichment creates three
 * companies and the CRM shows a prospect list with the same employer listed three times.
 *
 * NOT a public-suffix implementation, deliberately — that needs a list that goes stale. It lowercases,
 * drops the scheme, the `www.`, the port, the path and any trailing dot, and stops. `acme.co.uk`
 * therefore stays `acme.co.uk`, which is the right answer; the case this cannot do is recognising
 * that `acme.co.uk` and `acme.com` are one company, and neither can a suffix list.
 */
export function registrableDomain(input: unknown): string | undefined {
  const raw = typeof input === "string" ? input.trim() : "";
  if (!raw) return undefined;
  let host = raw;
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) host = new URL(raw).hostname;
    else host = new URL(`https://${raw}`).hostname;
  } catch {
    return undefined;
  }
  host = host.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  // A domain needs a dot and a plausible TLD. "localhost" and "n/a" are not companies.
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return undefined;
  if (!/\.[a-z]{2,}$/.test(host)) return undefined;
  return host;
}

/** The canonical public profile URL, from a public identifier. */
export function profileUrl(publicId?: string): string | undefined {
  return publicId ? `https://www.linkedin.com/in/${encodeURIComponent(publicId)}` : undefined;
}

/**
 * Split a headline into a title and a company, when it is written the way most people write it.
 *
 * "VP Engineering at Acme" is the overwhelmingly common form and the title is the field the CRM
 * filters on. Used ONLY as a fallback: a structured `title`/`companyName` in the payload always wins,
 * because this is a guess and a guess that overwrote a fact would be a bug that reads as data quality.
 * Returns nothing for a headline with no separator rather than inventing a split.
 */
export function splitHeadline(headline?: string): { title?: string; company?: string } {
  if (!headline) return {};
  const m = headline.match(/^(.{2,80}?)\s+(?:at|@|chez|bei|en)\s+(.{2,80})$/i);
  if (!m) return {};
  return { title: m[1].trim(), company: m[2].trim().replace(/\s*[|·-].*$/, "").trim() || undefined };
}

/** Drop keys whose value is undefined, so a JSONB merge never overwrites a known field with null. */
export function defined<T extends Record<string, unknown>>(o: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== "") out[k] = v;
  return out as Partial<T>;
}
