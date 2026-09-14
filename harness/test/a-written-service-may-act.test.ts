import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { awaitApproval } from "../src/approvals";
import { getAuthoredStore } from "../src/authored";
import { resetPolicyCounters } from "../src/policy";
import { InMemoryStore } from "../src/store";
import { AUTHORED_SLUG_PREFIX } from "../src/wedge";
import type { WedgeManifest } from "../src/wedge";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE ALLOWANCE A WRITTEN SERVICE IS CLAMPED TO, APPLIED — AND STILL CLAMPED WHEN IT IS
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `repairAuthoredManifest` sanitises a written service's `auto_approve` on every load, with a whole
 * file of tests behind the clamping. Nothing ever read the result. `awaitApproval` resolved the
 * manifest with `loadWedge`, which refuses an authored slug by design — correctly, it is the tenancy
 * gate — so `evaluatePolicy` was handed `undefined` and answered "human gate applies" for EVERY
 * action of EVERY written service, for ever.
 *
 * That silently reversed a decision the founder made explicitly, recorded in `wedgeauthor.ts`: *"a
 * business that asks permission for everything on day one is a gate the founder learns to stop
 * reading, which kills the gate for the sends that matter."* And `approvals.ts` carries the
 * measurement of what an unread gate costs — 195 of 196 production approvals expired.
 *
 * So these are the two halves, and neither is safe without the other: the allowance HAPPENS, and it
 * is still the clamped one when it does.
 */

const RUN = randomUUID().slice(0, 8);

/** A promoted written service whose manifest asks for whatever `policy` is handed in. */
async function writeService(projectId: string, policy: unknown): Promise<string> {
  const slug = `${AUTHORED_SLUG_PREFIX}svc-${RUN}-${Math.random().toString(36).slice(2, 7)}`;
  const store = getAuthoredStore();
  await store.createDraft({
    project_id: projectId,
    slug,
    title: "A service we wrote",
    described_as: "something this founder sells that the catalogue does not cover",
    manifest: { wedge: slug, title: "A service we wrote", policy } as unknown as WedgeManifest,
    skills: [],
    knowledge: [],
  });
  // Only a PROMOTED service loads at all — the founder agreeing to run it is what makes it real.
  await store.decide(projectId, slug, "promoted", "founder@test.co");
  return slug;
}

let seq = 0;
/** A whole `Task`, because `createTask` stores what it is given and `taskClientId` reads `actor`. */
function task(slug: string, projectId?: string) {
  const at = new Date().toISOString();
  return {
    id: `t-${RUN}-${++seq}`,
    ...(projectId ? { project_id: projectId } : {}),
    wedge: slug,
    task_type: "do_the_thing",
    actor: { kind: "system", id: "test" },
    input: {},
    constraints: { max_runtime_s: 60, max_cost_usd: 1, approval_required: false },
    tools: [],
    status: "running",
    cost_usd: 0,
    created_at: at,
    updated_at: at,
  } as never;
}

/**
 * Ask for the decision and report which of the two branches it took — WITHOUT waiting for the gated
 * one to finish.
 *
 * The gated branch blocks until a person decides or the TTL fires, and both of its timers are
 * `unref`ed on purpose (a kernel restart must not hold the process open for a three-day approval).
 * In a test nothing else holds the loop, so awaiting it gives "promise resolution is still pending
 * but the event loop has already resolved" rather than an answer.
 *
 * What the gate actually does before it blocks is observable and is the thing worth asserting: the
 * task goes to `awaiting_approval` and the row stays `pending`. So the promise is left running and
 * the STATE is read — which is also closer to what a founder sees.
 */
async function decide(
  slug: string,
  projectId: string | undefined,
  action: string,
): Promise<"auto_approved" | "gated"> {
  const store = new InMemoryStore();
  const row = await store.createTask(task(slug, projectId));
  let settled: string | undefined;
  void awaitApproval(store, row.id, { action, risk: "low", preview: { why: "routine" } })
    .then((o) => { settled = o.decision; })
    .catch(() => { settled = "error"; });
  // A REF'd timer, so the loop stays alive long enough for the branch to be taken. The auto path is
  // a handful of awaits; the gated path has set the status by the time it starts waiting.
  await new Promise((r) => setTimeout(r, 60));
  if (settled === "auto_approved") return "auto_approved";
  assert.equal((await store.getTask(row.id))?.status, "awaiting_approval", "the gate should be open and waiting");
  return "gated";
}

test("a written service's clamped allowance actually lets its own action through", async () => {
  resetPolicyCounters();
  const project = `p-${RUN}-ok`;
  const slug = await writeService(project, { auto_approve: [{ action: "email:send_update", max_per_day: 5 }] });
  assert.equal(
    await decide(slug, project, "email:send_update"),
    "auto_approved",
    "the allowance the sanitiser preserved must apply",
  );
});

test("an action the service did not declare still waits for a person", async () => {
  resetPolicyCounters();
  const project = `p-${RUN}-other`;
  const slug = await writeService(project, { auto_approve: [{ action: "email:send_update", max_per_day: 5 }] });
  assert.equal(await decide(slug, project, "stripe:refund"), "gated");
});

test("a wildcard is still refused at the moment it would be USED, not only when it was written", async () => {
  resetPolicyCounters();
  const project = `p-${RUN}-star`;
  /*
    THE PROPERTY THAT MAKES EVALUATING AN AUTHORED ENVELOPE SAFE AT ALL.

    The author of these rules is a model, and it is the thing being granted. If the clamp only ran at
    authoring time, then a row written before the sanitiser existed — or edited in the database, or
    restored from an old backup — would carry a wildcard that this path would now honour. This test
    writes exactly that row, straight into the store, bypassing every authoring check.

    `toLoaded` runs `repairAuthoredManifest` on EVERY LOAD, so the wildcard is gone by the time
    anything reads it. That is the guarantee, and it does not depend on history.
  */
  const slug = await writeService(project, { auto_approve: [{ action: "*", max_per_day: 999 }] });
  assert.equal(await decide(slug, project, "stripe:refund"), "gated", "a stored wildcard must not become authority on read");
  assert.equal(await decide(slug, project, "email:send_update"), "gated");
});

test("a money rule stored on a written service is not authority over money", async () => {
  resetPolicyCounters();
  const project = `p-${RUN}-money`;
  // `sanitiseAuthoredPolicy` drops a rule with `max_amount_usd` WHOLE — "auto-approve up to $X" is
  // autonomy nobody demonstrated. Same argument: it has to hold on read, not on write.
  const slug = await writeService(project, { auto_approve: [{ action: "stripe:refund", max_per_day: 2, max_amount_usd: 10 }] });
  assert.equal(await decide(slug, project, "stripe:refund"), "gated");
});

test("a task with no project gets no envelope at all", async () => {
  resetPolicyCounters();
  const project = `p-${RUN}-noproj`;
  const slug = await writeService(project, { auto_approve: [{ action: "email:send_update", max_per_day: 5 }] });
  // No `project_id`. `loadProjectWedge` throws rather than guess a tenant, and an approval path is
  // not where that should be discovered — so the answer is the human gate.
  assert.equal(await decide(slug, undefined, "email:send_update"), "gated");
});
