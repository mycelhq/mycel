// A RATE LIMIT THAT RESET EVERY TIME WE SHIPPED.
//
// `rateLimited` holds its windows in a process-local `Map`. That is the right trade for shedding
// load and the wrong one for a credential check: with two API replicas a limit of N is really 2N,
// and the budget resets on every deploy — several times on a working day — handing a guesser a fresh
// allowance each time. The difference between a rate limit and the appearance of one.
//
// It is also the exact failure `policy_counters` exists for, in its own header: "this is a SECURITY
// control that failed OPEN. With 2 API replicas and 2 workers each holding their own counter, a
// `max_per_day: 40` envelope permitted roughly 160 auto-approved real-world actions per day."
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const routes = readFileSync(new URL("../src/auth.routes.ts", import.meta.url).pathname, "utf8");
const limiter = readFileSync(new URL("../src/rate-limit.ts", import.meta.url).pathname, "utf8");

test("every auth endpoint is rate limited, including the two that were not", () => {
  // `reset/confirm` returns a live SESSION on a correct token — the highest-value guess in the
  // system — and counted nothing. `hint` answers which provider an address last used, which
  // unmetered is a way to test a list and learn both that an account exists and how it is reached.
  // Split on the route opener rather than trying to brace-match a handler with a regex: the first
  // version demanded `\n});` within 900 characters and silently saw three routes of six, which is
  // the failure mode where a security test passes by not looking.
  const parts = routes.split(/app\.post\("(\/v1\/auth\/[a-z/]+)", async \(c\) => \{/).slice(1);
  const routesFound: [string, string][] = [];
  for (let i = 0; i < parts.length; i += 2) routesFound.push([parts[i]!, parts[i + 1] ?? ""]);
  assert.ok(routesFound.length >= 6, `found ${routesFound.length} auth routes — the matcher drifted`);
  for (const [path, body] of routesFound) {
    // Only the handler's own opening: the next route's text follows in this slice.
    assert.match(body.slice(0, 1200), /limitedDurable\(clientKey/, `${path} has no durable rate limit`);
  }
});

test("the auth surface uses the durable counter, not the in-process one", () => {
  assert.ok(!/\blimited\(clientKey/.test(routes.replace(/limitedDurable\(clientKey/g, "")),
    "an auth route still counts in a process-local Map");
  // And the unused sync import is gone rather than left as a temptation.
  assert.ok(!routes.includes("rateLimited as limited"));
});

test("it fails CLOSED, unlike the margin controls", () => {
  // A counter we cannot read means we cannot tell a first attempt from a thousandth. For a password
  // the safe answer is refuse: a founder retrying in a minute loses a minute, where guessing
  // unmetered loses the account. `images_per_month` makes the opposite call on purpose — one is a
  // margin control and this is a security boundary.
  const fn = limiter.slice(limiter.indexOf("export async function rateLimitedDurable"));
  assert.match(fn, /catch \{\s*return true;/, "a rate limiter that fails open is not one");
});

test("the window is part of the key, so a fixed window needs no sweep", () => {
  const fn = limiter.slice(limiter.indexOf("export async function rateLimitedDurable"));
  assert.match(fn, /Math\.floor\(Date\.now\(\) \/ windowMs\)/);
  assert.match(fn, /`\$\{key\}:\$\{slice\}`/);
  // Two windows of TTL, so the row outlives the slice it counts and cannot expire mid-window.
  assert.match(fn, /\(slice \+ 2\) \* windowMs/);
});

test("the auth namespace cannot collide with a real tenant", () => {
  // The counter store keys on `project_id` because everything else it counts belongs to a project.
  // A login attempt does not have one yet, and inventing a plausible id would put untrusted input
  // in a tenant column.
  const fn = limiter.slice(limiter.indexOf("export async function rateLimitedDurable"));
  assert.match(fn, /"~auth"/);
  // Wrapped prose again — `[\\s*]+` spans the comment continuation.
  assert.match(limiter, /cannot collide with a real[\s*]+project id/);
});

test("the in-process limiter no longer leaks one entry per client for ever", () => {
  // Same leak `policy_counters` names in its own header. A per-IP key on a public endpoint makes it
  // unbounded by design rather than by accident.
  assert.match(limiter, /function sweep\(now: number\)/);
  assert.match(limiter, /if \(now > v\.resetAt\) windows\.delete\(k\)/);
  assert.match(limiter, /sweep\(now\);/);
  // Swept on write: a module every test imports must not arm an interval.
  assert.ok(!/setInterval/.test(limiter), "a timer here would fire in every test process");
});
