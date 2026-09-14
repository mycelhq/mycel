// THE PORT SPLIT THAT NEVER SEPARATED ANYTHING, AND THE THREE MINUTES SPENT WATCHING A CORPSE.
//
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
//
// The founder, on the site studio: *"this is taking too long, fix it, render isn't working."* Both
// halves of that are one bug. From the failed boot as it was stored in production:
//
//     ✓ Ready in 472ms
//     ⚠ We detected multiple lockfiles ...
//     ⨯ Another next dev server is already running.
//     - Local: http://localhost:3000   - PID: 10398   - Dir: /root/app
//     Run kill 10398 to stop it.
//
// And the timings around it, from `public.events`:
//
//     06:50:21 installing → 06:50:37 booting → 06:50:51 LIVE        (30 seconds, worked)
//     07:02:23 installing → 07:02:24 booting → 07:05:27 could not boot
//     07:10:55 installing → 07:10:56 booting → 07:13:56 could not boot
//
// Two things are visible there. The boot works when the workspace is clean, so nothing is slow. And
// the two failures each cost exactly three minutes for a process that had already exited at second
// one — Next printed its refusal and quit, and the loop polled the dead port 72 more times.
//
// ── WHY THE EXISTING DEFENCE DID NOT FIRE ──
//
// `sandbox.ts` picks 4321 "DELIBERATELY NOT 3000 — the verify step boots its own throwaway
// `next dev` on 3000". That is a defence against a port collision. The collision is not on the port:
// Next 16 locks the DIRECTORY, and both servers run in ~/app. The guard was aimed one inch to the
// left of the problem and reported success for as long as Next had no such lock.
//
// The squatter is verify's own. `verify-build.sh` ended with `kill $(cat /tmp/dev.pid)`, and that
// pid is npm's WRAPPER — npm takes the signal, `next-server` is orphaned, and it holds the lock for
// the rest of the sandbox's life.
//
// Source assertions, for the reason `preview-timeout.test.ts` gives next door: what regressed is a
// handful of lines inside a background IIFE that needs a sandbox, a run registry and a real npm
// install to reach. A test that rebuilds three subsystems to prove a `kill` is present is a test
// nobody maintains. The shell fragments below ARE executed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inMonorepo, ONLY_IN_MONOREPO } from "./_monorepo";

/**
 * COMMENTS OUT, and the first run of this file is why. Two of these tests forbid a blanket
 * `pkill next` — and both failed against correct code, because the comment ARGUING that a blanket
 * pkill would kill the founder's preview contains the words "pkill next". A guard that fires on its
 * own rationale gets deleted by the next person in a hurry, which costs more than the check is worth.
 */
const strip = (s: string) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/^\s*(\/\/|#).*$/gm, "");

const runtime = strip(readFileSync(new URL("../src/runtime.ts", import.meta.url).pathname, "utf8"));
/*
  LAZY, for the reason in `an-invoice-knows-what-it-bills.test.ts`: `business-template/` is a sibling
  the published kernel does not ship, and a module-level read throws before node:test can honour a
  test's `skip`. The failure reports as `# skipped 0`, which is how to tell the two apart.
*/
const verifyPath = new URL("../../../business-template/scripts/verify-build.sh", import.meta.url).pathname;
const verifyRaw = () => readFileSync(verifyPath, "utf8");
const verify = () => strip(verifyRaw());

/** The boot, from the rung that announces it to the throw that ends it. */
function bootBlock(): string {
  const at = runtime.indexOf('say("preview: dev server booting")');
  assert.ok(at > 0, "the boot rung moved — this test is anchored to it");
  const end = runtime.indexOf("dev server did not answer within 3 minutes", at);
  assert.ok(end > at, "the timeout throw moved");
  return runtime.slice(at, end);
}

test("A DEAD BOOT IS NOT WAITED OUT", { skip: inMonorepo() ? false : ONLY_IN_MONOREPO }, () => {
  const block = bootBlock();
  /*
    The general fix, and the one that matters most: this catches a boot killed by a missing
    dependency, a broken next.config or an OOM just as well as the dev lock. `spawn` returns void
    and hands back no process handle, so the shell records its own exit.
  */
  assert.match(block, /rm -f \/tmp\/preview\.exit/, "a stale exit file makes the next boot look dead on arrival");
  assert.match(block, /npm run dev[^`]*echo \$\? > \/tmp\/preview\.exit/, "the boot leaves no death certificate");
  assert.match(block, /gone=\$\(cat \/tmp\/preview\.exit/, "the poll cannot tell a slow boot from a dead one");
  assert.match(block, /throw new Error\("the dev server exited instead of starting"\)/);
  // And it costs nothing: the corpse is checked in the SAME exec as the port, not a second round trip.
  const probes = block.match(/sandbox\s*\n?\s*\.exec\(|sandbox\.exec\(/g) ?? [];
  assert.ok(probes.length <= 3, `the poll loop grew extra round trips (${probes.length} execs in the block)`);
});

test("the port is read BEFORE the corpse", { skip: inMonorepo() ? false : ONLY_IN_MONOREPO }, () => {
  const block = bootBlock();
  /**
   * A dev server that answers and then exits between the two halves of one line is still a server
   * worth showing. Reversing these two checks turns a race into a false negative wearing a new
   * costume — the same class of bug this whole file is about.
   */
  const port = block.indexOf("up = true");
  const corpse = block.indexOf("died = true");
  assert.ok(port > 0 && corpse > 0, "both arms of the poll are gone");
  assert.ok(port < corpse, "the corpse is checked before the port, so a live server can be called dead");
});

test("THE STALE DEV SERVER IS CLEARED BY PORT NUMBER, NEVER BY NAME", { skip: inMonorepo() ? false : ONLY_IN_MONOREPO }, () => {
  const block = bootBlock();
  assert.match(block, /3000/, "nothing clears the lock verify leaves behind");
  assert.match(block, /rm -rf ~\/\$\{ws\.dir\}\/\.next\/dev/, "the lock FILE outlives its process and Next trusts it");
  /*
    The dangerous shortcut. `pkill next` would clear the squatter — and would also kill a live
    preview the founder is watching, every single time the agent verified its own work. 3000 is
    verify's by construction and can never be PREVIEW_PORT.
  */
  assert.ok(
    !/pkill\s+(-f\s+)?['"]?next/.test(block),
    "a blanket pkill here kills the founder's own preview",
  );
});

test("verify kills its process TREE, not npm's wrapper", { skip: inMonorepo() ? false : ONLY_IN_MONOREPO }, () => {
  assert.ok(
    !/kill \$\(cat \/tmp\/dev\.pid\) 2>\/dev\/null;/.test(verify()),
    "the teardown still signals npm and orphans next-server",
  );
  assert.match(verify(), /pkill -P "\$d"/, "npm's children survive the teardown");
  assert.match(verify(), /fuser -k 3000\/tcp|lsof -ti tcp:3000/, "nothing reclaims the port itself");
  // Same rule as above, on the other side of the fence.
  assert.ok(!/pkill\s+(-f\s+)?['"]?next/.test(verify()), "verify would kill the founder's preview");
});

test("the comment that said the port split was enough no longer says so", { skip: inMonorepo() ? false : ONLY_IN_MONOREPO }, () => {
  const sandbox = readFileSync(new URL("../src/sandbox.ts", import.meta.url).pathname, "utf8");
  /**
   * This is the whole reason the bug lived: the code was fine, and a confident comment two files
   * away said the case was handled. Leaving it in place is how the next person re-derives it.
   */
  // Flattened, because the sentence wraps across two comment lines and a `*` gutter.
  const flat = sandbox.replace(/\s*\n\s*\*?\s*/g, " ");
  assert.match(flat, /locks the dev server to its DIRECTORY, not its port/i);
});

// ── the shell actually runs ────────────────────────────────────────────────────────────────────────

test("the teardown survives a dev server that never started", { skip: inMonorepo() ? false : ONLY_IN_MONOREPO }, () => {
  /**
   * `npm install && npx tsc --noEmit && (npm run dev ...)` — when tsc fails, no dev server is
   * started and `/tmp/dev.pid` holds whatever the LAST run left there. The teardown still executes.
   * An unquoted or unguarded pid there is a kill aimed at an unrelated process, or a syntax error
   * that skips the rest of the chain.
   */
  const dir = mkdtempSync(join(tmpdir(), "verify-teardown-"));
  try {
    const teardown = /(d=\$\(cat [^\n]*?rm -f \/tmp\/dev\.pid;)/.exec(verifyRaw())?.[1];
    assert.ok(teardown, "the teardown fragment is no longer recognisable in the script");
    // Retarget /tmp so a test cannot touch a real pid file, and neuter the killers.
    const script = teardown!
      .replace(/\/tmp\/dev\.pid/g, join(dir, "dev.pid"))
      .replace(/\bfuser\b/g, "true")
      .replace(/\blsof\b/g, "true")
      .replace(/\bpkill\b/g, "true")
      .replace(/\bkill\b/g, "true");
    for (const [name, contents] of [["missing", null], ["empty", ""], ["stale", "999999"]] as const) {
      if (contents === null) rmSync(join(dir, "dev.pid"), { force: true });
      else writeFileSync(join(dir, "dev.pid"), contents);
      /*
        `set -uo pipefail` is what the script itself declares, and `-u` is the live hazard: an unset
        `$d` under it aborts everything after this point in the chain. `-e` is added on top because
        the fragment is cheap to make robust and the script's flags are not this test's to assume
        forever — the first version of this ran only `-e`, found a real abort, and the fix is good
        under both.
      */
      for (const flags of ["set -uo pipefail", "set -euo pipefail"]) {
        const out = execFileSync("bash", ["-c", `${flags}; ${script} echo OK`], { encoding: "utf8" });
        assert.match(out, /OK/, `the teardown aborted the chain under "${flags}" with a ${name} pid file`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the probe line reports up, waiting and dead as three different things", { skip: inMonorepo() ? false : ONLY_IN_MONOREPO }, () => {
  /**
   * The parse the loop depends on. Run for real, because `curl` writing `000` on a refused
   * connection and the `$(cat)` collapsing to empty are both assumptions about output, and both
   * are the kind of assumption that is wrong quietly.
   */
  const dir = mkdtempSync(join(tmpdir(), "preview-probe-"));
  const exitFile = join(dir, "preview.exit");
  const probe = () =>
    execFileSync(
      "bash",
      ["-c", `curl -s -o /dev/null -m 1 -w '%{http_code}' http://127.0.0.1:1/ || true; echo " gone=$(cat ${exitFile} 2>/dev/null)"`],
      { encoding: "utf8" },
    ).trim();
  const up = /^[1-5]\d\d\b/;
  const gone = /gone=\d/;
  try {
    const waiting = probe();
    assert.ok(!up.test(waiting), `a port that refuses read as up: "${waiting}"`);
    assert.ok(!gone.test(waiting), `a boot still installing read as dead: "${waiting}"`);

    writeFileSync(exitFile, "1\n");
    const dead = probe();
    assert.ok(gone.test(dead), `an exited dev server was not noticed: "${dead}"`);

    // And a real answer wins over both, including the exit-zero case the race note describes.
    for (const line of ["200 gone=", "404 gone=", "500 gone=", "200 gone=0"]) {
      assert.ok(up.test(line), `a dev server answering ${line.slice(0, 3)} was not accepted as live`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
