// Google Places (New) Text Search — the other way to find shops on a map.
//
// ═══ WHY A SECOND PLACES PROVIDER ═══
//
// Azure Maps is what we run, because it is the cheapest per lookup at the volume we run it. It is
// also the one with the most account setup in front of it, and the open repo had it as the only
// option — so the map half of discovery was unreachable for anybody who had not already decided to
// use Azure. `kernel/harness/src/gtm/providers.ts` lists Google first for exactly that reason: a
// stranger evaluating this on a Sunday meets the shortest path to a working key.
//
// ═══ IT IS ONE HOP, NOT TWO ═══
//
// The Azure path geocodes the place name to a lat/lon and then searches POIs around that pin. Text
// Search takes "bakery in Bristol" directly, so there is no geocode call, no pin, and no second
// failure mode where the map cannot place the town. That also halves the request count, which is
// the unit Google bills.
//
// ═══ THE FIELD MASK IS NOT OPTIONAL ═══
//
// `X-Goog-FieldMask` is required, and a field absent from it is absent from the response — not
// null, not empty, missing. Asking for everything is billed at the highest SKU, so this asks for
// exactly the five fields `Poi` carries and nothing else. A field added to `Poi` later must be
// added here too or it will silently always be undefined.

import type { AzurePoi } from "./azure-maps";

/** The shape Google returns, narrowed to what the field mask asks for. */
interface GooglePlace {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  websiteUri?: string;
  nationalPhoneNumber?: string;
}

export const GOOGLE_PLACES_ENDPOINT = "https://places.googleapis.com/v1/places:searchText";

/** Exactly the fields `AzurePoi` carries. Anything not named here does not come back. */
export const GOOGLE_PLACES_FIELD_MASK =
  "places.id,places.displayName,places.formattedAddress,places.websiteUri,places.nationalPhoneNumber";

/**
 * One Text Search, normalised onto the same POI shape the Azure path produces.
 *
 * `AzurePoi` is named for the provider that arrived first and is structurally generic — a name, a
 * phone, a website, an address. Renaming it would touch every caller in two apps for no behavioural
 * gain, so the second provider adopts it rather than introducing a parallel type that means the
 * same thing.
 *
 * THROWS on a transport error and returns an empty list on a refusal, matching the Azure module:
 * the caller counts queries and turns a failure into a named skip, and it must be able to tell "the
 * map found nobody" from "the map did not answer".
 */
export async function searchPlacesText(
  input: { query: string; limit?: number },
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ results: AzurePoi[]; status: number; detail?: string }> {
  const pageSize = Math.max(1, Math.min(input.limit ?? 20, 20));
  const res = await fetchImpl(GOOGLE_PLACES_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": GOOGLE_PLACES_FIELD_MASK,
    },
    body: JSON.stringify({ textQuery: input.query, pageSize }),
  });

  const text = await res.text();
  if (!res.ok) {
    // Carry Google's own sentence. "answered 400" sends somebody looking for a bug in the query
    // when the body says the key has no Places API enabled on it.
    let detail = `the map provider answered ${res.status}`;
    try {
      const m = (JSON.parse(text) as { error?: { message?: string } }).error?.message;
      if (m) detail = `the map provider refused: ${m}`;
    } catch {
      /* not JSON — the status is all there is */
    }
    return { results: [], status: res.status, detail };
  }

  let places: GooglePlace[] = [];
  try {
    places = (JSON.parse(text) as { places?: GooglePlace[] }).places ?? [];
  } catch {
    return { results: [], status: res.status, detail: "the map provider returned something that is not JSON" };
  }

  return {
    status: res.status,
    results: places
      .map((p): AzurePoi | null => {
        const name = p.displayName?.text?.trim();
        // A place with no name is not a business we can file, whatever else came back with it.
        if (!name) return null;
        return {
          name,
          phone: p.nationalPhoneNumber?.trim() || undefined,
          website: p.websiteUri?.trim() || undefined,
          address: p.formattedAddress?.trim() || undefined,
          providerId: p.id?.trim() || undefined,
        };
      })
      .filter((p): p is AzurePoi => p !== null),
  };
}
