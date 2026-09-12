import { test } from "node:test";
import assert from "node:assert/strict";
import { api, makeApp } from "./helpers";
import { getIdentityStore } from "../src/identity";
import { PLAN_MAX_TIER, resolveTier } from "../src/models";
import { wedgeForRole } from "../src/roles";
import {
  isPresubscriptionWork,
  PRESUB_MAX_COST_USD,
  PRESUB_MAX_RUNS,
  PRESUB_PLAN,
} from "../src/presubscription";

/**
 * THE DEADLOCK THAT MADE EVERY HOSTED SIGNUP DEAD ON ARRIVAL.
 *
 * Observed in production: a real account created on app.mycelai.dev pressed "Work it out" on step
 * two of onboarding and read "Couldn't start that. Try again in a moment." `POST /v1/tasks` had
 * refused it 402 `plan_inactive`, because a brand-new cloud org is stamped `plan_status: "none"` —
 * and the card is step SEVEN. The pitch was gated behind the sale, so nobody could reach the sale.
 *
 * Every test here names the bug it prevents. The exemption is deliberately narrow, and half of
 * these exist to prove it stayed narrow.
 */

/** The shaping wedge, resolved the way the kernel resolves it: from the role, never by name. */
const SHAPER = wedgeForRole("business_shaping")!;

/** Put the caller's own org into the state a brand-new cloud signup is in, and hand back its id. */
async function newSignup(app: ReturnType<typeof makeApp>["app"]): Promise<string> {
  const orgId = (await api(app, "me")).json.org_id as string;
  getIdentityStore().setPlan(orgId, { plan: "starter", status: "none" });
  return orgId;
}

const draft = (wedge: string, task_type: string, input: Record<string, unknown> = {}) => ({
  method: "POST",
  body: JSON.stringify({ wedge, task_type, input }),
});

test("presubscription: a brand-new org with plan_status none can complete onboarding's shaping runs", async () => {
  // THE BUG, exactly as production had it. All three of onboarding's drafting runs happen before
  // the card: the shape (step two), the questions (step three→four) and — when nothing installed
  // fits — the service itself. Any one of them refused strands the founder on a linear flow with no
  // way forward, and the error they read tells them to retry something that can never succeed.
  const { app } = makeApp();
  await newSignup(app);

  for (const type of ["draft_shape", "draft_questions", "draft_service"]) {
    const res = await api(app, "tasks", draft(SHAPER, type, { description: "bookkeeping for shops" }));
    assert.equal(res.status, 201, `${type} must run before anybody has paid: ${res.text}`);
  }
});

test("presubscription: the same org still cannot start a chase, a build, or any other real job", async () => {
  // THE BUG the exemption could easily have introduced: a hole in the paywall. Onboarding's drafts
  // are speculative work nobody but the founder ever sees. Chasing an invoice mails a real client,
  // and `app_building` publishes a site and spends CodeBuild minutes — both stay refused, and
  // `app_building` is named here because it is the other role a founder meets during onboarding and
  // is the tempting second exemption.
  const { app } = makeApp();
  await newSignup(app);

  for (const [wedge, type] of [
    ["books-keeper", "daily_sync"],
    ["invoice-chaser", "chase_invoice"],
    ["product-builder", "build_feature"],
  ]) {
    const res = await api(app, "tasks", draft(wedge, type));
    assert.equal(res.status, 402, `${wedge}/${type} must still be refused without a subscription`);
    assert.equal(res.json.code, "plan_inactive");
    assert.equal(res.json.plan_status, "none");
  }
});

test("presubscription: the exemption is the ROLE's task types, not everything the shaping wedge knows", async () => {
  // THE BUG: "the shaper is exempt" read as "that wedge is exempt". Holding a role must not turn
  // every verb the wedge happens to declare into free compute, and the list of exempt verbs must
  // come from the role declaration in roles.ts rather than from a second copy that drifts from it.
  assert.equal(isPresubscriptionWork(SHAPER, "draft_shape"), true);
  assert.equal(isPresubscriptionWork(SHAPER, "chase_invoice"), false, "a verb the role does not name");
  assert.equal(isPresubscriptionWork("invoice-chaser", "draft_shape"), false, "a wedge without the role");
  assert.equal(isPresubscriptionWork(undefined, "draft_shape"), false);
  assert.equal(isPresubscriptionWork(SHAPER, undefined), false);
});

test("presubscription: the allowance is capped, and the refusal names what ran out and what fixes it", async () => {
  // THE BUG: unauthenticated-to-us strangers burning model spend forever. Anyone can create an org
  // in ten seconds, so the exemption has to end somewhere — over the org's LIFETIME, not per month,
  // because a monthly allowance is a free tier with a slower clock.
  //
  // And the second half: the refusal that ends it must not be the sentence this whole change exists
  // to delete. "Try again in a moment" instructs a retry that can never succeed.
  const { app } = makeApp();
  await newSignup(app);

  for (let i = 0; i < PRESUB_MAX_RUNS; i++) {
    const res = await api(app, "tasks", draft(SHAPER, "draft_shape", { description: `take ${i}` }));
    assert.equal(res.status, 201, `draft ${i + 1} of the allowance should run`);
  }

  const over = await api(app, "tasks", draft(SHAPER, "draft_shape", { description: "one too many" }));
  assert.equal(over.status, 402, "the allowance is finite");
  assert.equal(over.json.code, "plan_inactive", "and it is a PLAN refusal, so the product offers the plan");
  assert.equal(over.json.allowance, "spent");
  assert.match(over.json.error, /start a plan/i, "the remedy is in the sentence");
  assert.doesNotMatch(over.json.error, /try again/i, "never a retry that cannot succeed");
  assert.doesNotMatch(over.json.error, /0 jobs/, "and never arithmetic instead of a reason");
});

test("presubscription: nothing a client sends can raise the allowance or its per-run budget", async () => {
  // THE BUG this file is most afraid of: a ceiling that a payload can argue with. `autonomy.ts` set
  // the precedent — a hard cap nobody can raise. Here the run count comes from stored rows, and the
  // per-run cost is clamped with Math.min AFTER the caller's constraints are read, so a crafted
  // request asking for a thousand dollars of model spend gets a free draft's budget.
  const { app } = makeApp();
  await newSignup(app);

  const res = await api(app, "tasks", {
    method: "POST",
    body: JSON.stringify({
      wedge: SHAPER,
      task_type: "draft_shape",
      input: { description: "a business" },
      constraints: { max_cost_usd: 1000, max_runtime_s: 999999 },
      // Fields a hopeful client might send in the belief that the server reads them. It must not.
      plan: "scale",
      plan_status: "active",
      limits: { tasks_per_month: 9999 },
    }),
  });
  assert.equal(res.status, 201);
  assert.ok(
    res.json.constraints.max_cost_usd <= PRESUB_MAX_COST_USD,
    `a pre-subscription run is clamped to $${PRESUB_MAX_COST_USD}, got ${res.json.constraints.max_cost_usd}`,
  );

  // The org is still unpaid afterwards — nothing in the body was allowed to change that.
  const org = getIdentityStore().getOrg((await api(app, "me")).json.org_id as string);
  assert.equal(org?.plan_status, "none", "a task body cannot promote an org");
  assert.equal(
    (await api(app, "tasks", draft("books-keeper", "daily_sync"))).status,
    402,
    "and real work is still refused",
  );
});

test("presubscription: a cancelled org gets no allowance at all", async () => {
  // THE BUG: a free tier reachable by cancelling. The exemption is for people who have never been
  // sold to, once. An org that had a subscription has already seen the product work and has already
  // been shaped, so re-running the pitch for it is free compute with no pitch to make.
  const { app } = makeApp();
  const orgId = (await api(app, "me")).json.org_id as string;
  getIdentityStore().setPlan(orgId, { plan: "starter", status: "cancelled" });

  const res = await api(app, "tasks", draft(SHAPER, "draft_shape", { description: "a business" }));
  assert.equal(res.status, 402);
  assert.equal(res.json.plan_status, "cancelled");
  assert.match(res.json.error, /subscription ended/);
});

test("presubscription: trialing and past_due are untouched by any of this", async () => {
  // THE BUG: a margin guard that leaks onto paying customers. A trial runs at the full limits of the
  // plan being trialled, and `past_due` — a declined first charge — keeps the business running for
  // weeks while Stripe retries. Neither may be quietly moved onto an onboarding allowance.
  const { app } = makeApp();
  const id = getIdentityStore();
  const orgId = (await api(app, "me")).json.org_id as string;

  for (const status of ["trialing", "past_due"] as const) {
    id.setPlan(orgId, { plan: "growth", status });
    assert.equal(id.workBlockedBy(orgId), null, `${status} is not blocked at all`);
    const real = await api(app, "tasks", draft("books-keeper", "daily_sync"));
    assert.equal(real.status, 201, `${status} still runs real work`);
    // The model ceiling is part of the plan, and `PRESUB_PLAN` must not have crept onto it.
    assert.equal(resolveTier("deep", "growth"), "deep", `${status} keeps its plan's tier`);
  }
});

test("presubscription: an unpaid org cannot reach a tier it has never paid for", async () => {
  // THE BUG: `plan` is aspirational before payment. A cloud org is stamped with the plan it is ABOUT
  // to buy while `plan_status` stays `none`, so picking "Growth" on the pricing page and never
  // paying would otherwise hand a stranger the `deep` tier at 10× the token price. runtime.ts reads
  // the STATUS and pins these runs to `PRESUB_PLAN`.
  //
  // And `PRESUB_PLAN` is the cheapest SANE tier, not the cheapest one: a `fast` run once looped
  // eleven times on a tool schema it could not hold and was killed by the runtime ceiling having
  // delivered nothing, which is the most expensive kind of cheap.
  assert.equal(PLAN_MAX_TIER[PRESUB_PLAN], "standard");
  assert.equal(resolveTier("deep", PRESUB_PLAN), "standard", "clamped down, never refused");
});
