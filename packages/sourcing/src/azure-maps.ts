// Azure Maps as the bulk lead source — the Places substitute, paid for with credits we already have.
//
// ── WHY THIS PROVIDER ─────────────────────────────────────────────────────────────────────────
//
// Google Places is the obvious choice and there are no Google credits on this account, while Azure
// and AWS both have them. AWS Location Service is built for geocoding and routing and its business
// POI data is thin, so Azure Maps is the one that can actually stand in: its POI records carry
// `poi.phone` and `poi.url`, which is the whole reason this step exists. THE PHONE NUMBER IS FREE.
// Measured on real Austin data: 57% of results carry a phone. A phone-enrichment vendor would
// charge per lead for exactly that field.
//
// ── THE FINDING THAT MAKES THIS USABLE, WHICH COST AN HOUR TO ESTABLISH ───────────────────────
//
// Free-text search is nearly useless for this ICP and it fails QUIETLY — it returns a plausible
// handful rather than an error. Measured in Austin inside a 30km radius:
//
//     query="plumber"             → 100   (capped)
//     query="dentist"             → 100   (capped)
//     query="advertising agency"  → 100   (capped)
//     query="marketing agency"    →  11
//     query="web design"          →  14
//     query="seo agency"          →   6
//
// Eleven marketing agencies in Austin is obviously wrong, and nothing in the response says so. The
// difference is that "advertising agency" happens to collide with a real TomTom CATEGORY and the
// others are treated as free text. So volume for agency wedges comes from browsing by category id,
// never from typing what we mean — `searchNearby`.
//
// Product GTM audiences are the other way around: a founder names a trade ("bakery") and a place
// ("Bristol"). There is no TomTom id for that. `geocodeAddress` + `searchPoi` is the hop that
// works for arbitrary trades. Empty `query` on `/search/poi` still returns zero.
//
// The second half of the finding is which endpoint takes a category. `/search/poi` accepts
// `categorySet` and returns ZERO when `query` is empty — it wants text and filters by category.
// `/search/nearby` is the one that browses a category with no query at all, and it is what the
// harvest calls. Same key, same radius, 100 results instead of 0.
//
// ── PAGING DOES NOT EXIST HERE ────────────────────────────────────────────────────────────────
//
// `ofs=100` returns an empty page with `totalResults: 0`. There is no second page: 100 is a hard
// ceiling per query, not a page size. That is why `harvest.ts` subdivides — a tile at the ceiling
// has NOT been enumerated, and the only way to see the rest is to ask about smaller ground.
// Google's ceiling is 60 and Azure's is 100, so the constant belongs to the provider rather than to
// the ledger.

/** Azure's hard per-query result cap. Not a page size — there is no second page. */
export const AZURE_RESULT_CEILING = 100;

/**
 * TomTom POI categories worth sweeping, by wedge.
 *
 * Found via the category tree API rather than guessed. `9352003` carries the synonyms "Marketing
 * Company / Ad Agency / Marketing / Advert Agency / Advertising Agency", which is why it is the
 * right id for a wedge aimed at digital marketing agencies even though its display name is
 * "Advertising Company".
 *
 * SEO and GEO agencies have NO category of their own — TomTom does not model them, and `seo agency`
 * as free text returned six results for a metro of two million. They are reached by sweeping
 * `advertising` and filtering on the website, not by a category query. That is a real limitation of
 * this source and the reason the footer-credit crawl exists alongside it.
 */
export const WEDGE_CATEGORIES: Record<string, { id: number; label: string }[]> = {
  "digital-marketing": [{ id: 9352003, label: "Advertising Company" }],
  "web-development": [
    { id: 9352005, label: "Software Company" },
    { id: 9352003, label: "Advertising Company" },
  ],
  "seo-geo": [{ id: 9352003, label: "Advertising Company" }],
};

/** Which Maps wedges a pass walks. Default is all three — a single SOURCING_WEDGE is the override. */
export function wedgesForPass(opts: { wedge?: string; env?: NodeJS.ProcessEnv } = {}): string[] {
  const env = opts.env ?? process.env;
  const one = opts.wedge ?? env.SOURCING_WEDGE?.trim();
  if (one) return [one];
  return Object.keys(WEDGE_CATEGORIES);
}

export interface AzurePoi {
  name: string;
  phone?: string;
  website?: string;
  address?: string;
  lat?: number;
  lon?: number;
  /** Azure's own id. NOT stable across data refreshes, so it is not an identity key. */
  providerId?: string;
}

export interface NearbyResult {
  results: AzurePoi[];
  /** True at the ceiling: the tile was not enumerated and must be subdivided. */
  saturated: boolean;
}

export interface NearbyQuery {
  lat: number;
  lon: number;
  /** Metres. Azure caps this at 50000. */
  radiusM: number;
  categoryId: number;
  limit?: number;
}

export interface PoiQuery {
  query: string;
  lat: number;
  lon: number;
  /** Metres. Azure caps this at 50000. Default 30km — a city, not a country. */
  radiusM?: number;
  limit?: number;
}

export interface GeocodeResult {
  lat: number;
  lon: number;
  label?: string;
}

function parsePoi(r: unknown): AzurePoi | null {
  const x = r as {
    poi?: Record<string, unknown>;
    address?: Record<string, unknown>;
    position?: Record<string, unknown>;
    id?: string;
  };
  const poi = x.poi ?? {};
  const name = String(poi.name ?? "");
  if (!name) return null;
  return {
    name,
    phone: typeof poi.phone === "string" ? poi.phone : undefined,
    website: typeof poi.url === "string" ? poi.url : undefined,
    address: typeof x.address?.freeformAddress === "string" ? x.address.freeformAddress : undefined,
    lat: typeof x.position?.lat === "number" ? x.position.lat : undefined,
    lon: typeof x.position?.lon === "number" ? x.position.lon : undefined,
    providerId: x.id,
  };
}

async function azureJson(
  url: URL,
  fetchImpl: typeof fetch,
): Promise<unknown[]> {
  const res = await fetchImpl(url.toString());
  if (!res.ok) throw new Error(`azure maps ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { results?: unknown[] };
  return Array.isArray(body.results) ? body.results : [];
}

function atlasUrl(path: string, key: string): URL {
  const url = new URL(`https://atlas.microsoft.com${path}`);
  url.searchParams.set("api-version", "1.0");
  url.searchParams.set("subscription-key", key);
  return url;
}

/**
 * One category sweep of one point.
 *
 * `fetchImpl` is injectable so the harvest loop can be tested without network and without a key —
 * the same reason `identity.ts` and `harvest.ts` are pure. Everything above this line is a decision;
 * this function is only transport.
 */
export async function searchNearby(
  q: NearbyQuery,
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<NearbyResult> {
  const url = atlasUrl("/search/nearby/json", key);
  url.searchParams.set("lat", String(q.lat));
  url.searchParams.set("lon", String(q.lon));
  // Azure rejects a radius over 50km outright rather than clamping, and a rejected sweep looks
  // identical to an empty one in the ledger — it would mark the ground swept having seen nothing.
  url.searchParams.set("radius", String(Math.min(q.radiusM, 50_000)));
  url.searchParams.set("categorySet", String(q.categoryId));
  url.searchParams.set("limit", String(q.limit ?? AZURE_RESULT_CEILING));

  const rows = await azureJson(url, fetchImpl);
  const results = rows.map(parsePoi).filter((p): p is AzurePoi => p !== null);
  return { results, saturated: rows.length >= AZURE_RESULT_CEILING };
}

/**
 * Free-text POI around a point. The hop GTM find uses for an arbitrary trade.
 *
 * `/search/poi` with an empty query returns zero — that is a documented Azure behaviour, not a
 * miss. Callers that have a category id should use `searchNearby` instead.
 */
export async function searchPoi(
  q: PoiQuery,
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<NearbyResult> {
  const query = q.query.trim();
  if (!query) return { results: [], saturated: false };

  const url = atlasUrl("/search/poi/json", key);
  url.searchParams.set("query", query);
  url.searchParams.set("lat", String(q.lat));
  url.searchParams.set("lon", String(q.lon));
  url.searchParams.set("radius", String(Math.min(q.radiusM ?? 30_000, 50_000)));
  url.searchParams.set("limit", String(q.limit ?? AZURE_RESULT_CEILING));

  const rows = await azureJson(url, fetchImpl);
  const results = rows.map(parsePoi).filter((p): p is AzurePoi => p !== null);
  return { results, saturated: rows.length >= AZURE_RESULT_CEILING };
}

/**
 * A place string → a point. One result. Null when Azure has no match, never a guessed coordinate.
 */
export async function geocodeAddress(
  query: string,
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GeocodeResult | null> {
  const q = query.trim();
  if (!q) return null;

  const url = atlasUrl("/search/address/json", key);
  url.searchParams.set("query", q);
  url.searchParams.set("limit", "1");

  const rows = await azureJson(url, fetchImpl);
  const first = rows[0] as { position?: { lat?: unknown; lon?: unknown }; address?: { freeformAddress?: unknown } } | undefined;
  const lat = first?.position?.lat;
  const lon = first?.position?.lon;
  if (typeof lat !== "number" || typeof lon !== "number") return null;
  return {
    lat,
    lon,
    label: typeof first?.address?.freeformAddress === "string" ? first.address.freeformAddress : undefined,
  };
}

/**
 * Metres for a tile at this depth, for handing `harvest.ts` tiles to a radius-based API.
 *
 * A radius over a square corner-to-corner is an OVER-cover, deliberately: gaps between tiles would
 * leave businesses permanently unreachable, whereas overlap only produces duplicates — and
 * duplicates are exactly what `identity.ts` is for. Given the choice, over-cover.
 */
export function radiusForTile(degrees: number): number {
  const metresPerDegree = 111_000;
  return Math.min(50_000, Math.ceil((degrees * metresPerDegree * Math.SQRT2) / 2));
}
