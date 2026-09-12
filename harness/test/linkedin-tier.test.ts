import { test } from "node:test";
import assert from "node:assert/strict";
import { accountTierFromMe } from "../src/linkedin/tier";

test("unknown /me is free — never assume Premium", () => {
  assert.equal(accountTierFromMe(undefined), "free");
  assert.equal(accountTierFromMe({}), "free");
  assert.equal(accountTierFromMe({ miniProfile: { firstName: "Ada" } }), "free");
});

test("named premium signals raise the tier; ads copy does not", () => {
  assert.equal(accountTierFromMe({ premiumSubscriber: true }), "premium");
  assert.equal(accountTierFromMe({ miniProfile: { premiumSubscriber: true } }), "premium");
  assert.equal(accountTierFromMe({ salesNavigatorSubscriber: true }), "sales_navigator");
  assert.equal(accountTierFromMe({ recruiter: true }), "recruiter");
  assert.equal(accountTierFromMe({ headline: "Try LinkedIn Premium" }), "free");
});
