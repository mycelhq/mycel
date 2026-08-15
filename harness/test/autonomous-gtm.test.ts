// The AUTONOMOUS GTM loop: discover → propose, on a schedule, with the founder only approving.
//
// The loop composes pieces that each have their own tests (findProspects, proposeCampaign, the
// scheduler's Cadence/claim model). What is proved HERE is the composition and its safety rails:
//
//   · a fire runs find → propose and lands ONE pending approval — nothing sent, nothing approved;
//   · it is IDEMPOTENT: a double-fire inside one cadence window raises no second proposal;
//   · a disabled or empty audience is a clean no-op;
//   · enabling the audience wires exactly one recurring schedule and disabling removes it.
//
// Discovery is INJECTED so the loop runs offline — the FullEnrich transport is not what this file is
// about. `FULLENRICH_API_KEY` is set so the loop's own "is discovery even allowed unattended" gate
// passes; the injected `discover` then stands in for the network.
import { test } from "node:test";
import assert from "node:assert/strict";
process.env.FULLENRICH_API_KEY = process.env.FULLENRICH_API_KEY || "test-key";
import { InMemoryStore } from "../src/store";
import { getDomainStore } from "../src/domain";
import { initSecretStore } from "../src/secrets";
import type { Connection } from "../src/contract";
import { gtmWedge } from "../src/gtm/stages";
import type { FindProspectsResult, FoundPerson } from "../src/gtm/prospects";
import {
  bucketKey,
  ensureAudienceSchedule,
  loadAudience,
  removeAudienceSchedule,
  runAutonomousGtm,
  saveAudience,
  AUTONOMOUS_GTM_TASK_TYPE,
  DEFAULT_AUDIENCE_CADENCE,
} from "../src/gtm/autonomous";

await initSecretStore();
const domain = () => getDomainStore();

async function linkedinAccount(project: string): Promise<Connection> {
  return domain().createConnection({
    project_id: project,
    kind: "linkedin",
    name: "founder LinkedIn",
    owner: { kind: "founder", id: "founder" },
    config: {},
  });
}

/** A discovery seam returning a fixed set of people, and counting how many times it was called. */
function stubDiscover(people: FoundPerson[]): {
  fn: (conn: Connection, input: unknown) => Promise<FindProspectsResult>;
  calls: number;
} {
  const box = { calls: 0 };
  const fn = async (): Promise<FindProspectsResult> => {
    box.calls++;
    return {
      ok: true,
      task_id: "find-task",
      found: people.length,
      people,
      people_written: people.length,
      companies_written: 0,
      detail: `found ${people.length}`,
    };
  };
  return {
    get calls() {
      return box.calls;
    },
    fn,
  } as { fn: (conn: Connection, input: unknown) => Promise<FindProspectsResult>; calls: number };
}

const PEOPLE: FoundPerson[] = [
  { profile_id: "dana-okafor", name: "Dana Okafor", title: "VP Engineering", company: "Acme" },
  { profile_id: "rui-silva", name: "Rui Silva", title: "CTO", company: "Brightlane" },
];

// draft is injected too so no model is called; a fixed opener stands in.
const draft = async () => "Saw you lead engineering at a fast-moving team — curious how you hire.";

test("a fire runs find → propose and lands ONE pending approval; nothing is sent", async () => {
  const store = new InMemoryStore();
  const project = "p-auto-1";
  const conn = await linkedinAccount(project);
  await saveAudience(domain(), project, {
    enabled: true,
    filters: { titles: ["VP Engineering", "CTO"], location: "United States" },
    cadence: DEFAULT_AUDIENCE_CADENCE,
    connection_id: conn.id,
  });

  const disc = stubDiscover(PEOPLE);
  const r = await runAutonomousGtm({ store, domain: domain(), project_id: project, discover: disc.fn, draft });

  assert.equal(r.idle, false, r.reason);
  assert.equal(r.found, 2);
  assert.equal(r.proposed, 2);
  assert.ok(r.campaign_id && r.approval_id);

  // The proposal task exists and is awaiting a human — the loop proposed, it did not decide.
  const task = await store.getTask((await store.listTasks({ wedge: gtmWedge(), limit: 50 })).find((t) => t.task_type === "propose_campaign")!.id);
  assert.equal(task!.status, "awaiting_approval");
  const approval = await store.getApproval(r.approval_id!);
  assert.equal(approval!.status, "pending", "NOTHING sends without the founder approving");

  // The fresh prospects became cases at stage queued — real work for the sequencer once approved.
  const cases = await domain().listCases({ project_id: project, wedge: gtmWedge() });
  assert.equal(cases.length, 2);
  assert.ok(cases.every((k) => k.stage === "queued"));

  // The founder-facing feed event: "found N, proposed a campaign".
  const events = await store.eventsAfter(task!.id, 0);
  const feed = events.map((e) => (e.data as any)?.gtm?.autonomous).find(Boolean);
  assert.equal(feed.proposed, 2);
  assert.equal(feed.campaign_id, r.campaign_id);
});

test("idempotent: a double-fire in the same cadence window raises no second proposal", async () => {
  const store = new InMemoryStore();
  const project = "p-auto-2";
  const conn = await linkedinAccount(project);
  await saveAudience(domain(), project, {
    enabled: true,
    filters: { titles: ["VP Engineering"] },
    cadence: DEFAULT_AUDIENCE_CADENCE,
    connection_id: conn.id,
  });
  const now = new Date();

  const disc = stubDiscover(PEOPLE);
  const first = await runAutonomousGtm({ store, domain: domain(), project_id: project, discover: disc.fn, draft, now });
  assert.equal(first.idle, false);
  assert.equal(disc.calls, 1);

  // Same window → the bucket is already consumed, so the second fire is a no-op that never even
  // reaches discovery. Two proposals for one batch is two campaigns wearing one consent.
  const second = await runAutonomousGtm({ store, domain: domain(), project_id: project, discover: disc.fn, draft, now });
  assert.equal(second.idle, true, second.reason);
  assert.match(second.reason, /already ran this cadence window/);
  assert.equal(disc.calls, 1, "discovery was not re-run in the same window");

  const proposals = (await store.listTasks({ wedge: gtmWedge(), limit: 50 })).filter((t) => t.task_type === "propose_campaign");
  assert.equal(proposals.length, 1, "exactly one proposal for the window");

  // A LATER window (bucket advances) proposes again — but only genuinely new people, and these two
  // are now enrolled, so it finds nobody new and stays a clean no-op.
  const laterNow = new Date(now.getTime() + DEFAULT_AUDIENCE_CADENCE.seconds * 2 * 1000);
  assert.notEqual(bucketKey(DEFAULT_AUDIENCE_CADENCE, laterNow), bucketKey(DEFAULT_AUDIENCE_CADENCE, now));
  const later = await runAutonomousGtm({ store, domain: domain(), project_id: project, discover: disc.fn, draft, now: laterNow });
  assert.equal(later.idle, true);
  assert.match(later.reason, /nobody new/);
});

test("a disabled or unset audience is a clean no-op — no discovery, no proposal", async () => {
  const store = new InMemoryStore();
  const project = "p-auto-3";
  await linkedinAccount(project);

  // Unset audience.
  const disc = stubDiscover(PEOPLE);
  const unset = await runAutonomousGtm({ store, domain: domain(), project_id: project, discover: disc.fn, draft });
  assert.equal(unset.idle, true);
  assert.equal(disc.calls, 0, "an unset audience never reaches discovery");

  // Disabled audience.
  await saveAudience(domain(), project, { enabled: false, filters: { titles: ["CTO"] } });
  const disabled = await runAutonomousGtm({ store, domain: domain(), project_id: project, discover: disc.fn, draft });
  assert.equal(disabled.idle, true);
  assert.equal(disc.calls, 0);

  // Enabled but empty filters is also a no-op — an empty search is a bug, not an operation.
  await saveAudience(domain(), project, { enabled: true, filters: {} });
  const empty = await runAutonomousGtm({ store, domain: domain(), project_id: project, discover: disc.fn, draft });
  assert.equal(empty.idle, true);
  assert.match(empty.reason, /no filters/);
  assert.equal(disc.calls, 0);

  assert.equal((await store.listTasks({ wedge: gtmWedge(), limit: 50 })).filter((t) => t.task_type === "propose_campaign").length, 0);
});

test("enabling wires exactly one recurring schedule; disabling removes it", async () => {
  const project = "p-auto-4";
  await ensureAudienceSchedule(domain(), project, DEFAULT_AUDIENCE_CADENCE);
  // Idempotent — a second enable re-points the same schedule, it does not create a second timer.
  await ensureAudienceSchedule(domain(), project, { kind: "daily", hour: 9, minute: 0 });
  let mine = (await domain().listSchedules()).filter((s) => s.project_id === project && s.task_type === AUTONOMOUS_GTM_TASK_TYPE);
  assert.equal(mine.length, 1, "one audience, one schedule");
  assert.equal(mine[0].enabled, true);
  assert.deepEqual(mine[0].cadence, { kind: "daily", hour: 9, minute: 0 }, "cadence was re-pointed");

  await removeAudienceSchedule(domain(), project);
  mine = (await domain().listSchedules()).filter((s) => s.project_id === project && s.task_type === AUTONOMOUS_GTM_TASK_TYPE);
  assert.equal(mine.length, 0, "disabling removes the timer");
});

test("a discovery hiccup skips the tick and never consumes the window", async () => {
  const store = new InMemoryStore();
  const project = "p-auto-5";
  const conn = await linkedinAccount(project);
  await saveAudience(domain(), project, {
    enabled: true,
    filters: { titles: ["VP Engineering"] },
    cadence: DEFAULT_AUDIENCE_CADENCE,
    connection_id: conn.id,
  });
  const now = new Date();

  // First fire: discovery throws. The loop must soft-skip, not throw, and must NOT consume the bucket.
  const boom = await runAutonomousGtm({
    store,
    domain: domain(),
    project_id: project,
    now,
    discover: async () => {
      throw new Error("proxy unreachable");
    },
    draft,
  });
  assert.equal(boom.idle, true);
  assert.match(boom.reason, /discovery error/);
  assert.equal((await loadAudience(domain(), project))!.last_bucket, undefined, "a skipped tick leaves the window open");

  // The next fire in the SAME window succeeds — because the hiccup never claimed the bucket.
  const disc = stubDiscover(PEOPLE);
  const ok = await runAutonomousGtm({ store, domain: domain(), project_id: project, discover: disc.fn, draft, now });
  assert.equal(ok.idle, false, ok.reason);
  assert.equal(ok.proposed, 2);
});
