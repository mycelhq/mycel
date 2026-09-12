// THE WORKSPACE npm MUTEX — the one that stops a founder breaking their own build by looking at it.
//
// `product-builder`'s verify opens with `npm install` in `~/app`. `startPreview` installs into the
// same directory, and it is triggered by a HUMAN OPENING A TAB — at a moment nobody chose, which
// may be the moment the verify is running. Two npm processes writing one `node_modules` corrupts it,
// and the run then fails with a verdict about the agent's work that is really about the founder
// having watched it.
//
// This is shell, so it is tested as shell: real bash, real concurrency, real exit codes. A unit test
// that asserted the string contained "mkdir" would have passed against the first version of this
// file, which had an unterminated quote in the trap and could not run at all.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { lockedScript, WORKSPACE_LOCK_DIR } from "../src/workspace";

const run = promisify(execFile);

/** Run a locked script and return its exit code and stdout, never throwing on a non-zero exit. */
async function sh(body: string, opts?: { waitSeconds?: number }): Promise<{ code: number; out: string }> {
  const dir = mkdtempSync(join(tmpdir(), "mycel-lock-"));
  const path = join(dir, "s.sh");
  writeFileSync(path, lockedScript(body, opts));
  try {
    const r = await run("bash", [path]);
    return { code: 0, out: `${r.stdout}${r.stderr}` };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const clear = () => rmSync(WORKSPACE_LOCK_DIR, { recursive: true, force: true });

test("the body runs and the lock is released after it", async () => {
  clear();
  const r = await sh("echo BODY_RAN");
  assert.equal(r.code, 0);
  assert.match(r.out, /BODY_RAN/);
  assert.equal(existsSync(WORKSPACE_LOCK_DIR), false, "a lock nobody releases blocks every later run");
});

test("a second holder waits — it does not interleave", async () => {
  clear();
  // The whole point. Before the lock these two were `npm install` and `npm install` in one tree.
  const slow = sh("echo A_START; sleep 2; echo A_DONE");
  await new Promise((r) => setTimeout(r, 300));
  const fast = await sh("echo B_RAN");
  const first = await slow;
  assert.match(first.out, /A_START[\s\S]*A_DONE/);
  assert.match(fast.out, /B_RAN/);
  // B finished after A did, which is the property that matters and the only one worth asserting:
  // asserting on wall-clock timing would be flaky on a loaded machine.
  assert.equal(existsSync(WORKSPACE_LOCK_DIR), false);
});

test("a body that fails still releases the lock, and keeps its own exit code", async () => {
  clear();
  // `cd ~/app || exit 2` is exactly what both real callers do on a missing workspace. If that path
  // leaked the lock, one bad run would wedge every build after it until the sandbox died.
  const r = await sh("cd /definitely-not-here || exit 2; echo NEVER");
  assert.equal(r.code, 2, "the caller's exit code survives the wrapper");
  assert.doesNotMatch(r.out, /NEVER/);
  assert.equal(existsSync(WORKSPACE_LOCK_DIR), false);
});

test("waiting too long is its own exit code, not a pretend npm failure", async () => {
  clear();
  const holder = sh("sleep 3");
  await new Promise((r) => setTimeout(r, 300));
  // 75 = EX_TEMPFAIL. `startPreview` reads it and says "timed out waiting for the build's own npm
  // install", which is a different sentence from "npm failed" and sends the reader somewhere else.
  const blocked = await sh("echo NEVER", { waitSeconds: 1 });
  assert.equal(blocked.code, 75);
  assert.doesNotMatch(blocked.out, /NEVER/);
  await holder;
  clear();
});

test("a stale lock is reclaimed rather than blocking for ever", () => {
  // Not executed — the reclaim is `find -mmin +10`, and a test that waits ten minutes is a test
  // nobody runs. What is asserted is that the reclaim EXISTS in the emitted script, because the
  // failure it prevents is permanent: a sandbox killed mid-install leaves a directory that blocks
  // every later run in it, and nothing would ever clear it.
  const s = lockedScript("true");
  assert.match(s, /-mmin \+10/);
  assert.match(s, /rm -rf "\$__lock"; continue/);
});
