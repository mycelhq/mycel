// Work that waits — the tests that make "never double-invoiced" a property rather than an intention.
//
// Every test here names the bug it prevents, because each one is a bug that does not announce
// itself: a wait that resumes twice sends a second invoice, a wait that never expires is an
// engagement that silently stops existing, and a wait that resumes on another tenant's paid invoice
// is a cross-tenant action with a fortnight-long fuse. None of those show up as a failed run.
import { getDeliverableStore } from "../src/deliverables";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { api, makeFreshApp } from "./helpers";
import { getDomainStore } from "../src/domain";
import { getBillingStore } from "../src/billing";
import { getRequestStore } from "../src/requests";
import { registerActionGrant } from "../src/actiongrants";
import { loadWedge } from "../src/wedge";
import { setNudgeDeps, sweepOpenRequests } from "../src/nudges";
import {
  MAX_REARMS,
  MAX_WAIT_DAYS,
  REARM_STUCK_AFTER_MINUTES,
  armWait,
  evaluateWait,
  rearmWait,
  resumeInput,
  resumeWait,
  setWaitDeps,
  sweepWaits,
  validateCondition,
} from "../src/waits";
import { proposeMoves, founderMoveAuthority } from "../src/moves";

const WEDGE = "books-keeper";
const RESUME_TYPE = "monthly_close"; // declared by the books-keeper manifest
const DAY = 86_400_000;

/**
 * Advance the wall clock past one millisecond.
 *
 * `client_reply` is satisfied by an inbound message STRICTLY AFTER `wait.created_at`, and ISO
 * timestamps have millisecond resolution — so a test that arms a wait and posts the reply in the
 * same tick writes both at the same instant and the `>` is false. That is a test artefact and not a
 * product bug (a real client does not reply inside the same millisecond), but without this the
 * suite would "prove" that replies never satisfy waits.
 */
const tick = () => new Promise((r) => setTimeout(r, 2));

/**
 * A project, a client and an open case — the minimum an engagement needs before it can wait.
 *
 * `makeFreshApp`, not `makeApp`, and that is load-bearing rather than tidy. The domain store is a
 * process-wide singleton, so with `makeApp` every test in this file shares one waits table — and
 * almost every assertion here is a COUNT (`resumed`, `considered`, `spawned.length`). A leaked wait
 * from the test above turns "resumed exactly once" into "resumed once, plus whatever else was
 * lying around", which passes and proves nothing.
 */
async function engagement(title = "Acme — October close") {
  const { app, store } = await makeFreshApp();
  const me = (await api(app, "me")).json;
  const projectId = me.projects[0].id as string;
  const client = (
    await api(app, "clients", { method: "POST", body: JSON.stringify({ display_name: "Acme", handles: [`acme-${randomUUID()}@x.test`] }) })
  ).json;
  const kase = (
    await api(app, "cases", { method: "POST", body: JSON.stringify({ wedge: WEDGE, title, client_id: client.id }) })
  ).json;
  return { app, store, projectId, client, kase, domain: getDomainStore() };
}

/**
 * The spawn half of `WaitDeps`, recording instead of running.
 *
 * `createServer` registers the real one, so these override it per-test and put it back. The count of
 * calls IS the exactly-once assertion in half the tests below.
 */
function recordingDeps(opts: { enabled?: boolean; throws?: boolean } = {}) {
  const spawned: { project_id: string; task_type: string; case_id?: string; input: Record<string, unknown> }[] = [];
  setWaitDeps({
    wedgeEnabled: () => opts.enabled ?? true,
    spawnTask: async (args) => {
      if (opts.throws) throw new Error("queue is down");
      spawned.push(args);
      return `task-${spawned.length}`;
    },
  });
  return spawned;
}

// ── arming ───────────────────────────────────────────────────────────────────────────────────────

test("waits: a wait must name a condition, a reason and something to resume", async () => {
  // Each refusal here is a wait that would otherwise sit in the table doing nothing observable. A
  // wait with no `resume.task_type` is the worst of them: it looks healthy on every list, satisfies
  // one day, and then has nothing to spawn.
  const { domain, projectId, kase } = await engagement();
  const good = { kind: "date", at: new Date(Date.now() + DAY).toISOString() } as const;

  assert.equal(validateCondition({ kind: "client_reply" }), "client_reply requires a thread_id");
  assert.equal(validateCondition({ kind: "date", at: "not-a-date" }), "date `at` is not a timestamp");
  assert.match(String(validateCondition({ kind: "vibes" })), /unknown wait condition/);
  assert.equal(validateCondition(good), null);

  const base = { project_id: projectId, case_id: kase.id, reason: "r", condition: good, resume: { task_type: RESUME_TYPE } };
  assert.equal((await armWait(domain, { ...base, project_id: "" } as never)).ok, false, "an unscoped wait is refused");
  assert.equal((await armWait(domain, { ...base, reason: "  " })).ok, false, "a reason a founder can read is required");
  assert.equal((await armWait(domain, { ...base, resume: { task_type: "" } })).ok, false, "a wait with no resume is a dead end");
  assert.equal((await armWait(domain, { ...base, condition: { kind: "invoice_paid" } as never })).ok, false);
  assert.equal((await armWait(domain, base)).ok, true);
});

test("waits: a wait is armed under the CASE's project, and another tenant's case is not found", async () => {
  // The motivating failure: `project_id` on the wait row decides whose connections the resumed run
  // reaches. A wait armed under the wrong project is a cross-tenant send with a delay fuse on it —
  // and unlike a normal leak it fires days later, when nobody is watching the request that caused it.
  const { domain, projectId, kase } = await engagement();
  const cond = { kind: "date", at: new Date(Date.now() + DAY).toISOString() } as const;

  const foreign = await armWait(domain, {
    project_id: `p-${randomUUID()}`,
    case_id: kase.id,
    reason: "someone else's engagement",
    condition: cond,
    resume: { task_type: RESUME_TYPE },
  });
  assert.deepEqual(foreign, { ok: false, error: "not found" }, "a real case under the wrong tenant is simply not found");

  const armed = await armWait(domain, { project_id: projectId, case_id: kase.id, reason: "ok", condition: cond, resume: { task_type: RESUME_TYPE } });
  assert.equal(armed.ok, true);
  assert.equal(armed.ok && armed.wait.project_id, projectId);

  // And the read side is scoped too: the same wait id under another tenant does not exist.
  const id = armed.ok ? armed.wait.id : "";
  assert.ok(await domain.getWait(projectId, id));
  assert.equal(await domain.getWait(`p-${randomUUID()}`, id), undefined, "no cross-tenant read of a wait");
  assert.deepEqual(await domain.listWaits({ project_id: `p-${randomUUID()}` }), [], "listWaits is sealed by project");
});

test("waits: one live wait per case, and a closed case cannot wait on anything", async () => {
  // Two live waits on one case is two resumes racing to advance the same stage — the double-invoice
  // bug arriving from inside the house rather than from a client replying twice.
  const { app, domain, projectId, kase } = await engagement();
  const cond = { kind: "date", at: new Date(Date.now() + DAY).toISOString() } as const;
  const arm = () => armWait(domain, { project_id: projectId, case_id: kase.id, reason: "first", condition: cond, resume: { task_type: RESUME_TYPE } });

  assert.equal((await arm()).ok, true);
  const second = await arm();
  assert.equal(second.ok, false);
  assert.match(second.ok === false ? second.error : "", /already waiting/);

  // The route turns exactly that into a 409 rather than a 500 — the caller asked for something the
  // model forbids, and is owed the difference.
  const viaRoute = await api(app, `cases/${kase.id}/wait`, {
    method: "POST",
    body: JSON.stringify({ reason: "third", condition: cond, resume: { task_type: RESUME_TYPE } }),
  });
  assert.equal(viaRoute.status, 409);

  await api(app, `cases/${kase.id}`, { method: "PUT", body: JSON.stringify({ status: "closed" }) });
  const onClosed = await armWait(domain, {
    project_id: projectId, case_id: kase.id, reason: "x", condition: cond, resume: { task_type: RESUME_TYPE },
  });
  assert.equal(onClosed.ok, false);
});

test("waits: an unknown resume task_type is refused at the ROUTE, when a human can still fix it", async () => {
  // A resume that spawns a task type no wedge declares produces a run with no output schema, no
  // policy and no knowledge — a fortnight later. Failing at arm time puts the error in front of the
  // person who wrote it.
  const { app, kase } = await engagement();
  const res = await api(app, `cases/${kase.id}/wait`, {
    method: "POST",
    body: JSON.stringify({
      reason: "waiting on scope",
      condition: { kind: "date", at: new Date(Date.now() + DAY).toISOString() },
      resume: { task_type: "no_such_task" },
    }),
  });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /unknown task_type/);
});

test("waits: arming defaults an expiry, so no wait can outlive the cap", async () => {
  // A wait with no expiry is an engagement that silently stops existing: never on anyone's list,
  // and the client is never told the ball is in their court.
  const { domain, projectId, kase } = await engagement();
  const now = new Date("2026-01-01T00:00:00.000Z");
  const armed = await armWait(
    domain,
    {
      project_id: projectId, case_id: kase.id, reason: "no expiry given",
      condition: { kind: "date", at: "2030-01-01T00:00:00.000Z" },
      resume: { task_type: RESUME_TYPE },
      expires_at: "2099-01-01T00:00:00.000Z", // a caller asking for forever
    },
    now,
  );
  assert.ok(armed.ok);
  const capped = new Date(now.getTime() + MAX_WAIT_DAYS * DAY).toISOString();
  assert.equal(armed.ok && armed.wait.expires_at, capped, "a caller cannot ask for longer than the cap");

  // And the pause is on the case's own timeline, not only in a table nobody opens.
  const kase2 = await domain.getCase(kase.id);
  assert.ok(kase2!.history.some((h) => h.note?.includes("waiting: no expiry given")), "the founder can read the pause where it happened");
});

// ── evaluation, over signals that already exist ──────────────────────────────────────────────────

test("waits: a client_reply is only satisfied by a message that arrived AFTER we started waiting", async () => {
  // Without the strict `>`, the wait is satisfied by the client's own last message — the very one we
  // were answering when we decided to wait — so every client_reply wait resumes on the first sweep
  // and nothing ever actually waits.
  const { domain, projectId, kase, client } = await engagement();
  const channel = await domain.createChannel({ project_id: projectId, kind: "email", name: "inbox", config: {} } as never);
  const thread = await domain.createThread({ project_id: projectId, client_id: client.id, channel_id: channel.id, case_id: kase.id, status: "open" } as never);
  await domain.addMessage({ thread_id: thread.id, direction: "inbound", author: client.id, body: "the question we were answering" } as never);

  await tick();
  const armed = await armWait(domain, {
    project_id: projectId, case_id: kase.id, reason: "waiting on Acme to confirm the scope",
    condition: { kind: "client_reply", thread_id: thread.id }, resume: { task_type: RESUME_TYPE },
  });
  assert.ok(armed.ok);
  const wait = armed.ok ? armed.wait : null!;

  assert.equal((await evaluateWait(domain, wait)).state, "pending", "the message we were replying to does not satisfy the wait");

  // Our own outbound reply is not satisfaction either — otherwise the kernel satisfies its own wait.
  await domain.addMessage({ thread_id: thread.id, direction: "outbound", author: "agent", body: "here is the scope" } as never);
  assert.equal((await evaluateWait(domain, wait)).state, "pending", "we cannot answer on the client's behalf");

  await tick();
  const reply = await domain.addMessage({ thread_id: thread.id, direction: "inbound", author: client.id, body: "confirmed" } as never);
  assert.deepEqual(await evaluateWait(domain, wait), { state: "satisfied", by: `message:${reply.id}`, index: 0, newly_satisfied: [] });
});

test("waits: an invoice or thread belonging to another tenant is UNRESOLVABLE, never satisfaction", async () => {
  // The leak this closes: `getInvoice` takes no project, so a wait naming a foreign invoice id would
  // read a row it has no right to and resume this founder's engagement off another founder's
  // payment. `evaluateWait` re-checks the tenant on every read for exactly this.
  const { domain, projectId, kase } = await engagement();
  const theirs = `p-${randomUUID()}`;
  const foreignInvoice = await getBillingStore().createInvoice({
    project_id: theirs, client_id: `c-${randomUUID()}`, currency: "USD",
    lines: [{ description: "their work", kind: "fixed", amount: 100_00 }],
    status: "paid", issue_date: "2026-01-01", due_date: "2026-01-15",
  } as never);

  const armed = await armWait(domain, {
    project_id: projectId, case_id: kase.id, reason: "waiting on payment",
    condition: { kind: "invoice_paid", invoice_id: foreignInvoice.id }, resume: { task_type: RESUME_TYPE },
  });
  assert.ok(armed.ok);
  const verdict = await evaluateWait(domain, armed.ok ? armed.wait : null!);
  assert.equal(verdict.state, "unresolvable", "a PAID invoice in another project does NOT resume us");
  assert.notEqual(verdict.state, "satisfied");
});

test("waits: a condition that can never come true fails CLOSED and loudly, it does not hang", async () => {
  // A withdrawn request and a voided invoice are not "still pending" — the answer is never coming.
  // Leaving them pending parks the engagement until the ninety-day cap with nobody told.
  const { domain, projectId, kase, client } = await engagement();
  const requests = getRequestStore();
  const req = await requests.createRequest({
    project_id: projectId, client_id: client.id, case_id: kase.id, kind: "info", ask: "send the bank export",
  } as never);
  const armed = await armWait(domain, {
    project_id: projectId, case_id: kase.id, reason: "waiting on the export",
    condition: { kind: "request_resolved", request_id: req.id }, resume: { task_type: RESUME_TYPE },
  });
  assert.ok(armed.ok);
  const wait = armed.ok ? armed.wait : null!;
  assert.equal((await evaluateWait(domain, wait)).state, "pending");

  await requests.cancelRequest(projectId, req.id);
  const verdict = await evaluateWait(domain, wait);
  assert.equal(verdict.state, "unresolvable");

  // And the sweep turns that into a terminal, VISIBLE row plus a note on the engagement — the
  // difference between a system that stopped and one that is quietly broken.
  recordingDeps();
  const summary = await sweepWaits({ domain, project_id: projectId });
  assert.equal(summary.broken, 1);
  assert.deepEqual(summary.failed_ids, [wait.id]);
  assert.equal((await domain.getWait(projectId, wait.id))!.status, "failed");
  assert.ok((await domain.getCase(kase.id))!.history.some((h) => h.note?.includes("wait broken")));
});

// ── exactly once ─────────────────────────────────────────────────────────────────────────────────

test("waits: a wait satisfied TWICE resumes ONCE", async () => {
  // THE bug. A client replies twice — or the sweep runs twice before the first resume lands — and
  // the engagement spawns two runs, each of which raises an invoice. The claim is one conditional
  // statement, so the second evaluation finds a row that is no longer `waiting`.
  const { domain, projectId, kase, client } = await engagement();
  const channel = await domain.createChannel({ project_id: projectId, kind: "email", name: "inbox", config: {} } as never);
  const thread = await domain.createThread({ project_id: projectId, client_id: client.id, channel_id: channel.id, case_id: kase.id, status: "open" } as never);
  await armWait(domain, {
    project_id: projectId, case_id: kase.id, reason: "waiting on Acme",
    condition: { kind: "client_reply", thread_id: thread.id }, resume: { task_type: RESUME_TYPE },
  });
  await tick();
  const spawned = recordingDeps();

  await domain.addMessage({ thread_id: thread.id, direction: "inbound", author: client.id, body: "first reply" } as never);
  const one = await sweepWaits({ domain, project_id: projectId });
  assert.equal(one.resumed, 1);

  // The client replies again, and the sweep runs again. Both are the normal case, not an edge case.
  await domain.addMessage({ thread_id: thread.id, direction: "inbound", author: client.id, body: "second reply" } as never);
  const two = await sweepWaits({ domain, project_id: projectId });
  assert.equal(two.considered, 0, "the wait is no longer in the waiting pool at all");
  assert.equal(spawned.length, 1, "ONE run, not two — this is the never-double-invoiced guarantee");
});

test("waits: two replicas claiming the same wait concurrently produce exactly ONE resume", async () => {
  // The worker tier runs several replicas and they sweep the same project in the same second. Before
  // the claim, both read `waiting`, both decided it was satisfied, and both spawned.
  const { domain, projectId, kase } = await engagement();
  const armed = await armWait(domain, {
    project_id: projectId, case_id: kase.id, reason: "the date arrives",
    condition: { kind: "date", at: new Date(Date.now() - DAY).toISOString() }, resume: { task_type: RESUME_TYPE },
  });
  assert.ok(armed.ok);
  const wait = armed.ok ? armed.wait : null!;
  const spawned = recordingDeps();

  const results = await Promise.all([
    resumeWait(domain, wait, "date:a"),
    resumeWait(domain, wait, "date:b"),
    resumeWait(domain, wait, "date:c"),
  ]);
  assert.equal(results.filter((r) => r.ok).length, 1, "one winner");
  assert.equal(results.filter((r) => !r.ok && r.reason === "lost_claim").length, 2, "two losers, and they say why");
  assert.equal(spawned.length, 1, "one run reached the queue");
  assert.equal((await domain.getWait(projectId, wait.id))!.status, "resumed");
});

test("waits: two replicas sweeping concurrently resume once, and the losers are not counted as broken", async () => {
  // A `lost_claim` is the system working. Counting it as broken would make a healthy two-replica
  // deployment page somebody every five minutes, which is how alerts get muted.
  const { domain, projectId, kase } = await engagement();
  await armWait(domain, {
    project_id: projectId, case_id: kase.id, reason: "the date arrives",
    condition: { kind: "date", at: new Date(Date.now() - DAY).toISOString() }, resume: { task_type: RESUME_TYPE },
  });
  const spawned = recordingDeps();

  const [a, b] = await Promise.all([
    sweepWaits({ domain, project_id: projectId }),
    sweepWaits({ domain, project_id: projectId }),
  ]);
  assert.equal(a.resumed + b.resumed, 1);
  assert.equal(a.broken + b.broken, 0, "losing a race is not a failure");
  assert.equal(spawned.length, 1);
});

test("waits: a resume that cannot spawn ends TERMINAL, it does not return to the pool", async () => {
  // A wait that goes back to `waiting` after a failed resume is a retry loop against whatever just
  // refused it — and if the refusal came after a partial side effect, it is also a second one.
  const { domain, projectId, kase } = await engagement();
  const armed = await armWait(domain, {
    project_id: projectId, case_id: kase.id, reason: "due now",
    condition: { kind: "date", at: new Date(Date.now() - DAY).toISOString() }, resume: { task_type: RESUME_TYPE },
  });
  assert.ok(armed.ok);
  recordingDeps({ throws: true });

  const r = await resumeWait(domain, armed.ok ? armed.wait : null!, "date:x");
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.reason, "spawn_failed");
  const after = (await domain.getWait(projectId, armed.ok ? armed.wait.id : ""))!;
  assert.equal(after.status, "failed", "terminal and visible, never eligible again");
  assert.ok(after.error);
  assert.ok((await domain.getCase(kase.id))!.history.some((h) => h.note?.includes("resume failed")));

  // And it is gone from the pool, so the next sweep does not retry it.
  assert.equal((await sweepWaits({ domain, project_id: projectId })).considered, 0);
});

test("waits: nothing resumes when resumption is not wired up, and a disabled wedge does not run", async () => {
  // Fail closed on both. A kernel booted without the routes mounted has no business resuming
  // anybody's engagements, and a founder who turned a wedge off has said the business no longer does
  // that work — resuming into it would run work they have withdrawn.
  const { domain, projectId, kase } = await engagement();
  const cond = { kind: "date", at: new Date(Date.now() - DAY).toISOString() } as const;
  const armed = await armWait(domain, { project_id: projectId, case_id: kase.id, reason: "due", condition: cond, resume: { task_type: RESUME_TYPE } });
  assert.ok(armed.ok);
  const wait = armed.ok ? armed.wait : null!;

  setWaitDeps(null);
  const unwired = await resumeWait(domain, wait, "date:x");
  assert.equal(unwired.ok === false && unwired.reason, "not_configured");
  assert.equal((await domain.getWait(projectId, wait.id))!.status, "waiting", "and it is untouched, so a wired kernel picks it up");

  const spawned = recordingDeps({ enabled: false });
  const off = await resumeWait(domain, wait, "date:x");
  assert.equal(off.ok === false && off.reason, "wedge_disabled");
  assert.equal(spawned.length, 0);
});

// ── coherence ────────────────────────────────────────────────────────────────────────────────────

test("waits: a resumed run gets the FROZEN intent and the LIVE case, so it picks up rather than restarts", async () => {
  // The two halves of coherence, and each has its own failure. Lose the intent and the resumed run
  // has no idea what it was doing — the task-runner failure. Freeze the facts and it acts on a
  // fortnight-stale picture of the engagement, the most expensive version of which is re-billing
  // work that was already billed while it waited.
  const { domain, projectId, kase, client } = await engagement();
  const armed = await armWait(domain, {
    project_id: projectId, case_id: kase.id, reason: "waiting on the scope confirmation",
    condition: { kind: "date", at: new Date(Date.now() - DAY).toISOString() },
    resume: { task_type: RESUME_TYPE, input: { drafting: "statement of work", case: { stage: "STALE" } } },
  });
  assert.ok(armed.ok);

  // The engagement moves on WHILE it is parked, exactly as a real one does.
  await domain.updateCase(kase.id, { stage: "collecting", data: { invoiced: true } });

  const spawned = recordingDeps();
  const r = await resumeWait(domain, armed.ok ? armed.wait : null!, "date:x");
  assert.ok(r.ok);
  const input = spawned[0].input as Record<string, any>;

  assert.equal(input.drafting, "statement of work", "the INTENT survived the wait");
  assert.equal(input.case.stage, "collecting", "the FACTS are live, not the snapshot the caller froze");
  assert.deepEqual(input.case.data, { invoiced: true }, "including work billed while it waited");
  assert.equal(input.client_id, client.id);
  assert.equal(input.resumed_from_wait.reason, "waiting on the scope confirmation");
  assert.ok(input.resumed_from_wait.waited_since, "and the run can tell it is a resume, which is the only way it can");

  // The `case` key matches what `POST /v1/cases/:id/tasks` passes, so a wedge cannot tell a resumed
  // episode from a fresh one by SHAPE — only by `resumed_from_wait`, which exists so it can.
  const fresh = resumeInput({ ...(armed.ok ? armed.wait : null!), resume: { task_type: RESUME_TYPE, input: {} } }, (await domain.getCase(kase.id))!);
  assert.deepEqual(Object.keys(fresh).sort(), ["case", "client_id", "resumed_from_wait"]);
});

test("waits: a resume is an ordinary queued Task — no send, no invoice, no way around a gate", async () => {
  // Vision Law 4 puts gates at consequence boundaries. If resuming were a way to skip an approval,
  // the wait would be a hole in the trust story rather than a part of it, and "the client replied,
  // so we auto-sent" is exactly the shape of that mistake. So the resume path is asserted to produce
  // a task and to touch nothing else: no message, no invoice, no approval short-circuited.
  const { app, store, domain, projectId, kase, client } = await engagement();
  const channel = await domain.createChannel({ project_id: projectId, kind: "email", name: "inbox", config: {} } as never);
  const thread = await domain.createThread({ project_id: projectId, client_id: client.id, channel_id: channel.id, case_id: kase.id, status: "open" } as never);

  const before = {
    messages: (await domain.listMessages(thread.id)).length,
    invoices: (await getBillingStore().listInvoices({ project_id: projectId, limit: 100 })).length,
    approvals: (await store.listApprovals("pending")).length,
  };

  await api(app, `cases/${kase.id}/wait`, {
    method: "POST",
    body: JSON.stringify({ reason: "waiting on Acme", condition: { kind: "client_reply", thread_id: thread.id }, resume: { task_type: RESUME_TYPE } }),
  });
  await tick();
  await domain.addMessage({ thread_id: thread.id, direction: "inbound", author: client.id, body: "confirmed" } as never);

  // The REAL deps this time — `createServer` registered them — so this exercises `spawnKernelTask`.
  const summary = await sweepWaits({ domain, project_id: projectId });
  assert.equal(summary.resumed, 1);

  const tasks = (await store.listTasks({ project_id: projectId } as never)).filter((t: any) => t.task_type === RESUME_TYPE);
  assert.equal(tasks.length, 1, "a resume produces exactly one ordinary task");
  const t: any = tasks[0];
  // It was ENQUEUED, so the orchestrator has it — it is in the ordinary lifecycle, not marked
  // complete or pre-approved by the resume path. (`queued` is a race: the mock runtime may already
  // have picked it up by the time we look, which is itself the proof it went through the queue.)
  assert.ok(["queued", "running", "succeeded", "failed"].includes(t.status), `ordinary lifecycle, got ${t.status}`);
  assert.equal(t.assigned_to, "agent", "it is work for a run, not a pre-decided outcome");
  assert.equal(t.source, "schedule", "an operator can tell 'the wait came good' from 'somebody clicked resume'");
  assert.equal(t.case_id, kase.id);
  assert.equal(t.project_id, projectId);

  // ═══ THE GATE PARITY ASSERTION ═══ A resumed run is subject to the same approvals a fresh one is,
  // and the way that is guaranteed is that it is spawned by the SAME closure with the SAME clamping.
  // So its constraints must be indistinguishable from a task the case route spawns by hand.
  const fresh = await api(app, `cases/${kase.id}/tasks`, { method: "POST", body: JSON.stringify({ task_type: RESUME_TYPE }) });
  assert.equal(fresh.status, 201);
  assert.deepEqual(
    t.constraints,
    (await store.getTask(fresh.json.id))!.constraints,
    "a resumed run is clamped exactly like a hand-started one — no cheaper ceiling, no skipped gate",
  );
  assert.ok(t.output_schema, "and given the wedge manifest's output schema — it went through spawnKernelTask, not a shortcut");

  assert.equal((await domain.listMessages(thread.id)).length, before.messages + 1, "the resume sent NOTHING; the only new message is the client's");
  assert.equal((await getBillingStore().listInvoices({ project_id: projectId, limit: 100 })).length, before.invoices, "and raised no invoice");
  assert.equal((await store.listApprovals("pending")).length, before.approvals, "and short-circuited no approval");
});

// ── never hangs: expiry and nudges ───────────────────────────────────────────────────────────────

test("waits: a condition that never arrives EXPIRES — it does not hang, and it spawns nothing", async () => {
  // The engagement that silently stops existing. Expiry ends the WAIT, not the engagement: what to
  // do about a client who never answered is a judgement call about a relationship, and a system that
  // picked one automatically would be autonomy no evidence earned.
  const { domain, projectId, kase, client } = await engagement();
  const channel = await domain.createChannel({ project_id: projectId, kind: "email", name: "inbox", config: {} } as never);
  const thread = await domain.createThread({ project_id: projectId, client_id: client.id, channel_id: channel.id, case_id: kase.id, status: "open" } as never);
  const armedAt = new Date("2026-01-01T00:00:00.000Z");
  const armed = await armWait(
    domain,
    {
      project_id: projectId, case_id: kase.id, reason: "waiting on Acme to confirm the scope",
      condition: { kind: "client_reply", thread_id: thread.id }, resume: { task_type: RESUME_TYPE },
    },
    armedAt,
  );
  assert.ok(armed.ok);
  const spawned = recordingDeps();

  // A day in: still waiting, nothing has happened.
  const early = await sweepWaits({ domain, project_id: projectId, now: new Date(armedAt.getTime() + DAY) });
  assert.equal(early.still_waiting, 1);
  assert.equal(early.expired, 0);

  // A day past the ninety-day cap.
  const late = await sweepWaits({ domain, project_id: projectId, now: new Date(armedAt.getTime() + (MAX_WAIT_DAYS + 1) * DAY) });
  assert.equal(late.expired, 1);
  assert.equal(spawned.length, 0, "giving up is not resuming");
  assert.equal((await domain.getWait(projectId, armed.ok ? armed.wait.id : ""))!.status, "expired");
  const kase2 = await domain.getCase(kase.id);
  assert.equal(kase2!.status, "open", "the ENGAGEMENT is still open — it is the wait that ended");
  assert.ok(kase2!.history.some((h) => h.note?.includes("gave up waiting")), "and a founder can see that it did");
});

test("waits: an answer that lands just before the deadline still resumes, even if the sweep is late", async () => {
  // Arithmetic must not lose a real answer. A client who replied an hour before the deadline and a
  // sweep that ran an hour after it is an ordinary Friday.
  const { domain, projectId, kase, client } = await engagement();
  const channel = await domain.createChannel({ project_id: projectId, kind: "email", name: "inbox", config: {} } as never);
  const thread = await domain.createThread({ project_id: projectId, client_id: client.id, channel_id: channel.id, case_id: kase.id, status: "open" } as never);
  const armedAt = new Date("2026-01-01T00:00:00.000Z");
  await armWait(
    domain,
    {
      project_id: projectId, case_id: kase.id, reason: "waiting on Acme",
      condition: { kind: "client_reply", thread_id: thread.id }, resume: { task_type: RESUME_TYPE },
      max_nudges: 0,
    },
    armedAt,
  );
  await tick();
  await domain.addMessage({ thread_id: thread.id, direction: "inbound", author: client.id, body: "just in time" } as never);
  const spawned = recordingDeps();

  const late = await sweepWaits({ domain, project_id: projectId, now: new Date(armedAt.getTime() + (MAX_WAIT_DAYS + 5) * DAY) });
  assert.equal(late.resumed, 1, "satisfied beats expired");
  assert.equal(late.expired, 0);
  assert.equal(spawned.length, 1);
});

test("waits: a wait that is still pending NUDGES on a ladder, at most once per due date, and never sends", async () => {
  // Two failures in one. A wait that never nudges is a client who was never told the ball is in
  // their court. A nudge that is not claimed atomically is two replicas both reading "2 of 3 sent"
  // and chasing the same client twice on the same morning.
  //
  // And it is a NOTE, not a send: an email despatched by a sweep is an email that never met an
  // approval gate.
  const { domain, projectId, kase, client } = await engagement();
  const channel = await domain.createChannel({ project_id: projectId, kind: "email", name: "inbox", config: {} } as never);
  const thread = await domain.createThread({ project_id: projectId, client_id: client.id, channel_id: channel.id, case_id: kase.id, status: "open" } as never);
  const armedAt = new Date("2026-01-01T00:00:00.000Z");
  const armed = await armWait(
    domain,
    {
      project_id: projectId, case_id: kase.id, reason: "waiting on the bank export",
      condition: { kind: "client_reply", thread_id: thread.id }, resume: { task_type: RESUME_TYPE },
    },
    armedAt,
  );
  assert.ok(armed.ok);
  const id = armed.ok ? armed.wait.id : "";
  assert.ok(armed.ok && armed.wait.nudge_at, "a default ladder was armed — see DEFAULT_NUDGE_DAYS");
  recordingDeps();

  // Four days in, the first chase is due. TWO replicas sweep at once.
  const at = new Date(armedAt.getTime() + 4 * DAY);
  const [a, b] = await Promise.all([
    sweepWaits({ domain, project_id: projectId, now: at }),
    sweepWaits({ domain, project_id: projectId, now: at }),
  ]);
  assert.equal(a.nudged + b.nudged, 1, "ONE nudge, not two — the client is not chased twice this morning");
  assert.equal((await domain.getWait(projectId, id))!.nudge_count, 1);

  // Nothing left the building.
  assert.equal((await domain.listMessages(thread.id)).length, 0, "a nudge is a founder-facing signal, never an outbound message");
  assert.ok((await domain.getCase(kase.id))!.history.some((h) => h.note?.includes("still waiting (nudge 1/")));

  // The ladder is finite: a wait that nudges forever is spam with a scheduler.
  for (let i = 2; i <= 6; i++) {
    await sweepWaits({ domain, project_id: projectId, now: new Date(armedAt.getTime() + (1 + 4 * i) * DAY) });
  }
  const final = (await domain.getWait(projectId, id))!;
  assert.ok(final.nudge_count <= final.max_nudges, `stopped at the cap (${final.nudge_count}/${final.max_nudges})`);
});

test("waits: a sweep MUST be scoped to a project — there is no fleet-wide overload", async () => {
  // The two cross-tenant leaks this codebase has shipped both came from an optional project with a
  // `?? ""` at the call site. Here that would resume one founder's engagements against another
  // founder's connections, so it throws rather than defaults.
  const { domain } = await engagement();
  await assert.rejects(() => sweepWaits({ domain, project_id: "" }), /scoped to a project/);
});

test("waits: one project's sweep never touches another project's waits", async () => {
  const { domain, projectId, kase } = await engagement();
  const cond = { kind: "date", at: new Date(Date.now() - DAY).toISOString() } as const;
  await armWait(domain, { project_id: projectId, case_id: kase.id, reason: "mine", condition: cond, resume: { task_type: RESUME_TYPE } });
  const spawned = recordingDeps();

  const theirs = await sweepWaits({ domain, project_id: `p-${randomUUID()}` });
  assert.equal(theirs.considered, 0, "a stranger's sweep sees nothing of ours");
  assert.equal(spawned.length, 0);

  assert.equal((await sweepWaits({ domain, project_id: projectId })).resumed, 1, "and ours still works");
});

// ── visible where a founder looks ────────────────────────────────────────────────────────────────

test("waits: a parked engagement leaves /next's move list and appears as HELD instead", async () => {
  // `checkInMove` fires on silence, and an engagement parked on a client reply is silent by
  // construction. Without the suppression the founder is told a fortnight later that "nobody has
  // touched this" and chases a client the kernel is already chasing — the double-contact cousin of
  // the double-invoice bug, and the one that teaches them the list is wrong.
  const { domain, projectId, kase, client } = await engagement();
  const stores = { domain, billing: getBillingStore(), requests: getRequestStore(), deliverables: getDeliverableStore() };
  const auth = founderMoveAuthority({ project_id: projectId, wedges: [WEDGE], client_ids: [client.id], case_ids: [kase.id] });

  // Age the engagement into staleness so it is definitely a move before it is parked.
  const long = new Date(Date.now() + 60 * DAY);
  const before = await proposeMoves(stores, auth, {}, long);
  assert.ok(before.moves.some((m) => m.case_id === kase.id), "a silent engagement is a move");
  assert.deepEqual(before.waiting, [], "and nothing is held");

  await armWait(domain, {
    project_id: projectId, case_id: kase.id, reason: "waiting on Acme to confirm the scope",
    condition: { kind: "date", at: new Date(Date.now() + 30 * DAY).toISOString() }, resume: { task_type: RESUME_TYPE },
  });

  const after = await proposeMoves(stores, auth, {}, long);
  assert.ok(!after.moves.some((m) => m.case_id === kase.id), "parked work is NOT proposed as something to do");
  assert.equal(after.waiting.length, 1, "it is accounted for instead of vanishing");
  assert.equal(after.waiting[0].case_id, kase.id);
  assert.equal(after.waiting[0].reason, "waiting on Acme to confirm the scope");
  assert.deepEqual(after.waiting[0].conditions, ["date"]);
  assert.equal(after.waiting[0].needs_attention, false);
  assert.ok(after.waiting[0].expires_at, "and a founder is told when the kernel gives up");
  assert.equal(after.authority_excluded, 0, "held is not 'refused' — it was not withheld from them");
});

test("waits: /next never shows another tenant's held work", async () => {
  // Every new read gets this. A `waiting` list assembled before the authority check would put an
  // engagement the caller cannot see onto their main surface under the guise of being helpful.
  const { domain, projectId, kase, client } = await engagement();
  await armWait(domain, {
    project_id: projectId, case_id: kase.id, reason: "ours, and private",
    condition: { kind: "date", at: new Date(Date.now() + 30 * DAY).toISOString() }, resume: { task_type: RESUME_TYPE },
  });
  const stores = { domain, billing: getBillingStore(), requests: getRequestStore(), deliverables: getDeliverableStore() };

  // A founder of another business, with a legitimate authority over their own empty project.
  const stranger = founderMoveAuthority({ project_id: `p-${randomUUID()}`, wedges: [WEDGE], client_ids: [], case_ids: [] });
  const theirs = await proposeMoves(stores, stranger, {}, new Date(Date.now() + 60 * DAY));
  assert.deepEqual(theirs.waiting, [], "no cross-tenant held work");
  assert.ok(!JSON.stringify(theirs).includes("ours, and private"));

  // A founder of THIS business who is nonetheless not allowed this client sees nothing either.
  const narrowed = founderMoveAuthority({ project_id: projectId, wedges: [WEDGE], client_ids: [`c-${randomUUID()}`], case_ids: [kase.id] });
  const narrow = await proposeMoves(stores, narrowed, {}, new Date(Date.now() + 60 * DAY));
  assert.deepEqual(narrow.waiting, [], "the authority is applied BEFORE the wait is reported");
  assert.ok(narrow.authority_excluded > 0, "and the refusal is counted");
});

test("waits: a wait stuck mid-resume is surfaced as needing a human, not hidden", async () => {
  // The claim deliberately does not release — a lease that expired and made the wait eligible again
  // would trade a stuck engagement for a duplicate invoice. The cost of that choice is a `resuming`
  // row that will never move on its own, so it must be the loudest thing on the list rather than
  // indistinguishable from a healthy parked one.
  const { app, domain, projectId, kase, client } = await engagement();
  const armed = await armWait(domain, {
    project_id: projectId, case_id: kase.id, reason: "crashed mid-resume",
    condition: { kind: "date", at: new Date(Date.now() - DAY).toISOString() }, resume: { task_type: RESUME_TYPE },
  });
  assert.ok(armed.ok);
  // Claim it and then "crash": exactly the state a replica killed between the claim and the spawn
  // leaves behind.
  await domain.claimWait(projectId, armed.ok ? armed.wait.id : "", "date:x", new Date().toISOString());

  const stores = { domain, billing: getBillingStore(), requests: getRequestStore(), deliverables: getDeliverableStore() };
  const auth = founderMoveAuthority({ project_id: projectId, wedges: [WEDGE], client_ids: [client.id], case_ids: [kase.id] });
  const proposal = await proposeMoves(stores, auth, {}, new Date(Date.now() + 60 * DAY));
  assert.equal(proposal.waiting.length, 1);
  assert.equal(proposal.waiting[0].needs_attention, true, "the ONE wait state that needs a person says so");
  assert.ok(!proposal.moves.some((m) => m.case_id === kase.id), "and it is still not proposed as ordinary work");

  // It is in the default answer of `GET /v1/waits` too, rather than behind a filter — hiding it is
  // how it stays hidden.
  const listed = await api(app, "waits");
  assert.equal(listed.status, 200);
  assert.ok(listed.json.some((w: any) => w.status === "resuming"), "the live view includes it by default");
});

test("waits: cancelling is not resuming — it is terminal and it spawns nothing", async () => {
  // "We are no longer blocked on this" and "the thing we were blocked on happened" are different
  // facts with different consequences. A cancel that quietly kicked off the resume run would be a
  // founder tidying their list into a client-facing send.
  const { app, domain, projectId, kase } = await engagement();
  const armed = await armWait(domain, {
    project_id: projectId, case_id: kase.id, reason: "never mind",
    condition: { kind: "date", at: new Date(Date.now() - DAY).toISOString() }, resume: { task_type: RESUME_TYPE },
  });
  assert.ok(armed.ok);
  const spawned = recordingDeps();

  const res = await api(app, `waits/${armed.ok ? armed.wait.id : ""}/cancel`, { method: "POST" });
  assert.equal(res.status, 200);
  assert.equal(res.json.status, "cancelled");
  assert.equal(spawned.length, 0, "cancelling sends and spawns nothing");

  // And a satisfied condition does not revive it: the sweep no longer sees it at all.
  const after = await sweepWaits({ domain, project_id: projectId });
  assert.equal(after.considered, 0);
  assert.equal(spawned.length, 0);
});

// ── wedges that park themselves ──────────────────────────────────────────────────────────────────

/**
 * A running task, as a wedge's own run looks to the internal routes.
 *
 * `case_id` is the field under test as much as anything: `armDeclaredWait` refuses to park a run
 * that has no engagement behind it, because inventing a case from a question would be the kernel
 * manufacturing an engagement out of a run's ignorance.
 */
async function runningTask(
  store: { createTask(t: unknown): Promise<unknown> },
  t: { id: string; project_id: string; task_type: string; client_id?: string; case_id?: string },
) {
  const now = new Date().toISOString();
  await store.createTask({
    id: t.id, project_id: t.project_id, wedge: WEDGE, task_type: t.task_type,
    client_id: t.client_id, case_id: t.case_id,
    actor: { kind: "system", id: "scheduler" }, input: {}, constraints: {}, tools: [],
    status: "running", cost_usd: 0, created_at: now, updated_at: now,
  } as never);
  return registerActionGrant({ task_id: t.id, connectionIds: [] });
}

test("waits: books-keeper parks the close when it asks the client for paperwork, and resumes the CLOSE not the chase", async () => {
  // THE BUG THIS PREVENTS: `chase_receipts` raised a `ClientRequest` and the run ended. Nothing
  // anywhere resumed the WORK when the client answered — `nudges.ts` would chase the ask for ever
  // and the month never closed. Waiting was a capability nobody triggered, which is the difference
  // between vision.md's "resumed next Tuesday" and a table with an API.
  const { app, store, domain, projectId, client, kase } = await engagement("Acme — March close");
  const nonce = await runningTask(store, {
    id: `bk-${randomUUID()}`, project_id: projectId, task_type: "chase_receipts",
    client_id: client.id, case_id: kase.id,
  });

  const asked = await api(app, "internal/knowledge/gap", {
    method: "POST",
    headers: { authorization: `Bearer ${nonce}` },
    body: JSON.stringify({ question: "Receipts for the 4 unmatched card payments in March?", ask_client: true, kind: "document" }),
  });
  assert.equal(asked.json.ok, true);
  assert.equal(asked.json.asked, "client");
  assert.ok(asked.json.wait_id, "the engagement parked itself — nobody had to know the feature existed");

  const [wait] = await domain.listWaits({ project_id: projectId, status: "waiting" });
  assert.equal(wait.conditions[0].kind, "request_resolved");
  assert.equal((wait.conditions[0] as { request_id: string }).request_id, asked.json.request_id);
  // Resuming `chase_receipts` would ask for the receipts again the moment they arrived. The manifest
  // names the NEXT step, which is what "picks up rather than restarts" means concretely.
  assert.equal(wait.resume.task_type, "monthly_close");
  assert.equal(wait.project_id, projectId, "scoped from the CASE, never from anything the model wrote");
});

test("waits: an armed wedge does not double-chase — the wait nudges zero times because the request ladder owns that", async () => {
  // THE BUG THIS PREVENTS: two mechanisms chasing one customer about one document. `nudges.ts`
  // already claims this exact request row atomically and escalates on its own slowing ladder. A wait
  // that also nudged would put a second "still waiting" line on the timeline for every real chase and
  // tell a founder two systems were on it — and the day somebody turned the wait's nudge into a send,
  // it would be two emails.
  const { app, store, domain, projectId, client, kase } = await engagement("Acme — April close");
  const nonce = await runningTask(store, {
    id: `bk-${randomUUID()}`, project_id: projectId, task_type: "chase_receipts",
    client_id: client.id, case_id: kase.id,
  });
  await api(app, "internal/knowledge/gap", {
    method: "POST",
    headers: { authorization: `Bearer ${nonce}` },
    body: JSON.stringify({ question: "The April bank statement, please", ask_client: true, kind: "document" }),
  });

  const [wait] = await domain.listWaits({ project_id: projectId, status: "waiting" });
  assert.equal(wait.max_nudges, 0, "the wait explicitly declines to chase");
  assert.equal(wait.nudge_at, undefined);

  // Six weeks later: the wait has still nudged nobody, however many times the sweep has run.
  const spawned = recordingDeps();
  const later = new Date(Date.now() + 42 * DAY);
  for (let i = 0; i < 3; i++) {
    const s = await sweepWaits({ domain, project_id: projectId, now: new Date(Date.now() + (7 + i * 7) * DAY) });
    assert.equal(s.nudged, 0, "the wait never chases — that is the request ladder's job");
  }
  assert.equal(spawned.length, 0, "and nothing resumed while the ask was still open");

  // The request ladder, meanwhile, IS chasing — one mechanism, not two. It stops the moment the
  // request leaves `open`, which is the same instant the wait's condition becomes true: the two are
  // triggered by mutually exclusive states of one row, so they cannot both act.
  const nudgeSpawns: { case_id?: string }[] = [];
  setNudgeDeps({ wedgeEnabled: () => true, spawnTask: async (a) => { nudgeSpawns.push(a); return `n-${nudgeSpawns.length}`; } });
  await sweepOpenRequests({ domain, project_id: projectId, now: later });
  // Counted against THIS engagement rather than against the sweep's totals: the request store is a
  // process-wide singleton that `makeFreshApp` does not reset, so a sibling test's asks are visible
  // in the same project and a summary count here would be measuring the suite, not the feature.
  assert.equal(nudgeSpawns.filter((n) => n.case_id === kase.id).length, 1, "exactly one chaser is on this customer");

  const askId = (wait.conditions[0] as { request_id: string }).request_id;
  await getRequestStore().resolveRequest(projectId, askId, "Attached — sorry for the delay.");
  nudgeSpawns.length = 0;
  await sweepOpenRequests({ domain, project_id: projectId, now: new Date(later.getTime() + 30 * DAY) });
  assert.equal(nudgeSpawns.filter((n) => n.case_id === kase.id).length, 0, "the ladder stops the moment the ask is answered");

  // …and that is precisely when the wait resumes. Exactly one run, and it is the close.
  const resumed = await sweepWaits({ domain, project_id: projectId, now: later });
  assert.equal(resumed.resumed, 1);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].task_type, "monthly_close");
  setNudgeDeps(null);
});

test("waits: a wedge that ends by SENDING declares no wait — the dunning ladder is not given a twin", async () => {
  // THE BUG THIS PREVENTS: arming a wait on `chase_invoice` looks like the obvious wiring and is the
  // dangerous one. A resume spawns through `spawnTask` directly, so it never passes through
  // `startChase` and therefore never touches `claimInvoiceForChase` — it would neither respect nor
  // stamp `last_chased_at`, and the hourly sweep would add its own email on top within the hour.
  // The ladder already re-evaluates "is this still unpaid"; a second opinion about that is the
  // duplicate the ladder exists to prevent. This asserts the manifests keep it that way.
  for (const slug of ["invoice-chaser", "gtm-operator"]) {
    const types = loadWedge(slug)?.manifest.task_types ?? {};
    for (const [name, spec] of Object.entries(types)) {
      assert.equal(
        spec.waits_for,
        undefined,
        `${slug}.${name} declares a wait, but that wedge already paces itself (dunning ladder / sequencer)`,
      );
    }
  }
  // And the one that does declare one resumes something OTHER than itself.
  const bk = loadWedge("books-keeper")?.manifest.task_types ?? {};
  assert.equal(bk.chase_receipts?.waits_for?.resume, "monthly_close");
  assert.notEqual(bk.chase_receipts?.waits_for?.resume, "chase_receipts");
});

// ── the way back from a stalled resume ───────────────────────────────────────────────────────────

/** Put a wait in the state a replica killed between the claim and the spawn leaves behind. */
const stall = async (
  domain: ReturnType<typeof getDomainStore>,
  projectId: string,
  waitId: string,
  minutesAgo = REARM_STUCK_AFTER_MINUTES + 5,
) => domain.claimWait(projectId, waitId, "date:crashed", new Date(Date.now() - minutesAgo * 60_000).toISOString());

/** An armed, already-satisfiable wait. `date` in the past, so a sweep resumes it immediately. */
async function stuckWait(title: string) {
  const ctx = await engagement(title);
  const armed = await armWait(ctx.domain, {
    project_id: ctx.projectId, case_id: ctx.kase.id, reason: "waiting on their sign-off",
    condition: { kind: "date", at: new Date(Date.now() - DAY).toISOString() },
    resume: { task_type: RESUME_TYPE },
  });
  assert.ok(armed.ok);
  const waitId = armed.ok ? armed.wait.id : "";
  await stall(ctx.domain, ctx.projectId, waitId);
  return { ...ctx, waitId };
}

test("waits: a re-arm cannot produce two resumes", async () => {
  // THE BUG THIS PREVENTS: the whole reason the claim never releases is that a lease would let a
  // slow resume run twice. A re-arm is a second claim on a wait whose first claim never completed,
  // so if it were a plain read-decide-write, two founders (or one double-clicked button, or two
  // replicas behind one load balancer) would both move it back to `waiting` — and the sweep would
  // then resume it once for each. That is the duplicate invoice, arriving by the recovery path.
  const { domain, projectId, waitId } = await stuckWait("Acme — stalled once");
  const spawned = recordingDeps();

  const both = await Promise.all([
    rearmWait(domain, { project_id: projectId, wait_id: waitId, by: "founder-a" }),
    rearmWait(domain, { project_id: projectId, wait_id: waitId, by: "founder-b" }),
  ]);
  assert.equal(both.filter((r) => r.ok).length, 1, "one winner, one loser — never two");
  assert.equal((await domain.getWait(projectId, waitId))!.rearm_count, 1, "and one attempt was spent, not two");

  // And the recovery itself resumes exactly once, however many times the sweep runs afterwards.
  await sweepWaits({ domain, project_id: projectId });
  await sweepWaits({ domain, project_id: projectId });
  assert.equal(spawned.length, 1, "re-armed, resumed once");
  assert.equal((await domain.getWait(projectId, waitId))!.status, "resumed");
});

test("waits: a re-arm is sealed by tenant — another founder cannot un-stick your engagement", async () => {
  // THE MOTIVATING FAILURE: this codebase has shipped two cross-tenant leaks, both from a scope
  // checked one layer up. Here the consequence is worse than a read: re-arming another tenant's wait
  // schedules a run against THEIR connections, days later, with no human anywhere near it.
  const { domain, projectId, waitId } = await stuckWait("Acme — stalled, and not yours");
  const foreign = `p-${randomUUID()}`;

  const r = await rearmWait(domain, { project_id: foreign, wait_id: waitId, by: "someone-else" });
  assert.deepEqual(r, { ok: false, reason: "not_found", message: "not found" }, "a wrong tenant is a missing row, not a refusal that confirms the id");
  assert.equal(await domain.rearmWait({ projectId: foreign, id: waitId, stuckBefore: new Date().toISOString(), maxRearms: 9, by: "x", nowIso: new Date().toISOString() }), undefined);
  assert.equal(await domain.rearmWait({ projectId: "", id: waitId, stuckBefore: new Date().toISOString(), maxRearms: 9, by: "x", nowIso: new Date().toISOString() }), undefined, "an empty tenant fails closed rather than matching everything");
  assert.equal((await domain.getWait(projectId, waitId))!.status, "resuming", "and the real owner's wait is untouched");
});

test("waits: a resume that got anywhere, or is still running, is not re-armable", async () => {
  // THE BUG THIS PREVENTS: an impatient founder turning a resume that WORKED, or one that is merely
  // slow, into a second run. These two guards are what bound how much the founder's assertion can
  // cost — everything a query can establish is established, and only the genuinely unobservable
  // remainder is left to them.
  // A resume that started SECONDS ago. It is indistinguishable from a crashed one by status alone,
  // and this is the guard that stops "the founder was impatient" becoming "the client heard twice".
  const fresh = await stuckWait("Acme — just claimed");
  await rearmWait(fresh.domain, { project_id: fresh.projectId, wait_id: fresh.waitId, by: "f" });
  await fresh.domain.claimWait(fresh.projectId, fresh.waitId, "date:x", new Date().toISOString());
  const tooSoon = await rearmWait(fresh.domain, { project_id: fresh.projectId, wait_id: fresh.waitId, by: "f" });
  assert.equal(tooSoon.ok, false);
  assert.equal(tooSoon.ok === false && tooSoon.reason, "too_soon");

  // A resume that recorded its run DID run. Re-arming that one is how you get two.
  const ran = await stuckWait("Acme — resume recorded a run");
  await ran.domain.settleWait(ran.projectId, ran.waitId, "resumed", { resumed_task_id: randomUUID() }, ["resuming"]);
  const already = await rearmWait(ran.domain, { project_id: ran.projectId, wait_id: ran.waitId, by: "f" });
  assert.equal(already.ok, false);
  assert.equal(already.ok === false && already.reason, "already_ran");
});

test("waits: a wait whose resume keeps dying stops being re-armable", async () => {
  // THE BUG THIS PREVENTS: an unbounded retry button. A resume that stalls three times is failing for
  // a reason another attempt will not change, and a founder clicking a fourth time is generating load
  // instead of a diagnosis. The budget lives in the WHERE clause, not in a caller's memory.
  const { domain, projectId, waitId } = await stuckWait("Acme — keeps dying");
  for (let i = 1; i <= MAX_REARMS; i++) {
    const r = await rearmWait(domain, { project_id: projectId, wait_id: waitId, by: "founder" });
    assert.equal(r.ok, true, `attempt ${i} allowed`);
    await stall(domain, projectId, waitId);
  }
  const over = await rearmWait(domain, { project_id: projectId, wait_id: waitId, by: "founder" });
  assert.equal(over.ok, false);
  assert.equal(over.ok === false && over.reason, "exhausted");
});

test("waits: a re-armed run passes every gate a fresh one does", async () => {
  // THE BUG THIS PREVENTS: recovery becoming a way around policy. Re-arming spawns NOTHING itself —
  // it hands the wait back to the sweep, which resumes through the same `resumeWait`, so a wedge the
  // founder has since turned off still refuses, and the run that does happen still stops at the
  // approval gate like any other.
  const { domain, projectId, waitId } = await stuckWait("Acme — wedge since disabled");
  const spawned = recordingDeps({ enabled: false });

  const r = await rearmWait(domain, { project_id: projectId, wait_id: waitId, by: "founder" });
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.wait.status, "waiting", "back on the list — NOT resumed");
  assert.equal(r.ok && r.wait.satisfied_by, undefined, "and the old evidence is cleared, so the condition is judged afresh");
  assert.equal(spawned.length, 0, "re-arming spawns nothing by itself");

  const swept = await sweepWaits({ domain, project_id: projectId });
  assert.equal(swept.resumed, 0);
  assert.equal(spawned.length, 0, "a disabled wedge refuses a re-armed resume exactly as it refuses a fresh one");
  assert.equal((await domain.getWait(projectId, waitId))!.status, "failed");
});

test("waits: re-arming over the wire requires the founder to say the resume never ran", async () => {
  // WHY THIS IS NOT CEREMONY: a crashed resume and a slow one are indistinguishable from outside, so
  // the last guard is a human assertion about the world. Requiring it in the body is what keeps the
  // UI honest — a one-click button would have implied the kernel verified something it cannot.
  const { app, domain, projectId, waitId } = await stuckWait("Acme — over the wire");
  recordingDeps();

  const bare = await api(app, `waits/${waitId}/rearm`, { method: "POST", body: JSON.stringify({}) });
  assert.equal(bare.status, 400);
  assert.equal(bare.json.code, "rearm.unconfirmed");
  assert.equal((await domain.getWait(projectId, waitId))!.status, "resuming", "and nothing moved");

  const ok = await api(app, `waits/${waitId}/rearm`, { method: "POST", body: JSON.stringify({ confirm: "did-not-run" }) });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.wait.status, "waiting");
  assert.equal(ok.json.attempts_left, MAX_REARMS - 1);
  assert.equal(ok.json.wait.rearmed_by !== undefined, true, "who asserted it is recorded — Law 6");

  // A second immediate re-arm is refused with a SENTENCE, not a generic error: the founder needs to
  // know it declined because the wait is no longer stuck, not because something broke.
  const again = await api(app, `waits/${waitId}/rearm`, { method: "POST", body: JSON.stringify({ confirm: "did-not-run" }) });
  assert.equal(again.status, 409);
  assert.equal(again.json.code, "rearm.not_stuck");

  // A wait id in nobody's project is a 404, not a 409 — a refusal would confirm the id exists.
  const nowhere = await api(app, `waits/${randomUUID()}/rearm`, { method: "POST", body: JSON.stringify({ confirm: "did-not-run" }) });
  assert.equal(nowhere.status, 404);
});

// ── more than one way out ────────────────────────────────────────────────────────────────────────
//
// Every test below names the bug it prevents. The family they belong to is one bug: a wait learned
// to hold several conditions, and every extra condition is another way to resume twice.

test("waits: a wait with no conditions, both spellings, a duplicate or an unknown mode is refused at arm time", async () => {
  // The motivating failure is the empty set. A wait with no conditions cannot be satisfied by
  // anything — it can only expire — so it is an engagement parked for ninety days with a reason a
  // founder can read and no mechanism on earth that could release it. It looks perfectly healthy on
  // every list for the entire quarter.
  const { domain, projectId, kase } = await engagement();
  const soon = { kind: "date", at: new Date(Date.now() + DAY).toISOString() } as const;
  const base = { project_id: projectId, case_id: kase.id, reason: "r", resume: { task_type: RESUME_TYPE } };

  assert.match(String((await armWait(domain, { ...base, conditions: [] } as never)).ok === false
    && (await armWait(domain, { ...base, conditions: [] } as never) as { error: string }).error), /at least one condition/);
  assert.match(
    String(((await armWait(domain, { ...base, condition: soon, conditions: [soon] } as never)) as { error: string }).error),
    /not both/,
    "two lists is two answers to what this engagement is blocked on",
  );
  assert.match(
    String(((await armWait(domain, { ...base, conditions: [soon, { ...soon }] } as never)) as { error: string }).error),
    /listed twice/,
  );
  assert.match(
    String(((await armWait(domain, { ...base, conditions: [soon], mode: "either" } as never)) as { error: string }).error),
    /unknown wait mode/,
    "an unknown mode is REFUSED and never coerced to `any` — a body that meant `all` and became `any` closes the month on the first receipt",
  );
  assert.equal((await armWait(domain, { ...base, conditions: [soon] } as never)).ok, true);
});

test("waits: TWO conditions satisfied in one sweep resume ONCE, and the resume records WHICH fired", async () => {
  // THE bug OR introduces. A client pays the invoice AND replies on the thread between two sweeps.
  // With a claim per condition — or with a sweep that resumed for each satisfied condition — the
  // engagement spawns two runs and the second one raises a second invoice. The claim is per WAIT and
  // `evaluateWait` collapses however many satisfied conditions into ONE verdict before it is reached.
  //
  // The second half is why OR is worth having at all: "they replied" and "they paid" lead to
  // different next moves, and a resume that cannot say which happened re-reads the invoice, finds it
  // unpaid, and drafts a chase at a client who just wrote in to dispute it.
  const { domain, projectId, kase, client } = await engagement();
  const billing = getBillingStore();
  const channel = await domain.createChannel({ project_id: projectId, kind: "email", name: "inbox", config: {} } as never);
  const thread = await domain.createThread({ project_id: projectId, client_id: client.id, channel_id: channel.id, case_id: kase.id, status: "open" } as never);
  const inv = await billing.createInvoice({
    project_id: projectId, client_id: client.id, case_id: kase.id, currency: "USD",
    lines: [{ description: "October", kind: "fixed", amount: 500_00 }],
    status: "sent", issue_date: "2026-01-01", due_date: "2026-01-15",
  } as never);

  const armed = await armWait(domain, {
    project_id: projectId, case_id: kase.id, reason: "they pay or they explain",
    conditions: [
      { kind: "invoice_paid", invoice_id: inv.id, label: "the October invoice" },
      { kind: "client_reply", thread_id: thread.id, label: "a word from them" },
    ],
    resume: { task_type: RESUME_TYPE },
  });
  assert.ok(armed.ok);
  const wait = armed.ok ? armed.wait : null!;
  assert.equal(wait.mode, "any", "the default is OR, because a wait with one exit is the special case");

  await tick();
  // BOTH come good before the sweep runs.
  await billing.recordPayment(inv.id, 500_00);
  await billing.updateInvoice(inv.id, { status: "paid" } as never);
  await domain.addMessage({ thread_id: thread.id, direction: "inbound", author: client.id, body: "paid, and here is the PO" } as never);

  const spawned = recordingDeps();
  const summary = await sweepWaits({ domain, project_id: projectId });
  assert.equal(summary.resumed, 1);
  assert.equal(spawned.length, 1, "two satisfied conditions are ONE resume — this is the double-invoice bug");

  const settled = (await domain.getWait(projectId, wait.id))!;
  assert.equal(settled.status, "resumed");
  assert.equal(settled.satisfied_index, 0, "first-satisfied-WINS is array order, so two replicas agree on the winner");
  assert.match(String(settled.satisfied_by), /^invoice:/);

  // And the run is TOLD which one, as a condition rather than as an id it would have to re-derive.
  const carried = (spawned[0]!.input as { resumed_from_wait: { satisfied_condition?: { kind: string }; satisfied_index?: number } }).resumed_from_wait;
  assert.equal(carried.satisfied_index, 0);
  assert.equal(carried.satisfied_condition?.kind, "invoice_paid");

  // A second sweep, with both conditions still true, must find nothing left to do.
  assert.equal((await sweepWaits({ domain, project_id: projectId })).resumed, 0);
  assert.equal(spawned.length, 1);
});

test("waits: TWO REPLICAS racing a multi-condition wait produce ONE resume", async () => {
  // The multi-replica half of the same bug, and the one that only shows up in production. Two worker
  // replicas sweep the same project in the same second; each sees a different condition satisfied
  // first depending on which store answered quickest. If the claim were per-CONDITION they would
  // both win — different rows — and the client gets two chases. It is per WAIT, so one gets the row
  // and the other gets `undefined`.
  const { domain, projectId, kase, client } = await engagement();
  const requests = getRequestStore();
  const req = await requests.createRequest({
    project_id: projectId, client_id: client.id, case_id: kase.id, kind: "info", ask: "the bank export",
  } as never);
  const armed = await armWait(domain, {
    project_id: projectId, case_id: kase.id, reason: "the export or the deadline",
    conditions: [
      { kind: "request_resolved", request_id: req.id, label: "the bank export" },
      { kind: "date", at: new Date(Date.now() - DAY).toISOString(), label: "the deadline" },
    ],
    resume: { task_type: RESUME_TYPE },
  });
  assert.ok(armed.ok);
  const wait = armed.ok ? armed.wait : null!;
  await requests.resolveRequest(projectId, req.id, {} as never);

  const spawned = recordingDeps();
  // Both replicas hold the SAME pre-claim row, which is exactly what two concurrent sweeps hold.
  const [a, b] = await Promise.all([
    resumeWait(domain, wait, "request:x", new Date(), 0),
    resumeWait(domain, wait, "date:y", new Date(), 1),
  ]);
  assert.equal([a.ok, b.ok].filter(Boolean).length, 1, "exactly one replica resumes");
  assert.equal(spawned.length, 1);
  const loser = a.ok ? b : a;
  assert.equal(loser.ok === false && loser.reason, "lost_claim");
});

test("waits: ONE dead exit does not kill an OR wait — every dead exit does", async () => {
  // The failure this prevents is throwing away a live engagement. A chase parked on "they pay OR
  // they reply" whose invoice gets voided is still perfectly alive via the reply — treating any dead
  // condition as a broken wait would fail it, put it on the broken list, and stop watching a
  // conversation that is still going. The opposite mistake is worse: a wait whose every exit is shut
  // must not sit `waiting` for ninety days looking healthy.
  const { domain, projectId, kase, client } = await engagement();
  const billing = getBillingStore();
  const channel = await domain.createChannel({ project_id: projectId, kind: "email", name: "inbox", config: {} } as never);
  const thread = await domain.createThread({ project_id: projectId, client_id: client.id, channel_id: channel.id, case_id: kase.id, status: "open" } as never);
  const inv = await billing.createInvoice({
    project_id: projectId, client_id: client.id, currency: "USD",
    lines: [{ description: "October", kind: "fixed", amount: 100_00 }],
    status: "sent", issue_date: "2026-01-01", due_date: "2026-01-15",
  } as never);
  const armed = await armWait(domain, {
    project_id: projectId, case_id: kase.id, reason: "pay or talk to us",
    conditions: [
      { kind: "invoice_paid", invoice_id: inv.id, label: "the invoice" },
      { kind: "client_reply", thread_id: thread.id, label: "a reply" },
    ],
    resume: { task_type: RESUME_TYPE },
  });
  assert.ok(armed.ok);
  const wait = armed.ok ? armed.wait : null!;

  await billing.updateInvoice(inv.id, { status: "void" } as never);
  const partial = await evaluateWait(domain, wait);
  assert.equal(partial.state, "pending", "one closed door is not a broken wait");
  assert.equal(partial.state === "pending" && partial.progress.dead.length, 1, "but the closed door IS reported");
  assert.equal(partial.state === "pending" && partial.progress.outstanding.length, 1);

  // Now shut the other one.
  const orphaned = { ...wait, conditions: [wait.conditions[0]!, { kind: "client_reply", thread_id: `t-${randomUUID()}` } as const] };
  const dead = await evaluateWait(domain, orphaned as never);
  assert.equal(dead.state, "unresolvable");
  assert.match(String(dead.state === "unresolvable" && dead.reason), /every way out of this wait is closed/);
});

// ── the join ─────────────────────────────────────────────────────────────────────────────────────

/** A month-end close parked on N receipts. The canonical service-business join. */
async function monthEndClose(n: number) {
  const ctx = await engagement("Acme — March close");
  const requests = getRequestStore();
  const asks = [];
  for (let i = 0; i < n; i++) {
    asks.push(
      await requests.createRequest({
        project_id: ctx.projectId, client_id: ctx.client.id, case_id: ctx.kase.id, kind: "doc",
        ask: `receipt ${i + 1}`,
      } as never),
    );
  }
  const armed = await armWait(ctx.domain, {
    project_id: ctx.projectId, case_id: ctx.kase.id, reason: "close the month once every receipt is in",
    mode: "all",
    conditions: asks.map((a, i) => ({ kind: "request_resolved" as const, request_id: a.id, label: `receipt ${i + 1}` })),
    resume: { task_type: RESUME_TYPE },
    max_nudges: 0,
  });
  assert.ok(armed.ok);
  return { ...ctx, requests, asks, wait: armed.ok ? armed.wait : null! };
}

test("waits: a join resumes only when EVERY part is in, and never once per part", async () => {
  // The bug: a month-end close that resumes on the first receipt files a set of books that is one
  // seventh complete, and — because the resume spawns the close — bills the client for it. The join
  // is satisfied by the CONJUNCTION, and until then the sweep must resume nothing at all however
  // many parts have landed.
  const { domain, projectId, requests, asks, wait } = await monthEndClose(3);
  const spawned = recordingDeps();

  await requests.resolveRequest(projectId, asks[0]!.id, {} as never);
  let s = await sweepWaits({ domain, project_id: projectId });
  assert.equal(s.resumed, 0, "one receipt is not a closed month");
  assert.equal(s.progressed, 1, "but the sweep says the join MOVED, which is how a live join is told from a dead one");
  assert.equal(spawned.length, 0);

  // Sweeping again with nothing new must not double-count the part it already banked. Without the
  // conditional append a seven-part join reports "19 of 7" after a fortnight of five-minute ticks.
  s = await sweepWaits({ domain, project_id: projectId });
  assert.equal(s.progressed, 0);
  assert.equal((await domain.getWait(projectId, wait.id))!.parts.length, 1);

  await requests.resolveRequest(projectId, asks[1]!.id, {} as never);
  assert.equal((await sweepWaits({ domain, project_id: projectId })).resumed, 0, "two of three is still not the month");

  await requests.resolveRequest(projectId, asks[2]!.id, {} as never);
  assert.equal((await sweepWaits({ domain, project_id: projectId })).resumed, 1);
  assert.equal(spawned.length, 1, "and exactly one close is spawned, not one per receipt");

  // The run is handed every part with the date each landed, which is what "which condition fired"
  // means for a join.
  const carried = (spawned[0]!.input as { resumed_from_wait: { mode: string; satisfied_parts?: unknown[] } }).resumed_from_wait;
  assert.equal(carried.mode, "all");
  assert.equal(carried.satisfied_parts?.length, 3);
});

test("waits: partial satisfaction is READABLE — '2 of 3 in', on the timeline and on /next", async () => {
  // The sentence the join exists to produce. Without it a parked month-end close and a dead one look
  // identical from the outside, which is exactly how one sits for six weeks with everybody assuming
  // it is nearly there.
  const { domain, projectId, kase, client, requests, asks, wait } = await monthEndClose(3);
  recordingDeps();
  await requests.resolveRequest(projectId, asks[0]!.id, {} as never);
  await requests.resolveRequest(projectId, asks[1]!.id, {} as never);
  await sweepWaits({ domain, project_id: projectId });

  // On the engagement's own timeline, in sequence with everything else that happened to it.
  const history = (await domain.getCase(kase.id))!.history;
  assert.ok(history.some((h) => h.note?.includes("receipt 1 is in (1 of 3)")), "each part lands on the timeline as it arrives");
  assert.ok(history.some((h) => h.note?.includes("receipt 2 is in (2 of 3)")));

  // And on the founder's actual surface, with what is MISSING named — which is also the list the
  // client has to act on, and therefore what makes a nudge worth sending.
  const stores = { domain, billing: getBillingStore(), requests: getRequestStore(), deliverables: getDeliverableStore() };
  const auth = founderMoveAuthority({ project_id: projectId, wedges: [WEDGE], client_ids: [client.id], case_ids: [kase.id] });
  const held = (await proposeMoves(stores, auth, {})).waiting.find((w) => w.wait_id === wait.id)!;
  assert.equal(held.mode, "all");
  assert.deepEqual(held.progress, { satisfied: 2, total: 3, outstanding: ["receipt 3"] });
});

test("waits: a join with ONE dead dependency does not hang — it fails loudly and says how far it got", async () => {
  // The dead end from expiry, one level up. Six receipts in, the seventh request is withdrawn, and a
  // join that treated "withdrawn" as "still pending" would sit at 6 of 7 until the ninety-day cap
  // while the founder believed the month was about to close. It cannot complete, so it stops NOW,
  // and the error names both the progress and the part that killed it.
  const { domain, projectId, kase, requests, asks, wait } = await monthEndClose(3);
  recordingDeps();
  await requests.resolveRequest(projectId, asks[0]!.id, {} as never);
  await sweepWaits({ domain, project_id: projectId });

  await requests.cancelRequest(projectId, asks[2]!.id);
  const verdict = await evaluateWait(domain, (await domain.getWait(projectId, wait.id))!);
  assert.equal(verdict.state, "unresolvable");
  assert.match(String(verdict.state === "unresolvable" && verdict.reason), /1 of 3 are in/);
  assert.match(String(verdict.state === "unresolvable" && verdict.reason), /receipt 3/, "and it names WHICH part killed it");

  const summary = await sweepWaits({ domain, project_id: projectId });
  assert.equal(summary.broken, 1);
  const dead = (await domain.getWait(projectId, wait.id))!;
  assert.equal(dead.status, "failed");
  assert.match(String(dead.error), /can never complete/);
  assert.equal(dead.parts.length, 1, "and the receipt that DID arrive is still on the record");
  assert.ok((await domain.getCase(kase.id))!.history.some((h) => h.note?.includes("wait broken")));
});

// ── expiry is not a dead end ─────────────────────────────────────────────────────────────────────

test("waits: an EXPIRED wait becomes a proposed move instead of an engagement nobody can see", async () => {
  // The dead end this closes. An expired wait used to write a note and stop: the engagement then sat
  // in no queue, appeared in no list and was proposed by nothing — and worse than never having been
  // parked, because parking it also removed it from the staleness check-in that would have caught
  // it. A client who went silent in March was still silent in June and the system had, by design,
  // forgotten to care.
  const { domain, projectId, kase, client } = await engagement();
  const armed = await armWait(domain, {
    project_id: projectId, case_id: kase.id, reason: "waiting on Acme for a signed SOW",
    condition: { kind: "date", at: new Date(Date.now() + 400 * DAY).toISOString() },
    resume: { task_type: RESUME_TYPE },
    expires_at: new Date(Date.now() + DAY).toISOString(),
  });
  assert.ok(armed.ok);
  const stores = { domain, billing: getBillingStore(), requests: getRequestStore(), deliverables: getDeliverableStore() };
  const auth = founderMoveAuthority({ project_id: projectId, wedges: [WEDGE], client_ids: [client.id], case_ids: [kase.id] });

  const later = new Date(Date.now() + 3 * DAY);
  recordingDeps();
  const summary = await sweepWaits({ domain, project_id: projectId, now: later });
  assert.equal(summary.expired, 1);
  assert.equal(summary.resumed, 0, "giving up spawns nothing — what happens to the client is judgement");

  const proposal = await proposeMoves(stores, auth, {}, later);
  const move = proposal.moves.find((m) => m.kind === "unblock_wait");
  assert.ok(move, "the abandoned engagement is PROPOSED, ranked with everything else");
  assert.equal(move!.case_id, kase.id);
  assert.match(move!.why, /waiting on Acme for a signed SOW/);
  assert.match(move!.why, /gave up after 0 nudges/);
  assert.ok(move!.score >= 30, "past its own deadline, so it ranks above a quiet engagement");
  assert.equal(move!.blocked_on, undefined, "the next step is OURS — it is a decision, not a nudge");
  assert.equal(move!.takeable, false);
  assert.match(String(move!.unavailable_reason), /judgement call/);

  // And it is exactly ONE row for the engagement: "check in, nothing has happened for 3 days" next
  // to "the chase gave up" is one situation described twice, the second time without the reason.
  assert.equal(proposal.moves.filter((m) => m.case_id === kase.id).length, 1);
  assert.equal(proposal.waiting.length, 0, "it is no longer HELD — nothing is watching it any more");
});

test("waits: a FAILED wait reaches the same list, and a re-parked engagement is one decision not two", async () => {
  // `expired` and `failed` are the same product state — a wait that is over and did not resume —
  // reached two ways: nobody answered, or the thing we waited on became impossible. Both leave an
  // engagement needing a human, and only surfacing one of them would leave the withdrawn-request
  // case exactly as invisible as expiry used to be.
  const { domain, projectId, kase, client, requests, asks, wait } = await monthEndClose(2);
  recordingDeps();
  await requests.cancelRequest(projectId, asks[0]!.id);
  await sweepWaits({ domain, project_id: projectId });
  assert.equal((await domain.getWait(projectId, wait.id))!.status, "failed");

  const stores = { domain, billing: getBillingStore(), requests: getRequestStore(), deliverables: getDeliverableStore() };
  const auth = founderMoveAuthority({ project_id: projectId, wedges: [WEDGE], client_ids: [client.id], case_ids: [kase.id] });
  const proposal = await proposeMoves(stores, auth, {});
  const rows = proposal.moves.filter((m) => m.kind === "unblock_wait");
  assert.equal(rows.length, 1);
  assert.match(rows[0]!.why, /stopped:/);
  assert.match(rows[0]!.why, /0 of 2 in/, "carrying the partial progress, because 0 of 2 and 6 of 7 are different conversations");

  // Re-park the engagement, and the dead wait must stop being proposed: something IS watching again.
  await armWait(domain, {
    project_id: projectId, case_id: kase.id, reason: "second try",
    condition: { kind: "date", at: new Date(Date.now() + 30 * DAY).toISOString() },
    resume: { task_type: RESUME_TYPE },
  });
  const after = await proposeMoves(stores, auth, {});
  assert.equal(after.moves.filter((m) => m.kind === "unblock_wait").length, 0);
  assert.equal(after.waiting.length, 1);
});

test("waits: /next never proposes another tenant's abandoned engagement", async () => {
  // Every new read gets this, and this one is a read of a DEAD wait — a row nothing else on the
  // surface looks at, which is exactly the kind that gets its tenant filter written by hand and
  // slightly differently. Two cross-tenant leaks have shipped here.
  const { domain, projectId, kase, client } = await engagement();
  await armWait(domain, {
    project_id: projectId, case_id: kase.id, reason: "ours, and abandoned",
    condition: { kind: "date", at: new Date(Date.now() + 400 * DAY).toISOString() },
    resume: { task_type: RESUME_TYPE },
    expires_at: new Date(Date.now() + DAY).toISOString(),
  });
  recordingDeps();
  const later = new Date(Date.now() + 3 * DAY);
  await sweepWaits({ domain, project_id: projectId, now: later });

  const stores = { domain, billing: getBillingStore(), requests: getRequestStore(), deliverables: getDeliverableStore() };
  const stranger = founderMoveAuthority({
    project_id: `p-${randomUUID()}`, wedges: [WEDGE], client_ids: [client.id], case_ids: [kase.id],
  });
  const theirs = await proposeMoves(stores, stranger, {}, later);
  assert.equal(theirs.moves.filter((m) => m.kind === "unblock_wait").length, 0);
  assert.deepEqual(theirs.waiting, []);

  // And the owner still sees it, so the isolation is not just an empty answer for everybody.
  const mine = founderMoveAuthority({ project_id: projectId, wedges: [WEDGE], client_ids: [client.id], case_ids: [kase.id] });
  assert.equal((await proposeMoves(stores, mine, {}, later)).moves.filter((m) => m.kind === "unblock_wait").length, 1);
});

test("waits: four asks on one close build ONE seven-part join, instead of three silently dropped requests", async () => {
  // THE BUG THIS PREVENTS, and it is the one the join was built for. `chase_receipts` asks the client
  // for four missing receipts by calling the gap route four times. Before this, the first ask parked
  // the engagement and the next three hit the one-live-wait-per-case index, were refused, and were
  // dropped on the floor — `armDeclaredWait` fails soft by design. The close then resumed on receipt
  // ONE and filed a quarter of a month, on time, looking entirely correct. Nothing failed; the books
  // were just wrong.
  const { app, store, domain, projectId, client, kase } = await engagement("Acme — May close");
  const nonce = await runningTask(store, {
    id: `bk-${randomUUID()}`, project_id: projectId, task_type: "chase_receipts",
    client_id: client.id, case_id: kase.id,
  });
  const asks = ["the March receipt", "the April receipt", "the Amex statement", "the Stripe payout"];
  const ids: string[] = [];
  for (const ask of asks) {
    const r = await api(app, "internal/knowledge/gap", {
      method: "POST",
      headers: { authorization: `Bearer ${nonce}` },
      body: JSON.stringify({ question: ask, ask_client: true, kind: "document" }),
    });
    assert.equal(r.json.ok, true);
    assert.ok(r.json.wait_id, `ask "${ask}" parked rather than being dropped`);
    ids.push(r.json.request_id);
  }

  const live = await domain.listWaits({ project_id: projectId, status: "waiting" });
  assert.equal(live.length, 1, "still ONE live wait per case — the index that stops two racing resumes is intact");
  const wait = live[0]!;
  assert.equal(wait.mode, "all");
  assert.equal(wait.conditions.length, 4, "and it is a four-part join, not one ask and three losses");
  // Each part carries the customer's own sentence, so the outstanding list is readable.
  assert.deepEqual(wait.conditions.map((c) => c.label), asks);

  // A repeated ask does not make the join permanently longer than the things outstanding.
  await api(app, "internal/knowledge/gap", {
    method: "POST",
    headers: { authorization: `Bearer ${nonce}` },
    body: JSON.stringify({ question: "the March receipt", ask_client: true, kind: "document" }),
  });
  assert.equal((await domain.getWait(projectId, wait.id))!.conditions.length, 5, "a NEW request row is a new part");
  const dupe = await domain.growWait(projectId, wait.id, wait.conditions[0]!, 12);
  assert.equal(dupe, undefined, "but the SAME request twice is refused — the count must mean something");

  // And the close waits for all of them.
  const spawned = recordingDeps();
  const requests = getRequestStore();
  for (const id of ids.slice(0, 3)) await requests.resolveRequest(projectId, id, "here");
  assert.equal((await sweepWaits({ domain, project_id: projectId })).resumed, 0, "three of five is not a closed month");
  assert.equal(spawned.length, 0);
});

test("intake_only kickoff asks for a brief and does not draft a deposit", async () => {
  const { app, kase } = await engagement("Acme — thin convert");
  const out = await api(app, `cases/${kase.id}/kickoff`, {
    method: "POST",
    body: JSON.stringify({ intake_only: true }),
  });
  assert.equal(out.status, 200, out.text);
  assert.equal(out.json.applied, true);
  assert.ok(!out.json.deposit_invoice, "thin convert must not raise a deposit");
  assert.ok(!out.json.money_plan, "thin convert must not invent a payment plan");
  const requests = out.json.requests as { kind: string; ask: string }[];
  assert.ok(requests.length >= 1, "must ask for something");
  assert.ok(
    requests.every((r) => r.kind !== "connection"),
    "thin convert must not invite connections",
  );
  assert.ok(
    requests.some((r) => /brief/i.test(r.ask) || r.kind === "document" || r.kind === "answer"),
    "intake must survive",
  );
});

test("kickoff parks the engagement on the asks it raised", async () => {
  // Convert used to create ClientRequests and leave the case un-parked, so the wait/resume spine
  // never saw week one. Books-keeper declares waits_for on chase_receipts → monthly_close.
  const { app, domain, projectId, kase } = await engagement("Acme — kickoff");
  const out = await api(app, `cases/${kase.id}/kickoff`, { method: "POST", body: JSON.stringify({ draft_deposit: false }) });
  assert.equal(out.status, 200, out.text);
  assert.equal(out.json.applied, true);
  assert.ok(out.json.wait_id, "kickoff must return the wait it armed");
  assert.ok((out.json.requests as unknown[]).length >= 2, "connection + intake asks");
  const live = await domain.listWaits({ project_id: projectId, status: "waiting" });
  assert.equal(live.length, 1, "one live wait, grown across every kickoff ask");
  assert.equal(live[0]!.mode, "all");
  assert.equal(live[0]!.conditions.length, out.json.requests.length);
  assert.equal(live[0]!.resume.task_type, RESUME_TYPE);
});
