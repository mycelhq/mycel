import { test } from "node:test";
import assert from "node:assert/strict";
import { api, makeApp } from "./helpers";
import { getIdentityStore, PLAN_LIMITS } from "../src/identity";

const PW = "a-long-enough-password";

test("plan: running it yourself is unmetered, and that is the default", async () => {
  // The whole open-core bargain. Someone who clones the repo must never meet a paywall, so the
  // default plan's limits are all null and every enforcement path is a no-op.
  const { app } = makeApp();
  const r = await api(app, "org");
  assert.equal(r.status, 200);
  assert.equal(r.json.org.plan, "self_hosted");
  assert.deepEqual(r.json.limits, {
    seats: null, projects: null, tasks_per_month: null, model_spend_usd_per_month: null,
  });
  assert.equal(typeof r.json.usage.tasks_this_month, "number");
});

test("plan: a member cannot set their own plan", async () => {
  // The one write in the kernel a session cannot make. The asymmetry is the point: a session
  // belongs to someone who benefits from a bigger number here.
  const { app } = makeApp();
  const signup = await api(app, "auth/signup", {
    method: "POST",
    body: JSON.stringify({ email: `plan-${Date.now()}@example.com`, password: PW }),
  });
  const session = signup.json.token as string;

  const attempt = await api(app, "org/plan", { method: "PUT", body: JSON.stringify({ plan: "scale" }) }, session);
  assert.equal(attempt.status, 403);
  assert.match(attempt.json.error, /control plane/);

  // The product key can, because that is the control plane's credential.
  const ok = await api(app, "org/plan", { method: "PUT", body: JSON.stringify({ plan: "starter", billing_ref: "cus_123" }) });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json.limits, PLAN_LIMITS.starter);

  const nonsense = await api(app, "org/plan", { method: "PUT", body: JSON.stringify({ plan: "enterprise-platinum" }) });
  assert.equal(nonsense.status, 400);
});

test("plan: the billing reference is not readable with a product key", async () => {
  // A key lives in an environment variable. One leaking should not also hand over the billing
  // account it can be used against.
  const { app } = makeApp();
  await api(app, "org/plan", { method: "PUT", body: JSON.stringify({ plan: "starter", billing_ref: "cus_secret" }) });
  assert.equal((await api(app, "org")).json.org.billing_ref, undefined, "invisible to the key that set it");

  const owner = await api(app, "auth/login", {
    method: "POST",
    body: JSON.stringify({ email: "owner@test.co", password: "secret" }),
  });
  const asMember = await api(app, "org", {}, owner.json.token);
  assert.equal(asMember.json.org.billing_ref, "cus_secret", "but visible to the human who pays it");
});

test("plan: a seat limit counts outstanding invitations, not just members", async () => {
  const { app } = makeApp();
  const id = getIdentityStore();
  const email = `seats-${Date.now()}@example.com`;
  const signup = await api(app, "auth/signup", { method: "POST", body: JSON.stringify({ email, password: PW }) });
  const session = signup.json.token as string;
  const orgId = signup.json.member.org_id as string;

  // free: one seat, which the founder already occupies.
  id.setPlan(orgId, { plan: "free" });
  const refused = await api(
    app,
    "team/invites",
    { method: "POST", body: JSON.stringify({ email: `a-${Date.now()}@example.com` }) },
    session,
  );
  assert.equal(refused.status, 402, refused.text);
  assert.equal(refused.json.code, "seat_limit");

  id.setPlan(orgId, { plan: "starter" }); // three seats
  const first = await api(app, "team/invites", { method: "POST", body: JSON.stringify({ email: `b-${Date.now()}@example.com` }) }, session);
  assert.equal(first.status, 201);
  const second = await api(app, "team/invites", { method: "POST", body: JSON.stringify({ email: `c-${Date.now()}@example.com` }) }, session);
  assert.equal(second.status, 201);

  // Two invites plus the founder is three. The fourth is refused BEFORE the email goes out —
  // otherwise the limit lands on a confused recipient at accept time instead of here.
  const fourth = await api(app, "team/invites", { method: "POST", body: JSON.stringify({ email: `d-${Date.now()}@example.com` }) }, session);
  assert.equal(fourth.status, 402);
  assert.equal((await api(app, "org", {}, session)).json.usage.seats, 3);

  // Revoking one frees the seat immediately.
  await api(app, `team/invites/${second.json.invite.id}`, { method: "DELETE" }, session);
  assert.equal(
    (await api(app, "team/invites", { method: "POST", body: JSON.stringify({ email: `e-${Date.now()}@example.com` }) }, session)).status,
    201,
  );
});

test("plan: cancelling drops to free limits rather than to nothing", () => {
  // The data stays readable and the work stops. Deleting access on a failed payment turns a billing
  // problem into a data-loss incident.
  const id = getIdentityStore();
  const { org } = id.createOrgWithOwner("lapsed-co", `lapsed-${Date.now()}@example.com`, PW);
  id.setPlan(org.id, { plan: "growth", status: "active" });
  assert.deepEqual(id.limitsFor(org.id), PLAN_LIMITS.growth);

  // past_due keeps the business running on purpose — a bookkeeping service that stops answering its
  // customers because a card expired costs the founder far more than the unpaid invoice costs us.
  id.setPlan(org.id, { status: "past_due" });
  assert.deepEqual(id.limitsFor(org.id), PLAN_LIMITS.growth, "past_due still works");

  id.setPlan(org.id, { status: "cancelled" });
  assert.deepEqual(id.limitsFor(org.id), PLAN_LIMITS.free);
});

test("plan: the metered limit refuses a job at the door, not after it is queued", async () => {
  const { app } = makeApp();
  const id = getIdentityStore();
  const orgId = (await api(app, "me")).json.org_id as string;

  const spawn = () =>
    api(app, "tasks", {
      method: "POST",
      body: JSON.stringify({ wedge: "enrollment-operator", task_type: "reply_to_lead", input: {} }),
    });
  assert.equal((await spawn()).status, 201);

  // A plan whose allowance is already spent. Refusing at creation means the founder finds out from
  // an error, not from a customer whose email went unanswered.
  const used = (await api(app, "org")).json.usage.tasks_this_month as number;
  PLAN_LIMITS.free.tasks_per_month = used; // tighten for the test rather than spawning a hundred
  id.setPlan(orgId, { plan: "free" });

  const refused = await spawn();
  assert.equal(refused.status, 402, refused.text);
  assert.equal(refused.json.code, "task_limit");
  assert.match(refused.json.error, /jobs a month/);

  PLAN_LIMITS.free.tasks_per_month = 100;
  id.setPlan(orgId, { plan: "self_hosted" });
  assert.equal((await spawn()).status, 201, "and unmetered again once the plan allows it");
});

test("plan: setting someone else's plan needs a credential of its own", async () => {
  // A hosted control plane holds ONE product key and serves every tenant. Without a second
  // credential, a key leaked from any product could rewrite every customer's entitlements.
  const { app } = makeApp();
  const id = getIdentityStore();
  const { org: theirs } = id.createOrgWithOwner("someone-else", `else-${Date.now()}@example.com`, PW);

  const previous = process.env.MYCEL_CONTROL_TOKEN;
  delete process.env.MYCEL_CONTROL_TOKEN;

  // Unset by default, so cross-org writes are unavailable to a self-hosted install. Nobody has to
  // notice a setting in order to be safe.
  const unset = await api(app, "org/plan", {
    method: "PUT",
    body: JSON.stringify({ org_id: theirs.id, plan: "scale" }),
  });
  assert.equal(unset.status, 403);
  assert.equal(id.getOrg(theirs.id)?.plan, undefined, "and nothing was written");

  process.env.MYCEL_CONTROL_TOKEN = "control-abc";
  const wrong = await api(app, "org/plan", {
    method: "PUT",
    headers: { "x-mycel-control": "control-abd" },
    body: JSON.stringify({ org_id: theirs.id, plan: "scale" }),
  });
  assert.equal(wrong.status, 403);

  const right = await api(app, "org/plan", {
    method: "PUT",
    headers: { "x-mycel-control": "control-abc" },
    body: JSON.stringify({ org_id: theirs.id, plan: "growth", status: "active" }),
  });
  assert.equal(right.status, 200, right.text);
  assert.equal(id.getOrg(theirs.id)?.plan, "growth");

  // An org that doesn't exist is a 404, not a silent success.
  assert.equal(
    (await api(app, "org/plan", {
      method: "PUT",
      headers: { "x-mycel-control": "control-abc" },
      body: JSON.stringify({ org_id: "no-such-org", plan: "growth" }),
    })).status,
    404,
  );

  if (previous === undefined) delete process.env.MYCEL_CONTROL_TOKEN;
  else process.env.MYCEL_CONTROL_TOKEN = previous;
});

test("plan: a spend ceiling stops the run that a job count would have allowed", async () => {
  // Counting jobs does not protect margin. The tiers differ by 35× in price, so a Growth customer
  // can sit well inside a 20,000-job allowance and still cost $1,520 of model spend against $380 of
  // revenue. This is the limit that corresponds to money.
  const { app, store } = makeApp();
  const id = getIdentityStore();
  const me = await api(app, "me");
  const orgId = me.json.org_id as string;
  const projectId = me.json.projects[0].id as string;

  const spawn = () =>
    api(app, "tasks", {
      method: "POST",
      body: JSON.stringify({ wedge: "enrollment-operator", task_type: "reply_to_lead", input: {} }),
    });

  id.setPlan(orgId, { plan: "starter" });
  assert.equal((await spawn()).status, 201, "well inside every limit");

  // A month of expensive runs, without having to actually make 2,000 of them.
  const now = new Date().toISOString();
  await store.createTask({
    id: `spendy-${Date.now()}`, project_id: projectId, wedge: "books-keeper", task_type: "daily_sync",
    actor: { kind: "system", id: "test" }, input: {}, constraints: {}, tools: [],
    status: "succeeded", cost_usd: 500, created_at: now, updated_at: now,
  } as never);

  const refused = await spawn();
  assert.equal(refused.status, 402, refused.text);
  assert.equal(refused.json.code, "spend_limit");
  assert.match(refused.json.error, /model spend/);

  // The job count is untouched — this is a second, independent ceiling, and the message says which
  // one you hit so the fix is obvious.
  const org = await api(app, "org");
  assert.ok(org.json.usage.model_spend_usd >= 500);
  assert.ok(org.json.usage.tasks_this_month < 2000, "nowhere near the job limit");

  // And running it yourself is still unmetered.
  id.setPlan(orgId, { plan: "self_hosted" });
  assert.equal((await spawn()).status, 201);
});
