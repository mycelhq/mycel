// The last message, which this engine documented and could not send.
//
// The cold-email skill describes the breakup, cites the published 10-15% response rate and says "if
// you send one, honor it". Nothing could mark a step as the end, so the copy for it was never
// written and a cadence simply went quiet — the highest-replying message in cold outbound, absent.
//
// The promise it makes ("you will not hear from me again") is the whole reason it gets answered, so
// honouring it is structural rather than a note for whoever composes the campaign.

import test from "node:test";
import assert from "node:assert/strict";

import { validateSteps, type SequenceStep } from "../src/gtm/campaign";
import { draftFirstMessage } from "../src/gtm/draft-message";
import { BREAKUP_BRIEF } from "@mycel/gtm-math";

const step = (over: Partial<SequenceStep>): SequenceStep =>
  ({ from: "connected", action: "send_message", advance_to: "dm1", ...over }) as SequenceStep;

test("breakup: a cadence may end with one, and that is valid", () => {
  validateSteps([
    step({ from: "connected", advance_to: "dm1" }),
    step({ from: "dm1", advance_to: "dm2" }),
    step({ from: "dm2", advance_to: "lost", breakup: true }),
  ]);
});

test("breakup: a message after the breakup is refused, because it makes the promise a lie", () => {
  // Not a weak breakup — a lie, told to the one person paying enough attention to notice.
  assert.throws(
    () =>
      validateSteps([
        step({ from: "connected", advance_to: "dm1", breakup: true }),
        step({ from: "dm1", advance_to: "dm2" }),
      ]),
    /promises nothing follows/,
  );
});

test("breakup: two endings is not a cadence", () => {
  assert.throws(
    () =>
      validateSteps([
        step({ from: "connected", advance_to: "dm1", breakup: true }),
        step({ from: "dm1", advance_to: "lost", breakup: true }),
      ]),
    /at most one breakup/,
  );
});

test("breakup: an ordinary cadence is untouched by the rule", () => {
  validateSteps([step({ from: "connected", advance_to: "dm1" }), step({ from: "dm1", advance_to: "dm2" })]);
});

test("breakup: the composer is told to write an ending, and it is the last instruction", () => {
  // Everything above it in the prompt is written for a message that wants a yes, so the brief has to
  // come last or it loses to the rules it contradicts.
  let seen = "";
  const complete = (async (a: { system?: string }) => {
    seen = a.system ?? "";
    return "Guessing this is not for you. Say no and I will close the file.";
  }) as never;

  return draftFirstMessage({
    orgId: "o1", sells: "bookkeeping", audience: "agencies", breakup: true, complete,
  }).then(() => {
    assert.ok(seen.includes(BREAKUP_BRIEF[0]!), "the brief must reach the model");
    assert.ok(
      seen.indexOf(BREAKUP_BRIEF[0]!) > seen.indexOf("Non-negotiable"),
      "it must come after the opener rules it overrides",
    );
  });
});

test("breakup: an ordinary draft never carries the ending brief", () => {
  let seen = "";
  const complete = (async (a: { system?: string }) => {
    seen = a.system ?? "";
    return "Saw you run finance at an agency. Want me to take the invoice chasing off your desk?";
  }) as never;
  return draftFirstMessage({ orgId: "o1", sells: "bookkeeping", audience: "agencies", complete }).then(() => {
    assert.ok(!seen.includes(BREAKUP_BRIEF[0]!));
  });
});
