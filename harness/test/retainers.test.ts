// RETAINERS — recurring revenue, and the one bug that charges a real client twice.
//
// Every test here names the bug it prevents, and each is mutation-checked: I broke the guard it
// covers and confirmed the test goes red before writing the next one.
//
// THE GAP THESE TESTS CLOSE. `"retainer"` was a string in a union type. A retainer line had no
// cadence, no anchor and no next-due; its status was a one-way ratchet, so it billed exactly ONCE
// ever; no scheduler branch created an invoice; and deliverable acceptance picked "the first planned
// line in array order", which on a plan of twelve monthly lines billed an arbitrary month.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { freshProjectId, makeFreshApp } from "./helpers";
import { getDomainStore } from "../src/domain";
import { _resetBilling, getBillingStore } from "../src/billing";
import {
  addPeriod,
  billRetainerPeriod,
  ensureRetainerSchedule,
  nextRetainerDue,
  proratedAmount,
  retainerPeriodsDue,
  setRetainer,
  sweepRetainers,
  RETAINER_SWEEP_TASK_TYPE,
} from "../src/money-plan.retainer";
import {
  lineForAcceptedDeliverable,
  moneyPlanFromTemplate,
  readMoneyPlan,
  writeMoneyPlan,
  type MoneyPlan,
  type RetainerRecurrence,
} from "../src/money-plan";
import { fireSchedule } from "../src/scheduler";
import { ensureUpkeep } from "../src/upkeep";
import { InMemoryStore } from "../src/store";

/** A monthly retainer anchored on `anchor`, priced at `amount`, on a fresh case in `projectId`. */
async function seedRetainer(opts: {
  project_id: string;
  amount_minor?: number;
  anchor: string;
  rec?: Partial<RetainerRecurrence>;
  currency?: string;
}) {
  const domain = getDomainStore();
  const client = await domain.createClient({ project_id: opts.project_id, handles: [`c-${randomUUID()}@example.com`] } as never);
  const plan: MoneyPlan = moneyPlanFromTemplate(opts.currency ?? "USD", [
    { label: "Monthly retainer", amount_minor: opts.amount_minor ?? 120_000, kind: "retainer" },
  ]);
  plan.lines[0] = {
    ...plan.lines[0]!,
    recurrence: { every: "month", interval: 1, anchor: opts.anchor, state: "active", ...opts.rec },
  };
  const kase = await domain.createCase({
    project_id: opts.project_id,
    client_id: client.id,
    wedge: "books-keeper",
    title: "Retainer engagement",
    stage: "delivery",
    status: "open",
    data: writeMoneyPlan({}, plan),
  } as never);
  return { kase, client, line: plan.lines[0]! };
}

const invoicesFor = async (projectId: string) =>
  getBillingStore().listInvoices({ project_id: projectId, limit: 100 });

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The period calendar. Pure functions, so the awkward part is testable without waiting on time.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

test("a monthly retainer's period boundaries clamp instead of drifting (31 Jan → 28 Feb → 31 Mar)", () => {
  // THE BUG: rolling the 31st into 2 March would move every later period key by a day or two, and
  // the period key is the ONLY thing standing between a client and a second invoice for March.
  assert.equal(addPeriod("2026-01-31", { every: "month", interval: 1 }), "2026-02-28");
  assert.equal(addPeriod("2026-02-28", { every: "month", interval: 1 }), "2026-03-28");
  assert.equal(addPeriod("2024-01-31", { every: "month", interval: 1 }), "2024-02-29", "leap year");
  assert.equal(addPeriod("2026-11-15", { every: "month", interval: 3 }), "2027-02-15", "quarterly crosses the year");
  assert.equal(addPeriod("2026-03-02", { every: "week", interval: 2 }), "2026-03-16");
});

test("proration is exact integer minor units — nothing divides by 100 and nothing rounds a float", () => {
  // THE BUG: `Math.round(amount * days / total)` is a float division. These cases pin the exact
  // arithmetic, including the half-up boundary, so a "tidy-up" back to floats fails here.
  assert.equal(proratedAmount(120_000, 20, 31), 77_419, "120000 * 20 / 31 = 77419.35…");
  assert.equal(proratedAmount(100, 1, 2), 50, "exact halves need no rounding");
  assert.equal(proratedAmount(101, 1, 2), 51, "half rounds up, consistently");
  assert.equal(proratedAmount(120_000, 31, 31), 120_000, "a full period is never prorated down");
  assert.equal(proratedAmount(120_000, 40, 31), 120_000, "and never up");
  assert.equal(proratedAmount(1, 1, 31), 0, "a penny over a month is zero, not 0.03");
  // JPY has no minor unit at all: the number IS the yen. Proration must stay an integer there too.
  assert.equal(proratedAmount(50_000, 15, 30), 25_000);
});

test("a period is due when it STARTS, and the catch-up window is bounded", () => {
  const rec: RetainerRecurrence = { every: "month", interval: 1, anchor: "2026-01-01", state: "active" };
  // THE BUG a bound prevents: a retainer anchored a year ago (a restored backup, a typo'd year)
  // firing twelve invoices into one client's inbox on the morning the sweep first sees it.
  const due = retainerPeriodsDue(rec, "2026-12-15");
  assert.equal(due.length, 3, "never more than the catch-up window");
  assert.deepEqual(due.map((p) => p.start), ["2026-10-01", "2026-11-01", "2026-12-01"], "the RECENT periods, not the oldest");
  assert.equal(retainerPeriodsDue(rec, "2025-12-31").length, 0, "nothing is due before the anchor");
  assert.equal(retainerPeriodsDue(rec, "2026-01-01")[0]!.start, "2026-01-01", "billed in advance, on the day it starts");
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The guarantee: once per period, ever.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

test("a retainer bills once per period and never twice — not across a restart, not across two replicas", async () => {
  // THE BUG THIS FILE EXISTS FOR. A duplicate invoice is discovered in the next month, by the
  // client, usually by their accountant.
  await makeFreshApp();
  _resetBilling();
  const projectId = freshProjectId("retainer-once");
  const { kase } = await seedRetainer({ project_id: projectId, anchor: "2026-03-01" });
  const now = new Date("2026-03-05T09:00:00Z");

  const first = await sweepRetainers({ domain: getDomainStore(), project_id: projectId, now });
  assert.equal(first.billed, 1, "March is billed once");

  // A SECOND REPLICA: the same sweep, on the same clock, against the same store, with no knowledge
  // that the first one ran. This is what four containers behind a load balancer actually do.
  const second = await sweepRetainers({ domain: getDomainStore(), project_id: projectId, now });
  assert.equal(second.billed, 0, "the second replica drafts nothing");
  assert.equal(second.already_billed, 1, "and says why — the ledger, not an error");

  // A RESTART: a fresh case object read back from the store, a later clock inside the same period.
  const reread = (await getDomainStore().getCase(kase.id))!;
  const rec = readMoneyPlan(reread.data)!.lines[0]!;
  const again = await billRetainerPeriod({
    domain: getDomainStore(),
    kase: reread,
    line: rec,
    period: retainerPeriodsDue(rec.recurrence!, "2026-03-20")[0]!,
    now: new Date("2026-03-20T09:00:00Z"),
  });
  assert.equal(again.ok, false);
  assert.equal(again.ok === false && again.reason, "already_billed");

  const invoices = await invoicesFor(projectId);
  assert.equal(invoices.length, 1, "ONE invoice for March, after three attempts to bill it");
  assert.equal(invoices[0]!.status, "draft", "and it reached nobody — a human still issues it");
  assert.equal(invoices[0]!.lines[0]!.unit_amount, 120_000);

  // The next period is a different key, so the clock keeps running.
  const april = await sweepRetainers({
    domain: getDomainStore(),
    project_id: projectId,
    now: new Date("2026-04-02T09:00:00Z"),
  });
  assert.equal(april.billed, 1, "April bills — once per period, not once ever");
  assert.equal((await invoicesFor(projectId)).length, 2);
});

test("two sweeps racing the same period produce one invoice (the claim, not a check)", async () => {
  // THE BUG: any "have we billed March?" read followed by a write has a window, and the two things
  // that fit through it are both real — a founder's button landing on the schedule's tick.
  await makeFreshApp();
  _resetBilling();
  const projectId = freshProjectId("retainer-race");
  await seedRetainer({ project_id: projectId, anchor: "2026-05-01" });
  const now = new Date("2026-05-01T00:00:01Z");
  const [a, b, c] = await Promise.all([
    sweepRetainers({ domain: getDomainStore(), project_id: projectId, now }),
    sweepRetainers({ domain: getDomainStore(), project_id: projectId, now }),
    sweepRetainers({ domain: getDomainStore(), project_id: projectId, now }),
  ]);
  assert.equal(a!.billed + b!.billed + c!.billed, 1, "exactly one of three concurrent sweeps wins");
  assert.equal((await invoicesFor(projectId)).length, 1);
});

test("a claim whose draft throws is given back, so the month is not silently lost", async () => {
  // THE BUG: a claim is a loan taken to serialise replicas, not a record that a client was billed.
  // A claim never returned is a month of the founder's revenue that disappears without a sound.
  await makeFreshApp();
  _resetBilling();
  const projectId = freshProjectId("retainer-release");
  const { kase, line } = await seedRetainer({ project_id: projectId, anchor: "2026-06-01" });
  const billing = getBillingStore();
  const realCreate = billing.createInvoice.bind(billing);
  billing.createInvoice = async () => {
    throw new Error("billing store is down");
  };
  const period = retainerPeriodsDue(line.recurrence!, "2026-06-03")[0]!;
  const failed = await billRetainerPeriod({
    domain: getDomainStore(),
    kase,
    line,
    period,
    now: new Date("2026-06-03T09:00:00Z"),
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.ok === false && failed.reason, "draft_failed", "and it is NOT reported as billed");
  assert.equal(
    (await billing.listRetainerPeriods({ project_id: projectId })).length,
    0,
    "the claim was released",
  );
  billing.createInvoice = realCreate;
  const retried = await sweepRetainers({
    domain: getDomainStore(),
    project_id: projectId,
    now: new Date("2026-06-04T09:00:00Z"),
  });
  assert.equal(retried.billed, 1, "the next sweep picks June back up");
});

test("a retainer cannot bill across tenants", async () => {
  // THE BUG: two cross-tenant leaks have shipped in this repo. A retainer is a STANDING instruction
  // to invoice somebody every month, so a leak here is not one wrong invoice, it is one a month.
  await makeFreshApp();
  _resetBilling();
  const mine = freshProjectId("retainer-mine");
  const theirs = freshProjectId("retainer-theirs");
  await seedRetainer({ project_id: mine, anchor: "2026-07-01" });
  await seedRetainer({ project_id: theirs, anchor: "2026-07-01", amount_minor: 999_999 });
  const now = new Date("2026-07-02T09:00:00Z");

  const swept = await sweepRetainers({ domain: getDomainStore(), project_id: mine, now });
  assert.equal(swept.billed, 1, "only my retainer");
  const mineInvoices = await invoicesFor(mine);
  const theirsInvoices = await invoicesFor(theirs);
  assert.equal(mineInvoices.length, 1);
  assert.equal(theirsInvoices.length, 0, "the other tenant's client was not invoiced");
  assert.equal(mineInvoices[0]!.project_id, mine);

  // And the sweep refuses to run unscoped rather than defaulting to "everything".
  await assert.rejects(
    () => sweepRetainers({ domain: getDomainStore(), project_id: "", now }),
    /scoped to a project/,
  );
  // The ledger is scoped too: my project cannot read the other tenant's billed periods.
  await sweepRetainers({ domain: getDomainStore(), project_id: theirs, now });
  const ledger = await getBillingStore().listRetainerPeriods({ project_id: mine });
  assert.equal(ledger.length, 1);
  assert.ok(ledger.every((r) => r.project_id === mine));
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Stopping. A retainer that cannot be stopped is worse than one that never starts.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

test("a paused retainer stops billing, and resuming never back-bills the gap", async () => {
  // THE BUG: un-pausing a retainer that was off for three months and finding three invoices in the
  // client's inbox that morning.
  await makeFreshApp();
  _resetBilling();
  const projectId = freshProjectId("retainer-pause");
  const { kase, line } = await seedRetainer({ project_id: projectId, anchor: "2026-01-01" });
  const domain = getDomainStore();

  await sweepRetainers({ domain, project_id: projectId, now: new Date("2026-01-02T09:00:00Z") });
  assert.equal((await invoicesFor(projectId)).length, 1, "January billed");

  const paused = await setRetainer({
    domain,
    kase: (await domain.getCase(kase.id))!,
    line_id: line.id,
    patch: { state: "paused" },
    today: "2026-01-15",
  });
  assert.match(paused.note ?? "", /paused/);
  for (const day of ["2026-02-02", "2026-03-02", "2026-04-02"]) {
    const s = await sweepRetainers({ domain, project_id: projectId, now: new Date(`${day}T09:00:00Z`) });
    assert.equal(s.billed, 0, `nothing billed on ${day}`);
    assert.equal(s.stopped, 1, "and the summary says the retainer is stopped, not that there was no work");
  }
  assert.equal((await invoicesFor(projectId)).length, 1, "three months paused, one invoice");

  const resumed = await setRetainer({
    domain,
    kase: (await domain.getCase(kase.id))!,
    line_id: line.id,
    patch: { state: "active" },
    today: "2026-04-10",
  });
  assert.match(resumed.note ?? "", /not billed retrospectively/);
  const after = await sweepRetainers({ domain, project_id: projectId, now: new Date("2026-05-02T09:00:00Z") });
  assert.equal(after.billed, 1, "May bills");
  assert.equal((await invoicesFor(projectId)).length, 2, "February, March and April never arrive");
});

test("an ended retainer stops for good, and closing the engagement stops it too", async () => {
  // THE BUG: a client offboarded in March receiving an April invoice because somebody ended the
  // engagement but not the money-plan line.
  await makeFreshApp();
  _resetBilling();
  const projectId = freshProjectId("retainer-end");
  const domain = getDomainStore();
  const ended = await seedRetainer({ project_id: projectId, anchor: "2026-01-01" });
  const closed = await seedRetainer({ project_id: projectId, anchor: "2026-01-01" });

  const out = await setRetainer({
    domain,
    kase: ended.kase,
    line_id: ended.line.id,
    patch: { state: "ended" },
    today: "2026-01-10",
  });
  assert.match(out.note ?? "", /credit note/, "the founder is told that ending does not refund");
  await domain.updateCase(closed.kase.id, { status: "closed" });

  const swept = await sweepRetainers({ domain, project_id: projectId, now: new Date("2026-02-02T09:00:00Z") });
  assert.equal(swept.billed, 0);
  assert.equal((await invoicesFor(projectId)).length, 0, "neither the ended nor the closed one billed");
  const rec = readMoneyPlan((await domain.getCase(ended.kase.id))!.data)!.lines[0]!.recurrence!;
  assert.equal(nextRetainerDue(rec, "2026-02-02"), undefined, "and the founder's screen says: never");
});

test("a mid-cycle price change takes effect on the NEXT period and cannot rewrite a billed one", async () => {
  // THE BUG: repricing a retainer silently changing an invoice the client has already received.
  await makeFreshApp();
  _resetBilling();
  const projectId = freshProjectId("retainer-reprice");
  const domain = getDomainStore();
  const { kase, line } = await seedRetainer({ project_id: projectId, anchor: "2026-01-01", amount_minor: 100_000 });
  await sweepRetainers({ domain, project_id: projectId, now: new Date("2026-01-02T09:00:00Z") });

  await setRetainer({
    domain,
    kase: (await domain.getCase(kase.id))!,
    line_id: line.id,
    patch: { amount_minor: 150_000 },
    today: "2026-01-20",
  });
  await sweepRetainers({ domain, project_id: projectId, now: new Date("2026-02-02T09:00:00Z") });

  const invoices = (await invoicesFor(projectId)).sort((a, b) => a.issue_date!.localeCompare(b.issue_date!));
  assert.equal(invoices.length, 2);
  assert.equal(invoices[0]!.lines[0]!.unit_amount, 100_000, "January keeps the price it was billed at");
  assert.equal(invoices[1]!.lines[0]!.unit_amount, 150_000, "February takes the new one");
});

test("an aligned first period is billed pro rata, and only the first", async () => {
  await makeFreshApp();
  _resetBilling();
  const projectId = freshProjectId("retainer-prorate");
  const domain = getDomainStore();
  // Engagement starts on the 12th; the founder wants billing on the 1st from then on.
  await seedRetainer({
    project_id: projectId,
    anchor: "2026-03-12",
    amount_minor: 120_000,
    rec: { first_period_ends: "2026-04-01" },
  });
  await sweepRetainers({ domain, project_id: projectId, now: new Date("2026-03-12T09:00:00Z") });
  await sweepRetainers({ domain, project_id: projectId, now: new Date("2026-04-01T09:00:00Z") });

  const invoices = (await invoicesFor(projectId)).sort((a, b) => a.issue_date!.localeCompare(b.issue_date!));
  assert.equal(invoices.length, 2);
  // 12 Mar → 1 Apr is 20 days; a natural month from 12 Mar is 31 days. 120000 * 20 / 31 = 77419.35…
  assert.equal(invoices[0]!.lines[0]!.unit_amount, 77_419, "exact integer minor units");
  assert.match(invoices[0]!.lines[0]!.description, /part period, 20 of 31 days/, "and the client is told why");
  assert.equal(invoices[1]!.lines[0]!.unit_amount, 120_000, "the second period is a full one");
  assert.equal(invoices[1]!.issue_date, "2026-04-01", "aligned to the calendar from here on");
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The clock. A sweep with no caller is this repo's signature bug.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

test("the scheduler actually fires retainer billing (a retainer with no clock never bills)", async () => {
  // THE BUG: `sweepOpenRequests`, `sweepOverdueInvoices` and `reconcileProject` were each complete,
  // tested and called by nothing. A retainer engine with no `fireSchedule` branch is the same bug
  // with the founder's recurring revenue on it.
  await makeFreshApp();
  _resetBilling();
  const projectId = freshProjectId("retainer-clock");
  const domain = getDomainStore();
  await seedRetainer({ project_id: projectId, anchor: "2026-08-01" });
  const schedule = await ensureRetainerSchedule(domain, projectId, "books-keeper");
  assert.equal(schedule.task_type, RETAINER_SWEEP_TASK_TYPE);
  assert.equal(
    (await ensureRetainerSchedule(domain, projectId, "books-keeper")).id,
    schedule.id,
    "idempotent — one clock per project, however often upkeep runs",
  );

  const store = new InMemoryStore();
  const task = await fireSchedule(store, domain, schedule, new Date("2026-08-02T09:00:00Z"));
  assert.ok(task, "manual fire still records a task");
  // The sweep is kicked off unawaited, exactly like every other harness-work branch.
  for (let i = 0; i < 50 && (await invoicesFor(projectId)).length === 0; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal((await invoicesFor(projectId)).length, 1, "the tick drew the invoice");
  assert.equal((await store.getTask(task.id))!.status, "succeeded");
});

test("upkeep puts a retainer on the clock because the project HAS one, not because of a blueprint", async () => {
  await makeFreshApp();
  _resetBilling();
  const domain = getDomainStore();
  const bare = freshProjectId("retainer-upkeep-bare");
  const bareReport = await ensureUpkeep(domain, bare);
  const bareSweep = bareReport.sweeps.find((s) => s.task_type === RETAINER_SWEEP_TASK_TYPE)!;
  assert.equal(bareSweep.wanted, false, "a business with no retainer is not broken, it just has none");
  assert.equal(bareSweep.running, false);

  const withOne = freshProjectId("retainer-upkeep");
  await seedRetainer({ project_id: withOne, anchor: "2026-08-01" });
  const report = await ensureUpkeep(domain, withOne);
  const sweep = report.sweeps.find((s) => s.task_type === RETAINER_SWEEP_TASK_TYPE)!;
  assert.equal(sweep.wanted, true);
  assert.equal(sweep.running, true, "and it is on the clock — nothing can block recurring revenue");
  assert.equal(sweep.blocked, undefined);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The arbitrary-line bug.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

test("accepting a deliverable never bills an arbitrary retainer line", () => {
  // THE BUG, EXACTLY: `plan.lines.find(first planned milestone/period/RETAINER)` on a plan with
  // twelve monthly retainer lines billed whichever one JSON ordering happened to put first — and
  // that month then billed AGAIN when the retainer clock came round.
  const plan = moneyPlanFromTemplate(
    "USD",
    Array.from({ length: 12 }, (_, i) => ({
      label: `Retainer month ${i + 1}`,
      amount_minor: 120_000,
      kind: "retainer" as const,
    })),
  );
  const pick = lineForAcceptedDeliverable(plan, "d1");
  assert.equal(pick.ok, false, "no retainer line is billed on acceptance, ever");
  assert.equal(pick.ok === false && pick.reason, "none");

  // Two candidate milestones is ambiguous, and ambiguity is answered by a person, not by an index.
  const two = moneyPlanFromTemplate("USD", [
    { label: "Phase one", amount_minor: 50_000, kind: "milestone" },
    { label: "Phase two", amount_minor: 70_000, kind: "milestone" },
  ]);
  const ambiguous = lineForAcceptedDeliverable(two, "d1");
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.ok === false && ambiguous.reason, "ambiguous");
  assert.equal(ambiguous.ok === false && ambiguous.candidates.length, 2, "and the caller is offered the choice");

  // Linking the deliverable resolves it, and the linked line wins over any ordering.
  two.lines[1] = { ...two.lines[1]!, deliverable_id: "d1" };
  const linked = lineForAcceptedDeliverable(two, "d1");
  assert.equal(linked.ok && linked.line.label, "Phase two");
});

test("a live retainer line refuses the one-shot invoice door", async () => {
  // THE BUG: `draftInvoiceFromPlanLine` flips a line to `invoiced`, which is a one-way ratchet. Run
  // it over a live retainer and the retainer bills once and then silently stops for ever.
  await makeFreshApp();
  _resetBilling();
  const projectId = freshProjectId("retainer-oneshot");
  const { kase, line } = await seedRetainer({ project_id: projectId, anchor: "2026-09-01" });
  const { draftInvoiceFromPlanLine } = await import("../src/money-plan");
  await assert.rejects(
    () => draftInvoiceFromPlanLine({ domain: getDomainStore(), kase, line }),
    /recurring retainer/,
  );
  assert.equal((await invoicesFor(projectId)).length, 0);
});

test("the money-plan editor never switches off a retainer by omitting the field", async () => {
  // THE BUG: the Cloud money-plan editor predates retainers and sends no `recurrence`. If omission
  // meant "clear", renaming a line would silently stop a live monthly retainer and nothing anywhere
  // would say so.
  const { applyMoneyPlanEdit } = await import("../src/money-plan");
  const plan = moneyPlanFromTemplate("USD", [{ label: "Retainer", amount_minor: 120_000, kind: "retainer" }]);
  plan.lines[0] = {
    ...plan.lines[0]!,
    recurrence: { every: "month", interval: 1, anchor: "2026-01-01", state: "active" },
  };
  const next = applyMoneyPlanEdit(plan, {
    currency: "USD",
    lines: [{ id: plan.lines[0]!.id, label: "Retainer (renamed)", amount_minor: 130_000, kind: "retainer" }],
  });
  assert.equal(next.lines[0]!.label, "Retainer (renamed)");
  assert.equal(next.lines[0]!.recurrence?.anchor, "2026-01-01", "still recurring, still anchored");
  assert.equal(next.lines[0]!.recurrence?.state, "active");
});

test("a malformed recurrence is refused rather than anchored to today", () => {
  // THE BUG: defaulting a missing anchor decides WHICH MONTHS GET BILLED, and a re-parse after a
  // deploy would move the boundaries under a ledger that has already claimed them.
  const plan = readMoneyPlan({
    money_plan: {
      currency: "USD",
      lines: [
        { id: "l1", label: "Retainer", amount_minor: 1000, kind: "retainer", status: "planned", recurrence: { every: "month" } },
        { id: "l2", label: "Milestone", amount_minor: 1000, kind: "milestone", status: "planned", recurrence: { every: "month", anchor: "2026-01-01" } },
      ],
    },
  })!;
  assert.equal(plan.lines[0]!.recurrence, undefined, "no anchor, no recurrence — the founder sees it is not running");
  assert.equal(plan.lines[1]!.recurrence, undefined, "and recurrence that has drifted onto a milestone is dropped");
});
