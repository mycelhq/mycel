import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE BUG THIS FILE EXISTS FOR: "opencode failed to start: opencode server listening on
 * http://127.0.0.1:4444".
 *
 * Observed on app.mycelai.dev during a founder walkthrough: a brand-new account described its
 * business, the shaping run sat in "running" for five minutes, and then failed with the sentence
 * above — a failure report that quotes opencode's own SUCCESS banner.
 *
 * opencode HAD started. It had bound loopback only, because `opencode serve --hostname` defaults to
 * "127.0.0.1" on the pinned build (`opencode serve --help` prints `[default: "127.0.0.1"]`). Nothing
 * outside the process's network namespace can reach a loopback socket, so `waitReady` polled an
 * unreachable address for its full 60s on every run:
 *
 *   · DaytonaSandbox — `getPreviewLink` proxies in from OUTSIDE the sandbox.
 *   · DockerSandbox  — `docker run -p 127.0.0.1::4444` publishes the container's interface, not the
 *                      container's loopback.
 *
 * Only the in-process LocalSandbox could ever reach it, which is exactly why 1116 tests stayed green
 * while every real run in production failed. That is the reason this is a source assertion rather
 * than a behavioural one: no fake sandbox can reproduce a bind address, because a fake sandbox is
 * the one environment where the bug does not exist.
 */

const SRC = join(import.meta.dirname, "..", "src");
const runtime = readFileSync(join(SRC, "runtime.ts"), "utf8");

/**
 * The single `opencode serve` command the harness actually spawns.
 *
 * Anchored to `sandbox.spawn(...)` rather than to the string "opencode serve", because runtime.ts
 * discusses the flag in prose as well as passing it, and a regex that matches the COMMENT would go
 * green while the real server stayed on loopback — which is the precise failure mode this file is
 * here to catch.
 */
function serveCommand(): string {
  const m = runtime.match(/sandbox\.spawn\(\s*`([^`]*opencode serve[^`]*)`/);
  assert.ok(m, "runtime.ts no longer spawns `opencode serve` — this test needs rewriting, not deleting");
  return m[1];
}

test("opencode serve binds a reachable address, not loopback", () => {
  const cmd = serveCommand();
  assert.match(
    cmd,
    /--hostname 0\.0\.0\.0/,
    "opencode serve defaults to --hostname 127.0.0.1. Without an explicit 0.0.0.0 the server is " +
      "unreachable through Daytona's preview proxy and through Docker's published port, and every " +
      "task fails after 60s with 'opencode failed to start' quoting the success banner.",
  );
});

test("the bind address is set before the port, on the same invocation", () => {
  // A `--hostname` that ended up on a different command (a second spawn, a shell fragment) would
  // satisfy a naive grep while leaving the real server on loopback.
  const cmd = serveCommand();
  assert.ok(
    cmd.includes("--hostname 0.0.0.0") && cmd.includes("--port"),
    `hostname and port must be flags of the same 'opencode serve': ${cmd}`,
  );
});

test("NO failure path reports a failure by quoting the startup banner", () => {
  /**
   * THE SAME MISTAKE, MADE THREE TIMES, CAUGHT TWICE IN ONE WALKTHROUGH.
   *
   * `/tmp/opencode.log` is only the stdout the harness redirects, and opencode's stdout is its
   * startup banner. Any failure path that reads it reports the failure by quoting a SUCCESS line.
   * Production produced two of these in one session, from two different lines:
   *
   *   opencode failed to start: opencode server listening on http://127.0.0.1:4444
   *   opencode ended before completing: opencode server listening on http://0.0.0.0:4444
   *
   * So this asserts the rule rather than the two known sites: nothing in runtime.ts reads that file
   * directly. `tailAgentLog` is the one way to get an agent log, and it reads the banner too — so
   * this costs no diagnostic power, it only removes the way to get it wrong.
   */
  const reads = runtime.match(/readFile\(\s*"\/tmp\/opencode\.log"/g) ?? [];
  assert.equal(
    reads.length,
    0,
    `runtime.ts reads /tmp/opencode.log directly ${reads.length} time(s). That file is the startup ` +
      `banner, so a failure path using it reports failure by quoting success. Use tailAgentLog.`,
  );
});

test("the startup failure reports opencode's real log, not just the redirected banner", () => {
  /**
   * THE SECOND HALF OF THE SAME PRODUCTION FAILURE. The `waitReady` catch block read
   * `/tmp/opencode.log`, which is only the stdout the harness redirects, and opencode's stdout is
   * the startup banner and nothing else — its diagnostics go to its own log directory.
   *
   * `tailAgentLog` was written for precisely this, with a comment saying so, and was wired only into
   * the LATER session-creation failure. The earlier and far more common startup failure kept reading
   * the wrong file, which is why the founder's error message reported a failure by quoting a success.
   */
  const catchBlock = runtime.slice(
    runtime.indexOf("await oc.waitReady("),
    runtime.indexOf("// 4 + 5."),
  );
  assert.ok(catchBlock.length > 0, "could not locate the waitReady failure path in runtime.ts");
  assert.match(
    catchBlock,
    /tailAgentLog\(sandbox\)/,
    "the startup failure path must use tailAgentLog, which gathers opencode's own log directory",
  );
  assert.doesNotMatch(
    catchBlock,
    /readFile\("\/tmp\/opencode\.log"\)/,
    "/tmp/opencode.log alone is the startup banner — it reports success on the failure path",
  );
});
