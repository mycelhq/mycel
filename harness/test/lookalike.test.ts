// More of the clients you already won — and the refusals that stop it being astrology.
//
// "Find me more companies like my best clients" is the most natural thing a founder asks and the
// easiest question in this product to answer badly. Hand it to a model with three won accounts and
// it produces a confident ideal-customer profile assembled from what they have in COMMON — which at
// n=3 is that they are all companies, all have websites, all are in the country you sell in.
//
// Commonality is not evidence. The tests that matter here are the ones where it declines.
import test from "node:test";
import assert from "node:assert/strict";
import lookalike, { type ProvenPattern } from "../../workflows/lookalike.mjs";

/** What `win_patterns` hands back once there is enough book to judge. */
const PATTERNS: ProvenPattern[] = [
  { attribute: "industry", value: "bakery", n: 40, wins: 12, win_rate: "30.0%", confidence_floor: 0.18, lift: 2.4 },
  { attribute: "city", value: "bristol", n: 30, wins: 7, win_rate: "23.3%", confidence_floor: 0.12, lift: 1.9 },
  { attribute: "size", value: "under 20", n: 55, wins: 9, win_rate: "16.4%", confidence_floor: 0.09, lift: 1.3 },
];

const CANDIDATES = [
  { name: "Hart's Bakery", domain: "harts.co.uk", industry: "bakery", city: "bristol", size: "under 20" },
  { name: "Clifton Loaf", domain: "cliftonloaf.co.uk", industry: "bakery", city: "bath" },
  { name: "Bristol Print Co", domain: "bpc.co.uk", industry: "printing", city: "bristol" },
  { name: "Vale Dental", domain: "vale.co.uk", industry: "dentistry", city: "cardiff" },
];

test("it ranks on what won, and puts the evidence on the row", () => {
  const r = lookalike({ patterns: PATTERNS, candidates: CANDIDATES });
  assert.equal(r.ready, true);
  assert.equal(r.ranked[0]!.name, "Hart's Bakery");
  // The evidence travels WITH the row. A ranked list nobody can argue with is a ranked list nobody
  // acts on, and a founder cannot argue with a number they were not shown.
  assert.match(r.ranked[0]!.why, /bakery \(industry\) has won 30\.0% across 40 leads/);
  assert.equal(r.ranked[0]!.matched.length, 3);

  // A candidate matching nothing proven is absent, not present with a zero. A row scored zero reads
  // as "we considered them and they are bad"; they were simply never evidence of anything.
  assert.equal(r.ranked.some((x) => x.name === "Vale Dental"), false);
});

test("matches do NOT compound, and that is the whole ranking decision", () => {
  // Hart's matches three patterns; Clifton matches one — the same strongest one. Multiplying lifts
  // would put Hart's at 2.4 × 1.9 × 1.3, a number measured over overlapping populations ("bristol"
  // and "under 20" are the same accounts twice) and the most confident-looking thing on the page.
  //
  // So both score on the SAME strongest pattern, and the extra matches only break the tie.
  const r = lookalike({ patterns: PATTERNS, candidates: CANDIDATES });
  const harts = r.ranked.find((x) => x.name === "Hart's Bakery")!;
  const clifton = r.ranked.find((x) => x.name === "Clifton Loaf")!;
  assert.equal(harts.score, clifton.score, "both matched `bakery`, so both score the bakery floor");
  assert.equal(harts.score, 0.18);
  assert.ok(r.ranked.indexOf(harts) < r.ranked.indexOf(clifton), "more matches breaks the tie");
});

test("no proven pattern is a refusal, not a ranking on nothing", () => {
  // THE COMMON CASE EARLY ON. A founder six weeks in has no patterns and `win_patterns` says so.
  // Ranking anyway means ranking on a guess, presented in the same shape as a real answer — which is
  // how the fourth thing a tool tells you stops being believed.
  const r = lookalike({ patterns: [], candidates: CANDIDATES });
  assert.equal(r.ready, false);
  assert.deepEqual(r.ranked, []);
  assert.match(r.why_not!, /more closed deals, not more leads/);

  // And an UNPROVEN segment must not sneak in through the same door. `win_patterns` quarantines
  // these deliberately; accepting one here would launder exactly the noise it went to the trouble of
  // separating, and it would do it invisibly.
  const unproven = [{ attribute: "industry", value: "bakery", n: 4, wins: 1, win_rate: "25.0%", lift: null }];
  const r2 = lookalike({ patterns: unproven as unknown as ProvenPattern[], candidates: CANDIDATES });
  assert.equal(r2.ready, false, "no confidence floor means it was never judged");
});

test("nobody already in the pipeline is offered as a fresh prospect", () => {
  // Ranking somebody you are mid-conversation with is how a founder opens a second thread with the
  // same person — and the person on the other end reads that as nobody paying attention.
  const r = lookalike({ patterns: PATTERNS, candidates: CANDIDATES, exclude: ["harts.co.uk"] });
  assert.equal(r.ranked.some((x) => x.name === "Hart's Bakery"), false);
  // Named rather than silently dropped, so a founder wondering where their best match went can see.
  assert.equal(r.skipped![0]!.why, "already in your pipeline");
  // Matching is case- and whitespace-insensitive, or the exclusion misses and the point is lost.
  assert.equal(lookalike({ patterns: PATTERNS, candidates: CANDIDATES, exclude: ["  HARTS.CO.UK "] }).ranked.some((x) => x.name === "Hart's Bakery"), false);
});

test("an attribute a candidate does not carry is not held against them", () => {
  // Absence of evidence. A prospect with no `size` recorded has not failed the size pattern — we
  // simply do not know, and scoring them down for our own missing data would rank the completeness
  // of our enrichment rather than the quality of the lead.
  const thin = [{ name: "Unknown Bakery", industry: "bakery" }];
  const r = lookalike({ patterns: PATTERNS, candidates: thin });
  assert.equal(r.ranked[0]!.score, 0.18, "scores on the pattern it does match");
  assert.equal(r.ranked[0]!.matched.length, 1);
});

test("nothing matching is a real answer, and the truncation is named", () => {
  const none = lookalike({ patterns: PATTERNS, candidates: [{ name: "Vale Dental", industry: "dentistry" }] });
  assert.equal(none.ready, true);
  assert.deepEqual(none.ranked, []);
  assert.match(none.headline!, /a list of near-misses would be worse than an empty one/);

  // A cap that silently drops rows reads as complete coverage — the failure this repo has paid for
  // three times. Say how many are behind it.
  const many = Array.from({ length: 40 }, (_, i) => ({ name: `Bakery ${String(i).padStart(2, "0")}`, industry: "bakery" }));
  const capped = lookalike({ patterns: PATTERNS, candidates: many, limit: 10 });
  assert.equal(capped.ranked.length, 10);
  assert.equal(capped.not_shown, 30);

  assert.throws(() => lookalike({ patterns: PATTERNS, candidates: [] }), /must not be empty/);
});

test("it says what it ranked on, so a founder can disagree with the criteria", () => {
  const r = lookalike({ patterns: PATTERNS, candidates: CANDIDATES });
  assert.equal(r.matched_on![0], "bakery (industry) — 30.0% of 40");
  assert.match(r.headline!, /look like the clients you have actually won/);
  // Same inputs, same answer — a founder re-reading this tomorrow sees the same list.
  assert.deepEqual(lookalike({ patterns: PATTERNS, candidates: CANDIDATES }), r);
});
