// The product-eval enrichment mock: MYCEL_FULLENRICH_MOCK=1 makes web discovery return a
// deterministic cast with no key and no spend, so the GTM journey evals can find clients headlessly.
import test from "node:test";
import assert from "node:assert/strict";
import { webDiscoverPeople } from "../src/gtm/discover-web";

test("MYCEL_FULLENRICH_MOCK returns a deterministic cast, no key needed", async () => {
  const prev = process.env.MYCEL_FULLENRICH_MOCK;
  process.env.MYCEL_FULLENRICH_MOCK = "1";
  try {
    const r = await webDiscoverPeople({ title: "Founder", location: "France", limit: 25 });
    assert.equal(r.ok, true);
    assert.ok(r.people.length >= 3, `expected a cast, got ${r.people.length}`);
    assert.ok(r.people.every((p) => p.profile_id && p.name && p.linkedin_url), "each mock person is well-formed");
    assert.equal(r.cost_usd, 0, "the mock spends nothing");
    // Page 2 is empty so a find loop terminates.
    const page2 = await webDiscoverPeople({ title: "Founder", limit: 25, start: 25 });
    assert.equal(page2.people.length, 0, "pagination terminates");
  } finally {
    if (prev === undefined) delete process.env.MYCEL_FULLENRICH_MOCK;
    else process.env.MYCEL_FULLENRICH_MOCK = prev;
  }
});
