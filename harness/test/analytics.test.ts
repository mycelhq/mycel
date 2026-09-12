// The kernel's product events — tests that assert the CALL SITES fire, not that the helper works.
//
// This distinction is the whole point of the file. A test that calls `capture()` directly and checks
// the body proves the POST is well-formed and proves nothing about whether anything ever calls it,
// which is precisely the failure that made this module necessary: production raised fifty-one client
// asks and instrumented none of them, while the three answers were captured perfectly. Every test
// below drives a real kernel path — arm a wait, satisfy it, let one expire, raise an ask — and reads
// what came out of the wire.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { api, makeApp, makeFreshApp } from "./helpers";
import { getDomainStore } from "../src/domain";
import { registerActionGrant } from "../src/actiongrants";
import { MAX_WAIT_DAYS, armWait, setWaitDeps, sweepWaits } from "../src/waits";
import { KERNEL_EVENT } from "../src/analytics";

const WEDGE = "books-keeper";
const RESUME_TYPE = "monthly_close";
const DAY = 86_400_000;

interface Captured {
  event: string;
  distinct_id: string;
  properties: Record<string, unknown>;
}

/**
 * Record what `capture()` puts on the wire, and pass everything else through.
 *
 * Passing through is not politeness. The kernel under test sends real mail, reads real connections
 * and talks to a sandbox; a blanket fetch stub would make this file's failures indistinguishable
 * from the harness losing its network, and would quietly break any test that ran after it.
 */
function recordCaptures(): { seen: Captured[]; restore: () => void } {
  const seen: Captured[] = [];
  const real = globalThis.fetch;
  const priorKey = process.env.MYCEL_POSTHOG_KEY;
  process.env.MYCEL_POSTHOG_KEY = "phc_test_key";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/capture/")) {
      seen.push(JSON.parse(String(init?.body)) as Captured);
      return new Response("1", { status: 200 });
    }
    return real(input as never, init as never);
  }) as typeof fetch;
  return {
    seen,
    restore: () => {
      globalThis.fetch = real;
      if (priorKey === undefined) delete process.env.MYCEL_POSTHOG_KEY;
      else process.env.MYCEL_POSTHOG_KEY = priorKey;
    },
  };
}

/**
 * A client the run can actually reach: a mailbox on the project and an address on the client.
 *
 * Required since `clientReachable` — a client ask with nowhere to go is now redirected to the
 * founder rather than filed silently, which is the fix for all fifty-one production asks having
 * `thread_id` NULL. These two tests are about the ask being RAISED, so they have to set up a client
 * who can be asked. Before this they passed against an unreachable one, which is precisely the
 * state the product was shipping.
 */
async function reachableClient(app: ReturnType<typeof makeApp>["app"], projectId: string): Promise<string> {
  await getDomainStore().createConnection({
    project_id: projectId, kind: "email", name: "mailbox", owner: { kind: "founder", id: "f" },
    config: { from: "hello@practice.test", api_url: "https://api.postmark.test/email" }, secret_ref: "env:MAIL",
  } as never).catch(() => undefined);
  const c = await getDomainStore().createClient({
    project_id: projectId, display_name: "Brightline", handles: ["ops@brightline.test"],
  } as never);
  return c.id;
}

async function engagement() {
  const { app } = await makeFreshApp();
  const projectId = (await api(app, "me")).json.projects[0].id as string;
  const client = (
    await api(app, "clients", { method: "POST", body: JSON.stringify({ display_name: "Acme", handles: [`acme-${randomUUID()}@x.test`] }) })
  ).json;
  const kase = (
    await api(app, "cases", { method: "POST", body: JSON.stringify({ wedge: WEDGE, title: "Acme — October close", client_id: client.id }) })
  ).json;
  return { app, projectId, client, kase, domain: getDomainStore() };
}

test("analytics: arming a wait emits wait_armed, keyed on the project", async () => {
  const { seen, restore } = recordCaptures();
  try {
    const { domain, projectId, kase } = await engagement();
    const armed = await armWait(domain, {
      project_id: projectId,
      case_id: kase.id,
      reason: "waiting on four receipts",
      conditions: [
        { kind: "date", at: new Date(Date.now() + DAY).toISOString() },
        { kind: "date", at: new Date(Date.now() + 2 * DAY).toISOString() },
      ],
      mode: "all",
      resume: { task_type: RESUME_TYPE, input: {} },
    });
    assert.equal(armed.ok, true);

    const ev = seen.find((e) => e.event === KERNEL_EVENT.waitArmed);
    assert.ok(ev, "arming a wait fired nothing — the denominator is missing again");
    // The project, not a fabricated user. The kernel has no session and inventing one would put a
    // person in PostHog who does not exist.
    assert.equal(ev.distinct_id, projectId);
    assert.equal(ev.properties.project_id, projectId);
    assert.equal(ev.properties.wedge, WEDGE);
    assert.equal(ev.properties.resume_task_type, RESUME_TYPE);
    // A seven-part join and one missing receipt are different businesses; averaging hides it.
    assert.equal(ev.properties.conditions, 2);
    assert.equal(ev.properties.mode, "all");
  } finally {
    restore();
  }
});

test("analytics: a wait that resumes emits wait_resumed, so an answered ask is provably worth something", async () => {
  const { seen, restore } = recordCaptures();
  try {
    const { domain, projectId, kase } = await engagement();
    setWaitDeps({ wedgeEnabled: () => true, spawnTask: async () => "task-1" });

    // Due yesterday, so the very next sweep satisfies it.
    const armed = await armWait(domain, {
      project_id: projectId,
      case_id: kase.id,
      reason: "resume on the 1st",
      condition: { kind: "date", at: new Date(Date.now() - DAY).toISOString() },
      resume: { task_type: RESUME_TYPE, input: {} },
    });
    assert.equal(armed.ok, true);

    const summary = await sweepWaits({ domain, project_id: projectId });
    assert.equal(summary.resumed, 1, "the wait did not resume, so this test proves nothing about the event");

    const ev = seen.find((e) => e.event === KERNEL_EVENT.waitResumed);
    assert.ok(ev, "work restarted and nothing recorded it");
    assert.equal(ev.distinct_id, projectId);
    assert.equal(ev.properties.resume_task_type, RESUME_TYPE);
    assert.equal(typeof ev.properties.parked_hours, "number");
  } finally {
    restore();
  }
});

test("analytics: an expired wait emits wait_dead as expired, kept apart from broken", async () => {
  const { seen, restore } = recordCaptures();
  try {
    const { domain, projectId, kase, client } = await engagement();
    setWaitDeps({ wedgeEnabled: () => true, spawnTask: async () => "task-1" });

    // A REAL thread. `client_reply` against an id nothing owns evaluates as unresolvable, which
    // takes the broken branch — the test would then pass on the wrong event and claim to have
    // proven something about expiry that it never touched.
    const channel = await domain.createChannel({ project_id: projectId, kind: "email", name: "inbox", config: {} } as never);
    const thread = await domain.createThread(
      { project_id: projectId, client_id: client.id, channel_id: channel.id, case_id: kase.id, status: "open" } as never,
    );

    const armedAt = new Date("2026-01-01T00:00:00.000Z");
    const armed = await armWait(
      domain,
      {
        project_id: projectId,
        case_id: kase.id,
        reason: "client never sent the receipts",
        condition: { kind: "client_reply", thread_id: thread.id },
        resume: { task_type: RESUME_TYPE, input: {} },
        max_nudges: 0,
      },
      armedAt,
    );
    assert.equal(armed.ok, true);

    // A day past the ninety-day cap, rather than waiting three months.
    const summary = await sweepWaits({ domain, project_id: projectId, now: new Date(armedAt.getTime() + (MAX_WAIT_DAYS + 1) * DAY) });
    assert.equal(summary.expired, 1, "nothing expired, so the assertion below would be vacuous");

    const ev = seen.find((e) => e.event === KERNEL_EVENT.waitDead);
    assert.ok(ev, "an engagement gave up waiting and left no trace");
    // "Expired" is a slow client. "Broken" is our bug. A dashboard that counts "did not resume"
    // merges them, and only one of the two is something we can fix.
    assert.equal(ev.properties.how, "expired");
    assert.equal(ev.properties.total, 1);
  } finally {
    restore();
  }
});

test("analytics: raising a client ask emits request_raised — the denominator production never had", async () => {
  const { seen, restore } = recordCaptures();
  try {
    const { app, store } = makeApp();
    const projectId = (await api(app, "me")).json.projects[0].id as string;
    const clientId = await reachableClient(app, projectId);
    const now = new Date().toISOString();
    const taskId = `analytics-task-${randomUUID()}`;
    await store.createTask({
      id: taskId,
      project_id: projectId,
      client_id: clientId,
      case_id: "case-analytics",
      wedge: WEDGE,
      task_type: "reconcile",
      actor: { kind: "system", id: "scheduler" },
      input: {},
      constraints: {},
      tools: [],
      status: "running",
      cost_usd: 0,
      created_at: now,
      updated_at: now,
    } as never);
    const nonce = await registerActionGrant({ task_id: taskId, connectionIds: [] });

    const r = (
      await api(app, "internal/knowledge/gap", {
        method: "POST",
        headers: { authorization: `Bearer ${nonce}` },
        body: JSON.stringify({
          question: "Where is the receipt for the 14 March payment of $2,400?",
          ask_client: true,
          kind: "document",
          detail: "A PDF or a photo is fine.",
          fallback: "assumed it was the Q1 retainer",
        }),
      })
    ).json;
    assert.equal(r.asked, "client", "no ask was raised, so there is nothing to have measured");

    const ev = seen.find((e) => e.event === KERNEL_EVENT.requestRaised);
    assert.ok(ev, "an ask went to a client and PostHog never heard about it");
    assert.equal(ev.distinct_id, projectId);
    assert.equal(ev.properties.wedge, WEDGE);
    assert.equal(ev.properties.task_type, "reconcile");
    assert.equal(ev.properties.kind, "document");
  } finally {
    restore();
  }
});

test("analytics: the founder answering an ask emits request_answered_by_founder, so the funnel is not read as client silence", async () => {
  // Two events, not one. The portal already fires when a CLIENT answers; without this half, a
  // founder who chases the client by phone and types the answer in themselves shows up in PostHog
  // as an ask that was never answered — and fifty-one raised against three answered is the exact
  // number that would send us building the wrong thing.
  const { seen, restore } = recordCaptures();
  try {
    const { app, store } = makeApp();
    const projectId = (await api(app, "me")).json.projects[0].id as string;
    const clientId = await reachableClient(app, projectId);
    const now = new Date().toISOString();
    const taskId = `answered-task-${randomUUID()}`;
    await store.createTask({
      id: taskId, project_id: projectId, client_id: clientId, case_id: "case-answered",
      wedge: WEDGE, task_type: "reconcile", actor: { kind: "system", id: "scheduler" },
      input: {}, constraints: {}, tools: [], status: "running", cost_usd: 0, created_at: now, updated_at: now,
    } as never);
    const nonce = await registerActionGrant({ task_id: taskId, connectionIds: [] });

    const raised = (
      await api(app, "internal/knowledge/gap", {
        method: "POST",
        headers: { authorization: `Bearer ${nonce}` },
        body: JSON.stringify({
          question: "Which bank is the October statement from?",
          ask_client: true,
          kind: "text",
          fallback: "assumed the main account",
        }),
      })
    ).json;
    assert.ok(raised.request_id, "no ask was raised, so there is nothing to answer");

    const answered = await api(app, `requests/${raised.request_id}/respond`, {
      method: "POST",
      body: JSON.stringify({ response: "Barclays — I rang them." }),
    });
    assert.equal(answered.status, 200, `the founder could not answer: ${JSON.stringify(answered.json)}`);

    const ev = seen.find((e) => e.event === KERNEL_EVENT.requestAnsweredByFounder);
    assert.ok(ev, "the founder answered and the funnel still shows an unanswered ask");
    assert.equal(ev.distinct_id, projectId);
    assert.equal(ev.properties.kind, "text");
    assert.equal(ev.properties.with_files, false);
    // Whether an ask is a queue or a bottleneck is a question about time, not count.
    assert.equal(typeof ev.properties.waited_hours, "number");
  } finally {
    restore();
  }
});

test("analytics: no key means no network, so a fresh checkout does not post to PostHog", async () => {
  // Not a nicety. Every developer running the suite, and every self-hosted worker without a key,
  // would otherwise fire real events at whatever host the default points to.
  const real = globalThis.fetch;
  const priorKey = process.env.MYCEL_POSTHOG_KEY;
  const priorPublic = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  delete process.env.MYCEL_POSTHOG_KEY;
  delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
  let posts = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input instanceof Request ? input.url : input).includes("/capture/")) posts++;
    return real(input as never, init as never);
  }) as typeof fetch;
  try {
    const { domain, projectId, kase } = await engagement();
    await armWait(domain, {
      project_id: projectId,
      case_id: kase.id,
      reason: "quiet",
      condition: { kind: "date", at: new Date(Date.now() + DAY).toISOString() },
      resume: { task_type: RESUME_TYPE, input: {} },
    });
    assert.equal(posts, 0, "an unconfigured kernel sent analytics anyway");
  } finally {
    globalThis.fetch = real;
    if (priorKey !== undefined) process.env.MYCEL_POSTHOG_KEY = priorKey;
    if (priorPublic !== undefined) process.env.NEXT_PUBLIC_POSTHOG_KEY = priorPublic;
  }
});
