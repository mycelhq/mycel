// The A/B verdict — the last link in the evidence loop, and the one that can do damage.
//
// Everything else in `insight/` either records a number or reports one. This decides, and what it
// decides is whether an agent rewrites a paying client's homepage. So the tests below are mostly
// tests that it REFUSES: an under-powered sample, a thin cell, a real-but-trivial gap, a conversion
// with no exposure behind it. A false "no winner" costs a week of waiting. A false "winner" costs a
// client's front door, twice — once when it is rewritten and again when the next rewrite reverts it.
//
// The isolation note from `insight.test.ts` applies here too: the domain store is a process
// singleton, so every test that asserts a total mints a fresh project id.
import { test } from "node:test";
import assert from "node:assert/strict";
import { freshProjectId, makeApp } from "./helpers";
import { getDomainStore } from "../src/domain";
import { ingestKeyFor } from "../src/insight/keys";
import { normaliseBatch } from "../src/insight/schema";
import { storeBatch } from "../src/insight/store";
import { buildSummary } from "../src/insight/summary";
import {
  CONVERSION_METRIC,
  CONVERT_PREFIX,
  EXPOSURE_PREFIX,
  MIN_CELL,
  MIN_EXPOSURES_PER_ARM,
  analyseExperiment,
  armsFrom,
} from "../src/insight/experiment";

/** An arm's counts, as they arrive: event names in a rolled-up window. */
const names = (arms: Record<string, { exposed: number; converted: number }>): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const [arm, v] of Object.entries(arms)) {
    out[EXPOSURE_PREFIX + arm] = v.exposed;
    out[CONVERT_PREFIX + arm] = v.converted;
  }
  return out;
};

const verdict = (arms: Record<string, { exposed: number; converted: number }>) =>
  analyseExperiment(names(arms), CONVERSION_METRIC)!;

/**
 * Put real rows in the store for one project.
 *
 * One `storeBatch` per call rather than N posts through the HTTP route: the route caps a batch at 50
 * events and rate-limits a project to 600 batches a minute, both of which are correct for the public
 * write path and neither of which has anything to teach us about the maths. The tests that DO care
 * about the write path go through `app.request` — see the tenancy test at the bottom.
 */
async function seed(projectId: string, arms: Record<string, { exposed: number; converted: number }>) {
  const events: Array<{ name: string }> = [];
  for (const [arm, v] of Object.entries(arms)) {
    for (let i = 0; i < v.exposed; i++) events.push({ name: EXPOSURE_PREFIX + arm }, { name: "$session" });
    for (let i = 0; i < v.converted; i++) events.push({ name: CONVERT_PREFIX + arm });
  }
  await storeBatch(getDomainStore(), projectId, { events });
}

// ── refusal ───────────────────────────────────────────────────────────────────────────────────

test("an under-powered sample yields no winner, and says how much more it needs", () => {
  // THE BUG THIS PREVENTS: three visitors, two of whom clicked one arm and one the other, read as a
  // 2:1 win. An agent that acts on this rewrites the page, watches noise move, rewrites it back, and
  // thrashes a client's site forever — each iteration justified by evidence that was never there.
  const v = verdict({ control: { exposed: 2, converted: 2 }, outcome: { exposed: 1, converted: 0 } });
  assert.equal(v.winner, null);
  assert.equal(v.loser, null);
  assert.equal(v.exposures_needed, MIN_EXPOSURES_PER_ARM - 1, "the thinnest arm is what has to catch up");
  assert.match(v.verdict, /Too little traffic/);
  // "Wait" and "no effect" are different instructions and the verdict must distinguish them, or an
  // agent will abandon a promising test at 3 visitors and keep waiting on one that will never move.
  assert.match(v.verdict, /Do not change the page/);

  // The arms are still REPORTED. Refusing to conclude is not refusing to say what was seen.
  assert.equal(v.arms.length, 2);
  assert.equal(v.arms[0]?.conversion_rate, 1);
});

test("a huge-looking gap at the exposure floor is still refused when a cell is empty", () => {
  // 200 exposures each clears the traffic floor, and 3 conversions against 1 looks like a 3× lift.
  // The normal approximation the z-test rests on is nowhere near valid at those counts, and it would
  // happily return a number anyway. This is the guard that stops a plausible-looking statistic being
  // computed on data that cannot support one.
  const v = verdict({ control: { exposed: 200, converted: 3 }, outcome: { exposed: 200, converted: 1 } });
  assert.equal(v.winner, null);
  assert.equal(v.exposures_needed, 0, "traffic was not the problem");
  assert.match(v.verdict, new RegExp(`Fewer than ${MIN_CELL}`));
});

test("a difference that is real but trivial does not justify rewriting a client's page", () => {
  // 60,000 exposures an arm and 10.0% vs 10.5%: z ≈ 2.9, comfortably significant, and worth nothing.
  // Significance is a claim that a difference is REAL, never that it is WORTH ANYTHING, and at large
  // enough n every difference becomes significant. Without this branch a mature site would rewrite
  // its homepage every week to chase half a percent.
  const v = verdict({
    control: { exposed: 60_000, converted: 6_000 },
    outcome: { exposed: 60_000, converted: 6_300 },
  });
  assert.equal(v.winner, null);
  assert.ok((v.confidence ?? 0) > 0.99, "the test did fire — this is not a power failure");
  assert.equal(v.relative_lift, 0.05);
  assert.match(v.verdict, /test a bigger idea/);
});

test("a plausible lift that has not separated from noise is refused, not rounded up", () => {
  // 10% vs 12% on 500 an arm — the shape of nearly every real A/B result. z ≈ 1.0.
  const v = verdict({ control: { exposed: 500, converted: 50 }, outcome: { exposed: 500, converted: 60 } });
  assert.equal(v.winner, null);
  assert.ok((v.confidence ?? 1) < 0.9);
  assert.match(v.verdict, /within noise/);
  assert.match(v.verdict, /Do not change the page/);
});

test("one arm alone is a broken split, not a landslide", () => {
  // THE BUG THIS PREVENTS: a `pickVariant` that stopped rolling, or an arm removed from `VARIANTS`
  // mid-test. Every visitor lands in one arm, that arm has a 100% share, and a naive "which arm has
  // the most conversions" would declare it the winner of a race it ran alone.
  const v = verdict({ control: { exposed: 5_000, converted: 900 } });
  assert.equal(v.winner, null);
  assert.match(v.verdict, /nothing to compare/);
  assert.match(v.verdict, /splitting traffic/);
});

test("a conversion with no exposure behind it cannot produce a rate above 100%", () => {
  // Exposures are the denominator. A replayed or hand-crafted batch could carry conversions for an
  // arm nobody was shown, and an unclamped rate of 300% is not a surprising finding — it is a broken
  // one, and a model handed it will write a task celebrating it.
  const [arm] = armsFrom({ [`${CONVERT_PREFIX}ghost`]: 30, [`${EXPOSURE_PREFIX}ghost`]: 10 });
  assert.equal(arm?.conversions, 10);
  assert.equal(arm?.conversion_rate, 1);
});

// ── the call, when the evidence is there ──────────────────────────────────────────────────────

test("a large, real difference names the winner AND the loser to rewrite", () => {
  const v = verdict({
    control: { exposed: 1_000, converted: 100 },
    outcome: { exposed: 1_000, converted: 150 },
  });
  assert.equal(v.winner, "outcome");
  assert.equal(v.loser, "control", "an agent needs to be told which arm to REPLACE, not just which won");
  assert.ok((v.confidence ?? 0) >= 0.99);
  assert.equal(v.relative_lift, 0.5);
  // The instruction has to name the file and forbid the obvious wrong move — deleting the loser,
  // which would end the experiment and leave nothing to measure the next change against.
  assert.match(v.verdict, /content\/marketing\.ts/);
  assert.match(v.verdict, /do not delete the arm/i);
});

test("the exposure floor blocks small samples without blocking genuinely large effects", () => {
  // Exactly at the floor, with an effect big enough to survive it. If this ever starts failing, the
  // floor has quietly become the decision rather than the precondition for one.
  const v = verdict({ control: { exposed: 200, converted: 20 }, outcome: { exposed: 200, converted: 50 } });
  assert.equal(v.winner, "outcome");
  assert.equal(v.exposures_needed, 0);
});

// ── the summary, which is what an agent actually reads ────────────────────────────────────────

test("the summary says which arm won, what a conversion is, and what to do", async () => {
  const projectId = freshProjectId("exp");
  await seed(projectId, { control: { exposed: 400, converted: 40 }, outcome: { exposed: 400, converted: 90 } });

  const s = await buildSummary(getDomainStore(), projectId, { days: 7 });
  assert.equal(s.experiment?.winner, "outcome");
  assert.equal(s.experiment?.loser, "control");
  // A rate whose definition is implicit is a rate that will be misread. It travels with the number.
  assert.equal(s.experiment?.metric, CONVERSION_METRIC);
  assert.match(s.experiment!.metric, /client portal/);

  // The two pre-decided fields are the ones a model reads first, and a decided experiment has to
  // reach both — a verdict buried in a nested object is a verdict that gets skipped.
  assert.match(s.attention ?? "", /"outcome" wins/);
  assert.match(s.headline, /"outcome" wins/);

  // The arm counters must NOT appear as week-over-week event deltas. That comparison is between this
  // week and last week, which is the wrong comparison for an experiment — the right one is between
  // arms over the same traffic — and reporting both would let a model act on whichever it read first.
  for (const d of s.changes) assert.ok(!d.metric.includes("$exposure"), `arm counter leaked into changes: ${d.metric}`);
});

test("a product that runs no experiment gets no experiment section", async () => {
  const projectId = freshProjectId("exp-none");
  await storeBatch(getDomainStore(), projectId, { events: [{ name: "signed_up" }] });
  const s = await buildSummary(getDomainStore(), projectId, { days: 7 });
  assert.equal(s.experiment, null, "an absent experiment must be null, never an empty verdict");
  assert.equal(s.headline.includes("wins"), false);
});

// ── tenancy, end to end over the real write path ──────────────────────────────────────────────

test("arm events cannot be attributed to another project, whatever the body says", async () => {
  // THE BUG THIS PREVENTS, and the reason it is worth a test of its own here rather than trusting
  // the one in insight.test.ts: an experiment result is ACTED ON. A batch that lands in the wrong
  // project does not merely corrupt a chart — it makes an agent rewrite a stranger's homepage on the
  // strength of a stranger's visitors. Two cross-tenant leaks have already shipped in this codebase.
  const { app } = makeApp();
  const mine = freshProjectId("exp-mine");
  const victim = freshProjectId("exp-victim");

  const res = await app.request("/v1/insight/events", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ingestKeyFor(mine)}` },
    body: JSON.stringify({
      v: 1,
      // Every spelling of "put this somewhere else" the endpoint might have been tempted to read.
      project_id: victim,
      projectId: victim,
      project: victim,
      events: [{ n: `${EXPOSURE_PREFIX}outcome`, t: Date.now() }, { n: "$session", t: Date.now() }],
    }),
  });
  assert.equal(res.status, 204);

  const theirs = await buildSummary(getDomainStore(), victim, { days: 7 });
  assert.equal(theirs.experiment, null, "the named project must have seen nothing at all");
  assert.equal(theirs.totals.events, 0);

  const ours = await buildSummary(getDomainStore(), mine, { days: 7 });
  assert.equal(ours.experiment?.arms[0]?.arm, "outcome", "it landed in the project the SIGNATURE names");
});

test("an event name is redacted before it can become an arm", () => {
  // Arms are carried in the event NAME, so the name is an attacker-chosen string that ends up as a
  // key in a stored document and in a sentence handed to a model. `normaliseBatch` is what stands
  // between those two facts.
  const r = normaliseBatch({
    v: 1,
    events: [{ n: `${EXPOSURE_PREFIX}Out Come<script>` }],
  });
  assert.ok(r.ok);
  assert.equal(r.batch.events[0]?.name, "$exposure:out_come_script");
  const [arm] = armsFrom({ [r.batch.events[0]!.name]: 1 });
  assert.equal(arm?.arm, "out_come_script", "whatever survives is inert");
});
