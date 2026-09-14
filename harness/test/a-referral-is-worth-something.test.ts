import { after, test } from "node:test";
import assert from "node:assert/strict";
import { api, makeApp } from "./helpers";
import { getIdentityStore } from "../src/identity";
import { mintReferralCode, normaliseReferralCode } from "../src/referrals";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE REFERRAL LOOP, END TO END
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A founder who has just watched this close a month's books is the most credible salesperson this
 * product will ever have. `milestones.ts` has asked at exactly the right moment — three days after
 * the first invoice is paid — since long before there was anything to hand them, and what it asked
 * for was goodwill, because goodwill was all there was.
 *
 * Four properties, and each one is a way the scheme gets farmed, broken or quietly lost:
 *
 *   1. A CODE IS READ THE WAY PEOPLE SUPPLY IT — pasted as a URL, typed in lower case — but a wrong
 *      code is NEVER repaired into a plausible one, because a mis-attributed referral is invisible
 *      afterwards.
 *   2. A MISTYPED CODE COSTS NOTHING. The account is created either way. A signup that 400s over an
 *      attribution table is a customer traded for a rounding error.
 *   3. THE REWARD LANDS ON A PAID CONVERSION, not on a signup, and exactly once.
 *   4. A REFERRER READS A NAME AND A STATE, and nothing else about the person they brought.
 */

const pw = "correct-horse-battery";
let n = 0;
const addr = () => `ref-${Date.now()}-${++n}@example.test`;

/** Sign somebody up and hand back their session and org. */
async function signup(app: Parameters<typeof api>[0], extra: Record<string, unknown> = {}) {
  const email = addr();
  const res = await api(app, "auth/signup", {
    method: "POST",
    body: JSON.stringify({ email, password: pw, ...extra }),
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return { token: res.json.token as string, orgId: res.json.projects[0].org_id as string, email };
}

const auth = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

test("a code is minted on first read, is stable, and is the caller's own", async () => {
  const { app } = makeApp();
  const a = await signup(app);

  const first = await api(app, "referrals", auth(a.token));
  assert.equal(first.status, 200);
  assert.match(first.json.code, /^[A-Z2-9]{8}$/);
  // Stable: a link in an email footer cannot change every time the screen is opened.
  const again = await api(app, "referrals", auth(a.token));
  assert.equal(again.json.code, first.json.code);

  // And it is nobody else's.
  const b = await signup(app);
  const theirs = await api(app, "referrals", auth(b.token));
  assert.notEqual(theirs.json.code, first.json.code);
});

test("an API key cannot read a referral link", async () => {
  /*
    A key belongs to an integration, not to a person, and whoever holds the link collects. The only
    reason a key would ask is that somebody put one in a script that posts it somewhere.
  */
  const { app } = makeApp();
  const res = await api(app, "referrals");
  assert.equal(res.status, 403);
});

test("a signup through a link is attributed, and shows up on the referrer's list", async () => {
  const { app } = makeApp();
  const a = await signup(app);
  const { code } = (await api(app, "referrals", auth(a.token))).json;

  const b = await signup(app, { org_name: "Brightline Books", referral_code: code });

  const list = await api(app, "referrals", auth(a.token));
  assert.equal(list.json.joined.length, 1);
  assert.equal(list.json.joined[0].name, "Brightline Books");
  // A signup is not a conversion. Nothing has been earned yet and the row says so.
  assert.equal(list.json.joined[0].credited, false);
  assert.equal(list.json.credited, 0);

  /*
    A NAME AND A STATE, AND NOTHING ELSE. A referrer is owed enough to recognise who they brought
    and to know whether it counted. Anything past that is one founder reading another's account
    through a feature they were given as a thank you.
  */
  const text = JSON.stringify(list.json.joined[0]);
  for (const leak of [b.email, b.orgId, "plan", "billing"]) {
    assert.ok(!text.includes(leak), `the referrer must not see ${leak}`);
  }
});

test("a mistyped or hostile code never costs somebody their account", async () => {
  const { app } = makeApp();
  for (const referral_code of ["NOPE", "ABCD0FGH", mintReferralCode(), "", "   ", 42 as unknown as string]) {
    const res = await api(app, "auth/signup", {
      method: "POST",
      body: JSON.stringify({ email: addr(), password: pw, referral_code }),
    });
    assert.equal(res.status, 201, `a bad code must not block a signup: ${String(referral_code)}`);
  }
});

test("your own code attributes nothing", async () => {
  const { app } = makeApp();
  const a = await signup(app);
  const { code } = (await api(app, "referrals", auth(a.token))).json;
  const identity = getIdentityStore();

  // The org-level refusal, directly: signing up cannot reach it (a new org has no code yet), but an
  // operator or a future caller can, and "once, and never onto itself" has to hold there too.
  assert.equal(identity.attributeReferral(a.orgId, a.orgId), false, "an org cannot refer itself");
  const b = await signup(app, { referral_code: code });
  assert.equal(identity.attributeReferral(b.orgId, a.orgId), false, "a second attribution is refused");
});

test("the reward lands when they start paying, and only once", async () => {
  const { app } = makeApp();
  const a = await signup(app);
  const { code } = (await api(app, "referrals", auth(a.token))).json;
  const b = await signup(app, { referral_code: code });

  /*
    The control plane's credential, which is what actually writes a plan. `api` sends the product
    key by default; the second header is what allows a write to ANOTHER org — see the plan route,
    and `plan.test.ts`, which asserts that a leaked product key alone cannot rewrite entitlements.
  */
  const previous = process.env.MYCEL_CONTROL_TOKEN;
  process.env.MYCEL_CONTROL_TOKEN = "control-for-referral-test";
  after(() => {
    if (previous === undefined) delete process.env.MYCEL_CONTROL_TOKEN;
    else process.env.MYCEL_CONTROL_TOKEN = previous;
  });

  const setPlan = async (status: string) => {
    const res = await api(app, "org/plan", {
      method: "PUT",
      headers: { "x-mycel-control": process.env.MYCEL_CONTROL_TOKEN! },
      body: JSON.stringify({ org_id: b.orgId, status }),
    });
    assert.equal(res.status, 200, `setting ${status} failed: ${JSON.stringify(res.json)}`);
    return res;
  };

  // `none` is the window between signing up and a card being accepted. Nothing is earned there.
  await setPlan("none");
  assert.equal((await api(app, "referrals", auth(a.token))).json.credited, 0);

  await setPlan("active");
  const paid = await api(app, "referrals", auth(a.token));
  assert.equal(paid.json.credited, 1);
  assert.equal(paid.json.joined[0].credited, true);
  const creditedAt = paid.json.joined[0].credited_at;

  /*
    LAPSED AND CAME BACK. A card fails, the org goes `past_due`, then pays again — and a scheme that
    credits on every transition to active pays a founder twice for one customer.
  */
  await setPlan("past_due");
  await setPlan("active");
  const secondTime = await api(app, "referrals", auth(a.token));
  assert.equal(secondTime.json.credited, 1, "a lapse and a return is one referral, not two");
  assert.equal(secondTime.json.joined[0].credited_at, creditedAt, "the credit kept its original date");
});

test("codes read the way people supply them, and a wrong one is never repaired", () => {
  const code = mintReferralCode();
  assert.equal(normaliseReferralCode(code), code);
  assert.equal(normaliseReferralCode(code.toLowerCase()), code);
  assert.equal(normaliseReferralCode(` ${code} `), code);
  assert.equal(normaliseReferralCode(`https://mycelai.dev/?ref=${code}`), code);
  /*
    The alphabet excludes `0`, `O`, `1`, `I` and `L` so that a code read aloud or off a screenshot
    cannot be ambiguous. An earlier draft "helpfully" folded those onto their neighbours, which is
    how a referral gets attributed to an org the reader never chose.
  */
  assert.equal(normaliseReferralCode("ABCD0FGH"), undefined);
  assert.equal(normaliseReferralCode("ABCDEFG"), undefined, "seven characters is not a code");
  assert.equal(normaliseReferralCode(undefined), undefined);
});
