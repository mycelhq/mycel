// Whether a message may be sent, which mailbox sends it, and what a bounce costs.
//
// ═══ WHY THESE TESTS LIVE IN THE KERNEL ═══
//
// Same reason `@mycel/gtm-math`'s do: the package is a dependency of two apps and has no test runner
// of its own, and the kernel is where a `npm test` already runs on every gate. The alternative — a
// third test setup for a package with no dependencies — buys nothing.
//
// The tests that matter here are the refusals. A sending system that is merely enthusiastic is easy;
// what makes one survive is that it says no to a mailbox that has not earned the volume, no to an
// address that bounced, and no to somebody who pressed the spam button — every time, with no way
// round it.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  DEFAULT_POLICY,
  RAMP,
  RAMP_CEILING,
  SuppressionLedger,
  addressKey,
  chooseInbox,
  earnedWeek,
  fromSmtpCode,
  gradeAddress,
  judge,
  keepsPlaintext,
  looksLikeEmail,
  merge,
  normalizeEmail,
  rampFor,
  refusalSaid,
  applyPenalty,
  shouldBurn,
  type InboxSnapshot,
} from "@mycel/deliverability";
import { readDeliveryEvent, readDsn } from "../src/outreach/bounces";
import { recentSuppressions, suppressAddress } from "../src/outreach/suppression";
import { executeAction } from "../src/actions";
import { getDomainStore } from "../src/domain";
import { inboxHealth, mayEmail, penaliseInbox, recordEmailSend } from "../src/outreach/inbox-health";
import { sendingReport } from "../src/outreach/sending-report";

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const at = (iso: string) => new Date(iso);

// ── The key ──────────────────────────────────────────────────────────────────────────────────────

test("one person, one key — the whole list depends on it", () => {
  // A suppression list is only as good as its key. If the list stores one spelling and the send path
  // looks up another, somebody who asked us to stop gets mailed again, which is the single failure
  // this entire area exists to prevent.
  assert.equal(normalizeEmail("  Sam@Example.COM "), "sam@example.com");
  assert.equal(addressKey("Sam@Example.com", sha), addressKey("sam@example.com ", sha));

  // Subaddressing and dots are NOT collapsed, and both are deliberate. Gmail ignores them; nearly
  // nobody else does, so `s.am@corp.com` at a corporate host is a different person. Suppressing an
  // address somebody never asked us to suppress is the worse error.
  assert.notEqual(addressKey("sam+news@example.com", sha), addressKey("sam@example.com", sha));
  assert.notEqual(addressKey("s.am@example.com", sha), addressKey("sam@example.com", sha));
});

test("addresses a cold sender must never touch are graded apart from ones a founder may choose", () => {
  // `abuse@` and `postmaster@` are the addresses a receiver watches specifically to catch senders
  // like us. Hitting one is how a domain gets blocklisted rather than merely ignored.
  assert.equal(gradeAddress("abuse@corp.com"), "never");
  assert.equal(gradeAddress("no-reply@corp.com"), "never");
  assert.equal(gradeAddress("noreply.orders@corp.com"), "never", "a suffix does not make it a person");
  // A judgement, not a refusal: a small business genuinely reads info@, and a founder may reasonably
  // decide to write to it. Reported so they can decide; never silently dropped.
  assert.equal(gradeAddress("info@corp.com"), "role");
  assert.equal(gradeAddress("sam.hartley@corp.com"), "person");

  assert.equal(looksLikeEmail("sam@corp.com"), true);
  assert.equal(looksLikeEmail("sam@corp"), false, "no dot in the domain");
  assert.equal(looksLikeEmail("sam..h@corp.com"), false);
});

// ── The ramp ─────────────────────────────────────────────────────────────────────────────────────

const inbox = (over: Partial<InboxSnapshot> = {}): InboxSnapshot => ({
  address: "a@one.com",
  domain: "one.com",
  displayName: null,
  startedAt: at("2026-08-01T00:00:00Z"),
  state: "active",
  penalty: 0,
  penaltyAt: null,
  sentTotal: 0,
  bounces: 0,
  complaints: 0,
  sentToday: 0,
  lastSendAt: null,
  ...over,
});

test("the ramp is EARNED, not waited out", () => {
  // THE BUG THIS RULE EXISTS FOR, observed on a real fleet: three mailboxes, calendar week 2,
  // therefore permitted 15/day each — 45/day across the fleet — on four lifetime sends between them.
  // Time did not build the reputation. Delivered mail builds the reputation, and there was none.
  const idle = rampFor(inbox({ sentTotal: 4 }), at("2026-08-12T10:00:00Z"));
  assert.equal(idle.calendarWeek, 2);
  assert.equal(idle.week, 1, "no volume behind it, so it is still a week-1 mailbox");
  assert.equal(idle.cap, RAMP[0]);
  assert.match(idle.reason, /only earns week 1/);

  // A mailbox that actually worked its allowance advances on schedule and notices nothing.
  const worked = rampFor(inbox({ sentTotal: 40 }), at("2026-08-12T10:00:00Z"));
  assert.equal(worked.week, 2);
  assert.equal(worked.cap, RAMP[1]);

  // And it cannot outrun the calendar either: reputation takes wall-clock time to register at a
  // receiver no matter how eagerly you send.
  assert.equal(rampFor(inbox({ sentTotal: 5000 }), at("2026-08-03T10:00:00Z")).week, 1);
  assert.equal(earnedWeek(0), 1);
});

test("a complaint costs twice what a bounce costs, and the ramp goes down as well as up", () => {
  // A bounce means the address was wrong — a data problem upstream. A complaint means the address
  // was RIGHT and a real person said "this is spam". That is a verdict on the message.
  const base = { penalty: 0, penaltyAt: null };
  assert.equal(applyPenalty(base, "complaint", at("2026-09-01T00:00:00Z")).penalty, 2);
  assert.equal(applyPenalty(base, "hard_bounce", at("2026-09-01T00:00:00Z")).penalty, 1);
  // A full mailbox is not a list-quality problem.
  assert.equal(applyPenalty(base, "transient_bounce", at("2026-09-01T00:00:00Z")).penalty, 0);

  // The step-back is relative to where the inbox actually is, so the bite scales with the ramp.
  const NOW = at("2026-08-31T10:00:00Z");
  const mature = inbox({ sentTotal: 5000, startedAt: at("2026-07-01T00:00:00Z"), penalty: 2, penaltyAt: at("2026-08-30T00:00:00Z") });
  const hit = rampFor(mature, NOW);
  assert.equal(hit.calendarWeek, 9);
  assert.equal(hit.week, 7, "nine calendar weeks, stepped back two");
  assert.ok(hit.cap < RAMP_CEILING);
  assert.match(hit.reason, /stepped back 2/);

  /**
   * AND A MAILBOX WITH ENOUGH CALENDAR SLACK ABSORBS THE SAME PENALTY WITHOUT LOSING A SEND. This
   * test asserted the opposite first and the code was right: at fourteen calendar weeks the ramp is
   * already capped by what the mailbox's own volume EARNED (week 8), so subtracting two from the
   * calendar changes nothing. That is the earned-week rule doing its job — the penalty bites where
   * the calendar is what is holding the cap up, which is exactly where a step-back should land.
   */
  const veteran = rampFor({ ...mature, startedAt: at("2026-06-01T00:00:00Z") }, NOW);
  assert.equal(veteran.calendarWeek, 14);
  assert.equal(veteran.cap, RAMP_CEILING);

  // Penalty decays, one week per clean fortnight. Without decay one bad address cripples a mailbox
  // forever, which pushes an operator toward editing the number by hand.
  const recovered = rampFor({ ...mature, penaltyAt: at("2026-07-05T00:00:00Z") }, NOW);
  assert.equal(recovered.penalty, 0);
  assert.equal(recovered.cap, RAMP[7]);

  // And far enough down is burned: zero sends, and a human has to clear it. Deliberately not
  // self-healing — "it fixed itself overnight" is how a burned mailbox quietly resumes.
  assert.equal(shouldBurn({ penalty: 10 }), true);
  assert.equal(rampFor(inbox({ state: "burned" }), at("2026-09-01T10:00:00Z")).cap, 0);
});

test("a bad list holds an old mailbox at week-1 volume, however old it is", () => {
  // Age is evidence of nothing once the list feeding the mailbox is bad.
  const old = inbox({ startedAt: at("2026-01-01T00:00:00Z"), sentTotal: 4000, bounces: 300 });
  const v = rampFor(old, at("2026-09-01T10:00:00Z"));
  assert.equal(v.cap, RAMP[0]);
  assert.match(v.reason, /bounce rate/);

  // But not before the sample means anything: one bounce from a three-send mailbox is not a 33%
  // bounce rate, and at that point age alone means 5 a day anyway.
  const young = rampFor(inbox({ sentTotal: 3, bounces: 1 }), at("2026-08-03T10:00:00Z"));
  assert.match(young.reason, /week 1/);
});

// ── Rotation ─────────────────────────────────────────────────────────────────────────────────────

const WEDNESDAY_11AM = at("2026-09-02T11:00:00Z");

test("least-used-FIRST by fraction of its own cap, not round-robin", () => {
  // Round-robin looks fair and is not: inboxes have different caps, so a fixed rotation over-serves
  // the newest mailbox and under-serves the mature one.
  const fleet = [
    inbox({ address: "new@one.com", startedAt: at("2026-08-30T00:00:00Z"), sentTotal: 0, sentToday: 3 }),
    inbox({ address: "old@two.com", domain: "two.com", startedAt: at("2026-06-01T00:00:00Z"), sentTotal: 5000, sentToday: 10 }),
  ];
  const r = chooseInbox(fleet, DEFAULT_POLICY, WEDNESDAY_11AM, () => 0);
  // The mature mailbox has sent more in absolute terms and far less as a fraction of what it can
  // safely carry, which is what "spread the sends" actually means.
  assert.equal(r.choice?.inbox.address, "old@two.com");
});

test("the refusals are distinct, because a healthy engine must not look like a stalled one", () => {
  assert.equal(chooseInbox([], DEFAULT_POLICY, WEDNESDAY_11AM).refusal, "no_inboxes");
  // Cold mail timestamped 03:14 on a Sunday is not from a founder.
  assert.equal(chooseInbox([inbox()], DEFAULT_POLICY, at("2026-09-06T11:00:00Z")).refusal, "outside_window");
  assert.equal(chooseInbox([inbox()], DEFAULT_POLICY, at("2026-09-02T03:14:00Z")).refusal, "outside_window");
  assert.equal(chooseInbox([inbox({ state: "paused" })], DEFAULT_POLICY, WEDNESDAY_11AM).refusal, "all_paused");
  // "all_at_cap" at 2pm is the system working correctly; "all_spacing" means come back in a minute.
  assert.equal(chooseInbox([inbox({ sentToday: 99 })], DEFAULT_POLICY, WEDNESDAY_11AM).refusal, "all_at_cap");
  const justSent = inbox({ lastSendAt: at("2026-09-02T10:59:30Z") });
  assert.equal(chooseInbox([justSent], DEFAULT_POLICY, WEDNESDAY_11AM).refusal, "all_spacing");
});

test("no single domain may carry the whole day, even when it is the healthy one", () => {
  // Without this the healthy domain silently absorbs all the volume and is then the only domain that
  // gets burned. Two mature mailboxes on one domain against one new mailbox on another.
  const fleet = [
    inbox({ address: "a@one.com", startedAt: at("2026-06-01T00:00:00Z"), sentTotal: 5000 }),
    inbox({ address: "b@one.com", startedAt: at("2026-06-01T00:00:00Z"), sentTotal: 5000 }),
    inbox({ address: "c@two.com", domain: "two.com", startedAt: at("2026-08-30T00:00:00Z"), sentTotal: 0 }),
  ];
  const r = chooseInbox(fleet, DEFAULT_POLICY, WEDNESDAY_11AM, () => 0);
  const one = r.domains.find((d) => d.domain === "one.com")!;
  assert.ok(one.ceiling < one.cap, "the healthy domain is held below what its mailboxes could carry");
  // And the ceiling can only ever LOWER a domain's capacity — a share above what its mailboxes can
  // carry is not extra permission.
  const two = r.domains.find((d) => d.domain === "two.com")!;
  assert.ok(two.ceiling <= two.cap);
});

// ── The verdict ──────────────────────────────────────────────────────────────────────────────────

test("permanent suppresses forever; transient suppresses nobody", () => {
  // THE ONE JUDGEMENT IN THE FILE. Getting it backwards in either direction is expensive: suppress
  // on a transient bounce and a real prospect is deleted because their server had a bad minute;
  // fail to suppress on a permanent one and the bounce rate that gets a domain blocked is being fed
  // deliberately, one retry at a time.
  const hard = judge({ kind: "bounce", permanent: true, address: "Gone@corp.com", inbox: "a@one.com", diagnostic: "550 5.1.1 user unknown" });
  assert.equal(hard.suppress, "hard_bounce");
  assert.equal(hard.penaltyWeeks, 1);
  assert.equal(hard.address, "gone@corp.com", "normalised, so it matches the key the list is stored under");

  const soft = judge({ kind: "bounce", permanent: false, address: "busy@corp.com", diagnostic: "452 mailbox full" });
  assert.equal(soft.suppress, undefined);
  assert.equal(soft.penaltyWeeks, 0);
  assert.match(soft.detail, /still real/);

  // "The transport did not say" is treated as transient. The cost of guessing permanent is deleting
  // a real person; the cost of guessing transient is one wasted retry.
  assert.equal(judge({ kind: "bounce", address: "x@corp.com" }).suppress, undefined);
});

test("a complaint is a verdict on the message, and costs the mailbox twice as much", () => {
  const c = judge({ kind: "complaint", address: "sam@corp.com", inbox: "a@one.com" });
  assert.equal(c.suppress, "complaint");
  assert.equal(c.penaltyWeeks, 2);
  assert.match(c.detail, /marked this as spam/);
  // Plain English for a person, never a code — a refusal is when somebody is already frustrated.
  assert.ok(!/[_.]/.test(c.detail.split(" ")[0]!));
});

test("a provider refusing to send is OUR problem, and must not suppress the recipient", () => {
  // Bad credentials, a content filter, an unverified identity. Suppressing the recipient for our own
  // misconfiguration deletes a real prospect for something they had no part in.
  const r = judge({ kind: "reject", address: "sam@corp.com", inbox: "a@one.com", diagnostic: "identity not verified" });
  assert.equal(r.suppress, undefined);
  assert.equal(r.penaltyWeeks, 0);
  assert.match(r.detail, /configuration problem on our side/);
});

test("SMTP and SES reach the same verdict, because they are two shapes of one fact", () => {
  // On SES a bounce arrives hours later over SNS; on SMTP the receiving server says it during the
  // transaction. The consequences have to be identical or the two products enforce different rules.
  const smtp = fromSmtpCode({ code: 550, to: "gone@corp.com", inbox: "a@one.com", response: "5.1.1 user unknown" });
  const ses = judge({ kind: "bounce", permanent: true, address: "gone@corp.com", inbox: "a@one.com", diagnostic: "5.1.1 user unknown" });
  assert.equal(smtp.suppress, ses.suppress);
  assert.equal(smtp.penaltyWeeks, ses.penaltyWeeks);

  assert.equal(fromSmtpCode({ code: 451, to: "busy@corp.com" }).suppress, undefined, "4xx is greylisting, not death");
});

// ── The list ─────────────────────────────────────────────────────────────────────────────────────

test("FIRST WRITE WINS on the reason, and that is not an implementation detail", () => {
  // Somebody unsubscribed in March and their mailbox hard-bounced in June. The reason that matters —
  // the one an operator or a regulator would ask about — is the unsubscribe. Overwriting it erases
  // the record of a request we were legally obliged to honour, and the answer is the same either way.
  const key = addressKey("sam@corp.com", sha);
  const ledger = new SuppressionLedger();
  ledger.add({ key, reason: "unsubscribe", at: "2026-03-04T09:00:00Z" });
  const second = ledger.add({ key, reason: "hard_bounce", at: "2026-06-11T09:00:00Z" });
  assert.equal(second.created, false);
  assert.equal(ledger.get(key)!.reason, "unsubscribe");
  assert.equal(ledger.size, 1);

  assert.equal(merge(undefined, { key, reason: "complaint", at: "x" }).reason, "complaint");
});

test("a request to stop is honoured WITHOUT keeping the address; an incident keeps it", () => {
  // Honouring "stop processing my data" by writing that person's address into a new permanent table
  // is the wrong shape, and the hash honours it forever without keeping what they asked us to drop.
  assert.equal(keepsPlaintext("unsubscribe"), false);
  assert.equal(keepsPlaintext("reply_optout"), false);
  // A bounce or a complaint is an incident WE have to investigate — "which list did this come from"
  // needs the address.
  assert.equal(keepsPlaintext("hard_bounce"), true);
  assert.equal(keepsPlaintext("complaint"), true);
});

test("the refusal a founder reads names the reason and no field of ours", () => {
  const said = refusalSaid({ reason: "complaint", at: "2026-06-11T09:00:00Z" });
  assert.equal(said, "Not sent: they marked a message as spam on 2026-06-11.");
  for (const reason of ["unsubscribe", "reply_optout", "hard_bounce", "complaint", "manual", "region"] as const) {
    const line = refusalSaid({ reason, at: "2026-06-11T09:00:00Z" });
    assert.ok(!/_/.test(line), `${reason} leaks a field name: ${line}`);
    assert.ok(!/suppress/i.test(line), `${reason} uses our vocabulary: ${line}`);
  }
});

test("the ledger has no way to remove a row, deliberately", () => {
  // Coming off a suppression list is a hand-written delete by a person with a reason — never a
  // method something can call in a loop.
  const ledger = new SuppressionLedger();
  assert.equal(typeof (ledger as unknown as { remove?: unknown }).remove, "undefined");
  assert.equal(typeof (ledger as unknown as { delete?: unknown }).delete, "undefined");
});

// ── The kernel side: recognising a failure, and refusing the next send ───────────────────────────
//
// Everything above is the shared rules. These are the two places the kernel was cut: it saw every
// bounce and threw it away, and it had no list to check before sending.

test("a bounce that arrives as an ordinary email is read, not filed as a reply", () => {
  // ═══ THE ONE THAT WAS WORSE THAN SILENT ═══
  //
  // When a receiving server rejects a message after accepting it, the failure comes back as a
  // delivery status notification — a normal email from MAILER-DAEMON to the mailbox that sent it. It
  // arrived as `message.received`, parsed cleanly, and was filed as a message on the client's thread.
  //
  // So a dunning chase to a dead address produced a "reply", and a ladder that stands down on an
  // inbound reply stood down. The client never wrote and their invoice stopped being chased.
  const v = readDsn({
    from_handle: "mailer-daemon@googlemail.com",
    subject: "Delivery Status Notification (Failure)",
    inbox_id: "chase@hartley.co.uk",
    text: [
      "Address not found.",
      "",
      "Final-Recipient: rfc822; ap@harlow.co.uk",
      "Action: failed",
      "Status: 5.1.1",
      "Diagnostic-Code: smtp; 550 5.1.1 The email account that you tried to reach does not exist.",
    ].join("\n"),
  })!;
  assert.ok(v, "a real DSN with the RFC 3464 fields is recognised");
  assert.equal(v.suppress, "hard_bounce");
  // THE ADDRESS IS THE ONE THAT FAILED — never the daemon that sent the report, and never our own
  // mailbox that received it. Suppressing either would be worse than doing nothing.
  assert.equal(v.address, "ap@harlow.co.uk");
});

test("a soft DSN is read and suppresses nobody", () => {
  const v = readDsn({
    from_handle: "postmaster@corp.com",
    inbox_id: "chase@hartley.co.uk",
    text: "Final-Recipient: rfc822; sam@corp.com\nStatus: 4.2.2\nDiagnostic-Code: smtp; 452 mailbox full",
  })!;
  assert.equal(v.suppress, undefined);
  assert.match(v.detail, /still real/);
});

test("failing to recognise a DSN is the safe direction, and the rules say which way", () => {
  // An unrecognised DSN is filed as a message, which is where they all went before. A false positive
  // suppresses a real person on the strength of a subject line, which is not the same cost.

  // A real person writing about a bounce is not a bounce.
  assert.equal(readDsn({ from_handle: "sam@corp.com", subject: "Delivery failed?", text: "Status: 5.1.1 — did this bounce?" }), undefined);
  // A daemon with no machine-readable recipient cannot say whose address died.
  assert.equal(readDsn({ from_handle: "mailer-daemon@corp.com", text: "Your message could not be delivered." }), undefined);
  // A daemon and a recipient but no status: unclassifiable, and guessing permanent deletes a real
  // person over a mailbox that was full for an hour.
  assert.equal(readDsn({ from_handle: "mailer-daemon@corp.com", text: "Final-Recipient: rfc822; sam@corp.com" }), undefined);
  // An out-of-office from a no-reply address is not a DSN either.
  assert.equal(readDsn({ from_handle: "no-reply@corp.com", subject: "Out of office", text: "I am away until Monday." }), undefined);
});

test("a provider's own bounce and complaint events stop being acknowledged into nothing", () => {
  // These came down the webhook and were answered `{ ok: true, ignored }`. The kernel saw every
  // bounce against every agency running on it and learned nothing from any of them.
  const complained = readDeliveryEvent({
    event_type: "message.complained",
    message: { inbox_id: "chase@hartley.co.uk", to: "sam@corp.com", message_id: "m1" },
  })!;
  assert.equal(complained.suppress, "complaint");
  assert.equal(complained.penaltyWeeks, 2);

  // PERMANENCE COMES FROM THE PROVIDER'S WORD, NEVER THE EVENT NAME. `message.bounced` says a message
  // bounced and nothing about whether the address is dead; a provider reporting a full mailbox and a
  // nonexistent user under one name is normal.
  const soft = readDeliveryEvent({ event_type: "message.bounced", message: { to: "sam@corp.com", reason: "452 4.2.2 mailbox full" } })!;
  assert.equal(soft.suppress, undefined);
  const hard = readDeliveryEvent({ event_type: "message.bounced", message: { to: "gone@corp.com", bounce_type: "Permanent" } })!;
  assert.equal(hard.suppress, "hard_bounce");
  // Unstated is transient, for the same reason.
  assert.equal(readDeliveryEvent({ event_type: "message.bounced", message: { to: "x@corp.com" } })!.suppress, undefined);

  // And the SES vocabulary reaches the same verdict, because they are two spellings of one fact.
  const ses = readDeliveryEvent({
    notificationType: "Bounce",
    mail: { source: "chase@hartley.co.uk", messageId: "m2", destination: ["gone@corp.com"] },
    bounce: { bounceType: "Permanent", bounceSubType: "General", bouncedRecipients: [{ emailAddress: "gone@corp.com", diagnosticCode: "550 5.1.1" }] },
  })!;
  assert.equal(ses.suppress, "hard_bounce");
  assert.equal(ses.address, "gone@corp.com");

  // A reply is not a delivery event and must not be mistaken for one.
  assert.equal(readDeliveryEvent({ event_type: "message.received", message: { to: "x@corp.com" } }), undefined);
});

test("a suppressed address is refused by the ONE function that sends, whatever the action is called", async () => {
  // ═══ THE TEST THIS WHOLE BUILD EXISTS FOR ═══
  //
  // A hard bounce arrives, the address goes on the list, and the next step of the sequence tries to
  // mail it anyway. Before this, it did. Retrying a dead address is the single behaviour that feeds
  // the bounce rate that gets a sending domain blocked.
  const domain = getDomainStore();
  const project = `p-supp-${Date.now()}`;
  const conn = await domain.createConnection({
    project_id: project,
    kind: "email",
    name: "sending",
    owner: { kind: "founder", id: "f" },
    config: { api_url: "http://127.0.0.1:1/never-called", from: "chase@hartley.co.uk" },
  });

  // The webhook's job, done directly: a permanent bounce becomes a row on this business's list.
  const bounce = readDeliveryEvent({
    event_type: "message.bounced",
    message: { inbox_id: "chase@hartley.co.uk", to: "gone@harlow.co.uk", bounce_type: "Permanent", reason: "550 5.1.1 no such user" },
  })!;
  await suppressAddress({ project_id: project, email: bounce.address!, reason: bounce.suppress! });

  // Now the next send. The action is deliberately NOT called `send_*`: the check must not depend on
  // somebody spelling their capability a particular way, because that is a way round it nobody meant
  // to leave. It also must not need the network — if this reaches fetch, the test hangs rather than
  // passing, which is the right way for this assertion to fail.
  const refused = await executeAction(conn, "notify_client", { to: "Gone@Harlow.co.uk", subject: "Invoice INV-0007", body: "..." });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "suppressed");
  // Plain English, and none of our vocabulary — this lands on a founder's screen.
  assert.match(refused.detail!, /does not exist/);
  assert.ok(!/suppress|hard_bounce|project_id/i.test(refused.detail!), refused.detail);

  // Case and whitespace are the same person. If the list stores one spelling and the send path looks
  // up another, somebody who asked us to stop gets mailed again.
  assert.equal((await executeAction(conn, "x", { to: "  gone@harlow.co.uk " })).code, "suppressed");
  // A recipient in an array is checked too — one suppressed address refuses the whole send rather
  // than quietly dropping a name the founder believes was written to.
  assert.equal((await executeAction(conn, "x", { to: ["ok@harlow.co.uk", "gone@harlow.co.uk"] })).code, "suppressed");

  // And somebody who is NOT on the list is not refused by this gate. (It fails at the network, which
  // is the point: the suppression check let it through.)
  const allowed = await executeAction(conn, "x", { to: "ap@harlow.co.uk" });
  assert.notEqual(allowed.code, "suppressed");

  // The list is per-tenant: another agency's outreach to the same person is none of our business.
  const other = await domain.createConnection({
    project_id: `${project}-other`,
    kind: "email",
    name: "sending",
    owner: { kind: "founder", id: "f" },
    config: { api_url: "http://127.0.0.1:1/never-called", from: "hello@other.co.uk" },
  });
  assert.notEqual((await executeAction(other, "x", { to: "gone@harlow.co.uk" })).code, "suppressed");
});

test("first write wins across the store, not just in memory", async () => {
  const project = `p-first-${Date.now()}`;
  await suppressAddress({ project_id: project, email: "sam@corp.com", reason: "unsubscribe", at: "2026-03-04T09:00:00Z" });
  const second = await suppressAddress({ project_id: project, email: "SAM@corp.com", reason: "hard_bounce" });
  assert.equal(second.created, false);
  assert.equal(second.row.reason, "unsubscribe", "the request we were obliged to honour outranks the bounce");

  // And a request to stop is honoured WITHOUT keeping the address; an incident keeps it.
  const stored = (await recentSuppressions(project))[0]!;
  assert.equal(stored.reason, "unsubscribe");
  assert.equal(stored.email, undefined, "no plaintext for somebody who asked us to stop processing it");

  await suppressAddress({ project_id: project, email: "gone@corp.com", reason: "hard_bounce" });
  assert.equal((await recentSuppressions(project)).find((s) => s.reason === "hard_bounce")!.email, "gone@corp.com");
});

// ── The ramp, on the agency's own sending ────────────────────────────────────────────────────────
//
// The suppression list stops us mailing a particular person. It says nothing about how fast a
// mailbox may send, and cold outreach email from this kernel had no ceiling of ANY kind — the
// sequencer exempted it from LinkedIn's budget (correctly) and replaced it with `{ allowed: true }`.

const IN_WINDOW = new Date("2026-09-02T11:00:00Z"); // a Wednesday, mid-morning

test("a brand-new mailbox sends five a day, not a hundred", async () => {
  const project = `p-ramp-${Date.now()}`;
  const from = "hello@hartley.co.uk";

  const first = await mayEmail({ project_id: project, address: from, now: IN_WINDOW });
  assert.equal(first.allowed, true);
  assert.equal(first.ramp.cap, RAMP[0], "week one, because it has never sent anything");

  // Work the allowance. Each send is recorded only after a successful dispatch — counting on intent
  // would let a run of transport failures eat the day and advance the warm-up on undelivered volume.
  for (let i = 0; i < RAMP[0]!; i++) {
    await recordEmailSend({ project_id: project, address: from, now: IN_WINDOW });
  }
  const spent = await mayEmail({ project_id: project, address: from, now: IN_WINDOW });
  assert.equal(spent.allowed, false);
  assert.match(spent.reason, /sent its 5 for today/);
  // A founder gets a wait that matches the situation: come back tomorrow, not in four minutes.
  assert.ok(spent.nextAfterMs >= 60 * 60 * 1000);
});

test("the refusals are in a founder's words, and each one waits a different length of time", async () => {
  const project = `p-window-${Date.now()}`;
  const from = "hello@hartley.co.uk";

  // Cold email timestamped 03:14 on a Sunday is not from a founder.
  const sunday = await mayEmail({ project_id: project, address: from, now: new Date("2026-09-06T11:00:00Z") });
  assert.equal(sunday.allowed, false);
  assert.match(sunday.reason, /weekday, in working hours/);

  const night = await mayEmail({ project_id: project, address: from, now: new Date("2026-09-02T03:14:00Z") });
  assert.equal(night.allowed, false);

  // Spacing: a mailbox that sent ninety seconds ago does not send again.
  await recordEmailSend({ project_id: project, address: from, now: IN_WINDOW });
  const tooSoon = await mayEmail({ project_id: project, address: from, now: new Date(IN_WINDOW.getTime() + 30_000) });
  assert.equal(tooSoon.allowed, false);
  assert.match(tooSoon.reason, /spacing/);
  assert.ok(tooSoon.nextAfterMs < 60 * 60 * 1000, "come back in minutes, not tomorrow");

  // None of these say anything a founder would have to look up.
  for (const r of [sunday.reason, night.reason, tooSoon.reason]) {
    assert.ok(!/_/.test(r), r);
    assert.ok(!/ramp|penalty|snapshot|verdict/i.test(r), r);
  }
});

test("a complaint steps the sending mailbox back, and enough of them burn it", async () => {
  const project = `p-burn-${Date.now()}`;
  const from = "hello@hartley.co.uk";
  // Give it a history, so the ramp has somewhere to fall from.
  for (let i = 0; i < 40; i++) await recordEmailSend({ project_id: project, address: from, now: IN_WINDOW });

  const after = await penaliseInbox({ project_id: project, address: from, kind: "complaint" });
  assert.equal(after.penalty, 2, "a complaint is a verdict on the message, and costs two weeks");
  assert.equal(after.state, "warming");

  // A transient bounce costs nothing: a full mailbox is not a list-quality problem.
  const soft = await penaliseInbox({ project_id: project, address: from, kind: "transient_bounce" });
  assert.equal(soft.penalty, 2);

  // Five complaints is burned: zero sends, and a human has to clear it. Deliberately not
  // self-healing — "it fixed itself overnight" is how a burned mailbox quietly resumes.
  for (let i = 0; i < 4; i++) await penaliseInbox({ project_id: project, address: from, kind: "complaint" });
  const burned = await penaliseInbox({ project_id: project, address: from, kind: "complaint" });
  assert.equal(burned.state, "burned");
  const refused = await mayEmail({ project_id: project, address: from, now: IN_WINDOW });
  assert.equal(refused.allowed, false);
  assert.match(refused.reason, /a human must clear this/);
});

test("the ramp is scoped to the BUSINESS and to cold sending, not to a connection or a client", async () => {
  const a = `p-scope-a-${Date.now()}`;
  const b = `p-scope-b-${Date.now()}`;
  for (let i = 0; i < RAMP[0]!; i++) await recordEmailSend({ project_id: a, address: "hello@shared.co.uk", now: IN_WINDOW });

  // One agency exhausting its allowance says nothing about another's, even from a lookalike address.
  assert.equal((await mayEmail({ project_id: a, address: "hello@shared.co.uk", now: IN_WINDOW })).allowed, false);
  assert.equal((await mayEmail({ project_id: b, address: "hello@shared.co.uk", now: IN_WINDOW })).allowed, true);

  // And the health board answers "how is my sending" without anybody re-deriving a cap.
  const board = await inboxHealth(a, IN_WINDOW);
  assert.equal(board.length, 1);
  assert.equal(board[0]!.address, "hello@shared.co.uk");
  assert.equal(board[0]!.sentToday, RAMP[0]);
  assert.equal(board[0]!.ramp.cap, RAMP[0]);
});

test("yesterday's sends do not count against today", async () => {
  const project = `p-day-${Date.now()}`;
  const from = "hello@hartley.co.uk";
  const tuesday = new Date("2026-09-01T11:00:00Z");
  for (let i = 0; i < RAMP[0]!; i++) await recordEmailSend({ project_id: project, address: from, now: tuesday });
  assert.equal((await mayEmail({ project_id: project, address: from, now: tuesday })).allowed, false);

  // A new day resets the daily counter and nothing else: the lifetime total still stands, which is
  // what the warm-up advances on.
  const wednesday = await mayEmail({ project_id: project, address: from, now: IN_WINDOW });
  assert.equal(wednesday.allowed, true);
  assert.equal((await inboxHealth(project, IN_WINDOW))[0]!.sentTotal, RAMP[0]);
});

// ── What a founder is actually told ─────────────────────────────────────────────────────────────
//
// The rule is that a founder never sees the guts of the platform, and this is the worst area to
// forget it in: nobody running a bookkeeping practice knows what a warm-up ramp is, what week 3
// means, or why a hard bounce differs from a soft one. Shown any of it they will ignore the screen
// or ask us what it means, and both of those are the screen failing.

/** Every word this system uses about itself, and none of them may reach a founder. */
const OUR_WORDS =
  /\b(ramp|warm[- ]?up|penalt|suppress|hard[_ ]bounce|soft bounce|transient|snapshot|verdict|inbox_health|project_id|wedge|capability|artifact|week \d|cap\b|throttl|reputation score|sha256|hash)\b/i;

const allText = (r: { headline: string; addresses: { state: string; today: string; why: string }[]; stopped: { who: string; why: string; when: string }[]; do_this: string[] }): string =>
  [r.headline, ...r.addresses.flatMap((a) => [a.state, a.today, a.why]), ...r.stopped.flatMap((s) => [s.who, s.why, s.when]), ...r.do_this].join(" | ");

test("the sending report says nothing a founder would have to look up", async () => {
  const project = `p-report-${Date.now()}`;
  const from = "hello@hartley.co.uk";
  for (let i = 0; i < 3; i++) await recordEmailSend({ project_id: project, address: from, now: IN_WINDOW });
  await suppressAddress({ project_id: project, email: "gone@corp.com", reason: "hard_bounce" });
  await suppressAddress({ project_id: project, email: "sam@corp.com", reason: "unsubscribe" });

  const r = await sendingReport(project, IN_WINDOW);
  assert.match(r.headline, /You can send 2 more emails today/);
  assert.equal(r.addresses[0]!.state, "Settling in");
  assert.equal(r.addresses[0]!.today, "3 of 5 sent today");
  // The reason is an explanation, not a measurement.
  assert.match(r.addresses[0]!.why, /newer address/);
  assert.match(r.addresses[0]!.why, /end up in spam/);

  const text = allText(r);
  const leak = OUR_WORDS.exec(text);
  assert.equal(leak, null, `the report leaks "${leak?.[0]}": ${text}`);
  assert.ok(!/_/.test(text), text);
});

test("who we stopped emailing, described as a person would describe it", async () => {
  const project = `p-stopped-${Date.now()}`;
  await recordEmailSend({ project_id: project, address: "hello@hartley.co.uk", now: IN_WINDOW });
  await suppressAddress({ project_id: project, email: "gone@corp.com", reason: "hard_bounce", at: IN_WINDOW.toISOString() });
  await suppressAddress({ project_id: project, email: "sam@corp.com", reason: "unsubscribe", at: IN_WINDOW.toISOString() });

  const r = await sendingReport(project, new Date(IN_WINDOW.getTime() + 3 * 86_400_000));
  const bounced = r.stopped.find((s) => s.who === "gone@corp.com")!;
  assert.equal(bounced.why, "the address does not exist");
  assert.equal(bounced.when, "3 days ago", "never an ISO string on a screen");

  // An unsubscribe is held only as a hash, so there is no address to show — and "someone who asked
  // to be removed" is both the honest rendering and the more useful sentence. The founder does not
  // need to know WHO, only that somebody did and that we are honouring it.
  const opted = r.stopped.find((s) => s.who !== "gone@corp.com")!;
  assert.equal(opted.who, "Someone who asked to be removed");
  assert.equal(opted.why, "they unsubscribed");
});

test("something to do appears only when a person must do something", async () => {
  const project = `p-act-${Date.now()}`;
  const from = "hello@hartley.co.uk";
  await recordEmailSend({ project_id: project, address: from, now: IN_WINDOW });

  // Healthy: no advice. An empty action list is the GOOD outcome and must never be padded to look
  // busy — a screen that always has three suggestions on it teaches a founder to stop reading them.
  assert.deepEqual((await sendingReport(project, IN_WINDOW)).do_this, []);

  // A complaint: one thing, and it points at the cause rather than at the symptom.
  await penaliseInbox({ project_id: project, address: from, kind: "complaint", now: IN_WINDOW });
  const slowed = await sendingReport(project, IN_WINDOW);
  assert.equal(slowed.addresses[0]!.state, "Slowed down");
  assert.match(slowed.headline, /slowed down/);
  assert.equal(slowed.do_this.length, 1);
  assert.match(slowed.do_this[0]!, /where these contacts came from/);

  // Burned: the one case where waiting does not fix it, and the sentence says so.
  for (let i = 0; i < 5; i++) await penaliseInbox({ project_id: project, address: from, kind: "complaint", now: IN_WINDOW });
  const dead = await sendingReport(project, IN_WINDOW);
  assert.equal(dead.addresses[0]!.state, "Stopped");
  assert.match(dead.headline, /can no longer be used/);
  assert.match(dead.do_this[0]!, /set up a different address/);
  assert.match(dead.do_this[0]!, /cannot be recovered by waiting/);
  assert.equal(OUR_WORDS.exec(allText(dead)), null, allText(dead));
});

test("nothing set up yet is a sentence, not an empty table or a red badge", async () => {
  // A founder who has not started outreach opening this screen should read where they are. An empty
  // state that reads as a fault is how somebody concludes the product is broken on their first visit.
  const r = await sendingReport(`p-empty-${Date.now()}`, IN_WINDOW);
  assert.equal(r.headline, "You have not sent any outreach email yet.");
  assert.deepEqual(r.addresses, []);
  assert.deepEqual(r.do_this, []);
  assert.equal(r.can_send_today, 0);
});
