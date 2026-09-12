import test from "node:test";
import assert from "node:assert/strict";
import { geocodeAddress, searchPoi, AZURE_RESULT_CEILING } from "@mycel/sourcing/azure-maps";
import {
  mapsDiscover,
  mapsJoinPlan,
  phoneDigits,
} from "../src/gtm/discover-maps";

const fakeFetch = (rows: unknown[], ok = true) =>
  (async () => ({
    ok,
    status: ok ? 200 : 429,
    json: async () => ({ results: rows }),
    text: async () => "err",
  })) as unknown as typeof fetch;

test("no maps key is a named skip, not an empty market", async () => {
  const r = await mapsDiscover({ industries: ["bakery"], location: "Bristol", apiKey: "" });
  assert.equal(r.ok, false);
  assert.match(r.detail ?? "", /no maps key/);
  assert.equal(r.pois.length, 0);
});

test("no place is a named skip — nearby needs a point", async () => {
  const r = await mapsDiscover({ industries: ["bakery"], apiKey: "k" });
  assert.equal(r.ok, false);
  assert.match(r.detail ?? "", /no place/);
});

test("geocode then POI — the GTM hop, not nearby-by-category", async () => {
  const seen: string[] = [];
  const impl = (async (url: string) => {
    seen.push(url);
    if (url.includes("/search/address/json")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ results: [{ position: { lat: 51.45, lon: -2.59 }, address: { freeformAddress: "Bristol" } }] }),
        text: async () => "",
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        results: [{ poi: { name: "Hart's Bakery", phone: "+44 117 973 2600", url: "https://hartsbakery.co.uk" }, address: { freeformAddress: "Bristol" }, position: {}, id: "x" }],
      }),
      text: async () => "",
    };
  }) as unknown as typeof fetch;

  const r = await mapsDiscover({
    industries: ["bakery"],
    location: "Bristol",
    apiKey: "k",
    fetchImpl: impl,
    limit: 10,
  });
  assert.equal(r.ok, true);
  assert.equal(r.pois.length, 1);
  assert.equal(r.pois[0]?.phone, "+44 117 973 2600");
  assert.ok(seen.some((u) => u.includes("/search/address/json")), "must geocode the place");
  assert.ok(seen.some((u) => u.includes("/search/poi/json")), "GTM trades use POI+query, not nearby+category");
  assert.ok(!seen.some((u) => u.includes("/search/nearby/json")));
});

test("a named person at the same own-domain gets the phone — the shop is not filed twice", () => {
  const plan = mapsJoinPlan(
    [{ name: "Hart's Bakery", phone: "+44 117 973 2600", website: "https://hartsbakery.co.uk" }],
    [{ profile_id: "in-ada", company_domain: "hartsbakery.co.uk" }],
  );
  const stamp = plan.find((a) => a.kind === "stamp");
  assert.equal(stamp?.kind, "stamp");
  if (stamp?.kind === "stamp") {
    assert.equal(stamp.profile_id, "in-ada");
    assert.equal(stamp.phone, "+44 117 973 2600");
  }
});

test("no named person — the shop is filed as maps:{domain}", () => {
  const plan = mapsJoinPlan(
    [{ name: "Hart's Bakery", phone: "+44 117 973 2600", website: "https://www.hartsbakery.co.uk" }],
    [],
  );
  const shop = plan.find((a) => a.kind === "shop");
  assert.equal(shop?.key, "maps:hartsbakery.co.uk");
});

test("a Wix URL is not a domain — identity falls through to the phone", () => {
  const plan = mapsJoinPlan(
    [{ name: "Joe's Plumbing", phone: "+1 415-555-0142", website: "https://joesplumbing.wixsite.com/home" }],
    [],
  );
  assert.ok(!plan.some((a) => a.kind === "company"));
  const shop = plan.find((a) => a.kind === "shop");
  assert.equal(shop?.key, "maps:tel:14155550142");
});

test("UK numbers still key a shop when there is no domain", () => {
  assert.equal(phoneDigits("+44 117 973 2600"), "441179732600");
  const plan = mapsJoinPlan([{ name: "A shop", phone: "+44 117 973 2600" }], []);
  assert.equal(plan[0]?.kind, "shop");
  assert.equal(plan[0] && plan[0].kind === "shop" ? plan[0].key : "", "maps:tel:441179732600");
});

test("searchPoi with an empty query does not hit the network — Azure would return zero", async () => {
  let hit = false;
  const spy = (async () => {
    hit = true;
    return { ok: true, status: 200, json: async () => ({ results: [] }), text: async () => "" };
  }) as unknown as typeof fetch;
  const r = await searchPoi({ query: "  ", lat: 51, lon: -2 }, "k", spy);
  assert.equal(r.results.length, 0);
  assert.equal(hit, false);
});

test("geocode returns null rather than a guessed point", async () => {
  const r = await geocodeAddress("nowhere-xyz", "k", fakeFetch([]));
  assert.equal(r, null);
});

test("Azure's 100-result ceiling is still the cap on POI search", async () => {
  const full = Array.from({ length: AZURE_RESULT_CEILING }, (_, i) => ({
    poi: { name: `Shop ${i}` },
    address: {},
    position: {},
    id: String(i),
  }));
  const r = await searchPoi({ query: "bakery", lat: 51, lon: -2 }, "k", fakeFetch(full));
  assert.equal(r.saturated, true);
});
