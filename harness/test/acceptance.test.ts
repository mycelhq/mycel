// The return half of the GTM loop: an invitation was accepted.
//
// THE BUG THIS FILE EXISTS TO PREVENT, above every other assertion in it: `factsFor` in sequence.ts
// has always read `data.connected`, `DEFAULT_SEQUENCE` gates its first DM on `connected AND
// !replied`, and for a long time NOTHING IN THE REPOSITORY EVER WROTE THAT FIELD. Every prospect
// walked view_profile → send_invite → `invited`, sat there, and was closed `lost` at twenty-one
// days. A prospect could never become a conversation, let alone a client, and nothing failed and
// nothing logged — the pipeline just looked like a quiet week. `test/gtm-loop.test.ts` proves the
// outbound half and stops at the invitation, which is precisely why the gap survived: both halves
// passed their tests and the loop was still open.
//
// So the first test below asserts the field itself, by name, and the last one asserts the thing the
// field is FOR — that pacing's feedback term moves off the same observation rather than off a
// counter nobody increments.
import { test } from "node:test";
import assert from "node:assert/strict";
import { initSecretStore } from "../src/secrets";
import { getDomainStore } from "../src/domain";
import { engagementMultiplier, recordEngagement, recordTouch } from "../src/pacing";
import { noteAcceptedInvitations, INVITE_ACCEPTED } from "../src/gtm/acceptance";
import { connectionIds } from "../src/linkedin/network";
import { factsFor } from "../src/gtm/sequence";
import { gtmWedge } from "../src/gtm/stages";

await initSecretStore();

const domain = () => getDomainStore();

let seq = 0;
/** A LinkedIn account row. Its own project per call, because these tests assert on tenancy. */
async function account(projectId: string) {
  return domain().createConnection({
    project_id: projectId,
    kind: "linkedin",
    name: `LI ${++seq}`,
    owner: { kind: "founder", id: "founder" },
    config: {},
  });
}

async function invitedCase(projectId: string, connectionId: string, profileId: string, stage = "invited") {
  return domain().createCase({
    project_id: projectId,
    wedge: gtmWedge(),
    title: profileId,
    stage,
    status: "open",
    data: { campaign_id: "c1", connection_id: connectionId, profile_id: profileId },
  });
}

test("acceptance writes `data.connected` — the field factsFor has always read and nothing ever wrote", async () => {
  const conn = await account("p-connected");
  const kase = await invitedCase("p-connected", conn.id, "dana-okafor");

  // Before: the sequencer's own view of this case says it is NOT connected, so the DM step's
  // `only_if: "connected AND !replied"` cannot pass. This was the terminal state of every prospect.
  assert.equal(factsFor((await domain().getCase(kase.id))!).connected, false);

  const r = await noteAcceptedInvitations(domain(), { id: conn.id, project_id: "p-connected" }, {
    connected: ["dana-okafor"],
  });
  assert.equal(r.accepted, 1);
  assert.deepEqual(r.case_ids, [kase.id]);

  const after = (await domain().getCase(kase.id))!;
  const d = after.data as Record<string, unknown>;
  // The field, asserted by name. If a refactor renames it on one side only, this fails here rather
  // than silently reopening the twenty-one-day-to-`lost` bug in production.
  assert.equal(d.connected, true, "`data.connected` was not written — the DM step can never unlock");
  assert.equal(after.stage, "connected");
  assert.equal(factsFor(after).connected, true);

  // `invite_accepted` is a SEPARATE fact reading a SEPARATE field, and it was a declared trigger in
  // linkedin/capabilities.ts with no implementation behind it. It must not be a synonym for
  // `connected`: a prospect the founder already knew, enrolled straight at `connected`, has the
  // stage but never accepted anything.
  assert.equal(typeof d.invite_accepted_at, "string");
  assert.equal(factsFor(after).invite_accepted, true, `${INVITE_ACCEPTED} still has nothing behind it`);
});

test("the follow-up is due immediately, because that is the one touch whose timing is worth anything", async () => {
  const conn = await account("p-due");
  const far = new Date(Date.now() + 12 * 3_600_000).toISOString();
  const kase = await domain().createCase({
    project_id: "p-due", wedge: gtmWedge(), title: "Rui", stage: "invited", status: "open",
    // Parked twelve hours out by `waitingStage`, which is where a real invited case actually sits.
    due_at: far,
    data: { campaign_id: "c1", connection_id: conn.id, profile_id: "rui-silva" },
  });

  const now = new Date();
  await noteAcceptedInvitations(domain(), { id: conn.id, project_id: "p-due" }, { connected: ["rui-silva"] }, now);

  const after = (await domain().getCase(kase.id))!;
  assert.equal(after.due_at, now.toISOString(), "an acceptance that stays parked for twelve hours wastes the acceptance");
  // Whatever reason parked it is cleared, or the founder reads "waiting for them to accept" on a
  // case where they demonstrably already did.
  assert.equal((after.data as Record<string, unknown>).paused_reason, undefined);
});

test("only `invited` cases flip — a prospect the founder already knew is not an acceptance", async () => {
  const conn = await account("p-stage");
  // Enrolled but never invited. This person is in the founder's connections for reasons that have
  // nothing to do with us. Counting them would be free budget: acceptance only ever RAISES the
  // multiplier, so an inflated numerator is an account earning allowance it did not earn.
  const queued = await invitedCase("p-stage", conn.id, "old-friend", "queued");
  const invited = await invitedCase("p-stage", conn.id, "dana-okafor", "invited");

  const r = await noteAcceptedInvitations(domain(), { id: conn.id, project_id: "p-stage" }, {
    connected: ["old-friend", "dana-okafor"],
  });
  assert.equal(r.accepted, 1);
  assert.equal((await domain().getCase(queued.id))!.stage, "queued");
  assert.equal((await domain().getCase(invited.id))!.stage, "connected");
});

test("a second poll of the same connections list counts nothing — two replicas must not double-count", async () => {
  // The connections list is a STANDING list, not a delta feed: every poll sees the same people
  // again, and with several scheduler replicas two of them can poll the same account in the same
  // window. The dedupe is structural — the count is cases that MOVED, and a case at `connected` is
  // no longer at `invited` — but that is exactly the kind of property a refactor breaks quietly,
  // because the symptom is an account slowly earning budget rather than an error.
  const conn = await account("p-twice");
  await invitedCase("p-twice", conn.id, "dana-okafor");
  const observation = { connected: ["dana-okafor", "someone-else"] };

  const first = await noteAcceptedInvitations(domain(), { id: conn.id, project_id: "p-twice" }, observation);
  assert.equal(first.accepted, 1);

  const second = await noteAcceptedInvitations(domain(), { id: conn.id, project_id: "p-twice" }, observation);
  assert.equal(second.accepted, 0, "the same acceptance was counted twice — the account is earning budget it did not earn");
  assert.equal(second.pending, 0);

  // And concurrently, which is the shape the replicas actually take.
  const conn2 = await account("p-race");
  await invitedCase("p-race", conn2.id, "dana-okafor");
  const races = await Promise.all(
    Array.from({ length: 4 }, () => noteAcceptedInvitations(domain(), { id: conn2.id, project_id: "p-race" }, observation)),
  );
  assert.equal(races.reduce((n, r) => n + r.accepted, 0), 1, "concurrent polls double-counted one acceptance");
});

test("acceptance is scoped to one tenant, and refuses rather than defaults without a project", async () => {
  // The incident shape this codebase has already had once: `listCases` applies NO tenant filter when
  // handed an undefined project, so a scoping argument that is optional-with-a-default plus one
  // caller that forgets it walks every customer's pipeline. Required, and refused.
  await assert.rejects(
    () => noteAcceptedInvitations(domain(), { id: "c", project_id: "" }, { connected: ["dana-okafor"] }),
    /needs the connection's project/,
  );

  const mine = await account("p-mine");
  const theirs = await account("p-theirs");
  // The SAME person, invited by two different customers. Only the polling tenant's case may move.
  const myCase = await invitedCase("p-mine", mine.id, "dana-okafor");
  const theirCase = await invitedCase("p-theirs", theirs.id, "dana-okafor");

  const r = await noteAcceptedInvitations(domain(), { id: mine.id, project_id: "p-mine" }, { connected: ["dana-okafor"] });
  assert.equal(r.accepted, 1);
  assert.equal((await domain().getCase(myCase.id))!.stage, "connected");
  assert.equal((await domain().getCase(theirCase.id))!.stage, "invited", "another tenant's case moved on our poll");
});

test("two accounts inside ONE project do not answer for each other", async () => {
  // The tenant filter is necessary and not sufficient: a project may hold several LinkedIn accounts,
  // and an acceptance observed on one says nothing about an invitation the other sent. Without the
  // `connection_id` match the wrong account's engagement counter moves, which is the same
  // unearned-budget failure wearing a different hat.
  const a = await account("p-two-accounts");
  const b = await account("p-two-accounts");
  const onA = await invitedCase("p-two-accounts", a.id, "dana-okafor");
  const onB = await invitedCase("p-two-accounts", b.id, "rui-silva");

  const r = await noteAcceptedInvitations(domain(), { id: a.id, project_id: "p-two-accounts" }, {
    connected: ["dana-okafor", "rui-silva"],
  });
  assert.equal(r.accepted, 1);
  assert.equal((await domain().getCase(onA.id))!.stage, "connected");
  assert.equal((await domain().getCase(onB.id))!.stage, "invited");
});

test("nothing observed is not an error, and says how many are still pending", async () => {
  // "Nothing happened" has to be unmysterious, or the next person to look at a quiet pipeline cannot
  // tell a working poller from the broken one this whole subsystem replaced.
  const conn = await account("p-quiet");
  await invitedCase("p-quiet", conn.id, "dana-okafor");

  const none = await noteAcceptedInvitations(domain(), { id: conn.id, project_id: "p-quiet" }, { connected: [] });
  assert.deepEqual(none, { accepted: 0, case_ids: [], pending: 0 });

  const someoneElse = await noteAcceptedInvitations(domain(), { id: conn.id, project_id: "p-quiet" }, {
    connected: ["a-stranger"],
  });
  assert.equal(someoneElse.accepted, 0);
  assert.equal(someoneElse.pending, 1, "the founder cannot tell 'nobody accepted' from 'nothing is running'");
});

test("acceptances feed the pacing multiplier — the safety system stops strangling a healthy account", async () => {
  // THE SECOND HALF OF THE SAME BUG. `engagement.sent` increments on every invitation, and until the
  // acceptance poller existed nothing ever wrote `accepted`. So an account that had sent twenty
  // invitations read as 0% acceptance, dropped to the 0.3 band and kept falling — pacing throttling
  // a perfectly healthy account on evidence it had refused to collect.
  const conn = await account("p-pacing");
  for (let i = 0; i < 25; i++) await recordTouch(domain(), conn.id, "invite");

  const silent = ((await domain().getConnection(conn.id))!.config.pacing as { engagement: Parameters<typeof engagementMultiplier>[0] }).engagement;
  assert.equal(silent.sent, 25);
  assert.equal(silent.accepted, 0);
  assert.equal(engagementMultiplier(silent), 0.3, "this is the throttle an account earned by being unobserved");

  // Now the same observation that moves the cases moves the counter. Ten of the twenty-five landed.
  const cases = await Promise.all(
    Array.from({ length: 10 }, (_, i) => invitedCase("p-pacing", conn.id, `prospect-${i}`)),
  );
  const r = await noteAcceptedInvitations(domain(), { id: conn.id, project_id: "p-pacing" }, {
    connected: cases.map((_, i) => `prospect-${i}`),
  });
  // Derived from the case transitions, NOT from the length of the observed list — that is what makes
  // it a real acceptance rate rather than a count of the founder's friends.
  await recordEngagement(domain(), conn.id, { accepted: r.accepted });

  const earned = ((await domain().getConnection(conn.id))!.config.pacing as { engagement: Parameters<typeof engagementMultiplier>[0] }).engagement;
  assert.equal(earned.accepted, 10);
  assert.equal(engagementMultiplier(earned), 1, "40% acceptance must earn full allowance, not the unobserved-account throttle");
});

test("the connections parser keys on public identifiers and merges what the walk sees twice", async () => {
  // The fetch is unverifiable from CI; the PARSER is the part that breaks on a LinkedIn deploy, so
  // it is pure and tested against a fixture. A node with no public identifier is unkeyable — it can
  // never be matched against a case's `profile_id` — so dropping it is correct, and keeping it would
  // put an entry in the observation that can only ever be a false negative.
  const payload = {
    elements: [
      { navigationUrl: "https://www.linkedin.com/in/dana-okafor?trk=connections", title: { text: "Dana Okafor" } },
      { navigationUrl: "https://www.linkedin.com/in/dana-okafor", title: { text: "Dana Okafor" } },
      { navigationUrl: "https://www.linkedin.com/in/rui-silva", title: { text: "Rui Silva" } },
      { title: { text: "LinkedIn Member" } },
    ],
  };
  assert.deepEqual(connectionIds(payload), ["dana-okafor", "rui-silva"]);
  assert.deepEqual(connectionIds({}), []);
  assert.deepEqual(connectionIds(null), []);
});
