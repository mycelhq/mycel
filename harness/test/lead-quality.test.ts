// The founder's pipeline, verbatim, with the junk it actually contained.

import { test } from "node:test";
import assert from "node:assert/strict";
import { judgeLead, looksLikeOrganisation, screenLeads } from "@mycel/sourcing";

test("the rows that were actually in the pipeline are dropped", () => {
  // Every one of these was on screen between real prospects, with no face and nothing to send to.
  const junk = [
    { name: "Agora Software", company: "Agora Software", linkedin_url: "https://x" },
    { name: "Teranga Software", company: "Teranga Software", linkedin_url: "https://x" },
    { name: "Altena-Software", company: "Altena-Software", linkedin_url: "https://x" },
    { name: "International Software Company", company: "International Software Company", linkedin_url: "https://x" },
    { name: "Dlubal Software FR", company: "Dlubal Software FR", linkedin_url: "https://x" },
    { name: "Check Point Software Technologies", company: "Check Point Software Technologies", linkedin_url: "https://x" },
    { name: "Siyam Kham Business Software", company: "Siyam Kham Business Software", linkedin_url: "https://x" },
    { name: "P2M Web And Software", company: "P2M Web And Software", linkedin_url: "https://x" },
  ];
  for (const l of junk) {
    const v = judgeLead(l);
    assert.equal(v.keep, false, `kept "${l.name}", which is a company`);
    assert.match(String(v.reason), /company/i);
  }
});

test("the real people from the same screen are kept", () => {
  // The gate that matters more. A hygiene filter that eats real prospects is worse than the junk.
  const real = [
    { name: "Khadija Kamoun", company: "Independent", headline: "Head of Growth B2B | €2M+ Revenue Generated", linkedin_url: "https://x" },
    { name: "Adriana Massino", company: "Televet", headline: "Fondatrice @Televet", email: "adriana@televet.co" },
    { name: "Elena Debbaut", company: "Self", headline: "Turnaround • Strategic Execution • Operational Restructuring", linkedin_url: "https://x" },
    { name: "Mickaël Driol", company: "Mekong Partners", headline: "DG, Mekong Partners", linkedin_url: "https://x" },
    { name: "Sunny Dhingra", company: "Acme", headline: "MBA", linkedin_url: "https://x" },
    { name: "Quentin H.", company: "Acme", headline: "Cyber Security & Cyber Resilience", linkedin_url: "https://x" },
    { name: "Rafael Branco", company: "TIMOCOM", headline: "Product Marketing Manager", linkedin_url: "https://x" },
    { name: "Mugilan Chitambram", company: "Valiram", headline: "Regional Digital Marketing Manager", linkedin_url: "https://x" },
  ];
  for (const l of real) {
    const v = judgeLead(l);
    assert.equal(v.keep, true, `dropped "${l.name}" — reason given: ${v.reason}`);
  }
});

test("a person whose employer is a person-shaped name is still kept", () => {
  // "Mickaël Driol" at "Driol" — folding both to the same string would drop a real lead. The rule is
  // name EQUALS company, not name resembles it.
  assert.equal(judgeLead({ name: "Mickaël Driol", company: "Driol Consulting", headline: "DG", linkedin_url: "https://x" }).keep, true);
});

test("a real person with an unusual name survives on the strength of a headline", () => {
  // `looksLikeOrganisation` fires on four-plus words, which some real names reach. A headline is the
  // strongest evidence there is a human here, so it overrides the shape test.
  const withHeadline = { name: "Maria de los Angeles Ruiz", company: "Acme", headline: "Head of Ops at Acme", linkedin_url: "https://x" };
  assert.equal(judgeLead(withHeadline).keep, true, "dropped a real person with a long name and a real headline");
});

test("nothing to contact is nothing to sequence", () => {
  assert.equal(judgeLead({ name: "Jane Doe", company: "Acme" }).keep, false);
  assert.match(String(judgeLead({ name: "Jane Doe", company: "Acme" }).reason), /no email, profile or phone/);
});

test("scraper placeholders are not people", () => {
  for (const n of ["LinkedIn Member", "unknown", "N/A", "info", "test"]) {
    assert.equal(judgeLead({ name: n, company: "Acme", linkedin_url: "https://x" }).keep, false, `kept "${n}"`);
  }
});

test("organisation detection is structural, so it holds in languages nobody listed", () => {
  for (const n of ["Nordic Nest Group AB", "Bureau Vallée SARL", "Müller Systems GmbH", "Studio Kern & Partners"]) {
    assert.ok(looksLikeOrganisation(n), `missed "${n}"`);
  }
  for (const n of ["Elena Debbaut", "Quentin H.", "Rafael Branco"]) {
    assert.ok(!looksLikeOrganisation(n), `"${n}" was called a company`);
  }
});

test("screening a batch reports what it removed, so a founder can audit the filter", () => {
  // A garbage collector nobody can inspect is one nobody will trust with their pipeline.
  const { keep, dropped } = screenLeads([
    { name: "Agora Software", company: "Agora Software", linkedin_url: "https://x" },
    { name: "Rafael Branco", company: "TIMOCOM", headline: "PMM", linkedin_url: "https://x" },
  ]);
  assert.equal(keep.length, 1);
  assert.equal(dropped.length, 1);
  assert.ok(dropped[0]!.reason.length > 10, "dropped without a sentence anybody could read");
});
