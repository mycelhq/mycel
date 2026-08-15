// The next-move engine's tests.
//
// moves.ts reads invoices, client requests and cases across every wedge in a project and hands a
// founder a ranked list. Two families of bug matter here and each test names the one it prevents:
//
//   1. TENANCY. The whole surface is a cross-store read, which is the exact shape of the four
//      cross-tenant leaks this codebase has already had. Every read block below is exercised against
//      a SECOND project's rows — a ranking test that only seeds one tenant proves nothing, because
//      each block applies the authority itself and that is precisely the repetition that drifts.
//
//   2. THE RANKING BEING INDEFENSIBLE. A move nobody can justify is worse than no move, so the
//      scoring tests assert the PROPERTIES the comments in moves.ts claim (money saturates, late is
//      flat, blocked ranks below finishable) rather than pinning magic numbers — a test that only
//      pins constants passes while the curve is wrong.
import { connectMailbox } from "./helpers";
import { getDeliverableStore } from "../src/deliverables";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
// The manifest-honesty test reads `wedges/*/wedge.json` off disk rather than restating what they
// declare — a second copy of the source of truth is the thing that goes stale.
import { readdir, readFile } from "node:fs/promises";
import { getDomainStore } from "../src/domain";
import { getBillingStore } from "../src/billing";
import { getRequestStore } from "../src/requests";
import {
  CASE_STALE_DAYS,
  CONDITIONAL_KINDS,
  CONSEQUENCE_WINDOW_DAYS,
  MAX_CONSEQUENCES,
  MAX_SITE_MOVE_SCORE,
  MIN_EVIDENCE,
  MOVE_KINDS,
  PAID_ATTRIBUTION_DAYS,
  REPLY_ATTRIBUTION_DAYS,
  REQUEST_NUDGE_DAYS,
  TAKEABLE_KINDS,
  deadlinePoints,
  deriveMoveAuthority,
  evidencePoints,
  wastePoints,
  founderMoveAuthority,
  learnedPoints,
  moneyPoints,
  narrowMoves,
  noteInvoiceSettled,
  noteReplyToTouch,
  outcomeStats,
  proposeMoves,
  recordOutcome,
  stalenessPoints,
  systemMoveAuthority,
  takeMove,
  takeability,
  consequencesOf,
  type Consequence,
  type MoveOutcome,
  type Move,
  type MoveAuthority,
  type MoveKind,
  type MoveStores,
} from "../src/moves";
import { setChaseDeps, sweepOverdueInvoices } from "../src/dunning";
// The verdict the ranking quotes, and the write path that seeds it. Imported rather than restated:
// a test carrying its own copy of the thresholds would keep passing while the two drifted apart.
import { CONVERSION_METRIC, analyseExperiment } from "../src/insight/experiment";
import { storeBatch } from "../src/insight/store";
import { gtmWedge, CAMPAIGN_COLLECTION } from "../src/gtm/stages";
import { TOUCH_TASK_TYPE } from "../src/gtm/sequence";
import { CHECK_IN_TASK_TYPE, CHECK_IN_COOLDOWN_DAYS, setCheckInDeps, startCheckIn } from "../src/checkin";
import { HARD_MAX_PER_DAY, HARD_MAX_PER_SWEEP } from "../src/autonomy";
import type { Task } from "../src/contract";

const WEDGE = "books-keeper";
const DAY = 86_400_000;

const stores = (): MoveStores => ({
  domain: getDomainStore(),
  billing: getBillingStore(),
  requests: getRequestStore(),
  deliverables: getDeliverableStore(),
});

/**
 * The clock every fixture is relative to.
 *
 * The REAL wall clock, not a frozen literal, and that is not laziness. `createRequest` and
 * `createCase` stamp `created_at`/`updated_at` from `Date.now()` inside the store, so a fixed NOW in
 * the past makes every row the test creates appear to be from the future and the age of everything
 * comes out negative. Only the offsets below are fixed; the origin has to be the store's own.
 */
const NOW = new Date();
const ago = (days: number): string => new Date(NOW.getTime() - days * DAY).toISOString();
const agoDate = (days: number): string => ago(days).slice(0, 10);
const ahead = (days: number): string => new Date(NOW.getTime() + days * DAY).toISOString();

/** A task shaped as the store returns one. Only the fields the authority reads matter. */
function taskOf(p: Partial<Task>): Task {
  return {
    id: randomUUID(),
    wedge: WEDGE,
    task_type: "daily_sync",
    actor: { kind: "user", id: "founder" },
    input: {},
    constraints: { max_runtime_s: 300, max_cost_usd: 1, approval_required: false },
    tools: [],
    status: "running",
    cost_usd: 0,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    ...p,
  } as Task;
}

/** The founder's own authority over a project, built the way the route builds it. */
async function authFor(projectId: string): Promise<MoveAuthority> {
  const domain = getDomainStore();
  const clients = (await domain.listClients()).filter((c) => c.project_id === projectId);
  const cases = await domain.listCases({ project_id: projectId });
  return founderMoveAuthority({
    project_id: projectId,
    wedges: [...new Set([WEDGE, gtmWedge(), ...cases.map((k) => k.wedge)])],
    client_ids: clients.map((c) => c.id),
    case_ids: cases.map((k) => k.id),
  });
}

async function makeClient(projectId: string, label: string) {
  return getDomainStore().createClient({
    project_id: projectId,
    display_name: `${label} Ltd`,
    handles: [`${label}-${randomUUID().slice(0, 8)}@example.com`],
    metadata: {},
  });
}

async function overdueInvoice(projectId: string, clientId: string, opts: {
  amount: number;
  daysOverdue: number;
  currency?: string;
  lastChasedDaysAgo?: number;
  /** Pass false for the business the walkthrough actually found: overdue money, nowhere to send. */
  mailbox?: boolean;
}) {
  // A business with no mailbox no longer chases at all: `startChase` refuses with `cannot_send`
  // before it claims the invoice, because a chase that cannot be sent is a paid model call that
  // burns the ladder claim and still reports success. See promises.ts. Every scene in this file
  // is a business that could actually send the reminder, which is what it always meant.
  if (opts.mailbox !== false) await connectMailbox(projectId);
  const inv = await getBillingStore().createInvoice({
    project_id: projectId,
    client_id: clientId,
    currency: opts.currency ?? "USD",
    status: "sent",
    issue_date: agoDate(opts.daysOverdue + 30),
    due_date: agoDate(opts.daysOverdue),
    lines: [
      { id: randomUUID(), description: "Monthly bookkeeping", kind: "fixed", quantity_milli: 1000, unit_amount: opts.amount },
    ],
  });
  if (opts.lastChasedDaysAgo !== undefined) {
    // Through the claim, because that is the only writer of `last_chased_at` in production. A test
    // that pokes the field directly would keep passing if the claim ever stopped stamping it.
    await getBillingStore().claimInvoiceForChase(inv.id, ahead(1), ago(opts.lastChasedDaysAgo));
  }
  return (await getBillingStore().getInvoice(inv.id))!;
}

const kindsOf = (moves: Move[]) => moves.map((m) => m.kind);
const byId = (moves: Move[], id: string) => moves.find((m) => m.id.endsWith(`:${id}`));

// ── authority ────────────────────────────────────────────────────────────────────────────────────

test("an unattributed task proposes nothing rather than everything", () => {
  // THE BUG: `deriveAuthority` had to grow `if (!task.project_id) return 403` after the fact,
  // because a scope assembled at a call site is a scope one call site forgets. A task with no
  // project has no tenant, and a read with no tenant is a read of everyone's.
  assert.equal(deriveMoveAuthority(taskOf({ project_id: undefined })), undefined);
  assert.equal(deriveMoveAuthority(undefined), undefined);
  assert.throws(() => founderMoveAuthority({ project_id: "", wedges: [], client_ids: [], case_ids: [] }));
});

test("a run's authority is its own wedge only", () => {
  // THE BUG: a reflection run handed a ranked list of every wedge's work is one prompt injection
  // away from proposing itself a chase against a client it was never scoped to.
  const auth = deriveMoveAuthority(taskOf({ project_id: "p1", wedge: "invoice-chaser", client_id: "c1" }))!;
  assert.deepEqual([...auth.wedges], ["invoice-chaser"]);
  assert.deepEqual([...auth.client_ids], ["c1"]);
});

test("narrowMoves can only shrink — naming a stranger's client yields the empty set", () => {
  // THE BUG: filters that widen. Asking about a client we do not work for must return nothing and
  // reveal neither that they exist nor that we serve them — not fall back to the authority's own set.
  const auth = founderMoveAuthority({
    project_id: "p1", wedges: [WEDGE], client_ids: ["mine-a", "mine-b"], case_ids: ["k1"],
  });
  assert.deepEqual(narrowMoves(auth, { client_id: "someone-elses" }).client_ids, []);
  assert.deepEqual(narrowMoves(auth, { client_id: "mine-a" }).client_ids, ["mine-a"]);
  assert.deepEqual(narrowMoves(auth, {}).client_ids, ["mine-a", "mine-b"]);
  // An unknown kind is dropped, not honoured as a widening.
  assert.ok(!narrowMoves(auth, { kinds: ["not_a_kind" as never] }).kinds.includes("not_a_kind" as never));
  // The limit is clamped at both ends: 0 and 10_000 are both attempts to change what is read.
  assert.equal(narrowMoves(auth, { limit: 0 }).limit, 1);
  assert.equal(narrowMoves(auth, { limit: 10_000 }).limit, 100);
});

test("a house-wide run reads NO client-owned row — the empty set is the tightest scope", async () => {
  // THE BUG, and it is the one this whole authority pattern exists for: reading empty `client_ids`
  // as "unfiltered" rather than "nothing". A house-wide sweep would then rank every client's debts.
  const project = `p-${randomUUID()}`;
  const client = await makeClient(project, "acme");
  await overdueInvoice(project, client.id, { amount: 500_00, daysOverdue: 20 });

  const houseWide = deriveMoveAuthority(taskOf({ project_id: project, client_id: undefined }))!;
  const proposal = await proposeMoves(stores(), houseWide, {}, NOW);
  assert.deepEqual(proposal.moves, []);
  // Counted, not silently dropped: the caller learns rows exist it may not read, and stops guessing.
  assert.ok(proposal.authority_excluded >= 1);
});

// ── tenancy, across every read block ─────────────────────────────────────────────────────────────

test("one project's moves never contain another project's rows", async () => {
  // THE BUG: the four cross-tenant leaks this codebase has already had, all of them a scoping filter
  // written twice. Every block here (invoices, requests, cases, GTM) applies the authority itself.
  const mine = `p-${randomUUID()}`;
  const theirs = `p-${randomUUID()}`;
  const domain = getDomainStore();

  for (const project of [mine, theirs]) {
    const client = await makeClient(project, project.slice(0, 6));
    await overdueInvoice(project, client.id, { amount: 900_00, daysOverdue: 30 });
    await getRequestStore().createRequest({
      project_id: project, client_id: client.id, kind: "document", ask: `${project} bank statement`,
    });
    await domain.createCase({
      project_id: project, wedge: WEDGE, title: `${project} year end`, client_id: client.id,
      stage: "open", status: "open", data: {}, due_at: ahead(2),
    });
  }
  // The requests store stamps `created_at` at insert, so age them past the nudge threshold by
  // proposing from a "now" far enough in the future.
  const later = new Date(NOW.getTime() + (REQUEST_NUDGE_DAYS + 5) * DAY);

  const proposal = await proposeMoves(stores(), await authFor(mine), {}, later);
  assert.ok(proposal.moves.length >= 3, `expected all three blocks to fire, got ${kindsOf(proposal.moves)}`);
  for (const m of proposal.moves) {
    assert.equal(m.project_id, mine, `a move for ${m.project_id} escaped into ${mine}'s list`);
    assert.ok(!m.why.includes(theirs), "another tenant's identifier appeared in a reason string");
  }
});

// ── the dunning ladder is the invoice-chaser's, not this module's ────────────────────────────────

test("an invoice inside its ladder window produces NO move at all", async () => {
  // THE BUG: a second opinion about chase cadence. `wedges/invoice-chaser/knowledge/dunning-policy.md`
  // says never twice in 48h and `chaseIntervalDays` encodes a rung-by-rung cadence on top of it.
  // Showing a founder "chase this" for something the ladder has decided to hold is an invitation to
  // chase it — and the client on the other end experiences the ladder, not the ranking function.
  const project = `p-${randomUUID()}`;
  const client = await makeClient(project, "paced");
  // 5 days overdue → rung one → the ladder allows a chase every 3 days.
  const held = await overdueInvoice(project, client.id, { amount: 400_00, daysOverdue: 5, lastChasedDaysAgo: 1 });
  const due = await overdueInvoice(project, client.id, { amount: 400_00, daysOverdue: 5, lastChasedDaysAgo: 4 });

  const auth = await authFor(project);
  const moves = (await proposeMoves(stores(), auth, { kinds: ["chase_invoice"] }, NOW)).moves;
  assert.equal(byId(moves, held.id), undefined, "an invoice chased yesterday was proposed for chasing again");
  assert.ok(byId(moves, due.id), "an invoice past its ladder interval was not proposed");
});

test("nothing is proposed for a debt that is not owed", async () => {
  // THE BUG: the three refusals `sweepOverdueInvoices` makes. A draft the client has never seen, a
  // settled invoice, and one not yet due are all dunning emails about money that is not owed.
  const project = `p-${randomUUID()}`;
  const client = await makeClient(project, "settled");
  const billing = getBillingStore();

  const draft = await billing.createInvoice({
    project_id: project, client_id: client.id, currency: "USD", status: "draft",
    due_date: agoDate(30),
    lines: [{ id: randomUUID(), description: "d", kind: "fixed", quantity_milli: 1000, unit_amount: 100_00 }],
  });
  const notYetDue = await overdueInvoice(project, client.id, { amount: 100_00, daysOverdue: -5 });
  const paid = await overdueInvoice(project, client.id, { amount: 100_00, daysOverdue: 30 });
  await billing.recordPayment(paid.id, 100_00, new Date().toISOString());

  const moves = (await proposeMoves(stores(), await authFor(project), { kinds: ["chase_invoice"] }, NOW)).moves;
  assert.equal(byId(moves, draft.id), undefined, "a draft the client has never seen was proposed for chasing");
  assert.equal(byId(moves, notYetDue.id), undefined, "an invoice not yet due was proposed for chasing");
  assert.equal(byId(moves, paid.id), undefined, "a settled invoice was proposed for chasing");
});

test("the carrier is the wedge's own input builder, so a taken move and a swept chase are one run", async () => {
  // THE BUG: two builders that drift on `days_overdue` — the single field `next_step` branches on to
  // pick a rung. A move carrying its own hand-rolled input would silently pick a different rung than
  // the dunning sweep for the same invoice.
  const project = `p-${randomUUID()}`;
  const client = await makeClient(project, "carrier");
  const inv = await overdueInvoice(project, client.id, { amount: 1_234_00, daysOverdue: 12 });
  const [move] = (await proposeMoves(stores(), await authFor(project), { kinds: ["chase_invoice"] }, NOW)).moves;

  assert.equal(move.carrier.wedge, "invoice-chaser");
  assert.equal(move.carrier.task_type, "chase_invoice");
  assert.equal(move.carrier.input.invoice_id, inv.id);
  assert.equal(move.carrier.input.days_overdue, 12);
  assert.equal(move.carrier.input.amount_due, 1_234_00);
  // Money stays an integer in minor units all the way through. Never a float, anywhere.
  assert.equal(Number.isInteger(move.signals.money_at_stake), true);
});

test("a chase with no mailbox behind it is proposed unavailable, not proposed live", async () => {
  // THE BUG, observed in a walkthrough on 2026-08-12: `takeability` returned `{takeable: true}`
  // unconditionally for `chase_invoice`, and the mailbox check lived fourteen hundred lines away in
  // `startChase`. The row rendered a live button whose tooltip promised "It drafts, then waits for
  // you in Approvals"; the founder clicked it five times; each refusal arrived as a transient toast
  // and the row never changed, because `revalidatePath` only runs on success. The product looked
  // broken when it was merely unconfigured — which is the difference between a bug and a blocker a
  // founder can clear in one click.
  //
  // The move is still PROPOSED. Overdue money is still the most important thing on the page, and
  // hiding the row would hide the debt along with the reason. It is proposed with the refusal
  // attached, which is the same sentence `startChase` would have produced after the click.
  const project = `p-${randomUUID()}`;
  const client = await makeClient(project, "nomailbox");
  await overdueInvoice(project, client.id, { amount: 9_000_00, daysOverdue: 23, mailbox: false });

  const [move] = (await proposeMoves(stores(), await authFor(project), { kinds: ["chase_invoice"] }, NOW)).moves;
  assert.ok(move, "the overdue invoice must still be on the list — the debt is real either way");
  assert.equal(move.takeable, false, "a chase with nowhere to send from must not render a live button");
  assert.match(move.unavailable_reason ?? "", /mailbox/i, "the refusal must name the thing to connect");
  // The sentence a founder reads is about their business, not ours. See narration.ts.
  assert.doesNotMatch(move.unavailable_reason ?? "", /wedge|harness|kernel|capability|connection_id/i);

  // And the same business WITH a mailbox gets the button back — otherwise this test would pass just
  // as well against a gate that refused every chase forever.
  const ok = `p-${randomUUID()}`;
  const c2 = await makeClient(ok, "hasmailbox");
  await overdueInvoice(ok, c2.id, { amount: 9_000_00, daysOverdue: 23 });
  const [live] = (await proposeMoves(stores(), await authFor(ok), { kinds: ["chase_invoice"] }, NOW)).moves;
  assert.equal(live.takeable, true, "a business that can send must still be able to click");
});

test("a stated never-chase rule holds that client's invoice at rank time, and shows itself", async () => {
  // THE BUG, observed in a walkthrough: the founder answered "Never chase anyone at Ravel Systems"
  // during onboarding. Twenty minutes later the #1 move was "Chase Invoice INV-0001 · Ravel Systems",
  // and "Why here?" cited only money, deadline and silence. Rules reached draft time via groundRun
  // and never ranking. Onboarding was theatre.
  const { getKnowledgeStore } = await import("../src/knowledge.store");
  const { distillFromOnboarding } = await import("../src/knowledge");
  const project = `p-${randomUUID()}`;
  const ravel = await makeClient(project, "Ravel Systems");
  // display_name is "Ravel Systems Ltd" from makeClient — the rule names "Ravel Systems".
  const other = await makeClient(project, "Northwind");
  await overdueInvoice(project, ravel.id, { amount: 9_000_00, daysOverdue: 34 });
  await overdueInvoice(project, other.id, { amount: 500_00, daysOverdue: 10 });

  await getKnowledgeStore().putRule(
    distillFromOnboarding({
      project_id: project,
      wedge: "invoice-chaser",
      question_id: "never-chase",
      question: "Anyone we should never chase?",
      answer: "Never chase anyone at Ravel Systems — they are our biggest retainer.",
    }),
  );

  const moves = (await proposeMoves(stores(), await authFor(project), { kinds: ["chase_invoice"] }, NOW)).moves;
  const held = moves.find((m) => m.client_id === ravel.id);
  const live = moves.find((m) => m.client_id === other.id);
  assert.ok(held, "the Ravel invoice must still be on the list — hiding it would hide the rule");
  assert.equal(held.takeable, false);
  assert.match(held.unavailable_reason ?? "", /Ravel Systems/);
  const ruleTerm = held.score_terms.find((t) => t.term === "rule");
  assert.ok(ruleTerm, "Why here? must show the rule, not only money/deadline/silence");
  assert.match(ruleTerm.because, /you said/);
  assert.match(ruleTerm.because, /Never chase anyone at Ravel Systems/);
  assert.ok(held.score_terms.some((t) => t.term === "money"), "the debt is still in the working");
  assert.ok(live, "a different client must still be chaseable");
  assert.equal(live.takeable, true);
  assert.equal(live.score_terms.some((t) => t.term === "rule"), false);
  // Held ranks below live even though the debt is larger — that is the whole point.
  assert.ok(held.score < live.score);
  assert.notEqual(moves[0]?.client_id, ravel.id, "the held chase must not be #1");

  const after = await getKnowledgeStore().listRules(project, { status: "active" });
  assert.equal(after.length, 1);
  assert.ok(after[0]!.uses >= 1, "Learning must stop saying never-used about a rule that just held a chase");

  await proposeMoves(stores(), await authFor(project), { kinds: ["chase_invoice"] }, NOW);
  const again = await getKnowledgeStore().listRules(project, { status: "active" });
  assert.equal(again[0]!.uses, after[0]!.uses, "a page refresh must not tally as another job");
});

test("a vague onboarding rule stays unused after ranking", async () => {
  const { getKnowledgeStore } = await import("../src/knowledge.store");
  const { distillFromOnboarding } = await import("../src/knowledge");
  const project = `p-${randomUUID()}`;
  const client = await makeClient(project, "Ravel Systems");
  await overdueInvoice(project, client.id, { amount: 9_000_00, daysOverdue: 34 });
  await getKnowledgeStore().putRule(
    distillFromOnboarding({
      project_id: project,
      wedge: "invoice-chaser",
      question_id: "house-style",
      question: "How should we sound?",
      answer: "Be polite, and reply quickly.",
    }),
  );
  const [move] = (await proposeMoves(stores(), await authFor(project), { kinds: ["chase_invoice"] }, NOW)).moves;
  assert.ok(move);
  assert.equal(move.takeable, true);
  assert.equal(move.score_terms.some((t) => t.term === "rule"), false);
  const rows = await getKnowledgeStore().listRules(project, { status: "active" });
  assert.equal(rows[0]!.uses, 0, "Learning must keep saying never-used — the rule matched nothing");
});

test("the founder-facing score reasons are written for a person, not a compiler", async () => {
  // "the due date passed 23 day(s) ago" and "1 open invoice(s)" shipped to real screens. `day(s)` is
  // a placeholder somebody meant to come back to, and it appears in the ONE explanation this product
  // stakes its credibility on — the arithmetic behind why this move is at the top of the day.
  const project = `p-${randomUUID()}`;
  const client = await makeClient(project, "plural");
  await overdueInvoice(project, client.id, { amount: 1_000_00, daysOverdue: 1 });
  const [move] = (await proposeMoves(stores(), await authFor(project), { kinds: ["chase_invoice"] }, NOW)).moves;

  for (const term of move.score_terms) {
    assert.doesNotMatch(term.because, /\(s\)/, `"${term.because}" — pluralise it properly`);
  }
  assert.ok(
    move.score_terms.some((t) => /passed 1 day ago/.test(t.because)),
    "one day overdue must read '1 day', not '1 days' and not '1 day(s)'",
  );
});

// ── the ranking, and its defensibility ───────────────────────────────────────────────────────────

test("money saturates: a huge invoice cannot bury everything else", async () => {
  // THE BUG: a linear money term. Chasing a $100 invoice and a $100,000 one cost the founder the
  // same minute, so a linear score makes every small overdue invoice invisible behind one big one —
  // which is exactly the backlog an AR chaser is bought to clear.
  assert.equal(moneyPoints(0, "USD"), 0);
  assert.equal(moneyPoints(-5, "USD"), 0);
  const small = moneyPoints(100_00, "USD");
  const big = moneyPoints(10_000_00, "USD");
  const huge = moneyPoints(10_000_000_00, "USD");
  assert.ok(small < big && big < huge, "the money term must still be monotonic");
  assert.ok(huge <= 40, "the money term must be capped");
  // 100x the money is far from 100x the points — that is the whole claim.
  assert.ok(big < small * 4, `${big} should be nowhere near ${small} * 100`);
  // Zero-decimal currencies are read through `minorUnitExponent`, not assumed to be cents.
  assert.ok(moneyPoints(1000, "JPY") > moneyPoints(1000, "USD"));
});

test("late is flat, so one ancient item cannot pin the top of the list for ever", async () => {
  // THE BUG: an unbounded overdue term. A thing 300 days late is not ten times more urgent than one
  // 30 days late — it is a different conversation — and letting it grow means everything that could
  // still be saved on time sits underneath it permanently.
  assert.equal(deadlinePoints(0), deadlinePoints(-300));
  assert.equal(deadlinePoints(undefined), 0);
  assert.equal(deadlinePoints(90), 0, "a deadline beyond the horizon is a fact, not a signal");
  assert.ok(deadlinePoints(1) > deadlinePoints(10), "nearer deadlines must pull harder");
});

test("staleness saturates rather than growing without bound", async () => {
  // THE BUG: dead engagements parking permanently at the top. The cliff is in the first fortnight;
  // after a month the marginal harm of one more silent day is ~0 and the fix is not one more email.
  assert.equal(stalenessPoints(0), 0);
  assert.equal(stalenessPoints(undefined), 0);
  assert.ok(stalenessPoints(3) < stalenessPoints(14));
  assert.equal(stalenessPoints(30), stalenessPoints(3000));
});

test("a move blocked on the client ranks below equally-stale work we can finish ourselves", async () => {
  // THE BUG: a founder's list filling with waiting. A nudge is a real move — a client sitting on a
  // document is the thing that never gets chased when a human runs the business — but it cannot be
  // COMPLETED by us, so it must sit below work we can close out.
  const project = `p-${randomUUID()}`;
  const client = await makeClient(project, "blocked");
  const domain = getDomainStore();

  await domain.createCase({
    project_id: project, wedge: WEDGE, title: "Quiet engagement", client_id: client.id,
    stage: "open", status: "open", data: {},
  });
  await getRequestStore().createRequest({
    project_id: project, client_id: client.id, kind: "document", ask: "March bank statement",
  });

  const later = new Date(NOW.getTime() + (CASE_STALE_DAYS + 3) * DAY);
  const moves = (await proposeMoves(stores(), await authFor(project), {}, later)).moves;
  const nudge = moves.find((m) => m.kind === "nudge_client_request")!;
  const checkIn = moves.find((m) => m.kind === "check_in_case")!;
  assert.ok(nudge && checkIn, `expected both moves, got ${kindsOf(moves)}`);
  assert.equal(nudge.blocked_on, "client");
  assert.ok(nudge.score < checkIn.score, `blocked ${nudge.score} should rank below finishable ${checkIn.score}`);
  // And the penalty is visible, not hidden inside a total.
  assert.ok(nudge.score_terms.some((t) => t.term === "blocked" && t.points < 0));
});

test("every move carries its working, and the total always equals the terms", async () => {
  // THE BUG: a score that disagrees with its own explanation. vision.md asks for "explaining why it
  // did something when asked"; a `why` string narrated separately from the arithmetic is a story.
  const project = `p-${randomUUID()}`;
  const client = await makeClient(project, "explain");
  await overdueInvoice(project, client.id, { amount: 2_500_00, daysOverdue: 9 });
  const moves = (await proposeMoves(stores(), await authFor(project), {}, NOW)).moves;
  assert.ok(moves.length > 0);
  for (const m of moves) {
    assert.ok(m.why.length > 10, "a move with no reason is not a move a founder can act on");
    assert.ok(m.score_terms.length > 0);
    const sum = m.score_terms.reduce((n, t) => n + t.points, 0);
    assert.ok(Math.abs(sum - m.score) < 0.05, `score ${m.score} != sum of terms ${sum}`);
    for (const t of m.score_terms) assert.ok(t.because.length > 0, `term ${t.term} has no justification`);
  }
});

test("move ids are stable and the ordering does not shuffle between calls", async () => {
  // THE BUG: a list that reorders on refresh is a list a founder stops trusting — and, worse, an
  // outcome recorded against a randomly-generated move id references a row nothing can ever find.
  const project = `p-${randomUUID()}`;
  const client = await makeClient(project, "stable");
  const a = await overdueInvoice(project, client.id, { amount: 500_00, daysOverdue: 10 });
  const b = await overdueInvoice(project, client.id, { amount: 500_00, daysOverdue: 10 });
  const auth = await authFor(project);
  const first = (await proposeMoves(stores(), auth, {}, NOW)).moves;
  const second = (await proposeMoves(stores(), auth, {}, NOW)).moves;
  assert.deepEqual(first.map((m) => m.id), second.map((m) => m.id));
  assert.ok(first.some((m) => m.id === `chase_invoice:${a.id}`));
  assert.ok(first.some((m) => m.id === `chase_invoice:${b.id}`));
});

test("a case that is both due and stale produces ONE move, not two", async () => {
  // THE BUG: a ranked list that stops being a list of things to do and becomes a list of things the
  // engine noticed. "Get it over the line" and "check in on it" are the same act for one engagement.
  const project = `p-${randomUUID()}`;
  const client = await makeClient(project, "onemove");
  const kase = await getDomainStore().createCase({
    project_id: project, wedge: WEDGE, title: "Sales tax return", client_id: client.id,
    stage: "gathering", status: "open", data: {}, due_at: ahead(1),
  });
  const later = new Date(NOW.getTime() + (CASE_STALE_DAYS + 5) * DAY);
  const moves = (await proposeMoves(stores(), await authFor(project), {}, later)).moves;
  const forCase = moves.filter((m) => m.entity.id === kase.id);
  assert.equal(forCase.length, 1, `expected one move for the case, got ${kindsOf(forCase)}`);
  assert.equal(forCase[0].kind, "advance_case", "the deadline is the honest headline when both apply");
});

// ── GTM: the sequencer's own gate, asked rather than reimplemented ───────────────────────────────

async function seedCampaign(projectId: string, steps: unknown[]) {
  const campaignId = randomUUID();
  await getDomainStore().upsertRecord({
    project_id: projectId,
    wedge: gtmWedge(),
    collection: CAMPAIGN_COLLECTION,
    key: campaignId,
    data: {
      id: campaignId,
      campaign_id: campaignId,
      project_id: projectId,
      connection_id: `conn-${randomUUID()}`,
      name: "Q3 founders",
      steps,
      approval_id: randomUUID(),
      task_id: randomUUID(),
      expires_at: ahead(30),
      created_at: ago(1),
    },
  });
  return campaignId;
}

test("a replied prospect is never proposed, and an unmet step condition proposes nothing", async () => {
  // THE BUG: showing a founder "message this prospect" for someone who already replied. The stage
  // machine treats `replied` as terminal and `only_if` gates the rest; recomputing either here would
  // mean the list and the sequencer disagree about what is legal, and the list is what a human acts on.
  const project = `p-${randomUUID()}`;
  const domain = getDomainStore();
  const campaign = await seedCampaign(project, [
    // `invite_accepted`, NOT `connected` — the two are deliberately different facts (see
    // `factsFor`): `connected` is true for anyone at or past that stage, including a prospect
    // enrolled straight there, while `invite_accepted` is true only where THIS campaign's
    // invitation was observed being accepted.
    { from: "connected", action: "send_message", advance_to: "dm1", only_if: "invite_accepted AND !replied" },
    { from: "dm1", action: "send_message", advance_to: "dm2" },
  ]);

  const replied = await domain.createCase({
    project_id: project, wedge: gtmWedge(), title: "Answered already", stage: "replied", status: "open",
    data: { campaign_id: campaign, invite_accepted_at: ago(3), has_reply: true }, due_at: ago(1),
  });
  const unmet = await domain.createCase({
    project_id: project, wedge: gtmWedge(), title: "Invitation never accepted", stage: "connected", status: "open",
    // No `invite_accepted_at`, so the fact is FALSE — and an unknown fact is false, never true.
    data: { campaign_id: campaign }, due_at: ago(1),
  });
  const ready = await domain.createCase({
    project_id: project, wedge: gtmWedge(), title: "Ready for the first DM", stage: "connected", status: "open",
    data: { campaign_id: campaign, invite_accepted_at: ago(2) }, due_at: ago(1),
  });
  const waiting = await domain.createCase({
    project_id: project, wedge: gtmWedge(), title: "Cadence gap not elapsed", stage: "connected", status: "open",
    data: { campaign_id: campaign, invite_accepted_at: ago(2) }, due_at: ahead(2),
  });

  const moves = (await proposeMoves(stores(), await authFor(project), {}, NOW)).moves;
  const ids = new Set(moves.map((m) => m.entity.id));
  assert.ok(!ids.has(replied.id), "a prospect who already replied was proposed for another message");
  assert.ok(!ids.has(unmet.id), "a step whose only_if is unmet was proposed");
  assert.ok(!ids.has(waiting.id), "a prospect still inside the sequencer's cadence gap was proposed");
  assert.ok(ids.has(ready.id), "a prospect whose step is genuinely due was not proposed");

  const move = moves.find((m) => m.entity.id === ready.id)!;
  assert.equal(move.kind, "gtm_next_touch");
  assert.equal(move.carrier.wedge, gtmWedge());
  /**
   * THE BUG THIS LINE NOW PINS: the carrier named `"gtm_next_touch"`, a task type that exists in no
   * manifest, no dispatcher and no scheduler — invented here out of the move's own kind. So the
   * button was greyed out with a sentence saying no wedge could carry an outreach touch, while
   * `advanceSequences` dispatched `outreach_touch` for this very case every five minutes. Asserted
   * against the constant the DISPATCHER exports, so the two cannot drift apart again silently.
   */
  assert.equal(move.carrier.task_type, TOUCH_TASK_TYPE);
  // And the proposed input is the shape `dispatchStep` actually writes, field for field — otherwise
  // `/next` would be previewing a task row the sequencer never creates.
  assert.deepEqual(move.carrier.input, {
    campaign_id: campaign,
    case_id: ready.id,
    step: "send_message",
    stage: "connected",
  });
});

test("a GTM prospect is never proposed as a stale engagement to check in on", async () => {
  // THE BUG: a prospect deliberately waiting out a jittered cadence gap looks exactly like an
  // abandoned engagement. Falling through to the staleness block would bury a founder's list under
  // "check in on this" for every person in every campaign.
  const project = `p-${randomUUID()}`;
  const campaign = await seedCampaign(project, [{ from: "invited", action: "send_message", advance_to: "dm1", only_if: "connected" }]);
  await getDomainStore().createCase({
    project_id: project, wedge: gtmWedge(), title: "Invited, never accepted", stage: "invited", status: "open",
    data: { campaign_id: campaign }, due_at: ago(1),
  });
  const later = new Date(NOW.getTime() + 60 * DAY);
  const moves = (await proposeMoves(stores(), await authFor(project), {}, later)).moves;
  assert.deepEqual(kindsOf(moves), [], `a waiting prospect produced ${kindsOf(moves)}`);
});

// ── outcomes: closing the loop ───────────────────────────────────────────────────────────────────

test("outcomes append rather than merge, so two recorded at once do not lose one", async () => {
  // THE BUG: insight/store.ts documents it at length — `upsertRecord` merges `data` SHALLOWLY with
  // no arithmetic, so a running per-kind counter row is a read-modify-write that loses updates the
  // moment two browsers post together. This is the one write path guaranteed to be concurrent.
  const project = `p-${randomUUID()}`;
  const auth = await authFor(project);
  const moveId = "chase_invoice:inv-1";
  await Promise.all([
    recordOutcome(getDomainStore(), auth, { move_id: moveId, kind: "chase_invoice", entity_id: "inv-1", result: "paid", by: "m1" }),
    recordOutcome(getDomainStore(), auth, { move_id: moveId, kind: "chase_invoice", entity_id: "inv-1", result: "ignored", by: "m1" }),
  ]);
  const stats = await outcomeStats(getDomainStore(), auth);
  assert.equal(stats.get("chase_invoice")?.taken, 2);
  assert.equal(stats.get("chase_invoice")?.worked, 1);
  assert.equal(stats.get("chase_invoice")?.ignored, 1);
});

test("one project's outcomes never train another project's ranking", async () => {
  // THE BUG: the tenant taken from the request body instead of the authority. An outcome written
  // into the wrong ledger silently retrains a founder's list toward someone else's business.
  const mine = `p-${randomUUID()}`;
  const theirs = `p-${randomUUID()}`;
  const mineAuth = await authFor(mine);
  const theirsAuth = await authFor(theirs);
  for (let i = 0; i < MIN_EVIDENCE + 2; i++) {
    await recordOutcome(getDomainStore(), theirsAuth, {
      move_id: `chase_invoice:x${i}`, kind: "chase_invoice", entity_id: `x${i}`, result: "rejected", by: "them",
    });
  }
  assert.equal((await outcomeStats(getDomainStore(), mineAuth)).size, 0);
  assert.equal((await outcomeStats(getDomainStore(), theirsAuth)).get("chase_invoice")?.rejected, MIN_EVIDENCE + 2);
});

test("history below the evidence floor changes nothing", async () => {
  // THE BUG: superstition wearing a percentage sign. Adjusting a founder's list from two data points
  // means the engine confidently deprioritises the one thing they happened to ignore twice.
  assert.equal(learnedPoints(undefined), 0);
  assert.equal(learnedPoints({ kind: "chase_invoice", taken: MIN_EVIDENCE - 1, worked: 0, ignored: 0, rejected: MIN_EVIDENCE - 1 }), 0);
});

test("repeated rejection drags a kind down harder than repeated success lifts it", async () => {
  // THE BUG: symmetric learning. "Ignored" means the founder had a busier minute; "rejected" means
  // they looked at it and said no. A product that keeps proposing what it has been told not to do is
  // a product that gets closed — so the downside is deliberately larger than the upside.
  const rejected = learnedPoints({ kind: "chase_invoice", taken: 10, worked: 0, ignored: 0, rejected: 10 });
  const worked = learnedPoints({ kind: "chase_invoice", taken: 10, worked: 10, ignored: 0, rejected: 0 });
  const even = learnedPoints({ kind: "chase_invoice", taken: 10, worked: 5, ignored: 5, rejected: 0 });
  assert.ok(rejected < 0 && worked > 0);
  assert.ok(Math.abs(rejected) > worked, "a rejection must cost more than a success earns");
  assert.equal(even, 0, "a kind that works half the time is neither promoted nor demoted");
});

test("recorded outcomes actually move the ranking", async () => {
  // THE BUG THIS CLOSES: vision.md's loop is "measure → update judgment → ask less next time". A
  // ranking that cannot be shown to be wrong is a very confident list, not an operator. This is the
  // end-to-end proof that the ledger feeds back into the score.
  const project = `p-${randomUUID()}`;
  const client = await makeClient(project, "learns");
  await overdueInvoice(project, client.id, { amount: 750_00, daysOverdue: 15 });
  const auth = await authFor(project);

  const before = (await proposeMoves(stores(), auth, {}, NOW)).moves[0];
  for (let i = 0; i < MIN_EVIDENCE + 1; i++) {
    await recordOutcome(getDomainStore(), auth, {
      move_id: `chase_invoice:old${i}`, kind: "chase_invoice", entity_id: `old${i}`, result: "rejected", by: "founder",
    });
  }
  const after = (await proposeMoves(stores(), auth, {}, NOW)).moves[0];
  assert.equal(after.id, before.id);
  assert.ok(after.score < before.score, `score should fall after repeated rejection: ${before.score} → ${after.score}`);
  assert.ok(after.score_terms.some((t) => t.term === "learned" && t.points < 0));
  assert.equal(after.signals.learned?.rejected, MIN_EVIDENCE + 1);
});

// ── taking a move ────────────────────────────────────────────────────────────────────────────────
//
// The list became an operator here: a founder reads "chase INV-104" and takes it, instead of
// navigating to Invoices and rebuilding by hand the run the move already described. Everything below
// guards one of the three ways that goes wrong — a second run, a different run, or another tenant's
// run.

/** Every `spawnTask` the harness made, in order. The proof that two doors are one run. */
interface Spawned {
  project_id: string;
  wedge: string;
  task_type: string;
  client_id?: string;
  case_id?: string;
  source: string;
  input: Record<string, unknown>;
}

/**
 * Install a recording `ChaseDeps` for one test and take it back out afterwards.
 *
 * Through `setChaseDeps` — the real registration point `mountInvoiceRoutes` uses — rather than by
 * stubbing `startChase`. A test that mocks the function under test proves the mock works.
 */
function recordingChaseDeps(opts: { enabled?: boolean } = {}) {
  const spawned: Spawned[] = [];
  setChaseDeps({
    wedgeEnabled: () => opts.enabled !== false,
    spawnTask: async (a) => {
      spawned.push(a as Spawned);
      return `task-${spawned.length}-${randomUUID().slice(0, 8)}`;
    },
    attachInvoiceDocument: async () => ({ artifact_id: "a", name: "i.pdf", content_type: "application/pdf", size_bytes: 1 }),
  });
  return { spawned, restore: () => setChaseDeps(null) };
}

test("taking the same move twice spawns exactly one run", async (t) => {
  // THE BUG: move ids are DETERMINISTIC (`${kind}:${entity_id}`) so that an outcome recorded an hour
  // later still finds its move. That same stability is what makes a double click dangerous — two
  // takes of `chase_invoice:INV-104` are two identical, valid requests. Without the ladder's
  // compare-and-set claim behind the take path, one impatient founder puts two dunning emails in one
  // client's inbox an instant apart, which is precisely what the whole dunning policy is written to
  // prevent.
  const { spawned, restore } = recordingChaseDeps();
  t.after(restore);
  const project = `p-${randomUUID()}`;
  const client = await makeClient(project, "twice");
  const inv = await overdueInvoice(project, client.id, { amount: 900_00, daysOverdue: 10 });
  const auth = await authFor(project);

  const first = await takeMove(stores(), auth, `chase_invoice:${inv.id}`, NOW);
  const second = await takeMove(stores(), auth, `chase_invoice:${inv.id}`, NOW);

  assert.equal(first.ok, true, first.ok ? "" : first.message);
  assert.equal(second.ok, false, "the second take must not spawn a second chase");
  assert.equal(second.ok === false && second.reason, "paced");
  assert.equal(spawned.length, 1, `expected one run, got ${spawned.length}`);
});

test("a taken move and a swept chase are the same run, field for field", async (t) => {
  // THE BUG: a second path to the same work. The carrier input was already shared via
  // `chaseTaskInput`, and that was never enough — each door still had its own claim, its own
  // document attachment and its own refusals, and the first field they would have drifted on is
  // `days_overdue`, the single number `next_step` branches on to pick a rung of the ladder. Both
  // doors now go through `startChase`, and this is what says so.
  const { spawned, restore } = recordingChaseDeps();
  t.after(restore);
  const project = `p-${randomUUID()}`;
  const client = await makeClient(project, "sameRun");
  const taken = await overdueInvoice(project, client.id, { amount: 1_234_00, daysOverdue: 12 });
  const swept = await overdueInvoice(project, client.id, { amount: 1_234_00, daysOverdue: 12 });

  const r = await takeMove(stores(), await authFor(project), `chase_invoice:${taken.id}`, NOW);
  assert.equal(r.ok, true, r.ok ? "" : r.message);
  await sweepOverdueInvoices({ project_id: project, now: NOW });

  const fromTake = spawned.find((s) => s.input.invoice_id === taken.id);
  const fromSweep = spawned.find((s) => s.input.invoice_id === swept.id);
  assert.ok(fromTake && fromSweep, "both doors must have spawned a run");
  assert.equal(fromTake.wedge, fromSweep.wedge);
  assert.equal(fromTake.task_type, fromSweep.task_type);
  assert.equal(fromTake.source, fromSweep.source);
  // Identical inputs but for WHICH invoice they are about. Compared as whole objects rather than
  // field by field, because the field a future change drifts on is exactly the one a hand-written
  // list of assertions forgot to include — `days_overdue` being the one that picks the rung.
  const anonymise = (i: Record<string, unknown>) => ({ ...i, invoice_id: null, invoice_number: null });
  assert.deepEqual(anonymise(fromTake.input), anonymise(fromSweep.input));
});

test("a move whose task type no wedge declares is honestly unavailable, not an error on click", async (t) => {
  // THE BUG: a live button for work nothing can carry. Four of the five kinds propose a
  // `carrier.task_type` that appears in no wedge manifest, so a run spawned for one arrives with no
  // output schema, no policy rules and no knowledge — an agent handed a verb nobody taught it. A
  // greyed-out button that says why is a truthful product; one that throws on click is a broken one.
  const { spawned, restore } = recordingChaseDeps();
  t.after(restore);
  const project = `p-${randomUUID()}`;
  const client = await makeClient(project, "unavailable");
  const req = await getRequestStore().createRequest({
    project_id: project, client_id: client.id, wedge: WEDGE, kind: "info",
    ask: "Send last year's accounts", detail: "",
  });

  assert.equal(takeability("chase_invoice").takeable, true);
  for (const kind of ["advance_case", "check_in_case", "gtm_next_touch"] as const) {
    const gate = takeability(kind);
    assert.equal(gate.takeable, false, `${kind} claims a carrier it does not have`);
    assert.ok(gate.reason && gate.reason.length > 10, `${kind} must say WHY it is unavailable`);
  }
  // `nudge_client_request` now HAS a carrier — but only for a wedge that declares it, and only when
  // an engagement names that wedge. Both halves are unavailable-with-a-reason, not an error.
  assert.equal(takeability("nudge_client_request", "").takeable, false, "an ask with no engagement has no voice");
  assert.equal(takeability("nudge_client_request", "gtm-operator").takeable, false, "a wedge that declares no nudge cannot carry one");
  assert.equal(takeability("nudge_client_request", WEDGE).takeable, true, `${WEDGE} declares nudge_client_request on disk`);

  // This request is attached to NO case, so nothing owns the voice a reminder would go out in.
  // Taken from far enough in the future that it is genuinely on the list — otherwise this would be
  // asserting "not proposed yet", which is a different (and much weaker) fact.
  const later = new Date(NOW.getTime() + (REQUEST_NUDGE_DAYS + 1) * DAY);
  const r = await takeMove(stores(), await authFor(project), `nudge_client_request:${req.id}`, later);
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.reason, "no_carrier");
  assert.equal(spawned.length, 0, "an unavailable move must not reach the harness at all");
});

/**
 * Every wedge manifest on disk, parsed once. Read rather than restated — a second copy of the source
 * of truth is the thing that goes stale, and this whole block exists to catch exactly that drift.
 */
type Manifest = {
  task_types?: Record<string, { harness?: unknown; input_schema?: any; output_schema?: any }>;
};
async function manifests(): Promise<Map<string, Manifest>> {
  const dir = new URL("../../wedges/", import.meta.url);
  const out = new Map<string, Manifest>();
  for (const slug of await readdir(dir)) {
    out.set(slug, JSON.parse(await readFile(new URL(`${slug}/wedge.json`, dir), "utf8")) as Manifest);
  }
  return out;
}

/**
 * The carrier task type each kind proposes. Kept in step with `moves.ts` by construction: these are
 * the strings the `carrier` blocks there write, and two of them are imported from the modules that
 * own them rather than spelled out, because those are the two that were wrong.
 */
const CARRIER_TYPE: Record<MoveKind, string> = {
  chase_invoice: "chase_invoice",
  nudge_client_request: "nudge_client_request",
  check_in_case: CHECK_IN_TASK_TYPE,
  gtm_next_touch: TOUCH_TASK_TYPE,
  advance_case: "advance_case",
  // Named so the guard keeps working, not because anything declares it. If a wedge ever does, the
  // assertion below fails and sends whoever did it to `takeability` — which refuses this kind on
  // purpose, because deciding what happens to a client who went silent is not a task type.
  unblock_wait: "unblock_wait",
  // DECLARED ON DISK AND REFUSED ANYWAY. Pinned explicitly below rather than skipped silently.
  rewrite_losing_arm: "build_feature",
  // No carrier at all, deliberately: raising an invoice is `POST /v1/invoices`, not a wedge task.
  invoice_accepted_work: "",
  // No carrier at all: releasing is `POST /v1/deliverables/:id/release`, a founder gate, not a task.
  release_deliverable: "",
};

/**
 * THE BUG THIS BLOCK PREVENTS, in the direction that matters most: a takeable kind whose carrier is
 * a name nobody declared.
 *
 * That is not hypothetical — it is what `gtm_next_touch` was. It proposed the task type
 * `"gtm_next_touch"`, which appears in no manifest, no dispatcher and no scheduler; it had been
 * invented out of the move's own kind. The old version of this test could not catch it, because it
 * only compared `TAKEABLE_KINDS` against disk and that kind was (correctly, by the letter) not in
 * the list. The lie was one level down: the reason shown to the founder said no wedge could carry an
 * outreach touch, while the sequencer dispatched `outreach_touch` for the same case every five
 * minutes.
 *
 * So the assertion is now on the CARRIER, wedge by wedge, for every kind — and it runs in both
 * directions, because both directions are real failures: a takeable kind with no declaration spawns
 * an agent with no contract, and a declared carrier that stays greyed out is a capability the
 * business has and the product denies.
 */
test("every takeable kind names a carrier a real manifest declares, wedge by wedge", async () => {
  const all = await manifests();
  const declaredAnywhere = new Set<string>();
  for (const m of all.values()) for (const t of Object.keys(m.task_types ?? {})) declaredAnywhere.add(t);

  // The unconditional list, checked against disk exactly as before.
  const refusedOnPurpose: MoveKind[] = ["rewrite_losing_arm", "advance_case", "unblock_wait", "invoice_accepted_work", "release_deliverable"];
  for (const kind of MOVE_KINDS) {
    if (CONDITIONAL_KINDS.includes(kind) || refusedOnPurpose.includes(kind)) continue;
    assert.equal(
      TAKEABLE_KINDS.includes(kind),
      declaredAnywhere.has(CARRIER_TYPE[kind]),
      `TAKEABLE_KINDS disagrees with the manifests about ${kind} (declared on disk: ${declaredAnywhere.has(CARRIER_TYPE[kind])})`,
    );
  }

  // The conditional kinds, per wedge. This is the assertion the old test could not make: for every
  // installed wedge and every per-wedge kind, `takeability` must give the manifest's own answer.
  for (const kind of CONDITIONAL_KINDS) {
    assert.ok(!TAKEABLE_KINDS.includes(kind), `${kind}'s takeability is per-wedge, not per-kind`);
    assert.ok(declaredAnywhere.has(CARRIER_TYPE[kind]), `nothing on disk declares ${CARRIER_TYPE[kind]}, so ${kind} is dead code`);
    for (const [slug, m] of all) {
      assert.equal(
        takeability(kind, slug).takeable,
        !!m.task_types?.[CARRIER_TYPE[kind]],
        `takeability disagrees with ${slug}/wedge.json about ${kind}`,
      );
    }
    // A wedge that does not exist is never takeable — the fail-closed half, which is what a founder
    // hits when an engagement names a service that has since been removed.
    assert.equal(takeability(kind, "not-installed").takeable, false, `${kind} was takeable for a service that is not installed`);
    assert.equal(takeability(kind, "").takeable, false, `${kind} was takeable with no wedge behind it`);
  }
});

/**
 * THE BUG: breadth faked with an empty declaration.
 *
 * The cheap way to light up four more buttons is to add `"advance_case": {}` to each wedge. The
 * manifest would parse, `wedgeDeclares` would say yes, and the button would go live over a run with
 * no output schema, no rubric and no knowledge — an agent handed a verb nobody taught it, which
 * always "succeeds" and never does anything. That is strictly worse than the button being absent,
 * because the founder now believes the work was started.
 *
 * So a declaration has to carry a CONTRACT, and which contract depends on what the task type is:
 *
 *   · A RUN (it declares a `harness` block, so a model is invoked) owes an `output_schema` with a
 *     non-empty `required`. Without required fields, `strict_output` has nothing to enforce and the
 *     run's answer is prose.
 *   · A ROW (no `harness` block — `outreach_touch` is the only one, created by the dispatcher so the
 *     message stays inspectable) owes an `input_schema` with a non-empty `required`, because the
 *     input is the whole of what it records.
 */
test("no takeable kind is carried by a hollow declaration", async () => {
  const all = await manifests();
  const checked: string[] = [];
  for (const kind of [...TAKEABLE_KINDS, ...CONDITIONAL_KINDS]) {
    const type = CARRIER_TYPE[kind];
    for (const [slug, m] of all) {
      const t = m.task_types?.[type];
      if (!t) continue;
      // Only the declarations a founder can actually reach: `takeability` is the gate, so if it
      // refuses this wedge the declaration is not carrying anything and is not this test's business.
      if (CONDITIONAL_KINDS.includes(kind) && !takeability(kind, slug).takeable) continue;
      checked.push(`${slug}/${type}`);
      if (t.harness) {
        assert.ok(t.output_schema, `${slug}/${type} is a run with no output_schema`);
        assert.ok(
          Array.isArray(t.output_schema.required) && t.output_schema.required.length > 0,
          `${slug}/${type} declares an output_schema with no required fields — strict_output has nothing to hold it to`,
        );
      } else {
        assert.ok(t.input_schema, `${slug}/${type} is a row with no input_schema`);
        assert.ok(
          Array.isArray(t.input_schema.required) && t.input_schema.required.length > 0,
          `${slug}/${type} declares an input_schema with no required fields — nothing pins what the row must record`,
        );
      }
    }
  }
  // The test must actually have looked at something. A refactor that renamed every carrier would
  // otherwise leave this passing over an empty loop, which is the failure mode of every "for each
  // thing, assert" test ever written.
  assert.ok(checked.length >= 4, `expected several carriers to check, found ${checked.join(", ") || "none"}`);
});

/**
 * THE BUG: a deliberate refusal decaying into an accident.
 *
 * Four kinds are refused for reasons that have nothing to do with manifests, and each reason is a
 * decision somebody could undo by deleting three lines. Both halves of each are pinned — that the
 * kind is still refused, AND that the refusal says the true thing — so an edit that quietly changes
 * what a button on the founder's home screen does fails a test instead.
 */
test("the four kinds refused on purpose stay refused, for the reasons given", async () => {
  const all = await manifests();
  const declaredAnywhere = new Set<string>();
  for (const m of all.values()) for (const t of Object.keys(m.task_types ?? {})) declaredAnywhere.add(t);

  // `rewrite_losing_arm`: its carrier really exists. Taking it would publish a marketing page with
  // no approval between the click and the internet (`orchestrator.ts` deploys on run completion).
  assert.ok(declaredAnywhere.has("build_feature"), "product-builder no longer declares build_feature");
  assert.ok(!takeability("rewrite_losing_arm").takeable, "rewrite_losing_arm became takeable — a click would now publish a page");
  assert.match(takeability("rewrite_losing_arm").reason ?? "", /publish/i, "the refusal must say it is about publishing");

  // `advance_case`: the one most likely to be faked, because declaring the type is easy and what
  // would be behind it is nothing. The refusal must point at the work, not shrug.
  assert.ok(!declaredAnywhere.has("advance_case"), "a wedge now declares advance_case — go and read `takeability`");
  assert.ok(!takeability("advance_case", WEDGE).takeable);
  assert.match(takeability("advance_case", WEDGE).reason ?? "", /open it|check in/i, "the refusal must say what to do instead");

  // `unblock_wait`: a judgement about a relationship, and it will never have a carrier.
  assert.ok(!declaredAnywhere.has("unblock_wait"));
  assert.ok(!takeability("unblock_wait").takeable);
  assert.match(takeability("unblock_wait").reason ?? "", /judgement/i);

  // `invoice_accepted_work`: pricing your own work is not agent work, and the carrier is empty on
  // purpose so `takeability` reads the absence rather than a plausible-looking name.
  assert.equal(CARRIER_TYPE.invoice_accepted_work, "", "invoice_accepted_work must name no carrier at all");
  assert.ok(!takeability("invoice_accepted_work").takeable);
  assert.match(takeability("invoice_accepted_work").reason ?? "", /raise the invoice/i, "the refusal must say where to go");

  // And EVERY kind that is not takeable gives a sentence. A greyed control with no reason is the
  // thing this whole design refuses; an empty string would satisfy `takeable: false` and say nothing.
  for (const kind of MOVE_KINDS) {
    // The slug is interpolated into some refusals, so it must not itself contain the vocabulary this
    // loop is looking for — otherwise the assertion below fails on the fixture rather than the code.
    for (const wedge of [undefined, WEDGE, "not-installed"]) {
      const gate = takeability(kind, wedge);
      if (gate.takeable) continue;
      assert.ok((gate.reason ?? "").length > 30, `${kind}/${wedge} refuses with no usable reason: ${gate.reason}`);
      // A customer-facing sentence never names the machinery. vision Law: no "wedge", no "kernel".
      assert.doesNotMatch(gate.reason!, /\b(wedge|kernel|harness|provision)\b/i, `${kind}/${wedge} leaks internal vocabulary`);
    }
  }
});

test("release_deliverable: an in_review deliverable surfaces on /next; a released one does not", async () => {
  const project = `p-rel-${randomUUID().slice(0, 8)}`;
  const client = await makeClient(project, "Acme");
  const kase = await getDomainStore().createCase({
    project_id: project,
    wedge: WEDGE,
    title: "Homepage",
    client_id: client.id,
  });
  const dstore = getDeliverableStore();
  const d = await dstore.createDeliverable({
    project_id: project,
    case_id: kase.id,
    client_id: client.id,
    title: "Homepage copy",
    kind: "document",
  } as never);
  // A submitted version drives the deliverable to `in_review` — the state ignition leaves it in.
  await dstore.submitVersion({
    project_id: project,
    deliverable_id: d.id,
    allowedFrom: ["drafting"],
    version: { summary: "first draft", artifact_ids: ["art-1"] } as never,
    at: NOW.toISOString(),
  });

  const m = (await proposeMoves(stores(), await authFor(project), { kinds: ["release_deliverable"] }, NOW)).moves.find(
    (x) => x.id === `release_deliverable:${d.id}`,
  );
  assert.ok(m, "an in_review deliverable must surface a release_deliverable move");
  assert.equal(m!.takeable, false, "releasing is founder-only — never takeable");
  assert.equal(m!.carrier.wedge, "", "no carrier — it must not spawn a run");
  assert.ok(m!.score_terms.some((t) => t.term === "ready"), "ranked on being finished-and-waiting");

  // Released to the client → with_client → the founder's job is done, the move disappears.
  await dstore.transitionDeliverable(project, d.id, "with_client", ["in_review"], NOW.toISOString());
  const after = (await proposeMoves(stores(), await authFor(project), { kinds: ["release_deliverable"] }, NOW)).moves;
  assert.ok(
    !after.some((x) => x.id === `release_deliverable:${d.id}`),
    "a released (with_client) deliverable is the client's now, not the founder's job",
  );

  // And releasing is refused as a click, with a sentence that says where to go.
  assert.equal(takeability("release_deliverable").takeable, false);
  assert.match(takeability("release_deliverable").reason ?? "", /release/i);
});

/**
 * THE BUG: more executable kinds quietly becoming more volume.
 *
 * This change made two more kinds takeable, and `permits` in autonomy.ts refuses any move with
 * `takeable: false` — so widening takeability widens what the SWEEP is allowed to consider, for
 * free, without anybody editing autonomy.ts. The ceilings are the only thing that stops that being a
 * change in how much the business does on its own at 03:00, and they are asserted as LITERALS rather
 * than compared to themselves, because a test that reads the constant it is guarding passes no
 * matter what somebody sets it to.
 */
test("the autonomy ceilings did not move when the kinds widened", () => {
  assert.equal(HARD_MAX_PER_SWEEP, 5, "the per-sweep ceiling moved");
  assert.equal(HARD_MAX_PER_DAY, 20, "the per-day ceiling moved");
});

// ── the kinds that became executable ─────────────────────────────────────────────────────────────

/** The check-in carrier's spawn, recorded. The twin of `recordingChaseDeps`, for the same reason. */
function recordingCheckInDeps(opts: { enabled?: boolean } = {}) {
  const spawned: Spawned[] = [];
  setCheckInDeps({
    wedgeEnabled: () => opts.enabled !== false,
    spawnTask: async (a) => {
      spawned.push(a as Spawned);
      return `task-${spawned.length}-${randomUUID().slice(0, 8)}`;
    },
  });
  return { spawned, restore: () => setCheckInDeps(null) };
}

/** A silent engagement on a wedge that declares the check-in. */
async function quietCase(projectId: string, clientId: string, daysSilent: number) {
  const k = await getDomainStore().createCase({
    project_id: projectId,
    client_id: clientId,
    wedge: WEDGE,
    title: "Month-end close",
    stage: "collecting",
    status: "open",
  });
  // `updated_at` is what `checkInMove` reads, and `createCase` stamps it to now. Backdated through
  // the store rather than by mutating the object, so the memory and Postgres paths see one fixture.
  (await getDomainStore().getCase(k.id))!.updated_at = new Date(NOW.getTime() - daysSilent * DAY).toISOString();
  return (await getDomainStore().getCase(k.id))!;
}

test("a quiet engagement can actually be taken, and taking it twice runs it once", async (t) => {
  /**
   * THE BUG, IN TWO HALVES.
   *
   * The first: `check_in_case` proposed a carrier — `wedge/check_in_case` — that no manifest declared,
   * so the highest-ranked row on a quiet founder's list was a grey button with an apology. A ranked
   * list whose top rows cannot be acted on is a reading list.
   *
   * The second, which arrives the moment the first is fixed: move ids are DETERMINISTIC, so two
   * clicks are two identical valid requests, and a check-in is a message to a real client. Without
   * `claimCaseMarker`'s compare-and-set, an impatient founder puts two identical "just checking in"
   * notes in one inbox an instant apart — the most embarrassing failure this product can produce,
   * because it is the one the client sees.
   */
  const { spawned, restore } = recordingCheckInDeps();
  t.after(restore);
  const project = `p-${randomUUID()}`;
  const client = await makeClient(project, "quiet");
  const kase = await quietCase(project, client.id, CASE_STALE_DAYS + 5);
  const auth = await authFor(project);

  const proposal = await proposeMoves(stores(), auth, {}, NOW);
  const move = proposal.moves.find((m) => m.id === `check_in_case:${kase.id}`);
  assert.ok(move, `no check-in was proposed: ${kindsOf(proposal.moves)}`);
  assert.equal(move!.takeable, true, `still not takeable: ${move!.unavailable_reason}`);
  assert.equal(move!.carrier.task_type, CHECK_IN_TASK_TYPE);

  const first = await takeMove(stores(), auth, move!.id, NOW);
  const second = await takeMove(stores(), auth, move!.id, NOW);
  assert.equal(first.ok, true, first.ok ? "" : first.message);
  assert.equal(second.ok, false, "the second take must not spawn a second check-in");
  assert.equal(spawned.length, 1, `expected one run, got ${spawned.length}`);
  assert.equal(spawned[0].task_type, CHECK_IN_TASK_TYPE);
  assert.equal(spawned[0].wedge, WEDGE, "a check-in must go out in the engagement's own voice");
  assert.equal(spawned[0].case_id, kase.id);
  // The tone input the agent writes against. A hand-rolled second builder would have got this first.
  assert.equal(spawned[0].input.days_silent, CASE_STALE_DAYS + 5);

  // And the claim is what did it, not merely the ranking: the cooldown must still hold a take made
  // from a page drawn before the first one, right up to the day it expires.
  const insideCooldown = new Date(NOW.getTime() + (CHECK_IN_COOLDOWN_DAYS - 1) * DAY);
  const third = await startCheckIn(getDomainStore(), (await getDomainStore().getCase(kase.id))!, {
    pacing: "ladder",
    now: insideCooldown,
  });
  assert.equal(third.ok, false);
  assert.equal(third.ok === false && third.reason, "paced");
  assert.equal(spawned.length, 1, "the cooldown let a second check-in through");
});

test("a check-in cannot be taken across tenants, and the refusal reveals nothing", async (t) => {
  // THE BUG: the leak family this codebase has already had four times — a scope checked one layer up.
  // `takeMove` re-proposes under the caller's OWN authority and looks the id up in that list, so
  // another founder's engagement is not merely refused, it is indistinguishable from a stale id.
  const { spawned, restore } = recordingCheckInDeps();
  t.after(restore);
  const mine = `p-${randomUUID()}`;
  const theirs = `p-${randomUUID()}`;
  await makeClient(mine, "mine-ci");
  const theirClient = await makeClient(theirs, "theirs-ci");
  const theirCase = await quietCase(theirs, theirClient.id, CASE_STALE_DAYS + 10);

  const r = await takeMove(stores(), await authFor(mine), `check_in_case:${theirCase.id}`, NOW);
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.reason, "not_proposed", "a cross-tenant id must look exactly like a stale one");
  assert.equal(spawned.length, 0, "no run may be spawned against another tenant's engagement");
  // And their row is untouched: no claim stamped, so their own list is not silently paced by us.
  const after = (await getDomainStore().getCase(theirCase.id))!;
  assert.equal((after.data as Record<string, unknown> | undefined)?.last_checked_in_at, undefined);
});

test("a kind refused on purpose gives a founder a reason instead of an error", async (t) => {
  /**
   * THE BUG: a refusal that behaves like a fault. `advance_case` will not be takeable — the work it
   * points at is the engagement's own — and the honest product is a row that says so and stays on
   * the list. A `takeMove` that threw, or that returned a bare "error", would make a deliberate
   * design decision indistinguishable from something being broken, and the founder's response to
   * that is to stop trusting every other row on the page.
   */
  const { spawned, restore } = recordingCheckInDeps();
  t.after(restore);
  const project = `p-${randomUUID()}`;
  const client = await makeClient(project, "dated");
  const kase = await getDomainStore().createCase({
    project_id: project, client_id: client.id, wedge: WEDGE, title: "Year-end filing",
    stage: "review", status: "open", due_at: new Date(NOW.getTime() + 2 * DAY).toISOString(),
  });
  const auth = await authFor(project);

  const move = (await proposeMoves(stores(), auth, {}, NOW)).moves.find((m) => m.kind === "advance_case");
  assert.ok(move, "a dated engagement must still be NOTICED even though it cannot be taken");
  assert.equal(move!.takeable, false);
  assert.ok((move!.unavailable_reason ?? "").length > 30, "an unavailable row with no reason is a broken button");

  const r = await takeMove(stores(), auth, `advance_case:${kase.id}`, NOW);
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.reason, "no_carrier");
  assert.equal(r.ok === false && r.message, move!.unavailable_reason, "the row and the click must give one answer");
  assert.equal(spawned.length, 0, "an unavailable move must not reach the harness at all");
});

// ── consequences ─────────────────────────────────────────────────────────────────────────────────

test("what the business achieved is ranked by consequence, not by recency", () => {
  /**
   * THE BUG: a reverse-chronological feed. Sixteen things happen in a fortnight and four are worth a
   * founder's minute; ordering them by clock puts a prospect's "thanks, not now" above eleven
   * thousand pounds landing, and a surface that does that is skimmed once and then ignored — which
   * is the same failure the ranked move list exists to avoid, on the other side of the loop.
   *
   * Asserted as an ORDERING over weights rather than by pinning the numbers, so the test still means
   * something after somebody tunes them: money first, an unblocked ask second, a reply third.
   */
  const at = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * DAY).toISOString();
  const row = (o: Partial<MoveOutcome> & Pick<MoveOutcome, "kind" | "result" | "at">): MoveOutcome => ({
    v: 1, move_id: `${o.kind}:${o.entity_id ?? "e"}`, entity_id: "e", by: "system", ...o,
  });
  const ranked = consequencesOf(
    [
      row({ kind: "gtm_next_touch", result: "replied", at: at(0), note: "they replied 1 day after the last touch" }),
      row({ kind: "nudge_client_request", result: "done", at: at(3), note: "\"March statement\" was answered" }),
      row({ kind: "chase_invoice", result: "paid", at: at(6), note: "INV-104 settled in full 2 days after the last chase" }),
      // Recorded by a founder pressing a button that says "didn't work". A real outcome, and NOT a
      // consequence: a list of things that failed is a different surface with a different job.
      row({ kind: "chase_invoice", result: "rejected", at: at(1), by: "member-1" }),
      // Outside the window. Real, and no longer news.
      row({ kind: "chase_invoice", result: "paid", at: at(CONSEQUENCE_WINDOW_DAYS + 1), note: "ancient" }),
    ],
    NOW,
  );
  assert.deepEqual(
    ranked.map((c) => c.result),
    ["paid", "done", "replied"],
    "the oldest event in the list is the one that mattered most, and it must come first",
  );
  assert.equal(ranked[0].what, "INV-104 settled in full 2 days after the last chase", "the observer's own sentence, verbatim");
  assert.ok(ranked.every((c) => c.by === "system"), "only observed facts, never a founder's opinion, count as a consequence");
  assert.ok(ranked.length <= MAX_CONSEQUENCES);
});

test("a chase that got paid comes back to the founder as a consequence", async () => {
  /**
   * THE BUG: the loop turning invisibly. `noteInvoiceSettled` wrote a row, `learnedPoints` moved by a
   * point, and the founder's home screen looked exactly the same — one row shorter, which is
   * indistinguishable from a list that lost a row. This is the end-to-end version: the harness
   * observes a settlement, and the next read of the business says so on the same page as the work.
   */
  const project = `p-${randomUUID()}`;
  const client = await makeClient(project, "landed");
  const inv = await overdueInvoice(project, client.id, { amount: 4_000_00, daysOverdue: 20, lastChasedDaysAgo: 2 });
  const settled = { ...(await getBillingStore().getInvoice(inv.id))! };

  const auth = await authFor(project);
  const wrote = await noteInvoiceSettled(getDomainStore(), systemMoveAuthority(project), settled, NOW.toISOString());
  assert.ok(wrote, "the settlement was not credited to the chase that plausibly earned it");

  const proposal = await proposeMoves(stores(), auth, {}, NOW);
  const hit = proposal.consequences.find((c) => c.move_id === `chase_invoice:${inv.id}`);
  assert.ok(hit, `the settlement did not surface: ${JSON.stringify(proposal.consequences)}`);
  assert.equal(hit!.result, "paid");
  assert.match(hit!.what, /settled in full/);
  // A customer-facing surface never sees the machinery, and this string is rendered on `/next`.
  assert.doesNotMatch(hit!.what, /\b(wedge|kernel|harness|provision)\b/i);
});

test("consequences are scoped to the tenant that earned them", async () => {
  // THE BUG: the leak family again, on a read that is easy to forget because it looks like a summary
  // rather than a query. `readOutcomes` pushes the project INTO `queryRecords` — a post-filter would
  // leak the moment `MAX_OUTCOME_ROWS` truncated another tenant's rows into view.
  const mine = `p-${randomUUID()}`;
  const theirs = `p-${randomUUID()}`;
  await makeClient(mine, "mine-c");
  await recordOutcome(getDomainStore(), systemMoveAuthority(theirs), {
    move_id: "chase_invoice:not-mine", kind: "chase_invoice", entity_id: "not-mine",
    result: "paid", by: "system", note: "THEIR invoice settled", at: NOW.toISOString(),
  });
  const proposal = await proposeMoves(stores(), await authFor(mine), {}, NOW);
  assert.deepEqual(proposal.consequences, [], "another business's win appeared on this founder's page");
});

test("a move id from another business cannot be taken, and is not confirmed to exist", async (t) => {
  // THE BUG: the leak family this codebase has already had four times — a scope checked one layer
  // up, or a tenant taken from the request body. `takeMove` re-proposes under the caller's own
  // authority and looks the id up in THAT list, so another founder's invoice is not merely refused,
  // it is indistinguishable from an id that was never real.
  const { spawned, restore } = recordingChaseDeps();
  t.after(restore);
  const mine = `p-${randomUUID()}`;
  const theirs = `p-${randomUUID()}`;
  await makeClient(mine, "mine");
  const theirClient = await makeClient(theirs, "theirs");
  const theirInvoice = await overdueInvoice(theirs, theirClient.id, { amount: 5_000_00, daysOverdue: 40 });

  const r = await takeMove(stores(), await authFor(mine), `chase_invoice:${theirInvoice.id}`, NOW);
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.reason, "not_proposed", "a cross-tenant id must look exactly like a stale one");
  assert.equal(spawned.length, 0, "no run may be spawned for another tenant's invoice");
  // And the invoice is untouched: no claim stamped, so their own sweep is not silently paced by us.
  assert.equal((await getBillingStore().getInvoice(theirInvoice.id))!.last_chased_at, undefined);
});

// ── outcomes the harness already knows ───────────────────────────────────────────────────────────

test("a settlement inside the window credits the chase; one outside credits nothing", async () => {
  // THE BUG: attribution with no clock. Crediting every chase for every later payment would make
  // `learnedPoints` a measure of how often clients eventually pay — which is close to always — and
  // the engine would conclude chasing works no matter what it does. The brief's example is the
  // failure exactly: a payment two months either side of a chase is not that chase's outcome.
  const project = `p-${randomUUID()}`;
  const client = await makeClient(project, "settles");
  const auth = await authFor(project);

  const chased = await overdueInvoice(project, client.id, { amount: 400_00, daysOverdue: 20, lastChasedDaysAgo: 3 });
  const stale = await overdueInvoice(project, client.id, { amount: 400_00, daysOverdue: 200, lastChasedDaysAgo: PAID_ATTRIBUTION_DAYS + 5 });
  const never = await overdueInvoice(project, client.id, { amount: 400_00, daysOverdue: 20 });

  assert.ok(await noteInvoiceSettled(getDomainStore(), auth, chased, NOW.toISOString()));
  assert.equal(await noteInvoiceSettled(getDomainStore(), auth, stale, NOW.toISOString()), undefined, "a chase older than the window earns no credit");
  assert.equal(await noteInvoiceSettled(getDomainStore(), auth, never, NOW.toISOString()), undefined, "an invoice nobody chased credits no chase");
  // Paid BEFORE the chase: clock skew or a backdated payment. A chase cannot cause the past.
  assert.equal(await noteInvoiceSettled(getDomainStore(), auth, chased, ago(10)), undefined);

  const stats = await outcomeStats(getDomainStore(), auth);
  assert.equal(stats.get("chase_invoice")?.taken, 1, "exactly one settlement was attributable");
  assert.equal(stats.get("chase_invoice")?.worked, 1);
});

test("a derived outcome lands in the project the row belongs to, and nowhere else", async () => {
  // THE BUG: an outcome written under the caller's project rather than the row's. It would train the
  // wrong founder's ranking, silently, from a payment they never saw — the same shape as the leaks
  // the authority pattern exists to prevent, arriving this time through a row a caller handed us.
  const mine = `p-${randomUUID()}`;
  const theirs = `p-${randomUUID()}`;
  const theirClient = await makeClient(theirs, "otherco");
  const theirInvoice = await overdueInvoice(theirs, theirClient.id, { amount: 100_00, daysOverdue: 5, lastChasedDaysAgo: 1 });

  // Their invoice, my authority. Refused rather than written.
  assert.equal(await noteInvoiceSettled(getDomainStore(), systemMoveAuthority(mine), theirInvoice, NOW.toISOString()), undefined);
  assert.equal((await outcomeStats(getDomainStore(), await authFor(mine))).size, 0);
  assert.ok(await noteInvoiceSettled(getDomainStore(), systemMoveAuthority(theirs), theirInvoice, NOW.toISOString()));
  assert.equal((await outcomeStats(getDomainStore(), await authFor(theirs))).get("chase_invoice")?.worked, 1);
});

test("a reply credits the touch that earned it, only inside the reply window", async () => {
  // THE BUG: `gtm_next_touch` could never cross `MIN_EVIDENCE`, because the only way to record a
  // reply was a founder going back to /next and clicking — while `noteInboundReplies` was watching
  // the exact event. And the window matters in the other direction: a prospect answering out of the
  // blue three months later must not retroactively make an old sequence look effective.
  const project = `p-${randomUUID()}`;
  const auth = systemMoveAuthority(project);
  const recent = { id: `k-${randomUUID()}`, project_id: project, data: { last_touch_at: ago(2) } };
  const ancient = { id: `k-${randomUUID()}`, project_id: project, data: { last_touch_at: ago(REPLY_ATTRIBUTION_DAYS + 3) } };
  const untouched = { id: `k-${randomUUID()}`, project_id: project, data: {} };

  assert.ok(await noteReplyToTouch(getDomainStore(), auth, recent, NOW.toISOString()));
  assert.equal(await noteReplyToTouch(getDomainStore(), auth, ancient, NOW.toISOString()), undefined);
  // A prospect replying to something this campaign never sent — enrolled mid-conversation, or
  // answering a message the founder wrote by hand. Real, and not ours to take credit for.
  assert.equal(await noteReplyToTouch(getDomainStore(), auth, untouched, NOW.toISOString()), undefined);

  const stats = await outcomeStats(getDomainStore(), await authFor(project));
  assert.equal(stats.get("gtm_next_touch")?.worked, 1);
});

test("a derived outcome is marked as observed, not as something a human said", async () => {
  // THE BUG: `by` set to a member id on a write nobody clicked. The ledger is the evidence the
  // ranking learns from, and an operator reading it has to be able to tell an observed fact from a
  // founder's opinion — only one of them says anything about the founder.
  const project = `p-${randomUUID()}`;
  const client = await makeClient(project, "observed");
  const inv = await overdueInvoice(project, client.id, { amount: 100_00, daysOverdue: 5, lastChasedDaysAgo: 1 });
  const o = await noteInvoiceSettled(getDomainStore(), systemMoveAuthority(project), inv, NOW.toISOString());
  assert.equal(o?.by, "system");
  assert.equal(o?.result, "paid");
  // The SAME id `chaseMove` computes, so a founder's click and the observed settlement accumulate
  // against one move rather than two.
  assert.equal(o?.move_id, `chase_invoice:${inv.id}`);
});

// ═══ the decided marketing experiment as a ranked move ═══════════════════════════════════════════
//
// Four bugs are named below, and they are the four the design of `rewrite_losing_arm` is a response
// to: an undecided test producing a move at all; speculative work outranking money owed; a verdict
// computed from one tenant's traffic appearing on another's home screen; and a page that could be
// republished without a human.

/**
 * Seed one project's insight window with an A/B split.
 *
 * Writes through `storeBatch` rather than hand-rolling a record so the arm-name wire convention
 * (`$exposure:<arm>` / `$convert:<arm>`, see `insight/experiment.ts`) is exercised end to end. A
 * test that inserted a pre-counted row would keep passing if the prefixes ever changed.
 */
async function seedArms(
  projectId: string,
  arms: Array<{ arm: string; exposures: number; conversions: number }>,
  at: Date = NOW,
): Promise<void> {
  const events: Array<{ name: string }> = [];
  for (const a of arms) {
    for (let i = 0; i < a.exposures; i++) events.push({ name: `$exposure:${a.arm}` });
    for (let i = 0; i < a.conversions; i++) events.push({ name: `$convert:${a.arm}` });
  }
  await storeBatch(getDomainStore(), projectId, { events }, at);
}

const siteMoveIn = (moves: Move[]): Move | undefined => moves.find((m) => m.kind === "rewrite_losing_arm");

test("an experiment that has not decided produces no move at all", async () => {
  // THE BUG: relocating the thrashing `insight/experiment.ts` exists to prevent onto the home
  // screen. A row on a ranked list is an instruction whatever hedging sits in its subtitle, so an
  // undecided test must not be a low-scoring row — it must be no row. Three shapes of undecided are
  // checked, because they fail different gates and a fix that only closed one would look correct.
  const domain = getDomainStore();

  // (1) Under the exposure floor. Two arms, a huge apparent gap, twenty visitors.
  const thin = `p-${randomUUID()}`;
  await seedArms(thin, [
    { arm: "hero-a", exposures: 20, conversions: 2 },
    { arm: "hero-b", exposures: 20, conversions: 8 },
  ]);
  assert.equal(
    siteMoveIn((await proposeMoves(stores(), await authFor(thin))).moves),
    undefined,
    "20 visitors an arm produced a move — the 200-exposure floor is not reaching the ranking",
  );

  // (2) Plenty of traffic, difference within noise. This is the one that matters most: it looks
  // like a result to a human eyeballing the rates, and the z-test refuses it.
  const noisy = `p-${randomUUID()}`;
  await seedArms(noisy, [
    { arm: "hero-a", exposures: 500, conversions: 50 },
    { arm: "hero-b", exposures: 500, conversions: 57 },
  ]);
  assert.equal(
    siteMoveIn((await proposeMoves(stores(), await authFor(noisy))).moves),
    undefined,
    "a 14% relative gap at 500 exposures is inside the noise band and must not be proposed",
  );

  // (3) Real and significant, but too small to be worth rewriting a client's page for.
  const trivial = `p-${randomUUID()}`;
  await seedArms(trivial, [
    { arm: "hero-a", exposures: 20_000, conversions: 2_000 },
    { arm: "hero-b", exposures: 20_000, conversions: 2_100 },
  ]);
  assert.equal(
    siteMoveIn((await proposeMoves(stores(), await authFor(trivial))).moves),
    undefined,
    "a 5% lift cleared significance and must still be refused by MIN_RELATIVE_LIFT",
  );

  // And a project with no marketing site at all is silent rather than empty-and-noisy.
  const none = `p-${randomUUID()}`;
  assert.equal(siteMoveIn((await proposeMoves(stores(), await authFor(none))).moves), undefined);
  assert.ok(domain, "domain store is the only store this block needed");
});

test("a decided experiment is proposed, quotes the kernel's own verdict, and is not takeable", async () => {
  // THE BUG this half prevents: two accounts of one decision. The founder's row and the agent's
  // `mycel-insight` read must carry the SAME sentence, or the day they diverge is the day the
  // founder stops trusting the run that acted on it.
  const project = `p-${randomUUID()}`;
  await seedArms(project, [
    { arm: "hero-a", exposures: 4_000, conversions: 200 }, // 5.0%
    { arm: "hero-b", exposures: 4_000, conversions: 400 }, // 10.0% — a doubling
  ]);

  const proposal = await proposeMoves(stores(), await authFor(project));
  const move = siteMoveIn(proposal.moves);
  assert.ok(move, "a decided experiment produced no move");
  assert.equal(move.id, "rewrite_losing_arm:hero-a", "keyed on the losing arm, so a flip is a new move");
  assert.equal(move.entity.kind, "experiment");
  assert.equal(move.project_id, project);
  // No counterparty: the marketing page is a property of the project, not a noun with an edge.
  assert.equal(move.client_id, undefined);
  assert.equal(move.case_id, undefined);

  // The verdict, verbatim — the same string `insight/summary.ts` puts in front of the agent.
  const report = analyseExperiment(
    { "$exposure:hero-a": 4_000, "$convert:hero-a": 200, "$exposure:hero-b": 4_000, "$convert:hero-b": 400 },
    CONVERSION_METRIC,
  );
  assert.equal(move.why, report?.verdict);
  assert.equal(report?.loser, "hero-a");

  // NOT takeable, and refused for the publishing reason rather than for a missing carrier — the
  // carrier is real (`product-builder` declares `build_feature`) and the button is still dark.
  assert.equal(move.takeable, false, "a click would deploy a new homepage with no approval");
  assert.match(move.unavailable_reason ?? "", /publish/i);
  assert.equal(move.carrier.task_type, "build_feature");
  const taken = await takeMove(stores(), await authFor(project), move.id);
  assert.equal(taken.ok, false);
  assert.equal(taken.ok === false && taken.reason, "no_carrier");

  // NO MONEY. The founder's home screen sums `money_at_stake` into "$X in play"; a modelled number
  // there makes that total part fact and part arithmetic nobody can separate.
  assert.equal(move.signals.money_at_stake, undefined, "a site move must never carry a money figure");
  assert.ok(!move.score_terms.some((t) => t.term === "money"));
  assert.deepEqual(
    move.score_terms.map((t) => t.term).filter((t) => t !== "learned"),
    ["evidence", "waste"],
    "the site move competes on its own two axes and no others",
  );
});

test("no possible site move can outrank a certain overdue invoice", async () => {
  // THE BUG: a moves list where speculative work beats money owed. That is a product nobody trusts
  // twice, and it is one raised constant away at all times.
  //
  // Asserted against the CAP rather than against the scores that happen to occur, because a test
  // over observed values keeps passing while the ceiling drifts. `MAX_SITE_MOVE_SCORE` is exported
  // from moves.ts precisely so this is a comparison of two numbers and not a re-derivation.
  const project = `p-${randomUUID()}`;
  const client = await makeClient(project, "still owes us");

  // The most a decided experiment can ever be worth: an enormous lift on enormous traffic.
  await seedArms(project, [
    { arm: "hero-a", exposures: 60_000, conversions: 600 }, //  1%
    { arm: "hero-b", exposures: 60_000, conversions: 12_000 }, // 20% — a 20x lift
  ]);
  // A SMALL invoice, one day late. $100, not $4,000 — the interesting case is the cheapest chase
  // that must still win, not the expensive one that obviously does.
  const inv = await overdueInvoice(project, client.id, { amount: 100_00, daysOverdue: 1, lastChasedDaysAgo: 30 });

  const { moves } = await proposeMoves(stores(), await authFor(project));
  const site = siteMoveIn(moves);
  const chase = moves.find((m) => m.id === `chase_invoice:${inv.id}`);
  assert.ok(site, "the maximal experiment produced no move, so this proves nothing");
  assert.ok(chase, "the invoice was not proposed, so this proves nothing");

  assert.ok(
    site.score <= MAX_SITE_MOVE_SCORE,
    `a site move scored ${site.score}, above its own declared ceiling of ${MAX_SITE_MOVE_SCORE}`,
  );
  assert.ok(
    chase.score > MAX_SITE_MOVE_SCORE,
    `$100 one day overdue scores ${chase.score}, at or below the site ceiling of ${MAX_SITE_MOVE_SCORE} — ` +
      `speculative work can now outrank certain money`,
  );
  assert.ok(moves.indexOf(chase) < moves.indexOf(site), "the invoice must be listed above the site move");

  // The other half of the claim, and it is a claim about being VISIBLE rather than about being
  // beaten: the point of the ceiling is that the move sits in a band, not that it is buried. A
  // decided experiment must clear the housekeeping band (a silent case tops out at 20 + 8).
  assert.ok(site.score > 28, `a decided experiment scored ${site.score} and would sit under routine check-ins`);
});

test("a decided experiment cannot leak across tenants", async () => {
  // THE BUG: the leak family this codebase has already shipped twice. Insight rows are the newest
  // read in `proposeMoves` and therefore the newest place for a scoping filter to be written a
  // sixth, subtly different way. The verdict is derived from counters that belong to ONE project.
  const mine = `p-${randomUUID()}`;
  const theirs = `p-${randomUUID()}`;
  await seedArms(theirs, [
    { arm: "hero-a", exposures: 8_000, conversions: 400 },
    { arm: "hero-b", exposures: 8_000, conversions: 1_200 },
  ]);

  const mineMoves = (await proposeMoves(stores(), await authFor(mine))).moves;
  assert.equal(
    siteMoveIn(mineMoves),
    undefined,
    "another business's A/B verdict appeared on this founder's home screen",
  );
  // And it is not merely refused — it is invisible. Nothing in the proposal hints that a verdict
  // exists somewhere, which is the difference between a scoped read and a post-filter that counts.
  assert.equal(mineMoves.length, 0);

  // The owner still sees it, so the assertion above is about scoping and not about a broken read.
  assert.ok(siteMoveIn((await proposeMoves(stores(), await authFor(theirs))).moves));

  // Taking the OTHER tenant's move id is indistinguishable from taking one that was never real.
  const cross = await takeMove(stores(), await authFor(mine), "rewrite_losing_arm:hero-a");
  assert.equal(cross.ok, false);
});

test("evidence and waste saturate rather than grow without bound", async () => {
  // THE BUG: a term with no ceiling. `moneyPoints` is log-scaled and capped so one enormous invoice
  // cannot hold the top of the list forever; these two terms need the same property for the same
  // reason, and a curve is only testable as a property.
  assert.equal(evidencePoints(0), 0, "no lift is no evidence");
  assert.equal(evidencePoints(undefined), 0);
  assert.equal(evidencePoints(-0.5), 0, "a negative lift cannot happen and must not score");
  // Monotonic, and flat past the saturation point.
  assert.ok(evidencePoints(0.1) < evidencePoints(0.5));
  assert.ok(evidencePoints(0.5) < evidencePoints(1));
  assert.equal(evidencePoints(1), evidencePoints(50), "a 50x lift is not 50x more urgent than a doubling");
  // The floor matters: everything that reaches this term already cleared four statistical gates, so
  // the minimum possible lift must still be worth a non-trivial number of points.
  assert.ok(evidencePoints(0.1) > 8, "a just-decided experiment scores near zero and would be invisible");

  assert.equal(wastePoints(0), 0);
  assert.equal(wastePoints(undefined), 0);
  assert.ok(wastePoints(200) < wastePoints(2_000));
  assert.equal(wastePoints(10_000), wastePoints(10_000_000), "waste saturates");
});
