/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * A CLIENT WITH NO ENGAGEMENT IS AN ACCOUNT THAT NEVER STARTS
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `clients.routes.ts` calls `openEngagementForNewClient` when a client is added. That call is a
 * ONE-SHOT wrapped in a `.catch` that logs, and every reason it can decline is transient or was true
 * only at that instant: the shaping run had not landed, the artifact backend blipped, the wedge was
 * not installed yet. Nothing ever asks again.
 *
 * MEASURED IN PRODUCTION, 13 September: thirteen clients across four businesses with no engagement,
 * the oldest added on 16 August — including every signup in the last thirty days that got as far as
 * adding a client. Traced on one of them: Meridian Growth Studio shaped at 20:55, added the client
 * "Kestrel Analytics" at 20:57, and four days later had 1 client, 0 engagements, 0 deliverables and
 * no run of any kind since the shaping.
 *
 * The gap could not be closed inside `fulfillment-ignite`, which is the sweep that STARTS
 * production: `upkeep.ts` arms it on "at least one open engagement is on a wedge that produces a
 * deliverable". It only runs for a project that already has the thing these accounts lack. The two
 * sweeps are one step apart and the gap between them is where a new customer's first month goes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getDomainStore } from "../src/domain";
import { sweepStrandedClients, ensureEngagementSchedule, OPEN_ENGAGEMENTS_TASK_TYPE } from "../src/engagement-sweep";

/**
 * The sweep's only real dependency is the decision it delegates, so it is INJECTED rather than
 * module-mocked. The first version of this file used `t.mock.method` on the module's export and got
 * "Cannot redefine property" from every test — an ES export is not writable, and a sweep that can
 * only be tested by standing up the whole engagement stack would not be tested.
 */
function spyOpen() {
  const calls: string[] = [];
  return { calls, impl: async (_p: string, c: { id: string }) => (calls.push(c.id), `case-${c.id}`) };
}

async function seed(n: number, opts: { engaged?: number } = {}) {
  const project = `p-${randomUUID()}`;
  const domain = getDomainStore();
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const c = await domain.createClient({ project_id: project, display_name: `Client ${i}`, handles: [] } as never);
    ids.push(c.id);
  }
  for (let i = 0; i < (opts.engaged ?? 0); i++) {
    await domain.createCase({
      project_id: project, wedge: "geo-monitor", title: `Client ${i}`, client_id: ids[i], stage: "open", status: "open",
    });
  }
  return { project, domain, ids };
}

test("A STRANDED CLIENT GETS ITS ENGAGEMENT ON A LATER SWEEP", async () => {
  const { project, domain, ids } = await seed(2);
  const spy = spyOpen();
  const out = await sweepStrandedClients({ domain, store: {} as never, project_id: project, open: spy.impl });
  assert.equal(out.stranded, 2, "both clients should be stranded");
  assert.equal(out.opened, 2);
  assert.deepEqual(spy.calls.sort(), ids.sort(), "the sweep skipped a client with no engagement");
});

test("a client that already has an engagement is left alone", async () => {
  const { project, domain, ids } = await seed(3, { engaged: 2 });
  const spy = spyOpen();
  const out = await sweepStrandedClients({ domain, store: {} as never, project_id: project, open: spy.impl });
  assert.equal(out.stranded, 1, "an engaged client was counted as stranded");
  assert.deepEqual(spy.calls, [ids[2]], "the sweep reopened work for a client that already had some");
});

test("A BUSINESS WHOSE SERVICE CANNOT BE RESOLVED IS DECLINED, NOT GUESSED", async () => {
  /**
   * The decision belongs to `openEngagementForNewClient` and stays there — it refuses when the
   * business runs two producing services, because whose letterhead the work goes out under is not
   * ours to guess. Verified against production: of four businesses with stranded clients, two
   * resolve (an AI-visibility firm and Meridian, both `geo-monitor`) and two correctly decline —
   * a Texas payroll and contractor-compliance firm the catalogue does not cover, and one with no
   * shape at all. Re-deciding here would be a second implementation of that rule, and the two drift.
   */
  const { project, domain } = await seed(2);
  const out = await sweepStrandedClients({
    domain, store: {} as never, project_id: project, open: async () => undefined,
  });
  assert.equal(out.stranded, 2);
  assert.equal(out.opened, 0, "the sweep opened an engagement the decision declined");
  assert.equal(out.no_service, 2, "a decline is not reported, so it looks like health");
});

test("ONE CLIENT'S FAILURE DOES NOT STOP THE OTHERS", async () => {
  // Each open sends intake questions to a real person. A misconfigured mailbox on one client must
  // not cost the other four their first month — which is the whole point of this module.
  const { project, domain } = await seed(3);
  let n = 0;
  const out = await sweepStrandedClients({
    domain, store: {} as never, project_id: project,
    open: async (_p, c) => {
      if (++n === 1) throw new Error("mailbox not connected");
      return `case-${c.id}`;
    },
  });
  assert.equal(out.opened, 2, "a single failure stopped the sweep");
  assert.equal(out.failed.length, 1);
  assert.match(out.failed[0]!, /mailbox not connected/, "the failure is recorded without its reason");
});

test("a paste of forty clients does not fire forty kickoffs in one minute", async () => {
  /**
   * Each open sends intake questions to a real person, and forty emails leaving together is how a
   * domain gets burned. They open over the following sweeps instead — OLDEST FIRST, which is both
   * the order a founder would pick and the order that makes the wait bounded rather than arbitrary.
   */
  const { project, domain, ids } = await seed(12);
  const spy = spyOpen();
  const out = await sweepStrandedClients({ domain, store: {} as never, project_id: project, open: spy.impl });
  assert.equal(out.stranded, 12, "the summary hides how many are still waiting");
  assert.ok(out.opened <= 5, `one sweep opened ${out.opened} engagements at once`);
  assert.deepEqual(spy.calls, ids.slice(0, out.opened), "the sweep did not take the oldest clients first");
});

test("a project with no clients does nothing at all", async () => {
  const project = `p-${randomUUID()}`;
  const out = await sweepStrandedClients({ domain: getDomainStore(), store: {} as never, project_id: project });
  assert.deepEqual(out, { project_id: project, stranded: 0, opened: 0, no_service: 0, failed: [] });
});

test("the schedule is idempotent — one per project, reused after", async () => {
  const project = `p-${randomUUID()}`;
  const domain = getDomainStore();
  const a = await ensureEngagementSchedule(domain, project, "payments");
  const b = await ensureEngagementSchedule(domain, project, "payments");
  assert.equal(a.id, b.id, "a second upkeep created a second schedule");
  assert.equal(a.task_type, OPEN_ENGAGEMENTS_TASK_TYPE);
  assert.equal(
    (await domain.listSchedules()).filter((s) => s.project_id === project).length,
    1,
    "the project collected duplicate schedules",
  );
});

test("IT IS ARMED ON CLIENTS, NOT ON ENGAGEMENTS", async () => {
  const { readFileSync } = await import("node:fs");
  const upkeep = readFileSync(new URL("../src/upkeep.ts", import.meta.url).pathname, "utf8");
  /**
   * The circular dependency this whole module exists to break. Arming on `does_fulfillment` — "at
   * least one open engagement is on a wedge that produces a deliverable" — would mean the sweep that
   * opens a missing engagement only runs for projects that already have one.
   */
  /*
    The `consider` block, NOT the first mention — which is the import, four hundred lines above the
    thing being asserted. The first version of this anchored on `indexOf` and read a window of the
    import statement, so it failed against correct code.
  */
  const at = upkeep.indexOf("task_type: OPEN_ENGAGEMENTS_TASK_TYPE");
  assert.ok(at > 0, "the engagement sweep is not armed by upkeep at all");
  const block = upkeep.slice(at, at + 400);
  assert.match(block, /wanted: facts\.has_clients/, "armed on the wrong fact");
  assert.ok(!/wanted: facts\.does_fulfillment/.test(block), "armed on engagements existing, which is the bug");
});

// ── the fit that decides whose work it is ─────────────────────────────────────────────────────────

test("AN `adjacent` WEDGE IS THE FIRM'S OWN BACK OFFICE, NOT ITS CLIENT WORK", async () => {
  /**
   * `deliveryWedge` accepted `fit: "direct" | "adjacent"`, and the two mean opposite things. Read
   * from production, 13 September — every one of these is `adjacent`, and the shaper's own `covers`
   * text says whose business it is about:
   *
   *     Northlight Studio  (brand identity + Webflow)  → invoice-chaser
   *         "Chases YOUR overdue invoices by email and escalates on a schedule."
   *     Harbourline Studio (brand + web design)        → invoice-chaser
   *         "Chases YOUR overdue project deposits by email."
   *     Web app development for food businesses        → security-questionnaire
   *         "Answers client questionnaires from YOUR mounted knowledge."
   *
   * FOUR OF THE FIFTEEN real businesses shaped so far are design studios sitting on exactly that
   * answer. `deliveryWedge` picks the service a CLIENT's engagement opens on — so taking the
   * adjacent answer would open an engagement in a design client's name on invoice chasing and send
   * that client intake questions about it.
   *
   * It matters more now than it did this morning: the engagement sweep asks this question on a
   * clock, for every stranded client, so a wrong answer is no longer one founder's confusing
   * afternoon. It is mail leaving the building.
   */
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/engagement-open.ts", import.meta.url).pathname, "utf8");
  const fn = src.slice(src.indexOf("export async function deliveryWedge"), src.indexOf("export async function", src.indexOf("export async function deliveryWedge") + 10));

  assert.match(fn, /shape\.fit === "direct"/, "an adjacent wedge is being used as the client delivery service");
  assert.ok(
    !/fit === "direct" \|\| fit === "adjacent"/.test(fn),
    "both fits are accepted again, so a design studio's clients get invoice-chasing engagements",
  );

  // And the shape still CARRIES the adjacent answer — it is useful, just not for this question.
  const shapeSrc = readFileSync(new URL("../src/business-shape.ts", import.meta.url).pathname, "utf8");
  assert.match(shapeSrc, /fit\?: "direct" \| "adjacent"/, "callers cannot tell the two apart any more");
  assert.match(
    shapeSrc,
    /wedge: fit === "direct" \|\| fit === "adjacent" \? str\(runs\.wedge\) : undefined,/,
    "the adjacent wedge was dropped entirely rather than labelled",
  );
});
