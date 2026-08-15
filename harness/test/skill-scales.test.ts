// The scales — the tests that make "which skills land the work" a number, per agency and across all.
//
// Attribution had no proof it worked: the skills a run used were computed and dropped, and a client's
// acceptance lived only on the version. Each test here is a claim about the join — a used skill that
// gets accepted weighs up, one sent back weighs down, and the global scale sees every agency while a
// tenant scale sees only its own. Ids are unique per test because the global scope is shared by
// design (that is the whole point), so a reused skill name would let one test's votes count in
// another's aggregate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { makeFreshApp } from "./helpers";
import { getDomainStore } from "../src/domain";
import { recordSkillUses, recordDeliverableVerdict, skillScales } from "../src/skill-scales";

const WEDGE = "books-keeper";

/** A fresh domain store, and a run of unique ids so this test's votes are its own. */
async function scene() {
  await makeFreshApp();
  const domain = getDomainStore();
  const tag = randomUUID().slice(0, 8);
  return { domain, tag, skill: (n: string) => `${n}-${tag}.md` };
}

test("scales: an accepted deliverable weighs its skills up, tenant and global", async () => {
  const { domain, skill } = await scene();
  const project = `proj-${randomUUID()}`;
  const task = `task-${randomUUID()}`;
  const a = skill("close-review");
  const b = skill("reconcile");

  await recordSkillUses(domain, { project_id: project, task_id: task, wedge: WEDGE, skills: [{ name: a }, { name: b }] });
  const cast = await recordDeliverableVerdict(domain, { project_id: project, task_id: task, verdict: "accepted" });
  assert.equal(cast, 2, "one vote per skill the run used");

  const mine = await skillScales(domain, { project_id: project });
  const forA = mine.find((s) => s.skill === a);
  assert.ok(forA, "the used skill shows on the tenant scale");
  assert.equal(forA.accepted, 1);
  assert.equal(forA.revised, 0);
  assert.equal(forA.acceptance_rate, 1);

  const global = await skillScales(domain);
  assert.ok(global.find((s) => s.skill === a && s.wedge === WEDGE), "and on the global scoreboard");
});

test("scales: asking for changes is a loss, not a non-event", async () => {
  const { domain, skill } = await scene();
  const project = `proj-${randomUUID()}`;
  const task = `task-${randomUUID()}`;
  const a = skill("thin-procedure");

  await recordSkillUses(domain, { project_id: project, task_id: task, wedge: WEDGE, skills: [{ name: a }] });
  await recordDeliverableVerdict(domain, { project_id: project, task_id: task, verdict: "changes_requested" });

  const forA = (await skillScales(domain, { project_id: project })).find((s) => s.skill === a);
  assert.ok(forA);
  assert.equal(forA.revised, 1);
  assert.equal(forA.accepted, 0);
  assert.equal(forA.acceptance_rate, 0);
});

test("scales: the global scoreboard sees every agency; a tenant scale sees only its own", async () => {
  const { domain, skill } = await scene();
  const s = skill("shared-web-skill");
  const projA = `proj-${randomUUID()}`;
  const projB = `proj-${randomUUID()}`;
  const taskA = `task-${randomUUID()}`;
  const taskB = `task-${randomUUID()}`;

  // Agency A: the skill landed.
  await recordSkillUses(domain, { project_id: projA, task_id: taskA, wedge: WEDGE, skills: [{ name: s }] });
  await recordDeliverableVerdict(domain, { project_id: projA, task_id: taskA, verdict: "accepted" });
  // Agency B: the same skill got sent back.
  await recordSkillUses(domain, { project_id: projB, task_id: taskB, wedge: WEDGE, skills: [{ name: s }] });
  await recordDeliverableVerdict(domain, { project_id: projB, task_id: taskB, verdict: "changes_requested" });

  const global = (await skillScales(domain)).find((r) => r.skill === s);
  assert.ok(global, "the skill is on the global board");
  assert.equal(global.accepted, 1);
  assert.equal(global.revised, 1);
  assert.equal(global.total, 2);
  assert.equal(global.acceptance_rate, 0.5, "the scale weighs both agencies");

  const forA = (await skillScales(domain, { project_id: projA })).find((r) => r.skill === s);
  assert.equal(forA?.accepted, 1);
  assert.equal(forA?.revised, 0, "agency A does not see agency B's loss");
  const forB = (await skillScales(domain, { project_id: projB })).find((r) => r.skill === s);
  assert.equal(forB?.revised, 1);
  assert.equal(forB?.accepted, 0);
});

test("scales: a verdict for a run that used no skills casts no votes", async () => {
  const { domain } = await scene();
  const cast = await recordDeliverableVerdict(domain, {
    project_id: `proj-${randomUUID()}`,
    task_id: `task-${randomUUID()}`, // nothing recorded for it
    verdict: "accepted",
  });
  assert.equal(cast, 0);
});

test("scales: a verdict never trains another project's scale", async () => {
  const { domain, skill } = await scene();
  const s = skill("scoped");
  const mine = `proj-${randomUUID()}`;
  const theirs = `proj-${randomUUID()}`;
  const task = `task-${randomUUID()}`;

  // The run and its skills belong to `mine`.
  await recordSkillUses(domain, { project_id: mine, task_id: task, wedge: WEDGE, skills: [{ name: s }] });
  // A verdict scoped to `theirs` with my task id must find nothing — the lookup is tenant-scoped.
  const cast = await recordDeliverableVerdict(domain, { project_id: theirs, task_id: task, verdict: "accepted" });
  assert.equal(cast, 0, "the skill uses are not visible from another tenant's scope");
  assert.equal((await skillScales(domain, { project_id: theirs })).length, 0);
});
