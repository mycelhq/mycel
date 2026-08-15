// The nudge carrier's tests.
//
// `nudge_client_request` was the move kind with no carrier: open `ClientRequest` rows sat there and
// nothing in the repo ever chased them. The bugs that matter for the thing that closes that gap are
// not "does it send the right words" — that is the agent's job, and it is gated by an approval.
// They are:
//
//   1. IDEMPOTENCE. A client must not be reminded twice about the same document because two replicas
//      swept at once, or because a founder double-clicked. Every test below that touches pacing names
//      that bug.
//   2. ONE IMPLEMENTATION. The sweep, the route and `takeMove` must be provably the same run. They
//      were two copies for the chase once, and the field they drifted on was the one the ladder
//      branches on.
//   3. TENANCY. Every read is scoped, and a request in another project must be invisible rather than
//      refused-after-being-read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getDomainStore } from "../src/domain";
import { getRequestStore } from "../src/requests";
import {
  MAX_NUDGES,
  NUDGE_TASK_TYPE,
  nudgeIntervalDays,
  nudgeIsDue,
  nudgeWedgeFor,
  setNudgeDeps,
  startNudge,
  sweepOpenRequests,
  wedgeCarriesNudge,
} from "../src/nudges";

const WEDGE = "books-keeper";
const DAY = 86_400_000;
const NOW = new Date();
const ago = (d: number) => new Date(NOW.getTime() - d * DAY).toISOString();
const at = (d: number) => new Date(NOW.getTime() + d * DAY);

/**
 * The real registration point `mountRequestRoutes` uses, not a hand-built stub of the module.
 *
 * Through `setNudgeDeps` deliberately: a test that called a private spawn would keep passing on the
 * day the wiring stopped being registered, and "the sweep silently does nothing" is exactly the
 * failure this file exists to catch.
 */
function recordingDeps(opts: { enabled?: boolean; throws?: boolean } = {}) {
  const spawned: Array<Record<string, any>> = [];
  setNudgeDeps({
    wedgeEnabled: () => opts.enabled !== false,
    spawnTask: async (args) => {
      if (opts.throws) throw new Error("queue is down");
      spawned.push(args as never);
      return `task-${spawned.length}`;
    },
  });
  return { spawned, restore: () => setNudgeDeps(null) };
}

async function engagement(projectId: string, wedge = WEDGE) {
  const client = await getDomainStore().createClient({
    project_id: projectId, display_name: "Acme Ltd", handles: [`a-${randomUUID().slice(0, 6)}@x.co`], metadata: {},
  });
  const kase = await getDomainStore().createCase({
    project_id: projectId, wedge, title: "March close", client_id: client.id,
    stage: "gathering", status: "open", data: {},
  });
  return { client, kase };
}

async function ask(projectId: string, opts: { case_id?: string; client_id: string; due_at?: string }) {
  return getRequestStore().createRequest({
    project_id: projectId,
    client_id: opts.client_id,
    case_id: opts.case_id,
    kind: "document",
    ask: "Your March bank statement",
    due_at: opts.due_at,
  });
}

// ── the ladder, pure ─────────────────────────────────────────────────────────────────────────────

test("the nudge ladder slows down as it escalates, and never goes under the floor", () => {
  // THE BUG: a chaser that speeds up. A third reminder arriving twice a week is the point at which
  // an automated chaser stops being helpful and becomes the reason a client mutes the sender.
  assert.ok(nudgeIntervalDays(1) < nudgeIntervalDays(2));
  assert.ok(nudgeIntervalDays(2) < nudgeIntervalDays(3));
  // Nonsense in must not produce "chase immediately" out.
  assert.ok(nudgeIntervalDays(NaN) >= 2);
  assert.ok(nudgeIntervalDays(-5) >= 2);
});

test("a request is due when it is past its date OR simply old, and not before", () => {
  // THE BUG: treating "no deadline" as "never urgent". Most requests are raised mid-run with no
  // due date, and that is precisely the population that otherwise never gets chased at all.
  const nowIso = NOW.toISOString();
  assert.equal(nudgeIsDue({ created_at: ago(0) }, nowIso), false);
  assert.equal(nudgeIsDue({ created_at: ago(5) }, nowIso), true, "an old ask with no date must still be chased");
  assert.equal(nudgeIsDue({ created_at: ago(0), due_at: ago(1) }, nowIso), true, "past its own date is due immediately");
  assert.equal(nudgeIsDue({ created_at: ago(0), due_at: at(5).toISOString() }, nowIso), false);
});

// ── whose voice ──────────────────────────────────────────────────────────────────────────────────

test("the wedge comes from the engagement, and a cross-tenant case never supplies one", async () => {
  // THE BUG the first version shipped: `scope.wedges[0] ?? DUNNING_WEDGE` — the authority's first
  // wedge, in whatever order a Set iterated — which would chase a client for a bank statement in the
  // invoice-chaser's dunning voice with the dunning policy mounted as its knowledge.
  const mine = `p-${randomUUID()}`;
  const theirs = `p-${randomUUID()}`;
  const { client, kase } = await engagement(mine);
  const attached = await ask(mine, { client_id: client.id, case_id: kase.id });
  assert.equal(await nudgeWedgeFor(getDomainStore(), attached), WEDGE);

  const loose = await ask(mine, { client_id: client.id });
  assert.equal(await nudgeWedgeFor(getDomainStore(), loose), undefined, "nothing owns the voice of an unattached ask");

  // A request claiming another tenant's case. `getCase` cannot scope itself, so this is the one
  // check standing between a forged `case_id` and a run spawned under another founder's connections.
  const theirEngagement = await engagement(theirs);
  const forged = { ...attached, project_id: mine, case_id: theirEngagement.kase.id };
  assert.equal(await nudgeWedgeFor(getDomainStore(), forged), undefined, "a case in another project must resolve to no wedge");
});

test("a wedge that does not declare the task type cannot carry a nudge", () => {
  // THE BUG: spawning a run for a task type no manifest declares. It arrives with no output schema,
  // no policy rules and no knowledge — an agent handed a verb nobody taught it.
  assert.equal(wedgeCarriesNudge(WEDGE), true);
  assert.equal(wedgeCarriesNudge("gtm-operator"), false);
  assert.equal(wedgeCarriesNudge("no-such-wedge"), false);
  assert.equal(wedgeCarriesNudge(undefined), false);
});

// ── idempotence: the whole point ─────────────────────────────────────────────────────────────────

test("two nudges started at once produce ONE run — the claim, not a check", async (t) => {
  // THE BUG, and it is the reason `last_nudged_at` exists at all: with four worker replicas, "read
  // the row, decide a reminder is due, write that we reminded" passes the check in both before either
  // writes, and the client gets the same email twice in one second. The guard has to be one statement.
  const { spawned, restore } = recordingDeps();
  t.after(restore);
  const project = `p-${randomUUID()}`;
  const { client, kase } = await engagement(project);
  const req = await ask(project, { client_id: client.id, case_id: kase.id });

  const when = at(5);
  const [a, b] = await Promise.all([
    startNudge(getDomainStore(), req, { pacing: "ladder", now: when }),
    startNudge(getDomainStore(), req, { pacing: "ladder", now: when }),
  ]);
  assert.equal([a, b].filter((r) => r.ok).length, 1, "exactly one caller may win the claim");
  assert.equal([a, b].find((r) => !r.ok)!.ok === false && ([a, b].find((r) => !r.ok) as any).reason, "paced");
  assert.equal(spawned.length, 1, "a second run is a second email in a client's inbox");
});

test("the ladder holds a second nudge inside its window, and says so honestly", async (t) => {
  const { spawned, restore } = recordingDeps();
  t.after(restore);
  const project = `p-${randomUUID()}`;
  const { client, kase } = await engagement(project);
  const req = await ask(project, { client_id: client.id, case_id: kase.id });

  const first = await startNudge(getDomainStore(), req, { pacing: "ladder", now: at(5) });
  assert.equal(first.ok, true, first.ok ? "" : first.message);

  const fresh = (await getRequestStore().getRequest(project, req.id))!;
  const tooSoon = await startNudge(getDomainStore(), fresh, { pacing: "ladder", now: at(6) });
  assert.equal(tooSoon.ok, false);
  // `paced` is NOT a failure. A button that says "something went wrong" when the honest answer is
  // "we asked them yesterday" teaches a founder to distrust the policy.
  assert.equal(tooSoon.ok === false && tooSoon.reason, "paced");

  const later = (await getRequestStore().getRequest(project, req.id))!;
  const allowed = await startNudge(getDomainStore(), later, { pacing: "ladder", now: at(5 + nudgeIntervalDays(1) + 1) });
  assert.equal(allowed.ok, true, allowed.ok ? "" : allowed.message);
  assert.equal(spawned.length, 2);
});

test("a founder overriding still cannot spend more than the client's patience", async (t) => {
  // THE BUG: an escape hatch that is really an unlimited one. `override` exists so a founder is never
  // silently declined — but MAX_NUDGES is about how many emails a customer will tolerate, and a
  // founder clicking a button does not increase that number.
  const { spawned, restore } = recordingDeps();
  t.after(restore);
  const project = `p-${randomUUID()}`;
  const { client, kase } = await engagement(project);
  const req = await ask(project, { client_id: client.id, case_id: kase.id });

  for (let i = 0; i < MAX_NUDGES; i++) {
    const row = (await getRequestStore().getRequest(project, req.id))!;
    const r = await startNudge(getDomainStore(), row, { pacing: "override", now: at(i) });
    assert.equal(r.ok, true, `override ${i} was refused: ${r.ok ? "" : r.message}`);
  }
  const spent = (await getRequestStore().getRequest(project, req.id))!;
  const refused = await startNudge(getDomainStore(), spent, { pacing: "override", now: at(9) });
  assert.equal(refused.ok, false);
  assert.equal(refused.ok === false && refused.reason, "exhausted");
  assert.equal(spawned.length, MAX_NUDGES, "the budget is enforced inside the claim, not by a caller");
});

test("a resolved request cannot be nudged, whatever the caller believes", async (t) => {
  // THE BUG: reminding a client about a document they already sent. The status guard is in the
  // claim's WHERE clause, so a stale row in a caller's hand cannot get past it.
  const { spawned, restore } = recordingDeps();
  t.after(restore);
  const project = `p-${randomUUID()}`;
  const { client, kase } = await engagement(project);
  const req = await ask(project, { client_id: client.id, case_id: kase.id });
  await getRequestStore().resolveRequest(project, req.id, "here it is");

  // `req` is the row as it was BEFORE the answer arrived — exactly what a sweep holds mid-pass.
  const r = await startNudge(getDomainStore(), req, { pacing: "override", now: at(5) });
  assert.equal(r.ok, false);
  assert.equal(spawned.length, 0);
});

// ── wiring, fail-closed ──────────────────────────────────────────────────────────────────────────

test("an unwired kernel and a disabled wedge both nudge nobody", async (t) => {
  // THE BUG: degrading to a simpler spawn. A kernel booted without the request routes mounted has no
  // business emailing anybody's clients, and a founder who turned a wedge off has said the business
  // no longer does that work.
  const project = `p-${randomUUID()}`;
  const { client, kase } = await engagement(project);
  const req = await ask(project, { client_id: client.id, case_id: kase.id });

  setNudgeDeps(null);
  const unwired = await startNudge(getDomainStore(), req, { pacing: "override", now: at(5) });
  assert.equal(unwired.ok === false && unwired.reason, "not_configured");

  const { spawned, restore } = recordingDeps({ enabled: false });
  t.after(restore);
  const off = await startNudge(getDomainStore(), req, { pacing: "override", now: at(5) });
  assert.equal(off.ok === false && off.reason, "wedge_disabled");
  assert.equal(spawned.length, 0);
  // And neither refusal stamped the row: a refusal that paced the request would silence the sweep too.
  assert.equal((await getRequestStore().getRequest(project, req.id))!.last_nudged_at, undefined);
});

test("a spawn that fails does not release the claim", async (t) => {
  // THE BUG a release would reintroduce: two replicas racing the release and both re-nudging. A
  // missed reminder costs one interval; a duplicate one costs the relationship. Same trade as
  // `startChase`.
  const { restore } = recordingDeps({ throws: true });
  t.after(restore);
  const project = `p-${randomUUID()}`;
  const { client, kase } = await engagement(project);
  const req = await ask(project, { client_id: client.id, case_id: kase.id });

  const r = await startNudge(getDomainStore(), req, { pacing: "ladder", now: at(5) });
  assert.equal(r.ok === false && r.reason, "spawn_failed");
  const row = (await getRequestStore().getRequest(project, req.id))!;
  assert.ok(row.last_nudged_at, "the claim must stay held after a failed spawn");
  assert.equal(row.nudge_count, 1);
});

// ── the sweep ────────────────────────────────────────────────────────────────────────────────────

test("the sweep and a direct nudge produce the same run, and never cross a tenant", async (t) => {
  // THE BUG dunning.ts:220-233 records: a take path and a sweep path that are two copies agreeing by
  // accident. They are compared as whole objects rather than field by field, because the field a
  // future change drifts on is exactly the one a hand-written list of assertions forgot.
  const { spawned, restore } = recordingDeps();
  t.after(restore);
  const mine = `p-${randomUUID()}`;
  const theirs = `p-${randomUUID()}`;
  const a = await engagement(mine);
  const b = await engagement(theirs);
  const swept = await ask(mine, { client_id: a.client.id, case_id: a.kase.id });
  const direct = await ask(mine, { client_id: a.client.id, case_id: a.kase.id });
  const theirRequest = await ask(theirs, { client_id: b.client.id, case_id: b.kase.id });

  const when = at(5);
  const one = await startNudge(getDomainStore(), direct, { pacing: "ladder", now: when });
  assert.equal(one.ok, true, one.ok ? "" : one.message);
  const summary = await sweepOpenRequests({ domain: getDomainStore(), project_id: mine, now: when });

  assert.equal(summary.project_id, mine);
  assert.ok(summary.nudged >= 1);
  const fromSweep = spawned.find((s) => s.input.request_id === swept.id);
  const fromDirect = spawned.find((s) => s.input.request_id === direct.id);
  assert.ok(fromSweep && fromDirect, "both doors must have spawned a run");
  assert.equal(fromSweep.wedge, fromDirect.wedge);
  assert.equal(fromSweep.task_type, NUDGE_TASK_TYPE);
  assert.equal(fromSweep.source, fromDirect.source);
  const anonymise = (i: Record<string, unknown>) => ({ ...i, request_id: null });
  assert.deepEqual(anonymise(fromSweep.input), anonymise(fromDirect.input));

  // Nothing in the other tenant was touched, and no run was spawned for it.
  assert.equal(spawned.some((s) => s.project_id === theirs), false);
  assert.equal((await getRequestStore().getRequest(theirs, theirRequest.id))!.last_nudged_at, undefined);
});

test("a sweep must be scoped to a project — there is no overload that sweeps everything", async () => {
  // THE BUG: `?? ""` at a call site. A single misconfigured schedule mailing every tenant's clients
  // from one project's connection is how the two cross-tenant leaks in this codebase got in.
  await assert.rejects(
    () => sweepOpenRequests({ domain: getDomainStore(), project_id: "", now: NOW }),
    /scoped to a project/,
  );
});

test("the sweep is idempotent across ticks — a client is reminded once, not once per tick", async (t) => {
  // THE BUG: the sweep cadence becoming the client's experience. It runs every four hours; the
  // ladder decides what the customer actually receives, and making the sweep more frequent must make
  // it more RESPONSIVE rather than more aggressive.
  const { spawned, restore } = recordingDeps();
  t.after(restore);
  const project = `p-${randomUUID()}`;
  const { client, kase } = await engagement(project);
  await ask(project, { client_id: client.id, case_id: kase.id });

  for (let hour = 0; hour < 12; hour++) {
    await sweepOpenRequests({ domain: getDomainStore(), project_id: project, now: at(5 + hour / 24) });
  }
  assert.equal(spawned.length, 1, `twelve hourly ticks produced ${spawned.length} reminders`);
});
