import { test } from "node:test";
import assert from "node:assert/strict";
import { api, makeApp } from "./helpers";
import {
  cloudMode,
  getIdentityStore,
  INACTIVE_LIMITS,
  PLAN_LIMITS,
  UNLIMITED_LIMITS,
} from "../src/identity";
import { resolveTier } from "../src/models";
import { auditList } from "../src/audit";
import { isSuperAdminEmail } from "../src/superadmin";

/**
 * The seven-day trial, the accounts with no ceilings, and the two things that must not go wrong at
 * the end of a trial: data vanishing, and work stopping without a reason.
 *
 * Every test here names the bug it prevents. Several of them are bugs that the previous shape of
 * this code actually had.
 */

const PW = "a-long-enough-password";
const uniq = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;

/** Run `fn` with MYCEL_CLOUD set, restoring it afterwards — plans differ by deployment. */
function inCloud<T>(fn: () => T): T {
  const before = process.env.MYCEL_CLOUD;
  process.env.MYCEL_CLOUD = "1";
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.MYCEL_CLOUD;
    else process.env.MYCEL_CLOUD = before;
  }
}

/**
 * Run `fn` with `emails` as the super-admin allowlist, restoring it afterwards.
 *
 * `await`s the result before restoring. The synchronous version of this helper was itself a bug:
 * with an async `fn`, the `finally` fired the instant the promise was RETURNED rather than settled,
 * so the allowlist was torn down before the first `await` inside the test resumed and every
 * assertion after it ran against an empty one. It failed loudly here; the same mistake in
 * production code is how a privilege check becomes intermittent.
 */
async function withSuperAdmins<T>(emails: string, fn: () => T | Promise<T>): Promise<T> {
  const before = process.env.MYCEL_SUPERADMIN_EMAILS;
  process.env.MYCEL_SUPERADMIN_EMAILS = emails;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.MYCEL_SUPERADMIN_EMAILS;
    else process.env.MYCEL_SUPERADMIN_EMAILS = before;
  }
}

// -------------------------------------------------------------------------------------------------
// The trial
// -------------------------------------------------------------------------------------------------

test("trial: a trialling org has the full limits of the plan it is trialling", () => {
  // THE BUG: a trial that behaves like the old free tier. Someone evaluating Growth for seven days
  // on 100 jobs and one seat is evaluating a product we do not sell, and the number that stops them
  // is one we invented rather than one they would ever pay for. `trialing` must fall through to the
  // plan's own row, for every plan, including the model tier.
  const id = getIdentityStore();
  const { org } = id.createOrgWithOwner("trialling-co", uniq("trial"), PW);

  id.setPlan(org.id, { plan: "growth", status: "trialing" });
  assert.deepEqual(id.limitsFor(org.id), PLAN_LIMITS.growth, "growth trial gets growth limits");
  assert.equal(id.workBlockedBy(org.id), null, "and may actually run work");
  // The tier ceiling is part of the plan. A Growth trial that silently ran on the cheaper model
  // would be a demo of something else.
  assert.equal(resolveTier("deep", "growth"), "deep");

  id.setPlan(org.id, { plan: "starter", status: "trialing" });
  assert.deepEqual(id.limitsFor(org.id), PLAN_LIMITS.starter, "starter trial gets starter limits");
  assert.notDeepEqual(id.limitsFor(org.id), PLAN_LIMITS.free, "and never the old free tier's");
});

test("trial: expiry stops new work but deletes nothing and always says why", async () => {
  // THE BUG, in two halves, and both of them were named as the part that must not be sloppy.
  //
  // Half one: a lapsed org losing its data. Nothing in the kernel deletes on a plan change, and this
  // proves it by counting what survives rather than by trusting that.
  //
  // Half two: scheduled work stopping silently. `INACTIVE_LIMITS.tasks_per_month` is 0, so a bare
  // numeric check would refuse with "your plan includes 0 jobs a month, and 0 have run" — which
  // reads as a bug, names no cause and offers no remedy. The refusal must carry `plan_inactive`.
  const { app } = makeApp();
  const id = getIdentityStore();
  const orgId = (await api(app, "me")).json.org_id as string;

  id.setPlan(orgId, { plan: "starter", status: "trialing" });
  const during = await api(app, "tasks", {
    method: "POST",
    body: JSON.stringify({ wedge: "books-keeper", task_type: "daily_sync", input: {} }),
  });
  assert.equal(during.status, 201, "work runs during the trial");
  const taskId = during.json.id as string;

  // The trial ends and the card is never charged successfully at all — the subscription is gone.
  id.setPlan(orgId, { status: "cancelled" });

  const after = await api(app, "tasks", {
    method: "POST",
    body: JSON.stringify({ wedge: "books-keeper", task_type: "daily_sync", input: {} }),
  });
  assert.equal(after.status, 402);
  assert.equal(after.json.code, "plan_inactive", "not task_limit — the cause is named");
  assert.equal(after.json.plan_status, "cancelled");
  assert.match(after.json.error, /stays where it is/, "and the founder is told nothing was lost");
  assert.doesNotMatch(after.json.error, /0 jobs/, "and never with arithmetic instead of a reason");

  // Half one: the work that already happened is still there, still readable, still theirs.
  const still = await api(app, `tasks/${taskId}`);
  assert.equal(still.status, 200, "the task a lapsed org already ran is not deleted");
  assert.equal(still.json.id, taskId);
  const list = await api(app, "tasks");
  assert.equal(list.status, 200, "and the list still answers rather than 402-ing a read");
});

test("trial: a failed first charge keeps the business running rather than stopping it", async () => {
  // THE BUG: treating a declined card as a cancellation. When a seven-day trial ends and the card
  // fails, Stripe moves the subscription to `past_due` and retries it for weeks. If that stopped
  // the business, a founder mid-engagement would find out from their own client not getting an
  // answer — which is far more damage than the unpaid invoice does to us.
  const { app } = makeApp();
  const id = getIdentityStore();
  const orgId = (await api(app, "me")).json.org_id as string;

  id.setPlan(orgId, { plan: "growth", status: "trialing" });
  id.setPlan(orgId, { status: "past_due" });

  assert.deepEqual(id.limitsFor(orgId), PLAN_LIMITS.growth, "full plan limits, not reduced ones");
  assert.equal(id.workBlockedBy(orgId), null);
  const run = await api(app, "tasks", {
    method: "POST",
    body: JSON.stringify({ wedge: "books-keeper", task_type: "daily_sync", input: {} }),
  });
  assert.equal(run.status, 201, "and the scheduled work actually still runs");
});

test("trial: a new cloud org is not a free tier while it has no subscription", () => {
  // THE BUG this whole change exists for: a new org landing on `free`, getting a LiteLLM key, and
  // burning model spend with no revenue and no commitment signal. `plan` now NAMES the plan they are
  // about to buy — so the billing screen has something honest to render — while `plan_status: "none"`
  // means it grants nothing. Reading `plan` as an entitlement is the mistake this guards against.
  inCloud(() => {
    const id = getIdentityStore();
    const { org } = id.createOrgWithOwner("brand-new", uniq("new"), PW);
    assert.equal(org.plan, "find", "named, so the product can say what they are signing up for");
    assert.equal(org.plan_status, "none", "but with nothing behind it");
    assert.deepEqual(id.limitsFor(org.id), INACTIVE_LIMITS, "and therefore entitled to nothing");
    assert.equal(id.workBlockedBy(org.id), "none");
  });
});

test("trial: a self-hosted install never acquires a paywall from any of this", () => {
  // THE BUG: the open-core bargain breaking as collateral damage. `MYCEL_CLOUD` is opt-in precisely
  // so that somebody who clones the repo cannot accidentally get one, and a `plan_status: "none"`
  // leaking into the non-cloud path would paywall every self-hoster on the next release.
  assert.equal(cloudMode(), false, "the test suite is not the hosted product");
  const id = getIdentityStore();
  const { org } = id.createOrgWithOwner("self-hoster", uniq("self"), PW);
  assert.equal(org.plan, "self_hosted");
  assert.equal(org.plan_status, "active");
  assert.deepEqual(id.limitsFor(org.id), PLAN_LIMITS.self_hosted);
  assert.equal(id.workBlockedBy(org.id), null);
});

test("trial: orgs already on the legacy free plan are grandfathered, not broken", () => {
  // THE BUG: leaving live orgs in a state no code path expects. There are real orgs on `free` in
  // production. Removing the row would make `limitsFor` fall through to `self_hosted` and hand them
  // UNMETERED spend — the exact failure this file's header describes, in reverse. They keep the
  // limits they have always had.
  const id = getIdentityStore();
  const { org } = id.createOrgWithOwner("legacy-co", uniq("legacy"), PW);
  id.setPlan(org.id, { plan: "free", status: "active" });
  assert.deepEqual(id.limitsFor(org.id), PLAN_LIMITS.free, "exactly what they had yesterday");
  assert.notDeepEqual(id.limitsFor(org.id), PLAN_LIMITS.self_hosted, "and emphatically not unmetered");
  assert.equal(id.workBlockedBy(org.id), null, "their scheduled work keeps running");
  assert.equal(resolveTier("deep", "free"), "standard", "still clamped to the tier they had");
});

test("trial: a plan change is written into the audit chain", async () => {
  // THE BUG: entitlement history being unreconstructable. The org row shows only what is true now
  // and Stripe shows charges rather than the decisions we made from them, so a trial that lapsed, a
  // card that failed and an operator moving somebody by hand are indistinguishable afterwards.
  const { app } = makeApp();
  const me = await api(app, "me");
  const projectId = (await api(app, "projects")).json[0].id as string;

  await api(app, "org/plan", {
    method: "PUT",
    body: JSON.stringify({ plan: "growth", status: "trialing", renews_at: "2026-08-14T00:00:00.000Z" }),
  });
  await api(app, "org/plan", { method: "PUT", body: JSON.stringify({ status: "past_due" }) });

  const entries = (await auditList(projectId, 50)).filter((e) => e.action === "org.plan_changed");
  assert.ok(entries.length >= 2, "both transitions are on the chain");
  // `auditList` returns the chain in append order, so the newest entry is the LAST one. Reading
  // `[0]` here passed for the wrong reason during development: it found the trialing transition and
  // agreed with an assertion that was also wrong.
  const latest = entries.at(-1)!;
  const detail = latest.detail as { from: { status?: string }; to: { status?: string } };
  assert.equal(detail.from.status, "trialing", "and it records what it moved FROM");
  assert.equal(detail.to.status, "past_due", "as well as to");
  // The audit log is readable by the tenant. Stripe's customer id is not something a chain entry
  // needs to carry to be useful, and `detail` is documented as non-secret.
  assert.ok(!("billing_ref" in (latest.detail as object)), "and never the billing account id");
  assert.equal(me.status, 200);
});

// -------------------------------------------------------------------------------------------------
// The accounts with no ceilings
// -------------------------------------------------------------------------------------------------

test("superadmin: an allowlisted owner's org has no ceilings anywhere", async () => {
  // THE BUG: a limit check that does not honour it. There is one answer to "is this actor
  // unlimited" — `orgIsUnlimited` — and every ceiling in the system reads it, so this asserts the
  // numeric limits, the plan-status gate, and the model tier together rather than one of the three.
  const email = uniq("founder");
  await withSuperAdmins(email, async () => {
    const { app } = makeApp();
    const id = getIdentityStore();
    const { org } = id.createOrgWithOwner("mycel-hq", email, PW);

    // Deliberately the worst case: no subscription at all, which is the normal state for our own org.
    assert.deepEqual(id.limitsFor(org.id), UNLIMITED_LIMITS);
    assert.equal(id.workBlockedBy(org.id), null, "and `none` does not stop them mid-demo");
    assert.equal(id.orgIsUnlimited(org.id), true);
    // The tier ceiling is a limit too. Reproducing a customer's deep-tier bug must not need a plan.
    assert.equal(resolveTier("deep", "starter", true), "deep");
    assert.equal(resolveTier("deep", "starter", false), "standard", "and only for them");

    const signin = await api(app, "auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password: PW }),
    });
    assert.equal(signin.status, 200);
    // `issue()` writes the entry fire-and-forget, deliberately: a failure to record the trail must
    // never block a sign-in. So the read has to yield the event loop once first.
    await new Promise((r) => setImmediate(r));
    const projectId = id.listProjects(org.id)[0].id;
    const entries = (await auditList(projectId, 50)).filter((e) => e.action === "superadmin.session");
    // THE BUG: an account that can do anything and leaves no trace. Recorded per sign-in rather than
    // per limit check, because `limitsFor` runs on every task and would produce noise, not a trail.
    assert.ok(entries.length >= 1, "the uncapped session is on the tamper-evident chain");
    assert.equal(entries.at(-1)!.actor, id.listMembers(org.id)[0].id, "attributed to the person");
  });
});

test("superadmin: it cannot be granted through any authenticated route", async () => {
  // THE BUG, and the reason it is an env allowlist rather than a column: every value in this system
  // has a route that writes it. `prefs` is a free-form, member-writable store returned from /v1/me,
  // so a flag living there would be self-grantable with one PATCH. This walks every authenticated
  // write surface that touches a Member or an Org and proves none of them moves the needle.
  const { app } = makeApp();
  const id = getIdentityStore();
  const email = uniq("climber");
  const signup = await api(app, "auth/signup", {
    method: "POST",
    body: JSON.stringify({ email, password: PW }),
  });
  assert.equal(signup.status, 201);
  const session = signup.json.token as string;
  const orgId = signup.json.member.org_id as string;
  const memberId = signup.json.member.id as string;
  assert.equal(id.orgIsUnlimited(orgId), false, "nobody starts uncapped");

  // 1. Their own preferences — the free-form bag.
  const prefs = await api(
    app,
    "me/prefs",
    {
      method: "PATCH",
      body: JSON.stringify({ superadmin: true, unlimited: true, is_super_admin: true, role: "superadmin" }),
    },
    session,
  );
  assert.equal(prefs.status, 200, "the write is accepted — prefs are free-form by design");
  assert.equal(id.orgIsUnlimited(orgId), false, "and means nothing");
  // Asserted on `orgIsUnlimited` rather than on the limits object. Under a self-hosted test
  // environment the plan is `self_hosted`, whose limits are structurally identical to
  // UNLIMITED_LIMITS — so comparing the tables would have "passed" while proving nothing.

  // 2. The plan route — the one place entitlement is legitimately written. A session cannot use it
  //    at all, and even the control plane's own key cannot express "unlimited" as a plan.
  const asMember = await api(app, "org/plan", { method: "PUT", body: JSON.stringify({ plan: "scale" }) }, session);
  assert.equal(asMember.status, 403);
  const asKey = await api(app, "org/plan", { method: "PUT", body: JSON.stringify({ plan: "unlimited" }) });
  assert.equal(asKey.status, 400, "there is no such plan, and there deliberately never will be");
  assert.equal(id.orgIsUnlimited(orgId), false);

  // 3. Role escalation. Even owner — the role `orgIsUnlimited` looks at — grants nothing on its own;
  //    the allowlist is about the ADDRESS, and the address came from the member row, not the wire.
  const role = await api(app, `team/members/${memberId}`, { method: "PATCH", body: JSON.stringify({ role: "owner" }) }, session);
  assert.equal(id.orgIsUnlimited(orgId), false, `role write (${role.status}) grants nothing`);

  // 4. And the thing that actually does it is not reachable from a request at all.
  assert.equal(isSuperAdminEmail(email), false);
  await withSuperAdmins(email, () => {
    assert.equal(isSuperAdminEmail(email), true, "only a deployment credential can do this");
    assert.deepEqual(id.limitsFor(orgId), UNLIMITED_LIMITS);
  });
  assert.equal(id.orgIsUnlimited(orgId), false, "and it goes away when the env does");
});

test("superadmin: a non-admin on the same deployment is still gated", async () => {
  // THE BUG: an exemption that leaks. A super-admin existing must change nothing for anybody else,
  // so this runs an ordinary org WITH the allowlist populated and asserts every ceiling still bites.
  await withSuperAdmins(uniq("someone-else"), async () => {
    const { app } = makeApp();
    const id = getIdentityStore();
    const orgId = (await api(app, "me")).json.org_id as string;

    id.setPlan(orgId, { plan: "starter", status: "active" });
    assert.deepEqual(id.limitsFor(orgId), PLAN_LIMITS.starter, "the plan's row, not UNLIMITED_LIMITS");
    assert.equal(resolveTier("deep", "starter"), "standard", "still clamped to their tier");

    // The project ceiling still refuses at the number the plan advertises.
    const owner = id.listMembers(orgId)[0];
    const login = await api(app, "auth/login", {
      method: "POST",
      body: JSON.stringify({ email: owner.email, password: process.env.MYCEL_OWNER_PASSWORD ?? "secret" }),
    });
    assert.equal(login.status, 200);
    const session = login.json.token as string;
    let refused: { status: number; json: { code?: string } } | null = null;
    for (let i = 0; i < 4 && !refused; i++) {
      const r = await api(app, "projects", { method: "POST", body: JSON.stringify({ name: `p${i}` }) }, session);
      if (r.status === 402) refused = r;
    }
    assert.ok(refused, "an ordinary org still meets its project ceiling");
    assert.equal(refused!.json.code, "project_limit");

    id.setPlan(orgId, { status: "cancelled" });
    assert.deepEqual(id.limitsFor(orgId), INACTIVE_LIMITS, "and cancelling still stops them");
  });
});

test("superadmin: an uncapped member does not uncap a tenant they were invited into", async () => {
  // THE BUG, and it is a cross-tenant one: if ANY member sufficed, then the moment a super-admin
  // accepted an invitation into a customer's org — to debug something, which is exactly why they
  // would — that customer's limits would come off and their model bill would be whatever their
  // agents felt like spending. `orgIsUnlimited` looks at the OWNER, which is the account that
  // created the org and can be neither changed nor removed.
  const admin = uniq("cofounder");
  await withSuperAdmins(admin, async () => {
    const { app } = makeApp();
    const id = getIdentityStore();

    // A customer's org, owned by the customer.
    const { org: theirs } = id.createOrgWithOwner("a-customer", uniq("customer"), PW);
    id.setPlan(theirs.id, { plan: "starter", status: "active" });
    assert.deepEqual(id.limitsFor(theirs.id), PLAN_LIMITS.starter);

    // The super-admin joins it as an admin, the way a support session actually happens.
    const invited = id.invite({ orgId: theirs.id, email: admin, role: "admin", invitedBy: "op" });
    assert.ok(!("error" in invited), "the invitation is fine — this is a normal thing to do");
    const accepted = await api(app, `invites/${(invited as { token: string }).token}/accept`, {
      method: "POST",
      body: JSON.stringify({ password: PW }),
    });
    assert.equal(accepted.status, 201);

    assert.equal(id.orgIsUnlimited(theirs.id), false, "the customer's ceilings are still the customer's");
    assert.deepEqual(id.limitsFor(theirs.id), PLAN_LIMITS.starter);
    const joined = id.listMembers(theirs.id).find((m) => m.email === admin.toLowerCase())!;
    assert.equal(id.isSuperAdminMember(joined.id), true, "though the person is still one");
  });
});

test("superadmin: the allowlist is empty by default and matched case-insensitively", async () => {
  // THE BUG: an intermittent privilege check. Emails are stored lowercased on every write path in
  // identity.ts, so a case-sensitive comparison would produce someone who is a super-admin depending
  // on how they typed their address into the sign-in box — the worst failure mode a privilege check
  // can have. And an unset variable must mean nobody, so CI and every self-hosted install fail closed.
  assert.equal(isSuperAdminEmail("anyone@example.com"), false, "empty allowlist grants nobody");
  assert.equal(isSuperAdminEmail(undefined), false);
  assert.equal(isSuperAdminEmail(""), false);
  await withSuperAdmins(" Founder@Mycel.Dev , second@mycel.dev ", () => {
    assert.equal(isSuperAdminEmail("founder@mycel.dev"), true);
    assert.equal(isSuperAdminEmail("FOUNDER@MYCEL.DEV"), true);
    assert.equal(isSuperAdminEmail("second@mycel.dev"), true, "whitespace and commas are tolerated");
    assert.equal(isSuperAdminEmail("founder@mycel.dev.attacker.com"), false, "and it is exact, not a prefix");
  });
});

test("superadmin: an uncapped org's limits do not leak across tenants", async () => {
  // THE BUG: cross-tenant leakage through the entitlement path. Two cross-tenant leaks have shipped
  // here, so the exemption is asserted to be per-org rather than global — including that a task
  // resolves its ceiling from ITS OWN project's org and not from whoever enqueued it.
  const admin = uniq("hq");
  await withSuperAdmins(admin, async () => {
    const id = getIdentityStore();
    const { org: ours } = id.createOrgWithOwner("mycel-hq", admin, PW);
    const { org: theirs, project: theirProject } = id.createOrgWithOwner("acme", uniq("acme"), PW);
    id.setPlan(theirs.id, { plan: "starter", status: "active" });

    assert.deepEqual(id.limitsFor(ours.id), UNLIMITED_LIMITS);
    assert.deepEqual(id.limitsFor(theirs.id), PLAN_LIMITS.starter, "the neighbour is untouched");
    assert.equal(id.orgIsUnlimited(theirs.id), false);

    // A project id belonging to the other tenant must resolve to the other tenant's ceiling — this
    // is the lookup `runtime.ts` performs to pick a model tier for a run.
    assert.equal(id.getProject(theirProject.id)?.org_id, theirs.id);
    assert.equal(id.orgIsUnlimited(id.getProject(theirProject.id)!.org_id), false);
    // And an unowned task ("" org) can never come out uncapped.
    assert.equal(id.orgIsUnlimited(""), false);
  });
});
