import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LINKEDIN_ACTIONS,
  LINKEDIN_TRIGGERS,
  describeForAgent,
  riskFor,
  touchFor,
} from "../src/linkedin/capabilities";

test("capabilities: an unknown action is high risk and expensive, not free", () => {
  // The default has to be the safe one. A capability someone adds tomorrow without updating this
  // table should arrive at the approval gate rather than slip past it, and should spend from the
  // scarcest budget rather than none.
  assert.equal(riskFor("something_nobody_declared"), "high");
  assert.equal(touchFor("something_nobody_declared"), "invite");
});

test("capabilities: risk tracks reach, so the gate stops training people to click approve", () => {
  // Every action used to be hardcoded `risk: "high"`. A gate that treats reading a profile and
  // messaging a stranger identically teaches people to approve without reading, which makes the
  // gate worthless — and the gate is the product.
  assert.equal(riskFor("get_profile"), "low");
  assert.equal(riskFor("search_people"), "low");
  assert.equal(riskFor("send_invite"), "high");
  assert.equal(riskFor("send_message"), "high");
  assert.equal(riskFor("create_post"), "high", "public and permanent under the founder's name");
  assert.equal(riskFor("comment_on_post"), "high", "same — public, permanent, attributed");

  // Reads never spend budget; the scarce ones always do.
  for (const c of LINKEDIN_ACTIONS.filter((c) => c.kind === "read")) {
    assert.equal(c.touch, null, `${c.id} is a read and must cost nothing`);
    assert.notEqual(c.risk, "high", `${c.id} changes nothing, so it should not gate like a send`);
  }
  assert.equal(touchFor("send_invite"), "invite");
  assert.equal(touchFor("send_inmail"), "inmail");
});

test("capabilities: the surface is broad enough for an agent to have real choices", () => {
  const ids = new Set(LINKEDIN_ACTIONS.map((c) => c.id));
  // If the agent cannot endorse, comment or withdraw, it will do the one thing it can — send
  // invitations — which is exactly the behaviour that gets accounts restricted.
  for (const needed of [
    "search_people", "get_profile", "view_profile", "follow_person",
    "react_to_post", "comment_on_post", "endorse_skill",
    "send_invite", "withdraw_invite", "accept_invite",
    "send_message", "send_inmail", "reply_to_comment", "create_post",
  ]) {
    assert.ok(ids.has(needed), `missing capability: ${needed}`);
  }

  const triggers = new Set(LINKEDIN_TRIGGERS.map((t) => t.id));
  for (const needed of [
    "message_received", "invite_accepted", "invite_received",
    "profile_viewed", "post_commented", "post_reacted", "mentioned", "job_change",
  ]) {
    assert.ok(triggers.has(needed), `missing trigger: ${needed}`);
  }
});

test("capabilities: every entry tells the agent what it is FOR, not just what it is called", () => {
  // A bare list of verb names produces an agent that picks the wrong one. The description is the
  // mechanism, so an entry without one is a bug rather than a style issue.
  for (const c of LINKEDIN_ACTIONS) {
    assert.ok(c.what.length > 25, `${c.id}: description too thin to choose on`);
    assert.ok(Object.keys(c.args).length > 0, `${c.id}: no arguments described`);
    if (c.risk === "high") {
      assert.ok(c.caution, `${c.id} is high risk and must say why`);
    }
  }
  for (const t of LINKEDIN_TRIGGERS) {
    assert.ok(t.why.length > 25, `${t.id}: says what happened but not why it matters`);
  }
});

test("capabilities: the prompt rendering carries cost and caution, not just names", () => {
  const md = describeForAgent();
  // The agent needs to know what an action SPENDS, or it will burn a week of invitations on day one.
  assert.match(md, /spends invite/);
  assert.match(md, /free/);
  assert.match(md, /endorse_skill/);
  assert.match(md, /job_change/);
  assert.match(md, /careful:/);
  // And that a human sees the outbound ones.
  assert.match(md, /approval gate/);
});
