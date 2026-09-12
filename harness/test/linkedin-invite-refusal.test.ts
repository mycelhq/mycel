// What LinkedIn means when it refuses an invitation — and what it costs to keep asking.
//
// THE INCIDENT THESE TESTS STAND IN FOR. The founder's own account reached
// `engagement: {sent: 6, flagged: 305}` inside a single evening on 2026-08-18. 305 is not three
// hundred pieces of evidence that the account is unhealthy: it is ONE refusal, asked again once per
// prospect per tick, against a denominator (`sent`) that cannot grow while invitations are being
// refused. The multiplier that reads that counter would have collapsed the account's budget to a
// fifth and paused it, on evidence the retry loop manufactured.
//
// Four things were missing and there is a test here for each: telling the four refusal causes apart,
// saying the remedy that matches the cause, counting one episode once, and not asking again for a
// window in which the answer could not possibly have changed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { initSecretStore } from "../src/secrets";
import { getDomainStore } from "../src/domain";
import { connectWithSession, sendLinkedInInvite, _setVerifier } from "../src/linkedin/connect";
import { _setFetch } from "../src/linkedin/proxy";
import { _resetUsage } from "../src/linkedin/meter";
import {
  INVITE_REFUSAL_CODE,
  InviteQuotaError,
  classifyInviteRefusal,
  isQuotaRefusal,
  sendInvite,
} from "../src/linkedin/invites";
import {
  INVITE_REFUSAL_WAIT_MS,
  invitesBlocked,
  noteInviteRefusal,
  clearInviteRefusal,
  _resetInviteRefusals,
  _resetLinkedInHealth,
  _setHealthClock,
} from "../src/linkedin/health";

const SESSION = { li_at: "AQEDx", jsessionid: '"ajax:1"' };
const CTX = { connectionId: "conn-invite", proxyUrl: "http://u:p@resi.example:8080" };
/** Already a member urn, so no profile read is needed and the test is about the invite alone. */
const URN = "urn:li:fsd_profile:ACoAAADANA";

function reset(): void {
  _resetLinkedInHealth();
  _resetInviteRefusals();
  _resetUsage();
  _setHealthClock(null);
}

function res(status: number, body: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h: string) => (h === "content-length" ? String(body.length) : null) },
    text: async () => body,
  } as unknown as Response;
}
const jsonRes = (status: number, body: unknown) => res(status, JSON.stringify(body));

/** Record every URL the package asks for, so "it did not ask again" is an assertion and not a hope. */
function wire(handler: (url: string) => Response): string[] {
  const urls: string[] = [];
  _setFetch(async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    return handler(url);
  });
  return urls;
}

// ── the classifier: four causes, three remedies, one of them not about the account at all ────────

test("CANT_RESEND_YET is a PROSPECT, not a quota — the misclassification that inflated the counter", () => {
  // This string lived in the quota regex. It is LinkedIn's name for "you already invited this
  // person recently", so a loop re-walking a stale prospect list booked one account-level quota flag
  // per prospect — for an account that had not been refused anything.
  assert.equal(classifyInviteRefusal(409, { code: "CANT_RESEND_YET" }), "duplicate");
  assert.equal(classifyInviteRefusal(400, { status: "ALREADY_INVITED" }), "duplicate");
  // And it is not a quota refusal for the follow/react path either.
  assert.equal(isQuotaRefusal(409, { code: "CANT_RESEND_YET" }), false);
});

test("the three ACCOUNT-level causes are told apart, because they have three different remedies", () => {
  assert.equal(classifyInviteRefusal(403, { message: "weekly invitation limit reached" }), "weekly");
  assert.equal(classifyInviteRefusal(403, { code: "TOO_MANY_PENDING_INVITATIONS" }), "pending");
  assert.equal(classifyInviteRefusal(403, { code: "ACCOUNT_RESTRICTED" }), "restricted");
  // A bare 429 with nothing readable is still a refusal; weekly is the likeliest cause.
  assert.equal(classifyInviteRefusal(429, {}), "weekly");
  // An ordinary failure is NOT one of these. Booking a 422 with no refusal copy as a quota event is
  // exactly how a transport problem becomes a permanent-looking account problem.
  assert.equal(classifyInviteRefusal(422, { message: "unprocessable" }), null);
  assert.equal(classifyInviteRefusal(500, { code: "INVITATION_LIMIT" }), null);
});

test("each cause's message names the remedy that works FOR THAT CAUSE, and only that one", () => {
  const weekly = new InviteQuotaError("weekly").message;
  // A founder told "weekly limit" waits. So the weekly message must not send them withdrawing, and
  // the pending message must not let them wait — waiting makes a full pending pile worse.
  assert.match(weekly, /nothing but time/i);
  assert.match(weekly, /does NOT give the weekly allowance back/i);

  const pending = new InviteQuotaError("pending").message;
  assert.match(pending, /withdraw/i);
  assert.match(pending, /not the weekly limit/i);

  const restricted = new InviteQuotaError("restricted").message;
  assert.match(restricted, /human has to open the account/i);
  assert.doesNotMatch(restricted, /weekly window will/i);

  // And each carries its own code, so the UI and the sequencer can branch without reading prose.
  assert.equal(new InviteQuotaError("weekly").code, INVITE_REFUSAL_CODE.weekly);
  assert.equal(new InviteQuotaError("pending").code, INVITE_REFUSAL_CODE.pending);
  assert.equal(new InviteQuotaError("restricted").code, INVITE_REFUSAL_CODE.restricted);
  assert.notEqual(INVITE_REFUSAL_CODE.weekly, INVITE_REFUSAL_CODE.pending);
});

test("a duplicate is RETURNED, not thrown — it must never reach the account-level handler", async () => {
  reset();
  wire(() => jsonRes(409, { code: "CANT_RESEND_YET" }));
  try {
    const r = await sendInvite(SESSION, CTX, URN);
    assert.equal(r.ok, false);
    assert.equal(r.code, INVITE_REFUSAL_CODE.duplicate);
    assert.match(r.detail ?? "", /says nothing about the account/i);
  } finally {
    _setFetch(null);
    reset();
  }
});

test("an account-level refusal throws, carrying the cause the classifier found", async () => {
  reset();
  wire(() => jsonRes(403, { code: "TOO_MANY_PENDING_INVITATIONS" }));
  try {
    const e = await sendInvite(SESSION, CTX, URN).then(() => null, (err: unknown) => err);
    assert.ok(e instanceof InviteQuotaError);
    assert.equal((e as InviteQuotaError).reason, "pending");
  } finally {
    _setFetch(null);
    reset();
  }
});

test("a 403 that says 'pending cap' is an ANSWER, not a checkpoint — but a real checkpoint still is", async () => {
  reset();
  // Every 403 used to become `LinkedInChallengeError`, so a full pending pile told the founder to
  // reconnect a session that was working perfectly. They reconnect, wait a week, and nothing changes.
  wire(() => jsonRes(403, { code: "TOO_MANY_PENDING_INVITATIONS" }));
  try {
    const e = await sendInvite(SESSION, CTX, URN).then(() => null, (err: unknown) => err);
    assert.ok(e instanceof InviteQuotaError, "a pending cap must not read as a dead session");
    assert.equal((e as InviteQuotaError).reason, "pending");
  } finally {
    _setFetch(null);
    reset();
  }

  // The demotion is narrow on purpose. A 403 that carries an actual checkpoint is still a challenge
  // however the rest of the body reads — otherwise this fix would be a hole in the session breaker.
  wire(() => jsonRes(403, { code: "ACCOUNT_RESTRICTED", challenge_id: "abc" }));
  try {
    const e = await sendInvite(SESSION, CTX, URN).then(() => null, (err: unknown) => err);
    assert.ok(e instanceof Error);
    assert.equal((e as { code?: string }).code, "challenged");
  } finally {
    _setFetch(null);
    reset();
  }
});

// ── the breaker: record once, wait a window that could change the answer, stop ────────────────────

test("the invite breaker opens once per episode and answers 'is this the first'", () => {
  reset();
  let t = 1_000_000;
  _setHealthClock(() => t);
  try {
    assert.equal(invitesBlocked("c1"), null, "nothing is refused until LinkedIn refuses it");

    const first = noteInviteRefusal("c1", "weekly", INVITE_REFUSAL_CODE.weekly, "no invitations left");
    assert.equal(first.first, true);
    assert.equal(first.untilMs, INVITE_REFUSAL_WAIT_MS.weekly);

    // THE COUNTER ASSERTION. Every further refusal of the same cause is the same fact, and the
    // caller keys `engagement.flagged` on `first` — this is what turns 305 back into 1.
    for (let i = 0; i < 50; i++) {
      assert.equal(noteInviteRefusal("c1", "weekly", INVITE_REFUSAL_CODE.weekly, "x").first, false);
    }

    // While the episode is open, invitations are refused locally, with the code that travels.
    const blocked = invitesBlocked("c1");
    assert.equal(blocked?.code, INVITE_REFUSAL_CODE.weekly);
    assert.match(blocked?.detail ?? "", /not retrying for another \d+ min/);

    // A DIFFERENT cause during an open episode is new information and is counted again.
    assert.equal(
      noteInviteRefusal("c1", "restricted", INVITE_REFUSAL_CODE.restricted, "restricted").first,
      true,
    );

    // The window is a wait, not a stop: once it has passed, LinkedIn gets asked again.
    t += INVITE_REFUSAL_WAIT_MS.restricted + 1;
    assert.equal(invitesBlocked("c1"), null);
    // And that reopens a fresh episode, which counts.
    assert.equal(noteInviteRefusal("c1", "weekly", INVITE_REFUSAL_CODE.weekly, "x").first, true);
  } finally {
    reset();
  }
});

test("an invitation that goes through clears the refusal; a mere successful READ does not", () => {
  reset();
  try {
    noteInviteRefusal("c2", "weekly", INVITE_REFUSAL_CODE.weekly, "no invitations left");
    assert.ok(invitesBlocked("c2"), "still refused");
    // The general health map is what a successful profile read clears. An exhausted invitation
    // allowance is not evidence about profile reads and profile reads are not evidence about it —
    // if this shared state, one inbox poll would have re-opened the whole retry storm.
    _resetLinkedInHealth();
    assert.ok(invitesBlocked("c2"), "a successful unrelated call must not un-refuse the invitation");
    clearInviteRefusal("c2");
    assert.equal(invitesBlocked("c2"), null);
  } finally {
    reset();
  }
});

// ── end to end: what the founder's account actually did on 2026-08-18 ─────────────────────────────

/** Hours to add to now so the account's derived local time is a Tuesday at 10:00 — inside hours. */
function workingHoursOffset(now = new Date()): number {
  const target = new Date(now);
  target.setUTCHours(10, 0, 0, 0);
  while (target.getUTCDay() !== 2) target.setUTCDate(target.getUTCDate() + 1);
  return (target.getTime() - now.getTime()) / 3_600_000;
}

test("a refused account is flagged ONCE and asked ONCE — the {sent: 6, flagged: 305} regression", async () => {
  reset();
  await initSecretStore();
  _setVerifier(async () => ({
    self_urn: "urn:li:fs_miniProfile:ME",
    mailbox_urn: "urn:li:fsd_profile:ME",
    name: "Founder",
  }));
  const urls = wire((url) =>
    url.includes("normInvitations") || url.includes("verifyQuotaAndCreate")
      ? jsonRes(429, { message: "you have reached the weekly invitation limit" })
      : jsonRes(200, {}),
  );
  try {
    const r = await connectWithSession({
      li_at: "AQEDx",
      jsessionid: '"ajax:1"',
      proxyUrl: "http://u:p@resi.example:8080",
      project_id: "p-invite-refusal",
    });
    assert.equal(r.phase, "connected", r.error);
    const conn = (await getDomainStore().getConnection(r.connection_id))!;
    const ready = (await getDomainStore().updateConnection(conn.id, {
      config: {
        ...conn.config,
        tier: "premium",
        account_age_days: 365,
        utc_offset: workingHoursOffset(),
        pacing: { engagement: { sent: 200, accepted: 80, replied: 30, flagged: 0 } },
      },
    }))!;

    urls.length = 0;
    const first = await sendLinkedInInvite(ready, URN);
    assert.equal(first.ok, false);
    assert.equal(first.code, INVITE_REFUSAL_CODE.weekly);
    // Counted across BOTH endpoints: the point is that ONE invitation was attempted, not which
    // URL carried it. The mock above already answers either.
    assert.equal(
      urls.filter((u) => u.includes("normInvitations") || u.includes("verifyQuotaAndCreate")).length,
      1,
      urls.join("\n"),
    );

    const afterFirst = (await getDomainStore().getConnection(ready.id))!;
    const flaggedOnce =
      ((afterFirst.config.pacing as { engagement?: { flagged?: number } })?.engagement?.flagged) ?? 0;
    assert.equal(flaggedOnce, 1, "one refusal, one flag");

    // Now the tick walks the next twenty-four prospects. Before the breaker, that was twenty-four
    // more requests and twenty-four more flags. It should now be zero of each.
    urls.length = 0;
    for (let i = 0; i < 24; i++) {
      const again = await sendLinkedInInvite(afterFirst, URN);
      assert.equal(again.ok, false);
      assert.equal(again.code, INVITE_REFUSAL_CODE.weekly, "and it still says WHY, per prospect");
    }
    assert.equal(urls.length, 0, `nothing should have gone to LinkedIn:\n${urls.join("\n")}`);

    const afterAll = (await getDomainStore().getConnection(ready.id))!;
    const flaggedTotal =
      ((afterAll.config.pacing as { engagement?: { flagged?: number } })?.engagement?.flagged) ?? 0;
    assert.equal(flaggedTotal, 1, "still one — this is the assertion that 305 can never happen again");
  } finally {
    _setFetch(null);
    _setVerifier(null);
    reset();
  }
});
