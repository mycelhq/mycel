import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { INTERNAL_VOCABULARY } from "../src/client-ready.ts";

/**
 * ═══ A GUARD THE WORKER CANNOT SEE IS A TRAP, NOT A STANDARD ═══
 *
 * `client-ready.ts` refuses to release a covering note containing any internal word, and for the
 * life of the product the run had never been shown the list. The first real `weekly_report` this
 * system ever completed was held on it, for the word "probes" — a full-price run producing a
 * finished report that no client could receive, failing a test it was never given.
 *
 * This pins the fix at the seam rather than in prose: one list, imported by both sides.
 */
const runtime = readFileSync(new URL("../src/runtime.ts", import.meta.url), "utf8");
const code = runtime.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("the run is told the rule it will be judged by", () => {
  assert.match(code, /INTERNAL_VOCABULARY\.join/);
  assert.match(code, /import \{ INTERNAL_VOCABULARY \} from "\.\/client-ready"/);
});

test("one list, not two that drift", () => {
  /**
   * Scoped to the instruction, not the file. `runtime.ts` uses "task_type" and "connection_id" all
   * over as real field names, and a whole-file scan reads those as restatements — the same
   * false-positive shape as matching a comment. What must not happen is the INSTRUCTION spelling
   * the words out, which would pass today and rot the first time somebody adds a term to the gate.
   */
  const at = code.indexOf("These words are ours, not theirs");
  assert.ok(at > 0, "the instruction is missing");
  const instruction = code.slice(at, at + 400);
  const quoted = INTERNAL_VOCABULARY.filter((w) => instruction.includes(`"${w}"`));
  assert.deepEqual(quoted, [], `the instruction restates the gate's list instead of interpolating it: ${quoted}`);
  assert.match(instruction, /\$\{INTERNAL_VOCABULARY\.join/);
});

test("it says who the note is for, not only what is banned", () => {
  // A blocklist alone teaches avoidance. The reason the words are wrong is that a client did not
  // commission a run and does not know this system exists, and saying so is what changes the voice.
  assert.match(code, /The summary is read by your client/);
  assert.match(code, /do not know this system exists/);
});

test("a prohibition is paired with a way to say the thing", () => {
  /**
   * The blocklist alone failed in production and the failure is instructive: a run needed to tell a
   * client a measurement had not completed and should be taken again, the honest English for which
   * is "rerun the checks" — a banned word. With no permitted phrasing offered the model chose the
   * accurate sentence over the rule, which was the right call. A prohibition with no alternative is
   * a trap for anyone with something true to say.
   */
  const at = code.indexOf("Where you need the idea and not the word");
  assert.ok(at > 0, "the banned list must come with substitutions");
  const sub = code.slice(at, at + 500);
  for (const term of ["probe", "artifact", "run"]) {
    assert.ok(sub.includes(term), `no alternative offered for "${term}"`);
  }
});

test("the vocabulary stays narrow enough to be honest", () => {
  // client-ready.ts argues this at length: a guard that holds real work gets switched off, and the
  // genuine leaks come back with it. These are nouns every service business uses about itself.
  for (const ordinary of ["report", "invoice", "statement", "document", "account", "pipeline", "workflow"]) {
    assert.ok(!INTERNAL_VOCABULARY.includes(ordinary), `"${ordinary}" belongs to the client's trade, not to us`);
  }
});
