// The moments worth marking, and the one thing to ask at each.
//
// Every assertion here is about restraint. The easy version of this feature — webhook fires, email
// sends — is wrong in three separate ways, and each of them is a test below.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dueAsk, ASKS, QUIET_DAYS, type Milestone, type AskState } from "../src/milestones";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-09-01T10:00:00Z");
const at = (days: number) => new Date(T0 + days * DAY);
const paid: Milestone = { kind: "first_client_paid", at: new Date(T0).toISOString(), subject: "INV-0001" };
const accepted: Milestone = { kind: "first_deliverable_accepted", at: new Date(T0).toISOString() };

test("nothing is asked in the moment it happens", () => {
  /**
   * THE OBVIOUS BUILD, AND WHY IT IS WRONG EVERY TIME.
   *
   * At the second the payment lands the founder is looking at the SCREEN, not their inbox — an
   * email arriving now is a notification about something they are already looking at. And a request
   * for a favour, from a machine, one second after money moved, reads as a system that was waiting
   * for it rather than a business that is pleased for them.
   */
  assert.equal(dueAsk({ milestones: [paid], sent: [], now: at(0) }), undefined);
  assert.equal(dueAsk({ milestones: [paid], sent: [], now: at(1) }), undefined);
  assert.equal(dueAsk({ milestones: [paid], sent: [], now: at(2.9) }), undefined);

  const due = dueAsk({ milestones: [paid], sent: [], now: at(3) })!;
  assert.equal(due.kind, "referral");
  assert.equal(due.milestone.subject, "INV-0001", "the ask can name what it is about");
});

test("a moment goes cold, and a late ask is dropped rather than delivered", () => {
  // "How did your first month go?" asked eleven weeks later is not a late version of the same
  // question. It is a different, worse question from somebody who has not been paying attention.
  assert.ok(dueAsk({ milestones: [paid], sent: [], now: at(20) }));
  assert.equal(dueAsk({ milestones: [paid], sent: [], now: at(22) }), undefined);
  assert.equal(dueAsk({ milestones: [paid], sent: [], now: at(200) }), undefined);
});

test("one ask at a time, whatever kind — a very good week is not three emails", () => {
  /**
   * A founder who signs their first client, gets paid and ships their first accepted deliverable in
   * one week would otherwise hear from us three times about it. That is how somebody learns to
   * filter your domain, and it would land on the best week they have had.
   */
  const both = [paid, accepted];
  const justSent: AskState[] = [{ kind: "referral", sent_at: at(3).toISOString() }];
  // Satisfaction is due at day 21 and the referral went at day 3 — the floor is what holds it.
  assert.equal(QUIET_DAYS, 10);
  assert.equal(dueAsk({ milestones: both, sent: justSent, now: at(11) }), undefined, "inside the quiet floor");
  const later = dueAsk({ milestones: both, sent: justSent, now: at(21) });
  assert.equal(later?.kind, "satisfaction", "and out the other side, the next one is due");
});

test("an ask is sent once and never again", () => {
  const sent: AskState[] = [{ kind: "referral", sent_at: at(3).toISOString() }];
  // Well past the quiet floor, well inside the window, and still nothing — because it went already.
  assert.equal(dueAsk({ milestones: [paid], sent, now: at(15) }), undefined);
});

test("satisfaction waits three weeks, because on the day everybody says nine", () => {
  // Three weeks is when they know whether the SECOND deliverable was as good as the first, which is
  // the question that predicts whether they stay.
  const spec = ASKS.find((a) => a.kind === "satisfaction")!;
  assert.equal(spec.after_days, 21);
  assert.equal(spec.after_milestone, "first_deliverable_accepted");
  assert.equal(dueAsk({ milestones: [accepted], sent: [], now: at(20) }), undefined);
  assert.equal(dueAsk({ milestones: [accepted], sent: [], now: at(21) })?.kind, "satisfaction");
});

test("no milestone, no ask — this system never invents a reason to write to somebody", () => {
  assert.equal(dueAsk({ milestones: [], sent: [], now: at(365) }), undefined);
  // And an unparseable timestamp is not a moment either. It fails closed, which for an outbound
  // message is the only safe direction.
  assert.equal(dueAsk({ milestones: [{ kind: "first_client_paid", at: "whenever" }], sent: [], now: at(10) }), undefined);
});

test("the referral comes before the satisfaction check when both are ripe", () => {
  // Order is the declaration order in ASKS, and it is deliberate: the referral is asked at the top
  // of the feeling and the satisfaction check is asked once it has settled. Ripe together means the
  // founder has been quiet for a while, and the better question to open with is the happy one.
  const old = { kind: "first_deliverable_accepted" as const, at: new Date(T0 - 15 * DAY).toISOString() };
  const both = dueAsk({ milestones: [paid, old], sent: [], now: at(4) })!;
  assert.equal(both.kind, "referral");
});

test("the ask is a tool, not a favour", async () => {
  /**
   * "Do you know anyone who needs this?" converts on goodwill, which is a thing you spend rather
   * than earn. The referral hands them something to go and USE instead: run the free report on a
   * prospect's domain and it comes back with their name on it, ready to send.
   *
   * Every one of those is a warm lead for them and a real finding in front of somebody who has never
   * heard of us — a better trade for both sides than an email asking for a name.
   */
  const { askCopy } = await import("../src/milestones");
  const copy = askCopy({ kind: "referral", milestone: paid, due_at: new Date(T0).toISOString() });

  assert.match(copy.headline, /INV-0001/, "it names what actually happened");
  assert.match(copy.body, /with your name at the top/i);
  assert.ok(copy.href.startsWith("/"), "it goes somewhere in the product");
  // The words that would make it a favour rather than a tool.
  for (const beg of ["do you know anyone", "refer a friend", "spread the word", "we'd appreciate"]) {
    assert.equal(`${copy.headline} ${copy.body} ${copy.cta}`.toLowerCase().includes(beg), false, beg);
  }

  // The satisfaction check asks about the SECOND deliverable, not the first. On the day of the
  // first, everybody says nine.
  const sat = askCopy({ kind: "satisfaction", milestone: accepted, due_at: new Date(T0).toISOString() });
  assert.match(sat.body, /the ones after it/i);
  // And it offers to fix the process rather than to collect a score. A number nobody acts on is a
  // question that spent the moment for nothing.
  assert.match(sat.body, /fix the way it/i);
});
