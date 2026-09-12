// The gate must stop the things worth stopping and nothing else.
//
// Production, 27 Aug: 196 approvals, 195 expired, one approved — and zero LinkedIn attempts in the
// same window. Those are the same fact. The action proxy called awaitApproval unconditionally, so
// risk decided what the CARD said and never whether one was raised; every sourcing read queued,
// waited out a five-minute TTL and died. A gate that stops everything is a switch that is off.
//
// These tests pin the shape of the fix: low proceeds and is still recorded, everything that can
// cost money or reach a stranger still blocks.

import { test } from "node:test";
import assert from "node:assert/strict";
import { assessRisk } from "../src/risk.ts";

const riskOf = (action: string, payload: Record<string, unknown> = {}, extra = {}) =>
  assessRisk({ action, capability: action, payload, ...extra }).risk;

test("the sourcing verbs that filled the queue now pass without a human", () => {
  // These three were 103 of the 196 cards. All reads.
  for (const verb of ["search_people", "get_profile", "get_company", "company_people"]) {
    assert.equal(riskOf(verb), "low", `${verb} must not need a click`);
  }
});

test("money still stops, whatever it is called", () => {
  for (const action of ["refund", "charge_card", "issue_refund"]) {
    assert.notEqual(riskOf(action, { amount: 50_00 }), "low", `${action} must still block`);
  }
});

test("the first message to a stranger still stops", () => {
  // Reputation, not words. This is the one outbound case worth interrupting someone for, and it is
  // why "unblock outbound" could not just mean "let sends through".
  assert.notEqual(riskOf("send_message", {}, { firstContact: true }), "low");
});

test("destructive verbs still stop", () => {
  for (const action of ["delete_account", "cancel_subscription", "revoke_access"]) {
    assert.notEqual(riskOf(action), "low", `${action} must still block`);
  }
});

test("an unrecognised action still stops — unknown is not safe", () => {
  assert.equal(riskOf("frobnicate_the_widget"), "medium");
});
