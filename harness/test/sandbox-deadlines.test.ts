// A TIMEOUT ARGUMENT THAT THE IMPLEMENTATION DROPS.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// THE OUTAGE THIS EXISTS TO PREVENT
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// `books-keeper/monthly_close`, production, 2026-09-05. Eight runs in one day, every one dead at
// EXACTLY 60 minutes with a Daytona `504 Gateway Time-out` and $0 spent — the model was never
// reached. The event timeline is four lines long:
//
//     15:16:32  step.started  configure_sandbox
//     15:16:38  step.started  start_opencode
//     16:16:39  task.finished 504 Gateway Time-out
//
// One step, one hour, nothing in between. The run burned its entire `max_runtime_s: 3600` budget
// inside `start_opencode` and the stall watchdog never fired — it cannot, because it lives inside
// `for await (const ev of stream)` and there is no stream yet at that point.
//
// The cause is in the interface:
//
//     exec(command: string, timeoutMs?: number): Promise<ExecResult>;   // Sandbox
//     async exec(command: string): Promise<ExecResult>                  // DaytonaSandbox
//
// TypeScript lets an implementation take fewer parameters than the interface declares, so this
// compiles, and every `sandbox.exec(cmd, 300_000)` in the codebase — ten of them, including a
// 300-second build in workspace.ts — silently discards its timeout. `spawn` and `previewUrl` had
// no bound at all. Any one of them could hang for the whole task budget, and one did.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { withDeadline, DAYTONA_DEADLINES } from "../src/sandbox";

test("withDeadline rejects when the promise outlives its bound", async () => {
  const never = new Promise<string>(() => {});
  await assert.rejects(
    () => withDeadline(never, 40, "exec"),
    /exec.*40ms|timed out/i,
    "a hung call must reject rather than hang the run",
  );
});

test("withDeadline names what timed out", async () => {
  // "the run failed" is the failure this whole file is about. The message has to say which call.
  const never = new Promise<string>(() => {});
  const err = await withDeadline(never, 20, "previewUrl").catch((e: Error) => e);
  assert.match((err as Error).message, /previewUrl/, "the label must reach the error");
});

test("withDeadline passes a fast value straight through", async () => {
  assert.equal(await withDeadline(Promise.resolve("ok"), 5_000, "exec"), "ok");
});

test("withDeadline does not swallow a real rejection", async () => {
  await assert.rejects(
    () => withDeadline(Promise.reject(new Error("ECONNREFUSED")), 5_000, "exec"),
    /ECONNREFUSED/,
    "the underlying error must survive — a deadline wrapper that masks causes is worse than none",
  );
});

test("withDeadline clears its timer so a fast call cannot hold the process open", async () => {
  // A naive `Promise.race` with `setTimeout` leaves a live handle per call. At one sandbox every
  // five minutes that is a slow leak, and in tests it hangs the runner.
  const before = process.getActiveResourcesInfo?.().filter((r) => r === "Timeout").length ?? 0;
  await withDeadline(Promise.resolve(1), 60_000, "exec");
  const after = process.getActiveResourcesInfo?.().filter((r) => r === "Timeout").length ?? 0;
  assert.ok(after <= before, `left ${after - before} timer(s) pending`);
});

test("every method that touches the SDK is bounded", () => {
  // THIS TEST USED TO ITERATE `DAYTONA_DEADLINES` AND ASSERT THE NUMBERS WERE FINITE, which is
  // tautological: it can only ever pass, and it passed while `writeFile`, `readFile`, `destroy`
  // and `acquire` were still unbounded — including the `writeFile` that runs inside
  // `start_opencode`, the exact step whose hang this file exists for.
  //
  // The honest assertion enumerates the methods that reach the SDK and requires each to be bounded.
  // It reads the class, so a new unbounded method fails it on the day it is written.
  const src = readFileSync(new URL("../src/sandbox.ts", import.meta.url), "utf8");
  const cls = src.slice(src.indexOf("export class DaytonaSandbox"), src.indexOf("\nexport class DockerSandbox"));
  const bodies = cls.split(/\n  (?:static )?async /).slice(1);
  const touching = bodies
    .map((b) => ({ name: b.slice(0, b.indexOf("(")), body: b.replace(/\/\*[\s\S]*?\*\//g, "") }))
    .filter((m) => /this\.sb\.|client\.create/.test(m.body));

  assert.ok(touching.length >= 6, `expected to find the SDK-touching methods, found ${touching.length}`);
  for (const m of touching) {
    assert.match(m.body, /withDeadline/, `DaytonaSandbox.${m.name} reaches the SDK unbounded — it can consume a whole task budget`);
  }
});

test("the declared deadlines are finite and short enough to matter", () => {
  for (const [name, ms] of Object.entries(DAYTONA_DEADLINES)) {
    assert.ok(Number.isFinite(ms) && ms > 0, `${name} must be finite and positive`);
    assert.ok(ms <= 20 * 60 * 1000, `${name} at ${ms}ms is long enough to eat a task budget`);
  }
});


// ─────────────────────────────────────────────────────────────────────────────────────────────────
// AND THAT THE METHODS ACTUALLY USE IT
// ─────────────────────────────────────────────────────────────────────────────────────────────────
//
// Everything above tests the helper. None of it would notice `withDeadline` being deleted from
// `exec` — which is the precise shape of the bug this file exists for: a bound that is declared,
// available, and not applied at the call site.

/** The body of one method on DaytonaSandbox, comments stripped. */
function methodBody(name: string): string {
  const src = readFileSync(new URL("../src/sandbox.ts", import.meta.url), "utf8");
  const cls = src.slice(src.indexOf("export class DaytonaSandbox"));
  const start = cls.indexOf(`async ${name}(`);
  assert.ok(start > -1, `DaytonaSandbox.${name} not found`);
  return cls
    .slice(start, cls.indexOf("\n  async ", start + 10))
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[^\n]*?\/\/[^\n]*$/gm, "");
}

for (const m of ["exec", "spawn", "previewUrl"] as const) {
  test(`DaytonaSandbox.${m} is bounded`, () => {
    const body = methodBody(m);
    assert.match(body, /withDeadline/, `${m} must go through withDeadline — an unbounded call can eat the whole task budget`);
    assert.match(
      body,
      new RegExp(`DAYTONA_DEADLINES\\.${m}|timeoutMs`),
      `${m} must use its declared deadline rather than an inline number`,
    );
  });
}

test("exec honours the timeout its interface promises", () => {
  // The original bug in one assertion: the interface says `exec(command, timeoutMs?)` and the
  // implementation took `(command)`. A signature narrower than the interface still compiles.
  const body = methodBody("exec");
  assert.match(
    body.split("\n")[0],
    /timeoutMs/,
    "exec's signature must accept timeoutMs — ten call sites pass one and TypeScript will not tell you it is dropped",
  );
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE ONE PAIR OF BRACKETS
// ─────────────────────────────────────────────────────────────────────────────────────────────────
//
// `spawn` sent `${command} &` and it hung — every time, for the whole of `max_runtime_s`, on every
// agent run this product attempted in production. 117 failures in twelve hours averaging 62 minutes.
//
// The command is an AND-list:
//
//     set -a && . envFile && set +a && rm -f envFile && opencode serve … > /tmp/opencode.log 2>&1
//
// `&` binds looser than `&&`, so bash backgrounds the WHOLE list as a subshell — and the redirection
// binds only to `opencode serve`. The subshell's own stdout and stderr are still the exec session's,
// and the subshell does not exit until opencode does. Daytona's `executeCommand` waits for EOF on
// those streams, so it waits for a server designed never to stop.
//
// Measured against a live sandbox: the broken form times out at 20s, the wrapped form returns in
// 0.1s, and BOTH leave a healthy opencode answering 200 on its port. opencode was never the problem.

test("spawn detaches the whole command, not just its last word", () => {
  const body = methodBody("spawn");
  assert.match(
    body,
    /\(\s*\$\{command\}\s*\)\s*>\s*\/dev\/null\s*2>&1\s*&/,
    "spawn must wrap the command in a group and redirect THAT — `${command} &` backgrounds an " +
      "AND-list as a subshell whose streams keep the exec session open until the server exits",
  );
});

test("spawn does not background a bare command list", () => {
  // The exact broken form, asserted as forbidden. A template that ends `} &` with no group around
  // it is the bug, and it reads as obviously correct — which is why it survived this long.
  const body = methodBody("spawn");
  assert.ok(
    !/executeCommand\(`\$\{command\}\s*&`\)/.test(body),
    "this is the form that hung every agent run in production",
  );
});
