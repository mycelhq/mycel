import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildFilters, mapPerson, webDiscoverPeople } from "../src/gtm/discover-web";

describe("FullEnrich web discovery", () => {
  it("buildFilters maps the loose composer input to FullEnrich filters", () => {
    const f = buildFilters({ title: "Founder", company: "Stripe", location: "France" });
    // apiv2.StringFilters: an ARRAY of { value } objects (confirmed live — a bare string array 400s).
    assert.deepEqual(f.current_position_titles, [{ value: "Founder" }]);
    assert.deepEqual(f.person_locations, [{ value: "France" }]);
    assert.deepEqual(f.current_company_names, [{ value: "Stripe" }]);
    // title + query merge into one titles field, deduped
    assert.deepEqual(buildFilters({ title: "CEO", query: "Co-Founder" }).current_position_titles, [
      { value: "CEO" },
      { value: "Co-Founder" },
    ]);
  });

  it("mapPerson turns a FullEnrich person into a FoundPerson with the LinkedIn URL", () => {
    const p = mapPerson({
      full_name: "Karen-Laure Mrejen",
      headline: "Founder @Swaive",
      linkedin_url: "https://www.linkedin.com/in/karen-laure-mrejen",
      location: "Paris, France",
      current_position: { title: "Founder", company_name: "Swaive" },
    });
    assert.ok(p, "should map");
    assert.equal(p!.name, "Karen-Laure Mrejen");
    assert.equal(p!.linkedin_url, "https://www.linkedin.com/in/karen-laure-mrejen");
    assert.ok(p!.profile_id, "keyed on something stable");
  });

  it("mapPerson returns null for an unkeyable row (nothing to key on)", () => {
    assert.equal(mapPerson({}), null);
    assert.equal(mapPerson("nope"), null);
  });

  it("webDiscoverPeople short-circuits when FullEnrich is not configured", async () => {
    const prev = process.env.FULLENRICH_API_KEY;
    delete process.env.FULLENRICH_API_KEY;
    try {
      const r = await webDiscoverPeople({ title: "Founder" });
      assert.equal(r.ok, false);
      assert.equal(r.code, "fullenrich_not_configured");
    } finally {
      if (prev !== undefined) process.env.FULLENRICH_API_KEY = prev;
    }
  });
});
