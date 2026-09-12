// The LinkedIn circuit breaker — the tests that stand in for an incident.
//
// On 2026-08-18 production logged 35,456 copies of `linkedin action failed: voyager profile 410`,
// 308 of them every five minutes for ten hours, from one worker, against one dead endpoint. Every
// test in this file describes one of the four things that were missing that day: knowing a failure
// is permanent, refusing the next call because of it, backing off when it is only transient, and
// telling a human ONCE instead of 35,456 times.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BACKOFF_BASE_MS,
  ENDPOINT_GONE_CODE,
  LinkedInGoneError,
  LinkedInUnavailableError,
  SESSION_DEAD_CODE,
  actionableLine,
  classifyVoyagerFailure,
  linkedinBackoffMs,
  linkedinBlocked,
  noteLinkedInFailure,
  noteLinkedInSuccess,
  _resetLinkedInHealth,
  _setHealthClock,
} from "../src/linkedin/health";
import { LinkedInChallengeError, voyagerCall } from "../src/linkedin/voyager";
import { _setFetch } from "../src/linkedin/proxy";
import { InMemoryStore } from "../src/store";
import { getDomainStore } from "../src/domain";
import { randomUUID } from "node:crypto";
import type { Case, Connection, Task } from "../src/contract";
import {
  enrollProspect,
  proposeCampaign,
  type Campaign,
  type SequenceStep,
} from "../src/gtm/campaign";
import { advanceSequences, _setDispatcher } from "../src/gtm/sequence";

// ── the classifier ───────────────────────────────────────────────────────────────────────────────

test("classifier: 410 is permanent and NAMED — the exact failure that ran 3,700 times an hour", () => {
  // The verbatim production message. `profile.ts` throws `voyager profile ${status}` and nothing
  // upstream had any way to tell that apart from a prospect who happened not to load.
  const f = classifyVoyagerFailure(new Error("voyager profile 410"));
  assert.equal(f.kind, "gone");
  assert.equal(f.permanent, true);
  assert.equal(f.code, ENDPOINT_GONE_CODE);
  // A code is what makes `gtm/sequence.ts` wait a DAY instead of coming back in sixty minutes.
  assert.ok(f.code, "a permanent failure must carry a code or the sequencer retries it hourly");

  const typed = classifyVoyagerFailure(new LinkedInGoneError("profile", 410, "c1"));
  assert.equal(typed.kind, "gone");
  assert.equal(typed.permanent, true);
  // The remedy is ours, not the founder's — telling them to reconnect would send them nowhere.
  assert.match(actionableLine(typed, "acme-li"), /endpoint retired for acme-li/);
  assert.doesNotMatch(actionableLine(typed, "acme-li"), /reconnect required/);
});

test("classifier: a dead session is permanent and says reconnect; a blip is not", () => {
  for (const status of [401, 403, 999]) {
    const f = classifyVoyagerFailure(new Error(`voyager search ${status}`));
    assert.equal(f.permanent, true, `${status} is a dead session`);
    assert.equal(f.kind, "session");
    assert.equal(f.code, SESSION_DEAD_CODE);
  }
  const challenge = classifyVoyagerFailure(new LinkedInChallengeError(401, "c1"));
  assert.equal(challenge.kind, "session");
  assert.equal(challenge.permanent, true);
  assert.equal(actionableLine(challenge, "dana@acme.co"), "linkedin session expired for dana@acme.co; reconnect required");

  // The other half of the judgement, and the half that must not regress: rate limits and outages
  // are LinkedIn asking us to slow down, not the account being over.
  assert.equal(classifyVoyagerFailure(new Error("voyager search 429")).permanent, false);
  assert.equal(classifyVoyagerFailure(new Error("voyager search 429")).kind, "rate_limit");
  assert.equal(classifyVoyagerFailure(new Error("voyager profile 503")).kind, "server");
  assert.equal(classifyVoyagerFailure(new Error("voyager profile 503")).permanent, false);
  assert.equal(classifyVoyagerFailure(new Error("LinkedIn search timed out after 45s via proxy")).kind, "network");
  assert.equal(classifyVoyagerFailure(new Error("something odd")).permanent, false);
});

// ── the breaker ──────────────────────────────────────────────────────────────────────────────────

test("breaker: one permanent failure stops the connection, and the second call never leaves", async () => {
  _resetLinkedInHealth();
  let calls = 0;
  _setFetch(async () => {
    calls++;
    return {
      ok: false,
      status: 410,
      headers: { get: () => null },
      text: async () => "",
    } as unknown as Response;
  });
  try {
    const ctx = { connectionId: "conn-gone", proxyUrl: "http://u:p@proxy.example:8000" };
    const session = { li_at: "x", jsessionid: '"ajax:1"' };

    await assert.rejects(
      () => voyagerCall("https://www.linkedin.com/voyager/api/identity/profiles/dana/profileView", session, ctx, "profile"),
      (e: Error) => e.name === "LinkedInGoneError",
    );
    assert.equal(calls, 1);

    // THE FIX, in one assertion. Before this, the next 35,455 attempts each made this request.
    await assert.rejects(
      () => voyagerCall("https://www.linkedin.com/voyager/api/identity/profiles/erin/profileView", session, ctx, "profile"),
      (e: Error) => e instanceof LinkedInUnavailableError && e.code === ENDPOINT_GONE_CODE,
    );
    assert.equal(calls, 1, "the breaker refused before a byte went out");

    // A different connection is untouched — one dead account must not stop the fleet.
    assert.equal(linkedinBlocked("conn-other"), null);
  } finally {
    _setFetch(null);
    _resetLinkedInHealth();
  }
});

test("breaker: only a SUCCESS reopens it — which is what a reconnect produces", () => {
  _resetLinkedInHealth();
  noteLinkedInFailure("c1", new LinkedInChallengeError(999, "c1"));
  assert.equal(linkedinBlocked("c1")?.code, SESSION_DEAD_CODE);
  noteLinkedInSuccess("c1");
  assert.equal(linkedinBlocked("c1"), null);
  _resetLinkedInHealth();
});

test("breaker: the actionable line is printed ONCE, not once per failure", () => {
  _resetLinkedInHealth();
  const first = noteLinkedInFailure("c1", new Error("voyager profile 410"));
  assert.equal(first.announce, true);
  for (let i = 0; i < 500; i++) {
    assert.equal(noteLinkedInFailure("c1", new Error("voyager profile 410")).announce, false);
  }
  _resetLinkedInHealth();
});

// ── backoff ──────────────────────────────────────────────────────────────────────────────────────

test("backoff: transient failures double, cap, and clear on success", () => {
  _resetLinkedInHealth();
  let clock = 1_000_000;
  _setHealthClock(() => clock);
  try {
    // The first 429 is a blip: retried immediately, because a single rate limit is normal traffic.
    assert.equal(noteLinkedInFailure("c2", new Error("voyager search 429")).backoffMs, 0);
    assert.equal(linkedinBlocked("c2"), null);

    // The second is a pattern.
    const b1 = noteLinkedInFailure("c2", new Error("voyager search 429"));
    assert.equal(b1.backoffMs, BACKOFF_BASE_MS);
    assert.equal(b1.announce, true, "the founder hears that we started backing off, exactly once");
    assert.equal(linkedinBlocked("c2")?.code, "linkedin_backoff");
    assert.equal(linkedinBackoffMs("c2"), BACKOFF_BASE_MS);

    // …and it doubles, silently.
    const b2 = noteLinkedInFailure("c2", new Error("voyager search 503"));
    assert.equal(b2.backoffMs, BACKOFF_BASE_MS * 2);
    assert.equal(b2.announce, false);
    assert.equal(noteLinkedInFailure("c2", new Error("voyager search 503")).backoffMs, BACKOFF_BASE_MS * 4);

    // The clock running out reopens the door — a backoff is a wait, not a stop.
    clock += BACKOFF_BASE_MS * 4 + 1;
    assert.equal(linkedinBlocked("c2"), null);

    // And a success wipes the ladder, so the next blip starts at the bottom again.
    noteLinkedInSuccess("c2");
    assert.equal(noteLinkedInFailure("c2", new Error("voyager search 429")).backoffMs, 0);
  } finally {
    _setHealthClock(null);
    _resetLinkedInHealth();
  }
});

test("backoff: it is capped, so a long outage never parks an account for hours", () => {
  _resetLinkedInHealth();
  let last = 0;
  for (let i = 0; i < 40; i++) last = noteLinkedInFailure("c3", new Error("voyager search 503")).backoffMs;
  assert.equal(last, 30 * 60_000);
  _resetLinkedInHealth();
});

// ── the sequencer skip ───────────────────────────────────────────────────────────────────────────

const domain = () => getDomainStore();

function workingHoursOffset(now = new Date()): number {
  const target = new Date(now);
  target.setUTCHours(10, 0, 0, 0);
  while (target.getUTCDay() !== 2) target.setUTCDate(target.getUTCDate() + 1);
  return (target.getTime() - now.getTime()) / 3_600_000;
}

async function account(project: string): Promise<Connection> {
  return domain().createConnection({
    project_id: project,
    kind: "linkedin",
    name: "LI",
    owner: { kind: "founder", id: "founder" },
    config: {
      tier: "premium",
      account_age_days: 365,
      utc_offset: workingHoursOffset(),
      pacing: { engagement: { sent: 200, accepted: 80, replied: 30, flagged: 0 } },
    },
  });
}

const DM_FIRST: SequenceStep[] = [
  { from: "connected", action: "send_message", advance_to: "dm1", only_if: "connected AND !replied" },
];

async function campaignFor(store: InMemoryStore, project: string, conn: Connection): Promise<Campaign> {
  const iso = new Date().toISOString();
  const task: Task = {
    id: randomUUID(), project_id: project, wedge: "gtm-operator", task_type: "propose_campaign",
    actor: { kind: "user", id: "m" }, input: {},
    constraints: { max_runtime_s: 60, max_cost_usd: 0, approval_required: true },
    tools: [], status: "awaiting_approval", cost_usd: 0, created_at: iso, updated_at: iso,
  };
  await store.createTask(task);
  const r = await proposeCampaign(store, domain(), {
    task_id: task.id,
    project_id: project,
    connection_id: conn.id,
    name: "storm",
    steps: DM_FIRST,
    prospects: [{ profile_id: "dana", name: "Dana", thread: "urn:li:thread:1", copy: { send_message: "hi" } }],
  });
  await store.setApproval(r.approval_id, "approved");
  return r.campaign;
}

async function enrol(campaign: Campaign, profileId: string): Promise<Case> {
  const kase = await enrollProspect(domain(), campaign, {
    profile_id: profileId, name: profileId, thread: `urn:li:thread:${profileId}`,
    copy: { send_message: `hi ${profileId}` },
  });
  return (await domain().updateCase(kase.id, {
    stage: "connected",
    data: { ...kase.data, connected: true },
  }))!;
}

test("a stopped LinkedIn account costs the tick ONE dispatch, not twenty-five", async () => {
  const store = new InMemoryStore();
  const conn = await account("p-storm");
  const campaign = await campaignFor(store, "p-storm", conn);
  for (const id of ["dana", "erin", "fay", "gil", "hana"]) await enrol(campaign, id);

  let dispatches = 0;
  _setDispatcher(async () => {
    dispatches++;
    // Exactly what `asResult` now returns for a 410: a NAMED permanent failure.
    return {
      ok: false,
      code: ENDPOINT_GONE_CODE,
      detail: "LinkedIn no longer serves the profile endpoint (410) — this needs a fix on our side",
    };
  });
  try {
    const summary = await advanceSequences(store, domain(), { project_id: "p-storm" });
    assert.equal(dispatches, 1, "308 identical failed Voyager calls per tick is the bug this stops");
    assert.equal(summary.parked, 1);
    assert.match(summary.note ?? "", /stopped this tick/);

    // The rest keep their due_at: the backlog drains in order the moment the account is fixed.
    const open = await domain().listCases({ project_id: "p-storm", wedge: "gtm-operator", status: "open" });
    assert.equal(open.length, 5);
  } finally {
    _setDispatcher(null);
  }
});

test("an ordinary per-prospect failure does NOT stop the tick", async () => {
  const store = new InMemoryStore();
  const conn = await account("p-normal");
  const campaign = await campaignFor(store, "p-normal", conn);
  for (const id of ["dana", "erin", "fay"]) await enrol(campaign, id);

  let dispatches = 0;
  _setDispatcher(async () => {
    dispatches++;
    return { ok: false, detail: "that profile is not visible to this account" };
  });
  try {
    await advanceSequences(store, domain(), { project_id: "p-normal" });
    // One prospect being invisible says nothing about the next one — the loop must keep going, or
    // the breaker becomes a second, quieter outage.
    assert.equal(dispatches, 3);
  } finally {
    _setDispatcher(null);
  }
});
