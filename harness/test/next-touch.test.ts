// The outbound cadence workflow — pure, clock-free, and willing to stop.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runWorkflow } from "../src/workflows";

const next = async (args: Record<string, unknown>) => {
  const r = await runWorkflow("gtm-operator", "next_touch", args);
  assert.equal(r.ok, true, r.error);
  return r.data as {
    should_send: boolean;
    mark_closed: boolean;
    next_stage: string;
    touch_number: number;
    next_touch_after_days: number | null;
    reason: string;
  };
};

test("stopping is a first-class outcome: reply, booking and opt-out all end the sequence", async () => {
  // The failure this prevents is the one that gets a domain blocked and a founder's reputation
  // spent: a fourth message to someone who already answered.
  const replied = await next({ stage: "touch_2", has_reply: true, touch_count: 2 });
  assert.equal(replied.should_send, false);
  assert.equal(replied.next_stage, "replied");

  const booked = await next({ stage: "booked", touch_count: 1 });
  assert.equal(booked.should_send, false);

  const out = await next({ stage: "touch_1", opt_out: true, touch_count: 1 });
  assert.equal(out.should_send, false);
  assert.equal(out.mark_closed, true);
  assert.equal(out.next_stage, "closed_lost");
  // Opt-out beats everything, including a stage that would otherwise be due.
  assert.equal((await next({ stage: "prospect", opt_out: true })).should_send, false);
});

test("the cadence advances on elapsed days, which are passed IN — no clock in the workflow", async () => {
  const first = await next({ stage: "prospect" });
  assert.equal(first.should_send, true);
  assert.equal(first.touch_number, 1);
  assert.equal(first.next_touch_after_days, 4);

  // Too soon: it waits, and says how long for, instead of sending.
  const early = await next({ stage: "touch_1", touch_count: 1, days_since_last_touch: 1 });
  assert.equal(early.should_send, false);
  assert.equal(early.next_touch_after_days, 3);

  const due = await next({ stage: "touch_1", touch_count: 1, days_since_last_touch: 5 });
  assert.equal(due.should_send, true);
  assert.equal(due.touch_number, 2);
});

test("three touches and then a clean close — a sequence cannot run forever", async () => {
  const third = await next({ stage: "touch_2", touch_count: 2, days_since_last_touch: 4 });
  assert.equal(third.should_send, true);
  assert.equal(third.touch_number, 3);
  assert.equal(third.next_touch_after_days, null, "there is no fourth touch");

  const closed = await next({ stage: "touch_3", touch_count: 3, days_since_last_touch: 9 });
  assert.equal(closed.should_send, false);
  assert.equal(closed.mark_closed, true);
  assert.equal(closed.next_stage, "closed_lost");
});

test("an unknown stage refuses to send rather than guessing", async () => {
  const weird = await next({ stage: "invented_by_the_model", touch_count: 0 });
  assert.equal(weird.should_send, false);
  assert.match(weird.reason, /no cadence rule/);
  // Undeclared workflows and bad args are refused by the runner, not the function.
  assert.equal((await runWorkflow("gtm-operator", "not_a_workflow", {})).ok, false);
  assert.equal((await runWorkflow("gtm-operator", "next_touch", {})).ok, false, "stage is required");
});
