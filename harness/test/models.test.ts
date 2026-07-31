import { test } from "node:test";
import assert from "node:assert/strict";
import { PLAN_MAX_TIER, TIER_MODELS, TIER_PRICE, isTier, modelForTier, resolveTier, wasClamped } from "../src/models";

test("models: a plan clamps the tier down rather than refusing the work", () => {
  // A free customer asking for deep reasoning gets a cheaper answer, not an error. The work still
  // happens — that is the point of a free tier — and the upgrade prompt belongs in the product
  // rather than in a failed run.
  assert.equal(resolveTier("deep", "free"), "fast");
  assert.equal(wasClamped("deep", "free"), true);

  assert.equal(resolveTier("deep", "starter"), "standard");
  assert.equal(resolveTier("standard", "starter"), "standard");
  assert.equal(wasClamped("standard", "starter"), false);

  assert.equal(resolveTier("deep", "growth"), "deep");
  // Someone running it themselves is spending their own money on their own key.
  assert.equal(resolveTier("deep", "self_hosted"), "deep");

  // Asking for LESS than the ceiling is always honoured — nobody is forced onto an expensive model.
  assert.equal(resolveTier("fast", "growth"), "fast");
  assert.equal(wasClamped("fast", "growth"), false);

  // No declared tier is "standard", not "the best one available".
  assert.equal(resolveTier(undefined, "growth"), "standard");
});

test("models: the tier ladder is actually ordered by price", () => {
  // The whole scheme is worthless if `fast` is not cheaper than `deep`. This catches a future edit
  // that swaps a model for a pricier one without noticing.
  assert.ok(TIER_PRICE.fast.in < TIER_PRICE.standard.in);
  assert.ok(TIER_PRICE.standard.in < TIER_PRICE.deep.in);
  assert.ok(TIER_PRICE.fast.out < TIER_PRICE.standard.out);
  assert.ok(TIER_PRICE.standard.out < TIER_PRICE.deep.out);

  for (const tier of ["fast", "standard", "deep"] as const) {
    assert.match(modelForTier(tier), /^openai\//, "every tier resolves to a real provider-qualified model");
  }
});

test("models: free never reaches the expensive tier", () => {
  // The one plan with no revenue attached must not be able to spend like the one that pays $380.
  assert.equal(PLAN_MAX_TIER.free, "fast");
  assert.notEqual(PLAN_MAX_TIER.free, "deep");
});

test("models: a wedge manifest is JSON and can say anything", () => {
  assert.equal(isTier("deep"), true);
  assert.equal(isTier("cheap"), false);
  assert.equal(isTier(undefined), false);
  assert.equal(isTier(7), false);
  // An unrecognised tier falls back to standard rather than to the most expensive model.
  assert.equal(resolveTier(undefined, "growth"), "standard");
});
