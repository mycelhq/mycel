/**
 * ═══ THE RUN DIED. THE BOX DID NOT. ═══
 *
 * `recoveryReason` has always told the founder "The sandbox it was working in went with it", and
 * that was half true. The RUN went with it. The sandbox stayed `started`, with nothing driving it,
 * until its idle timer fired and Daytona's auto-delete finally caught it.
 *
 * Fourteen days of production: 396 runs interrupted by a kernel restart, 870 sandbox-hours of
 * 10 GiB boxes doing nothing — the largest single line in a bill whose disk share is 80%.
 *
 * `reapStoppedSandboxes` cannot cover it. It refuses to touch a `started` box, correctly, because
 * from outside a slow run looks identical to an abandoned one. Only the kernel that created this
 * box knows it is dead — so it writes the id down before any work runs, and recovery deletes it by
 * name. openwork does the same thing for the same reason: reserve and persist the runtime identity
 * BEFORE submitting the prompt, so a lease can be recovered rather than guessed at.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dirname, "..", "src");
const code = (f: string) =>
  readFileSync(join(SRC, f), "utf8")
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
    })
    .join("\n");

test("the sandbox id is written down before any work runs", () => {
  const orch = code("orchestrator.ts");
  const acquire = orch.indexOf("createSandbox(");
  const record = orch.indexOf('"sandbox.acquired"');
  assert.ok(acquire > -1, "createSandbox is gone — this test is asserting against nothing");
  assert.ok(record > -1, "the orchestrator never records the sandbox id; a restart cannot name what it held");
  // Order matters and is the whole point. Recording it after the run would miss every run that
  // dies during the work, which is all of them.
  assert.ok(record > acquire, "the id must be recorded straight after acquisition");
  const between = orch.slice(acquire, record);
  assert.ok(
    !/await\s+(runTask|startPrompt|oc\.)/.test(between),
    "work begins before the sandbox id is recorded — a run killed in that window still leaks",
  );
});

test("recovery deletes the box by name, and cannot be blocked by the provider", () => {
  const rec = code("recovery.ts");
  assert.match(rec, /deleteSandboxById/, "recovery never deletes the sandbox it knows was orphaned");
  assert.match(rec, /sandbox\.acquired/, "recovery does not read the id the orchestrator wrote");
  // A provider call must never leave a task non-terminal. That is worse than the leak.
  assert.match(
    rec,
    /reapSandboxFor\([^)]*\)\.catch\(/,
    "the reap is not guarded — a Daytona outage would stop tasks being marked failed",
  );
  /**
   * The first version of this asserted the reap ran BEFORE `setStatus`, and it could not fail: it
   * used `indexOf("reapSandboxFor(")`, which finds the function DEFINITION sitting above
   * `recoverTasks`, so the position was always earlier than the call it meant to check. Moving the
   * real call after `setStatus` left it green.
   *
   * Worth writing down because the fix is not a better `indexOf`. The order is not the invariant —
   * the reap is `.catch()`-guarded either way, so the row is marked failed regardless, and after
   * is arguably safer. What must hold is that the row reaches a terminal state at all. That is what
   * is asserted, on the call site rather than the declaration.
   */
  const call = rec.indexOf("await reapSandboxFor(");
  assert.ok(call > -1, "reapSandboxFor is defined but never called");
  assert.match(rec, /setStatus\(t\.id, "failed", reason\)/, "the interrupted row is no longer marked failed");
});

test("every round's box is released, not just the last", async () => {
  // A parent resumed after a batch acquires a fresh sandbox each round. The rounds before the last
  // are precisely the ones no other mechanism will ever name — the geo report that looped three
  // times held three boxes and recovery would have released one.
  const rec = code("recovery.ts");
  assert.match(rec, /new Set<string>\(\)/, "the reap keeps a single id rather than all of them");
  assert.ok(!/events\.at\(-1\)|\.pop\(\)|findLast/.test(rec), "the reap looks at only the last acquisition");
});

test("a 404 from the provider counts as released", async () => {
  // The box we wanted gone is gone. Reporting that as a failure would make the log claim a leak
  // that does not exist, and this repo has paid for logs that lie.
  const sb = code("sandbox.ts");
  assert.match(sb, /status === 404/, "deleteSandboxById treats an already-deleted box as a failure");
});
