// Finding businesses before spending anything on reaching them.
//
// GTM discovery ran on FullEnrich alone — an email waterfall, charged per contact, very good at
// turning a known person into a reachable one and the wrong tool for finding out who is out there.
// It also shaped the product around what it can see: LinkedIn-shaped individuals at companies large
// enough to have them. The studio this was built for sells to independent cafes and bakeries, whose
// owners are frequently not on LinkedIn at all — and a discovery step that can only return LinkedIn
// profiles reports that market as EMPTY, which is a much worse answer than an expensive one.
import test from "node:test";
import assert from "node:assert/strict";
import { businessName, cheapDiscover, dorksFor, parseOrganic } from "../src/gtm/discover-cheap";

/** A Serper `/search` response, in the shape `growth/lib/sourcing/serper.ts` proves in production. */
const serperStub = (organic: { title: string; link: string; snippet?: string }[], status = 200) => {
  const calls: string[] = [];
  const impl = (async (_url: string, init?: { body?: string }) => {
    // Recorded HERE, not inside the body reader. It used to be recorded inside `json()`, so a query
    // whose response was never parsed went unrecorded — which made "how many queries did we send"
    // silently depend on how the caller happened to read the answer.
    calls.push(JSON.parse(String(init?.body ?? "{}")).q);
    const body = JSON.stringify({ organic });
    return {
      ok: status === 200,
      status,
      // A real `Response` has both, and the caller reads `text()` so it can quote the provider's
      // own error message on a failure instead of just the status code.
      text: async () => body,
      json: async () => JSON.parse(body),
    };
  }) as unknown as typeof fetch;
  return { impl, calls };
};

test("it finds businesses, not LinkedIn profiles", async () => {
  const { impl } = serperStub([
    { title: "Hart's Bakery | Artisan Sourdough in Bristol | Order Online", link: "https://hartsbakery.co.uk/about", snippet: "A railway-arch bakery under Temple Meads." },
    { title: "Little Victories - Speciality Coffee", link: "https://www.littlevictories.co.uk/", snippet: "Coffee bar and roastery." },
  ]);
  const r = await cheapDiscover({
    industries: ["independent bakery"],
    location: "Bristol",
    apiKey: "k",
    fetchImpl: impl,
  });
  assert.equal(r.ok, true);
  assert.equal(r.businesses.length, 2);

  // The name a person would use, not the SEO tail Google shows.
  assert.equal(r.businesses[0]!.name, "Hart's Bakery");
  assert.equal(r.businesses[0]!.domain, "hartsbakery.co.uk");
  // `www.` is stripped, because it is the dedupe key and a domain that differs by four characters
  // would be sourced twice.
  assert.equal(r.businesses[1]!.domain, "littlevictories.co.uk");
  // Google's snippet is the only free evidence of what they actually do. Kept, for the opener.
  assert.match(r.businesses[0]!.about!, /railway-arch/);
  // And which dork found them, so a founder can see why this business is on their list.
  assert.ok(r.businesses[0]!.via);
});

test("directories are not businesses you can sell to", async () => {
  // A dork for "independent bakery Bristol" returns TripAdvisor before it returns a bakery.
  const { impl } = serperStub([
    { title: "THE 10 BEST Bakeries in Bristol", link: "https://www.tripadvisor.co.uk/x" },
    { title: "Bakeries in Bristol | Yell", link: "https://www.yell.com/x" },
    { title: "Bristol bakery jobs", link: "https://uk.indeed.com/q-bakery" },
    { title: "Some Bakery", link: "https://linkedin.com/company/some-bakery" },
    { title: "Mark's Bread", link: "https://marksbread.co.uk" },
  ]);
  const r = await cheapDiscover({ industries: ["bakery"], apiKey: "k", fetchImpl: impl });
  assert.deepEqual(r.businesses.map((b) => b.domain), ["marksbread.co.uk"]);
});

test("the same business found by two dorks is one business", async () => {
  const { impl } = serperStub([
    { title: "Hart's Bakery — About", link: "https://hartsbakery.co.uk/about" },
    { title: "Hart's Bakery — Contact", link: "https://hartsbakery.co.uk/contact" },
  ]);
  const r = await cheapDiscover({ industries: ["bakery"], apiKey: "k", fetchImpl: impl });
  assert.equal(r.businesses.length, 1);
});

test("'we could not search' never reads as 'nobody is out there'", async () => {
  // The state that matters most. A discovery step returning zero and saying nothing is
  // indistinguishable from an empty market, and a founder who reads that once stops running the loop.
  const noKey = await cheapDiscover({ industries: ["bakery"], apiKey: "" });
  assert.equal(noKey.ok, false);
  assert.equal(noKey.queries, 0);
  assert.match(noKey.detail!, /no search key/);

  // The failure a founder will actually hit: the account runs out of credits mid-sweep.
  const { impl } = serperStub([], 400);
  const broke = await cheapDiscover({ industries: ["bakery"], apiKey: "k", fetchImpl: impl });
  assert.equal(broke.ok, false);
  assert.match(broke.detail!, /answered 400/);

  // And a genuine empty result says THAT, distinctly, with what it cost.
  const { impl: empty } = serperStub([]);
  const none = await cheapDiscover({ industries: ["bakery"], apiKey: "k", fetchImpl: empty });
  assert.equal(none.ok, true);
  assert.match(none.detail!, /found no businesses/);
  assert.ok(none.queries > 0);

  // A network error is carried out, not swallowed into silence.
  const throws = (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch;
  const died = await cheapDiscover({ industries: ["bakery"], apiKey: "k", fetchImpl: throws });
  assert.equal(died.ok, false);
  assert.match(died.detail!, /ECONNRESET/);
});

test("the dorks come from what the founder said, and cost is bounded", async () => {
  // `growth/`'s dorks hunt agencies. These have to hunt whatever trade the founder actually sells
  // to, so they are built from the audience rather than from a fixed catalogue.
  const qs = dorksFor({ industries: ["independent cafe", "bakery"], location: "Bristol" });
  assert.ok(qs.every((q) => /Bristol/.test(q)));
  assert.ok(qs.some((q) => /"independent cafe"/.test(q)));
  // A recruiter's page for a bakery is not a bakery.
  assert.ok(qs.every((q) => /-jobs -careers -hiring/.test(q)));
  // Each dork is one paid query, so the count is capped rather than growing with the audience.
  assert.ok(dorksFor({ industries: ["a", "b", "c", "d", "e", "f"], location: "x" }).length <= 8);
  // Nothing to search for is not an error, and is not a search.
  assert.deepEqual(dorksFor({}), []);
});

test("a title with no separator is kept whole rather than cut at a guessed length", () => {
  assert.equal(businessName("Hart's Bakery | Artisan Sourdough"), "Hart's Bakery");
  assert.equal(businessName("Little Victories - Speciality Coffee"), "Little Victories");
  assert.equal(businessName("Mark's Bread"), "Mark's Bread");
  // A leading fragment too short to be a name means the split was wrong; use the title.
  assert.equal(businessName("Co | Bristol Roasters"), "Co | Bristol Roasters");
});

test("the limit is a spend cap, and it is honoured", async () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ title: `Shop ${i}`, link: `https://shop${i}.co.uk` }));
  const { impl } = serperStub(many);
  const r = await cheapDiscover({ industries: ["bakery"], apiKey: "k", fetchImpl: impl, limit: 5 });
  assert.equal(r.businesses.length, 5);
  // Stopped sweeping once it had enough — the queries are what cost money.
  assert.equal(r.queries, 1);
});

// ── Two search providers, one normalised result ─────────────────────────────

test("search: a Brave key sends the request to Brave, not to Serper", async () => {
  const seen: string[] = [];
  const fetchImpl = (async (url: string) => {
    seen.push(String(url));
    return { ok: true, status: 200, text: async () => JSON.stringify({ web: { results: [
      { title: "Hart's Bakery — Bristol", url: "https://hartsbakery.co.uk", description: "A bakery." },
    ] } }) };
  }) as unknown as typeof fetch;

  const prev = process.env.BRAVE_API_KEY;
  process.env.BRAVE_API_KEY = "k";
  try {
    const r = await cheapDiscover({ industries: ["bakery"], location: "Bristol", fetchImpl, limit: 5 });
    assert.ok(seen.some((u) => u.includes("api.search.brave.com")), `hit: ${seen[0]}`);
    assert.ok(!seen.some((u) => u.includes("serper.dev")));
    assert.equal(r.businesses[0]?.domain, "hartsbakery.co.uk", "Brave's shape must normalise");
  } finally {
    if (prev === undefined) delete process.env.BRAVE_API_KEY;
    else process.env.BRAVE_API_KEY = prev;
  }
});

test("search: every provider shape normalises onto the same result", () => {
  const want = [{ title: "T", link: "https://x.com", snippet: "D" }];
  assert.deepEqual(
    parseOrganic("brave", JSON.stringify({ web: { results: [{ title: "T", url: "https://x.com", description: "D" }] } })),
    want,
  );
  assert.deepEqual(parseOrganic("serper", JSON.stringify({ organic: want })), want);
  assert.deepEqual(
    parseOrganic("tavily", JSON.stringify({ results: [{ title: "T", url: "https://x.com", content: "D", score: 0.9 }] })),
    want,
    "downstream code must not be able to tell them apart",
  );
});

test("search: a Tavily key sends the request to Tavily, with the key as a bearer", async () => {
  const seen: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    seen.push({ url: String(url), init });
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ results: [{ title: "Hart's Bakery — Bristol", url: "https://hartsbakery.co.uk", content: "A bakery." }] }),
    };
  }) as unknown as typeof fetch;

  const prev = process.env.TAVILY_API_KEY;
  process.env.TAVILY_API_KEY = "tvly-k";
  try {
    const r = await cheapDiscover({ industries: ["bakery"], location: "Bristol", fetchImpl, limit: 5 });
    assert.ok(seen.some((c) => c.url.includes("api.tavily.com")), `hit: ${seen[0]?.url}`);
    assert.ok(!seen.some((c) => c.url.includes("serper.dev") || c.url.includes("brave.com")));
    assert.equal((seen[0]!.init?.headers as Record<string, string>).authorization, "Bearer tvly-k");
    assert.equal(r.businesses[0]?.domain, "hartsbakery.co.uk", "Tavily's shape must normalise");
  } finally {
    if (prev === undefined) delete process.env.TAVILY_API_KEY;
    else process.env.TAVILY_API_KEY = prev;
  }
});

test("search: Tavily is asked in plain words, because it reads operators as meaning", async () => {
  /**
   * The failure this pins is silent and returns 200. Tavily is semantic: it does not refuse
   * `-jobs -careers`, it absorbs them, so a dork that means "bakeries, NOT job pages" becomes a
   * request for bakeries AND job pages — with a full result set and nothing to warn on.
   */
  const asked: string[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    asked.push((JSON.parse(String(init?.body)) as { query: string }).query);
    return { ok: true, status: 200, text: async () => JSON.stringify({ results: [] }) };
  }) as unknown as typeof fetch;

  const prev = process.env.TAVILY_API_KEY;
  process.env.TAVILY_API_KEY = "k";
  try {
    const r = await cheapDiscover({ industries: ["bakery"], location: "Bristol", fetchImpl, limit: 5 });
    assert.ok(asked.length > 0, "a query must actually have been sent");
    for (const q of asked) {
      assert.ok(!/-\w+|\bOR\b|["()]/.test(q), `an operator survived into a semantic query: ${q}`);
    }
    assert.match(r.detail ?? "", /broader|degraded|without/i, "a widened sweep must say so");
  } finally {
    if (prev === undefined) delete process.env.TAVILY_API_KEY;
    else process.env.TAVILY_API_KEY = prev;
  }
});

test("search: a body that is not JSON is no results, not a crash", () => {
  assert.deepEqual(parseOrganic("brave", "<html>rate limited</html>"), []);
});
