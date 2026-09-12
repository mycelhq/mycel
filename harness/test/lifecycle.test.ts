// A suite of true statements about transitions tells you nothing about whether the path is
// connected. This models the path itself and reports the furthest stage ever reached — the only
// number that would have been honest at any point today.
import { test } from "node:test";
import assert from "node:assert/strict";
import { STAGES, depthOf, headline, observe, report } from "../src/simulation/lifecycle";

const at = (n: number) => new Date(1_800_000_000_000 + n * 60_000).toISOString();

test("an empty world reports zero, not a crash", () => {
  const r = report([]);
  assert.equal(r.furthest, undefined);
  assert.equal(r.neverReached.length, STAGES.length);
  assert.match(headline(r), /^0\/15 stages reached/);
});

test("THE HEADLINE COUNTS WHAT HAPPENED, NOT HOW DEEP IT GOT", () => {
  // Run against production, the depth version printed "14/15" for an engagement that had reached
  // four — one invoice was marked paid, and depth credits everything beneath the high-water mark.
  // This is the flattering-metric failure that grading time-to-value against finishers was.
  const r = report([
    { stage: "client_created", at: 1, evidence: "c" },
    { stage: "invoiced", at: 2, evidence: "i" },
    { stage: "paid", at: 3, evidence: "p" },
  ]);
  assert.match(headline(r), /^3\/15 stages reached/, "three observed is three, not fourteen");
  assert.equal(r.skipped.length, 11, "and the eleven that never happened are named");
});

test("the headline is the fraction — the sentence that was always true today", () => {
  const obs = observe({
    clients: [{ created_at: at(1) }],
    cases: [{ created_at: at(2), data: { kickoff_at: at(3) } }],
    tasks: [{ created_at: at(4), status: "succeeded", task_type: "monthly_close" }],
    deliverables: [{ created_at: at(5), status: "in_review" }],
  });
  const r = report(obs);
  assert.equal(r.furthest, "delivered");
  // FIVE observed — client, case, kickoff, work_ran, delivered. The depth-based version of
  // this printed 9, crediting the four stages in between that never happened.
  assert.match(headline(r), /5\/15 stages reached/);
  assert.match(headline(r), /furthest: delivered/);
});

test("SKIPPED is the signal: delivered without materials_received ever happening", () => {
  // Exactly the state production was in — deliveries happening while the client-materials loop was
  // dead. A current-stage report would have called this healthy.
  const obs = observe({
    clients: [{ created_at: at(1) }],
    cases: [{ created_at: at(2), data: { kickoff_at: at(3) } }],
    tasks: [{ created_at: at(4), status: "succeeded", task_type: "monthly_close" }],
    deliverables: [{ created_at: at(5), status: "in_review" }],
  });
  const r = report(obs);
  assert.ok(r.skipped.includes("materials_received"), "a bypassed stage must be named");
  assert.match(headline(r), /SKIPPED: .*materials_received/);
});

test("a resolved request with NO files does not prove the materials loop", () => {
  // A client can answer a document ask with a sentence. That never exercises the mount path, so it
  // must not count — this is the difference between the loop existing and the loop working.
  const words = observe({ requests: [{ created_at: at(1), status: "resolved", resolved_at: at(2) }] });
  assert.equal(words.length, 0);

  const files = observe({
    requests: [{ created_at: at(1), status: "resolved", resolved_at: at(2), response_artifact_ids: ["a1"] }],
  });
  assert.equal(files[0]?.stage, "materials_received");
  assert.match(files[0]!.evidence, /1 file/);
});

test("THE RETAINER STAGES: revision requested, revised, accepted-on-v2", () => {
  const obs = observe({
    deliverables: [{ created_at: at(1), status: "in_review" }],
    verdicts: [
      { at: at(2), decision: "changes" },
      { at: at(4), decision: "accept", version: 2 },
    ],
    versions: [{ created_at: at(3), version: 2 }],
  });
  const r = report(obs);
  assert.equal(r.furthest, "revision_accepted");
  const stages = obs.map((o) => o.stage);
  assert.ok(stages.includes("revision_requested"));
  assert.ok(stages.includes("revised"));
});

test("accepting v1 is NOT the retainer stage — nobody objected", () => {
  const obs = observe({ verdicts: [{ at: at(2), decision: "accept", version: 1 }] });
  assert.equal(obs.length, 0, "a first-pass acceptance proves nothing about revision");
});

test("live portal vocabulary (`accepted`, `changes_requested`) still counts as the retainer loop", () => {
  const obs = observe({
    verdicts: [
      { at: at(2), decision: "changes_requested" },
      { at: at(4), decision: "accepted", version: 2 },
    ],
    versions: [{ created_at: at(3), version: 2 }],
  });
  assert.ok(obs.some((o) => o.stage === "revision_requested"));
  assert.ok(obs.some((o) => o.stage === "revision_accepted"));
});

test("a stamped case.data.revision_accepted_at is the product loop, not only the simulation", () => {
  const obs = observe({
    cases: [{ created_at: at(1), data: { revision_accepted_at: at(2) } }],
  });
  assert.equal(obs.filter((o) => o.stage === "revision_accepted").length, 1);
});

test("furthest and current are different questions, and both are reported", () => {
  // Delivered last week, now sitting back at an unanswered ask. Reporting only `current` would say
  // the product cannot deliver; reporting only `furthest` would hide that it is stuck.
  const obs = [
    { stage: "delivered" as const, at: 100, evidence: "d" },
    { stage: "case_opened" as const, at: 200, evidence: "c" },
  ];
  const r = report(obs);
  assert.equal(r.furthest, "delivered");
  assert.equal(r.current, "case_opened");
  assert.match(headline(r), /now sitting at: case_opened/);
});

test("a stage that happened twice is dated by its FIRST occurrence", () => {
  const r = report([
    { stage: "delivered", at: 500, evidence: "second" },
    { stage: "delivered", at: 100, evidence: "first" },
  ]);
  assert.equal(r.timeline.find((o) => o.stage === "delivered" && o.evidence === "first")?.at, 100);
});

test("only SUCCEEDED work counts as work_ran", () => {
  const failed = observe({ tasks: [{ created_at: at(1), status: "failed", task_type: "monthly_close" }] });
  assert.equal(failed.length, 0, "a failed run is not a run that happened");
});

test("stage order is stable, because the index IS the depth", () => {
  assert.equal(depthOf("prospect_found"), 0);
  assert.ok(depthOf("materials_received") < depthOf("work_ran"));
  assert.ok(depthOf("delivered") < depthOf("revision_accepted"));
  assert.ok(depthOf("revision_accepted") < depthOf("paid"));
});

test("every observation carries evidence, so a report can never claim a stage without saying why", () => {
  const obs = observe({
    clients: [{ created_at: at(1) }],
    invoices: [{ created_at: at(2), status: "sent", paid_at: at(3) }],
  });
  assert.ok(obs.length > 0);
  for (const o of obs) assert.ok(o.evidence.trim().length > 0, `${o.stage} has no evidence`);
});
