import { test } from "node:test";
import assert from "node:assert/strict";
import { api, makeApp, waitTask } from "./helpers";

/**
 * The prompt is paid for on every single run, so what goes in it is a cost decision as much as a
 * design one. These assert the shape rather than the wording.
 */
test("context: skills are indexed in the prompt, not inlined into it", async () => {
  // Every skill's full text used to be concatenated into AGENTS.md, so a wedge with twenty
  // procedures paid for twenty on a task that needed one. The agent has a filesystem — knowledge
  // already works this way — so the prompt carries a menu and the agent pays only for what it opens.
  const { app, store } = makeApp();
  const created = await api(app, "tasks", {
    method: "POST",
    body: JSON.stringify({ wedge: "books-keeper", task_type: "daily_sync", input: {} }),
  });
  await waitTask(app, created.json.id);

  const { readFileSync, existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { loadWedge } = await import("../src/wedge");
  const wedge = loadWedge("books-keeper")!;
  assert.ok(wedge.skills.length, "the wedge has skills to index");

  const { buildAgentsMdForTest } = await import("../src/runtime");
  const task = await store.getTask(created.json.id);
  const md = buildAgentsMdForTest(task!, wedge, []);

  for (const s of wedge.skills) {
    // The path is named so the agent can open it…
    assert.ok(md.includes(`skills/${s.name}`), `${s.name} is indexed`);
    // …and it comes with enough of a description to decide whether it is worth opening. That line
    // is the whole basis of the decision, so a skill with no summary is a skill that gets skipped.
    const line = md.split("\n").find((l) => l.includes(`skills/${s.name}`))!;
    assert.ok(line.length > `- \`skills/${s.name}\` — `.length + 10, `${s.name} has a real summary`);
  }

  // The body is NOT in the prompt. Checked against a distinctive phrase from the file itself rather
  // than a length heuristic, which would pass for the wrong reason.
  const skill = wedge.skills[0];
  const distinctive = skill.content
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 40 && !l.startsWith("#") && !l.startsWith("-"))
    .pop();
  if (distinctive) {
    assert.ok(!md.includes(distinctive), "the skill's prose stays in the file, not the prompt");
  }

  void readFileSync;
  void existsSync;
  void join;
});

test("context: the prompt stays small as a wedge grows procedures", async () => {
  // The property that actually matters: adding skills must not grow the per-run prompt linearly.
  const { buildAgentsMdForTest } = await import("../src/runtime");
  const base = {
    manifest: { name: "x", task_types: {} },
    dir: "/tmp",
    knowledge: [],
    skills: [] as { name: string; content: string }[],
  };
  const task = {
    id: "t1", wedge: "x", task_type: "y", actor: { kind: "system", id: "s" }, input: {},
    constraints: { max_runtime_s: 60, max_cost_usd: 1, approval_required: true },
    tools: [], status: "queued", cost_usd: 0, created_at: "", updated_at: "",
  };

  const one = buildAgentsMdForTest(
    task as never,
    { ...base, skills: [{ name: "a.md", content: "---\ndescription: does a thing\n---\n" + "x".repeat(5000) }] } as never,
    [],
  );
  const ten = buildAgentsMdForTest(
    task as never,
    {
      ...base,
      skills: Array.from({ length: 10 }, (_, i) => ({
        name: `s${i}.md`,
        content: `---\ndescription: does thing ${i}\n---\n` + "x".repeat(5000),
      })),
    } as never,
    [],
  );

  // Ten skills of 5,000 characters each would have added 50,000 characters to every run. The index
  // costs a line apiece.
  assert.ok(ten.length - one.length < 1000, `index grew by ${ten.length - one.length} chars for 9 more skills`);
});
