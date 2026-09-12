// Orgs that SHOW the product without RUNNING it.
//
// ═══ WHAT A SHOWROOM ORG IS ═══
//
// A tenant strangers are invited into, holding a seeded business they can read, click through and
// judge — and which must never spend anything on their behalf. demo.mycelai.dev is one. There is no
// reason to expect it to be the last: a sandbox for a trial, a fixture for a screenshot, a tenant a
// support engineer reproduces a bug in.
//
// ═══ WHY THE EXISTING CEILINGS WERE NOT ENOUGH ═══
//
// The demo tenant already had every control that exists: model budget zero at the LiteLLM gateway,
// schedules disabled, connections deleted. A visitor still could not spend a token or reach the
// outside world.
//
// And clicking "Build my site" still cost something. Task creation checks
// `limits.model_spend_usd_per_month`, which reads the PLAN ($90 on growth) — not the budget the
// org's key actually carries (zero). So the task was created, a sandbox booted, the model call was
// refused at the gateway, and the run died. No tokens, no reach, and one microVM per click for
// anyone bored enough to keep clicking.
//
// That gap is not really about demos. Any org whose key budget sits below its plan ceiling — a
// downgrade, a hand-edited budget, a partial outage — creates tasks that boot infrastructure to
// discover they cannot run. This is the narrow, explicit half of that fix.
//
// ═══ WHY AN ENV ALLOWLIST, NOT A COLUMN ═══
//
// The same argument `superadmin.ts` makes, in the opposite direction. A column is a value, and every
// value here has an authenticated route that writes it; a flag that REMOVES a tenant's ability to
// run is one bad PATCH away from being cleared by whoever it was meant to constrain. `process.env`
// is reachable from no request at all, so the property is not "no route writes it today" but "no
// route can".
//
// The cost is that adding a showroom needs a redeploy. For a tenant whose defining feature is that
// it does not act, that is the right trade.

/**
 * Read at call time rather than module load, so a test can set it and a redeploy takes effect on
 * the next request rather than the next process.
 */
export function showroomOrgIds(): Set<string> {
  const raw = process.env.MYCEL_SHOWROOM_ORG_IDS ?? "";
  return new Set(
    raw
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

/** True when this org exists to be looked at rather than used. */
export function isShowroomOrg(orgId?: string | null): boolean {
  if (!orgId) return false;
  return showroomOrgIds().has(orgId.trim());
}

/**
 * What a visitor is told.
 *
 * Names the situation rather than blaming them or pretending something broke. Somebody clicking
 * "Build my site" in a demo has done nothing wrong and should not be shown an error that reads like
 * one — the honest sentence is that this tenant is a showroom, and where the real thing lives.
 */
export const SHOWROOM_REFUSAL =
  "This is a demo workspace — it shows a business that has already run, so nothing new starts here. " +
  "Everything you can see is real; only the running is switched off.";

/**
 * WHICH OF THE CONFIGURED SHOWROOM IDS NAME NO ORG THAT EXISTS.
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * A GUARD THAT PROTECTS NOTHING LOOKS EXACTLY LIKE A GUARD THAT WORKS
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `MYCEL_SHOWROOM_ORG_IDS` held `e349fa95-f41c-44db-bea7-0d0d26903733` in production. No org has
 * ever had that id. So `isShowroomOrg` returned false for everything, every call site behaved
 * correctly, every test passed, and the demo tenant — the one thing this exists to freeze — ran
 * 5,094 tasks and failed 1,169 of them.
 *
 * Two costs, and the second is the one that hurt paying work. The landing page embeds that tenant,
 * so a visitor read "409 jobs run, 98 did not finish" on the screen we sell with. And those runs
 * take Daytona disk, where "Total disk limit exceeded. Maximum allowed: 300GiB" is a top-three
 * reason REAL customer runs fail. The demo was starving production.
 *
 * Nothing in the code was wrong. The only way to catch it is to check the RESOURCE the guard claims
 * to protect, which is what this does: at boot, resolve every configured id against the orgs that
 * actually exist and say loudly which ones do not.
 *
 * PURE, so the rule is testable without a store. The caller supplies the ids that exist.
 */
export function unknownShowroomOrgs(configured: Iterable<string>, existing: Iterable<string>): string[] {
  const known = new Set([...existing].map((id) => id.trim()).filter(Boolean));
  return [...configured].map((id) => id.trim()).filter((id) => id && !known.has(id));
}

/**
 * Say so at boot, once, at error level.
 *
 * `console.error` rather than a throw: a self-hoster with a stale id in their env should not be
 * unable to start, and a deployment that cannot boot because a DEMO tenant is misconfigured has
 * turned a cosmetic problem into an outage. Loud and running beats silent or dead.
 */
export function reportShowroomConfig(existingOrgIds: Iterable<string>): string[] {
  const missing = unknownShowroomOrgs(showroomOrgIds(), existingOrgIds);
  if (missing.length) {
    console.error(
      `[mycel] MYCEL_SHOWROOM_ORG_IDS names ${missing.length} org(s) that do not exist: ${missing.join(", ")}. ` +
        `Those tenants are NOT frozen — they will create tasks, spawn sandboxes and consume disk.`,
    );
  }
  return missing;
}
