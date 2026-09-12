// THE PREVIEW THAT "HIT TIME LIMITS", AND THE CLASS BEHIND IT.
//
// The founder's report was not that the preview showed a wrong page — it was that nothing came back
// at all until something upstream gave up. The proxy's `fetch` had no signal, so its `catch` only
// ever fired on a refused or reset connection. A socket that OPENS and then goes quiet throws
// nothing, and the request sat on undici's 300s default while the browser and the ALB's own 300s
// idle timeout waited with it.
//
// That is also the ordinary state of a preview rather than an edge case: a Next dev server compiles
// a route on FIRST REQUEST — the very request this proxy makes — and while it compiles it has
// accepted the socket and sent nothing. The common path was the hanging path.
//
// These are source assertions rather than a live proxy test: the route needs a grant store, a run
// registry and a sandbox, and what actually regressed here is one missing option on one call. A test
// that reconstructs three subsystems to prove a `signal` is present is a test nobody maintains.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url).pathname, "utf8");

test("the preview proxy bounds how long it waits for the dev server", () => {
  const s = src("server.ts");
  const at = s.indexOf('app.all("/v1/preview/:grant/*"');
  assert.ok(at > 0, "the proxy route moved — this test is anchored to it");
  const route = s.slice(at, at + 12_000);
  assert.match(route, /signal:\s*AbortSignal\.timeout\(PREVIEW_UPSTREAM_MS\)/,
    "an unsignalled fetch here is a 300s hang, which is what the founder saw");
});

test("a timeout is reported as still-compiling, not as unreachable", () => {
  const s = src("server.ts");
  const at = s.indexOf('app.all("/v1/preview/:grant/*"');
  const route = s.slice(at, at + 12_000);
  // "unreachable" sends a founder looking for a crash that has not happened. A dev server that
  // accepted the socket and said nothing is compiling.
  assert.match(route, /=== "TimeoutError"[\s\S]{0,80}page\("booting"/);
  assert.match(route, /page\("unreachable"\)/, "a refused connection is still unreachable");
});

test("the deadline is above a cold route compile and far below the gateway's", () => {
  const s = src("server.ts");
  const m = /const PREVIEW_UPSTREAM_MS = ([\d_]+);/.exec(s);
  assert.ok(m, "the constant is named so it can be reasoned about, not inlined");
  const ms = Number(m![1]!.replace(/_/g, ""));
  assert.ok(ms >= 20_000, `${ms}ms would cut off a legitimately cold Next compile`);
  assert.ok(ms <= 120_000, `${ms}ms is long enough that the gateway answers first, which is the bug`);
});

// ── the same shape, on the two paths where it costs more than a preview ─────────────────────────

test("every AgentMail call has a deadline — this is the mail path inside a customer's run", () => {
  const s = src("agentmail.ts");
  assert.match(s, /fetchWithDeadline\(`\$\{cfg\.baseUrl\}\$\{path\}`/,
    "a bare fetch plus an unguarded res.text() is the exact shape that took the engine dark");
  // And no bare fetch survives in the module's request path.
  assert.doesNotMatch(s, /await fetch\(`\$\{cfg\.baseUrl\}/);
});

test("a webhook to a stranger's server cannot hold a run open", () => {
  const s = src("actions.ts");
  const at = s.indexOf("const url = rel ? `${base.replace");
  assert.ok(at > 0, "the webhook executor moved — this test is anchored to it");
  const fn = s.slice(at, at + 1800);
  assert.match(fn, /fetchWithDeadline\(url/);
  assert.doesNotMatch(fn, /await fetch\(url/);
});

test("fetchWithDeadline is no longer dead code", () => {
  // It was written for precisely this class and referenced by nothing outside its own tests — the
  // fix for the outage sitting one import away from the code still making it.
  const users = ["agentmail.ts", "actions.ts"].filter((f) => src(f).includes("fetchWithDeadline"));
  assert.deepEqual(users, ["agentmail.ts", "actions.ts"]);
});

// ── the agent control plane, which is where "the sandbox doesn't work" actually comes from ───────
//
// The founder's report was that the sandbox times out. `waitReady` is the first thing a run does to
// the opencode server, and its probe fetch had no signal: the `while (Date.now() < deadline)` loop
// only checks BETWEEN iterations, so one socket that opened and went quiet consumed the whole 60s
// budget in a single pass and then kept going to undici's 300s default. A `waitReady` asked for a
// minute could cost five, and the run above it just waited.
//
// It also blinded the diagnostic the loop exists for. The tally distinguishes "60 × 502" (the proxy)
// from "60 × ECONNREFUSED" (the process); a hang is neither, so the error said "no probe ever ran"
// and named nothing at all.

test("every call to the in-sandbox opencode server is bounded", () => {
  const s = src("opencode.ts");
  const calls = [...s.matchAll(/await fetch\(`\$\{this\.baseUrl\}[^`]*`/g)];
  assert.ok(calls.length >= 3, `found ${calls.length} control-plane calls — the matcher drifted`);
  for (const m of calls) {
    // Looks BEHIND the call as well as ahead of it: `sendPrompt` builds one `init` object and passes
    // it to two fetches, so its signal is declared above the call site rather than inline. A matcher
    // that only read forwards would report the bounded call as unbounded.
    const region = s.slice(Math.max(0, m.index! - 900), m.index! + 700);
    assert.match(
      region,
      /signal:\s*AbortSignal\.timeout\(/,
      `unbounded call to the opencode server at offset ${m.index}: ${m[0].slice(0, 70)}`,
    );
  }
});

test("a readiness probe cannot spend the whole readiness budget", () => {
  const s = src("opencode.ts");
  const at = s.indexOf("async waitReady(");
  const fn = s.slice(at, at + 3500);
  // Bounded per probe, and by a value far under the loop's own deadline — the point is to get BACK
  // to the loop and probe again, not to wait out the budget in one attempt.
  assert.match(fn, /AbortSignal\.timeout\(Math\.min\(5000/);
});

test("a hang is a tallied observation, not 'no probe ever ran'", () => {
  const s = src("opencode.ts");
  const at = s.indexOf("async waitReady(");
  const fn = s.slice(at, at + 3500);
  assert.match(fn, /TimeoutError/, "a timeout must be told apart from a refused connection");
  assert.match(fn, /socket opened, server silent/,
    "the tally exists to name the failure; a hang has to name itself too");
});
