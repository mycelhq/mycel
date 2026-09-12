// A LOCAL SANDBOX IS NOT A SANDBOX, AND `exec` PROVES IT.
//
// `LocalSandbox.exec` is `bash -lc <command>` on the HOST — same machine, same process table, no
// containment. That is fine for the things it is used for, and it makes any command with a
// process-wide blast radius a bug rather than a nuisance.
//
// `pkill -f 'opencode serve'` was run before every `opencode serve` start, described in its own
// comment as "load-bearing ONLY on docker" and "a harmless no-op on daytona/local", and then issued
// unconditionally. On local it killed every opencode on the machine — including one belonging to a
// run still in progress, and including a developer's own session.
//
// Symptom: `opencode ended before completing`, minutes after the kill, with no error. A single run
// in isolation always passed, which is exactly why it read as flakiness for the whole session.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pickOpencodePort } from "../src/runtime";

const runtime = () => readFileSync(new URL("../src/runtime.ts", import.meta.url), "utf8");

test("the host-wide pkill only runs on the backend that needs it", () => {
  const src = runtime();
  // The CALL, not the several comments that discuss it — the first mention in this file is a note
  // about an earlier wrong fix, and matching that is how this test passed while the bug was live.
  const at = src.indexOf(".exec(`pkill -f 'opencode serve'");
  assert.ok(at > 0, "the pkill call is gone entirely — docker still needs it");
  const before = src.slice(Math.max(0, at - 500), at);
  assert.match(before, /cfg\.sandboxBackend === "docker"/, "the pkill is not gated on the docker backend");
});

test("only docker has a fixed port, which is why only docker needs the kill", () => {
  // The justification, asserted rather than trusted: if every backend got the fixed port, gating the
  // kill on docker would be wrong and this test should fail.
  assert.equal(pickOpencodePort("docker", 4444), 4444, "docker must be the fixed-port case");
  const local = new Set(Array.from({ length: 40 }, () => pickOpencodePort("local", 4444)));
  assert.ok(local.size > 1, "local ports are not varied, so a stale bind could still collide");
  assert.ok(!local.has(4444), "a local port collided with the fixed docker port");
});

test("a local sandbox's exec really is unconfined, which is the reason for all of this", () => {
  // If this ever stops being true — a real jail, a container — the gate above can be relaxed. Until
  // then, any command issued through `sandbox.exec` on local runs against the developer's machine.
  const sb = readFileSync(new URL("../src/sandbox.ts", import.meta.url), "utf8");
  const cls = sb.slice(sb.indexOf("export class LocalSandbox"));
  const exec = cls.slice(cls.indexOf("exec("), cls.indexOf("exec(") + 400);
  assert.match(exec, /execFile\(\s*"bash"/, "LocalSandbox.exec no longer shells out on the host");
});
