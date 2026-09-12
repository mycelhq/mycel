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
import { TIER_MODELS, modelsUpToCeiling, resolveTier, type ModelTier } from "./models";
import { splitModel } from "./opencode";
import { getIdentityStore } from "./identity";
import { PRESUB_MAX_SPEND_USD, PRESUB_PLAN } from "./presubscription";

const base = () => process.env.MYCEL_LITELLM_URL?.replace(/\/+$/, "");
const master = () => process.env.MYCEL_LITELLM_MASTER_KEY;

/** True when model calls are brokered through a proxy that enforces budgets. */
export const litellmEnabled = (): boolean => !!base() && !!master();

/**
 * The operator's own provider credential, for deployments that broker nothing.
 *
 * `OPENAI_API_KEY` is the name `resolveUpstream` already uses via `providerEnvVar`, and
 * `MYCEL_LLM_UPSTREAM` the base it already honours — so a self-hoster who configured the agent
 * runtime has, by that act, configured this too. Nothing new to set and nothing new to learn.
 */
function directCredential(): { base: string; key: string } | undefined {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) return undefined;
  const upstream = (process.env.MYCEL_LLM_UPSTREAM ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  return { base: upstream, key };
}

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

/*
 * Models a plan may reach — the tier ceiling, expressed as an allowlist the proxy enforces.
 *
 * This used to be a local `modelsForPlan` that walked the tier ladder itself. It is now
 * `modelsUpToCeiling` in models.ts, next to `resolveTier`, because the two were a second and third
 * copy of the same ladder and had already drifted once — see the note below on the provider prefix,
 * which is what that drift cost. One function, one ceiling, and the super-admin bypass therefore
 * cannot apply to the resolver and miss the allowlist.
 *
 * The comment that lived here is worth keeping, because it records a real outage:
 *
 * The names are provider-qualified, exactly as TIER_MODELS spells them and exactly as they are
 * registered with the proxy (`model_name: "openai/gpt-5.6-luna"`, see scripts/litellm-models.js).
 *
 * This used to strip the prefix, under the comment "the proxy speaks bare model ids". That was a
 * belief about the proxy, not a fact about it: LiteLLM matches a key's allowlist against the
 * registered `model_name` verbatim. Once the models were registered provider-qualified, every
 * request was refused with "key not allowed to access model", after the model itself had already
 * resolved — an authorization failure wearing the costume of a configuration one.
 *
 * TIER_MODELS is the single source of truth for these strings. Three places had quietly grown their
 * own convention: this allowlist, the proxy grant, and the sandbox's own config. Only the sandbox
 * one is genuinely different, and for a reason — inside the sandbox the provider is `mycel`, which
 * is what keeps the real key out of it.
 */

/**
 * The virtual key for this org, minting one if needed.
 *
 * Re-issued when the plan changes, because both the budget and the model allowlist are baked into
 * the key at creation. A customer who upgrades and still holds a key capped at the old plan's
 * budget would hit a ceiling they have already paid to remove.
 */
export async function keyForOrg(orgId: string): Promise<string | undefined> {
  if (!litellmEnabled()) return undefined;
  // FRESH, not the replica's memory. A warm worker's in-memory org keeps the plan it had at
  // hydration, and the vault comparison below then agrees with the stale plan — so an upgrade
  // changed nothing until the worker rolled (observed in prod 2026-08-16; a growth org was refused
  // the deep model with "key not allowed to access model"). One row-read per run buys the plan the
  // founder is actually on. See IdentityStore.freshOrg.
  const org = await getIdentityStore().freshOrg(orgId);

  /**
   * AN ORG THAT HAS NOT SUBSCRIBED YET IS NOT AN ORG WITH A $0 BUDGET.
   *
   * `limitsFor` answers `INACTIVE_LIMITS` for `plan_status: "none"`, whose
   * `model_spend_usd_per_month` is 0, so this minted a key with `max_budget: 0`. That was correct
   * for everything such an org could do, which until now was nothing.
   *
   * It stopped being correct the moment onboarding's own drafting runs were allowed to happen
   * before the card — see presubscription.ts and the production deadlock it names. Without this,
   * `POST /v1/tasks` accepts the run, the founder watches it start, and the model call is refused
   * at the proxy for exceeding a budget of zero: a task reported as running that cannot do
   * anything, which is this repo's most expensive bug shape wearing a spinner.
   *
   * The budget granted IS the allowance, so the proxy enforces the same number the route does
   * rather than a second one that can drift from it. `cancelled` is deliberately untouched and
   * keeps its $0 key, because it may not run anything at all.
   */
  const presub = org?.plan_status === "none" && !getIdentityStore().orgIsUnlimited(orgId);
  const plan = presub ? PRESUB_PLAN : (org?.plan ?? "self_hosted");
  const budget = presub
    ? PRESUB_MAX_SPEND_USD
    : getIdentityStore().limitsFor(orgId).model_spend_usd_per_month;

  // Computed before the cache check so it can be compared, and reused when minting — one source for
  // both, so they cannot drift apart the way the allowlist and the registered names did.
  //
  // A super-admin org gets the full ladder AND, via `limitsFor` above, a null budget — so the key it
  // holds is genuinely uncapped rather than uncapped in our code and capped at the proxy, which is
  // the failure this file already has a paragraph about.
  const models = modelsUpToCeiling(plan, getIdentityStore().orgIsUnlimited(orgId));
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

/**
 * ONE non-streaming completion, on the org's own virtual key.
 *
 * WHY THIS EXISTS AT ALL. Until now every model call in the kernel happened inside a sandbox and
 * reached the provider through `/v1/internal/llm/*`, which pins the model to a run's grant. Grounded
 * answering (`ask.ts`) has no sandbox and no run — a founder typed a question and is waiting — so it
 * needs a server-side call. That is exactly the moment somebody reaches for `process.env.OPENAI_API_KEY`
 * and quietly opens an unmetered path around every budget in the product.
 *
 * So this is the only server-side model call, and it has the same three properties the proxy path
 * has: the key is the ORG's LiteLLM virtual key (budgeted, allowlisted, attributable), the model is
 * resolved from `resolveTier` against the org's plan rather than from a caller, and the token count
 * is capped here.
 *
 * Returns undefined when LiteLLM is not configured or the call fails. EVERY caller must have a
 * deterministic answer for that case — a feature that breaks when the proxy is down is a feature
 * that cannot ship, and a grounded answer composed from retrieved rows is degradable by design.
 */
export async function chatComplete(args: {
  orgId: string;
  tier: ModelTier;
  system: string;
  user: string;
  maxTokens?: number;
  timeoutMs?: number;
}): Promise<string | undefined> {
  /**
   * ═══ A SELF-HOSTER WITH A PROVIDER KEY GETS NOTHING FROM THIS FUNCTION, AND SHOULD ═══
   *
   * This returned `undefined` whenever LiteLLM was absent, and six features are built on it: the
   * answer box (`ask`), the chat, ads copy, the proposal composer and the outreach composer. Every
   * one of them silently degrades to "write your own" on any deployment that has not stood up a
   * LiteLLM — which is every self-hosted kernel, i.e. the thing the open-source repo asks people to
   * run.
   *
   * The agent path solved this long ago: `resolveUpstream` in runtime.ts brokers through LiteLLM
   * when it is configured and falls back to the operator's own provider key when it is not. There
   * was no argument for the two paths differing; this one had simply never been taught the rule.
   *
   * ═══ AND THE FALLBACK CANNOT SILENTLY UN-BUDGET A HOSTED DEPLOYMENT ═══
   *
   * The broker is what enforces per-org budgets and the model allowlist, so a direct key is an
   * UNMETERED key. That is correct for a self-hoster spending their own money and wrong for a
   * multi-tenant host, where a mis-set `MYCEL_LITELLM_URL` would quietly move every tenant onto one
   * unbudgeted credential.
   *
   * It cannot happen by accident here: the direct path requires LiteLLM to be entirely absent AND a
   * provider key to be present. In the cloud LiteLLM is always configured, so the branch is dead
   * there — the same structural argument `resolveUpstream` makes, in the same shape.
   */
  const direct = !litellmEnabled() ? directCredential() : undefined;
  if (!litellmEnabled() && !direct) return undefined;
  const key = direct ? direct.key : await keyForOrg(args.orgId);
  if (!key) return undefined;
  const plan = getIdentityStore().getOrg(args.orgId)?.plan;
  // Clamped to the plan's ceiling by the same function the run path uses, so a founder on Starter
  // does not get a deep-tier bill through the answer box. A direct deployment has no plan to clamp
  // to and no broker to enforce it, so the tier maps straight through.
  /**
   * ═══ THE PROVIDER PREFIX IS FOR THE BROKER, AND THE DIRECT PATH HAS NO BROKER ═══
   *
   * Every entry in TIER_MODELS is written `openai/gpt-5.6-luna`, because LiteLLM routes on that
   * prefix. `api.openai.com` does not — it answers `The model 'openai/gpt-5.6-luna' does not exist`,
   * which `chatComplete` turns into `undefined`, which is the silent "write your own" again.
   *
   * So the direct path sends the model id and the proxy path sends the qualified name. Which
   * provider it is was already decided by `MYCEL_LLM_UPSTREAM`; repeating it in the model name only
   * gives the endpoint a string it cannot parse.
   */
  const model = direct
    ? splitModel(process.env.MYCEL_MODEL ?? TIER_MODELS[args.tier]).modelId
    : TIER_MODELS[resolveTier(args.tier, plan, getIdentityStore().orgIsUnlimited(args.orgId))];
  const endpoint = direct ? direct.base : base();
  /**
   * ═══ `reasoning_effort: "minimal"` IS NOT UNIVERSAL, AND THE 400 IS INDISTINGUISHABLE FROM MUTE ═══
   *
   * Every tier in TIER_MODELS accepts it, so the hosted deployment has never seen this — verified:
   * zero `litellm completion failed` in production over three hours. Point the same code at a model
   * that does not, and OpenAI answers:
   *
   *   'reasoning_effort' does not support 'minimal' with this model.
   *   Supported values are: 'none', 'low', 'medium', and 'high'.
   *
   * Which `chatComplete` turns into `undefined`, which every caller turns into "write your own".
   * A self-hoster would see six features quietly do nothing and have no way to know why.
   *
   * So the call retries ONCE without the field. Not by pre-detecting the model — a list of which
   * models accept which values is a list that is wrong the week after it is written — but by
   * reading the provider's own refusal, which is the only source that is never out of date.
   * Production keeps sending `minimal` and never reaches the retry.
   */
  const bodyFor = (effort: string | undefined) =>
    JSON.stringify({
      model,
      // GPT-5-class models (every tier — see TIER_MODELS in models.ts) reject two things this call
      // used to send, and either one is a 400 that killed every chatComplete caller (the GTM
      // opener, ads, proposals) down to a silent "write your own":
      //   · `temperature` other than the default 1 ("does not support 0.2 with this model"), and
      //   · `max_tokens` — they demand `max_completion_tokens`.
      // The proxy does NOT honour a per-request `drop_params`, so the fix is to simply not send the
      // offending shapes: omit temperature (accept the default) and use max_completion_tokens. If a
      // future tier points at an older model that wants the old shapes, this is where to branch.
      //
      // TWO reasoning-model gotchas fold in here. First, `max_completion_tokens` on a GPT-5-class
      // model bounds reasoning tokens AND output tokens together — so the caller's `maxTokens: 160`
      // (a short opener) was entirely eaten by reasoning, the model returned EMPTY visible content,
      // and `draftFirstMessage` read that as "couldn't draft" with no error to show (a SUCCESS with
      // no text logs nothing). We give the model real headroom regardless of the caller's small
      // output ask, and rely on the prompt + `clip()` downstream to keep the message short. Second,
      // `reasoning_effort: "minimal"` — these are grounded, write-one-paragraph-from-facts calls,
      // not puzzles; minimal reasoning keeps them fast, cheap, and leaves the budget for output.
      max_completion_tokens: Math.min(Math.max(Math.floor(args.maxTokens ?? 500), 1600), 4000),
      ...(effort ? { reasoning_effort: effort } : {}),
      messages: [
        { role: "system", content: args.system },
        { role: "user", content: args.user },
      ],
    });
  const send = (effort: string | undefined) => ({
    method: "POST" as const,
    signal: AbortSignal.timeout(args.timeoutMs ?? 25_000),
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: bodyFor(effort),
  });

  let res = await fetch(`${endpoint}/chat/completions`, send("minimal"));
  if (res.status === 400) {
    // Read the refusal before deciding. Only THIS complaint is retryable; every other 400 is a real
    // fault and swallowing it behind a retry would hide it.
    const text = await res.clone().text();
    if (/reasoning_effort/i.test(text)) {
      res = await fetch(`${endpoint}/chat/completions`, send(undefined));
    }
  }
  try {
    if (!res.ok) {
      // The BODY, not just the status: a 400 here is almost always the provider naming the exact
      // offending field (a model it does not know, `temperature` a reasoning model won't take, or
      // `max_tokens` where it now demands `max_completion_tokens`). Logging the status alone left the
      // GTM opener silently degrading to "write your own" with no way to see why. Truncated because a
      // provider error can carry the echoed request.
      console.error(
        `[mycel] litellm completion failed: ${res.status} model=${model} :: ${(await res.text().catch(() => "")).slice(0, 400)}`,
      );
      return undefined;
    }
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = body.choices?.[0]?.message?.content;
    return typeof text === "string" && text.trim() ? text : undefined;
  } catch (e) {
    console.error("[mycel] litellm completion unreachable:", (e as Error).message);
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
