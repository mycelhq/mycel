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
 * $0.002 on nano. Run the Starter plan's 2,000 monthly jobs entirely on gpt-5.1 and the model bill
 * is ~$110 against £99 of revenue — the plan loses money at its own advertised limit. On mini it is
 * ~$22, which is a business.
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
 * Free gets `fast` — enough to feel the product work end to end, not enough to cost us real money
 * on someone who has not paid. `self_hosted` is unrestricted because it is the operator's own key
 * and their own bill; metering someone else's spend would be rude and pointless.
 */
export const PLAN_MAX_TIER: Record<Plan, ModelTier> = {
  self_hosted: "deep",
  free: "fast",
  starter: "standard",
  growth: "deep",
  scale: "deep",
};

/**
 * Resolve the tier a task actually runs at.
 *
 * Clamped DOWN to the plan's ceiling rather than refused. A free-tier customer asking for deep
 * reasoning gets a cheaper answer, not an error — the work still happens, which is the whole point
 * of a free tier, and the upgrade prompt belongs in the product rather than in a failed run.
 */
export function resolveTier(requested: ModelTier | undefined, plan: Plan | undefined): ModelTier {
  const want = requested ?? "standard";
  const ceiling = PLAN_MAX_TIER[plan ?? "self_hosted"] ?? "deep";
  return ORDER.indexOf(want) <= ORDER.indexOf(ceiling) ? want : ceiling;
}

/** True when the plan forced a cheaper model than the wedge asked for — the UI says so. */
export function wasClamped(requested: ModelTier | undefined, plan: Plan | undefined): boolean {
  const want = requested ?? "standard";
  return ORDER.indexOf(want) > ORDER.indexOf(PLAN_MAX_TIER[plan ?? "self_hosted"] ?? "deep");
}

export const modelForTier = (tier: ModelTier): string => TIER_MODELS[tier];

/** Is this string one of our tiers? Wedge manifests are JSON and can say anything. */
export const isTier = (v: unknown): v is ModelTier => ORDER.includes(v as ModelTier);
