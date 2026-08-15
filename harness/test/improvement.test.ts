import { test } from "node:test";
import assert from "node:assert/strict";
import { api, makeApp, waitTask } from "./helpers";
import { parseImprovementProposal } from "../src/improvement";
import { InMemoryKnowledgeStore, resetKnowledgeStore } from "../src/knowledge.store";

test("reflection output is strict, bounded, and does not persist a no-change answer", async () => {
  const context = { project_id: "p1", wedge: "harness-operator", task_id: "t1", task_type: "reflect_memory" };
  assert.equal(parseImprovementProposal({ should_change: false }, context), null);
  assert.equal(parseImprovementProposal({ should_change: true, target: "memory", confidence: "high", title: "no evidence", summary: "x", proposed_change: "y", evidence: [] }, context), null);
  const proposal = parseImprovementProposal({
    should_change: true,
    target: "memory",
    confidence: "high",
    title: "Use the approved tone",
    summary: "The same correction appeared twice.",
    proposed_change: "Add the approved tone as a house memory.",
    evidence: ["task t1 was edited", "task t2 was edited"],
  }, context);
  assert.ok(proposal);
  assert.equal(proposal?.id.length, 36);
  assert.equal(proposal?.evidence.length, 2);
});

test("improvement proposals are tenant-scoped and approval promotes memory only through the API", async () => {
  const store = new InMemoryKnowledgeStore();
  resetKnowledgeStore(store);
  const { app } = makeApp();
  const projectId = (await api(app, "me")).json.projects[0].id as string;
  await store.createImprovementProposal({
    id: "proposal-1", project_id: projectId, wedge: "harness-operator", task_id: "task-1",
    task_type: "reflect_memory", target: "memory", title: "Remember the tone",
    summary: "The founder corrected this twice.", proposed_change: "Use the concise tone.",
    evidence: ["approval edit on task-1"], confidence: "high", metadata: {},
  });
  await store.createImprovementProposal({
    id: "proposal-2", project_id: "another-project", wedge: "harness-operator", task_id: "task-2",
    task_type: "reflect_memory", target: "memory", title: "Private", summary: "Private", proposed_change: "Private",
    evidence: ["private"], confidence: "high", metadata: {},
  });

  const listed = await api(app, "improvements");
  assert.equal(listed.status, 200);
  assert.deepEqual((listed.json as { id: string }[]).map((p) => p.id), ["proposal-1"]);
  const approved = await api(app, "improvements/proposal-1", { method: "PUT", body: JSON.stringify({ status: "approved" }) });
  assert.equal(approved.status, 200);
  assert.equal((approved.json as { status: string }).status, "applied");
  const knowledge = (await api(app, "wedges/harness-operator/knowledge")).json as { metadata: { proposal_id?: string } }[];
  assert.equal(knowledge.some((item) => item.metadata.proposal_id === "proposal-1"), true);
});

test("accepting a procedure writes a playbook the next job mounts", async () => {
  const store = new InMemoryKnowledgeStore();
  resetKnowledgeStore(store);
  const { app } = makeApp();
  const projectId = (await api(app, "me")).json.projects[0].id as string;
  await store.createImprovementProposal({
    id: "proposal-proc",
    project_id: projectId,
    wedge: "invoice-chaser",
    task_id: "task-9",
    task_type: "review_work",
    target: "procedure",
    title: "How we chase",
    summary: "The open sounded like a debt collector.",
    proposed_change: "Lead with the work, not the balance.",
    evidence: ["approval edit on a chase"],
    confidence: "high",
    metadata: {},
  });
  const approved = await api(app, "improvements/proposal-proc", { method: "PUT", body: JSON.stringify({ status: "approved" }) });
  assert.equal(approved.status, 200, approved.text);
  assert.equal((approved.json as { status: string; playbook?: string }).status, "applied");
  assert.equal((approved.json as { playbook?: string }).playbook, "how-we-chase.md");
  const listed = await api(app, "wedges/invoice-chaser/playbooks");
  const row = (listed.json.playbooks as { name: string; source: string; content: string }[]).find((p) => p.name === "how-we-chase.md");
  assert.ok(row, "playbook missing from the library");
  assert.equal(row.source, "yours");
  assert.match(row.content, /Lead with the work/);
});

test("a scheduled-style reflection task becomes a proposal without changing active rules", async () => {
  const store = new InMemoryKnowledgeStore();
  resetKnowledgeStore(store);
  const { app } = makeApp();
  const projectId = (await api(app, "me")).json.projects[0].id as string;
  const created = await api(app, "tasks", {
    method: "POST",
    body: JSON.stringify({ wedge: "harness-operator", task_type: "reflect_memory", input: { message: "reflect" } }),
  });
  assert.equal(created.status, 201);
  await waitTask(app, created.json.id);
  const proposals = await store.listImprovementProposals(projectId);
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0]?.status, "proposed");
  assert.equal((await store.listRules(projectId)).length, 0);
});
