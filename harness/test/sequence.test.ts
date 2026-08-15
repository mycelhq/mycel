// The outreach sequencer.
//
// Four things here would each be a serious incident in production and none of them is loud when it
// breaks: a condition that binds the wrong way sends to someone who already replied; a pacing
// refusal that sends anyway walks an account into a restriction; an envelope that leaks across
// campaigns is an agent authorising its own sends; and a schedule that ignores its project sends
// one customer's list from another customer's account. So each one is a test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryStore } from "../src/store";
import { getDomainStore } from "../src/domain";
import type { Case, Connection, Task } from "../src/contract";
import { randomUUID } from "node:crypto";
import { ConditionError, evaluateCondition, parseCondition } from "../src/gtm/conditions";
import {
  campaignEnvelope,
  enrollProspect,
  proposeCampaign,
  validateSteps,
  CampaignError,
  DEFAULT_SEQUENCE,
  WARM_SEQUENCE,
  type Campaign,
  type SequenceStep,
} from "../src/gtm/campaign";
import { advanceSequences, ensureSequenceSchedule, factsFor, setTouchDeps, startNextTouch, _setDispatcher } from "../src/gtm/sequence";
import { noteInboundReplies } from "../src/gtm/replies";

const domain = () => getDomainStore();

// ── conditions ───────────────────────────────────────────────────────────────────────────────────

test("conditions: OR is looser than AND, which is looser than NOT", () => {
  // `a OR b AND c` must be `a OR (b AND c)`. A left-to-right evaluator gets this wrong, and the
  // wrong answer here is a message to someone who asked not to be messaged.
  assert.equal(evaluateCondition("a OR b AND c", { a: true, b: false, c: false }), true);
  assert.equal(evaluateCondition("a OR b AND c", { a: false, b: true, c: false }), false);
  assert.equal(evaluateCondition("a OR b AND c", { a: false, b: true, c: true }), true);

  // NOT binds tightest: `!a AND b` is `(!a) AND b`, never `!(a AND b)`.
  assert.equal(evaluateCondition("!a AND b", { a: true, b: true }), false);
  assert.equal(evaluateCondition("!a AND b", { a: false, b: true }), true);
  assert.equal(evaluateCondition("NOT a AND b", { a: false, b: true }), true);
});

test("conditions: parentheses override precedence, and negation composes", () => {
  assert.equal(evaluateCondition("(a OR b) AND c", { a: true, b: false, c: false }), false);
  assert.equal(evaluateCondition("(a OR b) AND c", { a: true, b: false, c: true }), true);
  assert.equal(evaluateCondition("!(a OR b)", { a: false, b: false }), true);
  assert.equal(evaluateCondition("!(a OR b)", { a: false, b: true }), false);
  assert.equal(evaluateCondition("!!a", { a: true }), true);
  assert.equal(evaluateCondition("a && !(b || c)", { a: true, b: false, c: false }), true);
});

test("conditions: the real one — connected AND !replied", () => {
  assert.equal(evaluateCondition("connected AND !replied", { connected: true, replied: false }), true);
  assert.equal(evaluateCondition("connected AND !replied", { connected: true, replied: true }), false);
  assert.equal(evaluateCondition("connected AND !replied", { connected: false, replied: false }), false);
});

test("conditions: an unknown fact is false, and malformed input throws rather than passing", () => {
  // Fail closed. A condition that reads a fact nobody computed must decline to send, not send.
  assert.equal(evaluateCondition("connected", {}), false);
  assert.equal(evaluateCondition("!connected", {}), true);
  // No condition at all is not a failed condition.
  assert.equal(evaluateCondition(undefined, {}), true);
  assert.equal(evaluateCondition("   ", {}), true);

  assert.throws(() => parseCondition("a AND"), ConditionError);
  assert.throws(() => parseCondition("(a AND b"), ConditionError);
  assert.throws(() => parseCondition("a b"), ConditionError);
  assert.throws(() => parseCondition("a AND $"), ConditionError);
});

// ── step validation ──────────────────────────────────────────────────────────────────────────────

test("a campaign cannot be composed out of actions no batch consent covers", () => {
  validateSteps(DEFAULT_SEQUENCE); // the shipped one is legal
  // Public and permanent under the founder's name. capabilities.ts is right that a generic comment
  // is worse than silence, and no one-click campaign approval covers writing them at scale.
  assert.throws(
    () => validateSteps([{ from: "queued", action: "comment_on_post", advance_to: "warmed" }]),
    CampaignError,
  );
  assert.throws(() => validateSteps([{ from: "queued", action: "invent_a_capability", advance_to: "warmed" }]), CampaignError);
  // Declared on LinkedIn, not wired for campaign ticks — proposing it would park every prospect.
  assert.throws(
    () => validateSteps([{ from: "queued", action: "follow_person", advance_to: "warmed" }]),
    CampaignError,
  );
  // A step that does not advance the case is an infinite sequence, which on LinkedIn is an account.
  assert.throws(() => validateSteps([{ from: "dm1", action: "send_message", advance_to: "queued" }]), CampaignError);
  // A typo'd fact would silently evaluate false and stall the campaign, so it is caught here.
  assert.throws(
    () => validateSteps([{ from: "connected", action: "send_message", advance_to: "dm1", only_if: "conneted" }]),
    CampaignError,
  );
});

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────────

/** Hours to add to now so the derived local time is a Tuesday at 10:00 — inside the sending window. */
function workingHoursOffset(now = new Date()): number {
  const target = new Date(now);
  target.setUTCHours(10, 0, 0, 0);
  while (target.getUTCDay() !== 2) target.setUTCDate(target.getUTCDate() + 1);
  return (target.getTime() - now.getTime()) / 3_600_000;
}

async function account(project: string, over: Record<string, unknown> = {}): Promise<Connection> {
  return domain().createConnection({
    project_id: project,
    kind: "linkedin",
    name: "LI",
    owner: { kind: "founder", id: "founder" },
    config: {
      tier: "premium",
      account_age_days: 365,
      utc_offset: workingHoursOffset(),
      pacing: { engagement: { sent: 200, accepted: 80, replied: 30, flagged: 0 } },
      ...over,
    },
  });
}

async function anchorTask(store: InMemoryStore, project: string): Promise<Task> {
  const iso = new Date().toISOString();
  const t: Task = {
    id: randomUUID(), project_id: project, wedge: "gtm-operator", task_type: "propose_campaign",
    actor: { kind: "user", id: "m" }, input: {}, constraints: { max_runtime_s: 60, max_cost_usd: 0, approval_required: true },
    tools: [], status: "awaiting_approval", cost_usd: 0, created_at: iso, updated_at: iso,
  };
  await store.createTask(t);
  return t;
}

/** A campaign whose first step is a DM, so a test does not have to walk the warm-up first. */
const DM_FIRST: SequenceStep[] = [{ from: "connected", action: "send_message", advance_to: "dm1", only_if: "connected AND !replied" }];

async function campaignWith(
  store: InMemoryStore,
  project: string,
  conn: Connection,
  opts: { approve?: boolean; steps?: SequenceStep[]; name?: string } = {},
): Promise<{ campaign: Campaign; approval_id: string }> {
  const task = await anchorTask(store, project);
  const r = await proposeCampaign(store, domain(), {
    task_id: task.id,
    project_id: project,
    connection_id: conn.id,
    name: opts.name ?? "Q3 founders",
    steps: opts.steps ?? DM_FIRST,
    prospects: [{ profile_id: "dana", name: "Dana", thread: "urn:li:thread:1", copy: { send_message: "hi Dana" } }],
  });
  if (opts.approve !== false) await store.setApproval(r.approval_id, "approved");
  return r;
}

async function enrolled(campaign: Campaign, over: Partial<Case["data"]> = {}, stage = "connected"): Promise<Case> {
  const kase = await enrollProspect(domain(), campaign, {
    profile_id: "dana", name: "Dana", thread: "urn:li:thread:1", copy: { send_message: "hi Dana" },
  });
  return (await domain().updateCase(kase.id, { stage, data: { ...kase.data, connected: true, ...over } }))!;
}

/** Records every dispatch so a test can assert that nothing went out. */
function spyDispatcher() {
  const calls: Array<{ action: string; payload: Record<string, unknown> }> = [];
  _setDispatcher(async (_conn, action, payload) => {
    calls.push({ action, payload });
    return { ok: true, detail: "sent" };
  });
  return calls;
}

// ── the envelope ─────────────────────────────────────────────────────────────────────────────────

test("an approved campaign auto-approves its OWN sends and nobody else's", async () => {
  const store = new InMemoryStore();
  const conn = await account("p-env");
  const a = await campaignWith(store, "p-env", conn, { name: "campaign A" });
  const b = await campaignWith(store, "p-env", conn, { name: "campaign B" });
  const caseA = await enrolled(a.campaign);

  // Its own case: allowed, with a reason that names the campaign and the human decision.
  const own = await campaignEnvelope(store, domain(), { campaign: a.campaign, kase: caseA, connection: conn, action: "send_message" });
  assert.equal(own.auto, true);
  assert.match(own.reason, /campaign "campaign A"/);

  // THE ATTACK: campaign B is approved too, and would happily send campaign A's prospect if the
  // envelope keyed on the action name (`send_message`) rather than on the campaign the case
  // belongs to. This is the check that stops an agent authorising itself by choosing a string.
  const crossed = await campaignEnvelope(store, domain(), { campaign: b.campaign, kase: caseA, connection: conn, action: "send_message" });
  assert.equal(crossed.auto, false);
  assert.match(crossed.reason, /does not belong to campaign/);
});

test("the envelope is bound to one account, one project, and one set of steps", async () => {
  const store = new InMemoryStore();
  const conn = await account("p-bind");
  const other = await account("p-bind");
  const elsewhere = await account("p-other");
  const { campaign } = await campaignWith(store, "p-bind", conn);
  const kase = await enrolled(campaign);

  // A second LinkedIn account in the same project is not the account this was approved for.
  const wrongAccount = await campaignEnvelope(store, domain(), { campaign, kase, connection: other, action: "send_message" });
  assert.equal(wrongAccount.auto, false);
  assert.match(wrongAccount.reason, /different account/);

  // Another tenant's connection, even with a matching campaign object, is refused before anything.
  const wrongTenant = await campaignEnvelope(store, domain(), { campaign, kase, connection: elsewhere, action: "send_message" });
  assert.equal(wrongTenant.auto, false);

  // An action the approved steps do not contain — the "I renamed my capability" bypass.
  const notAStep = await campaignEnvelope(store, domain(), { campaign, kase, connection: conn, action: "send_invite" });
  assert.equal(notAStep.auto, false);
  assert.match(notAStep.reason, /not a step in the approved campaign/);

  // And an action nothing may ever auto-approve, even if a step somehow named it.
  const forbidden = await campaignEnvelope(store, domain(), {
    campaign: { ...campaign, steps: [{ from: "queued", action: "create_post", advance_to: "warmed" }] },
    kase, connection: conn, action: "create_post",
  });
  assert.equal(forbidden.auto, false);
});

test("consent is re-read at send time: pending means nothing goes out, rejected stops everything", async () => {
  const store = new InMemoryStore();
  const conn = await account("p-consent");
  const { campaign, approval_id } = await campaignWith(store, "p-consent", conn, { approve: false });
  const kase = await enrolled(campaign);

  const pending = await campaignEnvelope(store, domain(), { campaign, kase, connection: conn, action: "send_message" });
  assert.equal(pending.auto, false);
  assert.match(pending.reason, /waiting for you to approve/);

  await store.setApproval(approval_id, "rejected");
  const rejected = await campaignEnvelope(store, domain(), { campaign, kase, connection: conn, action: "send_message" });
  assert.equal(rejected.auto, false);

  // An expired envelope is not a standing grant. Consent has a horizon.
  await store.setApproval(approval_id, "approved");
  const expired = await campaignEnvelope(store, domain(), {
    campaign: { ...campaign, expires_at: new Date(Date.now() - 1000).toISOString() },
    kase, connection: conn, action: "send_message",
  });
  assert.equal(expired.auto, false);
  assert.match(expired.reason, /expired/);
});

// ── the tick ─────────────────────────────────────────────────────────────────────────────────────

test("a due case is sent, advanced, spaced — and the auto-approval lands in the queue with its reason", async () => {
  const store = new InMemoryStore();
  const conn = await account("p-send");
  const { campaign } = await campaignWith(store, "p-send", conn);
  const kase = await enrolled(campaign);
  const calls = spyDispatcher();
  try {
    const now = new Date();
    const summary = await advanceSequences(store, domain(), { project_id: "p-send", now });
    assert.equal(summary.sent, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].action, "send_message");
    assert.equal(calls[0].payload.body, "hi Dana", "the copy is the approved copy — nothing is drafted at send time");

    const after = (await domain().getCase(kase.id))!;
    assert.equal(after.stage, "dm1");
    // Spaced, not burst: the next touch is minutes-to-hours away with jitter, never "now".
    assert.ok(Date.parse(after.due_at!) > now.getTime() + 45_000);

    // Autonomy stays auditable: a row in the same queue a human-gated action lands in, saying
    // which envelope allowed it.
    const auto = await store.listApprovals("auto_approved");
    assert.equal(auto.length, 1);
    assert.equal(auto[0].action, "linkedin:send_message");
    assert.match(auto[0].policy_reason!, /approved by a human/);
  } finally {
    _setDispatcher(null);
  }
});

test("a founder can take the touch that is already due, and cannot click it into a burst", async () => {
  /**
   * THE BUG, IN TWO HALVES.
   *
   * The first: `gtm_next_touch` was proposed on the founder's list with a carrier task type of
   * `"gtm_next_touch"` — a string that appears in no manifest, no dispatcher and no scheduler. It had
   * been invented out of the move's own kind, so `takeability` correctly concluded nothing could
   * carry it and greyed the button out with a sentence saying no service declared an outreach step,
   * while this file dispatched `outreach_touch` for the same case every five minutes.
   *
   * The second, which is the reason taking one is safe: this must be the CLOCK moving forward to
   * now, for a touch the sequencer already considers due — never a way to send a whole sequence in
   * an afternoon by clicking. Both the `due_at` gate and the claim are asserted, because the first
   * is what stops a burst and the second is what stops a double click.
   */
  const store = new InMemoryStore();
  const conn = await account("p-take");
  const { campaign } = await campaignWith(store, "p-take", conn);
  const kase = await enrolled(campaign);
  const calls = spyDispatcher();
  setTouchDeps({ store });
  try {
    const now = new Date();
    const taken = await startNextTouch(domain(), kase, { now });
    assert.equal(taken.ok, true, taken.ok ? "" : taken.message);
    assert.equal(calls.length, 1, "taking a due touch must dispatch exactly one message");
    assert.equal(calls[0].payload.body, "hi Dana", "the copy is the APPROVED copy — nothing is drafted at take time");

    // The task id comes back, so the founder's toast can link to the run. It used to be dropped on
    // the floor by `advanceCase`, and the take path would have had to guess it by scanning.
    const task = taken.ok ? await store.getTask(taken.task_id) : undefined;
    assert.equal(task?.task_type, "outreach_touch");
    assert.equal(task?.case_id, kase.id);

    // The auto-approval row still lands, with the envelope's reason. Taking a touch does not skip
    // the audit — it is the same dispatch, and the human gate happened when the campaign was approved.
    const auto = await store.listApprovals("auto_approved");
    assert.equal(auto.length, 1);
    assert.match(auto[0].policy_reason!, /approved by a human/);

    // NOW THE BURST. The case advanced and `due_at` is jittered minutes-to-hours out, so a second
    // click is refused by the same gate the tick obeys — not by a special case for buttons.
    const advanced = (await domain().getCase(kase.id))!;
    const again = await startNextTouch(domain(), advanced, { now });
    assert.equal(again.ok, false);
    assert.equal(again.ok === false && again.reason, "paced");
    assert.equal(calls.length, 1, "a second click sent a second message");
  } finally {
    setTouchDeps(null);
    _setDispatcher(null);
  }
});

test("two clicks landing together dispatch once, and an unwired kernel dispatches never", async () => {
  /**
   * THE BUG: `due_at` is a gate, not a claim. Two takes that both read the case before either wrote
   * would both see a touch that is due — and unlike a chase, this one SENDS, so the loser is a
   * stranger receiving the same DM twice. `claimCaseMarker` is one statement with the cooldown in its
   * WHERE clause; the loser gets nothing back and says so.
   *
   * And the fail-closed half: a kernel that never mounted the outbound routes has no store here, and
   * must refuse rather than reach for one. The fallback a hurried version reaches for is a second
   * path to a member's LinkedIn session.
   */
  const store = new InMemoryStore();
  const conn = await account("p-race");
  const { campaign } = await campaignWith(store, "p-race", conn);
  const kase = await enrolled(campaign);
  const calls = spyDispatcher();

  // Unwired first, while `setTouchDeps` has not been called for this store.
  setTouchDeps(null);
  const unwired = await startNextTouch(domain(), kase, {});
  assert.equal(unwired.ok, false);
  assert.equal(unwired.ok === false && unwired.reason, "not_configured");
  assert.equal(calls.length, 0, "an unwired kernel dispatched anyway");

  setTouchDeps({ store });
  try {
    const now = new Date();
    // Both handed the SAME pre-claim row, which is exactly what two browser tabs hold.
    const [a, b] = await Promise.all([
      startNextTouch(domain(), kase, { now }),
      startNextTouch(domain(), kase, { now }),
    ]);
    assert.equal([a.ok, b.ok].filter(Boolean).length, 1, "both clicks won the claim");
    assert.equal(calls.length, 1, `two clicks produced ${calls.length} messages`);
  } finally {
    setTouchDeps(null);
    _setDispatcher(null);
  }
});

test("first DM after accept uses profile_id when there is no conversation urn — and persists the thread", async () => {
  /**
   * THE BUG. `send_message` parked unconditionally when the case had no `thread`, and the step that
   * runs at `connected` IS the first DM — so by definition there was no conversation, and nothing
   * downstream could make one. Every campaign stalled at the exact moment it became valuable: an
   * invitation accepted and never followed by a message, re-parked on every tick, forever, with no
   * error anywhere.
   *
   * The second half is `resultData` keeping the urn the send just minted. Without it dm2 has no
   * thread either and opens a SECOND conversation with the same person.
   */
  const store = new InMemoryStore();
  const conn = await account("p-first-dm");
  const { campaign } = await campaignWith(store, "p-first-dm", conn);
  const kase = await enrolled(campaign, { thread: undefined });
  assert.equal((kase.data as Record<string, unknown>).thread, undefined);

  const calls: Array<{ action: string; payload: Record<string, unknown> }> = [];
  _setDispatcher(async (_conn, action, payload) => {
    calls.push({ action, payload });
    return {
      ok: true,
      detail: "sent",
      data: { message_id: "urn:li:fs_event:new", thread: "urn:li:fs_conversation:minted" },
    };
  });
  try {
    const summary = await advanceSequences(store, domain(), { project_id: "p-first-dm" });
    assert.equal(summary.sent, 1, "the first DM goes out instead of parking");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].payload.profile_id, "dana");
    assert.equal(calls[0].payload.thread, undefined);
    assert.equal(calls[0].payload.body, "hi Dana");

    const after = (await domain().getCase(kase.id))!;
    assert.equal(after.stage, "dm1");
    assert.equal(
      (after.data as Record<string, unknown>).thread,
      "urn:li:fs_conversation:minted",
      "the minted urn is kept, or dm2 starts a second thread with the same person",
    );
    assert.equal((after.data as Record<string, unknown>).last_message_id, "urn:li:fs_event:new");
  } finally {
    _setDispatcher(null);
  }
});

test("a send_message step with neither a thread nor a profile id still parks", async () => {
  // The park did not go away, it got a precondition. With nothing to address, nothing is sent.
  const store = new InMemoryStore();
  const conn = await account("p-park-dm");
  const { campaign } = await campaignWith(store, "p-park-dm", conn);
  await enrolled(campaign, { thread: undefined, profile_id: "" });
  const calls = spyDispatcher();
  try {
    const summary = await advanceSequences(store, domain(), { project_id: "p-park-dm" });
    assert.equal(summary.sent, 0);
    assert.equal(summary.parked, 1);
    assert.equal(calls.length, 0);
  } finally {
    _setDispatcher(null);
  }
});

test("a send_message step without approved copy parks rather than improvising", async () => {
  // Ordering guard: the copy check must still come before the addressing check, so a case with a
  // profile id and no approved words never sends improvised text under the founder's name.
  const store = new InMemoryStore();
  const conn = await account("p-no-copy");
  const { campaign } = await campaignWith(store, "p-no-copy", conn);
  const kase = await enrolled(campaign, { copy: {} });
  const calls = spyDispatcher();
  try {
    const summary = await advanceSequences(store, domain(), { project_id: "p-no-copy" });
    assert.equal(summary.sent, 0);
    assert.equal(summary.parked, 1);
    assert.equal(calls.length, 0);
    assert.match(
      String(((await domain().getCase(kase.id))!.data as Record<string, unknown>).paused_reason),
      /nothing will be improvised/,
    );
  } finally {
    _setDispatcher(null);
  }
});

test("a pacing refusal reschedules the case instead of sending — with a sentence the founder can read", async () => {
  const store = new InMemoryStore();
  // 3am local, expressed the way pacing sees it: outside this account's working hours. (Weekends
  // send now — the small hours are the only window guard, so that is what we push it into.)
  const conn = await account("p-paced", { utc_offset: workingHoursOffset() - 7 });
  const { campaign } = await campaignWith(store, "p-paced", conn);
  const kase = await enrolled(campaign);
  const calls = spyDispatcher();
  try {
    const now = new Date();
    const summary = await advanceSequences(store, domain(), { project_id: "p-paced", now });
    assert.equal(summary.paced, 1);
    assert.equal(summary.sent, 0);
    assert.equal(calls.length, 0, "a paced case must never reach the dispatcher");

    const after = (await domain().getCase(kase.id))!;
    assert.equal(after.stage, "connected", "and it stays where it was");
    assert.ok(Date.parse(after.due_at!) > now.getTime(), "due_at moved to when pacing said to try again");
    assert.match(String((after.data as Record<string, unknown>).paused_reason), /paused — .*working hours/);
  } finally {
    _setDispatcher(null);
  }
});

test("a used-up weekly allowance parks the case rather than spending what is not there", async () => {
  const store = new InMemoryStore();
  const conn = await account("p-budget", {
    pacing: {
      used: { message: 9999 },
      windows: { message: new Date().toISOString() },
      engagement: { sent: 200, accepted: 80, replied: 30, flagged: 0 },
    },
  });
  const { campaign } = await campaignWith(store, "p-budget", conn);
  const kase = await enrolled(campaign);
  const calls = spyDispatcher();
  try {
    const summary = await advanceSequences(store, domain(), { project_id: "p-budget" });
    assert.equal(summary.paced, 1);
    assert.equal(calls.length, 0);
    assert.match(String(((await domain().getCase(kase.id))!.data as Record<string, unknown>).paused_reason), /allowance/);
  } finally {
    _setDispatcher(null);
  }
});

test("a tick with no project processes NOTHING, and says why", async () => {
  const store = new InMemoryStore();
  const conn = await account("p-scoped");
  const { campaign } = await campaignWith(store, "p-scoped", conn);
  await enrolled(campaign);
  const calls = spyDispatcher();
  try {
    // `listCases` treats an absent project as "no tenant filter", so an unscoped schedule would
    // sequence EVERY customer's prospects through whichever account it found. Refusing is the only
    // safe reading of a schedule that lost its project.
    const summary = await advanceSequences(store, domain(), {});
    assert.equal(summary.processed, 0);
    assert.equal(calls.length, 0);
    assert.match(summary.note!, /no project/);

    // And a tick for a DIFFERENT project does not reach into this one.
    const other = await advanceSequences(store, domain(), { project_id: "p-somebody-else" });
    assert.equal(other.processed, 0);
    assert.equal(calls.length, 0);

    // The scoped tick does find it, which is what makes the two assertions above meaningful.
    const mine = await advanceSequences(store, domain(), { project_id: "p-scoped" });
    assert.equal(mine.processed, 1);
  } finally {
    _setDispatcher(null);
  }
});

test("a reply stops the sequence — no follow-up is ever sent after someone answers", async () => {
  const store = new InMemoryStore();
  const conn = await account("p-reply");
  const { campaign } = await campaignWith(store, "p-reply", conn, {
    steps: [
      { from: "connected", action: "send_message", advance_to: "dm1", only_if: "connected AND !replied" },
      { from: "dm1", action: "send_message", advance_to: "dm2", only_if: "connected AND !replied" },
    ],
  });
  const kase = await enrolled(campaign);
  const calls = spyDispatcher();
  try {
    await advanceSequences(store, domain(), { project_id: "p-reply" });
    assert.equal(calls.length, 1);

    // Dana answers. This is the inbox sync's path, and it is the only stop signal that matters.
    const flipped = await noteInboundReplies(domain(), conn, [{ thread_id: "urn:li:thread:1", from: { id: "dana", name: "Dana" } }]);
    assert.equal(flipped, 1);
    const replied = (await domain().getCase(kase.id))!;
    assert.equal(replied.stage, "replied");

    // Make it due again the way a follow-up would be, and tick repeatedly. `replied` is terminal,
    // so the case is never selected — stopping is structural, not a check somebody remembered.
    await domain().updateCase(kase.id, { due_at: new Date(Date.now() - 60_000).toISOString() });
    for (let i = 0; i < 3; i++) await advanceSequences(store, domain(), { project_id: "p-reply" });
    assert.equal(calls.length, 1, "a follow-up went out after they replied");
    assert.equal(factsFor((await domain().getCase(kase.id))!).replied, true);
  } finally {
    _setDispatcher(null);
  }
});

test("the gap between touches comes from the wedge's own cadence workflow, not from here", async () => {
  // next_touch.mjs already owns "how long after touch 1 does touch 2 go out" (+4 days), and it is
  // pure and clock-free. Duplicating that rule in the sequencer is how the two drift apart and the
  // founder ends up with a cadence nobody can find the source of. So it is asked, and this asserts
  // the answer is actually honoured — if the workflow were silently failing, the follow-up would go
  // out immediately and this test is the only thing that would notice.
  const store = new InMemoryStore();
  const conn = await account("p-cadence");
  const { campaign } = await campaignWith(store, "p-cadence", conn, {
    steps: [
      { from: "connected", action: "send_message", advance_to: "dm1", only_if: "connected AND !replied" },
      { from: "dm1", action: "send_message", advance_to: "dm2", only_if: "connected AND !replied" },
    ],
  });
  const kase = await enrolled(campaign);
  const calls = spyDispatcher();
  try {
    await advanceSequences(store, domain(), { project_id: "p-cadence" });
    assert.equal(calls.length, 1);

    // Pretend the jittered within-day spacing has elapsed. The CADENCE has not.
    await domain().updateCase(kase.id, { due_at: new Date(Date.now() - 60_000).toISOString() });
    const summary = await advanceSequences(store, domain(), { project_id: "p-cadence" });
    assert.equal(calls.length, 1, "the follow-up jumped the four-day gap");
    assert.equal(summary.parked, 1);
    const parked = (await domain().getCase(kase.id))!;
    assert.match(String((parked.data as Record<string, unknown>).paused_reason), /wait 4d before touch 2/);
    assert.ok(Date.parse(parked.due_at!) > Date.now() + 3 * 86_400_000);
  } finally {
    _setDispatcher(null);
  }
});

test("the batch is bounded — a backlog drains steadily instead of firing at once", async () => {
  const store = new InMemoryStore();
  const conn = await account("p-batch");
  const { campaign } = await campaignWith(store, "p-batch", conn);
  for (let i = 0; i < 40; i++) await enrolled(campaign);
  const calls = spyDispatcher();
  try {
    const summary = await advanceSequences(store, domain(), { project_id: "p-batch", limit: 5 });
    assert.equal(summary.processed, 5);
    assert.equal(calls.length, 5, "a burst is the bot signature the whole pacing design exists to avoid");
  } finally {
    _setDispatcher(null);
  }
});

test("the sequencer's schedule is scoped, frequent, and singular", async () => {
  const s = await ensureSequenceSchedule(domain(), "p-sched");
  assert.equal(s.project_id, "p-sched");
  assert.equal(s.task_type, "advance_sequences");
  // Frequent and small. A daily 09:00 schedule would spawn every due touch in one burst, which is
  // exactly what `nextIntervalMs`'s jitter exists to prevent.
  assert.deepEqual(s.cadence, { kind: "every", seconds: 300 });
  // Idempotent: two calls do not give a project two tickers racing each other.
  assert.equal((await ensureSequenceSchedule(domain(), "p-sched")).id, s.id);
  await assert.rejects(() => ensureSequenceSchedule(domain(), ""), /scoped to a project/);
});

test("a warm campaign has no invitation step, and its people start connected", async () => {
  const store = new InMemoryStore();
  const conn = await account("p-warm");
  // The bug this prevents: `WARM_SEQUENCE` has no `send_invite`, so nothing ever sets `connected`.
  // Its first DM guards on `connected AND !replied`, so every case on a warm list would sit at
  // `queued` for ever — a campaign that looks busy and sends nothing, against a list of people the
  // founder already knows.
  validateSteps(WARM_SEQUENCE);
  assert.equal(WARM_SEQUENCE.some((s) => s.action === "send_invite"), false);
  assert.equal(DEFAULT_SEQUENCE.some((s) => s.action === "send_invite"), true);

  const { campaign } = await campaignWith(store, "p-warm", conn, { steps: WARM_SEQUENCE });
  const kase = await enrollProspect(domain(), campaign, { profile_id: "dana", name: "Dana" });
  assert.equal((kase.data as Record<string, unknown>).connected, true);
  assert.equal(factsFor(kase).connected, true);

  // And the invite-carrying default must NOT claim the fact — an invitation that has not been
  // accepted is exactly the case `connected` exists to be false for.
  const { campaign: cold } = await campaignWith(store, "p-warm", conn, { name: "cold", steps: DEFAULT_SEQUENCE });
  const coldCase = await enrollProspect(domain(), cold, { profile_id: "rui", name: "Rui" });
  assert.equal((coldCase.data as Record<string, unknown>).connected, undefined);
});
