import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pickOpencodePort } from "../src/runtime";

/**
 * THE BUG THIS FILE EXISTS FOR (2026-08-17, evals/product/ERROR-HUNT-LOG.md):
 *
 *   opencode failed to start — probes saw: 54 × http 401
 *
 * ...AFTER the build had written all its files. A single run now starts opencode MORE THAN ONCE —
 * the schema-retry and the build verify-repair rounds call `runOpenCodeTask` again — and each call
 * mints a FRESH HTTP Basic password. Every call used to bind the SAME fixed port (4444). The earlier
 * `opencode serve` process outlives its aborted session, so on a fixed port it (password A) keeps
 * answering the new client (password B): a persistent 401 until the 60s timeout. A build that failed
 * verify ONCE thus died on the retry instead of repairing or failing with the real verify error.
 *
 * Two wrong fixes came first (readiness instrumentation; a pkill that is ineffective in the Daytona
 * microVM). The fix asserted here: each non-docker start gets its OWN port, so a lingering server can
 * never be on the socket the new client dials. Docker stays pinned (it publishes one inner port at
 * acquire time and its previewUrl ignores the argument) and relies on the there-effective pkill.
 */

test("two sequential non-docker starts do not reuse a colliding port", () => {
  // The invariant that makes the password mismatch impossible by construction: if the second start
  // never lands on the first start's port, no lingering first server can intercept the second client.
  // Random, so prove it holds across many draws rather than on one lucky pair.
  for (const backend of ["daytona", "local"]) {
    const seen = new Set<number>();
    let collisions = 0;
    for (let i = 0; i < 500; i++) {
      const p = pickOpencodePort(backend, 4444);
      if (seen.has(p)) collisions++;
      seen.add(p);
      assert.notEqual(p, 4444, `${backend}: must not reuse the base/fixed port that a stale server holds`);
      assert.ok(p > 4444 && p <= 4444 + 4000, `${backend}: port ${p} out of the ephemeral range`);
    }
    // A run starts opencode at most a handful of times; the odds two of THOSE collide are ~n/4000.
    // Over 500 draws some collisions are expected — assert the spread is wide, not that it is perfect.
    assert.ok(seen.size > 400, `${backend}: only ${seen.size} distinct ports in 500 draws (too clustered)`);
    assert.ok(collisions < 100, `${backend}: ${collisions} collisions in 500 draws is too many`);
  }
});

test("docker stays pinned to the fixed port", () => {
  // DockerSandbox publishes exactly one inner port at acquire time and previewUrl(port) ignores its
  // argument — a random inner port would be unreachable from the host. Docker must not randomise.
  for (let i = 0; i < 50; i++) {
    assert.equal(pickOpencodePort("docker", 4444), 4444);
  }
});

/**
 * A source-level guard for the two halves that the pure helper cannot see:
 *   1. the spawn and the previewUrl must use the SAME port variable (a client dialing a different
 *      port than the server bound is the collision wearing different clothes), and
 *   2. the port must come from `pickOpencodePort`, not a re-inlined `cfg.opencodePort`.
 */
test("spawn and previewUrl share one per-invocation port", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "src", "runtime.ts"), "utf8");
  assert.match(
    src,
    /const ocPort = pickOpencodePort\(/,
    "runtime.ts must derive the port from pickOpencodePort so the collision fix is in force",
  );
  assert.match(
    src,
    /opencode serve --hostname 0\.0\.0\.0 --port \$\{ocPort\}/,
    "the spawned server must bind the per-invocation ocPort",
  );
  assert.match(
    src,
    /sandbox\.previewUrl\(ocPort\)/,
    "the client must dial the SAME ocPort the server bound — otherwise the run 401s itself",
  );
  assert.doesNotMatch(
    src,
    /--port \$\{cfg\.opencodePort\}/,
    "a re-inlined fixed port reintroduces the stale-server 401 for schema-retry / verify-repair runs",
  );
});
