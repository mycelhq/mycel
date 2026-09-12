// The summit from STANDARD.md: everything else can be true and the business still needs a hire,
// because nothing reaches a client without a human releasing it. At ten clients that gate IS the
// next hire. This is the machinery for lifting it selectively.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLEAN_RUN_REQUIRED,
  PENALTY_PER_LAPSE,
  barFor,
  cleanRun,
  explain,
  lapses,
  mayAutoRelease,
  record,
  releasePolicyFor,
  toPolicy,
  type Outcome,
  type Record,
} from "../src/release-policy";

const rec = (outcomes: Outcome[] = []): Record => ({ wedge: "books-keeper", client_id: "c1", outcomes });
const ON = { enabled: true };
const ask = (r: Record, over: Partial<Parameters<typeof mayAutoRelease>[0]> = {}) =>
  mayAutoRelease({ record: r, policy: ON, clientReady: true, ...over });

test("OFF BY DEFAULT — auto-release is turned on, never discovered", () => {
  const perfect = rec(Array(20).fill("clean_accept"));
  assert.equal(mayAutoRelease({ record: perfect, clientReady: true }).release, "review");
});

test("the first deliverable for a client is always reviewed", () => {
  const d = ask(rec());
  assert.equal(d.release, "review");
  assert.match(d.reason, /nothing to go on yet/);
});

test("three clean first-pass acceptances lift the gate", () => {
  assert.equal(ask(rec(["clean_accept", "clean_accept"])).release, "review");
  const d = ask(rec(Array(CLEAN_RUN_REQUIRED).fill("clean_accept")));
  assert.equal(d.release, "auto");
  assert.match(d.reason, /accepted first time/);
});

test("an acceptance that needed a revision does NOT count toward the record", () => {
  // It proves the loop works. It does not prove the FIRST attempt was right, and the first attempt
  // is exactly what auto-release ships.
  const r = rec(["accept_after_changes", "clean_accept", "clean_accept", "clean_accept"]);
  assert.equal(cleanRun(r), 0, "the run is broken at the head by the revision");
  assert.equal(ask(r).release, "review");
});

test("the run is CONSECUTIVE — an old clean streak does not carry", () => {
  const r = rec(["changes_requested", "clean_accept", "clean_accept", "clean_accept", "clean_accept"]);
  assert.equal(cleanRun(r), 0);
  assert.equal(ask(r).release, "review");
});

test("AFTER AN AUTO-RELEASE COMES BACK, the bar goes UP, not back to where it was", () => {
  // A mistake made while a human was reviewing is one the system was allowed to make. A mistake
  // made because we skipped the human is one we chose to risk, and the client experiences it as the
  // business getting sloppier over time.
  const burned = rec(["auto_released_then_changes"]);
  assert.equal(lapses(burned), 1);
  assert.equal(barFor(burned, ON), CLEAN_RUN_REQUIRED + PENALTY_PER_LAPSE);

  const threeClean = rec(["clean_accept", "clean_accept", "clean_accept", "auto_released_then_changes"]);
  const d = ask(threeClean);
  assert.equal(d.release, "review", "three is no longer enough for a pairing that has lapsed");
  assert.match(d.reason, /the bar is higher here/);

  const sixClean = rec([...Array(6).fill("clean_accept"), "auto_released_then_changes"] as Outcome[]);
  assert.equal(ask(sixClean).release, "auto");
});

test("twice burned means twice as long again — a repeatedly bad pairing ends up gated for good", () => {
  const twice = rec(["auto_released_then_changes", "auto_released_then_changes"]);
  assert.equal(barFor(twice, ON), CLEAN_RUN_REQUIRED + 2 * PENALTY_PER_LAPSE);
});

test("client-readiness is a HARD precondition, not a factor", () => {
  // A track record is a statement about work that was fit to send. It can never be evidence that
  // unfit work is fine.
  const perfect = rec(Array(50).fill("clean_accept"));
  const d = mayAutoRelease({ record: perfect, policy: ON, clientReady: false });
  assert.equal(d.release, "review");
  assert.match(d.reason, /did not produce work a client can read/);
});

test("a founder marking an engagement for review always wins", () => {
  const perfect = rec(Array(50).fill("clean_accept"));
  assert.equal(ask(perfect, { alwaysReview: true }).release, "review");
});

test("the record distinguishes changes on reviewed work from changes on auto-released work", () => {
  const reviewed = record(rec(), { verdict: "changes_requested", hadRevision: false, wasAutoReleased: false });
  assert.equal(reviewed.outcomes[0], "changes_requested");
  assert.equal(lapses(reviewed), 0, "ordinary service business, no penalty");

  const auto = record(rec(), { verdict: "changes_requested", hadRevision: false, wasAutoReleased: true });
  assert.equal(auto.outcomes[0], "auto_released_then_changes");
  assert.equal(lapses(auto), 1, "this is the system telling us the threshold was wrong");
});

test("recording an acceptance knows whether it took a revision to get there", () => {
  assert.equal(record(rec(), { verdict: "accepted", hadRevision: false, wasAutoReleased: false }).outcomes[0], "clean_accept");
  assert.equal(record(rec(), { verdict: "accepted", hadRevision: true, wasAutoReleased: false }).outcomes[0], "accept_after_changes");
});

test("the record is bounded — a pairing's distant past does not grow forever", () => {
  let r = rec();
  for (let i = 0; i < 80; i++) r = record(r, { verdict: "accepted", hadRevision: false, wasAutoReleased: false });
  assert.equal(r.outcomes.length, 50);
});

test("the record is per wedge AND per client — the pair is the unit", () => {
  // A business doing brilliant bookkeeping for six months tells you nothing about the first website
  // it builds, and a wedge's record elsewhere says nothing about a brand new relationship.
  const r = rec(Array(10).fill("clean_accept"));
  assert.equal(r.wedge, "books-keeper");
  assert.equal(r.client_id, "c1");
  // A different pairing starts empty, and therefore reviewed.
  assert.equal(ask({ wedge: "product-builder", client_id: "c1", outcomes: [] }).release, "review");
  assert.equal(ask({ wedge: "books-keeper", client_id: "c2", outcomes: [] }).release, "review");
});

test("the founder is told what happened, in a sentence", () => {
  const auto = ask(rec(Array(3).fill("clean_accept")));
  assert.match(explain(auto), /^sent automatically —/);
  assert.match(explain(ask(rec())), /^waiting for you —/);
});

// ── The setting, which is what made any of the above reachable ───────────────────────────────────
//
// Everything above tests a mechanism that, until this pass, no founder could switch on:
// `releasePolicyFor` read `MYCEL_AUTO_RELEASE_PROJECTS`, an environment variable, so enabling it for
// one customer needed a deploy and nobody could watch a track record build up first. `STANDARD.md`
// §4 calls this "the thing that decides whether the vision is real"; it had never run for anybody.

test("with nothing set, the gate holds — a store that has never been written reads as off", async () => {
  const p = await releasePolicyFor("proj-untouched", { queryRecords: async () => [] });
  assert.equal(p.enabled, false, "auto-release is something a founder turns on, never discovers");
});

test("the setting turns it on, and carries the bar", async () => {
  const p = await releasePolicyFor("proj-a", {
    queryRecords: async () => [{ data: { enabled: true, clean_run_required: 5 } }],
  });
  assert.equal(p.enabled, true);
  assert.equal(p.cleanRunRequired, 5);
});

test("a store that throws fails CLOSED", async () => {
  // An unreachable database must never be the reason work goes to a client unreviewed. This is the
  // one failure mode where "degrade gracefully" would mean "send it anyway".
  const p = await releasePolicyFor("proj-a", {
    queryRecords: async () => {
      throw new Error("database is down");
    },
  });
  assert.equal(p.enabled, false);
});

test("a nonsense bar is ignored rather than obeyed", () => {
  // `toPolicy` clamps on READ as well as on write, because a row can be written by an older build,
  // by a migration, or by hand. A stored `0` would mean "release everything immediately".
  for (const bad of [0, -3, 21, 1000, "many", null]) {
    const p = toPolicy({ enabled: true, clean_run_required: bad });
    assert.equal(p.enabled, true, String(bad));
    assert.equal(p.cleanRunRequired, undefined, `${bad} should fall back to the default bar`);
  }
  assert.equal(toPolicy({ enabled: true, clean_run_required: 4 }).cleanRunRequired, 4);
});

test("a record with no `enabled` boolean is not a policy", () => {
  // Half-written rows happen. Anything that is not an explicit boolean falls back to the caller's
  // floor rather than being read as truthy.
  assert.equal(toPolicy({}).enabled, false);
  assert.equal(toPolicy({ enabled: "yes" }).enabled, false);
  assert.equal(toPolicy(undefined).enabled, false);
  assert.equal(toPolicy({ clean_run_required: 3 }).enabled, false);
});

test("the operator allowlist is a floor, not a gate", async () => {
  // A self-host that set the env var keeps working. It cannot turn the feature OFF for a project
  // that enabled it, and the project setting is what a founder controls — the person whose
  // reputation is spent is the one who gets to stop it.
  const previous = process.env.MYCEL_AUTO_RELEASE_PROJECTS;
  process.env.MYCEL_AUTO_RELEASE_PROJECTS = "proj-allow";
  try {
    const fromEnv = await releasePolicyFor("proj-allow", { queryRecords: async () => [] });
    assert.equal(fromEnv.enabled, true, "the allowlist still enables");

    const setOff = await releasePolicyFor("proj-allow", {
      queryRecords: async () => [{ data: { enabled: false } }],
    });
    assert.equal(setOff.enabled, false, "and the founder can still stop it");
  } finally {
    if (previous === undefined) delete process.env.MYCEL_AUTO_RELEASE_PROJECTS;
    else process.env.MYCEL_AUTO_RELEASE_PROJECTS = previous;
  }
});
