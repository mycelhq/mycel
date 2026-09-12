// WHAT AN ORG MAY RUN BEFORE IT HAS PAID FOR ANYTHING — and the ceilings that stop that being free
// compute for strangers.
//
// ═══ THE FAILURE THIS EXISTS FOR, OBSERVED IN PRODUCTION ═══
//
// A real account was created on app.mycelai.dev and walked through onboarding as a customer. Step
// two — "What do you sell?" → "Work it out" — answered "Couldn't start that. Try again in a
// moment." and the flow could not continue. Every hosted signup since the trial change hit this.
//
// The mechanism was a deadlock, not a bug in any one line. A brand-new cloud org is stamped
// `plan: "starter", plan_status: "none"` on purpose: the plan NAMES what they are about to buy
// while granting nothing (see `PlanStatus`). `POST /v1/tasks` refuses every task from such an org
// with 402 `plan_inactive`. But onboarding is linear — you → wedge → shape → questions → learned →
// connect → pay — and the shaping run is step TWO while the card is step SEVEN. The only thing that
// could convince somebody to pay was gated behind their having paid. We were gating our own sales
// pitch behind the sale, and the hosted product converted nobody.
//
// ═══ WHAT IS EXEMPT, AND WHY EXACTLY THAT ═══
//
// The `business_shaping` role, and nothing else. That role is onboarding's only agent: it reads one
// line about a business and drafts the shape (`draft_shape`), the questions worth asking
// (`draft_questions`), and — when nothing installed fits — the service itself (`draft_service`).
// Those three task types ARE the part of the funnel that happens before the close, and all three
// only ever write drafts the founder is then shown. None of them sends an email, touches a client,
// moves money, or provisions anything.
//
// Resolved through `roles.ts` and never by directory name. A string literal `"business-shaper"`
// here would be the eighth hardcode roles.ts was written to delete, and a contract test greps
// `src/` for wedge directory names precisely so that this cannot come back.
//
// ═══ WHY `app_building` IS NOT EXEMPT ═══
//
// It is the other role a founder meets during onboarding, so it is worth saying why the answer is
// no. Three independent reasons, any one of which is enough:
//
//   · It is not in the pre-close funnel at all. Building the founder's site is offered AFTER the
//     card, on the finish screen, and `OnboardingStep` in the cloud says so in as many words: it is
//     deliberately not a step, because minutes of waiting immediately before the close spends the
//     founder's patience at the moment it is worth the most.
//   · It costs real money — a `deep` tier run with a $5 ceiling plus a CodeBuild execution. That is
//     an order of magnitude past anything a stranger should be able to spend on us, and it cannot
//     be brought down to a shaping run's price without building something worse than nothing.
//   · It PUBLISHES. A site on a public domain, built by an account that has never been charged, is
//     a hosting service we did not mean to offer.
//
// Everything else — chasing an invoice, sending an email, GTM, inbound triggers (`triggers.ts`),
// the reflection clock — stays refused exactly as before. `trialing` and `past_due` never reach
// this file: they are not blocked at all, and run at their plan's full limits.
//
// ═══ WHY ONLY `none`, NEVER `cancelled` ═══
//
// `workBlockedBy` returns both. An org that HAD a subscription and lost it has already seen the
// product work and has already been shaped; handing it a fresh allowance of free drafting would be
// a small free tier reachable by cancelling, which is the exact thing removing the free tier was
// meant to stop. The exemption is for people who have never been sold to, once.
//
// ═══ HOW IT IS BOUNDED ═══
//
// Nothing authenticates the person on the other end of a signup to us. They can create an org in
// ten seconds and start burning model spend, so the allowance is capped on four independent axes,
// all of them enforced server-side from stored facts:
//
//   1. WHAT — the three task types above, resolved from the role index.
//   2. HOW MANY — `PRESUB_MAX_RUNS` tasks, counted over the org's whole lifetime rather than per
//      month, so waiting for the calendar to turn over grants nothing.
//   3. HOW MUCH — `PRESUB_MAX_SPEND_USD` of model spend over that same lifetime, and
//      `PRESUB_MAX_COST_USD` per run, clamped onto the task's own constraints.
//   4. HOW GOOD — `PRESUB_PLAN`'s tier ceiling, so the runs cannot reach `deep`.
//
// NONE OF THESE IS RAISABLE BY ANYTHING A CLIENT SENDS. The counts are derived from rows in the
// store, the ceilings are module constants, and the per-run cost is applied by `Math.min` AFTER the
// caller's constraints have been read — a request asking for `max_cost_usd: 1000` comes out at
// `PRESUB_MAX_COST_USD`. This is the same shape as `autonomy.ts`'s hard caps: a number nobody, plan
// or payload, can argue with.
import { WEDGE_ROLES, wedgeHasRole } from "./roles";
import type { Plan } from "./identity";

/**
 * How many runs an org that has never subscribed may start, ever.
 *
 * Onboarding needs four on the ordinary path: one `draft_shape`, one `draft_questions`, and — only
 * when nothing installed fits — one `draft_service`. The rest of the budget is for the founder who
 * reads our reading of their business, disagrees, and says it again in better words, which is the
 * single most valuable thing that can happen on that screen and must not be rationed to once.
 *
 * A LIFETIME COUNT, not a monthly one. A monthly allowance is a free tier with a slower clock.
 */
export const PRESUB_MAX_RUNS = 8;

/**
 * The money ceiling on the same allowance, in dollars of model spend over the org's lifetime.
 *
 * Belt and braces with the run count, and it is the one that actually protects margin: a run count
 * bounds how many times an agent starts, not what it spends once it has. Eight shaping runs at the
 * per-run ceiling below would be $4; in practice a shaping run costs a couple of cents, so this is
 * a runaway guard rather than something an honest signup will ever meet.
 */
export const PRESUB_MAX_SPEND_USD = 1;

/**
 * The per-run cost ceiling, clamped over whatever the caller asked for.
 *
 * Matches what the shaper's own manifest requests today (`max_cost_usd: 0.5` on `draft_shape`), so
 * the honest path is unaffected — this exists so that a crafted `POST /v1/tasks` with a large
 * `constraints.max_cost_usd` cannot turn one free draft into a large bill.
 */
export const PRESUB_MAX_COST_USD = 0.5;

/**
 * The plan whose model-tier ceiling a pre-subscription run gets.
 *
 * `starter` resolves to the `standard` tier (see `PLAN_MAX_TIER`), which is the cheapest SANE tier
 * and deliberately not the cheapest one. `fast` was tried as a floor for unpaid work and cost more,
 * not less: a `fast` run looped eleven times on a tool schema it could not hold and was killed by
 * the runtime ceiling having delivered nothing. A draft that fails is worth less than nothing here,
 * because it is the whole sales pitch.
 *
 * Applied by plan STATUS rather than by plan NAME, because the name is aspirational before payment:
 * an org can be stamped `growth` while `plan_status` is still `none`, and reading the name alone
 * would hand a stranger the `deep` tier.
 */
export const PRESUB_PLAN: Plan = "starter";

/**
 * "Since the beginning of time" — the window both lifetime counts are measured over.
 *
 * The store's counters take a `since`, and a pre-subscription allowance is not a rate. Passing the
 * epoch is how "ever" is spelled with the counters that already exist, rather than adding a second
 * pair of store methods that could disagree with the first.
 */
export const PRESUB_SINCE = "1970-01-01T00:00:00.000Z";

/**
 * Is this specific task one of onboarding's own drafting runs?
 *
 * BOTH halves are checked. A wedge that holds the `business_shaping` role may well declare other
 * task types (nothing stops it), and holding the role must not turn every verb that wedge knows
 * into free work. The task types come from the role declaration itself, so adding a fourth drafting
 * step to onboarding is one line in `roles.ts` and not a second list here that drifts from it.
 */
export function isPresubscriptionWork(wedge: string | undefined, taskType: string | undefined): boolean {
  if (!wedge || !taskType) return false;
  if (!wedgeHasRole(wedge, "business_shaping")) return false;
  return (WEDGE_ROLES.business_shaping.task_types as readonly string[]).includes(taskType);
}

/**
 * What a founder reads when the allowance itself is spent.
 *
 * Distinct from the ordinary `plan_inactive` sentence on purpose. "This business doesn't have a
 * subscription yet" is true but reads as though nothing ever worked, when in fact several drafts
 * already ran and they watched them. The sentence has to name what was used up, and it has to end
 * on the thing that fixes it — a refusal that stops at the diagnosis is the "try again in a moment"
 * bug in a better outfit.
 */
export const PRESUB_SPENT_MESSAGE =
  `we've done the ${PRESUB_MAX_RUNS} drafts that come before a plan — start a plan and it keeps going, ` +
  `with everything drafted so far still here`;
