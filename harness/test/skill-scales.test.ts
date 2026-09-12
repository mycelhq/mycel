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
import { recordSkillUses, recordDeliverableVerdict, skillScales, trialArms } from "../src/skill-scales";

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

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// ATTENTION — the fix that makes the scale measure a skill instead of its wedge
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// Every test above credits every mounted skill equally, which is exactly what the scale used to do
// in production. A wedge mounts roughly the same dozen skills every run, so all twelve accumulated
// the same wins and losses and converged on one number: the wedge's own acceptance rate. It read
// like data and it was the wedge's score printed twelve times.

test("scales: a skill the agent never opened does not get the credit", async () => {
  // The whole fix in one assertion. Two skills mounted, one read, the client accepts. Before this,
  // both went to 100% and the scoreboard could not tell them apart.
  const { domain, skill } = await scene();
  const project = `proj-${randomUUID()}`;
  const task = `task-${randomUUID()}`;
  const opened = skill("the-one-it-read");
  const ignored = skill("the-one-it-ignored");

  await recordSkillUses(domain, {
    project_id: project,
    task_id: task,
    wedge: WEDGE,
    skills: [{ name: opened, read: true }, { name: ignored, read: false }],
  });
  const cast = await recordDeliverableVerdict(domain, { project_id: project, task_id: task, verdict: "accepted" });
  assert.equal(cast, 1, "only the skill that was actually opened casts a vote");

  const mine = await skillScales(domain, { project_id: project });
  const hit = mine.find((s) => s.skill === opened);
  const miss = mine.find((s) => s.skill === ignored);
  assert.equal(hit?.accepted, 1);
  assert.equal(hit?.total, 1);
  // The ignored skill is still ON the scale — it was mounted, and that is the fact that answers
  // "is anyone using this". It just has no verdict resting on it.
  assert.equal(miss?.total, 0, "mounted and ignored: no acceptance evidence either way");
  assert.equal(miss?.mounted, 1);
  assert.equal(miss?.read, 0);
});

test("scales: attention is its own number, and it is the one that finds dead weight", async () => {
  // A skill mounted repeatedly and opened once. Its acceptance rate says nothing (one vote); its
  // attention rate says the index line is not earning the click. That second reading is invisible to
  // an acceptance rate, because with no votes it sits at zero beside everything else with no votes.
  const { domain, skill } = await scene();
  const project = `proj-${randomUUID()}`;
  const dusty = skill("nobody-opens-this");

  for (let i = 0; i < 4; i++) {
    const task = `task-${randomUUID()}`;
    await recordSkillUses(domain, {
      project_id: project,
      task_id: task,
      wedge: WEDGE,
      skills: [{ name: dusty, read: i === 0 }],
    });
    await recordDeliverableVerdict(domain, { project_id: project, task_id: task, verdict: "accepted" });
  }

  const s = (await skillScales(domain, { project_id: project })).find((x) => x.skill === dusty);
  assert.equal(s?.mounted, 4, "mounted into four runs");
  assert.equal(s?.read, 1, "opened in one");
  assert.equal(s?.attention_rate, 0.25);
  assert.equal(s?.total, 1, "and only that one run is evidence about whether it works");
});

test("scales: a run from before attention tracking still counts, both ways", async () => {
  // Rows with no `read` flag are the honest historical record under the old rule. Voiding them to
  // make a new field look tidy would delete the library's entire history.
  const { domain, skill } = await scene();
  const project = `proj-${randomUUID()}`;
  const task = `task-${randomUUID()}`;
  const legacy = skill("written-before-the-flag");

  await recordSkillUses(domain, { project_id: project, task_id: task, wedge: WEDGE, skills: [{ name: legacy }] });
  const cast = await recordDeliverableVerdict(domain, { project_id: project, task_id: task, verdict: "accepted" });
  assert.equal(cast, 1, "an unflagged row keeps its vote");

  const s = (await skillScales(domain, { project_id: project })).find((x) => x.skill === legacy);
  assert.equal(s?.accepted, 1);
  assert.equal(s?.mounted, 1);
  // Not counted as read — it is not known to have been — and so it drags attention down honestly
  // rather than being invented in either direction.
  assert.equal(s?.read, 0);
});

test("scales: the second pass replaces the first rather than doubling it", async () => {
  // runtime.ts writes the mounted set before the first turn (so a crashed run still leaves evidence)
  // and rewrites it in the `finally` with what was opened. That only works because the use rows
  // upsert on (task, skill).
  const { domain, skill } = await scene();
  const project = `proj-${randomUUID()}`;
  const task = `task-${randomUUID()}`;
  const s1 = skill("mounted-then-read");

  await recordSkillUses(domain, { project_id: project, task_id: task, wedge: WEDGE, skills: [{ name: s1 }] });
  await recordSkillUses(domain, { project_id: project, task_id: task, wedge: WEDGE, skills: [{ name: s1, read: true }] });
  const cast = await recordDeliverableVerdict(domain, { project_id: project, task_id: task, verdict: "accepted" });
  assert.equal(cast, 1, "one vote, not two");

  const s = (await skillScales(domain, { project_id: project })).find((x) => x.skill === s1);
  assert.equal(s?.read, 1, "and the later pass is the one that survives");
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// THE FOUNDER STAGE — most of the signal, and it was going in the bin
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// A client verdict needs a client, arrives days later, and for a business still finding its first one
// never arrives at all. A founder decides on every deliverable within minutes of it existing and is
// the harsher judge. Until now none of it was recorded.

test("scales: releasing untouched and rewriting first are different verdicts", async () => {
  const { domain, skill } = await scene();
  const project = `proj-${randomUUID()}`;
  const clean = skill("went-out-as-written");
  const fixed = skill("needed-a-rewrite");

  const t1 = `task-${randomUUID()}`;
  await recordSkillUses(domain, { project_id: project, task_id: t1, wedge: WEDGE, skills: [{ name: clean, read: true }] });
  await recordDeliverableVerdict(domain, { project_id: project, task_id: t1, verdict: "released" });

  const t2 = `task-${randomUUID()}`;
  await recordSkillUses(domain, { project_id: project, task_id: t2, wedge: WEDGE, skills: [{ name: fixed, read: true }] });
  await recordDeliverableVerdict(domain, { project_id: project, task_id: t2, verdict: "edited" });

  const all = await skillScales(domain, { project_id: project });
  const a = all.find((s) => s.skill === clean);
  const b = all.find((s) => s.skill === fixed);
  assert.equal(a?.released, 1);
  assert.equal(a?.first_pass_rate, 1);
  assert.equal(b?.edited, 1);
  assert.equal(b?.first_pass_rate, 0, "close enough to fix is not close enough to send");
  // And neither has touched the client-stage number, which is about something else entirely.
  assert.equal(a?.total, 0);
  assert.equal(b?.total, 0);
});

test("scales: the two stages are never averaged into one figure", async () => {
  // A founder's tidy-up must not cancel out a client's rejection. The composite would describe
  // nothing that happens in the world.
  const { domain, skill } = await scene();
  const project = `proj-${randomUUID()}`;
  const s1 = skill("released-then-rejected");
  const task = `task-${randomUUID()}`;

  await recordSkillUses(domain, { project_id: project, task_id: task, wedge: WEDGE, skills: [{ name: s1, read: true }] });
  await recordDeliverableVerdict(domain, { project_id: project, task_id: task, verdict: "released" });
  await recordDeliverableVerdict(domain, { project_id: project, task_id: task, verdict: "changes_requested" });

  const s = (await skillScales(domain, { project_id: project })).find((x) => x.skill === s1);
  assert.equal(s?.first_pass_rate, 1, "the founder did send it");
  assert.equal(s?.acceptance_rate, 0, "the client did send it back");
  assert.equal(s?.founder_total, 1);
  assert.equal(s?.total, 1);
});

test("scales: a founder refusal is recorded before any client sees the work", async () => {
  const { domain, skill } = await scene();
  const project = `proj-${randomUUID()}`;
  const s1 = skill("refused-outright");
  const task = `task-${randomUUID()}`;
  await recordSkillUses(domain, { project_id: project, task_id: task, wedge: WEDGE, skills: [{ name: s1, read: true }] });
  await recordDeliverableVerdict(domain, { project_id: project, task_id: task, verdict: "sent_back" });

  const s = (await skillScales(domain, { project_id: project })).find((x) => x.skill === s1);
  assert.equal(s?.sent_back, 1);
  assert.equal(s?.first_pass_rate, 0);
  assert.equal(s?.total, 0, "no client ever saw it, so there is no acceptance evidence");
});

test("scales: a skill well-evidenced by founders outranks one with a single acceptance", async () => {
  // Sorting on client votes alone would bury forty founder decisions under one lucky acceptance.
  const { domain, skill } = await scene();
  const project = `proj-${randomUUID()}`;
  const busy = skill("forty-founder-calls");
  const lucky = skill("one-acceptance");

  for (let i = 0; i < 8; i++) {
    const t = `task-${randomUUID()}`;
    await recordSkillUses(domain, { project_id: project, task_id: t, wedge: WEDGE, skills: [{ name: busy, read: true }] });
    await recordDeliverableVerdict(domain, { project_id: project, task_id: t, verdict: "released" });
  }
  const t = `task-${randomUUID()}`;
  await recordSkillUses(domain, { project_id: project, task_id: t, wedge: WEDGE, skills: [{ name: lucky, read: true }] });
  await recordDeliverableVerdict(domain, { project_id: project, task_id: t, verdict: "accepted" });

  const all = await skillScales(domain, { project_id: project });
  const iBusy = all.findIndex((s) => s.skill === busy);
  const iLucky = all.findIndex((s) => s.skill === lucky);
  assert.ok(iBusy < iLucky, "the better-evidenced skill reads first");
});

test("scales: an unknown verdict is skipped, never coerced to the nearest known one", async () => {
  // The ledger outlives any one enum. A row this build does not recognise is one a later build may,
  // and coercing it would invent data.
  const { domain, skill } = await scene();
  const project = `proj-${randomUUID()}`;
  const s1 = skill("from-the-future");
  const task = `task-${randomUUID()}`;
  await recordSkillUses(domain, { project_id: project, task_id: task, wedge: WEDGE, skills: [{ name: s1, read: true }] });
  await recordDeliverableVerdict(domain, {
    project_id: project,
    task_id: task,
    verdict: "escalated_to_partner" as never,
  });

  const s = (await skillScales(domain, { project_id: project })).find((x) => x.skill === s1);
  assert.equal(s?.total, 0);
  assert.equal(s?.founder_total, 0);
  assert.equal(s?.mounted, 1, "but the run still counts as one that mounted it");
});


/**
 * ═══ THE DELIVERABLE-LEVEL TRIAL LEDGER ═══
 *
 * `skill_vote` is per (deliverable × skill), which is right for a scale about a skill and wrong for
 * a trial about anything else. Summing those votes to judge a MODEL would count one deliverable
 * once per skill it mounted — a verdict confidently wrong about its own sample size, which is worse
 * than no verdict because it gets believed. These pin the separation.
 */
test("trial: a deliverable counts once however many skills it mounted", async () => {
  const { domain, skill } = await scene();
  const project = `proj-${randomUUID()}`;
  const task = `task-${randomUUID()}`;
  await recordSkillUses(domain, {
    project_id: project,
    task_id: task,
    wedge: WEDGE,
    skills: [{ name: skill("a") }, { name: skill("b") }, { name: skill("c") }],
    arm: "challenger",
  });
  await recordDeliverableVerdict(domain, { project_id: project, task_id: task, verdict: "released" });

  const arms = await trialArms(domain, { project_id: project });
  assert.equal(arms.challenger.decisions, 1, "three skills, one deliverable");
  assert.equal(arms.challenger.released, 1);
  assert.equal(arms.incumbent.decisions, 0, "the other arm saw nothing");
});

/**
 * A deliverable is released, and weeks later paid. Keying the ledger on the task alone would let
 * the second event overwrite the first, deleting the founder-stage decision the whole first-pass
 * rate is drawn from — and the trial would read as though the work had never been judged.
 */
test("trial: a later payment does not erase the release it was paid for", async () => {
  const { domain, skill } = await scene();
  const project = `proj-${randomUUID()}`;
  const task = `task-${randomUUID()}`;
  await recordSkillUses(domain, {
    project_id: project, task_id: task, wedge: WEDGE, skills: [{ name: skill("a") }], arm: "incumbent",
  });
  await recordDeliverableVerdict(domain, { project_id: project, task_id: task, verdict: "released" });
  await recordDeliverableVerdict(domain, { project_id: project, task_id: task, verdict: "paid" });

  const arms = await trialArms(domain, { project_id: project });
  assert.equal(arms.incumbent.decisions, 1, "the release survived the payment");
  assert.equal(arms.incumbent.released, 1);
  assert.equal(arms.incumbent.paid, 1);
});

/**
 * The ordinary case is that no trial is running, and it must cost nothing. A mechanism that writes
 * rows when no experiment exists is paid for by everyone and benefits no one.
 */
test("trial: a run outside a trial writes no trial rows at all", async () => {
  const { domain, skill } = await scene();
  const project = `proj-${randomUUID()}`;
  const task = `task-${randomUUID()}`;
  await recordSkillUses(domain, {
    project_id: project, task_id: task, wedge: WEDGE, skills: [{ name: skill("a") }],
  });
  await recordDeliverableVerdict(domain, { project_id: project, task_id: task, verdict: "released" });

  const arms = await trialArms(domain, { project_id: project });
  assert.deepEqual(arms.incumbent, { decisions: 0, released: 0, paid: 0 });
  assert.deepEqual(arms.challenger, { decisions: 0, released: 0, paid: 0 });
});

/** An edited draft is a decision that did NOT go out untouched. It must land in the denominator. */
test("trial: an edited draft counts against the arm that produced it", async () => {
  const { domain, skill } = await scene();
  const project = `proj-${randomUUID()}`;
  for (const [n, verdict] of [["t1", "released"], ["t2", "edited"], ["t3", "sent_back"]] as const) {
    const task = `task-${n}-${randomUUID()}`;
    await recordSkillUses(domain, {
      project_id: project, task_id: task, wedge: WEDGE, skills: [{ name: skill(n) }], arm: "challenger",
    });
    await recordDeliverableVerdict(domain, { project_id: project, task_id: task, verdict });
  }
  const arms = await trialArms(domain, { project_id: project });
  assert.equal(arms.challenger.decisions, 3);
  assert.equal(arms.challenger.released, 1);
});
