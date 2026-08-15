import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ageRamp,
  budgetFor,
  engagementMultiplier,
  evaluate,
  nextIntervalMs,
  withinSendingWindow,
  type Engagement,
  type PacingInput,
} from "../src/pacing";

const healthy: Engagement = { sent: 200, accepted: 80, replied: 30, flagged: 0 };
const ignored: Engagement = { sent: 200, accepted: 8, replied: 1, flagged: 0 };
const complained: Engagement = { sent: 200, accepted: 40, replied: 10, flagged: 8 };

const at = (over: Partial<PacingInput> = {}): PacingInput => ({
  tier: "free",
  accountAgeDays: 365,
  engagement: healthy,
  used: {},
  localHour: 10,
  localDay: 2, // Tuesday
  ...over,
});

test("pacing: the budget follows engagement, because that is what LinkedIn actually scores", () => {
  // 80 invitations a week at 40% acceptance is a healthy account; 40 a week at 3% is a restricted
  // one. Volume alone is the wrong lever, so the limit moves with the signal rather than sitting
  // at a fixed number chosen by us.
  const good = budgetFor("invite", at({ engagement: healthy }));
  const bad = budgetFor("invite", at({ engagement: ignored }));
  assert.ok(good > bad, `earning more: ${good} vs ${bad}`);
  assert.ok(bad >= 1, "throttled, never zeroed — a paused campaign should recover, not die");

  // Nobody wants these messages. Sending more of them is how an account dies.
  assert.ok(engagementMultiplier(ignored) < engagementMultiplier(healthy) * 0.6);
});

test("pacing: complaints collapse the budget rather than nudging it", () => {
  // "I don't know this person" is the signal that immediately precedes a restriction. It is the one
  // case where gradual is the wrong response.
  assert.equal(engagementMultiplier(complained), 0.2);
  const v = evaluate("invite", at({ engagement: complained }));
  assert.equal(v.allowed, false);
  assert.match(v.reason!, /unwanted/);
  // And it says what to change, because "paused" with no cause is a support ticket.
  assert.match(v.reason!, /who is being contacted|what is being said/);
});

test("pacing: a connected free account gets the documented dogfood pace, not 1 invite a day", () => {
  // Missing/unknown age + no engagement used to stack 0.25 × 0.6 × 0.8 → 1 invite/day and 3
  // messages/day. A member session on a dedicated country line is not a day-old LinkedIn.
  const quiet: Engagement = { sent: 0, accepted: 0, replied: 0, flagged: 0 };
  const invites = budgetFor("invite", at({ engagement: quiet }));
  const messages = budgetFor("message", at({ engagement: quiet }));
  assert.equal(invites, 80, `free invites/week: ${invites}`);
  assert.equal(messages, 175, `free messages/week (25/day): ${messages}`);

  const premiumInvites = budgetFor("invite", at({ tier: "premium", engagement: quiet }));
  const premiumMessages = budgetFor("message", at({ tier: "premium", engagement: quiet }));
  assert.equal(premiumInvites, 100);
  assert.equal(premiumMessages, 560);
  assert.ok(premiumInvites > invites, "Premium stays above free");
  assert.ok(premiumMessages > messages, "Premium messages stay above free");
});

test("pacing: it never exceeds the published ceiling, even at its best", () => {
  // Reply bonus can reach 1.15 — cap at the tier ceiling so a free account never inherits Premium.
  const best = budgetFor("invite", at({ engagement: { sent: 500, accepted: 300, replied: 100, flagged: 0 } }));
  assert.equal(best, 80, `free tier ceiling is 80/week; budget was ${best}`);
});

test("pacing: a new account starts slow and earns its way up", () => {
  // Under 30 days LinkedIn applies a stricter informal cap until trust accumulates. Opening at full
  // volume on day two is the classic way to lose an account.
  assert.ok(ageRamp(2) < ageRamp(10));
  assert.ok(ageRamp(10) < ageRamp(20));
  assert.ok(ageRamp(20) < ageRamp(40));
  assert.equal(ageRamp(90), 1);

  const fresh = budgetFor("invite", at({ accountAgeDays: 3 }));
  const seasoned = budgetFor("invite", at({ accountAgeDays: 365 }));
  assert.ok(fresh < seasoned / 3, `day-3 account: ${fresh}, established: ${seasoned}`);
});

test("pacing: a Sales Navigator account is not held to a free account's ceiling", () => {
  // Treating every tier the same either wastes what a customer paid LinkedIn for, or restricts a
  // free account by applying limits it does not have.
  assert.ok(budgetFor("invite", at({ tier: "sales_navigator" })) > budgetFor("invite", at({ tier: "free" })));
  assert.equal(budgetFor("inmail", at({ tier: "free" })), 1, "free has no InMail; floored at 1, not negative");
});

test("pacing: nothing goes out at 3am, but every day of the week is fine", () => {
  // A steady stream at 04:00 local is a pattern nobody has to look hard to spot; the small hours are
  // the only real bot tell. Weekends are NOT — a real person messages on a Saturday — so any day in
  // the 08:00–19:00 window sends.
  assert.equal(withinSendingWindow(3, 2), false);
  assert.equal(withinSendingWindow(23, 2), false);
  assert.equal(withinSendingWindow(10, 0), true, "Sunday, in-hours: fine");
  assert.equal(withinSendingWindow(10, 6), true, "Saturday, in-hours: fine");
  assert.equal(withinSendingWindow(10, 2), true);

  const night = evaluate("invite", at({ localHour: 3 }));
  assert.equal(night.allowed, false);
  assert.ok(night.nextAfterMs > 0, "and says when to come back rather than spinning");
});

test("pacing: touches are spread and jittered, never bursted", () => {
  // "Spread evenly" is in every piece of LinkedIn guidance. The jitter matters as much as the
  // spacing — a message exactly every 7 minutes is more obviously automated than a burst.
  const seen = new Set<number>();
  for (let i = 0; i < 200; i++) seen.add(nextIntervalMs(20));
  assert.ok(seen.size > 100, "intervals vary rather than being a fixed cadence");

  // Even an enormous budget cannot produce a machine-gun.
  for (let i = 0; i < 100; i++) assert.ok(nextIntervalMs(10_000) >= 45_000, "floor holds");

  // A bigger allowance means shorter gaps, but the whole day's work still spans the working window.
  const sparse = nextIntervalMs(5, () => 0.5);
  const dense = nextIntervalMs(50, () => 0.5);
  assert.ok(sparse > dense);
});

test("pacing: a spent allowance stops the campaign and says when it resets", () => {
  const budget = budgetFor("invite", at());
  const v = evaluate("invite", at({ used: { invite: budget } }));
  assert.equal(v.allowed, false);
  assert.equal(v.remaining, 0);
  // The founder needs to know WHY their campaign paused. An exception is a bug report; this is a
  // product.
  assert.match(v.reason!, /allowance/);
  assert.ok(v.nextAfterMs > 0);
});

test("pacing: a connection with no account_age_days is treated as established", async () => {
  const { assertSendAllowed } = await import("../src/pacing");
  const domain = {
    getConnection: async () => ({
      id: "c1",
      config: { tier: "free", utc_offset: 0 },
    }),
  } as never;
  const v = await assertSendAllowed(domain, "c1", "invite");
  assert.equal(v.budget, 80);
  assert.equal(v.remaining, 80);
  const msg = await assertSendAllowed(domain, "c1", "message");
  assert.equal(msg.budget, 175);
});

test("pacing: unknown state refuses to send", async () => {
  // An outreach system whose safety check degrades to "send anyway" has no safety check.
  const { assertSendAllowed } = await import("../src/pacing");
  const broken = {
    getConnection: async () => {
      throw new Error("database is down");
    },
  } as never;
  const v = await assertSendAllowed(broken, "c1", "invite");
  assert.equal(v.allowed, false);
  assert.match(v.reason!, /unavailable/);

  const missing = { getConnection: async () => undefined } as never;
  assert.equal((await assertSendAllowed(missing, "nope", "invite")).allowed, false);
});

test("pacing: a challenged session sends nothing, reads included", async () => {
  const { assertSendAllowed, assertPollAllowed } = await import("../src/pacing");
  const domain = {
    getConnection: async () => ({
      id: "c1",
      config: { linkedin_challenge: { at: "2026-08-13T00:00:00Z", status: 401 }, utc_offset: 0 },
    }),
  } as never;
  const send = await assertSendAllowed(domain, "c1", "invite");
  assert.equal(send.allowed, false);
  assert.match(send.reason!, /challenged/i);
  const poll = await assertPollAllowed(domain, "c1");
  assert.equal(poll.allowed, false);
  assert.match(poll.reason!, /challenged/i);
});
