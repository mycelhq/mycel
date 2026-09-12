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
/**
 * ═══ THE MODEL SURVEY, 29 AUGUST 2026 — AND WHY THE CHEAP-CHINESE-MODEL MOVE IS ONLY HALF RIGHT ═══
 *
 * Artificial Analysis Intelligence Index v4.1, with list prices per million tokens:
 *
 *   Claude Opus 5          63.0    —
 *   Kimi K3 (max)          59.7    $3.00 / $15.00   (cached input $0.30)
 *   GPT-5.6 Sol            58.9    $5.00 / $30.00
 *   GPT-5.6 Terra          55.0    $2.00 / $12.00   ← our `deep`
 *   DeepSeek V4 Pro        53.2    $0.44 / $0.87
 *   GPT-5.6 Luna           51.2    $0.20 / $1.20    ← our `standard`
 *   GLM-5.2                51.0    $1.40 / $4.40    (provider median ~$0.55 / $1.85)
 *   DeepSeek V4 Flash      50.0    $0.14 / $0.28
 *
 * TWO CONCLUSIONS, AND THE FIRST ONE IS A CORRECTION.
 *
 * 1. THERE IS NOTHING TO WIN AT THE `standard` TIER. GLM-5.2 scores 51.0 against Luna's 51.2 and
 *    costs more at every provider we could reach — $0.55/$1.85 at the median against $0.20/$1.20.
 *    OpenAI cut Luna 80% on 30 July 2026 and that closed the gap the whole "use the cheap Chinese
 *    model" instinct was built on. Moving `standard` today would pay more for slightly less.
 *
 * 2. THE `deep` TIER IS WHERE THE MONEY IS, and it is a lot of money. Terra is $2.00/$12.00 at 55.0;
 *    DeepSeek V4 Pro is $0.44/$0.87 at 53.2. That is 1.8 index points for a FOURTEENFOLD cut in
 *    output price, and output is what a deliverable is made of — a thousand-word report is a few
 *    thousand output tokens, so the `deliver` shape's cost is almost entirely on that side.
 *
 * WHAT THIS SURVEY CANNOT TELL US, said plainly rather than rounded away. The index is an aggregate
 * dominated by reasoning and coding. Our `deliver` work is long-form professional writing with
 * figures in it, and no public benchmark measures that in a way I would bet a client's monthly close
 * on. 1.8 aggregate points could be nothing or could be exactly the depth the exemplars exist to
 * teach. THIS IS A TRIAL, NOT A SWITCH — see `armFor` in skill-arsenal.ts for the machinery that
 * already exists to run one, and run the same deliverable through both arms before moving anything.
 *
 * AWS BEDROCK, MEASURED RATHER THAN ASSUMED — 2026-09-03, eu-west-2, the region this kernel runs in.
 *
 * The two shelves have to be judged separately, and an earlier edit of this comment got that wrong
 * by treating one answer as covering both.
 *
 * THE FRONTIER SHELF IS CURRENT. Bedrock carries `openai.gpt-5.6-luna` and `openai.gpt-5.6-terra` —
 * the exact `standard` and `deep` models named below — plus `gpt-5.6-sol`, `claude-fable-5-1` and
 * `grok-4.6`. Seventy-two models, no egress, no second vendor relationship.
 *
 * THE OPEN-WEIGHT SHELF IS STILL A GENERATION BEHIND, which is what this comment said originally and
 * what it still says, with the numbers moved on: Bedrock has DeepSeek V3.2 against V4 (April),
 * Kimi K2.5 against K2.6 (April) and K3 (July), GLM-5 against GLM-5.2 (June). GLM-5.2 landed fourth
 * on the headline intelligence index — ahead of every model you cannot download — and it is not
 * here. So the cheap-and-excellent tier this product would most like to reach is precisely the tier
 * Bedrock lags on.
 *
 * WHY IT MATTERS ANYWAY: MARGIN. Model spend is the largest variable cost in this product and it is
 * paid to OpenAI directly today. The same tokens through Bedrock bill to AWS credits the business
 * already holds, and LiteLLM speaks Bedrock as a provider, so the per-org `max_budget` enforcing
 * plan ceilings keeps working unchanged. That is a routing change, not an architectural one — and it
 * applies to the frontier shelf, which is exactly the shelf that is current.
 *
 * NOT DONE HERE, because it is a PRICING question rather than a plumbing one. Bedrock's per-token
 * rates are not automatically a provider's own, and swapping the workhorse tier of a live product on
 * an untested cost assumption is how a margin gets worse while appearing to improve. `armFor` exists
 * to run that comparison on real deliverables before anything moves.
 *
 * Every value below is env-overridable, so trying one is a config change and never a deploy.
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
/**
 * ═══ ESCALATE WHEN A RUN HAS PROVED IT NEEDS MORE, NOT WHEN WE GUESS IT MIGHT ═══
 *
 * One model for a whole run is one guess made before the work starts. The alternative usually
 * proposed is to classify each turn's difficulty and route accordingly — which is another guess,
 * made more often, by something that has not seen the answer either.
 *
 * There is a third signal and it is free: THE RUN ALREADY FAILED. `MAX_REPAIR_ROUNDS` in
 * orchestrator.ts hands a verify failure back to the agent with the actual failing output. A repair
 * round is not a suspicion that the task is hard — it is proof, in the form of a workspace that did
 * not verify.
 *
 * That is also exactly where the money is. This file already records what happens when a model is
 * out of its depth: a `chase_invoice` run on `fast` "tried again, identically, ELEVEN times ... 233
 * events, twenty-five minutes, killed by the runtime ceiling with nothing delivered." Per token
 * `fast` is four times cheaper; per DELIVERED ANSWER it was infinitely more expensive. Escalating
 * a proven-hard round is the cheap move, not the expensive one — it is the loop that costs.
 *
 * ONE STEP PER ROUND, and never past what the plan may reach. A Starter org does not get the deep
 * tier because its build failed twice; the ceiling is the ceiling, and `wasClamped` above already
 * says so out loud when it bites.
 *
 * NEVER DOWNWARD. A wedge manifest that asks for `deep` gets `deep` on round zero, and this can
 * only raise it. Quietly demoting somebody's chosen tier to save money on a retry would make the
 * second attempt worse than the first, which is the opposite of the whole point.
 */
export function escalatedTier(
  base: ModelTier,
  repairRound: number,
  plan?: Plan,
  unlimited = false,
): ModelTier {
  const round = Number.isFinite(repairRound) ? Math.max(0, Math.floor(repairRound)) : 0;
  if (round <= 0) return base;
  const ceiling = ORDER.indexOf(ceilingFor(plan, unlimited));
  const from = ORDER.indexOf(base);
  if (from < 0) return base;
  return ORDER[Math.min(from + round, ceiling, ORDER.length - 1)] ?? base;
}

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

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE TRIAL THIS FILE KEEPS ASKING FOR, ACTUALLY REACHABLE
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The survey above ends "THIS IS A TRIAL, NOT A SWITCH — see `armFor`", and `harness.ts` says the
 * same thing over the `deliver` shape: "flip it back with one word if a trial says otherwise, and
 * `armFor` exists to run that trial properly."
 *
 * `armFor` did exist. It could not do this. It splits runs by task id and `runtime.ts` uses it to
 * choose which SKILL OVERLAY a run reads — nothing anywhere connected an arm to a MODEL. So the
 * one decision this file explicitly refuses to make on a benchmark was, in practice, only ever
 * going to be made on a benchmark, because the alternative was unreachable. The machinery was
 * built and never invoked for the purpose its own comments cite it for.
 *
 * This is the wire, and it is deliberately the whole feature: one function, one call site.
 *
 *   MYCEL_MODEL_TRIAL=deepseek/deepseek-v4-pro   # what to try
 *   MYCEL_MODEL_TRIAL_TIER=standard              # against which tier's incumbent (default standard)
 *
 * Unset, `challengerFor` returns undefined and nothing changes — no branch taken, no cost, no
 * behaviour to reason about. That matters more than it looks: a trial mechanism that alters a
 * production path when nobody is running a trial is a liability rather than an instrument.
 *
 * ═══ WHY IT IS SCOPED TO ONE TIER ═══
 *
 * Without the tier check, a run on the challenger arm would swap the model for the `fast`
 * classification calls too. Those are a different question with a different right answer, and
 * mixing them means the evidence answers neither. A trial that measures two changes at once has
 * measured nothing.
 *
 * ═══ AND WHY THE EVIDENCE ALREADY EXISTS ═══
 *
 * Nothing here needs a new table. `runtime.ts` already records `arm` on the run and `chargeUsage`
 * already records the model, and `skill-trial.ts` already scores an arm the only way this product
 * should ever score one: the share of deliverables that went out WITHOUT AN EDIT. That is the same
 * number the console's learning curve plots and the same number the landing page now promises to
 * report. Cheaper-and-as-good is not a claim to take from an aggregate index dominated by coding
 * benchmarks; it is a claim about whether the founder had to rewrite it.
 */
export function challengerFor(tier: ModelTier, arm: "incumbent" | "challenger"): string | undefined {
  if (arm !== "challenger") return undefined;
  const model = process.env.MYCEL_MODEL_TRIAL?.trim();
  if (!model) return undefined;
  const under = process.env.MYCEL_MODEL_TRIAL_TIER?.trim() || "standard";
  return isTier(under) && under === tier ? model : undefined;
}

/** Is this string one of our tiers? Wedge manifests are JSON and can say anything. */
export const isTier = (v: unknown): v is ModelTier => ORDER.includes(v as ModelTier);
