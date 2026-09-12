// Reads must not queue. See READ_ONLY in risk.ts: 195 of 196 production approvals expired, and the
// top three by volume were reads. A queue nobody opens is not a gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { assessRisk } from "../src/risk.ts";

const at = (action: string) => assessRisk({ action, capability: action, payload: {} }).risk;

test("every live LinkedIn read scores low", () => {
  // The canonical READ_LIVE set from packages/linkedin/src/verbs.ts, copied deliberately: the
  // kernel cannot import from a growth package, so this test is the thing that keeps them agreeing.
  for (const verb of ["search_people", "company_people", "get_profile", "get_company"]) {
    assert.equal(at(verb), "low", `${verb} is a read and must not queue`);
  }
});

test("a write is not waved through as a read", () => {
  // `send_message` is deliberately absent: ROUTINE_MESSAGE already scores a reply on a live thread
  // as low, and that predates this list. The names below are the ones the READ_ONLY needles could
  // plausibly have over-matched — an `invite_` that contains "people", a `delete_`.
  for (const verb of ["outreach_touch", "invite_people", "delete_account", "charge_card"]) {
    assert.notEqual(at(verb), "low", `${verb} is not a read and must not be waved through`);
  }
});

test("a first message still comes to a person, read-shaped name or not", () => {
  // The one that matters for outbound: reputation is on the line, so it outranks any verb stem.
  const v = assessRisk({ action: "send_message", capability: "send_message", payload: {}, firstContact: true });
  assert.notEqual(v.risk, "low");
});

test("a read that moves money is still money", () => {
  // The read check sits BELOW the money checks on purpose — "get_refund" looks like a read and is
  // not one. Ordering is the whole guarantee here.
  assert.equal(assessRisk({ action: "get_refund", capability: "get_refund", payload: { amount: 900_00 } }).risk, "high");
});
