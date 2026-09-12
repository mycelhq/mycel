// Review was a binary: release it, or send it back to be redone. Every service business owner's
// actual instinct is the third thing — change one sentence, then send.
import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryDeliverableStore } from "../src/deliverables";

const P = "p1";
async function seeded() {
  const s = new InMemoryDeliverableStore();
  const d = await s.createDeliverable({ project_id: P, case_id: "k1", client_id: "c1", title: "July close", kind: "document" });
  await s.submitVersion({
    project_id: P, deliverable_id: d.id, allowedFrom: ["drafting"],
    version: { summary: "the agent's words", artifact_ids: ["a1"], task_id: "t1" },
    at: new Date().toISOString(),
  });
  return { s, d };
}

test("an edit is a NEW version — the agent's original survives", async () => {
  // The difference between what the agent wrote and what the founder sent is a labelled correction
  // on real work. Overwriting the original destroys the most valuable signal this product makes.
  const { s, d } = await seeded();
  const out = await s.submitVersion({
    project_id: P, deliverable_id: d.id, allowedFrom: ["in_review"],
    version: { summary: "the founder's words", artifact_ids: ["a1"], task_id: "t1", author: "founder" },
    at: new Date().toISOString(),
  });
  assert.ok(out);
  const versions = await s.listVersions(P, d.id);
  assert.equal(versions.length, 2);
  assert.equal(versions[0]!.summary, "the agent's words");
  assert.equal(versions[1]!.summary, "the founder's words");
});

test("the author is recorded, and absent means the agent", async () => {
  const { s, d } = await seeded();
  const before = await s.listVersions(P, d.id);
  assert.equal(before[0]!.author, undefined, "every version written before founders could edit");

  await s.submitVersion({
    project_id: P, deliverable_id: d.id, allowedFrom: ["in_review"],
    version: { summary: "fixed the date", artifact_ids: ["a1"], author: "founder" },
    at: new Date().toISOString(),
  });
  const after = await s.listVersions(P, d.id);
  assert.equal(after[1]!.author, "founder");
});

test("THE FILES COME ACROSS UNCHANGED — editing the note is not replacing the work", async () => {
  // Conflating the two would let a one-word fix silently drop the PDF.
  const { s, d } = await seeded();
  await s.submitVersion({
    project_id: P, deliverable_id: d.id, allowedFrom: ["in_review"],
    version: { summary: "one word changed", artifact_ids: ["a1"], author: "founder" },
    at: new Date().toISOString(),
  });
  const v = await s.listVersions(P, d.id);
  assert.deepEqual(v[1]!.artifact_ids, ["a1"], "the document is still attached");
});

test("an edit is only allowed on work that is actually waiting for review", async () => {
  const { s, d } = await seeded();
  const at = new Date().toISOString();
  await s.releaseVersion(P, d.id, 1, at);
  await s.transitionDeliverable(P, d.id, "with_client", ["in_review"], at);

  const blocked = await s.submitVersion({
    project_id: P, deliverable_id: d.id, allowedFrom: ["in_review"],
    version: { summary: "too late", artifact_ids: ["a1"], author: "founder" },
    at,
  });
  assert.equal(blocked, undefined, "the client already has it — rewriting under them is the bug the CAS prevents");
});
