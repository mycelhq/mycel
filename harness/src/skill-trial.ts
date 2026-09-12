// PUTTING A PROPOSED SKILL ON TRIAL — the gate between "a model suggested a rewrite" and "every run
// now follows it".
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// WHY A TRIAL AND NOT A SEARCH
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// The obvious way to improve prompts is DSPy's: define a metric, run the program hundreds of times
// under different instructions, keep what scores best. It is the right idea for a program of language
// model calls and it is unaffordable here. Our rollout is not an LM call — it is a sandbox, up to 400
// steps, dollars and tens of minutes. A few hundred rollouts per skill, across 118 skills, is a bill
// nobody would sign and a week nobody has.
//
// GEPA's finding is the one that transfers: when rollouts are expensive, reflecting on rich
// natural-language feedback beats searching against a scalar. And we have the richest feedback
// imaginable sitting unused — a founder who rewrites a deliverable has DEMONSTRATED their standard,
// verbatim, before and after, which no reward number can carry.
//
// So the loop inverts. We do not generate rollouts to evaluate a candidate; we take the rollouts
// production was going to run anyway and let the candidate earn its place among them. Marginal cost
// of evidence: zero. What that buys is patience — a trial can afford to wait for real work, which
// means the decision can rest on deliverables that were actually sent to actual clients.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// WHAT MAKES THIS SAFE, IN ORDER OF HOW BADLY IT GOES WRONG WITHOUT IT
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
//  1. THE INCUMBENT KEEPS RUNNING. A trial splits traffic; it does not replace anything. If the
//     challenger is worse, most work was still done by the procedure that worked, and the evidence
//     that it is worse was bought at the price of the minority arm rather than the whole book.
//
//  2. A FLOOR ON EVIDENCE, NOT JUST A LEAD. Three deliverables to two is not a result. Without a
//     minimum the first challenger to get lucky on its opening run is promoted for ever, and every
//     later challenger is measured against a fluke.
//
//  3. A MARGIN, NOT A TIE-BREAK. Equal is not better. A challenger that merely matches the incumbent
//     should lose, because the incumbent has history and the challenger has a model's opinion, and
//     churning a procedure that works costs the founder the thing they had learned to predict.
//
//  4. LOSING IS A RESULT. A trial that ends with the challenger behind must CONCLUDE, not linger.
//     An inconclusive trial left running is a permanent 20% tax on quality that nobody remembers
//     turning on.
//
//  5. NOTHING HERE PROMOTES INTO THE SHARED LIBRARY. A tenant's trial decides a tenant's overlay.
//     Crossing into the cross-tenant shelf reaches every customer at once, and `playbooks.ts`'s
//     restore only helps the tenant who notices. That door is human-gated and lives elsewhere.
import type { SkillScale } from "./skill-scales";

/**
 * The share of runs the challenger gets.
 *
 * A fifth, not a half. The asymmetry is the argument: the incumbent is a procedure with evidence
 * behind it and the challenger is a hypothesis, so an even split prices them as equals and spends
 * half the book proving something we do not yet believe. A fifth still reaches the floor below in a
 * few weeks of ordinary volume, and costs four times less when the hypothesis is wrong.
 */
export const CHALLENGER_SHARE = 0.2;

/**
 * How many settled deliverables each arm needs before the trial may conclude.
 *
 * Eight is not a statistically satisfying number and nothing here pretends otherwise. It is chosen
 * against the volume a real agency produces: a business doing two or three deliverables a week
 * reaches eight per arm in about two months at a fifth split, and a floor they cannot reach in a
 * quarter is a trial that never ends and a procedure that never improves.
 *
 * The honesty is in `MIN_MARGIN` rather than here — a small sample with a large required margin
 * decides slowly and rarely decides wrongly, which is the right trade when the cost of a wrong
 * promotion is every deliverable afterwards.
 */
export const MIN_PER_ARM = 8;

/**
 * How much better the challenger has to be, in first-pass rate.
 *
 * Ten points. At eight samples an arm, a smaller margin is noise wearing a decision's clothes — one
 * deliverable either way moves the rate by 12.5 points, so anything under that is a coin landing.
 */
export const MIN_MARGIN = 0.1;

/**
 * The measure a trial is decided on, and why it is not acceptance.
 *
 * `first_pass_rate` — did the founder send it without rewriting it. Acceptance is the better question
 * and the wrong instrument: it needs a client to answer, arrives days or weeks later, and never
 * arrives at all for a deliverable nobody chased. A trial decided on it would take a year.
 *
 * Payment is better still and rarer still. Both are carried on the verdict below so a human reading
 * the result can see them; neither decides it.
 */
export type TrialMeasure = "first_pass_rate";

export interface TrialArm {
  /** Founder decisions settled in this arm — released + edited + sent_back. */
  decisions: number;
  /** Of those, how many went out untouched. */
  released: number;
  /** Invoices settled against this arm's work. Reported, never decisive — see `TrialMeasure`. */
  paid: number;
}

export const armOf = (s: Pick<SkillScale, "founder_total" | "released" | "paid"> | undefined): TrialArm => ({
  decisions: s?.founder_total ?? 0,
  released: s?.released ?? 0,
  paid: s?.paid ?? 0,
});

const rate = (a: TrialArm): number => (a.decisions ? a.released / a.decisions : 0);

export type TrialOutcome = "promote" | "keep_incumbent" | "running";

export interface TrialVerdict {
  outcome: TrialOutcome;
  /** A sentence a founder reads. Always set, including while running — silence explains nothing. */
  why: string;
  incumbent_rate: number;
  challenger_rate: number;
  margin: number;
  /** How many more settled deliverables the smaller arm needs before this can conclude. */
  needs: number;
}

/**
 * Decide a trial.
 *
 * Pure, and takes both arms as data rather than reading them, so the rule can be argued with in a
 * test instead of inferred from production. Every threshold above is exported for the same reason:
 * a constant nobody can see is a constant nobody can challenge.
 */
export function judgeTrial(incumbent: TrialArm, challenger: TrialArm): TrialVerdict {
  const ir = rate(incumbent);
  const cr = rate(challenger);
  const margin = cr - ir;
  const needs = Math.max(0, MIN_PER_ARM - Math.min(incumbent.decisions, challenger.decisions));

  if (needs > 0) {
    return {
      outcome: "running",
      why:
        `still gathering evidence — ${needs} more settled deliverable${needs === 1 ? "" : "s"} needed ` +
        `on the thinner side (${incumbent.decisions} against the current procedure, ${challenger.decisions} against the proposed one).`,
      incumbent_rate: ir,
      challenger_rate: cr,
      margin,
      needs,
    };
  }

  /**
   * EPSILON, because the boundary is decided on floating-point subtraction of two ratios.
   *
   * A rate here is a ratio of small integers, and `9/10 - 8/10` is `0.10000000000000009` while other
   * pairs that are exactly ten points apart come out at `0.09999999999999998`. Without slack the
   * threshold accepts or rejects the SAME margin depending on which counts produced it, which is a
   * coin flip dressed as a rule and would be invisible in production — a challenger that deserved
   * promotion quietly not getting it, forever, on one arm's arithmetic.
   */
  if (margin >= MIN_MARGIN - 1e-9) {
    return {
      outcome: "promote",
      why:
        `the proposed version went out unedited ${pct(cr)} of the time against ${pct(ir)} for the current one, ` +
        `over ${challenger.decisions} and ${incumbent.decisions} deliverables. That is past the ${pct(MIN_MARGIN)} ` +
        `margin a change has to clear.`,
      incumbent_rate: ir,
      challenger_rate: cr,
      margin,
      needs: 0,
    };
  }

  /**
   * EVERYTHING ELSE KEEPS THE INCUMBENT, INCLUDING A NARROW WIN.
   *
   * A challenger ahead by less than the margin has not shown anything at this sample size — one
   * deliverable either way moves the rate further than that. And "not shown to be better" resolves
   * to keeping what works, because the incumbent has history and the challenger has a model's
   * opinion, and churning a procedure the founder had learned to predict has a cost that never
   * appears in either rate.
   */
  return {
    outcome: "keep_incumbent",
    why:
      margin > 0
        ? `the proposed version is ahead by only ${pct(margin)}, which is inside the noise at this sample size. Keeping the current procedure.`
        : margin === 0
          ? `both went out unedited ${pct(ir)} of the time. Equal is not better — keeping the current procedure.`
          : `the proposed version went out unedited ${pct(cr)} of the time against ${pct(ir)} for the current one. Keeping the current procedure.`,
    incumbent_rate: ir,
    challenger_rate: cr,
    margin,
    needs: 0,
  };
}

const pct = (n: number): string => `${Math.round(n * 100)}%`;

/**
 * Which arm a given run belongs to.
 *
 * Hashed from the task id rather than drawn at random, and that is not a style preference. A run may
 * be re-read, retried or reported on after the fact, and a random draw would answer differently each
 * time — the same deliverable could be counted in both arms, which corrupts the only evidence the
 * trial has. Deriving it means the answer is a fact about the task rather than about when it was
 * asked.
 */
export function armFor(taskId: string, share: number = CHALLENGER_SHARE): "challenger" | "incumbent" {
  const id = String(taskId ?? "");
  if (!id) return "incumbent"; // no identity, no experiment — the safe arm
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // >>> 0 before dividing: `Math.imul` yields a signed 32-bit value and a negative numerator would
  // put a fifth of tasks on the wrong side of every comparison.
  return (h >>> 0) / 0x1_0000_0000 < share ? "challenger" : "incumbent";
}
