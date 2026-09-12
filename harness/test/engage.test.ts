// Warm-up engagement (react/follow) — scaffolding, gated OFF by default.
//
// These tests prove the two things that matter for a ban-risk feature: the pure request bodies have
// the shape we think they do, and the kill-switch makes the executors INERT — no network call at
// all — until MYCEL_LINKEDIN_WARMUP is set. No real network is touched: voyagerCall is stubbed and
// injected, and the disabled-path test asserts the stub is never even reached.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  reactionBody,
  followBody,
  reactToPost,
  followPerson,
  REACTION_TYPES,
  WARMUP_ENABLED,
} from "../src/linkedin/engage";
import type { LinkedInSession, VoyagerCtx, VoyagerResponse } from "../src/linkedin/voyager";

const session: LinkedInSession = { li_at: "x", jsessionid: "ajax:1" };
const ctx: VoyagerCtx = { connectionId: "c1", proxyUrl: "http://proxy" };
const POST = "urn:li:activity:7000000000000000000";
const MEMBER = "urn:li:fsd_profile:ABC123";

/** A stub voyagerCall that records whether it ran and returns a canned response. */
function stub(res: Partial<VoyagerResponse>) {
  let calls = 0;
  const calledWith: Array<{ url: string; body: unknown }> = [];
  const fn = (async (url: string, _s: unknown, _c: unknown, _op: string, init?: any) => {
    calls++;
    calledWith.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
    return { ok: true, status: 200, json: {}, text: "", decoded: 0, ...res } as VoyagerResponse;
  }) as unknown as typeof import("../src/linkedin/voyager").voyagerCall;
  return { fn, get calls() { return calls; }, calledWith };
}

test("reactionBody maps the agent word to LinkedIn's reaction enum and carries the post urn", () => {
  assert.deepEqual(reactionBody(POST, "celebrate"), { reactionType: "PRAISE", threadUrn: POST });
  assert.deepEqual(reactionBody(POST, "support"), { reactionType: "EMPATHY", threadUrn: POST });
  // Every declared reaction maps to a non-empty enum value.
  for (const r of Object.keys(REACTION_TYPES) as (keyof typeof REACTION_TYPES)[]) {
    assert.equal(reactionBody(POST, r).reactionType, REACTION_TYPES[r]);
  }
});

test("followBody addresses the member by urn", () => {
  assert.deepEqual(followBody(MEMBER), { followeeUrn: MEMBER, following: true });
});

test("with the flag OFF (default) react/follow refuse and make NO voyagerCall", async () => {
  assert.equal(WARMUP_ENABLED, false, "warm-up must default off — MYCEL_LINKEDIN_WARMUP is not set in tests");
  const s = stub({});
  const r = await reactToPost(session, ctx, POST, "like", s.fn);
  assert.equal(r.ok, false);
  assert.equal(r.code, "warmup_disabled");
  const f = await followPerson(session, ctx, MEMBER, s.fn);
  assert.equal(f.ok, false);
  assert.equal(f.code, "warmup_disabled");
  assert.equal(s.calls, 0, "a disabled warm-up must never reach the network");
});

// The remaining tests exercise the enabled path. WARMUP_ENABLED is read at import time, so we drive
// the executors through a tiny re-import with the env set — kept in a subprocess-free way by testing
// the flag-on behaviour through a fresh module load.
test("with the flag ON, react/follow call through and a 429 is a quota refusal", async () => {
  process.env.MYCEL_LINKEDIN_WARMUP = "1";
  // Fresh import so the module-level WARMUP_ENABLED re-reads the env.
  const mod = await import(`../src/linkedin/engage.ts?on=${Date.now()}`);
  try {
    assert.equal(mod.WARMUP_ENABLED, true);

    const ok = stub({ ok: true, status: 200 });
    const r = await mod.reactToPost(session, ctx, POST, "insightful", ok.fn);
    assert.equal(r.ok, true);
    assert.equal(ok.calls, 1);
    assert.match(ok.calledWith[0].url, /voyagerSocialDashReactions/);
    assert.deepEqual(ok.calledWith[0].body, { reactionType: "INTEREST", threadUrn: POST });

    const okf = stub({ ok: true, status: 200 });
    const f = await mod.followPerson(session, ctx, MEMBER, okf.fn);
    assert.equal(f.ok, true);
    assert.match(okf.calledWith[0].url, /followingStates/);

    const quota = stub({ ok: false, status: 429 });
    const q = await mod.reactToPost(session, ctx, POST, "like", quota.fn);
    assert.equal(q.ok, false);
    assert.equal(q.code, "linkedin_engage_quota");

    // A bad reaction / non-urn refuses before any call.
    const bad = stub({});
    const br = await mod.reactToPost(session, ctx, POST, "thumbsup", bad.fn);
    assert.equal(br.ok, false);
    assert.equal(bad.calls, 0);
    const bf = await mod.followPerson(session, ctx, "not-a-urn", bad.fn);
    assert.equal(bf.ok, false);
    assert.equal(bad.calls, 0);
  } finally {
    delete process.env.MYCEL_LINKEDIN_WARMUP;
  }
});
