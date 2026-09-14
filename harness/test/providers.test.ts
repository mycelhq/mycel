// Whichever key you set is the provider you get.
//
// The GTM path reached four vendors by name, each hardcoded in the file that used it — Azure Maps,
// Serper, Firecrawl, FullEnrich. Those are our cost-optimised picks and a terrible first experience
// for anybody else: three accounts with unfamiliar vendors, in a specific combination, before the
// go-to-market half of the product does anything.
//
// The property that makes it simple is the inversion: configuration asks ONE question (what is your
// key) instead of two (which provider, and what is its key), because the second answer is the one
// people get wrong in a way that fails at runtime rather than at boot.

import test from "node:test";
import assert from "node:assert/strict";

import { PROVIDERS, howToEnable, overrideEnv, resolveAll, resolveProvider, shortestPath } from "../src/gtm/providers";

test("providers: no keys means off, and says the shortest way to turn it on", () => {
  const r = resolveProvider("search", {});
  assert.equal(r.chosen, null);
  assert.equal(r.problem, null, "absent is not an error — every capability is optional");
  assert.match(howToEnable(r), /Set SERPER_API_KEY/);
  assert.match(howToEnable(r), /https:\/\/serper\.dev/, "the answer to 'now what' sits with the question");
});

test("providers: setting one key is the whole configuration", () => {
  const r = resolveProvider("search", { BRAVE_API_KEY: "k" });
  assert.equal(r.chosen?.id, "brave");
  assert.match(howToEnable(r), /On, using Brave Search/);
});

test("providers: two keys resolve deterministically rather than surprisingly", () => {
  const r = resolveProvider("search", { SERPER_API_KEY: "a", BRAVE_API_KEY: "b" });
  assert.equal(r.chosen?.id, "serper", "first in list order, every time");
});

test("providers: an explicit choice is honoured over list order", () => {
  const r = resolveProvider("search", { SERPER_API_KEY: "a", BRAVE_API_KEY: "b", MYCEL_SEARCH_PROVIDER: "brave" });
  assert.equal(r.chosen?.id, "brave");
});

test("providers: asking for a provider whose key is missing is an ERROR, not a quiet fallback", () => {
  // Silently using a different vendor than the operator asked for is how a bill arrives from a
  // company they believed they had switched away from.
  const r = resolveProvider("search", { SERPER_API_KEY: "a", MYCEL_SEARCH_PROVIDER: "brave" });
  assert.equal(r.chosen, null);
  assert.match(r.problem ?? "", /BRAVE_API_KEY is not set/);
});

test("providers: a misspelled provider names the valid ones", () => {
  const r = resolveProvider("search", { MYCEL_SEARCH_PROVIDER: "bravé" });
  assert.equal(r.chosen, null);
  assert.match(r.problem ?? "", /not one of: serper, brave, tavily/);
});

test("providers: whitespace is not a key", () => {
  assert.equal(resolveProvider("search", { SERPER_API_KEY: "   " }).chosen, null);
});

test("providers: every capability resolves, and every option can be turned on by one variable", () => {
  const all = resolveAll({});
  assert.deepEqual(all.map((r) => r.capability), ["search", "places", "crawl", "enrich"]);
  for (const [cap, opts] of Object.entries(PROVIDERS)) {
    assert.ok(opts.length >= 2, `${cap} should offer a choice, not a single vendor`);
    assert.ok(opts.some((o) => o.implemented), `${cap} must have at least one provider that works`);
    for (const o of opts) {
      assert.match(o.env, /^[A-Z0-9_]+$/, `${o.id} needs one plain env var`);
      assert.match(o.signup, /^https:\/\//, `${o.id} must say where to get a key`);
      // Only a provider with code behind it can be selected. This asserted every option could be
      // turned on, which was true when the list was a wish and false once it told the truth.
      const chosen = resolveProvider(cap as "search", { [o.env]: "k" }).chosen?.id;
      assert.equal(chosen, o.implemented ? o.id : undefined, `${o.id} (implemented: ${o.implemented})`);
    }
  }
});

test("providers: the override variable is named the obvious way", () => {
  assert.equal(overrideEnv("places"), "MYCEL_PLACES_PROVIDER");
});

// ── Advertising only what there is code for ─────────────────────────────────
//
// The first version of this listed nine providers and four had an implementation. A user who read
// the availability endpoint, saw "set BRAVE_API_KEY to turn on search" and did it got a capability
// that resolved to Brave and a code path that could only call Serper — a promise the repo cannot
// keep, which is worse than the hardcoded vendor it replaced.

/**
 * DERIVED, NOT NAMED. This test hardcoded an example twice — Google Places, then Jina Reader — and
 * both times the test broke on the commit that BUILT the thing, which is the wrong moment for a
 * guard to fail. It reads the registry for whatever is still unbuilt today.
 */
test("providers: an option with no implementation is never chosen", () => {
  const unbuilt = (Object.entries(PROVIDERS) as Array<[keyof typeof PROVIDERS, typeof PROVIDERS.search]>)
    .flatMap(([cap, opts]) => opts.filter((o) => !o.implemented).map((o) => [cap, o] as const));
  for (const [cap, o] of unbuilt) {
    assert.equal(resolveProvider(cap, { [o.env]: "k" }).chosen, null, `${o.id} has no code behind it`);
  }
  // When the registry runs dry this loop checks nothing, which is a good state for the product and
  // a silent one for the suite. The synthetic case below is what keeps the rule under test.
});

test("providers: a key for a real provider still wins past an unimplemented one above it", () => {
  // Google is listed first for places because it is the shortest path for a stranger — but until it
  // is built, a user who sets the Azure key must still get Azure rather than nothing.
  assert.equal(resolveProvider("places", { AZURE_MAPS_KEY: "k" }).chosen?.id, "azure");
});

/**
 * A SYNTHETIC REGISTRY, because the real one is meant to run out of unbuilt providers.
 *
 * This test named a real unimplemented option twice and both times broke on the commit that BUILT
 * it. Deriving the example from `PROVIDERS` fixes that only until every option is implemented, at
 * which point the guard would pass by having nothing to check — the exact false green this codebase
 * keeps catching. The rule is about the resolver's behaviour, so it is tested on a registry that
 * exists to hold an unbuilt option.
 */
const SYNTHETIC: typeof PROVIDERS = {
  ...PROVIDERS,
  search: [
    { id: "real", env: "SYNTHETIC_REAL_KEY", label: "Real", signup: "https://example.com", implemented: true },
    { id: "planned", env: "SYNTHETIC_PLANNED_KEY", label: "Planned", signup: "https://example.com", implemented: false },
  ],
};

test("providers: asking for something unbuilt says so, rather than falling back silently", () => {
  const r = resolveProvider(
    "search",
    { SYNTHETIC_REAL_KEY: "k", SYNTHETIC_PLANNED_KEY: "k", MYCEL_SEARCH_PROVIDER: "planned" },
    SYNTHETIC,
  );
  assert.equal(r.chosen, null, "a key for an unbuilt provider must not make it selectable");
  assert.match(r.problem ?? "", /not implemented yet/);
});

test("providers: an unbuilt option is skipped in list order, not treated as the answer", () => {
  // It is listed FIRST here. A resolver that took the first option whose key is set, without asking
  // whether there is code behind it, would return `planned` and fail at the call site instead.
  const first: typeof PROVIDERS = { ...SYNTHETIC, search: [SYNTHETIC.search[1]!, SYNTHETIC.search[0]!] };
  const r = resolveProvider("search", { SYNTHETIC_REAL_KEY: "k", SYNTHETIC_PLANNED_KEY: "k" }, first);
  assert.equal(r.chosen?.id, "real");
});

test("providers: the instructions only name providers that exist", () => {
  // Derived, for the reason the unbuilt test is: naming a vendor here meant this broke on the
  // commit that built it. The property is that an instruction never sends somebody to a key with
  // no code behind it — telling them to set one that does nothing is the bug.
  for (const [cap, opts] of Object.entries(PROVIDERS)) {
    const detail = howToEnable(resolveProvider(cap as "search", {}));
    for (const o of opts.filter((x) => !x.implemented)) {
      assert.ok(!detail.includes(o.label), `${cap} instructions must not name ${o.label}`);
      assert.ok(!detail.includes(o.env), `${cap} instructions must not name ${o.env}`);
    }
    // The SHORTEST path, which is not the same as the first implemented one: list order picks the
    // winner when two keys are set, and a suggestion has to be something a stranger can act on
    // before they lose interest. See `instantKey`.
    assert.ok(
      detail.includes(shortestPath(opts)!.env),
      `${cap} must name the shortest path from off to on, not merely a working one`,
    );
  }
});


// ── What to suggest is not what to choose ──────────────────────────────────
//
// One list was answering two questions. Resolution takes the first keyed option because that is the
// better product; a first-run suggestion has to be a key somebody can actually get. Measured on a
// cold clone: boot told a newcomer to sign up for FullEnrich, which is a contact form.

test("providers: the suggestion is a key a stranger can get today", () => {
  for (const [cap, opts] of Object.entries(PROVIDERS)) {
    const pick = shortestPath(opts)!;
    assert.ok(pick.implemented, `${cap}: suggested a provider with no code behind it`);
    if (opts.some((o) => o.implemented && o.instantKey)) {
      assert.ok(pick.instantKey, `${cap}: an instant-key option exists and ${pick.id} was suggested instead`);
    }
  }
  assert.equal(shortestPath(PROVIDERS.enrich)!.id, "hunter", "FullEnrich's key arrives via a sales conversation");
  // Neither places option is instant — both sit behind a cloud project with billing attached — so
  // this falls back to list order rather than pretending one of them is two minutes' work.
  assert.equal(shortestPath(PROVIDERS.places)!.id, "google");
});

test("providers: suggesting is not choosing", () => {
  // The whole risk of the previous change: making the easy one the suggestion must not quietly make
  // it the one that runs when somebody has paid for the other.
  assert.equal(resolveProvider("enrich", { FULLENRICH_API_KEY: "a", HUNTER_API_KEY: "b" }).chosen?.id, "fullenrich");
});
