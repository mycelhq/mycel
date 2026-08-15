import type { Plan } from "./identity";

/**
 * Which model runs a piece of work, and what a plan is allowed to reach.
 *
 * This is the margin lever, and it is not a small one. Priced per million tokens (Nov 2025):
 *
 *   gpt-5.1      $1.25 in / $10.00 out
 *   gpt-5-mini   $0.25 in /  $2.00 out     — 5× cheaper
 *   gpt-5-nano   $0.05 in /  $0.40 out     — 25× cheaper
 *
 * A typical run is roughly 20k input and 3k output, so about $0.055 on gpt-5.1, $0.011 on mini and
 * $0.002 on nano. Run the Starter plan's 2,000 monthly jobs entirely on the deep tier and the model
 * bill is ~$152 against $99 of revenue — the plan loses money at its own advertised limit. On the
 * standard tier it is ~$15, which is a business.
 *
 * So the default is NOT the best model. It is the cheapest model that can do the job, with the
 * expensive one reserved for work that genuinely needs it and gated by what the customer pays.
 */
export type ModelTier = "fast" | "standard" | "deep";

/**
 * Tier → model. Chosen on price per unit of capability, not on version number.
 *
 * `gpt-5.6-luna` is both NEWER and cheaper than `gpt-5-mini` ($0.20/$1.20 against $0.25/$2.00), so
 * it simply dominates it — there is no reason to run the older, pricier model. The `deep` tier is
 * `terra` rather than `sol` because sol is 2.5× the price for the last increment of capability, and
 * the work that genuinely needs sol is rare enough to ask for it explicitly.
 *
 * Aliases without a date suffix, deliberately: OpenAI moves these forward and we want the
 * improvement. Pin a snapshot in a wedge manifest if a specific service needs stability.
 */
export const TIER_MODELS: Record<ModelTier, string> = {
  // Classification, extraction, routing, "is this urgent", parsing a statement. Most of what an
  // agent does in a service business is this, and it does not need a frontier model.
  fast: process.env.MYCEL_MODEL_FAST ?? "openai/gpt-5-nano",
  // Drafting something a customer will read. The workhorse.
  standard: process.env.MYCEL_MODEL_STANDARD ?? "openai/gpt-5.6-luna",
  // Multi-step judgement, a messy reconciliation, the awkward email. Earn it.
  deep: process.env.MYCEL_MODEL_DEEP ?? "openai/gpt-5.6-terra",
};

/** Per-million-token cost, for the spend estimate and the margin maths above. */
export const TIER_PRICE: Record<ModelTier, { in: number; out: number }> = {
  fast: { in: 0.05, out: 0.4 },
  standard: { in: 0.2, out: 1.2 },
  deep: { in: 2.0, out: 12.0 },
};

const ORDER: ModelTier[] = ["fast", "standard", "deep"];

/**
 * The best tier a plan may reach.
 *
 * FREE GETS `standard`, AND THE CHEAP TIER WAS NOT CHEAPER. This used to be `fast` on the reasoning
 * that it was "enough to feel the product work end to end, not enough to cost us real money on
 * someone who has not paid". Production disproved the first half and, with it, the second.
 *
 * A `chase_invoice` run on `fast` (gpt-5-nano) called `bash` and omitted the required `description`
 * key. OpenCode rejected it with a schema error. The model tried again, identically, ELEVEN times,
 * interleaved with re-reading the same policy file, and never converged — 233 events, twenty-five
 * minutes, killed by the runtime ceiling with nothing delivered.
 *
 * That is the failure mode that breaks the margin argument. Per token `fast` is 4× cheaper than
 * `standard`, but a model that cannot hold a tool schema does not do the work in 4× the turns — it
 * loops until a ceiling stops it, and the ceiling is where the real bill lands. The run above cost
 * $0.0134 and produced nothing; the same task converging in five turns on `standard` costs less in
 * absolute dollars AND produces an answer. The cheap tier was only cheap per token, which is not a
 * unit anyone is billed in.
 *
 * Spend on free is still bounded — by `max_cost_usd`, which is the control that was actually doing
 * this job all along. `fast` remains the right default for the work it is good at (classification,
 * extraction, routing); it is just not a floor that a whole plan can stand on.
 *
 * `self_hosted` is unrestricted because it is the operator's own key and their own bill; metering
 * someone else's spend would be rude and pointless.
 */
export const PLAN_MAX_TIER: Record<Plan, ModelTier> = {
  self_hosted: "deep",
  // Legacy, and grandfathered — see PLAN_LIMITS.free. Nothing new lands here, but live orgs do,
  // and a missing entry would silently fall through to the `?? "deep"` default below and hand the
  // cheapest surviving plan the most expensive model.
  free: "standard",
  find: "standard",
  starter: "standard",
  growth: "deep",
  scale: "deep",
};

/**
 * The tier ceiling in force, in one expression.
 *
 * `unlimited` is the super-admin path (see `superadmin.ts`) and it is a separate ARGUMENT rather
 * than a `Plan` value on purpose: a plan is a commercial fact that reaches Stripe, the pricing page
 * and the webhook, and none of those should ever learn that an uncapped account exists.
 */
const ceilingFor = (plan: Plan | undefined, unlimited: boolean): ModelTier =>
  unlimited ? "deep" : (PLAN_MAX_TIER[plan ?? "self_hosted"] ?? "deep");

/**
 * Resolve the tier a task actually runs at.
 *
 * Clamped DOWN to the plan's ceiling rather than refused. A customer asking for deep reasoning on a
 * plan that does not include it gets a cheaper answer, not an error — the work still happens, which
 * is the whole point of a trial, and the upgrade prompt belongs in the product rather than in a
 * failed run.
 *
 * Note what this means during a seven-day trial: the status is `trialing`, the plan is whichever
 * plan is being trialled, so someone trialling Growth reaches `deep`. A trial that silently ran on a
 * cheaper model than the plan it is selling would be a demo of a product we do not sell.
 */
export function resolveTier(
  requested: ModelTier | undefined,
  plan: Plan | undefined,
  unlimited = false,
): ModelTier {
  const want = requested ?? "standard";
  const ceiling = ceilingFor(plan, unlimited);
  return ORDER.indexOf(want) <= ORDER.indexOf(ceiling) ? want : ceiling;
}

/** True when the plan forced a cheaper model than the wedge asked for — the UI says so. */
export function wasClamped(
  requested: ModelTier | undefined,
  plan: Plan | undefined,
  unlimited = false,
): boolean {
  const want = requested ?? "standard";
  return ORDER.indexOf(want) > ORDER.indexOf(ceilingFor(plan, unlimited));
}

/**
 * Every model a holder of this plan may reach, cheapest first.
 *
 * Lives here rather than in litellm.ts because it is the same ceiling `resolveTier` applies, and the
 * two disagreeing is a live failure mode: the proxy allowlist and the tier resolver each grew their
 * own copy of this ladder once already, and the result was a run that resolved a model correctly and
 * was then refused by the key it was holding.
 */
export const modelsUpToCeiling = (plan: Plan | undefined, unlimited = false): string[] => {
  const ceiling = ceilingFor(plan, unlimited);
  return ORDER.slice(0, ORDER.indexOf(ceiling) + 1).map((t) => TIER_MODELS[t]);
};

export const modelForTier = (tier: ModelTier): string => TIER_MODELS[tier];

/** Is this string one of our tiers? Wedge manifests are JSON and can say anything. */
export const isTier = (v: unknown): v is ModelTier => ORDER.includes(v as ModelTier);
