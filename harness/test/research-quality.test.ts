// The only thing we knew about a research run was `reached: true`. A run that read three trade-body
// method statements and a run that read four agency landing pages both reported `reached: true` and
// were indistinguishable to every surface downstream — while being the difference between a service
// that scores 8/10 on "is this about MY trade" and one that scores 3.

import { test } from "node:test";
import assert from "node:assert/strict";
import { classifySource, describeResearch, researchQuality } from "../src/research-quality";

test("a regulator, a standard or a trade body is a primary source", () => {
  for (const u of [
    "https://www.gov.uk/guidance/planning-permission",                   // regulator
    "https://ico.org.uk/for-organisations/code-of-practice/",            // path names a code
    "https://www.rics.org/standards/valuation-global-standards",         // /standards in the path
    "https://someuniversity.edu/syllabus/paralegal",                     // a qualification
    "https://www.chartered-institute-of-x.org/practice-notes/billing",   // trade body spelled out
  ]) {
    assert.equal(classifySource(u), "primary", u);
  }
});

test("an acronym trade body is under-counted, and that is the chosen direction", () => {
  // `ada.org` is the American Dental Association defining dental billing codes. No structural test
  // can tell it from any other three-letter .org, so it scores `marketing`. That is wrong — and it
  // is wrong the safe way: this metric under-states quality and never inflates it. A number that
  // flattered the run would green-light a research step that read four landing pages.
  assert.equal(classifySource("https://www.ada.org/resources/practice/dental-codes"), "marketing");
  // The same body scores correctly the moment its path says what the page is.
  assert.equal(classifySource("https://www.ada.org/standards/dental-codes"), "primary");
});

test("the software a trade lives in is its own opinion about what a job must contain", () => {
  for (const u of [
    "https://docs.stripe.com/invoicing",
    "https://developer.intuit.com/app/developer/qbo/docs/api",
    "https://support.dentrix.com/help-center/claims",
    "https://example.com/documentation/claims-api",
  ]) {
    assert.equal(classifySource(u), "vendor_docs", u);
  }
});

test("a practitioner writing at length is worth more than a sales page", () => {
  for (const u of [
    "https://blog.someone.com/how-i-actually-work-denials",
    "https://www.reddit.com/r/dentistry/comments/xyz/eob_denials",
    "https://community.example.com/thread/1234",
    "https://medium.com/@someone/planning-validation",
  ]) {
    assert.equal(classifySource(u), "practitioner", u);
  }
});

test("a page selling the service is marketing, however professional it looks", () => {
  for (const u of ["https://acmedental.com/services", "https://acme.com/pricing", "https://acme.com/"]) {
    assert.equal(classifySource(u), "marketing", u);
  }
});

test("no source at all is distinguishable from a weak one", () => {
  // A finding nobody can check must not score the same as one cited to a sales page — that is the
  // difference between "we read something poor" and "we made it up".
  assert.equal(classifySource(""), "none");
  assert.equal(classifySource(undefined), "none");
  assert.equal(classifySource("   "), "none");
  // A citation that is not a URL is still a claim, just an unverifiable one.
  assert.equal(classifySource("BDA Advice Sheet B4, 2024 edition"), "marketing");
});

test("a real research payload scores on the sources its findings carry", () => {
  const good = researchQuality({
    reached: true,
    mechanics: [
      { rule: "an EOB carries a denial code", source: "https://www.ada.org/resources/claims/eob" },
      { rule: "resubmission window is 90 days", source: "https://www.gov.uk/guidance/claims" },
    ],
    steps: [{ step: "file the claim", who: "practice manager", source: "https://docs.dentrix.com/claims" }],
  });
  const weak = researchQuality({
    reached: true,
    mechanics: [{ rule: "claims can be denied", source: "https://acmedental.com/services" }],
    steps: [{ step: "handle admin", who: "staff", source: "" }],
  });
  assert.ok(good.depth > weak.depth, `good ${good.depth} should beat weak ${weak.depth}`);
  assert.equal(good.sourced, 1);
  assert.equal(weak.sourced, 0.5, "half of the weak run's findings cite nothing");
  assert.equal(good.distinctHosts, 3);
});

test("everything cited to one site is a different failure from half of it citing nothing", () => {
  // Reported separately on purpose: one number would hide which of the two happened, and they need
  // different corrections — go somewhere else, versus go back and cite what you already found.
  const oneVoice = researchQuality({
    mechanics: [
      { rule: "a", source: "https://blog.x.com/1" },
      { rule: "b", source: "https://blog.x.com/2" },
      { rule: "c", source: "https://blog.x.com/3" },
    ],
  });
  assert.equal(oneVoice.distinctHosts, 1);
  assert.equal(oneVoice.sourced, 1, "every finding IS sourced — the problem is that it is one opinion");
  assert.deepEqual(oneVoice.unsourced, []);
});

test("an empty result is zero, not a crash", () => {
  for (const v of [undefined, null, {}, { reached: false }, "nonsense", 42]) {
    const q = researchQuality(v);
    assert.equal(q.depth, 0);
    assert.equal(q.sourced, 0);
  }
});

test("the sentence names publishers, because that is what makes it believable", () => {
  const q = researchQuality({
    mechanics: [{ rule: "x", source: "https://www.ada.org/standards/x" }],
    steps: [{ step: "y", source: "https://acme.com/services" }],
  });
  const line = describeResearch(q);
  assert.match(line, /standards or trade bodies/);
  assert.match(line, /sales pages/);
  assert.ok(!/0\.\d/.test(line), `a founder reads publishers, not a score: ${line}`);
});
