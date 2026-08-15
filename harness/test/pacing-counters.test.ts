// The pacing loop, closed.
//
// `assertSendAllowed` read `connection.config.pacing` and nothing in the codebase ever wrote it, so
// every one of these assertions used to fail: the weekly budget never decremented, and
// `engagement.sent` stayed 0 for ever, which used to pin `engagementMultiplier` to a cautious 0.6
// default no matter how well an account is actually performing. These tests exist so that cannot
// silently come back — an open loop here does not look like a bug, it looks like a restricted
// LinkedIn account a week later.
import { test } from "node:test";
import assert from "node:assert/strict";
import { initSecretStore } from "../src/secrets";
import { getDomainStore } from "../src/domain";
import { assertSendAllowed, rollUsed, recordEngagement, recordTouch, WINDOW_MS } from "../src/pacing";
import { connectWithSession, sendLinkedInMessage, _setPacing, _setVerifier } from "../src/linkedin/connect";
import { _setFetch } from "../src/linkedin/proxy";
import { noteInboundReplies } from "../src/gtm/replies";

await initSecretStore();
_setVerifier(async () => ({ self_urn: "urn:li:fs_miniProfile:ME", mailbox_urn: "urn:li:fsd_profile:ME", name: "Founder" }));

const PROXY = "http://user:pw@resi.example:8080";
const domain = () => getDomainStore();

function jsonResponse(body: unknown): Response {
  const text = JSON.stringify(body);
  return {
    ok: true,
    status: 200,
    headers: { get: (h: string) => (h === "content-length" ? String(text.length) : null) },
    text: async () => text,
  } as unknown as Response;
}

async function linkedInAccount(): Promise<string> {
  const r = await connectWithSession({ li_at: "AQEDx", jsessionid: '"ajax:1"', proxyUrl: PROXY, project_id: "p1" });
  return r.connection_id;
}

const pacingOf = async (id: string) =>
  ((await domain().getConnection(id))!.config.pacing ?? {}) as {
    used?: Record<string, number>;
    windows?: Record<string, string>;
    last_at?: Record<string, string>;
    engagement?: Record<string, number>;
  };

test("a successful send spends from the budget — the counter the whole safety check reads", async () => {
  _setFetch(async () => jsonResponse({ value: { eventUrn: "urn:li:fs_event:1" } }));
  _setPacing(async () => ({ allowed: true, remaining: 10, budget: 20, nextAfterMs: 60_000 }));
  try {
    const id = await linkedInAccount();
    assert.equal((await pacingOf(id)).used?.message ?? 0, 0);

    await sendLinkedInMessage((await domain().getConnection(id))!, "urn:li:fs_conversation:2-x==", "hello");
    const after = await pacingOf(id);
    assert.equal(after.used?.message, 1, "the send was invisible to pacing — this is the open-loop bug");
    assert.ok(after.last_at?.message, "and when it happened is recorded, not just that it did");
    // A message is not an invitation, so it must NOT land in the acceptance-rate denominator:
    // dividing a fixed number of acceptances by every message sent makes a healthy account read as
    // one nobody wants to hear from, and the multiplier would collapse for no reason.
    assert.equal(after.engagement?.sent ?? 0, 0);
  } finally {
    _setFetch(null);
    _setPacing(null);
  }
});

test("a send LinkedIn refused costs nothing — allowance is only spent on messages that arrived", async () => {
  _setFetch(async () => ({ ok: false, status: 500, headers: { get: () => null }, text: async () => "" }) as unknown as Response);
  _setPacing(async () => ({ allowed: true, remaining: 10, budget: 20, nextAfterMs: 60_000 }));
  try {
    const id = await linkedInAccount();
    const res = await sendLinkedInMessage((await domain().getConnection(id))!, "urn:li:fs_conversation:2-y==", "hello");
    assert.equal(res.ok, false);
    assert.equal((await pacingOf(id)).used?.message ?? 0, 0, "a failed send must not burn a touch the recipient never got");
  } finally {
    _setFetch(null);
    _setPacing(null);
  }
});

test("concurrent sends cannot lose an increment", async () => {
  // THE RACE THIS IS ABOUT: `updateConnection` is read-modify-write. Two workers read used=7, both
  // write 8, and one real message is now invisible to the check that keeps the account alive. With
  // twenty in flight the drift is enough to walk an account straight through its weekly ceiling
  // while every single check answers "allowed".
  _setFetch(async () => jsonResponse({ value: { eventUrn: "urn:li:fs_event:1" } }));
  _setPacing(async () => ({ allowed: true, remaining: 100, budget: 200, nextAfterMs: 1 }));
  try {
    const id = await linkedInAccount();
    const conn = (await domain().getConnection(id))!;
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => sendLinkedInMessage(conn, `urn:li:fs_conversation:2-${i}==`, "hello")),
    );
    assert.equal((await pacingOf(id)).used?.message, 20, "increments were lost to a read-modify-write race");
  } finally {
    _setFetch(null);
    _setPacing(null);
  }
});

test("concurrent bumps of different kinds keep their own counters and their own windows", async () => {
  const conn = await domain().createConnection({
    project_id: "p1", kind: "linkedin", name: "LI", owner: { kind: "founder", id: "founder" }, config: {},
  });
  await Promise.all([
    ...Array.from({ length: 15 }, () => recordTouch(domain(), conn.id, "invite")),
    ...Array.from({ length: 10 }, () => recordTouch(domain(), conn.id, "message")),
    ...Array.from({ length: 5 }, () => recordEngagement(domain(), conn.id, { accepted: 1 })),
  ]);
  const p = await pacingOf(conn.id);
  assert.equal(p.used?.invite, 15);
  assert.equal(p.used?.message, 10);
  // Invitations ARE the acceptance-rate denominator, so they — and only they — count as `sent`.
  assert.equal(p.engagement?.sent, 15);
  assert.equal(p.engagement?.accepted, 5);
});

test("a counter rolls over rather than blocking an account for ever", async () => {
  const stale = new Date(Date.now() - WINDOW_MS.invite - 60_000).toISOString();
  const conn = await domain().createConnection({
    project_id: "p1", kind: "linkedin", name: "LI", owner: { kind: "founder", id: "founder" },
    config: { pacing: { used: { invite: 80 }, windows: { invite: stale } } },
  });

  // Read side: last week's total is not this week's total. Without this an account that had one
  // busy week would be throttled permanently by arithmetic nobody can see.
  assert.equal(rollUsed({ used: { invite: 80 }, windows: { invite: stale } }).invite, undefined);

  // Write side: the next touch opens a fresh window at 1, rather than accumulating to 81.
  await recordTouch(domain(), conn.id, "invite");
  const p = await pacingOf(conn.id);
  assert.equal(p.used?.invite, 1);
  assert.ok(Date.parse(p.windows!.invite) > Date.parse(stale));
});

test("a used-up allowance is what actually refuses the next send, end to end", async () => {
  // The whole point of writing the counter: `assertSendAllowed` reads it back and says no. Before
  // this, `used` was always `{}` and this verdict was unreachable.
  const conn = await domain().createConnection({
    project_id: "p1", kind: "linkedin", name: "LI", owner: { kind: "founder", id: "founder" },
    config: {
      tier: "free", account_age_days: 365,
      // Shifted so "now" lands inside a Tuesday working hour whatever time the suite runs.
      utc_offset: workingHoursOffset(),
      pacing: {
        used: { invite: 500 },
        windows: { invite: new Date().toISOString() },
        engagement: { sent: 200, accepted: 80, replied: 30, flagged: 0 },
      },
    },
  });
  const verdict = await assertSendAllowed(domain(), conn.id, "invite");
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason!, /allowance for the window is used/);
});

test("a reply is counted once per person, and only from people we actually contacted", async () => {
  const conn = await domain().createConnection({
    project_id: "p1", kind: "linkedin", name: "LI", owner: { kind: "founder", id: "founder" }, config: {},
  });
  const kase = await domain().createCase({
    project_id: "p1", wedge: "gtm-operator", title: "Dana", stage: "dm1", status: "open",
    data: { campaign_id: "c1", connection_id: conn.id, thread: "urn:li:thread:1", profile_id: "dana" },
  });

  const flipped = await noteInboundReplies(domain(), conn, [
    { thread_id: "urn:li:thread:1", from: { id: "dana", name: "Dana" } },
    { thread_id: "urn:li:thread:1", from: { id: "dana", name: "Dana" } }, // chatty, still one reply
    { thread_id: "urn:li:thread:9", from: { id: "a-recruiter" } }, // never contacted — not our signal
  ]);
  assert.equal(flipped, 1);
  assert.equal((await domain().getCase(kase.id))!.stage, "replied");

  // Second sync, same conversation: the case is already terminal, so nothing is counted again.
  // Inflating replies would EARN budget the account did not earn — the one direction to be careful in.
  assert.equal(await noteInboundReplies(domain(), conn, [{ thread_id: "urn:li:thread:1", from: { id: "dana" } }]), 0);
});

/** Hours to add to now so the derived local time is a Tuesday at 10:00 — inside every sending window. */
function workingHoursOffset(now = new Date()): number {
  const target = new Date(now);
  target.setUTCHours(10, 0, 0, 0);
  while (target.getUTCDay() !== 2) target.setUTCDate(target.getUTCDate() + 1);
  return (target.getTime() - now.getTime()) / 3_600_000;
}
