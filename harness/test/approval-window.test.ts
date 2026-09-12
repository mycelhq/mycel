import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { APPROVAL_TTL_MS } from "../src/approvals";

const src = readFileSync(new URL("../src/approvals.ts", import.meta.url), "utf8");

/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * THE WINDOW WAS SHORTER THAN THE HUMAN
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Measured on every approval a person has actually decided in production:
 *
 *     decided within 30 minutes      2 of 26
 *     decided within 24 hours       25 of 26
 *
 * The default was 30 minutes. It caught two decisions in twenty-six, and the only reason the other
 * twenty-four survived to be decided is that the expiry timer is in-process and `unref`ed — a kernel
 * restart loses it and the row quietly outlives its own TTL. "Expires in thirty minutes unless we
 * happen to deploy" was the real behaviour, and nobody chose it.
 *
 * The cost in the fortnight before this changed: 3 of 3 `send_invoice` approvals expired unsent, and
 * 2 of 4 campaigns. Half of the real outbound work the machine drafted, thrown away.
 */

test("the window is at least as long as the humans it is waiting for", () => {
  // 24h catches 25 of 26. Anything under a working day is choosing to throw drafts away, and the
  // failure is silent: an expired approval looks identical to a founder who decided not to send.
  assert.ok(
    APPROVAL_TTL_MS >= 24 * 60 * 60 * 1000,
    `the approval window is ${Math.round(APPROVAL_TTL_MS / 60000)} minutes; measured human latency ` +
      `runs from 44 minutes to three days, and 24 of 26 real decisions arrived after 30 minutes`,
  );
});

test("a suspended run holding a worker slot is instrumented, not assumed away", () => {
  /*
    THE TRADE THIS LENGTH MAKES, and the reason a longer window was genuinely unsafe before.

    A run suspended on an approval still holds its graphile job, so blocked runs compete with real
    work for the same ten slots. That was fatal when the queue carried 50 approvals a day — 197 of
    211 all-time expiries were `composio:search_people`, `get_profile`, `get_company`: READS, on an
    internal task type, put in front of a human. Nobody approves reading a company profile, so they
    all expired, and a 24-hour window would have jammed the fleet inside a day.

    That flood stopped because GTM moved off Composio for LinkedIn, NOT because the gate learned the
    difference between a read and a send. The classification that let `search_people` through as
    `risk: medium` is untouched, so brokering any read through the action proxy again brings it back.
    Until a read on an internal task type stops reaching a human at all, this window's safety rests on
    an integration having been removed — which is not a guarantee, and is exactly what the warning is
    for.
  */
  /*
    THE CALL, not the declaration — and the first version of this assertion could not tell them
    apart. `/warnIfFleetFilling\(\)/` matches `function warnIfFleetFilling(): void` just as happily
    as it matches the call site, so deleting the only invocation left the test green. A guard that
    is satisfied by the existence of the thing it is checking the USE of is not a guard.
  */
  assert.ok(
    /^\s*warnIfFleetFilling\(\);\s*$/m.test(src),
    "nothing CALLS warnIfFleetFilling — the fleet can fill silently",
  );
  assert.match(src, /function warnIfFleetFilling/, "the backpressure warning is gone entirely");
  assert.match(src, /MYCEL_WORKER_CONCURRENCY/, "the warning is not tied to the actual slot count");
  // It must fire ONCE per crossing. A warning on every gate call is a warning nobody reads, and this
  // is the single condition under which the window stops being the right trade.
  assert.match(src, /warnedAtFull/, "the backpressure warning has no once-per-crossing latch");
});

test("an operator can shorten it without a deploy", () => {
  // The failure this length trades for is fleet contention, and that arrives faster than a deploy.
  assert.match(src, /MYCEL_APPROVAL_TTL_MS/, "the window cannot be shortened without shipping code");
});
