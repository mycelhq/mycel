// What the won deals had in common — and, much harder, whether it is a pattern or noise.
//
// "Look at our wins and tell me what worked" is the most inviting question to hand a model and the
// worst. Given twelve leads and two wins it WILL find a pattern, because that is what it does, and
// it will say so in confident prose. The founder then aims a quarter of outbound at a coincidence.
//
// Every test here is about the tool refusing to answer.
import test from "node:test";
import assert from "node:assert/strict";
import winPatterns from "../../workflows/win-patterns.mjs";

const mk = (stage: string, industry: string, source: string, n = 1) =>
  Array.from({ length: n }, () => ({ stage, attributes: { industry, source } }));

/** 40 leads, 6 wins. Bakeries doing well, agencies not, cafes and restaurants too few to judge. */
const PIPELINE = [
  ...mk("won", "bakery", "dork", 5),
  ...mk("replied", "bakery", "dork", 4),
  ...mk("invited", "bakery", "dork", 6),
  ...mk("won", "agency", "linkedin", 1),
  ...mk("invited", "agency", "linkedin", 14),
  ...mk("invited", "restaurant", "dork", 3),
  ...mk("met", "cafe", "dork", 2),
  ...mk("invited", "cafe", "dork", 5),
];

test("it says NOT YET, and says why, rather than finding a pattern in nothing", () => {
  // A founder told "you need eleven more leads before this means anything" knows what to do. One
  // handed an empty list assumes the tool is broken and stops opening it.
  const early = winPatterns({ leads: PIPELINE.slice(0, 10) });
  assert.equal(early.ready, false);
  assert.deepEqual(early.patterns, []);
  assert.match(early.why_not!, /at least 30/);

  // Leads but no wins is a different sentence from not enough leads.
  const noWins = winPatterns({ leads: mk("invited", "bakery", "dork", 40) });
  assert.equal(noWins.ready, false);
  assert.match(noWins.why_not!, /Nothing has been won yet/);
});

test("a segment too small to read is NAMED, not dropped", () => {
  // A founder who cannot see that "restaurant" exists assumes it was never tried. One who reads
  // "restaurant — 3 leads, too few" knows the question is open and how to close it.
  const r = winPatterns({ leads: PIPELINE });
  const restaurant = r.unproven.find((u: { value: string }) => u.value === "restaurant");
  assert.ok(restaurant, "an untested segment is an open question, not an absence");
  assert.match(restaurant!.why!, /too few to read/);
  assert.equal(r.patterns.some((p: { value: string }) => p.value === "restaurant"), false);
});

test("no wins yet is 'weak evidence', never '0% — avoid'", () => {
  // Ten touches and no reply is weak evidence; nine hundred is strong. A table rendering both as 0%
  // invites a founder to abandon a market on ten touches.
  const leads = [...mk("won", "bakery", "dork", 6), ...mk("invited", "bakery", "dork", 14), ...mk("invited", "hotel", "dork", 12)];
  const r = winPatterns({ leads });
  const hotel = r.unproven.find((u: { value: string }) => u.value === "hotel");
  assert.ok(hotel);
  assert.match(hotel!.why!, /weak evidence, not a verdict/);
  assert.equal(hotel!.n, 12);
});

test("ranking is by confidence floor, so four-from-four does not beat ninety-from-a-hundred", () => {
  // A plain rate ranks a tiny perfect segment first, which is exactly backwards for deciding where
  // to spend next month.
  const leads = [
    ...mk("won", "tiny", "a", 8),
    ...mk("won", "big", "b", 40),
    ...mk("invited", "big", "b", 60),
  ];
  const r = winPatterns({ leads, min_sample: 8 });
  const industries = r.patterns.filter((p: { attribute: string }) => p.attribute === "industry");
  // `tiny` is 8/8 = 100%; `big` is 40/100 = 40%. The floor puts the better-evidenced one in contention.
  assert.equal(industries[0]!.value, "tiny");
  assert.ok(industries[0]!.confidence_floor > industries[1]!.confidence_floor);
  // But the smaller one is penalised by its own smallness rather than being taken at face value.
  assert.ok(industries[0]!.confidence_floor < 1, "a perfect rate on 8 leads is not certainty");
});

test("lift is against the base rate, not against the worst thing tried", () => {
  const r = winPatterns({ leads: PIPELINE });
  const bakery = r.patterns.find((p: { value: string }) => p.value === "bakery")!;
  // 5/15 = 33.3% against a 6/40 = 15% base.
  assert.equal(bakery.win_rate, "33.3%");
  assert.equal(r.base.win_rate, "15.0%");
  assert.equal(bakery.lift, 2.22);
});

test("the headline refuses unless the lead is real", () => {
  const strong = winPatterns({ leads: PIPELINE });
  assert.match(strong.headline!, /bakery/);
  assert.match(strong.headline!, /across 15 leads/, "it says how much evidence it has");

  // A flat pipeline gets no advice. "Do more of X" from a 1.05x lift is how a tool loses its
  // credibility permanently.
  const flat = [
    ...mk("won", "a", "s", 5), ...mk("invited", "a", "s", 15),
    ...mk("won", "b", "s", 5), ...mk("invited", "b", "s", 15),
  ];
  assert.match(winPatterns({ leads: flat }).headline!, /Nothing here is worth changing the plan for/);
});

test("it splits on whatever the leads carry, not a fixed list of keys", () => {
  // A trade nobody anticipated splits on something nobody listed, and a hardcoded key list is how
  // this only ever works for the one wedge it was written against.
  const leads = [
    ...Array.from({ length: 10 }, () => ({ stage: "won", attributes: { roof_type: "flat", county: "avon" } })),
    ...Array.from({ length: 30 }, () => ({ stage: "invited", attributes: { roof_type: "pitched", county: "avon" } })),
  ];
  const r = winPatterns({ leads });
  assert.ok(r.patterns.some((p: { attribute: string }) => p.attribute === "roof_type"));
});

test("`met` is not a win, because most deals die between the meeting and the money", () => {
  const leads = [...mk("met", "bakery", "dork", 20), ...mk("invited", "bakery", "dork", 20)];
  const r = winPatterns({ leads });
  assert.equal(r.ready, false, "twenty meetings and no money is not a pattern of winning");
  assert.equal(r.wins, 0);
  assert.equal(r.engaged, 20, "but they did engage, and that is counted separately");
});

test("an empty pipeline is refused rather than divided by zero", () => {
  assert.throws(() => winPatterns({ leads: [] }), /must not be empty/);
});
