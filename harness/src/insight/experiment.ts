// The A/B verdict: which arm of a marketing experiment won, and whether that means anything.
//
// ── Why this is in the kernel and not in the product ──
//
// The product that runs the experiment is generated code. If it computed its own verdict it would
// compute a different one every time it was regenerated, and the agent reading the result would be
// reading a number produced by the same process that is about to act on it. The arithmetic that
// decides "rewrite this headline" belongs on the side that neither wrote the page nor will rewrite
// it.
//
// ── The failure this file exists to prevent ──
//
// The loop it closes is: assign an arm → count exposures and conversions → agent reads the summary
// → agent rewrites the losing arm. Every part of that is cheap except the decision, and a wrong
// decision is not merely useless — it is actively destructive, because the agent will REWRITE A
// CLIENT'S HOMEPAGE on the strength of it. Three visitors split 2:1 is a coin landing heads twice.
// An agent that treats that as a result will rewrite the winning page, watch the numbers move
// (they were noise, so they move), rewrite it back, and thrash a paying client's front door
// forever, each iteration justified by evidence that was never there.
//
// So the default answer is NO WINNER, and everything below is the set of conditions that have to be
// met before this file is willing to say otherwise.
//
// ── The wire convention ──
//
// Arms arrive encoded in the EVENT NAME, not in props: `countBatch` stores name/path/step counts
// and drops props at the boundary (see `store.ts`), which is deliberate — props are where PII would
// hide. So the product emits `$exposure:<arm>` and `$convert:<arm>`. The `$` prefix marks them
// reserved, the same way `$pageview` and `$session` are, so a founder's own `track("convert")` can
// never be mistaken for an experiment reading.

/** Reserved event-name prefixes. Mirrored in `business-template/lib/insight.ts`. */
export const EXPOSURE_PREFIX = "$exposure:";
export const CONVERT_PREFIX = "$convert:";

/**
 * WHAT A CONVERSION IS, said out loud and carried into the summary.
 *
 * This string is in the payload the agent reads because a conversion rate whose definition is
 * implicit is a number that will be misread. It is not "a sale" — the generated marketing page
 * cannot observe a sale, and pretending otherwise would put a fictional business metric in front of
 * a model. It is the ONE action the page actually asks a stranger to take.
 *
 * The template's `/` has exactly one call to action, twice: `PortalCta` → `/portal`. So a
 * conversion is "a visitor who was shown an arm, and then went to the client portal, in the same
 * browser, without already having a portal session". Each clause earns its place:
 *
 *   - *shown an arm* — an exposure with no possible paired conversion proves nothing, so the
 *     denominator is only visitors who could have converted.
 *   - *without already having a portal session* — an existing client opening their account is not
 *     the marketing page working. Including them would make the rate a measure of how many
 *     customers the founder already has, and every arm would look identical.
 *   - *in the same browser* — the pairing is the whole experiment. Nothing else joins the two
 *     events, and nothing per-visitor is stored to do it with: the pairing happens in the visitor's
 *     own cookie before either event is sent, and what the kernel receives is already anonymous.
 *
 * The honest weakness, stated so nobody has to rediscover it: this measures INTENT, not revenue. A
 * headline that gets more people to click "Open the client portal" is not certainly a headline that
 * wins more business. It is the strongest signal a page with no checkout on it can produce, and it
 * is a real one — but an arm that wins here has won a proxy.
 */
export const CONVERSION_METRIC = "reached the client portal after seeing the marketing page";

/**
 * Exposures required in EVERY arm before a verdict is even attempted.
 *
 * This is not a power calculation — the z-test below is what actually decides — it is a floor
 * beneath which the test itself is invalid or absurd. Two things sit under it: the normal
 * approximation needs a handful of observations in each cell to mean anything, and a founder
 * watching their site get rewritten wants to be able to say "on how many visitors?" and hear a
 * number that does not embarrass them.
 *
 * 200 is deliberately low enough that it is NOT doing the work. At 200 per arm and a 10% baseline,
 * a 50% relative lift (10% → 15%) produces z ≈ 1.5 and is correctly refused; only something like
 * 10% → 20% clears the bar. That is the intended behaviour: at low volume, only an enormous effect
 * gets called, and everything else waits.
 */
export const MIN_EXPOSURES_PER_ARM = 200;

/**
 * Minimum successes AND failures per arm. The textbook validity condition for the normal
 * approximation to the binomial. Without it, an arm with 200 exposures and 1 conversion produces a
 * confident-looking z from a distribution that is nothing like normal.
 */
export const MIN_CELL = 5;

/**
 * |z| required. 2.576 is α = 0.01 two-sided, not the conventional 1.96.
 *
 * The stricter bar is a correction for two things this test does that a textbook one does not.
 *
 * **Peeking.** There is no fixed sample size and no end date. The agent reads this summary whenever
 * it happens to run, and a nominally-5% test evaluated repeatedly as data arrives rejects the null
 * far more often than 5% of the time — with daily looks over a few weeks, closer to a quarter of
 * the time. The rigorous fix is an always-valid sequential test (mixture SPRT, alpha spending);
 * that is real machinery, and at the traffic a small business's marketing page sees it would spend
 * more complexity than the decision is worth. Tightening α and holding a hard exposure floor is the
 * blunt version of the same idea, and it is honest about being blunt.
 *
 * **Multiple arms.** With more than two arms the comparison below is best-versus-runner-up, which
 * is a maximum over comparisons and therefore biased toward finding a difference. α = 0.01 absorbs
 * a couple of extra arms; a product with eight arms and this rule is under-corrected, which is
 * noted rather than solved because `VARIANTS` in the template has two entries and adding a third is
 * already an unusual act.
 */
export const Z_THRESHOLD = 2.576;

/**
 * The winner must also beat the runner-up by this much, RELATIVELY.
 *
 * Statistical significance is a statement about whether a difference is real, not about whether it
 * is worth anything. With enough traffic a 0.4% relative improvement becomes significant, and
 * "rewrite the client's headline because the new one converts 0.4% better" is a change with a real
 * cost (a deploy, a diff a human has to trust, a page that stops being the one the founder
 * approved) bought for nothing. 10% is the smallest lift anyone would defend in a sentence.
 */
export const MIN_RELATIVE_LIFT = 0.1;

export interface ExperimentArm {
  arm: string;
  exposures: number;
  conversions: number;
  /** `conversions / exposures`, 0..1, 4dp. 0 rather than NaN when nobody was exposed. */
  conversion_rate: number;
}

export interface ExperimentReport {
  /** What a conversion IS here, stated rather than assumed. Quoted back by the agent in its task. */
  metric: string;
  arms: ExperimentArm[];
  /** The arm to keep, or null. NULL IS THE DEFAULT AND THE COMMON CASE. */
  winner: string | null;
  /** The arm to rewrite. Only ever set alongside `winner`. */
  loser: string | null;
  /** `1 - p` for the best-vs-runner-up two-proportion test, or null when it was not computed. */
  confidence: number | null;
  /** Relative lift of the best arm over the runner-up. Null with fewer than two arms. */
  relative_lift: number | null;
  /** Exposures still needed in the thinnest arm before a verdict is even attempted. */
  exposures_needed: number;
  /** One sentence. When there is no winner it says WHY, because "wait" and "no effect" differ. */
  verdict: string;
}

/** Division that yields 0 rather than NaN, 4dp so JSON diffs stay stable. Same rule as `funnel.ts`. */
function rate(n: number, d: number): number {
  if (!d || d <= 0) return 0;
  return Math.round((n / d) * 10_000) / 10_000;
}

/**
 * Standard normal CDF, via Abramowitz & Stegun 7.1.26 (|ε| < 1.5e-7).
 *
 * Written out rather than pulled from a dependency because this is the only statistics in the
 * kernel and a package for one function is a supply-chain decision made for convenience. The error
 * bound matters only for the reported `confidence`; the decision itself is a comparison against a
 * constant, where 1.5e-7 cannot change the answer.
 */
function normalCdf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-z * z);
  return 0.5 * (1 + sign * y);
}

/**
 * Two-proportion z, pooled. Returns null when the standard error is not defined — an arm with no
 * exposures, or two arms whose pooled rate is 0 or 1 (nobody converted anywhere, or everybody did),
 * where the difference is exactly zero and there is nothing to test.
 */
export function twoProportionZ(c1: number, n1: number, c2: number, n2: number): number | null {
  if (n1 <= 0 || n2 <= 0) return null;
  const pooled = (c1 + c2) / (n1 + n2);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  if (!Number.isFinite(se) || se <= 0) return null;
  return (c1 / n1 - c2 / n2) / se;
}

/**
 * Pull the arms out of a window's event-name counts.
 *
 * An arm appears if it was EXPOSED. A `$convert:` with no matching `$exposure:` is a conversion for
 * an arm nobody saw, which can only come from a replayed or hand-crafted batch — the arm is created
 * with zero exposures so the count is visible rather than silently dropped, and the exposure floor
 * then refuses to draw a conclusion from it.
 */
export function armsFrom(names: Record<string, number>): ExperimentArm[] {
  const seen = new Map<string, { exposures: number; conversions: number }>();
  const at = (arm: string) => {
    let row = seen.get(arm);
    if (!row) seen.set(arm, (row = { exposures: 0, conversions: 0 }));
    return row;
  };
  for (const [name, raw] of Object.entries(names)) {
    const count = typeof raw === "number" && Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
    if (name.startsWith(EXPOSURE_PREFIX)) {
      const arm = name.slice(EXPOSURE_PREFIX.length);
      if (arm) at(arm).exposures += count;
    } else if (name.startsWith(CONVERT_PREFIX)) {
      const arm = name.slice(CONVERT_PREFIX.length);
      if (arm) at(arm).conversions += count;
    }
  }
  return [...seen.entries()]
    .map(([arm, v]) => ({
      arm,
      exposures: v.exposures,
      // Clamped for the same reason `analyseFunnel` clamps its steps monotonic: more conversions
      // than exposures is a rate above 100%, which is not a surprising finding but a broken one, and
      // an agent handed "converts at 140%" will write a task celebrating it. The product dedupes
      // both sides per browser so this should be unreachable; "should be unreachable" is exactly the
      // condition worth clamping, because the input arrives over the network.
      conversions: Math.min(v.conversions, v.exposures),
      conversion_rate: rate(Math.min(v.conversions, v.exposures), v.exposures),
    }))
    .sort((a, b) => b.conversion_rate - a.conversion_rate || b.exposures - a.exposures || a.arm.localeCompare(b.arm));
}

/**
 * The verdict.
 *
 * Every branch that returns no winner says which condition failed, and the distinction is the point:
 * "not enough traffic yet, come back at N" is an instruction to WAIT, while "the arms are within
 * noise of each other" is an instruction to STOP TESTING THIS and try a different hypothesis. An
 * agent given only `winner: null` cannot tell those apart and will do the wrong one.
 */
export function analyseExperiment(names: Record<string, number>, metric: string): ExperimentReport | null {
  const arms = armsFrom(names);
  if (arms.length === 0) return null;

  const base: Omit<ExperimentReport, "verdict"> = {
    metric,
    arms,
    winner: null,
    loser: null,
    confidence: null,
    relative_lift: null,
    exposures_needed: Math.max(0, MIN_EXPOSURES_PER_ARM - Math.min(...arms.map((a) => a.exposures))),
  };

  if (arms.length < 2) {
    return {
      ...base,
      verdict: `Only one arm ("${arms[0]!.arm}") has been exposed, so there is nothing to compare. Check that the variant assignment is actually splitting traffic.`,
    };
  }

  const best = arms[0]!;
  const rest = arms[1]!;
  const lift = rest.conversion_rate > 0 ? Math.round(((best.conversion_rate - rest.conversion_rate) / rest.conversion_rate) * 1000) / 1000 : null;
  const withLift = { ...base, relative_lift: lift };

  if (base.exposures_needed > 0) {
    const thinnest = arms.reduce((a, b) => (a.exposures <= b.exposures ? a : b));
    return {
      ...withLift,
      verdict: `Too little traffic to call: "${thinnest.arm}" has ${thinnest.exposures} exposures and needs at least ${MIN_EXPOSURES_PER_ARM}. Do not change the page on this. Come back after roughly ${base.exposures_needed} more visitors.`,
    };
  }

  const undersized = arms.find(
    (a) => a.conversions < MIN_CELL || a.exposures - a.conversions < MIN_CELL,
  );
  if (undersized) {
    return {
      ...withLift,
      verdict: `Not enough outcomes to test: "${undersized.arm}" has ${undersized.conversions} conversion(s) out of ${undersized.exposures}. Fewer than ${MIN_CELL} in either cell and the maths is not valid. Do not change the page on this.`,
    };
  }

  const z = twoProportionZ(best.conversions, best.exposures, rest.conversions, rest.exposures);
  if (z === null) {
    return { ...withLift, verdict: "No measurable difference between the arms — every arm converted identically. Do not change the page on this." };
  }
  const confidence = Math.round((1 - 2 * (1 - normalCdf(Math.abs(z)))) * 1000) / 1000;
  const decided = { ...withLift, confidence };

  if (Math.abs(z) < Z_THRESHOLD) {
    return {
      ...decided,
      verdict: `"${best.arm}" leads "${rest.arm}" (${pct(best.conversion_rate)} vs ${pct(rest.conversion_rate)}) but the gap is within noise at ${Math.round(confidence * 100)}% confidence, below the ${Math.round((1 - 0.01) * 100)}% this needs. Do not change the page on this — either wait for more traffic or test a bolder difference.`,
    };
  }
  if (lift !== null && lift < MIN_RELATIVE_LIFT) {
    return {
      ...decided,
      verdict: `"${best.arm}" beats "${rest.arm}" reliably but only by ${Math.round(lift * 100)}%, under the ${Math.round(MIN_RELATIVE_LIFT * 100)}% that would justify rewriting a client's page. Leave it alone and test a bigger idea.`,
    };
  }

  return {
    ...decided,
    winner: best.arm,
    loser: rest.arm,
    verdict: `"${best.arm}" wins on ${metric}: ${pct(best.conversion_rate)} vs ${pct(rest.conversion_rate)} for "${rest.arm}" over ${best.exposures} and ${rest.exposures} exposures (${Math.round(confidence * 100)}% confidence). Rewrite the "${rest.arm}" hero in content/marketing.ts as a new attempt to beat "${best.arm}" — do not delete the arm.`,
  };
}

function pct(n: number): string {
  return `${Math.round(n * 1000) / 10}%`;
}
