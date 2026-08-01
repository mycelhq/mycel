// Per-tenant model budgets, enforced at the provider boundary.
//
// The kernel already refuses a task when the org is over its monthly spend ceiling. That check runs
// ONCE, at task creation, against costs recorded by previous runs — so it cannot stop the run that
// is currently happening. A single task that finds a way to make a thousand model calls blows
// through the ceiling and the kernel only notices afterwards, when the money is spent.
//
// LiteLLM closes that. Each org gets a virtual key with `max_budget` and `budget_duration`, and the
// proxy refuses the request itself once the budget is gone. The kernel's check becomes the polite
// early warning; this is the actual limit.
//
// It also buys three things worth having on their own:
//   · One place that knows what every tenant spent, rather than a sum over our own task rows.
//   · Provider fallback — when OpenAI rate-limits, work continues instead of failing.
//   · A model allowlist per key, so a plan's tier ceiling is enforced by the proxy too, not only by
//     our own resolution logic.
//
// Absent unless MYCEL_LITELLM_URL and MYCEL_LITELLM_MASTER_KEY are set. Without them the kernel
// behaves exactly as before: the provider key goes to the sandbox and the ceiling is advisory.
import { getSecret, setSecret } from "./secrets";
import { PLAN_MAX_TIER, TIER_MODELS, type ModelTier } from "./models";
import { getIdentityStore, type Plan } from "./identity";

const base = () => process.env.MYCEL_LITELLM_URL?.replace(/\/+$/, "");
const master = () => process.env.MYCEL_LITELLM_MASTER_KEY;

/** True when model calls are brokered through a proxy that enforces budgets. */
export const litellmEnabled = (): boolean => !!base() && !!master();

const vaultKey = (orgId: string) => `litellm:org:${orgId}`;

interface StoredKey {
  key: string;
  /** The budget it was minted with, so a plan change can be detected and the key re-issued. */
  budget: number | null;
  plan: string;
  /**
   * The allowlist it was minted with, joined.
   *
   * Without this, a cached key is reused whenever plan and budget still match — so changing what
   * `modelsForPlan` returns has no effect on any org that already has a key, forever. That is
   * exactly how a corrected allowlist failed to correct anything: the code was right, the minted key
   * was still wrong, and nothing compared them.
   *
   * Optional because keys minted before this field existed have no value for it; absent counts as a
   * mismatch, which re-mints once and then stops.
   */
  models?: string;
}

/** Models a plan may reach — the tier ceiling, expressed as an allowlist the proxy enforces. */
function modelsForPlan(plan: Plan | undefined): string[] {
  const ceiling = PLAN_MAX_TIER[plan ?? "self_hosted"] ?? "deep";
  const order: ModelTier[] = ["fast", "standard", "deep"];
  // Provider-qualified, exactly as TIER_MODELS names them and exactly as they are registered with
  // the proxy (`model_name: "openai/gpt-5.6-luna"`, see scripts/litellm-models.js).
  //
  // This used to strip the prefix, under the comment "the proxy speaks bare model ids". That was a
  // belief about the proxy, not a fact about it: LiteLLM matches a key's allowlist against the
  // registered `model_name` verbatim. Once the models were registered provider-qualified, every
  // request was refused with "key not allowed to access model", after the model itself had already
  // resolved — an authorization failure wearing the costume of a configuration one.
  //
  // TIER_MODELS is the single source of truth for these strings. Three places had quietly grown
  // their own convention: this allowlist, the proxy grant, and the sandbox's own config. Only the
  // sandbox one is genuinely different, and for a reason — inside the sandbox the provider is
  // `mycel`, which is what keeps the real key out of it.
  return order.slice(0, order.indexOf(ceiling) + 1).map((t) => TIER_MODELS[t]);
}

/**
 * The virtual key for this org, minting one if needed.
 *
 * Re-issued when the plan changes, because both the budget and the model allowlist are baked into
 * the key at creation. A customer who upgrades and still holds a key capped at the old plan's
 * budget would hit a ceiling they have already paid to remove.
 */
export async function keyForOrg(orgId: string): Promise<string | undefined> {
  if (!litellmEnabled()) return undefined;
  const org = getIdentityStore().getOrg(orgId);
  const plan = org?.plan ?? "self_hosted";
  const budget = getIdentityStore().limitsFor(orgId).model_spend_usd_per_month;

  // Computed before the cache check so it can be compared, and reused when minting — one source for
  // both, so they cannot drift apart the way the allowlist and the registered names did.
  const models = modelsForPlan(plan);
  const wanted = models.join(",");

  const cached = await getSecret(vaultKey(orgId));
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as StoredKey;
      if (parsed.plan === plan && parsed.budget === budget && parsed.models === wanted) return parsed.key;
      // Plan, budget or allowlist changed — fall through and mint a key that matches the code.
    } catch {
      /* corrupt entry; mint a fresh one rather than wedging model calls forever */
    }
  }

  try {
    const res = await fetch(`${base()}/key/generate`, {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${master()}`, "content-type": "application/json" },
      body: JSON.stringify({
        models,
        // null means unmetered — a self-hosted operator's own key and own bill.
        ...(budget === null ? {} : { max_budget: budget, budget_duration: "30d" }),
        metadata: { mycel_org_id: orgId, plan },
        // So spend is attributable in LiteLLM's own dashboard without joining against our database.
        user_id: orgId,
      }),
    });
    if (!res.ok) {
      console.error(`[mycel] litellm key mint failed: ${res.status} ${await res.text()}`);
      return undefined;
    }
    const { key } = (await res.json()) as { key: string };
    await setSecret(vaultKey(orgId), JSON.stringify({ key, budget, plan, models: wanted } satisfies StoredKey));
    return key;
  } catch (e) {
    // Never fail a run because the budget broker is unreachable. The kernel's own ceiling still
    // applies at task creation, so this degrades to the previous behaviour rather than to no limit.
    console.error("[mycel] litellm unreachable:", (e as Error).message);
    return undefined;
  }
}

/** What this org has actually spent, according to the proxy rather than our own accounting. */
export async function spendForOrg(orgId: string): Promise<{ spend: number; budget: number | null } | undefined> {
  if (!litellmEnabled()) return undefined;
  const cached = await getSecret(vaultKey(orgId));
  if (!cached) return undefined;
  try {
    const { key } = JSON.parse(cached) as StoredKey;
    const res = await fetch(`${base()}/key/info?key=${encodeURIComponent(key)}`, {
      signal: AbortSignal.timeout(8_000),
      headers: { authorization: `Bearer ${master()}` },
    });
    if (!res.ok) return undefined;
    const info = (await res.json()) as { info?: { spend?: number; max_budget?: number | null } };
    return { spend: info.info?.spend ?? 0, budget: info.info?.max_budget ?? null };
  } catch {
    return undefined;
  }
}
