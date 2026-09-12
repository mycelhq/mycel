// Standing permission — the tests.
//
// autonomy.ts is the first thing in this kernel that starts client-facing work with nobody watching,
// so the tests below are organised around the ways that goes wrong rather than around the functions:
//
//   1. IT ACTS WHEN IT WAS NOT PERMITTED. No policy, a paused policy, a kind nobody granted, a
//      ceiling that was already spent, a window that had closed. Every one of those must PROPOSE.
//      Each test names the bug it prevents.
//   2. IT ACTS TWICE. Two replicas sweeping the same project, or a founder who already did it by
//      hand. The claims that protect this are not new — the tests prove the sweep actually goes
//      through them rather than around them.
//   3. IT ACTS ON THE WRONG BUSINESS. One project's permission spending another's reputation.
//   4. IT BECOMES A WAY PAST A GATE. The whole trust story is that autonomy decides whether to
//      START, never whether to skip a consequence gate — so the spawn an autonomous start produces
//      must be byte-identical to the one a founder's click produces.
import { connectMailbox } from "./helpers";
import { getDeliverableStore } from "../src/deliverables";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getDomainStore } from "../src/domain";
import { getBillingStore } from "../src/billing";
import { getRequestStore } from "../src/requests";
import { setChaseDeps } from "../src/dunning";
import { resetPolicyCounters } from "../src/policy";
import {
  moveAuthorityForProject,
  proposeMoves,
  recordOutcome,
  takeMove,
  MIN_EVIDENCE,
  type MoveStores,
  type OutcomeStat,
  type MoveKind,
} from "../src/moves";
import {
  EMPTY_POLICY,
  HARD_MAX_PER_DAY,
  HARD_MAX_PER_SWEEP,
  MIN_EVIDENCE_TO_SUGGEST,
  SWEEP_SECONDS,
  autonomyView,
  emptySweepBackoffSeconds,
  loadAutonomyPolicy,
  permits,
  recentStarts,
  sanitisePolicy,
  saveAutonomyPolicy,
  suggestWidening,
  sweepAutonomousMoves,
  type AutonomyPolicy,
} from "../src/autonomy";

const DAY = 86_400_000;
const NOW = new Date();
const ago = (days: number): string => new Date(NOW.getTime() - days * DAY).toISOString();
const agoDate = (days: number): string => ago(days).slice(0, 10);

const stores = (): MoveStores => ({
  domain: getDomainStore(),
  billing: getBillingStore(),
  requests: getRequestStore(),
  deliverables: getDeliverableStore(),
});

/**
 * The real chase wiring, through `setChaseDeps` — the registration point `mountInvoiceRoutes` uses.
 *
 * NOT a stub of `startChase`. A test that mocks the function under test proves the mock works, and
 * the single most important property here is that an autonomous start goes through the SAME carrier
 * a founder's click goes through, which is unobservable if the carrier is replaced.
 */
type Spawned = { project_id: string; wedge: string; task_type: string; input: Record<string, unknown> };
function recordingChaseDeps() {
  const spawned: Spawned[] = [];
  setChaseDeps({
    wedgeEnabled: () => true,
    spawnTask: async (a) => {
      spawned.push(a as Spawned);
      return `task-${spawned.length}-${randomUUID().slice(0, 8)}`;
    },
    attachInvoiceDocument: async () => ({
      artifact_id: "a", name: "i.pdf", content_type: "application/pdf", size_bytes: 1,
    }),
  });
  return { spawned, restore: () => setChaseDeps(null) };
}

async function makeClient(projectId: string, label: string) {
  return getDomainStore().createClient({
    project_id: projectId,
    display_name: `${label} Ltd`,
    handles: [`${label}-${randomUUID().slice(0, 8)}@example.com`],
    metadata: {},
  });
}

async function overdueInvoice(
  projectId: string,
  clientId: string,
  opts: { amount: number; daysOverdue: number; currency?: string; caseId?: string },
) {
  // A business with no mailbox no longer chases at all: `startChase` refuses with `cannot_send`
  // before it claims the invoice, because a chase that cannot be sent is a paid model call that
  // burns the ladder claim and still reports success. See promises.ts. Every scene in this file
  // is a business that could actually send the reminder, which is what it always meant.
  await connectMailbox(projectId);
  const inv = await getBillingStore().createInvoice({
    project_id: projectId,
    client_id: clientId,
    case_id: opts.caseId,
    currency: opts.currency ?? "USD",
    status: "sent",
    issue_date: agoDate(opts.daysOverdue + 30),
    due_date: agoDate(opts.daysOverdue),
    lines: [
      { id: randomUUID(), description: "Monthly bookkeeping", kind: "fixed", quantity_milli: 1000, unit_amount: opts.amount },
    ],
  });
  return (await getBillingStore().getInvoice(inv.id))!;
}

/** Grant permission the way the route does — through the sanitiser, never by poking a row. */
async function grant(projectId: string, policy: Partial<AutonomyPolicy>) {
  return saveAutonomyPolicy(
    getDomainStore(),
    projectId,
    { v: 1, ...policy } as AutonomyPolicy,
    "member-test",
    NOW,
  );
}

/** A move-shaped object for the pure decision tests. Only the fields `permits` reads matter. */
const moveLike = (
  kind: MoveKind,
  signals: Record<string, unknown> = {},
  takeable = true,
) => ({ kind, takeable, signals: signals as never });

const statOf = (kind: MoveKind, p: Partial<OutcomeStat>): Map<MoveKind, OutcomeStat> =>
  new Map([[kind, { kind, taken: 0, worked: 0, ignored: 0, rejected: 0, ...p }]]);

// ── 1. the default is ask ────────────────────────────────────────────────────────────────────────

test("no policy means nothing runs — and the business is not even read", async (t) => {
  // THE BUG: a sweep that defaults to "sensible behaviour" when it finds no policy. Silence must
  // mean PROPOSE. A business that has granted nothing has to behave exactly as it did before this
  // module existed, or every existing deployment starts acting on its own at the next deploy.
  const { spawned, restore } = recordingChaseDeps();
  t.after(restore);
  const project = `p-${randomUUID()}`;
  const client = await makeClient(project, "silent");
  await overdueInvoice(project, client.id, { amount: 900_00, daysOverdue: 20 });

  // The move IS proposed — this is not a test about an empty list.
  const proposal = await proposeMoves(stores(), await moveAuthorityForProject(getDomainStore(), project), {}, NOW);
  assert.equal(proposal.moves.length, 1);

  const summary = await sweepAutonomousMoves({ stores: stores(), project_id: project, now: NOW });
  assert.equal(summary.started, 0);
  assert.equal(spawned.length, 0);
  // `considered: 0` is the assertion that it short-circuited BEFORE reading the business, which is
  // what keeps a project that granted nothing at one indexed row read per tick.
  assert.equal(summary.considered, 0);
  assert.match(summary.stopped ?? "", /no autonomy policy/);
});

test("empty permitted-move ticks back off instead of firing every fifteen minutes", () => {
  assert.equal(emptySweepBackoffSeconds(0), SWEEP_SECONDS * 2);
  assert.ok(emptySweepBackoffSeconds(2) >= emptySweepBackoffSeconds(0));
  assert.ok(emptySweepBackoffSeconds(9) <= 3600);
});

test("a malformed or future-versioned policy proposes rather than acting", () => {
  // THE BUG: fail-open on data we do not understand. A row written by a newer kernel, or hand-edited,
  // must land on the same answer as no row at all — anything else means a bad migration grants
  // autonomy rather than removing it.
  const move = moveLike("chase_invoice");
  assert.equal(permits(undefined, move, NOW).allowed, false);
  assert.equal(permits({ v: 2 } as unknown as AutonomyPolicy, move, NOW).allowed, false);
  assert.equal(permits({ v: 1, allow: [] }, move, NOW).allowed, false);
  // A rule for a DIFFERENT kind is not a rule for this one. There is no prefix matching here on
  // purpose: `chase_invoice` and `check_in_case` are not a family.
  assert.equal(permits({ v: 1, allow: [{ kind: "check_in_case" }] }, move, NOW).allowed, false);
});

test("a permitted kind runs and an unpermitted one only proposes", async (t) => {
  // THE BUG: autonomy granted per-project rather than per-kind. A founder who says "yes, chase
  // invoices on your own" has not said "and nudge my clients for documents", and a policy that
  // cannot express the difference will be turned off entirely the first time it guesses wrong.
  const { spawned, restore } = recordingChaseDeps();
  t.after(restore);
  const project = `p-${randomUUID()}`;
  const client = await makeClient(project, "mixed");
  const inv = await overdueInvoice(project, client.id, { amount: 400_00, daysOverdue: 20 });
  // A request that is well past its patience, so a nudge is genuinely proposed alongside the chase.
  const req = await getRequestStore().createRequest({
    project_id: project, client_id: client.id, kind: "document", ask: "March bank statement",
  });

  await grant(project, { allow: [{ kind: "chase_invoice" }] });
  const summary = await sweepAutonomousMoves({
    stores: stores(),
    project_id: project,
    // Ten days on, so the request has aged past `REQUEST_NUDGE_DAYS` and both moves are on the list.
    now: new Date(NOW.getTime() + 10 * DAY),
  });

  assert.equal(summary.started, 1);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].task_type, "chase_invoice");
  assert.equal(summary.starts[0].move_id, `chase_invoice:${inv.id}`);
  // The nudge was seen and left alone. That is the product working, not a gap.
  assert.ok(summary.proposed >= 1);
  assert.ok(!spawned.some((s) => s.task_type === "nudge_client_request"));
  // The nudge really was on the list — otherwise this test proves nothing about selectivity.
  const auth = await moveAuthorityForProject(getDomainStore(), project);
  const list = await proposeMoves(stores(), auth, {}, new Date(NOW.getTime() + 10 * DAY));
  assert.ok(list.moves.some((m) => m.entity.id === req.id));

  // And the ungranted kind's refusal says WHY, naming the kind rather than describing a system.
  // Asserted against a takeable move of that kind, because a move with no carrier is refused one
  // step EARLIER (see the no-carrier test) and would hide whether the permission check works at all.
  const policy = await loadAutonomyPolicy(getDomainStore(), project);
  assert.match(
    permits(policy, moveLike("nudge_client_request"), NOW).because,
    /no standing permission for "nudge_client_request"/,
  );
});

// ── 2. ceilings and the kill switch ──────────────────────────────────────────────────────────────

test("ceilings hold across two concurrent sweeps", async (t) => {
  // THE BUG, and it is the one policy.ts already shipped once: counters in an in-process `Map`. Two
  // API replicas and two workers each counting to the same ceiling turned a `max_per_day: 40`
  // envelope into ~160 real actions a day — a security control failing OPEN, by four times, only in
  // production. This sweep runs on the worker tier, which has several replicas, so the ceiling has
  // to be claimed atomically or it is decoration.
  const { spawned, restore } = recordingChaseDeps();
  t.after(restore);
  resetPolicyCounters();
  const project = `p-${randomUUID()}`;
  const client = await makeClient(project, "race");
  // FOUR eligible invoices and a ceiling of one. Without an atomic claim both sweeps see budget.
  for (let i = 0; i < 4; i++) {
    await overdueInvoice(project, client.id, { amount: (i + 1) * 100_00, daysOverdue: 20 + i });
  }
  await grant(project, { allow: [{ kind: "chase_invoice" }], max_starts_per_day: 1 });

  const both = await Promise.all([
    sweepAutonomousMoves({ stores: stores(), project_id: project, now: NOW }),
    sweepAutonomousMoves({ stores: stores(), project_id: project, now: NOW }),
  ]);
  assert.equal(both[0].started + both[1].started, 1);
  assert.equal(spawned.length, 1);
});

test("the per-rule daily ceiling is separate from the project one, and neither can be raised", async (t) => {
  // THE BUG: a founder writing `max_per_day: 500` and getting it. The per-pass and per-day ceilings
  // exist so that a BUG is expensive-but-survivable rather than unbounded, which they are not if the
  // policy document can set them. A founder may lower them; there is deliberately no way up.
  const { spawned, restore } = recordingChaseDeps();
  t.after(restore);
  resetPolicyCounters();
  const project = `p-${randomUUID()}`;
  const client = await makeClient(project, "ceiling");
  for (let i = 0; i < 9; i++) {
    await overdueInvoice(project, client.id, { amount: (i + 1) * 100_00, daysOverdue: 20 + i });
  }
  const saved = await grant(project, {
    allow: [{ kind: "chase_invoice", max_per_day: 999 }],
    max_starts_per_sweep: 99,
    max_starts_per_day: 9_999,
  });
  assert.equal(saved.max_starts_per_sweep, HARD_MAX_PER_SWEEP);
  assert.equal(saved.max_starts_per_day, HARD_MAX_PER_DAY);
  assert.equal(saved.allow![0].max_per_day, HARD_MAX_PER_DAY);

  const summary = await sweepAutonomousMoves({ stores: stores(), project_id: project, now: NOW });
  // One pass can never exceed the hard per-sweep bound, whatever the document says.
  assert.equal(summary.started, HARD_MAX_PER_SWEEP);
  assert.equal(spawned.length, HARD_MAX_PER_SWEEP);
  assert.match(summary.stopped ?? "", /stopped at 5 starts/);
});

test("the kill switch stops every autonomous start immediately, without destroying the grant", async (t) => {
  // THE BUG: a founder watching something go wrong at 2am and having to delete rules one at a time
  // to make it stop — and then having to rebuild the policy from memory afterwards, which is the
  // reason they never turn it back on. Pausing is one field, checked before anything else, and it is
  // reversible.
  const { spawned, restore } = recordingChaseDeps();
  t.after(restore);
  resetPolicyCounters();
  const project = `p-${randomUUID()}`;
  const client = await makeClient(project, "stop");
  await overdueInvoice(project, client.id, { amount: 700_00, daysOverdue: 20 });
  await grant(project, { allow: [{ kind: "chase_invoice" }] });

  await grant(project, { paused: true, allow: [{ kind: "chase_invoice" }] });
  const paused = await sweepAutonomousMoves({ stores: stores(), project_id: project, now: NOW });
  assert.equal(paused.started, 0);
  assert.equal(spawned.length, 0);
  assert.match(paused.stopped ?? "", /paused/);
  // The grant survived the pause. Un-pausing restores exactly what was granted.
  const policy = (await loadAutonomyPolicy(getDomainStore(), project))!;
  assert.deepEqual(policy.allow?.map((r) => r.kind), ["chase_invoice"]);

  await grant(project, { paused: false, allow: [{ kind: "chase_invoice" }] });
  const running = await sweepAutonomousMoves({ stores: stores(), project_id: project, now: NOW });
  assert.equal(running.started, 1);
});

// ── 3. the shape of a permission ─────────────────────────────────────────────────────────────────

test("a value ceiling refuses a move it cannot evaluate rather than reading it as zero", () => {
  // THE BUG, and policy.ts has the same guard for the same reason: "no amount found in the payload"
  // read as "zero, therefore under the cap". A founder who caps autonomy at $2,000 has said
  // something about risk, and the moves with NO money on them are not automatically the safe ones —
  // a nudge is a client contact. A ceiling that cannot be evaluated is not a ceiling.
  const policy: AutonomyPolicy = { v: 1, allow: [{ kind: "chase_invoice", max_amount: 2_000 }] };
  const under = moveLike("chase_invoice", { money_at_stake: 150_000, currency: "USD", minor_unit_exponent: 2 });
  const over = moveLike("chase_invoice", { money_at_stake: 250_000, currency: "USD", minor_unit_exponent: 2 });
  const none = moveLike("chase_invoice", {});
  assert.equal(permits(policy, under, NOW).allowed, true);
  assert.equal(permits(policy, over, NOW).allowed, false);
  assert.match(permits(policy, over, NOW).because, /over the 2000 you allowed/);
  assert.equal(permits(policy, none, NOW).allowed, false);
  assert.match(permits(policy, none, NOW).because, /no money on it/);
});

test("the window is the founder's clock, and outside it the move only proposes", () => {
  // THE BUG this whole field exists for: a thousand emails on a Sunday. A time window is the cheapest
  // honest guard against a sweep that runs every fifteen minutes forever, and it has to be in the
  // FOUNDER's clock — a window that silently meant Greenwich would fire at 4am for half the market.
  const move = moveLike("chase_invoice");
  const wed10utc = new Date("2026-08-05T10:00:00Z"); // a Wednesday
  const sun10utc = new Date("2026-08-09T10:00:00Z"); // a Sunday
  const weekdays: AutonomyPolicy = {
    v: 1,
    allow: [{ kind: "chase_invoice", days: [1, 2, 3, 4, 5], hours: { from: 9, to: 18 } }],
  };
  assert.equal(permits(weekdays, move, wed10utc).allowed, true);
  assert.equal(permits(weekdays, move, sun10utc).allowed, false);
  assert.match(permits(weekdays, move, sun10utc).because, /only allowed this on Monday/);
  // 08:00 UTC is outside a 9–18 window at UTC, and inside it at UTC+2. Same instant, two answers,
  // and the founder's offset is what decides.
  const eight = new Date("2026-08-05T08:00:00Z");
  assert.equal(permits(weekdays, move, eight).allowed, false);
  assert.equal(permits({ ...weekdays, utc_offset_minutes: 120 }, move, eight).allowed, true);
});

test("a move with no carrier is never started on its own", () => {
  // THE BUG: autonomy waving through a move a FOUNDER cannot even take. Four of the five kinds
  // propose a `carrier.task_type` no wedge declares; spawning one produces a run with no output
  // schema, no policy and no knowledge — an agent handed a verb nobody taught it, at 3am.
  const policy: AutonomyPolicy = { v: 1, allow: [{ kind: "advance_case" }] };
  assert.equal(permits(policy, moveLike("advance_case", {}, false), NOW).allowed, false);
  assert.match(permits(policy, moveLike("advance_case", {}, false), NOW).because, /can carry that move yet/);
});

test("sanitisePolicy drops what it cannot understand instead of storing it", () => {
  // THE BUG: a rule naming a kind this build does not have, kept "in case a newer kernel wants it",
  // sitting in the founder's list looking like a granted permission that never fires. The honest
  // answer to "I granted that and nothing happened" must not be "we kept your typo".
  const clean = sanitisePolicy(
    {
      v: 1,
      allow: [
        { kind: "not_a_kind" as never },
        { kind: "chase_invoice", max_amount: -5, hours: { from: 18, to: 9 }, days: [9, 1] },
        // A second rule for a kind already granted. One rule per kind — two is a precedence question
        // a founder should never have to hold in their head.
        { kind: "chase_invoice", max_amount: 10 },
      ],
    },
    NOW,
    "member-1",
  );
  assert.equal(clean.allow!.length, 1);
  assert.equal(clean.allow![0].kind, "chase_invoice");
  // A negative ceiling is not a ceiling of zero — it is nonsense, and is dropped.
  assert.equal(clean.allow![0].max_amount, undefined);
  // An inverted window would refuse everything for ever while LOOKING like a grant.
  assert.equal(clean.allow![0].hours, undefined);
  // Day `9` is DROPPED, not clamped to Saturday. Clamping a typo into range grants a day the founder
  // never named — the one direction a sanitiser must never round.
  assert.deepEqual(clean.allow![0].days, [1]);
  // And "at most zero a day" is a revoke, not a clamp up to one.
  assert.deepEqual(sanitisePolicy({ v: 1, allow: [{ kind: "chase_invoice", max_per_day: 0 }] }, NOW, "m").allow, []);
  assert.equal(clean.updated_by, "member-1");
});

// ── 4. it is not a way past a gate ───────────────────────────────────────────────────────────────

test("an autonomous start is the SAME run a founder's click produces — approval gate included", async (t) => {
  // THE BUG, and it is the one that would end the product: autonomy quietly becoming a second path
  // to the same work that skips the consequence gate. Autonomy decides whether to START. The run's
  // first outward action still goes through `awaitApproval` unless the WEDGE's own policy.ts
  // envelope separately permits it — two different questions.
  //
  // Asserted structurally rather than by reading a comment: the spawn a sweep produces and the spawn
  // a founder's `takeMove` produces are compared field for field. If autonomy ever grew its own
  // spawn, its own constraints or its own `approval_required`, this diverges.
  const { spawned, restore } = recordingChaseDeps();
  t.after(restore);
  resetPolicyCounters();
  const byHandProject = `p-${randomUUID()}`;
  const byPolicyProject = `p-${randomUUID()}`;

  for (const project of [byHandProject, byPolicyProject]) {
    const client = await makeClient(project, "gate");
    await overdueInvoice(project, client.id, { amount: 500_00, daysOverdue: 20 });
  }

  const handAuth = await moveAuthorityForProject(getDomainStore(), byHandProject);
  const handList = await proposeMoves(stores(), handAuth, {}, NOW);
  const taken = await takeMove(stores(), handAuth, handList.moves[0].id, NOW);
  assert.equal(taken.ok, true);

  await grant(byPolicyProject, { allow: [{ kind: "chase_invoice" }] });
  const swept = await sweepAutonomousMoves({ stores: stores(), project_id: byPolicyProject, now: NOW });
  assert.equal(swept.started, 1);

  assert.equal(spawned.length, 2);
  const [hand, policy] = spawned;
  assert.equal(hand.task_type, policy.task_type);
  assert.equal(hand.wedge, policy.wedge);
  // The input the wedge's own builder produced, minus the ids that differ by construction.
  const shape = (s: Spawned) => Object.keys(s.input).sort();
  assert.deepEqual(shape(hand), shape(policy));
  // NOTHING in the autonomous spawn asks to skip an approval. If a key like this ever appears, it
  // was added by this module and it does not belong to it.
  assert.equal((policy as Record<string, unknown>).approval_required, undefined);
  assert.equal(policy.input.approval_required, undefined);
});

test("a move already taken by hand is not taken again by the sweep", async (t) => {
  // THE BUG: the founder chases INV-104 at 09:00 and the sweep chases it again at 09:15, so the
  // client gets two dunning emails an instant apart — precisely what the dunning ladder exists to
  // prevent. The sweep does not need a dedupe table for this: `chaseMove` asks the LADDER, which
  // stopped proposing the invoice the moment `last_chased_at` was stamped, so the sweep cannot even
  // see it. This test proves the sweep actually goes through that path.
  const { spawned, restore } = recordingChaseDeps();
  t.after(restore);
  resetPolicyCounters();
  const project = `p-${randomUUID()}`;
  const client = await makeClient(project, "byhand");
  await overdueInvoice(project, client.id, { amount: 800_00, daysOverdue: 12 });
  await grant(project, { allow: [{ kind: "chase_invoice" }] });

  const auth = await moveAuthorityForProject(getDomainStore(), project);
  const list = await proposeMoves(stores(), auth, {}, NOW);
  assert.equal((await takeMove(stores(), auth, list.moves[0].id, NOW)).ok, true);
  assert.equal(spawned.length, 1);

  const summary = await sweepAutonomousMoves({ stores: stores(), project_id: project, now: NOW });
  assert.equal(summary.started, 0);
  assert.equal(spawned.length, 1);
  // Not "refused" — it was never proposed, because the ladder is holding it.
  assert.equal(summary.considered, 0);
});

// ── 5. tenancy ───────────────────────────────────────────────────────────────────────────────────

test("one business's standing permission never acts on another's", async (t) => {
  // THE BUG: the two cross-tenant leaks this codebase has already shipped, arriving through a new
  // door and with the worst possible consequence — one founder's permission spending another
  // founder's reputation on their own clients, unattended.
  const { spawned, restore } = recordingChaseDeps();
  t.after(restore);
  resetPolicyCounters();
  const mine = `p-${randomUUID()}`;
  const theirs = `p-${randomUUID()}`;
  for (const project of [mine, theirs]) {
    const client = await makeClient(project, project.slice(0, 6));
    await overdueInvoice(project, client.id, { amount: 900_00, daysOverdue: 25 });
  }
  // Only ONE of them granted anything.
  await grant(mine, { allow: [{ kind: "chase_invoice" }] });

  const theirSummary = await sweepAutonomousMoves({ stores: stores(), project_id: theirs, now: NOW });
  assert.equal(theirSummary.started, 0);
  assert.equal(spawned.length, 0);

  const mySummary = await sweepAutonomousMoves({ stores: stores(), project_id: mine, now: NOW });
  assert.equal(mySummary.started, 1);
  assert.equal(spawned[0].project_id, mine);
  // The ledger is scoped too: the other business's page shows nothing ran on its own, because
  // nothing did.
  assert.equal((await recentStarts(getDomainStore(), theirs)).length, 0);
  assert.equal((await recentStarts(getDomainStore(), mine)).length, 1);
  // And the policy read itself is tenant-scoped — reading it under the wrong project must not find
  // the grant.
  assert.equal(await loadAutonomyPolicy(getDomainStore(), theirs), undefined);
});

test("an unscoped sweep throws rather than defaulting to a project", async () => {
  // THE BUG: `project_id ?? ""` at a call site. `sweepWaits` throws for the same reason and the
  // stakes are higher here, because this one starts client-facing work.
  await assert.rejects(() => sweepAutonomousMoves({ stores: stores(), project_id: "", now: NOW }));
  await assert.rejects(() => saveAutonomyPolicy(getDomainStore(), "", EMPTY_POLICY, "x", NOW));
});

// ── 6. explainability ────────────────────────────────────────────────────────────────────────────

test("every autonomous start is explained by the rule that permitted it", async (t) => {
  // THE BUG: vision Law 6. "Why did it do that" answered with a description of the system rather
  // than with the sentence the founder themselves wrote. A start nobody can trace back to a
  // permission is indistinguishable, to the founder reading it a week later, from a bug.
  const { restore } = recordingChaseDeps();
  t.after(restore);
  resetPolicyCounters();
  const project = `p-${randomUUID()}`;
  const domain = getDomainStore();
  const client = await makeClient(project, "why");
  const kase = await domain.createCase({
    project_id: project, client_id: client.id, wedge: "invoice-chaser", title: "Q1 retainer", stage: "open",
  });
  await overdueInvoice(project, client.id, { amount: 300_00, daysOverdue: 20, caseId: kase.id });
  await grant(project, { allow: [{ kind: "chase_invoice", max_amount: 5_000, max_per_day: 3 }] });

  const summary = await sweepAutonomousMoves({ stores: stores(), project_id: project, now: NOW });
  assert.equal(summary.started, 1);
  // The sentence names the rule in the founder's own terms, not "policy allowed it".
  assert.match(summary.starts[0].because, /you allow "chase_invoice" to run on its own/);
  assert.match(summary.starts[0].because, /up to 5000/);
  assert.match(summary.starts[0].because, /at most 3 a day/);

  // On the ENGAGEMENT's own timeline, in sequence with everything else that happened to it.
  const fresh = (await domain.getCase(kase.id))!;
  const note = fresh.history?.find((h) => h.note?.includes("started on its own"));
  assert.ok(note, "the case timeline records the autonomous start");
  assert.match(note!.note!, /you allow "chase_invoice"/);
  // And it says what did NOT happen, because "it chased them" would be a lie: the run drafts.
  assert.match(note!.note!, /Nothing is sent until it is approved/);

  // The ledger is the founder-facing answer to "what ran without me?".
  const recent = await recentStarts(domain, project);
  assert.equal(recent.length, 1);
  assert.equal(recent[0].task_id, summary.starts[0].task_id);
});

// ── 7. earned autonomy — suggested, never taken ──────────────────────────────────────────────────

test("evidence widens nothing on its own — it only asks", async () => {
  // THE BUG this refuses to have: a policy that raises its own ceilings because the numbers looked
  // good, and the founder finds out afterwards. vision.md's "autonomy increases only where evidence
  // and policy earned it" is TWO conditions. Evidence produces a suggestion; a human produces the
  // grant. `suggestWidening` is a pure function that returns sentences and writes nothing.
  const project = `p-${randomUUID()}`;
  const learned = statOf("chase_invoice", { taken: MIN_EVIDENCE_TO_SUGGEST, worked: MIN_EVIDENCE_TO_SUGGEST });
  const suggestions = suggestWidening(learned, undefined);
  assert.equal(suggestions.length, 1);
  assert.match(suggestions[0].because, /Want it to start these on its own/);
  // Nothing was written. The project still has no policy at all.
  assert.equal(await loadAutonomyPolicy(getDomainStore(), project), undefined);

  // Below the evidence bar: silence, not a hedged suggestion.
  assert.deepEqual(suggestWidening(statOf("chase_invoice", { taken: 3, worked: 3 }), undefined), []);
  // A single rejection stops the ask entirely. The founder has said no once; asking is not free.
  assert.deepEqual(
    suggestWidening(statOf("chase_invoice", { taken: 20, worked: 19, rejected: 1 }), undefined),
    [],
  );
  // Already granted: nothing to suggest.
  assert.deepEqual(
    suggestWidening(learned, { v: 1, allow: [{ kind: "chase_invoice" }] }),
    [],
  );
});

test("a kind the founder keeps rejecting stands itself down without being revoked", async () => {
  // THE BUG in the other direction: the automatic half. Narrowing is safe to do without asking,
  // because being wrong toward asking costs a click — and a granted kind that the founder has
  // rejected a third of the time is one they are about to turn off entirely. Widening is never
  // automatic; narrowing always is. The asymmetry is the whole argument.
  const policy: AutonomyPolicy = { v: 1, allow: [{ kind: "chase_invoice" }] };
  const move = moveLike("chase_invoice");
  const fine = statOf("chase_invoice", { taken: MIN_EVIDENCE + 1, worked: 5, rejected: 1 });
  const bad = statOf("chase_invoice", { taken: 9, worked: 5, rejected: 4 });
  assert.equal(permits(policy, move, NOW, fine).allowed, true);
  assert.equal(permits(policy, move, NOW, bad).allowed, false);
  assert.match(permits(policy, move, NOW, bad).because, /you rejected 4 of the last 9/);
  // Below the evidence floor it does NOT stand down: two data points is superstition wearing a
  // percentage sign, and standing down on it would make autonomy feel random.
  const thin = statOf("chase_invoice", { taken: 2, worked: 0, rejected: 2 });
  assert.equal(permits(policy, move, NOW, thin).allowed, true);
});

test("the founder sees the policy, what ran, and what is being suggested, in one read", async (t) => {
  // THE BUG: vision Law 5 — a new page for a subsystem. Standing permission is not a room; it is the
  // answer to "and what did you do without me?", which only means something next to the list of what
  // it did not do. So it rides along with the move proposal, in one call, and the surface cannot
  // show a policy that disagrees with the list underneath it.
  const { restore } = recordingChaseDeps();
  t.after(restore);
  resetPolicyCounters();
  const project = `p-${randomUUID()}`;
  const domain = getDomainStore();
  const client = await makeClient(project, "view");
  const inv = await overdueInvoice(project, client.id, { amount: 200_00, daysOverdue: 20 });
  await grant(project, { allow: [{ kind: "chase_invoice" }] });
  await sweepAutonomousMoves({ stores: stores(), project_id: project, now: NOW });

  const auth = await moveAuthorityForProject(domain, project);
  const view = await autonomyView(domain, auth);
  assert.equal(view.policy.allow?.[0].kind, "chase_invoice");
  assert.equal(view.recent.length, 1);
  assert.equal(view.recent[0].move_id, `chase_invoice:${inv.id}`);
  assert.equal(view.hard_max_per_sweep, HARD_MAX_PER_SWEEP);
  // Every kind travels, so the surface can offer a grant for one that has never run — the UI holds
  // no list of its own, for the reason `Move.takeable` travels on the move.
  assert.ok(view.kinds.includes("gtm_next_touch"));

  // A project with no policy still gets a well-formed view rather than an absent key, so the surface
  // renders "nothing runs on its own" instead of crashing on the founder's main page.
  const empty = await autonomyView(domain, await moveAuthorityForProject(domain, `p-${randomUUID()}`));
  assert.deepEqual(empty.policy.allow, []);
  assert.equal(empty.recent.length, 0);
});

test("an outcome ledger with real evidence is what feeds the suggestion", async () => {
  // THE BUG: a fake learning loop, which the brief is explicit is worse than none. The evidence has
  // to be the ledger `outcomeStats` actually reads — not a counter this module keeps — or the
  // suggestion is a number about itself. Written here through `recordOutcome`, the only writer.
  const project = `p-${randomUUID()}`;
  const domain = getDomainStore();
  const auth = await moveAuthorityForProject(domain, project);
  for (let i = 0; i < MIN_EVIDENCE_TO_SUGGEST; i++) {
    await recordOutcome(domain, auth, {
      move_id: `chase_invoice:inv-${i}`,
      kind: "chase_invoice",
      entity_id: `inv-${i}`,
      // `paid` is a fact the harness observed (an invoice settling inside the attribution window),
      // not a model's opinion of how a run went.
      result: "paid",
      by: "system",
    });
  }
  const view = await autonomyView(domain, auth);
  assert.equal(view.suggestions.length, 1);
  assert.equal(view.suggestions[0].kind, "chase_invoice");
  assert.equal(view.suggestions[0].taken, MIN_EVIDENCE_TO_SUGGEST);
});
