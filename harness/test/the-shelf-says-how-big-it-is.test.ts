/**
 * ═══ A MENU THAT DOES NOT STATE ITS OWN COMPLETENESS IS READ AS THE WHOLE WORLD ═══
 *
 * `stagedArsenalForBrief` writes the next twenty procedures into `craft/` and an index at
 * `craft/INDEX.md`. Both shipped, and nothing in AGENTS.md named either — so reaching them meant
 * the agent had to guess that a directory it was never told about was worth listing. Fourth
 * instance of the same defect in one day, after the craft doc, the deliverable template, and
 * `batch:results`.
 *
 * openwork's tool catalog is the fix, generalised: it renders "COMPLETE list" or
 * "PARTIAL - 12 of 40 shown" and changes its workflow instructions to match, per namespace as well
 * as overall. The point is not the wording. It is that the model is told the SHAPE of its own
 * ignorance, so a gap reads as a gap rather than as the edge of the world.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildAgentsMdForTest } from "../src/runtime";
import { stagedArsenalForBrief } from "../src/skill-arsenal";
import { loadWedge } from "../src/wedge";
import { resolveHarnessProfile } from "../src/harness";
import type { Task } from "../src/contract";

const CEILINGS = { maxRuntimeS: 3600, maxCostUsd: 50 };

function taskOf(wedge: string, task_type: string, input: unknown = {}): Task {
  return {
    id: "t1", project_id: "p1", wedge, task_type,
    actor: { kind: "system", id: "test" }, input,
    constraints: { max_runtime_s: 900, max_cost_usd: 2, approval_required: false },
    tools: [], status: "queued", cost_usd: 0,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  } as Task;
}

const BRIEF = { client: "Fairmont Dental Group", brief: "weekly visibility report and landing page copy" };

test("the staged index states how partial it is, in numbers", () => {
  const staged = stagedArsenalForBrief(taskOf("geo-monitor", "weekly_report", BRIEF));
  assert.ok(staged.staged > 0, "nothing was staged — this fixture no longer exercises the shelf");
  assert.ok(staged.shelf > staged.staged, "the shelf is not bigger than what was staged; the fixture is wrong");

  // The two numbers that make it honest: how many are reachable, and how many exist.
  assert.ok(staged.index.includes(String(staged.shelf)), "the index never says how big the library is");
  assert.match(staged.index, /PARTIAL/i, "the index does not say it is partial");
  // And what to do when nothing fits — the case that otherwise gets improvised silently.
  assert.match(staged.index, /rather than improvising/i, "the index does not say what to do when no procedure fits");
});

test("AGENTS.md names the index, and only when one was staged", () => {
  const wedge = loadWedge("geo-monitor")!;
  const task = taskOf("geo-monitor", "weekly_report", BRIEF);
  const profile = resolveHarnessProfile({ task, wedge, ceilings: CEILINGS });
  const staged = stagedArsenalForBrief(task);

  const withShelf = buildAgentsMdForTest(
    task, wedge, [], profile, undefined, undefined, undefined, undefined, [], undefined, undefined, false,
    { staged: staged.staged, shelf: staged.shelf },
  );
  assert.ok(withShelf.includes("craft/INDEX.md"), "AGENTS.md never names the index that was written to disk");
  assert.ok(withShelf.includes(String(staged.shelf)), "AGENTS.md does not say how big the library is");
  assert.match(withShelf, /closest matches, not the shelf/i, "the mounted list is still presented as complete");

  // A run with no staged shelf must not be pointed at a file it does not have.
  const without = buildAgentsMdForTest(
    task, wedge, [], profile, undefined, undefined, undefined, undefined, [], undefined, undefined, false, undefined,
  );
  assert.ok(!without.includes("craft/INDEX.md"), "a run with no staged shelf is pointed at an absent index");
});

test("the shelf is walked once, not twice, per run", () => {
  // The staging used to be computed at the write site, AFTER AGENTS.md was built. Naming it in the
  // prompt meant either hoisting the call or making it twice; a second walk of a 221-file shelf on
  // every deliver run is a real cost paid for a comment.
  const src = readSrc("runtime.ts");
  const calls = src.split("stagedArsenalForBrief(").length - 1;
  assert.equal(calls, 1, `stagedArsenalForBrief is called ${calls} times per run; the shelf should be walked once`);
});

function readSrc(file: string): string {
  return readFileSync(join(import.meta.dirname, "..", "src", file), "utf8")
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
    })
    .join("\n");
}
