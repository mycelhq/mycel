// THE BUG: the product promised an approval and created none.
//
// Observed in production on 2026-08-10. A `chase_invoice` run completed and the founder was told
// "the draft will be waiting for you in Approvals before anything leaves". The `approvals` table
// held ZERO ROWS — not zero for that task, zero account-wide, ever. Nothing was sent. The $4,800
// invoice stayed unpaid, and because `startChase` stamps `last_chased_at` to win its claim 37ms
// before the task row even exists, the move vanished from the ranked list for three days.
//
// So: a promise, unkept, reported as success, with the retry affordance deleted on the way out.
//
// Every test below names one link in that chain and fails if the link is restored. Each was
// mutation-checked by reverting its fix.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  assertSendPromiseKept,
  clearClaimReleases,
  excusedFrom,
  gateReached,
  parseRunOutput,
  readPromises,
  registerClaimRelease,
  releaseClaimFor,
} from "../src/promises";
import type { Task, TaskEvent } from "../src/contract";
import { _resetBilling, getBillingStore } from "../src/billing";
import { releaseChaseClaim, setChaseDeps, startChase, sweepOverdueInvoices } from "../src/dunning";
import { api, connectMailbox, freshProjectId, makeApp, waitTask } from "./helpers";
import { getDomainStore } from "../src/domain";

// The wedges on disk, located from THIS file rather than from `process.cwd()`. `wedgesDir()`
// resolves against the cwd, which is the harness package under `npm test` and the repo root under
// a bare `node --test` — a path that depends on how you invoked the suite is a test that passes on
// one machine.
const WEDGES = fileURLToPath(new URL("../../wedges/", import.meta.url));
const wedgeFile = (...parts: string[]) => WEDGES + parts.join("/");

const CHASE_PROMISE = readPromises({ send: { unless: { step: ["hold"], channel: ["none"] } } });

/** The run that failed in production: a perfectly valid final notice, and nothing else. */
const FINAL_NOTICE = JSON.stringify({
  step: "final_notice",
  channel: "email",
  message: "Invoice INV-0001 for $4,800 remains outstanding.",
  reasoning: "40 days overdue.",
});

const ev = (type: TaskEvent["type"]): Pick<TaskEvent, "type"> => ({ type });

/**
 * Put the real registrations back after a test has emptied the registry.
 *
 * The registry is process-wide by design — whoever takes a claim registers the undo at module load,
 * so the orchestrator never has to know which task types take one. That makes `clearClaimReleases`
 * a destructive seam: a test that empties it and walks away silently disarms the release for every
 * test after it in the file, and the END TO END case below would then pass on a bug. Restore, always.
 */
function restoreRealReleases() {
  clearClaimReleases();
  registerClaimRelease("chase_invoice", (task) => releaseChaseClaim(task));
}

// ── link 3: nothing in the kernel ever checked ───────────────────────────────────────────────────

test("a run that drafted a chase and never asked to send it is FAILED, not succeeded", () => {
  // THE BUG, exactly. `validateOutput` checks that the model produced the right SHAPE, and the
  // production output passes it perfectly while having done nothing at all. The events below are
  // the real 35-event trace for task b2b2dd66, reduced to the types that matter: no approval, ever.
  assert.throws(
    () =>
      assertSendPromiseKept({
        promised: CHASE_PROMISE,
        output: FINAL_NOTICE,
        events: [ev("task.created"), ev("tool.called"), ev("output.validated"), ev("artifact.created")],
      }),
    /never asked to send it/,
    "a chase that created no approval was allowed to report success",
  );
});

test("the refusal explains it to a founder without naming any machinery", () => {
  // A failure sentence that says "assertSendPromiseKept threw" is a failure the founder cannot act
  // on. The same rule narration.ts enforces on the screens, applied to the reason on the row.
  let message = "";
  try {
    assertSendPromiseKept({ promised: CHASE_PROMISE, output: FINAL_NOTICE, events: [] });
  } catch (e) {
    message = String((e as Error).message);
  }
  assert.match(message, /your client has heard nothing/);
  for (const word of ["wedge", "kernel", "harness", "provision", "approval gate", "action proxy"]) {
    assert.ok(!message.toLowerCase().includes(word), `the founder was told about "${word}"`);
  }
});

test("a run that reached the human gate succeeds, and says what is waiting", () => {
  const kept = assertSendPromiseKept({
    promised: CHASE_PROMISE,
    output: FINAL_NOTICE,
    events: [ev("task.created"), ev("approval.requested"), ev("approval.resolved")],
  });
  assert.equal(kept.kept, true);
  assert.match(kept.kept ? kept.note : "", /waiting for your approval/);
});

test("an AUTO-APPROVED send counts as reaching the gate", () => {
  // THE BUG THIS PREVENTS: counting only pending approvals. A send a wedge envelope or a standing
  // grant allowed emits `approval.resolved` and never `approval.requested` — it is never a pending
  // row anybody can click. Requiring the pending event would fail exactly the runs that behaved
  // correctly and autonomously, and would push the next person to debug it toward switching the
  // envelope off. Both settlement paths are evidence that `awaitApproval` was reached.
  assert.equal(gateReached([ev("approval.resolved")]), true);
  assert.equal(gateReached([ev("task.created"), ev("tool.result")]), false);
  const kept = assertSendPromiseKept({
    promised: CHASE_PROMISE,
    output: FINAL_NOTICE,
    events: [ev("approval.resolved")],
  });
  assert.equal(kept.kept, true);
});

test("a run that legitimately decided to say nothing is excused, and only by its own output", () => {
  // `hold` is the ladder's real answer for an invoice inside its 48h window or one whose client has
  // promised a date. Failing those would make the check unusable, and a check people switch off
  // protects nothing.
  for (const output of [
    JSON.stringify({ step: "hold", channel: "email", message: "" }),
    JSON.stringify({ step: "reminder", channel: "none", message: "no mailbox connected" }),
    // Case is not the model's to get right.
    JSON.stringify({ step: "HOLD", channel: "email", message: "" }),
  ]) {
    const kept = assertSendPromiseKept({ promised: CHASE_PROMISE, output, events: [] });
    assert.equal(kept.kept, true, `a legitimate stand-down was failed: ${output}`);
  }
});

test("unreadable output is NOT an excuse", () => {
  // The swallow this whole module exists to close. "We could not read what it decided" must never
  // resolve to "it decided to do nothing" — that is the failure reporting success, one level up.
  assert.throws(
    () => assertSendPromiseKept({ promised: CHASE_PROMISE, output: "I have queued this for you.", events: [] }),
    /never asked to send it/,
  );
  assert.equal(excusedFrom({ unless: { step: ["hold"] } }, null), undefined);
  assert.equal(parseRunOutput("not json at all"), null);
  // Fenced JSON is what a model actually emits most of the time.
  assert.equal(parseRunOutput('```json\n{"step":"hold"}\n```')?.step, "hold");
});

test("a task type that promises nothing is unchanged", () => {
  // The additive contract. Every task type in the repo except `chase_invoice` declares no promise,
  // and a check that quietly started failing them would be a far more expensive bug than the one it
  // was written for.
  assert.equal(assertSendPromiseKept({ promised: undefined, output: FINAL_NOTICE, events: [] }).kept, false);
  assert.equal(readPromises(undefined), undefined);
  assert.equal(readPromises({ send: "yes" }), undefined);
  assert.equal(readPromises("send"), undefined);
  // A malformed `unless` degrades to "always owed", not to "never checked".
  assert.deepEqual(readPromises({ send: { unless: { step: 7 } } }), { send: {} });
});

// ── link 4: the claim is a loan, and a failed run gives it back ──────────────────────────────────

test("a failed run releases the claim it was holding, and the orchestrator stays general", async () => {
  // THE BUG: `last_chased_at` stamped before the work, never revisited. The registry is the shape
  // that matters here — the alternative was `if (task.task_type === "chase_invoice")` inside
  // `runTask`, which leaves the kernel holding a list of the task types it happens to know about.
  clearClaimReleases();
  const task = { id: "t1", task_type: "chase_invoice" } as Task;
  assert.equal(await releaseClaimFor(task), undefined, "an unregistered task type released something");

  let released = 0;
  registerClaimRelease("chase_invoice", async () => {
    released++;
    return "put back on your list";
  });
  assert.equal(await releaseClaimFor(task), "put back on your list");
  assert.equal(released, 1);
  assert.equal(await releaseClaimFor({ id: "t2", task_type: "monthly_close" } as Task), undefined);
  restoreRealReleases();
});

test("a release that throws does not replace the real failure reason", async () => {
  // It runs inside the orchestrator's catch. Something has already gone wrong and the founder needs
  // to read THAT, not a second error from the cleanup.
  restoreRealReleases();
  registerClaimRelease("chase_invoice", async () => {
    throw new Error("the database is unreachable");
  });
  assert.equal(await releaseClaimFor({ id: "t3", task_type: "chase_invoice" } as Task), undefined);
  restoreRealReleases();
});

// ── links 1 and 2: the wedge must ask, and must declare that it will ─────────────────────────────

test("the invoice chaser declares its promise", async () => {
  // Pins the manifest half of the fix against a revert.
  const raw = await readFile(wedgeFile("invoice-chaser", "wedge.json"), "utf8");
  const manifest = JSON.parse(raw) as { task_types?: Record<string, { promises?: unknown }> };
  const promised = readPromises(manifest.task_types?.chase_invoice?.promises);
  assert.ok(promised?.send, "chase_invoice no longer promises to reach a human before it succeeds");
  assert.deepEqual(promised.send.unless?.step, ["hold"]);
  assert.deepEqual(promised.send.unless?.channel, ["none"]);
});

test("the chase skill instructs the send unconditionally", async () => {
  // THE BUG, at its root. The skill read "Only when instructed to actually send/charge — use the
  // action proxy", and nothing in the prompt, the input or the schema ever instructed. So the agent
  // drafted, replied JSON, and the run reported success having asked nobody anything.
  const skill = await readFile(wedgeFile("invoice-chaser", "skills", "chase-politely.md"), "utf8");
  assert.ok(
    !/only when instructed/i.test(skill),
    "the chase skill again gates its send on an instruction that is never given",
  );
  assert.match(skill, /MUST request the send/i);
  assert.match(skill, /\$MYCEL_ACTIONS_URL\/send_email/);
});

// ── link 1: a chase that cannot be sent must not start, and must not burn the claim ──────────────

test("a business with no mailbox is refused BEFORE the invoice is claimed", async () => {
  // THE BUG, at its origin. Production project 3dd801ba had ZERO connection rows. So
  // `capabilityConnections` resolved `send_email` to nothing, `runOpenCodeTask` never printed its
  // "Taking real-world actions" block, and the agent was never told a send was possible. It drafted,
  // the output validated, the run succeeded — and `last_chased_at` had already been stamped 37ms
  // before the task row existed, which is what removed a $4,800 invoice from the ranked list.
  //
  // Both halves are asserted: the refusal, and the fact that the ladder is untouched by it. The
  // second is the one that actually hurt, and a fix that refused AFTER claiming would still ship it.
  _resetBilling();
  let spawned = 0;
  setChaseDeps({
    wedgeEnabled: () => true,
    spawnTask: async () => `t-${++spawned}`,
    attachInvoiceDocument: async () => ({}),
  });
  const project = freshProjectId("nomail");
  const inv = await getBillingStore().createInvoice({
    project_id: project, client_id: "c1", currency: "USD", status: "sent",
    due_date: "2020-01-01", issue_date: "2019-12-01", number: "INV-0001",
    lines: [{ id: "l1", description: "work", kind: "fixed", quantity_milli: 1000, unit_amount: 480_000 }],
  } as never);

  const refused = await startChase(inv, { pacing: "ladder" });
  assert.equal(refused.ok, false);
  assert.equal(refused.ok ? "" : refused.reason, "cannot_send");
  assert.match(refused.ok ? "" : refused.message, /no mailbox connected/);
  assert.equal(spawned, 0, "a run was spawned for a business that cannot send anything");
  assert.equal(
    (await getBillingStore().getInvoice(inv.id))!.last_chased_at,
    undefined,
    "the invoice was marked chased by a chase that never happened — this is the bug",
  );

  // And with a mailbox, the very same invoice chases.
  await connectMailbox(project);
  const started = await startChase(inv, { pacing: "ladder" });
  assert.equal(started.ok, true, started.ok ? "" : started.message);
  assert.equal(spawned, 1);
  setChaseDeps(null);
});

test("a sweep that cannot send counts it, and never reports an empty sweep as a clean one", async () => {
  // `skipped` is what a paid invoice increments. A business with no mailbox and eleven overdue
  // invoices swept to `skipped: 11` and looked identical to a business that owed nothing — the
  // failure-reporting-success shape, on the sweep summary.
  _resetBilling();
  setChaseDeps({ wedgeEnabled: () => true, spawnTask: async () => "t", attachInvoiceDocument: async () => ({}) });
  const project = freshProjectId("sweep-nomail");
  await getBillingStore().createInvoice({
    project_id: project, client_id: "c1", currency: "USD", status: "sent",
    due_date: "2020-01-01", issue_date: "2019-12-01", number: "INV-9",
    lines: [{ id: "l1", description: "w", kind: "fixed", quantity_milli: 1000, unit_amount: 10_000 }],
  } as never);

  const summary = await sweepOverdueInvoices({ project_id: project });
  assert.equal(summary.cannot_send, 1);
  assert.equal(summary.skipped, 0, "a business that cannot chase was filed under 'nothing to chase'");
  assert.equal(summary.chased, 0);
  assert.match(summary.skipped_because ?? "", /no mailbox connected/);
  setChaseDeps(null);
});

test("a chase that did nothing gives the invoice back, and cannot un-chase a later one", async () => {
  // The claim is a LOAN taken to serialise four replicas, not a record that a client was contacted.
  // The compare-and-set is the whole safety of returning it: a release that ignored `claimed_at`
  // would let a stale failed run wipe the stamp of a chase that HAS gone out, and the next sweep
  // would put a second dunning email in that client's inbox.
  _resetBilling();
  const project = freshProjectId("release");
  await connectMailbox(project);
  const spawnedInputs: Record<string, unknown>[] = [];
  setChaseDeps({
    wedgeEnabled: () => true,
    spawnTask: async (a) => { spawnedInputs.push(a.input); return "t-1"; },
    attachInvoiceDocument: async () => ({}),
  });
  const billing = getBillingStore();
  const inv = await billing.createInvoice({
    project_id: project, client_id: "c1", currency: "USD", status: "sent",
    due_date: "2020-01-01", issue_date: "2019-12-01", number: "INV-7",
    lines: [{ id: "l1", description: "w", kind: "fixed", quantity_milli: 1000, unit_amount: 480_000 }],
  } as never);

  assert.equal((await startChase(inv, { pacing: "ladder" })).ok, true);
  const claimed = (await billing.getInvoice(inv.id))!.last_chased_at;
  assert.ok(claimed, "the claim must be stamped — that is what stops four replicas racing");

  const task = { id: "t-1", task_type: "chase_invoice", input: spawnedInputs[0] } as Task;

  // Somebody else re-stamps the row (a founder clicking Chase, the next sweep, another replica).
  await billing.claimInvoiceForChase(inv.id, new Date().toISOString(), "2030-01-01T00:00:00.000Z");
  assert.equal(await releaseChaseClaim(task), undefined, "a stale run released a chase it did not own");
  assert.equal((await billing.getInvoice(inv.id))!.last_chased_at, "2030-01-01T00:00:00.000Z");

  // Put it back the way this run left it, then release for real.
  await billing.claimInvoiceForChase(inv.id, "2031-01-01T00:00:00.000Z", claimed!);
  assert.match((await releaseChaseClaim(task)) ?? "", /back on your list/);
  assert.equal(
    (await billing.getInvoice(inv.id))!.last_chased_at,
    undefined,
    "an invoice nobody chased is still marked as chased",
  );
  setChaseDeps(null);
});

// ── end to end: the whole chain, through the real orchestrator ───────────────────────────────────

test("END TO END: a chase that never asks is failed, and the invoice comes back on the list", async () => {
  // THE PRODUCTION RUN, REPRODUCED, then fixed. Under the mock runtime the agent draft-and-stops
  // exactly as the real one did on 2026-08-10: the canned output picks the first enum value, so it
  // reports `{step: "reminder", channel: "email", …}` — a schema-perfect chase — and calls no action
  // proxy, so `awaitApproval` is never reached and no approval row is written.
  //
  // Before this change that run ended `succeeded` with the invoice stamped as chased. Both halves
  // are asserted here because both halves are the bug: the founder was told it worked, AND the only
  // affordance to try again was deleted.
  _resetBilling();
  const { store, app } = makeApp();
  const project = (await api(app, "me")).json.projects[0].id as string;
  await connectMailbox(project);
  const client = await getDomainStore().createClient({
    project_id: project, display_name: "Rowan & Fell", handles: ["ap@rowanfell.example"], metadata: {},
  });
  const inv = await getBillingStore().createInvoice({
    project_id: project, client_id: client.id, currency: "USD", status: "sent",
    due_date: "2026-07-01", issue_date: "2026-06-01", number: "INV-0001",
    // The real invoice: $4,800, integer minor units, nothing divides by 100.
    lines: [{ id: "l1", description: "March close", kind: "fixed", quantity_milli: 1000, unit_amount: 480_000 }],
  } as never);

  const chase = await api(app, `invoices/${inv.id}/chase`, { method: "POST" });
  assert.equal(chase.status, 201, chase.text);
  const taskId = chase.json.task_id as string;
  await waitTask(app, taskId, 10_000);

  const task = await store.getTask(taskId);
  assert.equal(task!.status, "failed", "a chase that asked nobody anything reported success");
  assert.match(task!.error ?? "", /never asked to send it/);

  // The founder's own feed says it, rather than leaving them to infer it from a status word.
  const events = await store.eventsAfter(taskId, 0);
  assert.ok(!events.some((e) => e.type === "approval.requested"), "the premise of this test is gone");
  assert.ok(
    events.some((e) => e.type === "progress" && /back on your list/.test(String(e.data?.note ?? ""))),
    "the founder was not told the invoice had been put back",
  );

  // And THE HALF THAT ACTUALLY HURT: the ladder is where it was, so `chaseMove` proposes it again.
  assert.equal(
    (await getBillingStore().getInvoice(inv.id))!.last_chased_at,
    undefined,
    "a $4,800 unpaid invoice is still marked as chased by a chase that never happened",
  );
});
