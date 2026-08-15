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
import { setIgniteDeps, sweepFulfillmentIgnition } from "../src/fulfillment-ignite";

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
