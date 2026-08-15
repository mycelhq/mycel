// LinkedIn account tier from a /me payload — pacing ceilings depend on this.
//
// Treating a free member as Premium is how you get them restricted in a fortnight. Unknown → free.
// Premium / Sales Navigator / Recruiter only when the payload says so in named fields, not a
// substring hunt across the whole blob (LinkedIn ads "Premium" on free accounts constantly).

import type { AccountTier } from "../pacing";

function truthy(v: unknown): boolean {
  return v === true || v === "true" || v === 1;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function productsOf(me: Record<string, unknown>): string {
  const bags = [me.premiumProducts, me.premiumFeatures, me.subscriptions, me.memberBadges, me.premium];
  const bits: string[] = [];
  for (const b of bags) {
    if (typeof b === "string") bits.push(b);
    else if (Array.isArray(b)) bits.push(...b.map((x) => String(x)));
    else if (b && typeof b === "object") bits.push(...Object.keys(b as object));
  }
  return bits.join(" ").toLowerCase();
}

/** Fail closed: free unless a named premium signal is present. */
export function accountTierFromMe(me: unknown): AccountTier {
  const o = asRecord(me);
  const mini = asRecord(o.miniProfile);
  const products = productsOf(o) + " " + productsOf(mini);
  if (/\brecruiter\b/.test(products) || truthy(o.recruiter) || truthy(mini.recruiter)) return "recruiter";
  if (
    /sales[\s_-]*navigator/.test(products) ||
    truthy(o.salesNavigator) ||
    truthy(mini.salesNavigator) ||
    truthy(o.salesNavigatorSubscriber)
  ) {
    return "sales_navigator";
  }
  if (
    truthy(o.premiumSubscriber) ||
    truthy(mini.premiumSubscriber) ||
    truthy(o.premium) ||
    truthy(mini.premium) ||
    /\bpremium\b/.test(products)
  ) {
    return "premium";
  }
  return "free";
}
