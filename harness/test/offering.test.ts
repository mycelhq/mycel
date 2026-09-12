// What the business SELLS — plural — and the evidence we already had for it.
//
// `research_service` returns `deliverables[]`: the nouns a client receives, each with a cadence, an
// hours estimate and a URL a run actually opened. Production's one research record holds eight of
// them. They were written to a record, handed to the drafting run, and exposed on no route, so the
// founder was asked "what do you sell", we went and found the real answer, and then never mentioned
// it — while onboarding's header went on saying "Your service", singular.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { api, makeFreshApp } from "./helpers";
import { getDomainStore } from "../src/domain";
import {
  keepServiceResearch,
  setArsenalDeps,
  spawnDraftAfterResearch,
  spawnLearningResearch,
} from "../src/skill-arsenal";
import {
  OFFERING_COLLECTION,
  draftServiceInput,
  normalizeItems,
  offeringLine,
  readOffering,
  researchedDeliverables,
  saveOffering,
} from "../src/offering";

const src = (rel: string) => readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), "utf8");

/** The eight-deliverable shape, trimmed. Real text, because the rules here are about real text. */
const RESEARCH = {
  reached: true,
  deliverables: [
    { what: "Initial AI search visibility audit", typical_hours: "4", source: "https://example.test/a" },
    { what: "Answer-engine visibility report", cadence: "Weekly or monthly", source: "https://example.test/b" },
    { what: "Citation and source-gap analysis", typical_hours: 3, source: "https://example.test/c" },
  ],
};

test("offering: the deliverables the research found are readable, which they were not", async () => {
  const { app } = await makeFreshApp();
  const projectId = (await api(app, "me")).json.projects[0].id as string;
  const domain = getDomainStore();
  await keepServiceResearch(domain, { project_id: projectId, output: RESEARCH });

  const found = await researchedDeliverables(domain, projectId);
  assert.equal(found.length, 3);
  assert.equal(found[0]!.what, "Initial AI search visibility audit");
  // A model may write hours as a string. Parsed, because "4h" is what tells a founder this row is a
  // real piece of work rather than a checkbox.
  assert.equal(found[0]!.typical_hours, 4);
  assert.equal(found[1]!.cadence, "Weekly or monthly");
  assert.equal(found[2]!.typical_hours, 3);
});

test("offering: hours that cannot be true are dropped rather than shown", async () => {
  const { app } = await makeFreshApp();
  const projectId = (await api(app, "me")).json.projects[0].id as string;
  const domain = getDomainStore();
  await keepServiceResearch(domain, {
    project_id: projectId,
    output: {
      reached: true,
      deliverables: [
        { what: "Free thing", typical_hours: 0 },
        { what: "Endless thing", typical_hours: 5000 },
        { what: "Unparseable thing", typical_hours: "about a day" },
      ],
    },
  });
  const found = await researchedDeliverables(domain, projectId);
  // Absent beats wrong. A confident "0 hours" next to a deliverable is worse than saying nothing,
  // because a founder reads it as a claim we are making about their work.
  for (const d of found) assert.equal(d.typical_hours, undefined);
});

test("offering: the same deliverable twice is shown once", async () => {
  const { app } = await makeFreshApp();
  const projectId = (await api(app, "me")).json.projects[0].id as string;
  const domain = getDomainStore();
  await keepServiceResearch(domain, {
    project_id: projectId,
    output: {
      reached: true,
      deliverables: [
        { what: "Monthly SEO report" },
        { what: "monthly  SEO   report!" },
        { what: "Technical audit" },
      ],
    },
  });
  const found = await researchedDeliverables(domain, projectId);
  assert.equal(found.length, 2, "a list that shows one thing twice reads as a product that cannot count");
});

test("offering: unticking actually unticks — saving twice replaces, it does not accumulate", async () => {
  // TWO PROPERTIES, and the second is the one that needed finding.
  //
  // The read is safe either way — `queryRecords` sorts newest-first — so an untick shows up
  // correctly even on a broken write. What is NOT safe is the write: `upsertRecord`'s conflict key
  // is `(project_id, wedge, collection, key, observed_at)`, so passing a fresh timestamp makes
  // every save a new ROW rather than an update. This list is re-ticked, unlike the research record
  // that shares the shape, so that is one row per edit forever behind a `limit 200` read — and the
  // day the two-hundred-and-first arrives the answer silently becomes unreachable.
  //
  // So the row count is asserted, not just the value. Asserting only the value passes on the bug.
  const { app } = await makeFreshApp();
  const projectId = (await api(app, "me")).json.projects[0].id as string;
  const domain = getDomainStore();

  /**
   * EXPLICIT, DISTINCT TIMESTAMPS, and without them this test passes on a broken implementation.
   *
   * Two `saveOffering` calls in a row execute inside the same millisecond, so a default
   * `new Date().toISOString()` produces the SAME string twice — which collapses the very conflict
   * key the bug depends on, and the write updates in place no matter how `observed_at` is handled.
   * Restoring the bug and watching this stay green is how that was found. A real founder ticks,
   * reads, and unticks a minute later.
   */
  await saveOffering(domain, {
    project_id: projectId,
    at: "2026-09-07T10:00:00.000Z",
    items: [{ what: "Monthly report", from: "research" }, { what: "Quarterly review", from: "research" }],
  });
  await saveOffering(domain, {
    project_id: projectId,
    at: "2026-09-07T10:01:00.000Z",
    items: [{ what: "Monthly report", from: "research" }],
  });

  const back = await readOffering(domain, projectId);
  assert.equal(back?.items.length, 1, "the unticked deliverable came back");
  assert.equal(back?.items[0]!.what, "Monthly report");

  const rows = await domain.queryRecords({ project_id: projectId, wedge: "kernel", collection: OFFERING_COLLECTION });
  assert.equal(rows.length, 1, "each save wrote a new row instead of replacing the one answer");

  // And "none of these" is a real answer that must persist, or the screen re-asks a question the
  // founder has already answered.
  await saveOffering(domain, { project_id: projectId, at: "2026-09-07T10:02:00.000Z", items: [] });
  const empty = await readOffering(domain, projectId);
  assert.deepEqual(empty?.items, []);
});

test("offering: a deliverable the founder typed is marked as theirs, not as ours", () => {
  const items = normalizeItems([
    { what: "Answer-engine report", from: "research" },
    { what: "Expert-witness statements", from: "founder" },
    { what: "  ", from: "founder" },
    { what: "Answer-engine  report", from: "founder" },
  ]);
  assert.equal(items.length, 2, "blank and duplicate rows are dropped");
  // The one nobody found on the open web is the one worth asking more about, so the provenance is
  // kept rather than flattened.
  assert.equal(items[1]!.from, "founder");
  assert.equal(items[0]!.from, "research");
});

test("offering: the round trip works over HTTP, both halves in one response", async () => {
  const { app } = await makeFreshApp();
  const projectId = (await api(app, "me")).json.projects[0].id as string;
  await keepServiceResearch(getDomainStore(), { project_id: projectId, output: RESEARCH });

  const before = await api(app, "services/offering", { headers: { "X-Mycel-Project": projectId } });
  assert.equal(before.status, 200);
  assert.equal(before.json.researched.length, 3);
  // Never `undefined`: a panel cannot tell "not answered" from "the field is missing", and the one
  // that guesses draws an empty checklist over an answer the founder already gave.
  assert.equal(before.json.offering, null);

  const saved = await api(app, "services/offering", {
    method: "POST",
    headers: { "X-Mycel-Project": projectId },
    body: JSON.stringify({ items: [{ what: "Citation and source-gap analysis", typical_hours: 3, from: "research" }] }),
  });
  assert.equal(saved.status, 200);

  const after = await api(app, "services/offering", { headers: { "X-Mycel-Project": projectId } });
  assert.equal(after.json.offering.items.length, 1);
  assert.equal(after.json.offering.items[0].typical_hours, 3);
  // Both halves, because neither renders alone: the picks with no research have no provenance, and
  // the research with no picks cannot draw a checked box.
  assert.equal(after.json.researched.length, 3);
});

test("offering: what the founder confirmed reaches the run that writes their service", async () => {
  // The point of the whole feature. A drafter given only the research writes the AVERAGE firm's
  // service — the one the web describes — so a founder who does two of eight gets six jobs they
  // have never sold.
  const { app } = await makeFreshApp();
  const projectId = (await api(app, "me")).json.projects[0].id as string;
  const domain = getDomainStore();
  await keepServiceResearch(domain, { project_id: projectId, output: RESEARCH });
  await saveOffering(domain, {
    project_id: projectId,
    items: [
      { what: "Citation and source-gap analysis", typical_hours: 3, from: "research" },
      { what: "Expert-witness statements", cadence: "ad hoc", from: "founder" },
    ],
  });

  const input = await draftServiceInput(domain, { input: { description: "GEO for law firms" }, project_id: projectId });
  const line = String(input.offering ?? "");
  assert.match(line, /Citation and source-gap analysis \(3h\)/);
  assert.match(line, /Expert-witness statements \(ad hoc\)/);
  // Kept apart from the research, because "the web says the trade does this" and "I do this" are
  // different claims and a drafter that merges them writes somebody else's business.
  assert.ok(input.research, "the research is still there");
  assert.notEqual(JSON.stringify(input.research), line);
});

test("offering: no answer changes nothing — this is additive to every existing draft run", async () => {
  const { app } = await makeFreshApp();
  const projectId = (await api(app, "me")).json.projects[0].id as string;
  const input = await draftServiceInput(getDomainStore(), { input: { description: "x" }, project_id: projectId });
  assert.equal(input.offering, undefined);
  assert.ok(Array.isArray(input.capabilities), "the rest of the arsenal is untouched");
});

test("offering: an empty offering states nothing rather than stating emptiness", () => {
  assert.equal(offeringLine({ items: [], at: "" }), undefined);
  assert.equal(offeringLine(undefined), undefined);
});

test("offering: runtime hands draft_service its offering, not just the arsenal", () => {
  // A CALL-SITE TEST, and the reason is on the shelf next to it. `arsenal-reaches-delivery.test.ts`
  // exists because a previous version of exactly this wiring was proven only by tests that called
  // the helper directly — the helper worked, nothing called it, and the tests were green throughout.
  const runtime = src("runtime.ts");
  assert.match(runtime, /draftServiceInput\(getDomainStore\(\), task\)/);
  assert.ok(
    !/withDraftServiceArsenal\(task\.input/.test(runtime),
    "the arsenal is composed inside draftServiceInput now — two paths means one of them drops the offering",
  );
});

// ── going and looking, for everyone ──────────────────────────────────────────────────────────────

test("offering: a covered trade is researched too — one record in production is the bug", async () => {
  // `research_service` was reachable from a single button, on a home-page panel, shown only when
  // NOTHING installed covered the trade. Production holds exactly one research record as a result,
  // and it is not because the job is unreliable: that run took 1.4 minutes and cost 1.3 cents.
  // Matching a firm to one installed service says nothing about the other six things they sell.
  const spawned: Record<string, unknown>[] = [];
  setArsenalDeps({
    listTasks: async () => [],
    spawnTask: async (a) => {
      spawned.push(a);
      return "task-1";
    },
  });
  try {
    const id = await spawnLearningResearch({
      task: { project_id: "p1", wedge: "business-shaper", task_type: "draft_shape", input: { description: "d" } },
      sells: "Bookkeeping for UK e-commerce shops",
    });
    assert.ok(id);
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0]!.task_type, "research_service");
    assert.equal((spawned[0]!.input as Record<string, unknown>).sells, "Bookkeeping for UK e-commerce shops");
    // The flag that stops it writing a second service over a tested one.
    assert.equal((spawned[0]!.input as Record<string, unknown>).learn_only, true);
  } finally {
    setArsenalDeps(null);
  }
});

test("offering: learning about a trade never writes a service over one that already works", async () => {
  // Without this, running research for a COVERED trade queues a draft against a business already
  // served — offering the founder a choice between our tested code and something written ninety
  // seconds ago, which is a worse product dressed as more of one.
  const spawned: Record<string, unknown>[] = [];
  setArsenalDeps({
    listTasks: async () => [],
    spawnTask: async (a) => {
      spawned.push(a);
      return "task-1";
    },
  });
  try {
    const id = await spawnDraftAfterResearch({
      task: { project_id: "p1", wedge: "business-shaper", task_type: "research_service", input: { learn_only: true } },
    });
    assert.equal(id, undefined);
    assert.equal(spawned.length, 0, "a learning run wrote a service nobody asked for");

    // And the original path is untouched: research started BY the write button still writes.
    const wrote = await spawnDraftAfterResearch({
      task: { project_id: "p1", wedge: "business-shaper", task_type: "research_service", input: { sells: "x" } },
    });
    assert.ok(wrote, "the uncovered-trade chain stopped working");
    assert.equal(spawned[0]!.task_type, "draft_service");
  } finally {
    setArsenalDeps(null);
  }
});

test("offering: a founder who re-describes their business does not buy a second browser run", async () => {
  // Re-describing is a normal thing to do in the first ten minutes and each attempt ends in another
  // `draft_shape`. Every status counts, failed included — production already has one research run
  // that hung for 38.9 minutes, and automatic retries are how one bad run becomes six.
  for (const status of ["queued", "running", "succeeded", "failed"]) {
    const spawned: unknown[] = [];
    setArsenalDeps({
      listTasks: async () => [{ project_id: "p1", task_type: "research_service", status }],
      spawnTask: async (a) => {
        spawned.push(a);
        return "task-2";
      },
    });
    try {
      const id = await spawnLearningResearch({
        task: { project_id: "p1", wedge: "business-shaper", task_type: "draft_shape", input: {} },
        sells: "Bookkeeping",
      });
      assert.equal(id, undefined, `a second research run was queued after a ${status} one`);
      assert.equal(spawned.length, 0);
    } finally {
      setArsenalDeps(null);
    }
  }
});

test("offering: a shape with no trade in it starts nothing — there is nothing to look up", async () => {
  const spawned: unknown[] = [];
  setArsenalDeps({ listTasks: async () => [], spawnTask: async (a) => { spawned.push(a); return "t"; } });
  try {
    assert.equal(
      await spawnLearningResearch({
        task: { project_id: "p1", wedge: "business-shaper", task_type: "draft_shape", input: {} },
        sells: "   ",
      }),
      undefined,
    );
    assert.equal(spawned.length, 0, "a browser run was paid for with no search term");
  } finally {
    setArsenalDeps(null);
  }
});

test("offering: the orchestrator starts the research when a shape lands", () => {
  // A CALL-SITE TEST. The function this exercises is exactly the kind that gets written, tested
  // through its own unit tests, and wired to nothing — which is how production ended up with one
  // research record while every piece of the machinery worked perfectly.
  const orch = src("orchestrator.ts");
  assert.match(orch, /task\.task_type === DRAFT_SHAPE_TASK_TYPE/);
  assert.match(orch, /spawnLearningResearch\(\{ task, sells \}\)/);
});
