/**
 * ═══ THE LOOP THAT COST THREE SANDBOX BOOTS AND PRODUCED NO REPORT ═══
 *
 * A parked parent has no memory of its first run: parking is a throw, the sandbox is destroyed and
 * the agent process is gone. `priorBatchResults` exists for exactly that and mounts the children's
 * outputs as `batch:results`, whose first paragraph is "DO NOT SPAWN THEM AGAIN."
 *
 * The agent never opened it. Observed end to end on task b8ef3b01, 6 September, geo weekly report:
 * three rounds, each reading run-geo-week.md, turn-measurement-into-work.md, craft:presenting-work,
 * the-shape-of-the-finished-work.md, brand/tokens.css and exemplar:weekly-report — and never
 * `batch:results`, which was mounted on rounds two and three. Six probe children, all six
 * succeeded, and the third fan-out tripped the loop cap: "fanned out 3 times without finishing".
 *
 * The file was correct. Nothing named it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildAgentsMdForTest } from "../src/runtime";
import { loadWedge } from "../src/wedge";
import { resolveHarnessProfile } from "../src/harness";
import type { Task } from "../src/contract";

const CEILINGS = { maxRuntimeS: 3600, maxCostUsd: 50 };

function taskOf(wedge: string, task_type: string): Task {
  return {
    id: "t1", project_id: "p1", wedge, task_type,
    actor: { kind: "system", id: "test" }, input: {},
    constraints: { max_runtime_s: 3600, max_cost_usd: 50, approval_required: false },
    tools: [], status: "queued", cost_usd: 0,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  } as Task;
}

const RESULTS = { name: "batch:results", content: "# The work you already sent out\nDO NOT SPAWN THEM AGAIN." };

function agentsMd(mounted: Array<{ name: string; content: string }>) {
  const wedge = loadWedge("geo-monitor")!;
  const task = taskOf("geo-monitor", "weekly_report");
  const profile = resolveHarnessProfile({ task, wedge, ceilings: CEILINGS });
  assert.ok(profile.grants_actions, "the fan-out section only renders for a run that holds a token");
  return buildAgentsMdForTest(task, wedge, [], profile, undefined, undefined, undefined, undefined, [], mounted);
}

test("a resumed run is told it already fanned out, and told before it is told how to fan out", () => {
  const md = agentsMd([RESULTS]);
  assert.match(md, /already fanned out/i, "the resumed run is never told its children came back");
  assert.ok(md.includes("skills/batch:results"), "the prompt does not name the file holding the answers");

  // Order is the whole point. A run that reads "here is how to open a batch" first has already
  // decided to open one by the time it learns it has the results.
  const told = md.search(/already fanned out/i);
  const howTo = md.indexOf("## Exact numbers and fan-out");
  assert.ok(howTo > -1, "the fan-out section is gone — this test is asserting against nothing");
  assert.ok(told < howTo, "the run is taught to fan out before it is told it already has");
});

test("a first round is told nothing about results it does not have", () => {
  // Round one has no batch. Claiming otherwise would send it looking for a file that is not there,
  // and a prompt that points at absent files is one the model stops trusting.
  const md = agentsMd([]);
  assert.ok(!/already fanned out/i.test(md), "a first run is told it already fanned out");
  assert.ok(!md.includes("batch:results"), "a first run is pointed at a file it was never given");
  // It must still learn how to fan out — that is the capability the whole wedge is built on.
  assert.ok(md.includes("## Exact numbers and fan-out"), "the first round lost the fan-out instructions");
});

test("the index line for a mounted file says what it is, not its first stray sentence", async () => {
  /**
   * `fileSummary` prefers frontmatter `description` and otherwise takes the first non-heading line.
   * For `batch:results` that line was "You spawned 2 job(s) earlier in this task and they have
   * finished. Their" — cut at a line break, mid-sentence, with "DO NOT SPAWN THEM AGAIN" six lines
   * below and never surfaced. The index line is the entire basis on which the agent decides whether
   * to open a file, and this one read like noise.
   */
  const { fileSummaryForTest } = await import("../src/runtime");
  const { batchResultsPage } = await import("../src/batches");

  const page = batchResultsPage([{ ok: true, n: 1 }]);
  const summary = fileSummaryForTest(page.content);
  assert.ok(!summary.endsWith("Their"), "the summary is still a sentence fragment");
  assert.match(summary, /do not open another batch/i, "the index line does not carry the instruction that stops the loop");
  // And the body must still say it, for the agent that does open the file.
  assert.match(page.content, /DO NOT SPAWN THEM AGAIN/, "the body lost its warning");
});
