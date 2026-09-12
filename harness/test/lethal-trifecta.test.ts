// ═══ THE RULE OF TWO, PINNED ═══
//
// An agent that combines three capabilities can be turned into an exfiltration tool by a single
// instruction hidden in content it reads:
//
//   1. access to private data
//   2. exposure to untrusted content
//   3. the ability to communicate externally
//
// Each is harmless alone. Together, an injected instruction has everything it needs: gather what
// the agent can already see, and send it somewhere using the channel the agent already has. The
// attacker never touches our infrastructure — the instruction arrives as ordinary content the agent
// was built to read. Prompt injection has no parameterized-query equivalent, because a model has no
// separate channel for commands and data, so the containment has to sit AROUND the model.
//
// This kernel holds all three on `deliver`: a client's emailed spreadsheet is untrusted content
// (`POST /v1/tasks/:id/artifacts` exists for exactly that), the tenant's knowledge is private, and
// an action grant can send. That is fine — the containment is real and these tests are what keep
// it real.
//
// Two things make it hold, and both are load-bearing:
//
//   · `grants_actions: false` on the shapes that do not need to send. `build` and `operate` can be
//     fully hijacked and still leak nothing, because they hold no credential to send with.
//   · The gate is SERVER-SIDE. The sandbox plugin matches gated tool NAMES ("send", "email", …),
//     and `bash` matches none of them — a shell-enabled run is ungated at the plugin layer by
//     construction. So the approval gate lives on the action route instead, where curl cannot go
//     around it.
//
// These tests exist because both properties are one careless edit from disappearing, and neither
// failure would show up as a broken test anywhere else.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const harness = readFileSync(join(SRC, "harness.ts"), "utf8");
const server = readFileSync(join(SRC, "server.ts"), "utf8");

/** `grants_actions` per shape, read from the defaults rather than restated here. */
function grantsByShape(): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const m of harness.matchAll(/^ {2}(\w+): \{/gm)) {
    const block = harness.slice(m.index! + m[0].length, m.index! + m[0].length + 6000);
    const body = block.slice(0, block.indexOf("\n  },") + 1 || undefined);
    const g = body.match(/grants_actions:\s*(true|false)/);
    if (g) out[m[1]] = g[1] === "true";
  }
  return out;
}

test("the shapes that do not need to send cannot send", () => {
  const g = grantsByShape();
  // A build agent reads a repo and a founder's brief and runs a shell. If it could also send, an
  // instruction hidden in any file it reads would have a way out.
  assert.equal(g.build, false, "a build run must hold no action grant");
  // An operate run drives a BROWSER — the most untrusted content there is.
  assert.equal(g.operate, false, "a browsing run must hold no action grant");
});

test("every shape that CAN send is gated on the server, not in the sandbox", () => {
  const g = grantsByShape();
  const sending = Object.entries(g).filter(([, v]) => v).map(([k]) => k);
  assert.ok(sending.length > 0, "no shape can act at all — the parser has drifted");

  // The gate must be on the action route. If this moves into the sandbox, `bash` + `curl` walks
  // around it, which is the whole reason it is here.
  assert.match(server, /app\.post\("\/v1\/internal\/actions\/:capability"/, "the action route moved");
  const route = server.slice(server.indexOf('app.post("/v1/internal/actions/:capability"'));
  const gate = route.slice(0, route.indexOf("HUMAN APPROVAL GATE") + 4000);
  assert.match(gate, /HUMAN APPROVAL GATE/, "the human approval gate is gone from the action route");
  assert.match(
    gate,
    /assessRisk\(/,
    "the gate no longer assesses risk before acting — every send would be equal",
  );
});

test("no capability verb skips the gate", () => {
  // The route's own promise, and the property a reviewer needs to be able to check quickly: the
  // planner rewrites a capability verb INTO the gated path rather than around it.
  const route = server.slice(server.indexOf('app.post("/v1/internal/actions/:capability"'));
  const head = route.slice(0, 6000);
  assert.match(
    head,
    /no branch below that skips the gate/i,
    "the no-skip guarantee was removed from the action route's contract",
  );
});

test("a shell-enabled shape is never trusted to gate itself", () => {
  // The plugin matches gated tool NAMES. `bash` is not one of them and cannot be made one without
  // gating every shell command, so a shape with a shell is ungated at the plugin layer BY DESIGN.
  // The comment that says so must survive, because it is the reason the server-side gate exists.
  assert.match(
    harness + server,
    /matches on tool NAME|isGated\(\) matches/i,
    "the note explaining why the plugin cannot gate a shell is gone — the next reader will assume it can",
  );
});
