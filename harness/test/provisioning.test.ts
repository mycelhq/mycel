// A RUN THAT NEVER STARTED IS A DIFFERENT KIND OF FAILURE.
//
// `queue.ts` enqueues with `maxAttempts: 1` and the reason is right: a task that reached the human
// approval gate and failed afterwards may have already sent an email or moved money. That argument
// is about a run that DID something, and says nothing about one that never got a sandbox.
//
// Production task f8944816 (2026-08-22) died permanently on `Total disk limit exceeded` — twenty-
// eight orphaned sandboxes from interrupted deploys had reached the organisation cap. Nothing about
// that job was wrong.
//
// The taxonomy is Suna's (`session-lifecycle/types.ts`): "`unreachable` exists because everything
// that produced `failed` on this path was in fact a down runtime, and the drain treated it as
// terminal: a queued prompt ... went `dead_lettered` on its FIRST attempt and was never re-tried
// when the box came back minutes later."

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_PROVISION_RETRIES,
  PROVISION_BACKOFF_MS,
  ProvisioningUnavailable,
  provisionBackoffMs,
  provisioningUnavailable,
} from "../src/provisioning";

test("the failure that actually happened is retryable", () => {
  assert.equal(
    provisioningUnavailable(new Error("Total disk limit exceeded. Maximum allowed: 300GiB.")),
    true,
  );
});

test("a provider that is momentarily full, rate-limited or 5xx is worth waiting for", () => {
  for (const m of [
    "Total disk limit exceeded. Maximum allowed: 300GiB.",
    "quota exceeded for organisation",
    "no capacity available in region",
    "429 Too Many Requests",
    "503 Service Unavailable",
    "502 Bad Gateway",
    "connect ETIMEDOUT",
    "socket hang up",
    "temporarily unavailable, try again",
  ]) {
    assert.equal(provisioningUnavailable(new Error(m)), true, m);
  }
});

test("a mistake is not a moment, and a retry of one is the same failure later", () => {
  // The important half. Retrying any of these burns the founder's time to reach an answer that was
  // already true on the first attempt.
  for (const m of [
    "401 unauthorized",
    "403 forbidden",
    "invalid api key",
    "no such image: mycel/sandbox:nope",
    "snapshot mycel-2026 does not exist",
    "invalid configuration",
  ]) {
    assert.equal(provisioningUnavailable(new Error(m)), false, m);
  }
});

test("a mistake wins over a moment when the message contains both", () => {
  // A provider body can say "unauthorized" and mention a quota in the same breath. Checking the
  // permanent patterns FIRST is what stops an auth failure being retried three times.
  assert.equal(provisioningUnavailable(new Error("401 unauthorized: quota exceeded for this key")), false);
});

test("an unrecognised failure is NOT retried", () => {
  // Fails toward the existing behaviour. A failure nobody has classified is exactly the one where
  // "could anything have happened yet" has not been established.
  for (const m of ["", "   ", "something went wrong", "Error"]) {
    assert.equal(provisioningUnavailable(new Error(m)), false, JSON.stringify(m));
  }
  assert.equal(provisioningUnavailable(undefined), false);
  assert.equal(provisioningUnavailable(null), false);
});

test("the wait is bounded, and measured in minutes because capacity frees on a human scale", () => {
  assert.equal(PROVISION_BACKOFF_MS.length, MAX_PROVISION_RETRIES);
  assert.ok(PROVISION_BACKOFF_MS[0]! >= 30_000, "seconds would just re-hit a full provider");
  // Rising, so a provider that is genuinely full is asked less often rather than more.
  for (let i = 1; i < PROVISION_BACKOFF_MS.length; i++) {
    assert.ok(PROVISION_BACKOFF_MS[i]! > PROVISION_BACKOFF_MS[i - 1]!, `step ${i} must grow`);
  }
  const total = PROVISION_BACKOFF_MS.reduce((a, b) => a + b, 0);
  assert.ok(total < 10 * 60_000, "a founder watching a job must be told it failed, not left waiting");
});

test("the backoff is clamped rather than reading off the end", () => {
  assert.equal(provisionBackoffMs(0), PROVISION_BACKOFF_MS[0]);
  assert.equal(provisionBackoffMs(99), PROVISION_BACKOFF_MS[PROVISION_BACKOFF_MS.length - 1]);
});

test("the error carries its attempt, and is a TYPE so a later failure cannot pose as one", () => {
  // A flag on a message could be produced by anything. Only the orchestrator's provisioning branch
  // can construct this, which is what keeps a run that may have SENT something off the retry path.
  const e = new ProvisioningUnavailable("Total disk limit exceeded", 2);
  assert.equal(e.attempt, 2);
  assert.equal(e.name, "ProvisioningUnavailable");
  assert.ok(e instanceof Error);
  assert.equal(new Error("Total disk limit exceeded") instanceof ProvisioningUnavailable, false);
});
