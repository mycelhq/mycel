// THE HUMAN GATE, as four routes. Read authored.ts first — it holds the tenancy argument.
//
// Mycel can now write a service definition for a business the installed catalogue does not cover.
// Everything about that is a proposal until a founder says otherwise, and this file is where the
// founder says it. `improvement.ts` is the precedent for propose → review → promote; the difference
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
import { fireSchedule, firstRun } from "./scheduler";
import { reviewDraft, type DraftReview } from "./wedgeauthor";
import type { Store } from "./store";
import type { Cadence } from "./contract";

/** The job the shaping agent does when nothing installed fits. Matches roles.ts and orchestrator.ts. */
const DRAFT_SERVICE_TASK_TYPE = "draft_service";

/** Jobs that wait on a person or a packet — they must not be the morning tick. */
const NOT_A_DESK_TICK = /^(nudge_|deliverable_|check_in|advance_)/;

const MORNING: Cadence = { kind: "daily", hour: 8, minute: 0 };

/**
 * Agreeing to a written service used to flip a status and leave `/clock` empty. Universal ops
 * (invoice chase) only appear when the project already raises invoices. The work they sell needs
 * its own morning tick, disabled until they go live — same contract as a packaged blueprint.
 */
async function ensureAuthoredDeskClock(projectId: string, row: AuthoredWedge): Promise<void> {
  const types = Object.keys(row.manifest.task_types ?? {});
  const taskType = types.find((t) => !NOT_A_DESK_TICK.test(t)) ?? types[0];
  if (!taskType) return;
  const domain = getDomainStore();
  const existing = (await domain.listSchedules()).filter((s) => s.project_id === projectId && s.wedge === row.slug);
  if (existing.length) return;
  await domain.createSchedule({
    project_id: projectId,
    name: row.title.trim() || "Desk",
    wedge: row.slug,
    task_type: taskType,
    input: {},
    cadence: MORNING,
    enabled: false,
    next_run_at: firstRun(MORNING),
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
  status: AuthoredWedge["status"];
  described_as: string;
  created_at: string;
  decided_at?: string;
}

export function toDraftView(row: AuthoredWedge): DraftView {
  return {
    ...reviewDraft({ slug: row.slug, manifest: row.manifest, skills: row.skills, knowledge: row.knowledge }),
    slug: row.slug,
    status: row.status,
    described_as: row.described_as,
    created_at: row.created_at,
    decided_at: row.decided_at,
  };
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
    return c.json(rows.map(toDraftView));
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
    const tasks = await deps.store.listTasks({ limit: 200 });
    const newest = tasks
      .filter((t) => t.project_id === projectId && t.task_type === DRAFT_SERVICE_TASK_TYPE)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
    if (!newest) return c.json({ state: "never_asked" });
    if (!TERMINAL.has(newest.status)) return c.json({ state: "working", task_id: newest.id });

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
    return c.json(toDraftView(row));
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
    const decided = await store().decide(projectId, slug, "promoted", deps.actorId(c));
    if (!decided) return notDecided(c, projectId, slug);
    /**
     * Agreeing to run it must put something on the clock when the service's roles need it.
     *
     * Promote used to flip status alone — `/clock` stayed empty and "running" was a lie. Quiet
     * upkeep creates payment/dunning/nudge schedules when the project facts warrant them, without
     * failing the promote if a wedge is missing (same contract as invoice writes).
     */
    await ensureAuthoredDeskClock(projectId, decided);
    await ensureUpkeepQuietly(getDomainStore(), projectId);
    return c.json(toDraftView(decided));
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
    if (decided) return c.json(toDraftView(decided));
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
