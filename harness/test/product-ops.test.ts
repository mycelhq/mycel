import { test } from "node:test";
import assert from "node:assert/strict";
import { asSurveyLog, nextSurvey, SURVEY_COOLDOWN_MS, SURVEY_PROMPTS } from "../src/surveys";
import { classifyTestEmail, digestDue, isDigestWeekday, testIdentityBlocked } from "../src/product-ops";
import { getIdentityStore } from "../src/identity";
import { api, makeApp } from "./helpers";

const PW = "correct-horse-battery";

function uniq(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
}

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

test("surveys: nothing fires on calendar age alone; churn jumps the cooldown", () => {
  const created = new Date(Date.now() - 20 * 3600_000).toISOString();
  const empty = asSurveyLog(undefined);
  assert.equal(nextSurvey(created, empty, {}), undefined, "no event, no prompt");

  const tooNew = new Date().toISOString();
  assert.equal(nextSurvey(tooNew, empty, { went_live: true }), undefined, "debounce still holds");

  const clock = nextSurvey(created, empty, { went_live: true });
  assert.equal(clock?.id, "clock");

  const client = nextSurvey(created, empty, { first_client: true });
  assert.equal(client?.id, "first_client");

  const chase = nextSurvey(created, empty, { first_chase: true });
  assert.equal(chase?.id, "pipeline", "first chase asks about finding clients first");

  const last = new Date().toISOString();
  const cooling = asSurveyLog({ answers: { clock: { at: last, score: 4 } }, last_at: last });
  assert.equal(nextSurvey(created, cooling, { went_live: true }), undefined, "cooldown holds");
  const churn = nextSurvey(created, cooling, { cancelled: true });
  assert.equal(churn?.id, "churn", "cancelling does not wait for the cooldown");
});

test("surveys: every prompt has a founder-facing feature name", () => {
  for (const p of SURVEY_PROMPTS) {
    assert.ok(p.feature.trim().length > 2);
    assert.doesNotMatch(p.feature + p.question + p.hint, /\b(harness|kernel|wedge|tenant|provision)\b/i);
  }
  assert.ok(SURVEY_COOLDOWN_MS >= 24 * 3600_000);
});

// ═══ "ACTIVE" WAS NEVER THE SAME QUESTION AS "PAID" ═══
//
// An org created outside the cloud signup path carries plan_status "active" with nothing billed.
// On 7 September production held nine orgs, ONE with a billing_ref and that one cancelled — and a
// weekly digest went out that morning to `founder@mycel.local` (a TLD that cannot resolve, so a
// guaranteed hard bounce), two demo tenants, and one real person at a real company.
//
// The bounces land on the sending domain every customer's mail shares, so fake rows in our own
// database degrade delivery for whoever is actually paying.

test("digest: Mon/Wed/Fri only, and only for an org that has actually paid", () => {
  const monday = Date.parse("2026-08-10T14:00:00Z"); // Monday
  const tuesday = Date.parse("2026-08-11T14:00:00Z");
  assert.equal(isDigestWeekday(new Date(monday)), true);
  assert.equal(isDigestWeekday(new Date(tuesday)), false);
  assert.equal(
    digestDue(
      { id: "o", name: "A", created_at: "2026-01-01T00:00:00Z", plan_status: "active", billing_ref: "sub_1" },
      monday,
    ),
    true,
  );
  assert.equal(
    digestDue({ id: "o", name: "A", created_at: "2026-01-01T00:00:00Z", plan_status: "cancelled" }, monday),
    false,
  );
  assert.equal(
    digestDue(
      {
        id: "o",
        name: "A",
        created_at: "2026-01-01T00:00:00Z",
        plan_status: "active",
        billing_ref: "sub_1",
        last_digest_at: new Date(monday - 2 * 3600_000).toISOString(),
      },
      monday,
    ),
    false,
    "a send two hours ago is not due again",
  );
});

test("ops: product snapshot is 404 to everyone except the allowlist", async () => {
  const { app } = makeApp();
  const email = uniq("ops");
  const signup = await api(app, "auth/signup", {
    method: "POST",
    body: JSON.stringify({ email, password: PW }),
  });
  const session = signup.json.token as string;

  const asKey = await api(app, "ops/product");
  assert.equal(asKey.status, 404, "a product key must not see every tenant");

  const asMember = await api(app, "ops/product", {}, session);
  assert.equal(asMember.status, 404);

  await withSuperAdmins(email, async () => {
    const me = await api(app, "me", {}, session);
    assert.equal(me.json.member.super_admin, true);
    const ok = await api(app, "ops/product", {}, session);
    assert.equal(ok.status, 200);
    assert.ok(ok.json.members.total >= 1);
    assert.ok(Array.isArray(ok.json.tenants));
    assert.ok(Array.isArray(ok.json.surveys.prompts));
  });
});

test("surveys: PATCH cannot forge scores; POST records them", async () => {
  const { app } = makeApp();
  const email = uniq("voice");
  const signup = await api(app, "auth/signup", {
    method: "POST",
    body: JSON.stringify({ email, password: PW }),
  });
  const session = signup.json.token as string;
  const memberId = signup.json.member.id as string;

  const forged = await api(
    app,
    "me/prefs",
    { method: "PATCH", body: JSON.stringify({ surveys: { answers: { clock: { at: "x", score: 5 } } } }) },
    session,
  );
  assert.equal(forged.status, 200);
  assert.equal(getIdentityStore().surveyLog(memberId).answers.clock, undefined);

  const next = await api(app, "surveys/next?signals=", {}, session);
  assert.equal(next.status, 200);
  assert.equal(next.json.prompt, null, "no event, no prompt — even after 18 hours would not matter here");

  const bad = await api(app, "surveys", { method: "POST", body: JSON.stringify({ prompt_id: "clock", score: 9 }) }, session);
  assert.equal(bad.status, 400);

  const ok = await api(
    app,
    "surveys",
    { method: "POST", body: JSON.stringify({ prompt_id: "clock", score: 4, comment: "clear" }) },
    session,
  );
  assert.equal(ok.status, 200);
  assert.equal(getIdentityStore().surveyLog(memberId).answers.clock?.score, 4);

  const again = await api(app, "surveys/next?signals=cancelled", {}, session);
  assert.equal(again.json.prompt?.id, "churn");
});

test("ops: control token can list due digests; a bare key cannot", async () => {
  const { app } = makeApp();
  const asKey = await api(app, "ops/digests");
  assert.equal(asKey.status, 404);

  const before = process.env.MYCEL_CONTROL_TOKEN;
  process.env.MYCEL_CONTROL_TOKEN = "digest-control";
  try {
    const ok = await api(app, "ops/digests", { headers: { "x-mycel-control": "digest-control" } });
    assert.equal(ok.status, 200);
    assert.ok(Array.isArray(ok.json.due));
  } finally {
    if (before === undefined) delete process.env.MYCEL_CONTROL_TOKEN;
    else process.env.MYCEL_CONTROL_TOKEN = before;
  }
});

test("classifyTestEmail flags QA addresses and leaves real ones alone", () => {
  assert.equal(classifyTestEmail("owner@test.co").test, true);
  assert.equal(classifyTestEmail("qa+run@example.test").test, true);
  assert.equal(classifyTestEmail("founder+test@agency.co").test, true);
  assert.equal(classifyTestEmail("hello@wrenandsalt.example").reason, "reserved TLD");
  assert.equal(classifyTestEmail("qa@mycelqa.dev").reason, "product QA domain");
  assert.equal(classifyTestEmail("studio@mailinator.com").reason, "disposable mailbox");
  assert.equal(classifyTestEmail("islam@mycelai.dev").test, false);
  assert.equal(classifyTestEmail("founder+prod@agency.co").test, false);
  assert.equal(classifyTestEmail("nina@northlightstudio.co").test, false);
  assert.equal(
    testIdentityBlocked({ plan_status: "active" }, "owner@test.co"),
    "paying",
  );
});

test("digest: a status of active with nothing billed does not send", () => {
  // The exact shape of every row that mailed on 7 September: `self_hosted` orgs get plan_status
  // "active" from createOrgWithOwner without anyone being charged.
  const monday = Date.parse("2026-08-10T14:00:00Z");
  const org = { id: "o", name: "default", created_at: "2026-01-01T00:00:00Z", plan_status: "active" as const };
  assert.equal(digestDue(org, monday), false, "active is not evidence of payment");
  assert.equal(digestDue({ ...org, billing_ref: "   " }, monday), false, "nor is a blank ref");
  assert.equal(digestDue({ ...org, billing_ref: "sub_live_1" }, monday), true);
});

test("digest: a trial does not send either", () => {
  // Atlas Studio was `starter`/`trialing` and had a digest sent to yc@yc.com. A trial has not paid.
  const monday = Date.parse("2026-08-10T14:00:00Z");
  const base = { id: "o", name: "Atlas Studio", created_at: "2026-01-01T00:00:00Z" };
  assert.equal(digestDue({ ...base, plan_status: "trialing" }, monday), false);
  assert.equal(digestDue({ ...base, plan_status: "past_due", billing_ref: "sub_1" }, monday), false);
});
