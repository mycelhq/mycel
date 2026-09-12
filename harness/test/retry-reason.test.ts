/**
 * A PROVIDER'S ERROR, ON A PAGE ANYBODY CAN OPEN.
 *
 * The strip at the top of every screen on the public demo showed, verbatim:
 *
 *   retrying (attempt 5): Budget has been exceeded! Key=key (sk-...A9bg) Current cost: 0.0,
 *   Max budget: 0.0
 *
 * Two faults in one line. It carries KEY MATERIAL — masked, but `sk-…A9bg` is a fragment of a live
 * credential echoed onto the internet. And it is a proxy's internal accounting language, shown to a
 * service business owner as the last thing their software said.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { retryReason } from "../src/opencode.ts";

test("the live message: no key, and a sentence a founder can read", () => {
  const raw = "Budget has been exceeded! Key=key (sk-...A9bg) Current cost: 0.0, Max budget: 0.0";
  const out = retryReason(raw);
  assert.doesNotMatch(out, /sk-/, `key material survived: ${out}`);
  assert.doesNotMatch(out, /A9bg/);
  assert.equal(out, "this business has reached its model spend limit for the month");
});

test("redaction runs before anything is understood", () => {
  // The rule has to hold for messages nobody has read yet, so it is unconditional rather than part
  // of a known-message branch.
  for (const raw of [
    "upstream refused sk-live_abcdef123456",
    "auth failed for Bearer eyJhbGciOiJIUzI1NiJ9",
    "denied: key=sk_test_9999 on this route",
  ]) {
    const out = retryReason(raw);
    assert.doesNotMatch(out, /sk-live|sk_test|eyJhbG/, `key material survived: ${out}`);
  }
});

test("a rate limit says so", () => {
  assert.match(retryReason("Rate limit reached for gpt-5 (429)"), /rate limiting/);
});

test("an unknown provider error is kept, not swallowed", () => {
  // A provider outage a founder can act on is worth more than a sentence that says only "an error".
  const out = retryReason("upstream connect error or disconnect/reset before headers");
  assert.match(out, /upstream connect error/);
});

test("nothing unbounded reaches the strip", () => {
  const out = retryReason("x".repeat(500));
  assert.ok(out.length <= 161, `retry note ran to ${out.length} chars`);
  assert.ok(out.endsWith("…"));
});

test("empty stays empty rather than becoming noise", () => {
  assert.equal(retryReason(undefined), "");
  assert.equal(retryReason("   "), "");
});

test("the emitter uses it", () => {
  const src = readFileSync(new URL("../src/opencode.ts", import.meta.url), "utf8");
  assert.match(src, /retrying \(attempt \$\{status\.attempt \?\? "\?"\}\): \$\{retryReason\(status\.message\)\}/,
    "the raw provider message is forwarded again");
});
