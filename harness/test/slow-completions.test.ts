import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { resolveHarnessProfile, SHAPE_DEFAULTS } from "../src/harness";
import { buildPromptForTest } from "../src/runtime";
import { loadWedge } from "../src/wedge";
import type { Task } from "../src/contract";

/**
 * A RUN WHOSE MODEL CALLS TAKE NINETY SECONDS EACH MUST COMPLETE.
 *
 * The founder tried his own onboarding and it failed, and it had been failing for everyone. The
 * cause was arithmetic, not a crash.
 *
 * A single model completion measures 85–95 seconds in production (LiteLLM spend logs; the ALB idle
 * timeout was raised 60 → 300 for exactly this reason). Onboarding's `draft_shape` was given 180
 * seconds — two completions — and the prompt then REQUIRED two of them: the strict-output
 * instruction said "FIRST write the JSON to ./output/result.txt, THEN reply with exactly that same
 * JSON". The `decide` profile denies `write` and `edit`, so that file could only be a `bash`
 * heredoc, and a tool call ends the assistant turn. Sample once to emit the heredoc, sample again to
 * repeat the identical JSON as prose.
 *
 * The production evidence, from a week of `mycel:run` task durations in /ecs/mycel/kernel:
 *
 *   11836ms  40168ms  45641ms  105777ms  156235ms  174987ms
 *   180161ms  180255ms  180598ms  180777ms  180848ms  180921ms   ← the ceiling, killed
 *   253425ms
 *
 * p50 175s against a 180s ceiling. The four runs that landed within a second of 180.0 were not slow
 * runs, they were interrupted ones, recorded `expired` with `aborted: max_runtime_exceeded` and
 * shown to a founder as "we failed" on the first screen of the product they ever saw.
 *
 * Two things had to change and both are asserted here, because fixing only the budget would have
 * left every founder waiting three minutes for an answer that takes ninety seconds to produce:
 *
 *   1. the strict prompt asks for ONE turn — the final message is the deliverable;
 *   2. the ceilings are stated in completions, not in minutes.
 */

const COMPLETION_S = 95;
const CEILINGS = { maxRuntimeS: 3600, maxCostUsd: 50 };
const WEDGES = join(import.meta.dirname, "..", "..", "wedges");

function taskOf(wedge: string, task_type: string): Task {
  return {
    id: "t1",
    wedge,
    task_type,
    actor: { kind: "user", id: "founder" },
    input: { description: "I do bookkeeping for UK creative agencies." },
    constraints: { max_runtime_s: 300, max_cost_usd: 1, approval_required: false },
    tools: [],
    status: "queued",
    cost_usd: 0,
    created_at: "",
    updated_at: "",
  } as Task;
}

test("slow completions: the strict prompt asks for the answer in ONE turn, not a file then a turn", () => {
  const wedge = loadWedge("business-shaper");
  assert.ok(wedge, "business-shaper loads");
  const task = taskOf("business-shaper", "draft_shape");
  const profile = resolveHarnessProfile({ task, wedge, ceilings: CEILINGS });
  assert.equal(profile.strict_output, true, "draft_shape is a strict-output decision");

  const prompt = buildPromptForTest(task, wedge, profile);

  // The exact instruction that cost the extra sampling. Not a paraphrase — this is the string.
  assert.ok(
    !/FIRST write the JSON to \.\/output\/result\.txt/.test(prompt),
    "the prompt no longer orders a file write before the answer",
  );
  assert.ok(
    !/result\.txt/.test(prompt),
    `a strict run is never sent to a file for its own deliverable:\n${prompt}`,
  );
  // And it still says what the deliverable IS, or we have merely deleted the instruction.
  assert.match(prompt, /final message/i);
  assert.match(prompt, /must be ONLY the JSON result/);
  assert.ok(prompt.includes("conforming to this schema"), "and it is still shown the shape");
});

test("slow completions: a build run still writes its summary to a file — this fix is decide-only", () => {
  // The doubling only bites `decide`, whose deliverable IS a message. A build's deliverable is a
  // repository and its result.txt is a summary of it, written once at the end of a long run where
  // one extra turn is noise. Narrowing the fix is the point; widening it would be a guess.
  const wedge = loadWedge("product-builder");
  assert.ok(wedge, "product-builder loads");
  const task = taskOf("product-builder", "build_feature");
  const profile = resolveHarnessProfile({ task, wedge, ceilings: CEILINGS });
  assert.equal(profile.shape, "build");
  assert.match(buildPromptForTest(task, wedge, profile), /result\.txt/);
});

test("slow completions: no skill tells an agent to write its result to a file", () => {
  // The prompt and the skills are two mouths on the same instruction, and they disagreed: the
  // prompt said "write FIRST, then reply", the skills said "as your last message AND in
  // ./output/result.txt". An earlier production stall was caused by exactly that contradiction, so
  // fixing one without the other reintroduces it.
  const offenders: string[] = [];
  for (const w of readdirSync(WEDGES, { withFileTypes: true })) {
    if (!w.isDirectory()) continue;
    const skills = join(WEDGES, w.name, "skills");
    let entries: string[];
    try {
      entries = readdirSync(skills);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!f.endsWith(".md")) continue;
      const body = readFileSync(join(skills, f), "utf8");
      // Prose ABOUT the old instruction is allowed — a line telling the agent to do it is not.
      for (const line of body.split("\n")) {
        if (!line.includes("output/result.txt")) continue;
        if (/\bdo not write it to a file\b|\bdo not\b.*result\.txt|used to be told/i.test(line)) continue;
        offenders.push(`${w.name}/${f}: ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `these skills still send the agent through a file:\n${offenders.join("\n")}`);
});

test("slow completions: every budget a founder waits on affords more than two model completions", () => {
  /**
   * The ceiling has to be honest about what a run COSTS, not about how long we wish it took. Two
   * completions is the number that was killing runs; three is the floor for a decision that reads a
   * knowledge file before it answers.
   */
  const waited: Array<[string, string]> = [
    ["business-shaper", "draft_shape"],
    ["business-shaper", "draft_questions"],
    ["business-shaper", "draft_service"],
    ["invoice-chaser", "chase_invoice"],
  ];
  for (const [w, t] of waited) {
    const wedge = loadWedge(w);
    assert.ok(wedge, `${w} loads`);
    const profile = resolveHarnessProfile({ task: taskOf(w, t), wedge, ceilings: CEILINGS });
    assert.ok(
      profile.max_runtime_s >= 3 * COMPLETION_S,
      `${w}/${t} gets ${profile.max_runtime_s}s — under three ${COMPLETION_S}s completions, so a ` +
        `normal run is a coin flip against the ceiling`,
    );
  }

  // Not just the ones listed above: NO declared decide-shaped task type anywhere may sit under the
  // line, or the next founder-facing wedge inherits the same bug by omission.
  const thin: string[] = [];
  for (const dir of readdirSync(WEDGES, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const wedge = loadWedge(dir.name);
    if (!wedge) continue;
    for (const [type, spec] of Object.entries(wedge.manifest.task_types ?? {})) {
      const declared = (spec as { harness?: { shape?: string; max_runtime_s?: number } }).harness;
      if (!declared || declared.shape === "build") continue;
      const profile = resolveHarnessProfile({
        task: taskOf(dir.name, type),
        wedge,
        ceilings: CEILINGS,
      });
      if (profile.max_runtime_s < 3 * COMPLETION_S) thin.push(`${dir.name}/${type}=${profile.max_runtime_s}s`);
    }
  }
  assert.deepEqual(thin, [], `budgets under three model completions: ${thin.join(", ")}`);
});

test("slow completions: the decide shape default itself is stated in completions", () => {
  assert.ok(
    SHAPE_DEFAULTS.decide.max_runtime_s >= 4 * COMPLETION_S,
    `the default every unspecified decision inherits is ${SHAPE_DEFAULTS.decide.max_runtime_s}s`,
  );
  // Still bounded — a ceiling that never fires is not a ceiling, and a stuck run must not be able to
  // sit on a founder's onboarding screen for a quarter of an hour.
  assert.ok(SHAPE_DEFAULTS.decide.max_runtime_s <= 900, "and it is still a ceiling");
});
