// Web-based prospect discovery — finding buyers WITHOUT LinkedIn's metered people-search quota.
//
// ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────────────────────────
// `linkedin/search.ts` is the one discovery surface LinkedIn METERS: a free account gets ~two
// people-searches per IP before every further one 302s with the keywords stripped (verified live
// 2026-08-14, see search.ts's header). That monthly Commercial Search Limit is a hard ceiling on
// the whole GTM loop when LinkedIn is the primary way we find people.
//
// FullEnrich already lives in this codebase as the paid EMAIL waterfall (`gtm/enrich.ts`). Its v2
// API also exposes `POST /people/search` — a filtered people database that returns, per person, the
// LinkedIn URL and id, name, headline, current employment (title + company + domain) and location.
// That is exactly the shape `findProspects` needs to seed the graph, and it does not touch the
// LinkedIn session at all. So when FullEnrich is configured we discover through it and leave
// LinkedIn for ACT-only work (connect / message / endorse); when it is not, the caller falls back
// to the metered Voyager search unchanged.
//
// ── FIELD NAMES, FROM THE DOCS NOT INFERRED ──────────────────────────────────────────────────────
// Confirmed against https://docs.fullenrich.com/api/v2/people/search/post :
//   · request filters (AND across fields, OR within a field): `current_position_titles`,
//     `current_company_names`, `current_company_domains`, `person_locations`, `person_skills`, …;
//     pagination `offset` (max 10,000) / `limit` (max 100) OR cursor `search_after` (unlimited).
//   · response: `{ metadata: { total, credits, offset, search_after }, people: [ person ] }` where a
//     person is `{ id, full_name, headline, description, location:{country,city,region},
//     social_profiles:{professional_network:{id,url,handle}}, employment:{ current:{ title,
//     company:{ name, domain, … } } } }`. The person row is the SAME shape `parseRichProfile`
//     (enrich.ts) already reads off an enrich result, so the mapping reuses it verbatim.
//
// ── COST, THE SAME MECHANISM ENRICH USES ─────────────────────────────────────────────────────────
// FullEnrich bills ~0.25 credit per person returned and reports `metadata.credits`. `cost_usd` is
// recorded ONLY when `FULLENRICH_USD_PER_CREDIT` is set — never written as 0 for an unpriced plan,
// exactly as enrich.ts argues.
//
// NEVER THROWS. Money-adjacent I/O: every failure returns `{ ok:false, code }` so the caller can
// fall back, and logs the status + body the way the litellm fix pattern does.
import { FULLENRICH_KEY_ENV, FULLENRICH_RATE_ENV, fullEnrichConfigured, parseRichProfile } from "./enrich";
import type { FoundPerson } from "./prospects";

/** Read at call time, like enrich.ts, so a process does not need re-importing to be reconfigured. */
const base = () => process.env.FULLENRICH_BASE_URL ?? "https://app.fullenrich.com/api/v2";

/** Default people per call; hard cap is FullEnrich's per-page max. A SPEND ceiling, not a perf one. */
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/** ~0.25 credit per person when the vendor does not report `metadata.credits`. From the docs. */
const CREDITS_PER_PERSON = 0.25;

export interface WebDiscoverInput {
  query?: string;
  title?: string;
  company?: string;
  location?: string;
  limit?: number;
  /** Offset-based paging (FullEnrich `offset`, max 10,000). Mirrors the Voyager `start`. */
  start?: number;
  /** Cursor paging (FullEnrich `search_after`) — unlimited depth, preferred when present. */
  cursor?: string;
}

export interface WebDiscoverResult {
  ok: boolean;
  people: FoundPerson[];
  /** A named, actionable condition — `fullenrich_not_configured` above all, so the caller falls back. */
  code?: string;
  /** Only present when `FULLENRICH_USD_PER_CREDIT` is configured. Never 0 for an unpriced plan. */
  cost_usd?: number;
  /** Feed back as `cursor` for the next page. Absent means FullEnrich had no more. */
  next_cursor?: string;
}

/** Dollars per credit, or undefined when the founder has not told us. Never guessed — matches enrich. */
function usdPerCredit(): number | undefined {
  const raw = Number(process.env[FULLENRICH_RATE_ENV]);
  return Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

function clampLimit(n?: number): number {
  if (!n || !Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(n)));
}

/**
 * The loose `{query,title,company,location}` a founder types → FullEnrich filters.
 *
 * `title` and a free-text `query` both land in `current_position_titles` (one field, OR within it)
 * rather than query going into `person_skills` — a skill is ANDed against every other field, so
 * "fractional CFO" as a skill would demand a prospect who both holds the title AND lists it as a
 * skill, quietly emptying the result. A title phrase is the honest reading of what was typed.
 */
export function buildFilters(input: WebDiscoverInput): Record<string, unknown> {
  // Each filter field is `apiv2.StringFilters` — an ARRAY of `{ value }` objects, NOT a string
  // array. Confirmed live 2026-08-15: a bare `["Founder"]` 400s with "cannot unmarshal string into
  // ... StringFilter"; `[{ value: "Founder" }]` returns people. OR within the array, AND across
  // fields.
  const sf = (values: string[]) => values.map((value) => ({ value }));
  const titles = [input.title, input.query].map((s) => s?.trim()).filter((s): s is string => !!s);
  const filters: Record<string, unknown> = {};
  if (titles.length) filters.current_position_titles = sf([...new Set(titles)]);
  if (input.company?.trim()) filters.current_company_names = sf([input.company.trim()]);
  if (input.location?.trim()) filters.person_locations = sf([input.location.trim()]);
  return filters;
}

/** The `/in/<slug>` handle out of a LinkedIn URL, when there is one — the graph's natural person key. */
function slugFromUrl(url?: string): string | undefined {
  if (typeof url !== "string") return undefined;
  const m = url.match(/\/in\/([^/?#]+)/i);
  return m?.[1] ? decodeURIComponent(m[1]) : undefined;
}

/** A stable, deterministic id for a person FullEnrich returned without a LinkedIn handle or id. */
function stableHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return `fe-${(h >>> 0).toString(36)}`;
}

/**
 * One FullEnrich person → `FoundPerson`.
 *
 * `profile_id` is the public identifier LinkedIn ACT capabilities address a person by: the
 * professional-network `handle`, else the `/in/<slug>` from the URL, else the numeric LinkedIn id,
 * else a stable hash of the URL/name so an un-LinkedIn'd row is still keyable rather than dropped.
 * The rich-profile fields reuse `parseRichProfile`, which reads this exact person shape.
 */
export function mapPerson(raw: unknown): FoundPerson | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  const social = (r.social_profiles as Record<string, unknown> | undefined)?.professional_network as
    | Record<string, unknown>
    | undefined;
  const rich = parseRichProfile(r);
  const linkedin_url = rich.linkedin_url ?? (typeof social?.url === "string" ? social.url : undefined);

  const handle = typeof social?.handle === "string" && social.handle.trim() ? social.handle.trim() : undefined;
  const linkedinId =
    social?.id !== undefined && social?.id !== null && String(social.id).trim() ? String(social.id).trim() : undefined;
  const anchor = linkedin_url ?? (typeof r.id === "string" ? r.id : undefined) ?? (typeof r.full_name === "string" ? r.full_name : undefined);
  const profile_id = handle ?? slugFromUrl(linkedin_url) ?? linkedinId ?? (anchor ? stableHash(anchor) : undefined);
  if (!profile_id) return null; // nothing to key on — unkeyable rows corrupt the collection

  const name = typeof r.full_name === "string" ? r.full_name.trim() || undefined : undefined;
  const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  return {
    profile_id,
    name,
    headline: rich.headline,
    title: rich.title,
    company: rich.company_name,
    company_domain: rich.company_domain,
    location: rich.location,
    linkedin_url,
    // FullEnrich people-search does not return a portrait; only the company logo. So no photo.
    photo_url: s((r as { photo_url?: unknown }).photo_url),
  };
}

async function call(body: unknown): Promise<{ ok: boolean; status: number; json?: unknown; text: string }> {
  const key = (process.env[FULLENRICH_KEY_ENV] ?? "").trim();
  const res = await fetch(`${base()}/people/search`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    /* a non-JSON body is a gateway page, not a result */
  }
  return { ok: res.ok, status: res.status, json, text };
}

/**
 * Discover people through FullEnrich's people database. Un-metered by LinkedIn; costs credits.
 *
 * Returns `{ ok:false, code:"fullenrich_not_configured" }` when the key is unset so the caller can
 * fall back to the metered Voyager search. Any non-2xx or parse error is fail-soft: `ok:false` with
 * a code, logged, never thrown.
 */
export async function webDiscoverPeople(input: WebDiscoverInput): Promise<WebDiscoverResult> {
  if (!fullEnrichConfigured()) return { ok: false, people: [], code: "fullenrich_not_configured" };

  const limit = clampLimit(input.limit);
  const filters = buildFilters(input);
  const body: Record<string, unknown> = {
    ...filters,
    limit,
    // Cursor wins when present (unlimited depth); otherwise offset, capped by the vendor at 10,000.
    ...(input.cursor ? { search_after: input.cursor } : input.start ? { offset: Math.max(0, Math.floor(input.start)) } : {}),
  };

  let r: Awaited<ReturnType<typeof call>>;
  try {
    r = await call(body);
  } catch (e) {
    console.error("[mycel] fullenrich people-search unreachable:", (e as Error)?.message ?? e);
    return { ok: false, people: [], code: "fullenrich_unreachable" };
  }
  if (!r.ok) {
    console.error(`[mycel] fullenrich people-search ${r.status}:`, r.text.slice(0, 500));
    return { ok: false, people: [], code: `fullenrich_${r.status}` };
  }

  const payload = (r.json ?? {}) as Record<string, unknown>;
  const rows = Array.isArray(payload.people)
    ? (payload.people as unknown[])
    : Array.isArray(payload.data)
      ? (payload.data as unknown[])
      : [];
  const people = rows.map(mapPerson).filter((p): p is FoundPerson => p !== null);

  const meta = (payload.metadata ?? {}) as Record<string, unknown>;
  const credits = typeof meta.credits === "number" ? meta.credits : people.length * CREDITS_PER_PERSON;
  const rate = usdPerCredit();
  const next = typeof meta.search_after === "string" && meta.search_after.trim() ? meta.search_after : undefined;

  return {
    ok: true,
    people,
    ...(rate !== undefined ? { cost_usd: Number((credits * rate).toFixed(4)) } : {}),
    ...(next ? { next_cursor: next } : {}),
  };
}
