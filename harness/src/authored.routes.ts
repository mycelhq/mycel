// THE HUMAN GATE, as four routes. Read authored.ts first — it holds the tenancy argument.
//
// Mycel can now write a service definition for a business the installed catalogue does not cover.
// Everything about that is a proposal until a founder says otherwise, and this file is where the
// founder says it. the self-improvement system (deleted in 59f1dd83 — 261 sandbox-hours, four proposals, nothing adopted)
// is the precedent for propose → review → promote; the difference
// here is what the human is actually LOOKING at, which is `reviewDraft` in wedgeauthor.ts rather
// than a JSON blob nobody can assess.
//
// ── TENANCY, IN ONE LINE PER ROUTE ──
//
// Every route resolves a project id first and refuses without one, and every store call takes it
// positionally. There is no route here that accepts a slug and looks it up globally, because there
// is no store method that would let it: `getAuthored(projectId, slug)` has no single-argument form.
// A slug belonging to another business reads as 404, which is also what a typo reads as — a probe
// for another tenant's service must be indistinguishable from a mistake.
//
// ── WHY PROMOTION IS A POST AND NOT A PUT ──
//
// `PUT /v1/improvements/:id` takes a status in the body and branches on it, and the shape has a
// known cost: the caller can send anything, so the route needs a vocabulary check, and "promote"
// and "reject" end up sharing a code path that has to remember which one it is on. These are two
// different decisions with two different consequences — one of them eventually emails a customer —
// so they are two routes and neither can be reached by getting a string slightly wrong.
import type { Hono } from "hono";
import { getAuthoredStore, type AuthoredWedge } from "./authored";
import { getDomainStore } from "./domain";
import { ensureUpkeepQuietly } from "./upkeep";
import { fireSchedule, firstRun, scheduleKey } from "./scheduler";
import { recurringJob, reviewDraft, type DraftReview } from "./wedgeauthor";
import { RESEARCH_SERVICE_TASK_TYPE } from "./skill-arsenal";
import { collapseForFounder, gradeDeliverables, type Grade } from "./deliverable-grade";
import { audit } from "./audit";
import { exemplarSkills } from "./exemplar";
import { composioConfig, listAllToolkits } from "./composio";
import type { WedgeManifest } from "./wedge";
import type { Store } from "./store";
import type { Cadence } from "./contract";
import { readOffering, researchedDeliverables, saveOffering } from "./offering";

/** The job the shaping agent does when nothing installed fits. Matches roles.ts and orchestrator.ts. */
const DRAFT_SERVICE_TASK_TYPE = "draft_service";

/**
 * ═══ THE RHYTHM IS A CHOICE NOW, AND IT USED TO BE A SECRET ═══
 *
 * Agreeing to a written service created a schedule the founder had never seen: 8am, every day, on
 * whichever job a regex in this file picked first. Nothing on the review card mentioned a clock at
 * all. The founder pressed "use this" and silently agreed to a daily tick on a job they could not
 * name — which is the one thing in the whole review flow they were not shown, and the one with a
 * recurring cost attached.
 *
 * Three named rhythms, because "how often" for a service business is genuinely a three-way choice
 * and a cron expression is not a question anybody can answer. `weekdays` stays the default: it is
 * what the product did before, so an existing founder's schedule does not change under them.
 *
 * `recurringJob` moved to wedgeauthor.ts so `reviewDraft` can show the SAME job this creates. Two
 * copies of that rule is how a card promises Mondays and the clock keeps Tuesdays.
 */
export const RHYTHMS = {
  weekdays: { says: "every weekday morning", cadence: { kind: "daily", hour: 8, minute: 0 } as Cadence },
  weekly: { says: "every Monday morning", cadence: { kind: "weekly", weekday: 1, hour: 8, minute: 0 } as Cadence },
  monthly: { says: "on the first of the month", cadence: { kind: "monthly", day: 1, hour: 8, minute: 0 } as Cadence },
} as const;

export type RhythmName = keyof typeof RHYTHMS;
export const isRhythm = (v: unknown): v is RhythmName => typeof v === "string" && v in RHYTHMS;

/**
 * Agreeing to a written service used to flip a status and leave `/clock` empty. Universal ops
 * (invoice chase) only appear when the project already raises invoices. The work they sell needs
 * its own morning tick, disabled until they go live — same contract as a packaged blueprint.
 */
async function ensureAuthoredDeskClock(projectId: string, row: AuthoredWedge, rhythm: RhythmName = "weekdays"): Promise<void> {
  const taskType = recurringJob(row.manifest);
  if (!taskType) return;
  const domain = getDomainStore();
  const existing = (await domain.listSchedules()).filter((s) => s.project_id === projectId && s.wedge === row.slug);
  if (existing.length) return;
  const { cadence } = RHYTHMS[rhythm];
  await domain.createSchedule({
    project_id: projectId,
    name: row.title.trim() || "Desk",
    wedge: row.slug,
    task_type: taskType,
    input: {},
    cadence,
    enabled: false,
    next_run_at: firstRun(cadence, new Date(), scheduleKey(projectId, taskType)),
  });
}

export interface AuthoredRouteDeps {
  /** For `GET /v1/services/last-attempt` — the run log is where a refusal's reason is written. */
  store: Store;
  /** The projects the caller may READ. Fails closed; see `identity.accessibleProjectIds`. */
  accessible(c: any): Set<string>;
  /** The project a write lands in, or undefined when the caller named none. */
  writeProjectId(c: any): string | undefined;
  /** Who is asking, for the promotion audit trail. A decision with no name on it is not a decision. */
  actorId(c: any): string;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE INTEGRATIONS THAT ACTUALLY EXIST
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `gradeDeliverables` needs this to tell a founder that the service they are about to promote asks
 * their client to connect something that cannot be connected. It is resolved here rather than in
 * the grade so that function stays pure, synchronous and testable without a network.
 *
 * CACHED FOR AN HOUR, PROCESS-WIDE. The catalogue is ~500 rows and changes on Composio's release
 * schedule, not ours; a review screen must not pay four paged round trips because somebody opened
 * it twice.
 *
 * DEGRADES TO `undefined`, WHICH MEANS "DID NOT CHECK". Not to an empty set — an empty set would
 * read as "no integration exists" and raise a blocking finding against every connection ask the
 * moment Composio was unreachable, stopping a founder from promoting a perfectly good service for a
 * reason on our side that they could not diagnose. Failing to check is the safe direction here and
 * the wrong-direction failure is worse than the bug being caught.
 */
let toolkitCache: { at: number; slugs: ReadonlySet<string> } | undefined;
const TOOLKIT_TTL_MS = 60 * 60 * 1000;

/**
 * ═══ ONLY FETCHED WHEN A MANIFEST ACTUALLY NAMES AN INTEGRATION ═══
 *
 * The first version called this unconditionally and it showed up immediately: `GET
 * /v1/services/drafts` went to 3.6s in the slow log, because a cache miss pages the entire Composio
 * catalogue — up to twenty requests — to answer a question most drafts never ask. A service with no
 * `client_connections` cannot have an unknown toolkit, so there is nothing to check and no reason to
 * have looked.
 *
 * Caller passes the manifests it is about to grade. Empty means the catalogue is never touched,
 * which is the common case.
 */
function namesAnIntegration(manifests: readonly WedgeManifest[]): boolean {
  return manifests.some((m) => (m.fulfillment?.client_connections ?? []).length > 0);
}

async function knownToolkits(
  manifests: readonly WedgeManifest[],
): Promise<ReadonlySet<string> | undefined> {
  if (!namesAnIntegration(manifests)) return undefined;
  if (toolkitCache && Date.now() - toolkitCache.at < TOOLKIT_TTL_MS) return toolkitCache.slugs;
  const cfg = composioConfig();
  if (!cfg) return undefined;
  try {
    const { items } = await listAllToolkits(cfg, {});
    if (!items.length) return undefined;
    const slugs = new Set(items.map((t) => String(t.slug ?? "").trim().toLowerCase()).filter(Boolean));
    toolkitCache = { at: Date.now(), slugs };
    return slugs;
  } catch {
    return undefined;
  }
}

/**
 * What crosses to the founder.
 *
 * The MANIFEST IS NOT IN IT, and that is the design rather than an oversight. A review surface that
 * ships the raw definition invites the console to render it, and a founder shown a JSON document has
 * been given the appearance of a review without the ability to perform one. What they get is the
 * three questions `reviewDraft` answers — what work this will do, what it needs permission for, and
 * what it will never do without asking — plus the description they typed, so they can check the
 * draft against the ask rather than against their memory of it.
 *
 * `slug` crosses because the promote and reject routes need it. It carries the authored mark, which
 * is machinery, so the console must not print it — the same rule the shaper's `plainEnglish` applies
 * to `runs_as.wedge`, which it also passes through and also never renders.
 */
export interface DraftView extends DraftReview {
  slug: string;
  /** What the draft asked for and did not get. See `AuthoredWedge.notices`. */
  notices: string[];
  status: AuthoredWedge["status"];
  described_as: string;
  created_at: string;
  decided_at?: string;
  
/**
   * WHETHER THE WORK THIS PRODUCES WILL BE CHECKED, which the other three questions do not ask.
   *
   * `reviewDraft` answers what it will do, what it needs, and what it will never do unasked. All
   * three are about BEHAVIOUR, and a service can answer them perfectly and still hand a client a
   * document with a contradiction in it.
   *
   * This is the moment that matters: a founder is looking at something a model wrote twenty seconds
   * ago from one paragraph they typed, deciding whether to point it at somebody who is paying. "It
   * validated" is not the question they are asking, and `checks` — the plain-English list of what is
   * enforced — reads the same whether there are nine gates or none. The grade is what distinguishes
   * them.
   *
   * The exemplar count is the PROJECT's, not this service's. `exemplarSkills` reads one the founder
   * uploaded at onboarding, keyed to the project, and mounts it for every trade they run — so a
   * founder who has uploaded one already has a bar for a service written five minutes ago, and
   * reporting otherwise would send them to do a thing they have done.
   /** The review verdict, computed rather than stored. */
  grade: Grade;
}

export function toDraftView(
  row: AuthoredWedge,
  exemplars = 0,
  toolkits?: ReadonlySet<string>,
): DraftView {
  return {
    ...reviewDraft({ slug: row.slug, manifest: row.manifest, skills: row.skills, knowledge: row.knowledge }),
    slug: row.slug,
    status: row.status,
    described_as: row.described_as,
    /**
     * On the review card, because that is the only screen where it can change a decision. A founder
     * approving a written service is being asked to trust the thing that wrote it, and "the draft
     * asked to act on its own without checking with you — none of it was allowed" is the most
     * useful sentence available about that. Empty for every service that asked for nothing it was
     * not entitled to, which is most of them.
     */
    notices: row.notices ?? [],
    created_at: row.created_at,
    decided_at: row.decided_at,
    /*
      COLLAPSED FOR THE SCREEN. `blocking` and `weak` still count every job, because those are the
      numbers the card leads with and "4 things need attention" is true; `findings` is one row per
      KIND of problem, because four sentences differing only in a job title is one fact rendered four
      times — see `collapseForFounder` for the measurement that produced it.
    */
    grade: (() => {
      const g = gradeDeliverables(row.manifest, { exemplars, knownToolkits: toolkits });
      return { ...g, findings: collapseForFounder(g.findings) };
    })(),
  };
}


/**
 * How many exemplars a run in this project would actually mount.
 *
 * The founder's own upload is keyed to the PROJECT, not to a wedge — `exemplarSkills` reads it
 * through whichever wedge holds the shaping role — so it is the bar for every trade they run,
 * including one written five minutes ago. Counting this service's own directory instead would tell
 * a founder who has already uploaded one to go and do it again.
 *
 * Fails soft to zero: a grade is a note on a review screen, and it must not be able to 500 the page
 * a founder is reading to decide whether to trust their new service.
 */
async function exemplarCount(projectId: string): Promise<number> {
  return exemplarSkills(getDomainStore(), projectId)
    .then((x) => x.length)
    .catch(() => 0);
}

/** Mirrors the kernel's terminal set. A run in one of these is never coming back. */
const TERMINAL = new Set(["succeeded", "failed", "rejected", "expired", "cancelled"]);

export function mountAuthoredRoutes(app: Hono, deps: AuthoredRouteDeps): void {
  const store = () => getAuthoredStore();

  /**
   * Resolve the one project this request is about, for a READ.
   *
   * Copied in shape from `requests.routes.ts` rather than shared, because the fan-out-over-accessible
   * pattern used by `GET /v1/improvements` is wrong here: a draft is a definition of what a specific
   * business does, and merging two businesses' drafts into one list is how somebody promotes the
   * wrong one. A member with two projects must name which.
   */
  const readProject = (c: any): string | undefined => {
    const set = deps.accessible(c);
    const named = c.req.header("x-mycel-project");
    if (named) return set.has(named) ? named : undefined;
    return set.size === 1 ? [...set][0] : undefined;
  };

  /**
   * WHAT THIS BUSINESS SELLS — the research's list, and the founder's answer to it.
   *
   * One route returning both halves, because neither is readable alone. `offered` without
   * `researched` is a list with no provenance; `researched` without `offered` cannot render a
   * checked box. Two round-trips to draw one panel would also mean the panel can arrive
   * half-answered, which on this screen looks like the product forgot.
   */
  app.get("/v1/services/offering", async (c) => {
    const projectId = readProject(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    const domain = getDomainStore();
    const [researched, offered] = await Promise.all([
      researchedDeliverables(domain, projectId),
      readOffering(domain, projectId),
    ]);
    return c.json({ researched, offering: offered ?? null });
  });

  app.post("/v1/services/offering", async (c) => {
    const projectId = readProject(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    const b = (await c.req.json().catch(() => ({}))) as { items?: unknown };
    // `normalizeItems` drops anything unusable rather than 400-ing, and the count comes back so a
    // caller that sent ten and gets four knows six were refused. Silently storing less than was
    // sent is how a founder discovers next week that half their business is missing.
    const saved = await saveOffering(getDomainStore(), { project_id: projectId, items: b.items });
    return c.json({ offering: saved });
  });

  /** Everything Mycel has written for this business, newest first. */
  app.get("/v1/services/drafts", async (c) => {
    const projectId = readProject(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    const status = c.req.query("status");
    const rows = await store().listAuthored({
      project_id: projectId,
      status: status === "drafted" || status === "promoted" || status === "rejected" ? status : undefined,
      limit: Number(c.req.query("limit") ?? 50),
    });
    const ex = await exemplarCount(projectId);
    // Once for the page, not once per row — the cache would absorb it, and relying on a cache to
    // make an N+1 acceptable is how the N+1 survives the day the cache is removed.
    const tk = await knownToolkits(rows.map((r) => r.manifest));
    return c.json(rows.map((r) => toDraftView(r, ex, tk)));
  });

  /**
   * How the last attempt to write a service went, and — if it failed — WHY, in a sentence.
   *
   * ═══ WHY THIS ROUTE EXISTS AT ALL ═══
   *
   * A run that produces an unusable definition succeeds: the agent did its job and its output passed
   * its own schema; what failed was the CONTENT, against the rules in wedgeauthor.ts. So nothing is
   * stored, and a console listing drafts sees an empty list — indistinguishable from "nobody ever
   * asked". A founder who has just been told we cannot cover their trade would then be shown a
   * blank panel and left to guess, which is this repo's recurring bug wearing a friendly face.
   *
   * The reason already exists, written out in full, on the `service.draft_refused` event. The event
   * stream is SSE and `/trace` is a span tree; neither is a thing a page can ask one question of.
   * So this route asks it: newest `draft_service` run in this project, its status, and the sentence
   * if there is one.
   *
   * Reads the task list rather than a stored pointer, for the reason lib/shape.ts gives for the
   * shaping run: the task list IS the record, so there is no id to go stale and re-describing the
   * business is just another run that becomes the newest one.
   */
  app.get("/v1/services/last-attempt", async (c) => {
    const projectId = readProject(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    /**
     * ═══ WRITING A SERVICE IS TWO RUNS NOW, AND THIS ROUTE ONLY KNEW ABOUT THE SECOND ═══
     *
     * The button starts `research_service` — the browser job that goes and reads how the trade is
     * actually delivered — and the kernel starts `draft_service` when it lands. Looking only for the
     * draft meant a founder who had just pressed the button was told `never_asked` for the fifteen
     * minutes the research was running, so the card offered to write them one they were already
     * getting, and pressing again would have queued a second.
     *
     * Both types, newest wins. A research run in flight is "working" for exactly the same reason a
     * drafting run is: something is happening and there is nothing to show yet.
     *
     * A research run that has FINISHED, though, is not the end of the story — the draft it triggers
     * may not have been created yet, which is a window of a second or two where the newest terminal
     * task is the research and reporting `finished` would flip the card back to "we can write one"
     * mid-flight. So a terminal research run with no draft behind it still reads as working.
     */
    const tasks = await deps.store.listTasks({ limit: 200 });
    const mine = tasks
      .filter((t) => t.project_id === projectId)
      .filter((t) => t.task_type === DRAFT_SERVICE_TASK_TYPE || t.task_type === RESEARCH_SERVICE_TASK_TYPE)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    const newest = mine[0];
    if (!newest) return c.json({ state: "never_asked" });
    if (!TERMINAL.has(newest.status)) return c.json({ state: "working", task_id: newest.id });
    if (newest.task_type === RESEARCH_SERVICE_TASK_TYPE) {
      // Finished looking; the draft is being queued. Only `failed` is worth reporting as an end —
      // a research run that died leaves nothing behind it, and the founder should be offered a retry
      // rather than a spinner that never resolves.
      return newest.status === "succeeded"
        ? c.json({ state: "working", task_id: newest.id })
        : c.json({ state: "finished", task_id: newest.id, task_status: newest.status });
    }

    const events = await deps.store.eventsAfter(newest.id, 0);
    const refused = [...events].reverse().find((e) => e.type === "service.draft_refused");
    const summary = refused?.data?.summary;
    if (typeof summary === "string" && summary.trim()) {
      return c.json({ state: "refused", task_id: newest.id, reason: summary, reasons: refused!.data.reasons ?? [] });
    }
    // The run produced a draft (which the list route serves) or ended without reaching the author at
    // all — a cancel, a budget abort. `finished` says which without inventing a reason for it.
    return c.json({ state: "finished", task_id: newest.id, task_status: newest.status });
  });

  app.get("/v1/services/drafts/:slug", async (c) => {
    const projectId = readProject(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    const row = await store().getAuthored(projectId, c.req.param("slug"));
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json(toDraftView(row, await exemplarCount(projectId), await knownToolkits([row.manifest])));
  });

  /**
   * The founder agrees to run it.
   *
   * This is the only thing in the system that makes an authored service loadable: until it lands,
   * `loadProjectWedge` returns null for the slug and therefore nothing can spawn a task against it.
   * The gate is in the resolver rather than duplicated at every spawn site, for the reason a gate at
   * a route always ends badly — it is a gate somebody forgets to add to the second route.
   *
   * ONE WAY. A promoted service cannot be walked back to `drafted` here, and the 409 says why. That
   * is not stubbornness: turning a running service off is a real operation, but it is `disable`,
   * with a story about the work already in flight, and pretending a status flip is that operation
   * would leave cases sitting in a stage machine nothing can advance.
   */
  app.post("/v1/services/drafts/:slug/promote", async (c) => {
    const projectId = deps.writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    const slug = c.req.param("slug");

    /**
     * ═══ A SERVICE WHOSE OUTPUT NOTHING REQUIRES DOES NOT GO LIVE BY ACCIDENT ═══
     *
     * Promote is the commitment — it flips the status AND puts the desk on the clock, so after this
     * the service runs against real clients on a schedule. A blocking finding means something
     * specific and bad: with nothing in `output_schema.required`, every output validates, INCLUDING
     * AN EMPTY ONE, so a run reports success and the client receives a blank.
     *
     * Refused rather than warned, because a warning on a review screen is read once and the schedule
     * fires for months. Same default-closed reasoning as approvals.
     *
     * ═══ AND IT IS OVERRIDABLE, DELIBERATELY ═══
     *
     * It is their business. A founder who has read the finding and wants to run it anyway — on
     * themselves, on a friendly first client — is making a decision this code is not entitled to
     * refuse twice. What it IS entitled to do is make the decision explicit and record who made it,
     * so "nobody told me" is never true.
     *
     * Weak findings do not gate. They are worth seeing and they are not "the client gets a blank".
     */
    // Read ONCE, before the grade branch. A request body is a stream: reading it inside the `if`
    // and again after it returns `{}` the second time, which would silently discard the rhythm.
    const body = (await c.req.json().catch(() => ({}))) as { acknowledge?: unknown; rhythm?: unknown };
    const before = await store().getAuthored(projectId, slug);
    if (before) {
      const grade = gradeDeliverables(before.manifest, { exemplars: 0, knownToolkits: await knownToolkits([before.manifest]) });
      if (grade.blocking > 0 && body.acknowledge !== true) {
        return c.json(
          {
            error: "this service is not ready to run against a client",
            verdict: grade.verdict,
            blocking: grade.findings.filter((f) => f.severity === "blocking"),
            // Named, so a console can offer the button rather than a founder guessing at the API.
            override: "send { \"acknowledge\": true } to run it anyway",
          },
          400,
        );
      }
      if (grade.blocking > 0) {
        await audit({
          project_id: projectId,
          actor: deps.actorId(c),
          action: "service.promoted_over_blocking",
          entity: "authored_wedge",
          entity_id: slug,
          // The findings, not a count: a year from now the question is what they were told.
          detail: { verdict: grade.verdict, blocking: grade.findings.filter((f) => f.severity === "blocking") },
        });
      }
    }

    const decided = await store().decide(projectId, slug, "promoted", deps.actorId(c));
    if (!decided) return notDecided(c, projectId, slug);
    /**
     * Agreeing to run it must put something on the clock when the service's roles need it.
     *
     * Promote used to flip status alone — `/clock` stayed empty and "running" was a lie. Quiet
     * upkeep creates payment/dunning/nudge schedules when the project facts warrant them, without
     * failing the promote if a wedge is missing (same contract as invoice writes).
     */
    // The rhythm the founder picked on the review card, or the one it showed them by default. Read
    // off the same body that carries `acknowledge`; an unknown value falls back rather than 400s,
    // because a bad enum must not cost somebody the service they just agreed to.
    await ensureAuthoredDeskClock(projectId, decided, isRhythm(body.rhythm) ? body.rhythm : "weekdays");
    await ensureUpkeepQuietly(getDomainStore(), projectId);
    return c.json(toDraftView(decided, await exemplarCount(projectId), await knownToolkits([decided.manifest])));
  });

  /**
   * Put the written service on the clock. Same moment as blueprint activate: schedules were created
   * disabled so nothing emails a client before the founder says go. Authored services have no
   * packaged blueprint, so `/v1/blueprints/:slug/activate` cannot do this.
   */
  app.post("/v1/services/drafts/:slug/go-live", async (c) => {
    const projectId = deps.writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    const slug = c.req.param("slug");
    const row = await store().getAuthored(projectId, slug);
    if (!row) return c.json({ error: "not found" }, 404);
    if (row.status !== "promoted") {
      return c.json({ error: `"${row.title}" is not running yet — agree to it first` }, 409);
    }
    const domain = getDomainStore();
    await ensureAuthoredDeskClock(projectId, row);
    const mine = (await domain.listSchedules()).filter((s) => s.project_id === projectId && s.wedge === slug);
    for (const s of mine) {
      if (!s.enabled) await domain.updateSchedule(s.id, { enabled: true });
    }
    const lead = mine[0];
    let firstTask: string | undefined;
    if (lead) firstTask = (await fireSchedule(deps.store, domain, { ...lead, enabled: true }))?.id;
    return c.json({ ok: true, activated: mine.map((s) => s.name), first_task_id: firstTask });
  });

  /** The founder says no. Same shape, and the same one-way rule for the same reason. */
  app.post("/v1/services/drafts/:slug/reject", async (c) => {
    const projectId = deps.writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    const slug = c.req.param("slug");
    const decided = await store().decide(projectId, slug, "rejected", deps.actorId(c));
    if (decided) return c.json(toDraftView(decided, await exemplarCount(projectId), await knownToolkits([decided.manifest])));
    return notDecided(c, projectId, slug);
  });

  /**
   * Why `decide` returned nothing, said in words.
   *
   * There are exactly two reasons and they need different answers: no such draft in this project
   * (404, indistinguishable from another tenant's slug, deliberately), or a draft somebody has
   * already decided (409 naming the decision). A single "not found" for both would tell a founder
   * whose colleague just promoted the same draft that their work had vanished.
   */
  async function notDecided(c: any, projectId: string, slug: string) {
    const row = await store().getAuthored(projectId, slug);
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json(
      {
        error:
          row.status === "promoted"
            ? `"${row.title}" is already running for this business — someone agreed to it${row.decided_at ? ` on ${row.decided_at.slice(0, 10)}` : ""}`
            : `"${row.title}" was already turned down${row.decided_at ? ` on ${row.decided_at.slice(0, 10)}` : ""}`,
        status: row.status,
      },
      409,
    );
  }
}
