// Azure Maps on GTM find — the hop that carries a free phone.
//
// Transport and identity live in `@mycel/sourcing`. This file is the join onto the people graph:
// stamp a phone on a named person at the same domain, and file the shop itself only when nobody
// named is there. Harvest (tiles, the 40-credit budget, promote) stays in growth. Do not copy it.

import { geocodeAddress, searchPoi, type AzurePoi } from "@mycel/sourcing/azure-maps";
import { searchPlacesText } from "@mycel/sourcing/google-places";
import { resolveProvider } from "./providers";
import { ownDomain } from "@mycel/sourcing/identity";
import type { DomainStore } from "../domain";
import { COMPANY_COLLECTION, PEOPLE_COLLECTION } from "../linkedin/graph";
import { gtmWedge } from "./stages";

/** A shop filed as a person. Structurally a `FoundPerson` — defined here so this file does not import prospects. */
export interface MapsShop {
  profile_id: string;
  name: string;
  company?: string;
  company_domain?: string;
  location?: string;
}

export function mapsConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  // "Is a map configured at all", whichever provider — not "is Azure configured".
  return resolveProvider("places", env as Record<string, string | undefined>).chosen !== null;
}

/** Digits we will key a shop on when there is no own-domain. Not a dial string. */
export function phoneDigits(input: string | undefined): string | null {
  if (!input) return null;
  const digits = input.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) return null;
  return digits;
}

export interface MapsDiscoverInput {
  industries?: readonly string[];
  location?: string;
  keywords?: string;
  limit?: number;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

export interface MapsDiscoverResult {
  ok: boolean;
  pois: AzurePoi[];
  queries: number;
  detail?: string;
}

function poiQueries(input: MapsDiscoverInput): string[] {
  const industries = (input.industries ?? []).map((s) => s.trim()).filter(Boolean).slice(0, 3);
  const extra = (input.keywords ?? "").trim();
  const terms = industries.length ? industries : extra ? [extra] : [];
  return [...new Set(terms)].slice(0, 3);
}

/**
 * Geocode the audience's place, then POI-search each trade.
 *
 * NEVER THROWS. No key, no place, no trade — each is a named skip, never an empty market.
 * `/search/nearby` is the harvest path (TomTom category ids). GTM audiences are arbitrary trades,
 * so this uses `/search/poi` with a query. One point, 30km — not a country-wide tile walk.
 */
export async function mapsDiscover(input: MapsDiscoverInput): Promise<MapsDiscoverResult> {
  /**
   * WHICHEVER MAPS KEY IS SET. See ./providers.ts.
   *
   * This read `AZURE_MAPS_KEY` directly, so the map half of discovery was reachable only by
   * somebody who had already chosen the vendor we chose for cost. `input.apiKey` still wins and is
   * treated as Azure, because that is what every existing caller means by it.
   */
  const picked = input.apiKey ? null : resolveProvider("places");
  const key = (input.apiKey ?? (picked?.chosen ? process.env[picked.chosen.env] : "") ?? "").trim();
  const provider = input.apiKey ? "azure" : (picked?.chosen?.id ?? "");
  if (!key) {
    return { ok: false, pois: [], queries: 0, detail: "no maps key is configured, so nothing was searched" };
  }
  const where = (input.location ?? "").trim();
  if (!where) {
    return { ok: false, pois: [], queries: 0, detail: "this audience names no place, so the map had nowhere to look" };
  }
  const terms = poiQueries(input);
  if (!terms.length) {
    return {
      ok: false,
      pois: [],
      queries: 0,
      detail: "this audience names no industry or keywords, so there was nothing to search the map for",
    };
  }

  const doFetch = input.fetchImpl ?? fetch;
  let queries = 0;
  /**
   * GOOGLE IS ONE HOP. Text Search takes "bakery in Bristol" and needs no pin, so there is no
   * geocode call and no second failure mode where the map cannot place the town. It also halves the
   * request count, which is the unit both vendors bill.
   */
  let pin: { lat: number; lon: number } = { lat: 0, lon: 0 };
  if (provider !== "google") {
    try {
      queries += 1;
      const geo = await geocodeAddress(where, key, doFetch);
      if (!geo) {
        return { ok: false, pois: [], queries, detail: `the map could not place "${where}"` };
      }
      pin = geo;
    } catch (e) {
      return {
        ok: false,
        pois: [],
        queries,
        detail: `the map could not geocode: ${String((e as Error)?.message ?? e)}`,
      };
    }
  }

  const limit = Math.max(1, Math.min(input.limit ?? 25, 100));
  const seen = new Set<string>();
  const pois: AzurePoi[] = [];
  const failures: string[] = [];

  for (const term of terms) {
    if (pois.length >= limit) break;
    queries += 1;
    try {
      // Two providers, one POI shape. Everything below — the domain read, the phone, the dedupe —
      // is provider-agnostic and cannot tell them apart.
      const page =
        provider === "google"
          ? await searchPlacesText({ query: `${term} in ${where}`, limit }, key, doFetch)
          : await searchPoi({ query: term, lat: pin.lat, lon: pin.lon, limit }, key, doFetch);
      /**
       * A REFUSAL IS NOT AN EMPTY MARKET.
       *
       * The Azure helper THROWS on a bad response and the catch below records it. The Google helper
       * returns `{ results: [], detail }` instead, so without this a 403 for a key with the Places
       * API switched off arrived as "found nobody" — the one confusion this whole file is written
       * to prevent, and the one a founder reads once before they stop running discovery.
       */
      const refusal = (page as { detail?: string }).detail;
      if (refusal && page.results.length === 0) failures.push(refusal);
      for (const p of page.results) {
        if (pois.length >= limit) break;
        const d = ownDomain(p.website);
        const tel = phoneDigits(p.phone);
        const id = d ? `domain:${d}` : tel ? `tel:${tel}` : `name:${p.name.toLowerCase()}`;
        if (seen.has(id)) continue;
        seen.add(id);
        pois.push(p);
      }
    } catch (e) {
      failures.push(String((e as Error)?.message ?? e));
    }
  }

  if (!pois.length) {
    return {
      ok: failures.length === 0,
      pois,
      queries,
      detail: failures.length
        ? `the map could not run: ${failures[0]}`
        : `searched the map (${queries} ${queries === 1 ? "query" : "queries"}) and found no businesses`,
    };
  }
  return {
    ok: true,
    pois,
    queries,
    ...(failures.length ? { detail: `${failures.length} of the map queries failed` } : {}),
  };
}

export interface MapsFileResult {
  stamped: number;
  shops: MapsShop[];
  companies: number;
}

export type MapsJoinAction =
  | {
      kind: "company";
      key: string;
      name: string;
      website?: string;
      phone?: string;
      address?: string;
    }
  | { kind: "stamp"; profile_id: string; phone: string }
  | {
      kind: "shop";
      key: string;
      name: string;
      domain?: string;
      phone?: string;
      address?: string;
    };

/**
 * What to write for one map page, given the named people already on the graph.
 *
 * Stamp a phone onto a person at the same own-domain. File the shop itself only when nobody named
 * is there. A Wix URL is not a domain.
 */
export function mapsJoinPlan(
  pois: AzurePoi[],
  named: Array<{ profile_id: string; company_domain?: string }>,
): MapsJoinAction[] {
  const out: MapsJoinAction[] = [];
  for (const poi of pois) {
    const d = ownDomain(poi.website);
    const tel = phoneDigits(poi.phone);
    if (d) {
      out.push({
        kind: "company",
        key: d,
        name: poi.name,
        website: poi.website,
        phone: poi.phone,
        address: poi.address,
      });
      const matches = named.filter((p) => p.company_domain?.toLowerCase() === d);
      if (matches.length) {
        if (poi.phone) {
          for (const p of matches) out.push({ kind: "stamp", profile_id: p.profile_id, phone: poi.phone });
        }
        continue;
      }
      out.push({
        kind: "shop",
        key: `maps:${d}`,
        name: poi.name,
        domain: d,
        phone: poi.phone,
        address: poi.address,
      });
      continue;
    }
    if (!tel) continue;
    out.push({
      kind: "shop",
      key: `maps:tel:${tel}`,
      name: poi.name,
      phone: poi.phone,
      address: poi.address,
    });
  }
  return out;
}

/**
 * Join map finds onto the people graph. See `mapsJoinPlan` for the rules.
 */
export async function fileMapsFinds(
  domain: DomainStore,
  scope: { project_id: string; case_id?: string },
  pois: AzurePoi[],
  named: Array<{ profile_id: string; company_domain?: string }>,
  at = new Date().toISOString(),
): Promise<MapsFileResult> {
  if (!scope.project_id || !pois.length) return { stamped: 0, shops: [], companies: 0 };

  const wedge = gtmWedge();
  let stamped = 0;
  let companies = 0;
  const shops: MapsShop[] = [];

  for (const action of mapsJoinPlan(pois, named)) {
    try {
      if (action.kind === "company") {
        await domain.upsertRecord({
          project_id: scope.project_id,
          wedge,
          collection: COMPANY_COLLECTION,
          key: action.key,
          data: {
            name: action.name,
            domain: action.key,
            ...(action.website ? { website: action.website } : {}),
            ...(action.phone ? { phone: action.phone } : {}),
            ...(action.address ? { location: action.address } : {}),
            source: "azure-maps",
          },
        });
        companies += 1;
        continue;
      }
      if (action.kind === "stamp") {
        await domain.upsertRecord({
          project_id: scope.project_id,
          wedge,
          collection: PEOPLE_COLLECTION,
          key: action.profile_id,
          data: {
            phone: action.phone,
            provenance: {
              phone: {
                by: "azure-maps",
                cost_usd: 0,
                at,
                attempts: [{ by: "azure-maps", ok: true, cost_usd: 0, at }],
              },
            },
          },
          case_id: scope.case_id,
        });
        stamped += 1;
        continue;
      }
      await domain.upsertRecord({
        project_id: scope.project_id,
        wedge,
        collection: PEOPLE_COLLECTION,
        key: action.key,
        data: {
          profile_id: action.key,
          name: action.name,
          company: action.name,
          ...(action.domain ? { company_key: action.domain, company_domain: action.domain } : {}),
          ...(action.phone ? { phone: action.phone } : {}),
          ...(action.address ? { location: action.address } : {}),
          source: "azure-maps",
          provenance: {
            search: {
              by: "azure-maps",
              cost_usd: 0,
              at,
              attempts: [{ by: "azure-maps", ok: true, cost_usd: 0, at }],
            },
          },
        },
        case_id: scope.case_id,
      });
      shops.push({
        profile_id: action.key,
        name: action.name,
        company: action.name,
        company_domain: action.domain,
        location: action.address,
      });
    } catch (e) {
      console.error(`[mycel] could not apply maps join ${action.kind}:`, e);
    }
  }

  return { stamped, shops, companies };
}
