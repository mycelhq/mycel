// The GTM loop, end to end, against a mocked Voyager transport.
//
// The pieces each had tests and the LOOP had none, which is exactly how a system ends up with a
// dispatcher that returns "unsupported" for two of its own default steps long after their executors
// shipped. Every campaign on the shipped sequence parked at step one, for ever, and nothing failed —
// the case just sat there with a reason on it that read like a design decision.
//
// So this file proves the path a prospect actually takes: search → graph → enrol → tick → refused by
// pacing → tick → warm-up view → tick → invitation. What it asserts along the way is the set of
// things that are each an incident on their own:
//
//   · the pacing counter DECREMENTS for every action, not just for `send_message`. That loop was
//     only closed recently and a new action path that skipped it silently reopens the bug whose
//     end state is a founder's real account restricted for a week with no appeal;
//   · a pacing refusal writes a due_at and a sentence, and never a dispatch;
//   · `send_invite` — the scarcest and most irreversible thing LinkedIn offers — goes through the
//     same approval path `send_message` does, and lands in the same queue afterwards;
//   · the invitation id LinkedIn mints ONCE is persisted, because withdrawing is the only way to
//     recover weekly allowance and there is no endpoint that would find that id again;
//   · the Commercial Search Limit surfaces as a named condition rather than "search failed".
//
// What is NOT provable here, and is not pretended: that LinkedIn accepts these cookies, that these
// endpoints still exist, and that a profile view actually reaches anyone's notifications. Those are
// the live checklist.
import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryStore } from "../src/store";
import { getDomainStore } from "../src/domain";
import { initSecretStore } from "../src/secrets";
import type { Connection } from "../src/contract";
import { _setFetch } from "../src/linkedin/proxy";
import { _resetUsage } from "../src/linkedin/meter";
import { connectWithSession, _setVerifier } from "../src/linkedin/connect";
import { COMPANY_COLLECTION, PEOPLE_COLLECTION } from "../src/linkedin/graph";
import { hasLinkedInExecutor } from "../src/actions";
import { SEQUENCE_LIVE_SET } from "../src/linkedin/verbs";
import { proposeCampaign, type Campaign, type SequenceStep } from "../src/gtm/campaign";
import { enrolProspects, findProspects, prospectsFromGraph } from "../src/gtm/prospects";
import { advanceSequences } from "../src/gtm/sequence";
import { gtmWedge } from "../src/gtm/stages";
import { randomUUID } from "node:crypto";

await initSecretStore();
_setVerifier(async () => ({ self_urn: "urn:li:fs_miniProfile:ME", mailbox_urn: "urn:li:fsd_profile:ME", name: "Founder" }));

const domain = () => getDomainStore();
const PROXY = "http://user:pw@resi.example:8080";

// ── the mocked Voyager ───────────────────────────────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h: string) => (h === "content-length" ? String(text.length) : null) },
    text: async () => text,
  } as unknown as Response;
}

/** A blended search page, in the shape the recursive parser in search.ts walks. */
const SEARCH_PAGE = {
  elements: [
    {
      type: "SEARCH_HITS",
      elements: [
        {
          targetUrn: "urn:li:fsd_profile:ACoAAADANA",
          title: { text: "Dana Okafor" },
          primarySubtitle: { text: "VP Engineering at Acme" },
          secondarySubtitle: { text: "Austin, Texas, United States" },
          navigationUrl: "https://www.linkedin.com/in/dana-okafor?trk=search",
          companyWebsite: "https://www.acme.com/about",
        },
        {
          targetUrn: "urn:li:fsd_profile:ACoAAARUI",
          title: { text: "Rui Silva" },
          primarySubtitle: { text: "CTO at Brightlane" },
          secondarySubtitle: { text: "Lisbon, Portugal" },
          navigationUrl: "https://www.linkedin.com/in/rui-silva",
          companyWebsite: "brightlane.io",
        },
      ],
    },
  ],
  paging: { total: 2 },
};

const profilePayload = (publicId: string, first: string, last: string, urnId: string) => ({
  profile: {
    publicIdentifier: publicId,
    firstName: first,
    lastName: last,
    entityUrn: `urn:li:fs_miniProfile:${urnId}`,
    headline: "VP Engineering at Acme",
    geoLocationName: "Austin",
    industryName: "Software",
  },
  positionView: {
    elements: [{ title: "VP Engineering", companyName: "Acme", company: { universalName: "acme", companyPageUrl: "https://acme.com" } }],
  },
});

/** Every URL the transport was asked for, in order. The proof of what actually left the box. */
type Wire = { urls: string[]; bodies: string[] };

function mockVoyager(): Wire {
  const wire: Wire = { urls: [], bodies: [] };
  _setFetch(async (url, init) => {
    wire.urls.push(url);
    wire.bodies.push(String((init as Record<string, unknown>)?.body ?? ""));
    if (
      url.includes("/search/results/people") ||
      url.includes("/search/blended") ||
      url.includes("/voyager/api/graphql")
    ) {
      return jsonResponse(SEARCH_PAGE);
    }
    if (url.includes("/growth/normInvitations")) {
      // LinkedIn hands the invitation id back exactly once, here.
      return jsonResponse({ value: { entityUrn: "urn:li:invitation:INV-9", sharedSecret: "shhh" } });
    }
    if (url.includes("action=withdraw")) return jsonResponse({ value: {} });
    if (url.includes("/identity/profiles/")) {
      const id = decodeURIComponent(url.split("/identity/profiles/")[1].split("/")[0]);
      return jsonResponse(profilePayload(id, id.split("-")[0], id.split("-")[1] ?? "x", `ACoAAA${id}`));
    }
    return jsonResponse({});
  });
  return wire;
}

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────────

/** Hours to add to now so the derived local time is a Tuesday at 10:00 — inside the sending window. */
function workingHoursOffset(now = new Date()): number {
  const target = new Date(now);
  target.setUTCHours(10, 0, 0, 0);
  while (target.getUTCDay() !== 2) target.setUTCDate(target.getUTCDate() + 1);
  return (target.getTime() - now.getTime()) / 3_600_000;
}

/** A connected account, with the pacing profile a real one carries. `inHours` decides the verdict. */
async function account(project: string, inHours: boolean): Promise<Connection> {
  const r = await connectWithSession({ li_at: "AQEDx", jsessionid: '"ajax:1"', proxyUrl: PROXY, project_id: project });
  assert.equal(r.phase, "connected", r.error);
  return (await setHours(r.connection_id, inHours))!;
}

async function setHours(connectionId: string, inHours: boolean): Promise<Connection | undefined> {
  const conn = (await domain().getConnection(connectionId))!;
  return domain().updateConnection(connectionId, {
    config: {
      ...conn.config,
      tier: "premium",
      account_age_days: 365,
      // Seven hours before the working-hours offset lands the account's local clock at 03:00, which
      // is how pacing sees "not now" without anyone faking a verdict. (Weekends send now; the small
      // hours are the guard.)
      utc_offset: workingHoursOffset() + (inHours ? 0 : -7),
      engagement: undefined,
      pacing: {
        ...(conn.config.pacing as Record<string, unknown> | undefined),
        engagement: { sent: 200, accepted: 80, replied: 30, flagged: 0 },
      },
    },
  });
}

/** Warm up, then invite. The first two steps of the shipped sequence — the ones that used to park. */
const WARM_THEN_INVITE: SequenceStep[] = [
  { from: "queued", action: "view_profile", advance_to: "warmed" },
  { from: "warmed", action: "send_invite", advance_to: "invited", wait_days: 1, only_if: "!connected" },
];

async function anchoredCampaign(
  store: InMemoryStore,
  project: string,
  conn: Connection,
  seed: string,
): Promise<{ campaign: Campaign; approval_id: string }> {
  const iso = new Date().toISOString();
  const taskId = randomUUID();
  await store.createTask({
    id: taskId, project_id: project, wedge: gtmWedge(), task_type: "propose_campaign",
    actor: { kind: "user", id: "m" }, input: {}, constraints: { max_runtime_s: 60, max_cost_usd: 0, approval_required: true },
    tools: [], status: "awaiting_approval", cost_usd: 0, created_at: iso, updated_at: iso,
  });
  return proposeCampaign(store, domain(), {
    task_id: taskId,
    project_id: project,
    connection_id: conn.id,
    name: "Q3 founders",
    steps: WARM_THEN_INVITE,
    prospects: [{ profile_id: seed, name: "Dana Okafor" }],
  });
}

const pacingOf = async (id: string) =>
  (((await domain().getConnection(id))!.config.pacing ?? {}) as { used?: Record<string, number>; engagement?: Record<string, number> });

// ── the loop ─────────────────────────────────────────────────────────────────────────────────────

test("search → graph → enrol → paced → warm-up → invitation: the whole path a prospect takes", async () => {
  _resetUsage();
  const store = new InMemoryStore();
  const wire = mockVoyager();
  try {
    const project = "p-loop";
    // Out of hours to begin with, so the first tick is refused by pacing rather than by luck.
    const conn = await account(project, false);

    // ── 1. FIND. A read: no approval, no touch budget, and the rows it leaves are the point.
    const found = await findProspects(store, domain(), conn, {
      project_id: project,
      connection_id: conn.id,
      query: "VP Engineering",
      limit: 10,
    });
    assert.equal(found.ok, true, found.detail);
    assert.equal(found.found, 2);
    assert.equal(found.people_written, 2, "a search that leaves nothing in the graph is a demo");
    assert.deepEqual(found.people.map((p) => p.profile_id).sort(), ["dana-okafor", "rui-silva"]);
    assert.equal(found.people[0].company, "Acme", "the headline split filled the CRM's company column");
    assert.equal((await store.getTask(found.task_id))!.status, "succeeded");

    // The face wall is a STREAM, not a refetch: one `progress` event per person, in the shape
    // Cloud's `readStreamEvent` reads (`{ gtm: { person } }`), emitted while the task is still
    // running. Without these the wall stays empty for the whole search and only fills on refresh —
    // which was the state of it, because nothing emitted the contract the client was listening for.
    const events = await store.eventsAfter(found.task_id, 0);
    const streamed = events
      .filter((e) => e.type === "progress")
      .map((e) => ((e.data as any).gtm?.person?.key as string) ?? "");
    assert.deepEqual(streamed.sort(), ["dana-okafor", "rui-silva"]);
    assert.ok(
      events.every((e) => e.type !== "task.finished"),
      "faces stream while the run is still live — after task.finished the browser has closed the stream",
    );

    // The CRM reads exactly these rows. Keyed on the public identifier and on the registrable
    // domain — the two natural keys the whole graph design rests on.
    const people = await domain().queryRecords({ project_id: project, wedge: gtmWedge(), collection: PEOPLE_COLLECTION });
    assert.deepEqual(people.map((r) => r.key).sort(), ["dana-okafor", "rui-silva"]);
    const companies = await domain().queryRecords({ project_id: project, wedge: gtmWedge(), collection: COMPANY_COLLECTION });
    assert.deepEqual(companies.map((r) => r.key).sort(), ["acme.com", "brightlane.io"]);
    // Free, and the zero is the finding rather than a missing value.
    assert.equal(((people[0].data as any).provenance.search as any).cost_usd, 0);

    // Another tenant cannot see any of it. `queryRecords` fails closed on the project.
    assert.equal((await domain().queryRecords({ project_id: "p-someone-else", wedge: gtmWedge(), collection: PEOPLE_COLLECTION })).length, 0);

    // ── 2. ENROL. One case per prospect per campaign, hydrated from the graph.
    const { campaign, approval_id } = await anchoredCampaign(store, project, conn, "dana-okafor");
    const drafts = await prospectsFromGraph(domain(), project, found.people.map((p) => p.profile_id));
    assert.equal(drafts.length, 2);
    const enrolment = await enrolProspects(store, domain(), campaign, drafts);
    assert.equal(enrolment.enrolled, 2);

    // Running the same search and enrolling again finds the same people. Two cases for one person
    // in one campaign is two sequences pointed at them in parallel, from a real account.
    const again = await enrolProspects(store, domain(), campaign, drafts);
    assert.equal(again.enrolled, 0);
    assert.equal(again.already, 2);

    // ── 3. TICK, REFUSED. Approve first: consent is re-read from the store on every send.
    await store.setApproval(approval_id, "approved");
    const urlsBefore = wire.urls.length;
    const paced = await advanceSequences(store, domain(), { project_id: project });
    assert.equal(paced.paced, 2);
    assert.equal(paced.sent, 0);
    assert.equal(wire.urls.length, urlsBefore, "a paced case must never reach the wire");

    const parked = await domain().listCases({ project_id: project, wedge: gtmWedge() });
    for (const k of parked) {
      assert.equal(k.stage, "queued", "and it stays exactly where it was");
      assert.match(String((k.data as any).paused_reason), /working hours/);
      assert.ok(Date.parse(k.due_at!) > Date.now(), "the refusal wrote a retry time, not a dispatch");
    }

    // ── 4. TICK, IN HOURS. The warm-up view — a step the dispatcher used to call unsupported.
    await setHours(conn.id, true);
    for (const k of parked) await domain().updateCase(k.id, { due_at: new Date(Date.now() - 1000).toISOString() });
    const warmed = await advanceSequences(store, domain(), { project_id: project });
    assert.equal(warmed.sent, 2, "view_profile is wired now — it used to park as 'no executor yet'");
    assert.ok(wire.urls.some((u) => u.includes("/identity/profiles/dana-okafor/profileView")));

    const afterWarm = await domain().listCases({ project_id: project, wedge: gtmWedge() });
    assert.deepEqual(afterWarm.map((k) => k.stage).sort(), ["warmed", "warmed"]);

    // THE CONSTRAINT THIS FILE EXISTS FOR. Every successful action spends its declared touch, keyed
    // on the capability id so `touchFor` maps it. An action path that skips this reopens the bug
    // whose end state is a restricted account.
    assert.equal((await pacingOf(conn.id)).used?.profile_view, 2);
    // …and a view is not an invitation. The mapping is per capability, not per "it sent something".
    assert.equal((await pacingOf(conn.id)).used?.invite ?? 0, 0);

    // ── 5. TICK, INVITE. Past the one-day cadence floor between the view and the request.
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString();
    for (const k of afterWarm) {
      await domain().updateCase(k.id, {
        due_at: new Date(Date.now() - 1000).toISOString(),
        data: { ...(k.data as Record<string, unknown>), last_touch_at: twoDaysAgo },
      });
    }
    const invited = await advanceSequences(store, domain(), { project_id: project });
    assert.equal(invited.sent, 2, invited.note);
    assert.ok(wire.urls.some((u) => u.includes("/growth/normInvitations")));

    const afterInvite = await domain().listCases({ project_id: project, wedge: gtmWedge() });
    assert.deepEqual(afterInvite.map((k) => k.stage).sort(), ["invited", "invited"]);
    // LinkedIn hands the invitation id back once. Withdrawing is the only way to recover weekly
    // allowance and no endpoint would find this id again, so it is persisted at the moment it exists.
    assert.equal((afterInvite[0].data as any).invitation_id, "INV-9");
    assert.equal((afterInvite[0].data as any).shared_secret, "shhh");

    const pacing = await pacingOf(conn.id);
    assert.equal(pacing.used?.invite, 2, "the scarcest budget in the system decremented");
    // `engagement.sent` is the DENOMINATOR of the acceptance rate, so invitations count and views
    // do not — 200 seeded plus the two just sent.
    assert.equal(pacing.engagement?.sent, 202);

    // ── 6. AUDITABILITY. Autonomy stays inspectable: every auto-approved touch is a row in the same
    // queue a human-gated one lands in, naming the envelope that allowed it.
    const auto = await store.listApprovals("auto_approved");
    assert.equal(auto.length, 4, "two views and two invitations");
    assert.equal(auto.filter((a) => a.action === "linkedin:send_invite").length, 2);
    // send_invite is high risk, and it arrives at the gate declared as such rather than as a send.
    assert.ok(auto.filter((a) => a.action === "linkedin:send_invite").every((a) => a.risk === "high"));
    assert.ok(auto.every((a) => /approved by a human/.test(a.policy_reason ?? "")));
  } finally {
    _setFetch(null);
  }
});

// ── the named conditions ─────────────────────────────────────────────────────────────────────────

test("the Commercial Search Limit is a named, actionable condition — never a generic failure", async () => {
  const store = new InMemoryStore();
  // A 429 with no people is LinkedIn's monthly profile-search cap, not a rate limit that clears in a
  // minute. A founder who reads "search failed" retries forever; one who reads this makes a choice.
  _setFetch(async () => jsonResponse({ message: "commercial use limit" }, 429));
  try {
    const conn = await account("p-limit", true);
    const r = await findProspects(store, domain(), conn, {
      project_id: "p-limit",
      connection_id: conn.id,
      query: "VP Engineering",
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, "linkedin_commercial_search_limit");
    assert.match(r.detail, /Commercial Search Limit/);
    assert.match(r.detail, /retrying and waiting an hour will not help/);
    assert.equal((await store.getTask(r.task_id))!.status, "failed");
  } finally {
    _setFetch(null);
  }
});

test("a capped search falls back to the company People tab — the unmetered surface keeps prospects flowing", async () => {
  const store = new InMemoryStore();
  // Three branches: the metered people-search is capped (429); resolving the company slug returns a
  // company carrying its numeric org id; the company People tab (ORGANIZATIONS_PEOPLE_ALUMNI) returns
  // a real person. The fallback stitches these into a normal find.
  _setFetch(async (url: string) => {
    if (url.includes("ORGANIZATIONS_PEOPLE_ALUMNI")) {
      return jsonResponse({
        elements: [
          {
            title: { text: "Ada Lovelace" },
            navigationUrl: "https://www.linkedin.com/in/ada-lovelace",
            entityUrn: "urn:li:fsd_profile:ACoAAAda",
            primarySubtitle: { text: "Engineer at Stripe" },
          },
        ],
      });
    }
    if (url.includes("/organization/companies")) {
      return jsonResponse({
        elements: [
          { name: "Stripe", universalName: "stripe", entityUrn: "urn:li:fs_company:2135371", companyPageUrl: "https://stripe.com" },
        ],
      });
    }
    // The people SRP: LinkedIn's monthly cap.
    return jsonResponse({ message: "commercial use limit" }, 429);
  });
  try {
    const conn = await account("p-fallback", true);
    const r = await findProspects(store, domain(), conn, {
      project_id: "p-fallback",
      connection_id: conn.id,
      query: "engineer",
      company: "stripe",
    });
    assert.equal(r.ok, true, "the fallback rescued the find");
    assert.equal(r.found, 1);
    assert.equal(r.people[0]?.name, "Ada Lovelace");
    assert.equal(r.people_written, 1);
    assert.equal((await store.getTask(r.task_id))!.status, "succeeded");
  } finally {
    _setFetch(null);
  }
});

test("amplification expands found people's companies via the unmetered People tab, deduped", async () => {
  // The base keyword search succeeds and returns ONE person at Stripe. Amplification then reads the
  // company People tab for "Stripe" (unmetered) and gets back two people: the same person again (a
  // dedupe) and a genuinely new one. The new one must be appended; the dupe must not; and the new
  // one's write must count toward people_written.
  const store = new InMemoryStore();
  _setFetch(async (url: string) => {
    if (url.includes("ORGANIZATIONS_PEOPLE_ALUMNI")) {
      // The company People tab: the base person (dupe) plus one new colleague.
      return jsonResponse({
        elements: [
          {
            title: { text: "Ada Lovelace" },
            navigationUrl: "https://www.linkedin.com/in/ada-lovelace",
            entityUrn: "urn:li:fsd_profile:ACoAAAda",
            primarySubtitle: { text: "Engineer at Stripe" },
          },
          {
            title: { text: "Grace Hopper" },
            navigationUrl: "https://www.linkedin.com/in/grace-hopper",
            entityUrn: "urn:li:fsd_profile:ACoAAAgr",
            primarySubtitle: { text: "Compiler pioneer at Stripe" },
          },
        ],
      });
    }
    if (url.includes("/organization/companies")) {
      return jsonResponse({
        elements: [
          { name: "Stripe", universalName: "Stripe", entityUrn: "urn:li:fs_company:2135371", companyPageUrl: "https://stripe.com" },
        ],
      });
    }
    // The base people SRP — one hit, at a slug-like single-word company.
    return jsonResponse({
      elements: [
        {
          type: "SEARCH_HITS",
          elements: [
            {
              targetUrn: "urn:li:fsd_profile:ACoAAAda",
              title: { text: "Ada Lovelace" },
              primarySubtitle: { text: "Engineer at Stripe" },
              navigationUrl: "https://www.linkedin.com/in/ada-lovelace",
            },
          ],
        },
      ],
      paging: { total: 1 },
    });
  });
  try {
    const conn = await account("p-amplify", true);
    const r = await findProspects(store, domain(), conn, {
      project_id: "p-amplify",
      connection_id: conn.id,
      query: "engineer",
    });
    assert.equal(r.ok, true);
    assert.equal(r.found, 2, "the base hit plus the one NEW colleague from the company tab");
    const keys = r.people.map((p) => p.profile_id).sort();
    assert.deepEqual(keys, ["ada-lovelace", "grace-hopper"], "the dupe was not appended twice");
    assert.equal(r.people_written, 2, "the amplified colleague's write is counted, the dupe is not");
  } finally {
    _setFetch(null);
  }
});

test("amplification never reduces or breaks the base result when it can add nothing", async () => {
  // The base search succeeds; amplification tries to expand the company but every company read fails
  // (404). The base result must come back byte-for-byte — same people, same counts, still ok.
  const store = new InMemoryStore();
  _setFetch(async (url: string) => {
    if (url.includes("ORGANIZATIONS_PEOPLE_ALUMNI") || url.includes("/organization/companies")) {
      return jsonResponse({ message: "gone" }, 404);
    }
    return jsonResponse({
      elements: [
        {
          type: "SEARCH_HITS",
          elements: [
            {
              targetUrn: "urn:li:fsd_profile:ACoAAAda",
              title: { text: "Ada Lovelace" },
              primarySubtitle: { text: "Engineer at Stripe" },
              navigationUrl: "https://www.linkedin.com/in/ada-lovelace",
            },
          ],
        },
      ],
      paging: { total: 1 },
    });
  });
  try {
    const conn = await account("p-amplify-noop", true);
    const r = await findProspects(store, domain(), conn, {
      project_id: "p-amplify-noop",
      connection_id: conn.id,
      query: "engineer",
    });
    assert.equal(r.ok, true);
    assert.equal(r.found, 1, "amplification added nobody and subtracted nobody");
    assert.equal(r.people[0]?.name, "Ada Lovelace");
    assert.equal(r.people_written, 1);
    assert.equal((await store.getTask(r.task_id))!.status, "succeeded");
  } finally {
    _setFetch(null);
  }
});

test("a capped search with NO company named stays capped — the fallback needs a company to read", async () => {
  const store = new InMemoryStore();
  _setFetch(async () => jsonResponse({ message: "commercial use limit" }, 429));
  try {
    const conn = await account("p-nocompany", true);
    const r = await findProspects(store, domain(), conn, {
      project_id: "p-nocompany",
      connection_id: conn.id,
      query: "VP Engineering",
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, "linkedin_commercial_search_limit");
  } finally {
    _setFetch(null);
  }
});

test("a search cannot be run through another project's account, and writes nothing if tried", async () => {
  const store = new InMemoryStore();
  mockVoyager();
  try {
    const conn = await account("p-owner", true);
    const r = await findProspects(store, domain(), conn, {
      project_id: "p-intruder",
      connection_id: conn.id,
      query: "VP Engineering",
    });
    assert.equal(r.ok, false);
    assert.match(r.detail, /another project/);
    assert.equal((await domain().queryRecords({ project_id: "p-intruder", wedge: gtmWedge(), collection: PEOPLE_COLLECTION })).length, 0);
  } finally {
    _setFetch(null);
  }
});

// ── enrolment rules ──────────────────────────────────────────────────────────────────────────────

test("an approved campaign's prospect list cannot grow afterwards", async () => {
  const store = new InMemoryStore();
  mockVoyager();
  try {
    const conn = await account("p-consent", true);
    const { campaign, approval_id } = await anchoredCampaign(store, "p-consent", conn, "dana-okafor");
    // While pending, adding people is the normal path: find, enrol, then approve what you can see.
    const before = await enrolProspects(store, domain(), campaign, [{ profile_id: "rui-silva", name: "Rui" }]);
    assert.equal(before.enrolled, 1);

    await store.setApproval(approval_id, "approved");
    // The approval card said "1 prospect" and named them. A list that grows after the signature is a
    // different decision wearing the first one's consent.
    const after = await enrolProspects(store, domain(), campaign, [{ profile_id: "sam-two", name: "Sam" }]);
    assert.equal(after.enrolled, 0);
    assert.match(after.note!, /already approved/);
    assert.equal((await domain().listCases({ project_id: "p-consent", wedge: gtmWedge() })).length, 1);
  } finally {
    _setFetch(null);
  }
});

test("a prospect with no public identifier is refused rather than filed as an unactionable case", async () => {
  const store = new InMemoryStore();
  mockVoyager();
  try {
    const conn = await account("p-key", true);
    const { campaign } = await anchoredCampaign(store, "p-key", conn, "dana-okafor");
    const r = await enrolProspects(store, domain(), campaign, [{ profile_id: "  ", name: "Nobody" }]);
    assert.equal(r.enrolled, 0);
    assert.equal(r.unkeyable, 1);
    // Every LinkedIn capability addresses a person by their public identifier. A case without one
    // parks for ever and looks like a bug in the founder's pipeline.
    assert.equal((await domain().listCases({ project_id: "p-key", wedge: gtmWedge() })).length, 0);
  } finally {
    _setFetch(null);
  }
});

// ── the executor table ───────────────────────────────────────────────────────────────────────────

test("the dispatcher and the executor table cannot disagree about what is wired", () => {
  // The regression this guards: `sequence.ts` decided support with a literal `action ===
  // "send_message"` while three more executors existed, so the shipped sequence parked at step one.
  for (const wired of ["send_message", "send_invite", "view_profile", "withdraw_invite", "search_people", "get_profile", "get_company"]) {
    assert.equal(hasLinkedInExecutor(wired), true, `${wired} has an executor and must be dispatchable`);
  }
  // Declared in capabilities.ts, deliberately not built. Public and permanent under the founder's
  // name — a machine should not be writing those, and an unbuilt capability must not fall through
  // to "send a DM", which is what the LinkedIn branch used to do with any capability it was given.
  for (const unwired of [
    "comment_on_post",
    "create_post",
    "endorse_skill",
    "send_inmail",
    "accept_invite",
    "reply_to_comment",
    "invent_a_capability",
  ]) {
    assert.equal(hasLinkedInExecutor(unwired), false, `${unwired} must not be dispatchable`);
  }
  // Warm-up engagement is dispatchable (an explicit action can reach it) but disarmed behind the
  // MYCEL_LINKEDIN_WARMUP kill-switch and kept out of every sequence — see engage.ts / verbs.ts.
  for (const gated of ["follow_person", "react_to_post"]) {
    assert.equal(hasLinkedInExecutor(gated), true, `${gated} is dispatchable but gated`);
    assert.equal(SEQUENCE_LIVE_SET.has(gated), false, `${gated} must never be a sequence verb`);
  }
});
