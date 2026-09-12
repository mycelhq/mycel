// Pure-logic tests for the LinkedIn core, exercised WITHOUT a host wired — the whole point of the
// package split is that meter/tier and the request builders stand alone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { accountTierFromMe } from "../src/tier";
import { recordTransfer, usageFor, forgetUsage, _resetUsage } from "../src/meter";
import { asSkillUrn, endorseSkill, endorsementBody, followPerson } from "../src/engage";
import { codeSuffix, inviteBody, DASH_INVITE_BODIES } from "../src/invites";
import { DECLARED_UNWIRED, SEQUENCE_LIVE, WARMUP_GATED } from "../src/verbs";

test("accountTierFromMe fails closed to free, and only names a tier on a named signal", () => {
  assert.equal(accountTierFromMe(undefined), "free");
  assert.equal(accountTierFromMe({}), "free");
  // Marketing "Premium" copy on a free account must not be read as a subscription.
  assert.equal(accountTierFromMe({ headline: "Premium coaching" }), "free");
  assert.equal(accountTierFromMe({ premiumSubscriber: true }), "premium");
  assert.equal(accountTierFromMe({ salesNavigatorSubscriber: true }), "sales_navigator");
  assert.equal(accountTierFromMe({ recruiter: true }), "recruiter");
});

test("recordTransfer accumulates per account and per op, and forgetUsage clears it", () => {
  _resetUsage();
  recordTransfer("c1", "sync", { wire: 1000, decoded: 5000 });
  recordTransfer("c1", "sync", { wire: 500, decoded: 2500 });
  recordTransfer("c1", "send", { wire: 100, up: 40 });

  const u = usageFor("c1")!;
  assert.equal(u.requests, 3);
  assert.equal(u.wire_bytes, 1600);
  assert.equal(u.by_op.sync.requests, 2);
  assert.equal(u.by_op.sync.wire_bytes, 1500);
  assert.equal(u.by_op.send.up_bytes, 40);
  // wire/decoded compression ratio is surfaced rather than inferred.
  assert.equal(u.compression_ratio, Number((1600 / 7500).toFixed(3)));

  forgetUsage("c1");
  assert.equal(usageFor("c1"), undefined);
});

// ── Endorsements ────────────────────────────────────────────────────────────
//
// An endorsement lands under the founder's real name, on a stranger's profile, permanently. Every
// guard that stops a wrong one is asserted here, and the most important is the last: while the
// kill-switch is off, nothing may reach the network at all.

test("endorse: refuses before any network call while the flag is off", async () => {
  delete process.env.MYCEL_LINKEDIN_WARMUP;
  let called = false;
  const spy = (async () => {
    called = true;
    return { ok: true, status: 200, json: {} };
  }) as never;
  const r = await endorseSkill({} as never, {} as never, "urn:li:fsd_profile:abc", "urn:li:fsd_skill:seo", spy);
  assert.equal(r.ok, false);
  assert.equal(r.code, "warmup_disabled");
  assert.equal(called, false, "the disabled path must make NO network call");
});

test("endorse: a skill NAME is refused; only a urn off their profile is accepted", async () => {
  // Endorsing somebody for a skill they never claimed is the tell that no human is involved, and it
  // turns a compliment into evidence. Taking a urn makes that structurally impossible.
  process.env.MYCEL_LINKEDIN_WARMUP = "1";
  const spy = (async () => ({ ok: true, status: 200, json: {} })) as never;
  const named = await endorseSkill({} as never, {} as never, "urn:li:fsd_profile:abc", "SEO", spy);
  assert.equal(named.ok, false);
  assert.match(named.detail ?? "", /skill they LISTS|not a skill urn/i);
  delete process.env.MYCEL_LINKEDIN_WARMUP;
});

test("endorse: urn shapes are validated, not trusted", () => {
  assert.equal(asSkillUrn("urn:li:fsd_skill:seo"), "urn:li:fsd_skill:seo");
  assert.equal(asSkillUrn("urn:li:skill:123"), "urn:li:skill:123");
  assert.equal(asSkillUrn("SEO"), undefined);
  assert.equal(asSkillUrn(""), undefined);
  assert.equal(asSkillUrn(null), undefined);
});

test("endorse: the body puts the member and the skill in their own fields", () => {
  // "Was the skill in the right field" should not first be answered in production.
  const body = endorsementBody("urn:li:fsd_profile:abc", "urn:li:fsd_skill:seo");
  assert.equal(body.endorseeUrn, "urn:li:fsd_profile:abc");
  assert.equal(body.skillUrn, "urn:li:fsd_skill:seo");
  assert.equal(body.endorsed, true);
});

test("endorse: it is warm-up gated, never sequenceable", () => {
  // The promotion was from "no executor" to "exists and is disarmed". It must not reach a cadence:
  // an endorsement is an action an agent chooses deliberately, not a rung that fires unwatched.
  assert.ok(WARMUP_GATED.includes("endorse_skill" as never));
  assert.ok(!SEQUENCE_LIVE.includes("endorse_skill" as never));
  assert.ok(!DECLARED_UNWIRED.includes("endorse_skill" as never));
});

test("an invite failure keeps LinkedIn's reason code, and never its prose", () => {
  // The shape, not the key: LinkedIn has moved this between `code`, `errorCode` and `data.code`.
  assert.equal(codeSuffix({ status: 422, code: "CANT_RESEND_YET" }), " (CANT_RESEND_YET)");
  assert.equal(codeSuffix({ data: { errorCode: "ALREADY_INVITED" } }), " (ALREADY_INVITED)");

  // Prose is not a code, and must not ride along: it can quote the invitee by name.
  assert.equal(codeSuffix({ message: "You cannot invite Ada Lovelace right now" }), "");
  assert.equal(codeSuffix({ message: "Ada" }), "", "a capitalised name is not a constant");

  // Nothing readable is not an error — the status code stands on its own, as it did before.
  assert.equal(codeSuffix(null), "");
  assert.equal(codeSuffix(undefined), "");
  assert.equal(codeSuffix({}), "");
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.equal(codeSuffix(circular), "", "an unserialisable payload degrades, it does not throw");
});

test("the invite body is a list of candidates, not one more guess", () => {
  // ═══ THE RECORD THIS REPLACES ═══
  //
  //   legacy `growth/normInvitations`   39 attempts, 0 sent, answering 422 — a retired Rest.li
  //                                     route that still resolves and will not take the body
  //   dash flat `inviteeProfileUrn`      7 attempts, 0 sent, answering a bare 400 — the route is
  //                                     live and the BODY is being rejected
  //
  // Two deploys, two shapes, one bit of information each, a day and a batch of prospects apiece.
  // A third guess would be the same trade again, so the shape became a question the runtime asks:
  // try them in order, stop on any real answer, and log which one was accepted. A refused
  // invitation costs no quota, which is what makes asking affordable.
  assert.equal(process.env.MYCEL_LINKEDIN_DASH_INVITE, undefined, "dash is the default");
  const urn = "urn:li:fsd_profile:ACoAAABCDEF";

  // Ordered by confidence, and the shape with 0/7 is no longer first.
  assert.ok(DASH_INVITE_BODIES.length >= 2, "one candidate is a guess, not a question");
  assert.equal(DASH_INVITE_BODIES[0]!.name, "dash-union");
  assert.equal(DASH_INVITE_BODIES[1]!.name, "dash-flat");

  const union = DASH_INVITE_BODIES[0]!.build(urn, "worth a look?");
  assert.deepEqual(union, {
    invitee: { inviteeUnion: { memberProfile: urn } },
    customMessage: "worth a look?",
  });

  const flat = DASH_INVITE_BODIES[1]!.build(urn, "worth a look?");
  assert.equal(flat.inviteeProfileUrn, urn, "the dash field takes the whole urn, not a split id");
  assert.ok(!("invitee" in flat), "the miniProfile-era envelope is gone");

  // No note means no field at all, rather than an empty one — in every candidate.
  for (const c of DASH_INVITE_BODIES) {
    const b = c.build(urn);
    assert.ok(!("customMessage" in b), `${c.name} sends an empty note field`);
  }
  // `inviteBody` still answers with the leading candidate, so callers that want one shape get the
  // one we currently believe in.
  assert.deepEqual(inviteBody(urn), DASH_INVITE_BODIES[0]!.build(urn));
});

// WHAT LINKEDIN SAID, not just the number it said it with.
//
// `follow` answered 400 three times a tick for a week and the only thing written anywhere was
// "voyager follow 400". That cannot tell a malformed body from a retired endpoint from an account
// restriction, and all three were live hypotheses while the founder was told to reconnect.
//
// The kill-switch matters here: `followPerson` refuses before any network call unless
// MYCEL_LINKEDIN_WARMUP=1, because its endpoints are INFERRED and unverified by the package's own
// admission. Production has that flag ON, which is why these calls reach LinkedIn at all — and why
// they have been answering 400 rather than working.

test("engage: a failure carries LinkedIn's own reason, not just the status", async () => {
  process.env.MYCEL_LINKEDIN_WARMUP = "1"; // production has this on; see the note above
  const session = { li_at: "x", jsessionid: '"ajax:1"' } as never;
  const ctx = { connectionId: "c", proxyUrl: "http://p" } as never;
  const call = async () => ({
    ok: false,
    status: 400,
    json: { code: "MISSING_REQUIRED_FIELD", message: "followeeUrn" },
    text: '{"code":"MISSING_REQUIRED_FIELD"}',
  });
  const r = await followPerson(session, ctx, "urn:li:fsd_profile:A", call as never);
  assert.equal(r.ok, false);
  assert.match(String(r.detail), /voyager follow 400/);
  assert.match(String(r.detail), /MISSING_REQUIRED_FIELD/, "the constant LinkedIn returned");
});

test("engage: an unrecognised body is printed rather than swallowed", async () => {
  process.env.MYCEL_LINKEDIN_WARMUP = "1";
  // The whole problem is that we do not know the shape. Refusing to print one we cannot parse
  // repeats the mistake this fixes.
  const session = { li_at: "x", jsessionid: '"ajax:1"' } as never;
  const ctx = { connectionId: "c", proxyUrl: "http://p" } as never;
  const call = async () => ({ ok: false, status: 400, json: {}, text: "  plain words   about   why  " });
  const r = await followPerson(session, ctx, "urn:li:fsd_profile:A", call as never);
  assert.match(String(r.detail), /plain words about why/, "whitespace collapsed, content kept");
});

test("engage: success says nothing extra", async () => {
  process.env.MYCEL_LINKEDIN_WARMUP = "1";
  const session = { li_at: "x", jsessionid: '"ajax:1"' } as never;
  const ctx = { connectionId: "c", proxyUrl: "http://p" } as never;
  const call = async () => ({ ok: true, status: 200, json: {}, text: "" });
  const r = await followPerson(session, ctx, "urn:li:fsd_profile:A", call as never);
  assert.deepEqual(r, { ok: true, detail: "followed" });
});
