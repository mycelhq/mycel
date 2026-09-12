// Seven wedges each declare nudge_client_request, check_in_case and deliverable_verdict, and all
// reach the same human. Every guard in this kernel is vertical; this is the horizontal one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mayTouch, orderPass, DEFAULT_POLICY, type Touch } from "../src/client-touch";

const NOW = 1_800_000_000_000;
const H = 60 * 60 * 1000;
const t = (kind: any, hoursAgo: number, wedge = "w"): Touch => ({ kind, at: NOW - hoursAgo * H, wedge });

test("THE FAILURE THIS EXISTS FOR: three wedges landing on one client in one hour", () => {
  // geo-monitor reports, invoice-chaser chases, books-keeper asks for documents. Each correct,
  // each correctly scheduled, together a company with no manners.
  const recent = [t("report", 0.2, "geo-monitor")];
  const v = mayTouch("chase_invoice", recent, NOW);
  assert.equal(v.allow, false);
  assert.equal(v.allow === false && v.reason, "too_soon");
});

test("A REPLY IS NEVER BUDGETED — deferring one is worse than any nudge", () => {
  // A client who asks a question and gets silence because a nudge used the quota is the single
  // worst outcome this file could produce.
  const full = [t("report", 1), t("invoice_chase", 5)];
  const v = mayTouch("deliverable_verdict", full, NOW);
  assert.equal(v.allow, true);
  assert.equal(v.allow === true && v.reason, "responsive");
});

test("two a day is the ceiling, and the third waits", () => {
  const v = mayTouch("check_in_case", [t("report", 10), t("invoice_chase", 6)], NOW);
  assert.equal(v.allow, false);
  assert.equal(v.allow === false && v.reason, "day_full");
});

test("a refusal ALWAYS carries a retry time", () => {
  // A deferral with no time attached is indistinguishable from a drop, and a dropped client touch
  // is invisible — nobody notices the email that never came.
  const v = mayTouch("check_in_case", [t("report", 10), t("invoice_chase", 6)], NOW);
  assert.equal(v.allow, false);
  if (v.allow === false) {
    assert.ok(v.retryAfter > NOW, "must be in the future");
    assert.ok(v.detail.length > 20, "and must say why in words a founder can read");
  }
});

test("MONEY OUTRANKS A CHECK-IN when both want the same slot", () => {
  // With a flat count the loser is whichever wedge ran second, which is arbitrary.
  const v = mayTouch("check_in_case", [], NOW, { pending: ["invoice_chase"] });
  assert.equal(v.allow, false);
  assert.equal(v.allow === false && v.reason, "outranked");
  // And the reverse is allowed.
  assert.equal(mayTouch("chase_invoice", [], NOW, { pending: ["check_in"] }).allow, true);
});

test("the day window rolls — yesterday does not count against today", () => {
  const old = [t("report", 30), t("invoice_chase", 26)];
  assert.equal(mayTouch("check_in_case", old, NOW).allow, true);
});

test("internal work is not a client touch and is never budgeted", () => {
  // An ops tick, a probe, a build. Budgeting these would stall the machine for no benefit.
  const full = [t("report", 1), t("invoice_chase", 5)];
  for (const internal of ["ops_distribution_tick", "probe_surface", "build_feature"]) {
    assert.equal(mayTouch(internal, full, NOW).allow, true, internal);
  }
});

test("the gap alone stops a burst even when the count is within budget", () => {
  const one = [t("report", 0.5)];
  assert.equal(mayTouch("nudge_client_request", one, NOW).allow, false);
  // Past the gap, the same touch is fine.
  assert.equal(mayTouch("nudge_client_request", [t("report", 5)], NOW).allow, true);
});

test("a pass is ordered by consequence, ties by when the work became ready", () => {
  // Sorting ties by wedge name would silently and permanently favour the alphabetical first.
  const items = [
    { taskType: "check_in_case", readyAt: 1 },
    { taskType: "chase_invoice", readyAt: 5 },
    { taskType: "nudge_client_request", readyAt: 9 },
    { taskType: "chase_receipts", readyAt: 2 },
  ];
  const ordered = orderPass(items).map((i) => i.taskType);
  assert.equal(ordered[0], "chase_invoice", "money first");
  assert.equal(ordered[1], "chase_receipts", "then the older of the two document requests");
  assert.equal(ordered[2], "nudge_client_request");
  assert.equal(ordered[3], "check_in_case", "a check-in is last, always");
});

test("the policy is two a day, four hours apart", () => {
  assert.equal(DEFAULT_POLICY.perDay, 2);
  assert.equal(DEFAULT_POLICY.minGapMs, 4 * H);
});
