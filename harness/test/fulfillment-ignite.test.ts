// Ignition — the tests that make "a paid, scoped engagement actually starts" a property, not a hope.
//
// Fulfillment was built end to end except for the spark. Each test here names the hole it guards: an
// engagement that never parks on a wait (so nothing ever resumed it), a deposit that arrives with no
// client_request to hear it, a second replica ticking the same sweep and double-spawning the work, a
// GTM case that must never be mistaken for deliverable work. None of these announce themselves — a
// business quietly does nothing, or does a thing twice.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
// loadWedge resolves wedges relative to this env; set it before anything imports the loader.
process.env.MYCEL_WEDGES_DIR ??= join(dirname(fileURLToPath(import.meta.url)), "..", "..", "wedges");

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { api, makeFreshApp } from "./helpers";
import { getDomainStore } from "../src/domain";
import { getBillingStore } from "../src/billing";
import { getRequestStore } from "../src/requests";
import { getDeliverableStore } from "../src/deliverables";
import {
  setIgniteDeps,
  sweepFulfillmentIgnition,
  igniteBackoffMs,
  MAX_IGNITE_ATTEMPTS,
  MAX_BARREN_RUNS,
} from "../src/fulfillment-ignite";
import { wasInterruptedByRestart } from "../src/recovery";

const WEDGE = "books-keeper"; // declares deliverable_shapes + a client_request wait resuming monthly_close
const PRODUCTION_TYPE = "monthly_close";
const NON_FULFILLMENT = "invoice-chaser"; // one operational task type, no deliverable_shapes

/**
 * A project, a client and an open case — the minimum an engagement needs before it can ignite.
 * `makeFreshApp`, not `makeApp`: the domain/billing/requests/deliverable stores are process-wide
 * singletons, and almost every assertion below is a COUNT. A leaked case from the test above turns
 * "ignited exactly one" into "ignited one, plus whatever was lying around".
 */
async function engagement(wedge = WEDGE, title = "Acme — October close") {
  const { app, store } = await makeFreshApp();
  const me = (await api(app, "me")).json;
  const projectId = me.projects[0].id as string;
  const client = (
    await api(app, "clients", {
      method: "POST",
      body: JSON.stringify({ display_name: "Acme", handles: [`acme-${randomUUID()}@x.test`] }),
    })
  ).json;
  const kase = (
    await api(app, "cases", { method: "POST", body: JSON.stringify({ wedge, title, client_id: client.id }) })
  ).json;
  return { app, store, projectId, client, kase, domain: getDomainStore() };
}

/**
 * The spawn half of `IgniteDeps`, recording instead of running. `createServer` registers the real
 * one, so these override it per test. The count of calls IS the exactly-once assertion. Note the
 * stub does NOT persist a task, so a second sweep sees no in-flight task and no deliverable — which
 * means the ONLY thing that can stop a re-ignition is the claim marker. That is deliberate: it puts
 * the marker under test rather than letting the deliverable check quietly cover for it.
 */
function recordingDeps(opts: { enabled?: boolean; throws?: boolean } = {}) {
  const spawned: { project_id: string; task_type: string; case_id?: string; source: string; input: Record<string, unknown> }[] = [];
  setIgniteDeps({
    wedgeEnabled: () => opts.enabled ?? true,
    spawnTask: async (args) => {
      if (opts.throws) throw new Error("queue is down");
      spawned.push(args);
      return `task-${spawned.length}`;
    },
  });
  return spawned;
}

// ── the spark ──────────────────────────────────────────────────────────────────────────────────

test("ignition: a ready, not-started engagement starts its production run", async () => {
  const { domain, store, projectId, kase } = await engagement();
  const spawned = recordingDeps();

  const summary = await sweepFulfillmentIgnition({ domain, store, project_id: projectId });

  assert.equal(summary.ignited, 1, "the one ready engagement ignited");
  assert.equal(spawned.length, 1, "one production run spawned");
  assert.equal(spawned[0].case_id, kase.id, "scoped to the case");
  assert.equal(spawned[0].task_type, PRODUCTION_TYPE, "runs the wedge's production task, not an operational one");
  assert.equal(spawned[0].source, "schedule", "the sweep decided");
  assert.equal(spawned[0].input.because, "intake_satisfied", "no outstanding ask ⇒ intake is the go-signal");
});

test("ignition: a paid deposit starts work even while intake is still outstanding", async () => {
  const { domain, store, projectId, client, kase } = await engagement();
  const spawned = recordingDeps();

  // Intake is NOT satisfied — there is an open ask on the case.
  await getRequestStore().createRequest({
    project_id: projectId,
    client_id: client.id,
    case_id: kase.id,
    kind: "document",
    ask: "Your March bank statement",
  } as never);
  // But the client paid.
  await getBillingStore().createInvoice({
    project_id: projectId,
    client_id: client.id,
    case_id: kase.id,
    currency: "USD",
    lines: [{ description: "deposit", kind: "fixed", amount: 500_00 }],
    status: "paid",
    issue_date: "2026-01-01",
    due_date: "2026-01-15",
  } as never);

  const summary = await sweepFulfillmentIgnition({ domain, store, project_id: projectId });

  assert.equal(summary.ignited, 1, "money is a second, independent go-signal");
  assert.equal(spawned[0].input.because, "deposit_paid");
});

test("ignition: an engagement that is neither answered nor paid does NOT start", async () => {
  const { domain, store, projectId, client, kase } = await engagement();
  const spawned = recordingDeps();

  await getRequestStore().createRequest({
    project_id: projectId,
    client_id: client.id,
    case_id: kase.id,
    kind: "document",
    ask: "Your March bank statement",
  } as never);

  const summary = await sweepFulfillmentIgnition({ domain, store, project_id: projectId });

  assert.equal(summary.ignited, 0);
  assert.equal(summary.not_ready, 1);
  assert.equal(spawned.length, 0);
});

test("ignition: a wedge that produces no deliverable is never ignited", async () => {
  // A GTM/chase case must not be mistaken for work a client reviews. invoice-chaser has one
  // operational task type and no deliverable_shapes, so there is nothing to produce.
  const { domain, store, projectId } = await engagement(NON_FULFILLMENT, "chasing Acme");
  const spawned = recordingDeps();

  const summary = await sweepFulfillmentIgnition({ domain, store, project_id: projectId });

  assert.equal(summary.ignited, 0);
  assert.equal(summary.no_production_type, 1, "named, not silently skipped");
  assert.equal(spawned.length, 0);
});

test("ignition: it fires exactly once — a second sweep in the same window starts nothing", async () => {
  // The stub persists no task and creates no deliverable, so neither the in-flight check nor the
  // deliverable check can cover here. Only the claim marker stops the re-spawn. This is THE test.
  const { domain, store, projectId } = await engagement();
  const spawned = recordingDeps();

  const first = await sweepFulfillmentIgnition({ domain, store, project_id: projectId });
  const second = await sweepFulfillmentIgnition({ domain, store, project_id: projectId });

  assert.equal(first.ignited, 1);
  assert.equal(second.ignited, 0, "the marker refuses a second ignition inside the window");
  assert.equal(spawned.length, 1, "the work was spawned once, not twice");
});

test("ignition: an engagement that already has a deliverable is left alone", async () => {
  const { domain, store, projectId, client, kase } = await engagement();
  const spawned = recordingDeps();

  await getDeliverableStore().createDeliverable({
    project_id: projectId,
    case_id: kase.id,
    client_id: client.id,
    title: "October close",
    kind: "document",
  } as never);

  const summary = await sweepFulfillmentIgnition({ domain, store, project_id: projectId });

  assert.equal(summary.ignited, 0, "production already ran once");
  assert.equal(summary.already_started, 1);
  assert.equal(spawned.length, 0);
});

// ── the close ceremony ───────────────────────────────────────────────────────────────────────────

test("ignition: an engagement closes once every deliverable is accepted", async () => {
  const { domain, store, projectId, client, kase } = await engagement();
  recordingDeps();
  const dstore = getDeliverableStore();

  const d = await dstore.createDeliverable({
    project_id: projectId,
    case_id: kase.id,
    client_id: client.id,
    title: "October close",
    kind: "document",
  } as never);
  // Drive it to accepted (only a client can reach this in production; here we set the terminal state
  // the sweep keys on).
  await dstore.transitionDeliverable(projectId, d.id, "accepted", ["drafting"], new Date().toISOString(), {
    accepted_at: new Date().toISOString(),
  });

  const summary = await sweepFulfillmentIgnition({ domain, store, project_id: projectId });

  assert.equal(summary.closed, 1);
  const after = await domain.getCase(kase.id);
  assert.equal(after?.status, "closed", "all deliverables accepted ⇒ the engagement is done");
});

test("ignition: an engagement with an unaccepted deliverable stays open", async () => {
  const { domain, store, projectId, client, kase } = await engagement();
  recordingDeps();

  await getDeliverableStore().createDeliverable({
    project_id: projectId,
    case_id: kase.id,
    client_id: client.id,
    title: "October close",
    kind: "document",
  } as never); // drafting, not accepted

  const summary = await sweepFulfillmentIgnition({ domain, store, project_id: projectId });

  assert.equal(summary.closed, 0, "a draft is not an acceptance");
  const after = await domain.getCase(kase.id);
  assert.equal(after?.status, "open");
});

test("productionTaskType: geo-monitor runs the weekly report, not a single probe", async () => {
  const { productionTaskType } = await import("../src/fulfillment-ignite");
  assert.equal(await productionTaskType("any", "geo-monitor"), "weekly_report");
});

// ── the retry that had no ceiling ────────────────────────────────────────────────────────────────
//
// The header of `fulfillment-ignite.ts` says the claim marker "does not permanently consume the
// case", so a run that failed and produced no deliverable is retried on the next sweep. Correct
// instinct — a case wedged forever by one transient failure is the worse bug — and with a
// five-minute sweep it had no ceiling.
//
// Production, 2026-09-05: `monthly_close` ran 2,975 times in thirty days against TWO clients,
// peaking at 566 in a day. A monthly deliverable. It was 1,105 of the 2,696 failed tasks on the
// account, and every attempt cost money. With a real customer whose close has a genuine problem —
// a missing feed, a malformed statement — that is 288 charges a day and nobody is told, because
// from the outside every sweep looks like the first one.

/** A finished production task on the case, in whatever state the test needs. */
async function pastRun(
  store: Awaited<ReturnType<typeof engagement>>["store"],
  kase: { id: string; project_id?: string; client_id?: string },
  projectId: string,
  status: "failed" | "succeeded" | "expired",
  at: Date,
  error?: string,
) {
  /**
   * `error` is set HERE and not via `store.setStatus`, which stamps `updated_at` from the wall
   * clock — silently replacing the synthetic time this fixture exists to control, and turning every
   * assertion about backoff windows into an assertion about how long the suite has been running.
   */
  return store.createTask({
    id: `t-${randomUUID()}`,
    project_id: projectId,
    client_id: kase.client_id,
    case_id: kase.id,
    wedge: WEDGE,
    task_type: PRODUCTION_TYPE,
    status,
    error,
    input: {},
    created_at: at.toISOString(),
    updated_at: at.toISOString(),
  } as never);
}

test("ignition: ONE failure still retries on the next sweep — transients must recover fast", async () => {
  // `igniteBackoffMs(1)` is deliberately equal to the sweep interval, so the first retry is as
  // prompt as it always was. A single failed run is usually a blip — a 504, a restarted container —
  // and making the customer wait longer for that would be a regression dressed as a fix. The
  // backoff exists for the case that keeps failing, and it starts biting on the second.
  const { domain, store, projectId, kase } = await engagement();
  const spawned = recordingDeps();
  const failedAt = new Date("2026-09-05T03:00:00.000Z");
  await pastRun(store, kase, projectId, "failed", failedAt);

  const summary = await sweepFulfillmentIgnition({
    domain,
    store,
    project_id: projectId,
    now: new Date(failedAt.getTime() + 5 * 60 * 1000 + 1000),
  });
  assert.equal(spawned.length, 1, "one failure must not delay the retry");
  assert.equal(summary.ignited, 1);
});

test("ignition: the SECOND failure buys a real wait", async () => {
  // This is where the loop used to be. Before the backoff, failure number two was retried five
  // minutes later, and so was number three hundred: `monthly_close` ran 566 times in a day against
  // two clients.
  const { domain, store, projectId, kase } = await engagement();
  const spawned = recordingDeps();
  const base = Date.parse("2026-09-05T03:00:00.000Z");
  await pastRun(store, kase, projectId, "failed", new Date(base));
  await pastRun(store, kase, projectId, "failed", new Date(base + 5 * 60 * 1000));

  // One sweep after the second failure. The backoff is now ten minutes.
  const held = await sweepFulfillmentIgnition({
    domain,
    store,
    project_id: projectId,
    now: new Date(base + 10 * 60 * 1000 + 1000),
  });
  assert.equal(spawned.length, 0, "two failures ⇒ the next sweep must not re-ignite");
  assert.equal(held.ignited, 0);
});

test("ignition: a case recovers once its backoff elapses", async () => {
  // The property worth keeping. A case must not be retired by one bad afternoon — the backoff is a
  // wait, not a verdict.
  const { domain, store, projectId, kase } = await engagement();
  const spawned = recordingDeps();
  const base = Date.parse("2026-09-05T03:00:00.000Z");
  await pastRun(store, kase, projectId, "failed", new Date(base));
  await pastRun(store, kase, projectId, "failed", new Date(base + 5 * 60 * 1000));

  const summary = await sweepFulfillmentIgnition({
    domain,
    store,
    project_id: projectId,
    now: new Date(base + 5 * 60 * 1000 + 11 * 60 * 1000),
  });
  assert.equal(spawned.length, 1, "past the ten-minute backoff the case starts again");
  assert.equal(summary.ignited, 1);
});

test("ignition: the backoff widens and is capped", () => {
  const mins = (n: number) => igniteBackoffMs(n) / 60000;
  assert.deepEqual([1, 2, 3, 4, 5].map(mins), [5, 10, 20, 40, 80]);
  assert.equal(mins(99), 180, "capped at three hours — a wait, not a retirement");
});

test("ignition: a case that keeps failing stops, and says so", async () => {
  const { domain, store, projectId, kase } = await engagement();
  const spawned = recordingDeps();
  const base = Date.parse("2026-09-01T03:00:00.000Z");
  for (let i = 0; i < MAX_IGNITE_ATTEMPTS; i++) {
    await pastRun(store, kase, projectId, "failed", new Date(base + i * 3_600_000));
  }

  // Long past any backoff — the only thing that can hold it now is the attempt ceiling.
  const summary = await sweepFulfillmentIgnition({
    domain,
    store,
    project_id: projectId,
    now: new Date(base + 30 * 24 * 3_600_000),
  });
  assert.equal(spawned.length, 0, `${MAX_IGNITE_ATTEMPTS} consecutive failures must stop the loop`);
  assert.ok(
    summary.failed.some((f) => f.includes(kase.id) && /consecutive/.test(f)),
    `an exhausted case must be NAMED, not folded into a success-shaped counter: ${JSON.stringify(summary.failed)}`,
  );
  assert.equal(summary.already_started, 0, "an exhausted case is not 'already started'");
});

test("ignition: a success resets the run of failures", async () => {
  // Counted consecutively from the most recent backwards. A case that failed five times last week
  // and worked since is on its first attempt, not its sixth — treating it as exhausted would
  // silently retire a working case.
  const { domain, store, projectId, kase } = await engagement();
  const spawned = recordingDeps();
  const base = Date.parse("2026-09-01T03:00:00.000Z");
  for (let i = 0; i < MAX_IGNITE_ATTEMPTS; i++) {
    await pastRun(store, kase, projectId, "failed", new Date(base + i * 3_600_000));
  }
  await pastRun(store, kase, projectId, "succeeded", new Date(base + 10 * 3_600_000));

  const summary = await sweepFulfillmentIgnition({
    domain,
    store,
    project_id: projectId,
    now: new Date(base + 30 * 24 * 3_600_000),
  });
  assert.equal(spawned.length, 1, "the run of failures ended at the success");
  assert.equal(summary.ignited, 1);
});

test("ignition: a deploy killing the run does not count against the case", async () => {
  // ECS SIGKILLs at `stopTimeout` (Fargate caps it at 120s) and a production run is 300-600s, so
  // every deploy lands on somebody's engagement — 120 such rows in one measured day. If those
  // counted, six deploys during one month-end would retire a working case, and the founder would
  // be told it failed six times running when it never failed once.
  const { domain, store, projectId, kase } = await engagement();
  const spawned = recordingDeps();
  const base = Date.parse("2026-09-01T03:00:00.000Z");
  for (let i = 0; i < MAX_IGNITE_ATTEMPTS + 2; i++) {
    await pastRun(store, kase, projectId, "failed", new Date(base + i * 3_600_000),
      "Interrupted by a kernel restart while running. The sandbox it was working in went with it.");
  }

  const summary = await sweepFulfillmentIgnition({
    domain,
    store,
    project_id: projectId,
    now: new Date(base + 30 * 24 * 3_600_000),
  });
  assert.equal(spawned.length, 1, "restart interruptions must not exhaust the case");
  assert.equal(summary.ignited, 1);
  assert.deepEqual(summary.failed, [], "and must not be reported as consecutive failures");
});

test("ignition: a restart does not launder a genuine run of failures", async () => {
  // Skipped, not treated as a success. A case that failed on its merits and was then interrupted
  // by a deploy is still on those failures — otherwise one restart resets the ceiling and the
  // runaway loop comes back.
  const { domain, store, projectId, kase } = await engagement();
  const spawned = recordingDeps();
  const base = Date.parse("2026-09-01T03:00:00.000Z");
  for (let i = 0; i < MAX_IGNITE_ATTEMPTS; i++) {
    await pastRun(store, kase, projectId, "failed", new Date(base + i * 3_600_000));
  }
  await pastRun(store, kase, projectId, "failed", new Date(base + 20 * 3_600_000),
    "Interrupted by a kernel restart while running.");

  const summary = await sweepFulfillmentIgnition({
    domain,
    store,
    project_id: projectId,
    now: new Date(base + 30 * 24 * 3_600_000),
  });
  assert.equal(spawned.length, 0, "the six real failures underneath still count");
  assert.ok(summary.failed.some((f) => /consecutive/.test(f)));
});

test("recovery reasons are the strings the ignite counter looks for", () => {
  // The two modules agree via exported constants rather than by both hardcoding prose. If the
  // wording drifts on one side, this fails rather than the counter silently starting to count
  // deploys again.
  assert.ok(wasInterruptedByRestart("Interrupted by a kernel restart while running. …"));
  assert.ok(wasInterruptedByRestart("Never started. This run was still waiting its turn …"));
  assert.equal(wasInterruptedByRestart("the run stopped responding — no activity for 15 minutes"), false);
  assert.equal(wasInterruptedByRestart(undefined), false);
});

test("ignition: retiring a case is recorded ON the case, not only in a summary field", async () => {
  // The first version of this pushed a line into `summary.failed` and stopped. NOTHING reads
  // `summary.failed`: scheduler.ts logs `skipped_because` and returns
  // `{ idle: ignited === 0 && closed === 0 }`, so retiring a case made the sweep report itself MORE
  // idle — healthier — at the moment it gave up on somebody's engagement.
  const { domain, store, projectId, kase } = await engagement();
  recordingDeps();
  const base = Date.parse("2026-09-01T03:00:00.000Z");
  for (let i = 0; i < MAX_IGNITE_ATTEMPTS; i++) {
    await pastRun(store, kase, projectId, "failed", new Date(base + i * 3_600_000));
  }

  const summary = await sweepFulfillmentIgnition({
    domain, store, project_id: projectId, now: new Date(base + 30 * 24 * 3_600_000),
  });

  assert.equal(summary.exhausted, 1, "the sweep must count it");
  const after = (await domain.listCases({ project_id: projectId, status: "open" })).find((c) => c.id === kase.id);
  assert.ok(after?.data?.ignition_retired_at, "the case must carry when it was retired");
  assert.equal(after?.data?.ignition_failures, MAX_IGNITE_ATTEMPTS, "and how many failures did it");
  assert.ok(
    (after?.history ?? []).some((e) => /consecutive failures/.test(e.note ?? "")),
    "and its history must say so in a sentence a person can read",
  );
});

test("ignition: the retirement is written once, not once per sweep", async () => {
  // This sweep runs every five minutes. An event per sweep buries the case history it explains.
  const { domain, store, projectId, kase } = await engagement();
  recordingDeps();
  const base = Date.parse("2026-09-01T03:00:00.000Z");
  for (let i = 0; i < MAX_IGNITE_ATTEMPTS; i++) {
    await pastRun(store, kase, projectId, "failed", new Date(base + i * 3_600_000));
  }
  const at = new Date(base + 30 * 24 * 3_600_000);
  await sweepFulfillmentIgnition({ domain, store, project_id: projectId, now: at });
  await sweepFulfillmentIgnition({ domain, store, project_id: projectId, now: at });
  await sweepFulfillmentIgnition({ domain, store, project_id: projectId, now: at });

  const after = (await domain.listCases({ project_id: projectId, status: "open" })).find((c) => c.id === kase.id);
  const notes = (after?.history ?? []).filter((e) => /consecutive failures/.test(e.note ?? ""));
  assert.equal(notes.length, 1, `three sweeps wrote ${notes.length} events`);
});

test("ignition: a case waiting out a backoff is not counted as started", async () => {
  // `backoff` and `in_flight` are different facts. Folding the first into `already_started` claims
  // work is underway when none is.
  const { domain, store, projectId, kase } = await engagement();
  recordingDeps();
  const base = Date.parse("2026-09-05T03:00:00.000Z");
  await pastRun(store, kase, projectId, "failed", new Date(base));
  await pastRun(store, kase, projectId, "failed", new Date(base + 5 * 60 * 1000));

  const s = await sweepFulfillmentIgnition({
    domain, store, project_id: projectId, now: new Date(base + 10 * 60 * 1000 + 1000),
  });
  assert.equal(s.backing_off, 1, "it is backing off");
  assert.equal(s.already_started, 0, "and it has emphatically not started");
});

test("ignition: a restart-killed retry still serves the backoff the case earned", async () => {
  // The clock is set by the newest attempt of ANY kind; only the COUNT skips restarts. Setting the
  // clock from genuine failures alone leaves a case with real failures behind it re-igniting every
  // five minutes forever, as long as each retry is killed by a deploy — and cfe29b4d measured 37 of
  // the last 38 failures as restart rows, so that is the common case.
  const { domain, store, projectId, kase } = await engagement();
  const spawned = recordingDeps();
  const base = Date.parse("2026-09-05T03:00:00.000Z");
  // Three real failures ⇒ a 20-minute backoff.
  for (let i = 0; i < 3; i++) await pastRun(store, kase, projectId, "failed", new Date(base + i * 60_000));
  // Then a retry killed by a deploy, one minute ago.
  await pastRun(store, kase, projectId, "failed", new Date(base + 30 * 60_000),
    "Interrupted by a kernel restart while running.");

  const held = await sweepFulfillmentIgnition({
    domain, store, project_id: projectId, now: new Date(base + 31 * 60_000),
  });
  assert.equal(spawned.length, 0, "the earned backoff must still be served from the latest attempt");
  assert.equal(held.backing_off, 1);

  // And once it elapses, it goes again — the restart did not retire it.
  const go = await sweepFulfillmentIgnition({
    domain, store, project_id: projectId, now: new Date(base + 55 * 60_000),
  });
  assert.equal(spawned.length, 1, "past the backoff it starts again");
  assert.equal(go.ignited, 1);
});

test("ignition: a retired case can be brought back", async () => {
  // `ignition_retired_at` is a RECORD of a decision, not the decision. The gate is
  // `failures >= MAX_IGNITE_ATTEMPTS`, recomputed from task history every sweep — so clearing the
  // field alone does nothing and the next sweep writes it straight back.
  //
  // Which meant no retired case could ever be un-retired, by anyone. And the failures that retire a
  // case are frequently not the case's fault: two real ones were retired by a provider hang that was
  // fixed twenty minutes later, and they stayed retired through the fix. A halt with no way back.
  const { domain, store, projectId, kase } = await engagement();
  const spawned = recordingDeps();
  const base = Date.parse("2026-09-01T03:00:00.000Z");
  for (let i = 0; i < MAX_IGNITE_ATTEMPTS; i++) {
    await pastRun(store, kase, projectId, "failed", new Date(base + i * 3_600_000));
  }

  const retired = await sweepFulfillmentIgnition({
    domain, store, project_id: projectId, now: new Date(base + 10 * 3_600_000),
  });
  assert.equal(retired.exhausted, 1, "precondition: the case is retired");
  assert.equal(spawned.length, 0);

  // Re-arm: clear the record AND mark where counting restarts.
  await domain.updateCase(kase.id, {
    data: { ignition_rearmed_at: new Date(base + 11 * 3_600_000).toISOString() },
  });

  const back = await sweepFulfillmentIgnition({
    domain, store, project_id: projectId, now: new Date(base + 12 * 3_600_000),
  });
  assert.equal(spawned.length, 1, "a re-armed case must actually start again");
  assert.equal(back.exhausted, 0, "and must not be retired on the same sweep that revived it");
});

test("ignition: re-arming does not forgive failures that came after it", async () => {
  // The boundary is a line, not an amnesty. Six fresh failures after a re-arm retire the case
  // again — otherwise one re-arm makes a case permanently un-retirable and the runaway loop the
  // ceiling exists to stop comes back through the back door.
  const { domain, store, projectId, kase } = await engagement();
  const spawned = recordingDeps();
  const base = Date.parse("2026-09-01T03:00:00.000Z");
  await domain.updateCase(kase.id, { data: { ignition_rearmed_at: new Date(base).toISOString() } });
  for (let i = 1; i <= MAX_IGNITE_ATTEMPTS; i++) {
    await pastRun(store, kase, projectId, "failed", new Date(base + i * 3_600_000));
  }

  const s = await sweepFulfillmentIgnition({
    domain, store, project_id: projectId, now: new Date(base + 30 * 3_600_000),
  });
  assert.equal(spawned.length, 0, "fresh failures after a re-arm must still count");
  assert.equal(s.exhausted, 1);
});

// ── waiting on the client ──────────────────────────────────────────────────────────────────────

/**
 * MEASURED IN PRODUCTION: 3,077 `monthly_close` runs across TWO engagements in fourteen days — one
 * every thirty-one minutes, each refusing for the same missing bank statement, each costing a model
 * call. Both real `monthly_close` schedules were disabled and had never fired; every run came from
 * this sweep.
 *
 * Nothing was broken in the backoff. `productionHoldoff` counts consecutive FAILURES and a run that
 * ends in `ask` SUCCEEDS — correctly, it did its job and discovered it could not proceed. But a
 * successful run with no deliverable leaves the sweep nothing to see, so the case still looks
 * un-started and is started again on the next pass, with no counter anywhere reaching a ceiling.
 *
 * And `readyReason` does not catch it: its first act IS to list open asks, but when there are some
 * it falls through to the money, and a paid deposit wins. That is right about the ENGAGEMENT and
 * silent about the RUN. Both burning cases had a paid deposit.
 */
test("ignition: a case whose run already asked the client is a wait, not a restart", async () => {
  const { domain, store, projectId, client, kase } = await engagement();
  const spawned = recordingDeps();
  // Same shape the paid-deposit test above uses — a paid invoice is what makes `readyReason` say go.
  await getBillingStore().createInvoice({
    project_id: projectId,
    client_id: client.id,
    case_id: kase.id,
    currency: "USD",
    lines: [{ description: "deposit", kind: "fixed", amount: 500_00 }],
    status: "paid",
    issue_date: "2026-01-01",
    due_date: "2026-01-15",
  } as never);

  // A previous run stopped for want of a statement. `task_id` is what marks it as a RUN's ask.
  await getRequestStore().createRequest({
    project_id: projectId,
    client_id: client.id,
    case_id: kase.id,
    kind: "document",
    ask: "Your March bank statement",
    party_role: "client",
    task_id: "task-that-stopped",
  } as never);

  const first = await sweepFulfillmentIgnition({ domain, store, project_id: projectId });
  assert.equal(first.ignited, 0, "it started a run whose inputs it already knows are missing");
  assert.equal(first.waiting_on_client, 1, "the wait is not counted, so nothing can report it");
  assert.equal(spawned.length, 0, "a model call was spent on a run that cannot succeed");

  // And it must not be a permanent halt — this is the failure shape this file keeps naming.
  const open = await getRequestStore().listRequests({ project_id: projectId, case_id: kase.id, status: "open" });
  await getRequestStore().resolveRequest(projectId, open[0]!.id, "attached");
  const after = await sweepFulfillmentIgnition({ domain, store, project_id: projectId });
  assert.equal(after.ignited, 1, "answering the question did not release the engagement");
  assert.equal(spawned.length, 1);
});

test("ignition: a kickoff ask does not stop an engagement making its first attempt", async () => {
  /**
   * The gate is scoped to asks carrying `task_id`, which `openMaterialRequests` sets and nothing
   * else does: it means A RUN STOPPED ON THIS. Kickoff's own asks — the statement requested when
   * the engagement opened, the decision confirming scope — deliberately carry none, because a fresh
   * engagement is entitled to try. Gating on those too would mean a case could never start while
   * any intake ask was outstanding, which is the opposite failure and looks identical from outside.
   */
  const { domain, store, projectId, client, kase } = await engagement();
  const spawned = recordingDeps();
  // Same shape the paid-deposit test above uses — a paid invoice is what makes `readyReason` say go.
  await getBillingStore().createInvoice({
    project_id: projectId,
    client_id: client.id,
    case_id: kase.id,
    currency: "USD",
    lines: [{ description: "deposit", kind: "fixed", amount: 500_00 }],
    status: "paid",
    issue_date: "2026-01-01",
    due_date: "2026-01-15",
  } as never);

  await getRequestStore().createRequest({
    project_id: projectId,
    client_id: client.id,
    case_id: kase.id,
    kind: "document",
    ask: "Your most recent bank statement",
    party_role: "client",
    // no task_id — this is kickoff's, not a run's
  } as never);

  const sweep = await sweepFulfillmentIgnition({ domain, store, project_id: projectId });
  assert.equal(sweep.waiting_on_client, 0, "a kickoff ask was mistaken for a stopped run");
  assert.equal(sweep.ignited, 1, "the engagement can never make its first attempt");
});


// ── runs that finish and produce nothing ─────────────────────────────────────────────────────────
//
// The 3,077-run incident was built entirely out of SUCCEEDING runs. `MAX_IGNITE_ATTEMPTS` counts
// failures and never moved; `waitingOnClient` closes one reason a run produces nothing, not the
// class. These cover the backstop.

test("ignition: a case whose runs finish and produce nothing is retired, not re-ignited forever", async () => {
  const { domain, store, projectId, kase } = await engagement();
  const spawned = recordingDeps();
  const base = Date.parse("2026-09-05T03:00:00.000Z");
  // Runs that SUCCEEDED. No failure, so no backoff and no exhaustion — and no deliverable, so the
  // case looks un-started on every single sweep. This is the exact shape that burned 3,077 runs.
  for (let i = 0; i < MAX_BARREN_RUNS; i++) {
    await pastRun(store, kase, projectId, "succeeded", new Date(base + i * 3_600_000));
  }

  const s = await sweepFulfillmentIgnition({
    domain, store, project_id: projectId, now: new Date(base + 4 * 3_600_000),
  });

  assert.equal(spawned.length, 0, "a fourth run would do exactly what the first three did");
  assert.equal(s.producing_nothing, 1);
  assert.equal(s.ignited, 0);
  assert.equal(s.exhausted, 0, "nothing failed; calling this exhaustion sends the founder to the wrong place");
});

test("ignition: below the ceiling it still tries — a transient empty run is not a retirement", async () => {
  const { domain, store, projectId, kase } = await engagement();
  const spawned = recordingDeps();
  const base = Date.parse("2026-09-05T03:00:00.000Z");
  for (let i = 0; i < MAX_BARREN_RUNS - 1; i++) {
    await pastRun(store, kase, projectId, "succeeded", new Date(base + i * 3_600_000));
  }

  const s = await sweepFulfillmentIgnition({
    domain, store, project_id: projectId, now: new Date(base + 4 * 3_600_000),
  });

  assert.equal(spawned.length, 1, "the ceiling must leave room for a genuine retry");
  assert.equal(s.producing_nothing, 0);
  assert.equal(s.ignited, 1);
});

test("ignition: the barren ceiling counts totals, so an intervening failure does not reset it", async () => {
  // Consecutive is right for failures — an intervening success proves the case works. Nothing
  // proves that here: the only evidence production works is a deliverable, and there is none.
  const { domain, store, projectId, kase } = await engagement();
  const spawned = recordingDeps();
  const base = Date.parse("2026-09-05T03:00:00.000Z");
  await pastRun(store, kase, projectId, "succeeded", new Date(base));
  await pastRun(store, kase, projectId, "failed", new Date(base + 3_600_000));
  await pastRun(store, kase, projectId, "succeeded", new Date(base + 2 * 3_600_000));
  await pastRun(store, kase, projectId, "succeeded", new Date(base + 3 * 3_600_000));

  const s = await sweepFulfillmentIgnition({
    domain, store, project_id: projectId, now: new Date(base + 30 * 3_600_000),
  });

  assert.equal(spawned.length, 0, "three completed runs produced nothing, whatever happened between them");
  assert.equal(s.producing_nothing, 1);
});

test("ignition: a case that HAS a deliverable never reaches the barren ceiling", async () => {
  // The ceiling reads every completed run as barren, which is only true because the caller has
  // already returned for any case with something to show. THIS test is what makes that safe: it
  // pins the early-continue the ceiling depends on. A delivered case that ran several times must
  // read as `already_started`, not as a case producing nothing.
  const { domain, store, projectId, client, kase } = await engagement();
  const spawned = recordingDeps();
  const base = Date.parse("2026-09-05T03:00:00.000Z");
  for (let i = 0; i < MAX_BARREN_RUNS + 2; i++) {
    await pastRun(store, kase, projectId, "succeeded", new Date(base + i * 3_600_000));
  }
  await getDeliverableStore().createDeliverable({
    project_id: projectId,
    case_id: kase.id,
    client_id: client.id,
    title: "October close",
    kind: "document",
  } as never);

  const s = await sweepFulfillmentIgnition({
    domain, store, project_id: projectId, now: new Date(base + 30 * 3_600_000),
  });

  assert.equal(spawned.length, 0);
  assert.equal(s.already_started, 1);
  assert.equal(s.producing_nothing, 0, "it produced something; the ceiling must not fire");
});

test("ignition: a genuinely erroring case is reported as erroring, not as producing nothing", async () => {
  // Both verdicts retire the case. They must not be confused: "six consecutive failures" and
  // "three runs that produced nothing" send a founder to completely different places.
  const { domain, store, projectId, kase } = await engagement();
  recordingDeps();
  const base = Date.parse("2026-09-05T03:00:00.000Z");
  for (let i = 0; i < MAX_IGNITE_ATTEMPTS; i++) {
    await pastRun(store, kase, projectId, "failed", new Date(base + i * 3_600_000));
  }

  const s = await sweepFulfillmentIgnition({
    domain, store, project_id: projectId, now: new Date(base + 30 * 24 * 3_600_000),
  });

  assert.equal(s.exhausted, 1);
  assert.equal(s.producing_nothing, 0, "failures take precedence over the barren backstop");
});

test("ignition: retiring for producing nothing says so on the case, and can be re-armed", async () => {
  const { domain, store, projectId, kase } = await engagement();
  const spawned = recordingDeps();
  const base = Date.parse("2026-09-05T03:00:00.000Z");
  for (let i = 0; i < MAX_BARREN_RUNS; i++) {
    await pastRun(store, kase, projectId, "succeeded", new Date(base + i * 3_600_000));
  }
  const at = new Date(base + 4 * 3_600_000);
  await sweepFulfillmentIgnition({ domain, store, project_id: projectId, now: at });

  const after = (await domain.listCases({ project_id: projectId, status: "open" })).find((c) => c.id === kase.id);
  assert.ok(after?.data?.ignition_retired_at, "the decision has to live on the record");
  assert.equal(after?.data?.ignition_retired_reason, "producing_nothing");
  const note = (after?.history ?? []).map((e) => e.note ?? "").join(" ");
  assert.match(note, /produced no deliverable/, "the note must name what actually happened");
  assert.doesNotMatch(note, /consecutive failures/, "nothing failed");

  // ── and it is not a trap ── clearing the pair gives the case a clean slate.
  await domain.updateCase(
    kase.id,
    { data: { ...after?.data, ignition_retired_at: undefined, ignition_rearmed_at: new Date(base + 5 * 3_600_000).toISOString() } },
    { at: at.toISOString(), kind: "note", note: "re-armed by hand", actor: "founder" },
  );
  const back = await sweepFulfillmentIgnition({
    domain, store, project_id: projectId, now: new Date(base + 6 * 3_600_000),
  });
  assert.equal(back.ignited, 1, "a re-armed case must get a clean slate");
  assert.equal(spawned.length, 1);
});
