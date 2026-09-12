// The campaign surface: propose, approve, tick. Mounted with one line in server.ts.
//
// There is a route here for approving a campaign, rather than reusing `POST /v1/approvals/:id/approve`,
// for a specific reason: that endpoint resolves an IN-PROCESS WAITER — it exists to unblock a run
// suspended inside `awaitApproval`, and it answers 409 when there is nobody blocked. A campaign
// approval has nobody blocked ON PURPOSE (that is the entire point of approving once instead of two
// hundred times), so it needs a path that decides the row and nothing else.
import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
import type { Connection, Task } from "../contract";
import { audit } from "../audit";
import type { DomainStore } from "../domain";
import type { Store } from "../store";
import {
  CampaignError,
  loadCampaign,
  setCampaignStatus,
  proposeCampaign,
  type ProspectDraft,
  type SequenceStep,
} from "./campaign";
import { enrichEmails, enrichableFromGraph, enrichmentConfigured, fullEnrichConfigured, FULLENRICH_KEY_ENV } from "./enrich";
import { FIRECRAWL_KEY_ENV, firecrawlConfigured } from "./firecrawl";
import { serperConfigured } from "./discover-cheap";
import { casesForCampaign, enrolProspects, findProspects, prospectsFromGraph } from "./prospects";
import {
  DEFAULT_AUDIENCE_CADENCE,
  ensureAudienceSchedule,
  loadAudience,
  removeAudienceSchedule,
  saveAudience,
  type AudienceFilters,
} from "./autonomous";
import type { Cadence } from "../contract";
import { advanceSequences, ensureSequenceSchedule, setTouchDeps } from "./sequence";
import { decideReply, proposeReply, ReplyError, ReplySendError } from "./reply";
import { expandLookalikes } from "./lookalike";
import { detectSignals, ingestSignals, type SignalHit } from "./signals";
// Extracted so `proposal-envelope.ts` can read the business name too — see business-shape.ts.
import { readBusinessShape } from "../business-shape";
import { gtmWedge, hasGtmWedge } from "./stages";
import { whyNoWedge, wedgeForRole } from "../roles";
import { draftFirstMessage, draftPerProspect, type ProspectWorld } from "./draft-message";
import { draftProposal } from "./proposal";
import { render } from "../render";
import { getArtifactBackend } from "../artifacts";
import { getIdentityStore } from "../identity";
import { getKnowledgeStore } from "../knowledge.store";
import { recordApprovalOutcome } from "../knowledge";
import { PEOPLE_COLLECTION } from "../linkedin/graph";
import type { AuthScope } from "../identity";

export interface GtmRouteDeps {
  store: Store;
  domain: DomainStore;
  getConnection(id: string): Promise<Connection | undefined>;
  accessible(c: any): Set<string>;
  writeProjectId(c: any): string | undefined;
  inScope(set: Set<string>, pid?: string): boolean;
}

export function mountGtm(app: Hono, deps: GtmRouteDeps): void {
  const { store, domain } = deps;

  /**
   * The store the take-one-touch path needs, registered at mount time.
   *
   * Here rather than in scheduler.ts, and the difference matters: the scheduler only runs where a
   * worker is running, while `/next` is served by every replica. Registering on the scheduler would
   * make "can a founder take an outreach touch" depend on whether THIS process happens to be the one
   * with the clock — which is a button that works on some page loads. Mounting the GTM routes is the
   * honest precondition: it is the same thing that decides whether outbound exists on this kernel at
   * all. Until this line runs `startNextTouch` refuses, fail-closed, and says so.
   */
  setTouchDeps({ store });

  /**
   * THE BOUNDARY GATE — one middleware, every `/v1/gtm/*` route.
   *
   * Outbound machinery is a wedge, and an install may simply not have one. This is the degradation
   * half of the split described on `gtmWedge` in stages.ts: the interior of `gtm/` throws on a
   * missing outreach wedge because reaching it means something upstream is broken, and this single
   * boundary turns the honest absence into a 501 that says which declaration is missing.
   *
   * WHY A MIDDLEWARE AND NOT A LINE IN EACH HANDLER. Fourteen routes; a per-handler check is
   * thirteen chances to forget one, and the one forgotten would be the one that writes. Before this,
   * `POST /v1/gtm/campaigns` hardcoded `wedge: "gtm-operator"` into a Task row unconditionally, so a
   * kernel with no outbound wedge accepted a campaign, stored the proposal, raised the approval —
   * and had nothing to run it with. Accepting work you cannot do is worse than refusing it.
   *
   * 501 and not 404: the route exists, the capability does not.
   */
  app.use("/v1/gtm/*", async (c, next) => {
    if (!hasGtmWedge()) {
      return c.json({ error: `outbound is not installed on this kernel — ${whyNoWedge("outreach")}` }, 501);
    }
    await next();
  });

  /**
   * ═══ WHAT ON THIS PATH ACTUALLY WORKS, ASKABLE BEFORE ANYTHING IS BUILT ON IT ═══
   *
   * THE FAILURE THIS EXISTS FOR. `FULLENRICH_API_KEY` was set nowhere — not in `.env.example`, not
   * in the Terraform, not in the buildspec, not in Secrets Manager — so email enrichment had never
   * once worked in production, and there was no way to learn that except to build a campaign, POST
   * to `/prospects/enrich` and read a 501. (It is IN the Terraform now: `infra/services.tf` wires it
   * into both task definitions from `local.secret_arns["fullenrich-api-key"]`. The paragraph above
   * outlived the fix by a release and this route went on telling founders otherwise — which is the
   * exact failure this route was built to cure, committed by the route itself.) Every
   * other surface stayed silent: no banner, no flag, no status. The absence was HONEST at the point
   * of use and INVISIBLE everywhere else, which is how a founder ends up designing an outreach
   * motion around a capability that does not exist.
   *
   * So the question gets a route. Per lead-path capability: whether it works right now, which
   * environment variable turns it on, and — the part that makes this worth having rather than a
   * config dump — what is LOST while it is off, said in a sentence about the product rather than
   * about the setting.
   *
   * `available: false` is a normal, supported, shipped state and must not read as breakage. Most of
   * this path genuinely works with no external key at all: search, enrolment, invites, messaging
   * and reply detection all run on the connected member session, and the only thing a missing
   * FullEnrich key costs is the email column. That is what `works_without_keys` says out loud, and
   * saying it is the whole difference between "this is off" and "this is broken".
   *
   * Not project-scoped, on purpose: this is a fact about the DEPLOYMENT, not about a tenant. It
   * names no connection, no record and no tenant-owned value. The `/v1/gtm/*` gate above still
   * applies, so it is only reachable where outbound is installed at all.
   */
  app.get("/v1/gtm/availability", (c) =>
    c.json({
      items: [
        {
          capability: "find_prospects",
          title: "Find people on LinkedIn",
          available: true,
          requires_key: null,
          detail: "Runs on your connected LinkedIn. No extra setup, and it costs nothing to find someone.",
        },
        {
          capability: "outreach_sequencing",
          title: "Invite them, message them, and spot their replies",
          available: true,
          requires_key: null,
          detail:
            "Runs on your connected LinkedIn. It sends slowly and safely, and nothing goes out without your OK.",
        },
        {
          capability: "enrich_emails",
          title: "Find someone's email",
          available: enrichmentConfigured(),
          requires_key: firecrawlConfigured() ? FIRECRAWL_KEY_ENV : FULLENRICH_KEY_ENV,
          detail: enrichmentConfigured()
            ? [
                firecrawlConfigured() ? "We check public company pages for an email that's already listed." : null,
                fullEnrichConfigured() ? "A paid lookup fills in the ones we can't find that way." : null,
              ]
                .filter(Boolean)
                .join(" ")
            : "Off for now. Turn on email finding to add it — finding people, inviting and messaging still work.",
        },
      ],
      /**
       * The headline, stated once, because a three-item list with one `false` in it still scans as
       * mostly broken. It is not: the expensive half of this path needs no key at all.
       */
      works_without_keys:
        "Finding people, inviting them, messaging, and spotting replies all run on your connected " +
        "LinkedIn — no extra setup. Only finding emails needs a bit more.",
    }),
  );

  /**
   * ═══ THE AUTONOMOUS GTM AUDIENCE ═══
   *
   * The standing "who to reach" the loop searches for, set ONCE. GET reads it; PUT writes it and
   * wires the recurring schedule: `enabled: true` creates/re-points the weekly (or chosen cadence)
   * schedule that runs discovery → propose on its own, `enabled: false` removes it. The loop only
   * DISCOVERS and PROPOSES — every send still waits for the founder's approval envelope, unchanged.
   */
  app.get("/v1/gtm/audience", async (c) => {
    const projectId = deps.writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    if (!deps.inScope(deps.accessible(c), projectId)) return c.json({ error: "unknown project" }, 404);
    const audience = await loadAudience(domain, projectId);
    // A project that has never configured one is not an error — it is the normal "off" state.
    return c.json(audience ?? { project_id: projectId, enabled: false, filters: {}, cadence: DEFAULT_AUDIENCE_CADENCE });
  });

  app.put("/v1/gtm/audience", async (c) => {
    const projectId = deps.writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    if (!deps.inScope(deps.accessible(c), projectId)) return c.json({ error: "unknown project" }, 404);
    const b = (await c.req.json().catch(() => ({}))) as {
      enabled?: boolean;
      filters?: AudienceFilters;
      cadence?: Cadence;
      connection_id?: string;
      calendar_url?: string;
      booking_provider?: string;
      booking_hook_secret?: string;
    };
    // A named connection must belong to this project — the loop will outreach from it.
    if (b.connection_id) {
      const conn = await deps.getConnection(b.connection_id);
      if (!conn || !deps.inScope(deps.accessible(c), conn.project_id)) return c.json({ error: "unknown connection" }, 404);
      if (conn.project_id !== projectId) return c.json({ error: "that account belongs to another project" }, 403);
    }
    const cadence = b.cadence ?? DEFAULT_AUDIENCE_CADENCE;
    const audience = await saveAudience(domain, projectId, {
      enabled: b.enabled,
      filters: b.filters,
      cadence,
      connection_id: b.connection_id,
      calendar_url: b.calendar_url,
      booking_provider: b.booking_provider,
      booking_hook_secret: b.booking_hook_secret,
    });
    // Enabling wires the recurring schedule; disabling removes it. One switch, one timer.
    if (audience.enabled) await ensureAudienceSchedule(domain, projectId, audience.cadence);
    else await removeAudienceSchedule(domain, projectId);
    return c.json(audience);
  });

  /**
   * Propose a campaign. Writes the record, the full-copy artifact and ONE approval — and returns
   * immediately. Nothing is sent until a human approves, and nothing blocks while they think.
   */
  app.post("/v1/gtm/campaigns", async (c) => {
    const projectId = deps.writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    const b = (await c.req.json().catch(() => ({}))) as {
      connection_id?: string;
      name?: string;
      prospects?: ProspectDraft[];
      steps?: SequenceStep[];
      valid_days?: number;
      calendar_url?: string;
    };
    if (!b.connection_id || !b.name || !b.prospects?.length) {
      return c.json({ error: "connection_id, name and at least one prospect are required" }, 400);
    }
    const conn = await deps.getConnection(b.connection_id);
    if (!conn || !deps.inScope(deps.accessible(c), conn.project_id)) return c.json({ error: "unknown connection" }, 404);
    if (conn.project_id !== projectId) return c.json({ error: "that account belongs to another project" }, 403);

    // The proposal is itself a task: it is what the approval and the artifact hang off, and it is
    // where the timeline of this campaign begins.
    const iso = new Date().toISOString();
    const task: Task = {
      id: randomUUID(),
      project_id: projectId,
      // The wedge that DECLARES the outreach role, not a directory name. The middleware above
      // guarantees there is one, so this cannot throw here.
      wedge: gtmWedge(),
      task_type: "propose_campaign",
      actor: { kind: "user", id: "member" },
      input: { name: b.name, prospects: b.prospects.length },
      constraints: { max_runtime_s: 60, max_cost_usd: 0, approval_required: true },
      tools: [],
      status: "awaiting_approval",
      cost_usd: 0,
      created_at: iso,
      updated_at: iso,
    };
    await store.createTask(task);

    try {
      const { campaign, approval_id } = await proposeCampaign(store, domain, {
        task_id: task.id,
        project_id: projectId,
        connection_id: b.connection_id,
        name: b.name,
        prospects: b.prospects,
        steps: b.steps,
        valid_days: b.valid_days,
        calendar_url: b.calendar_url,
      });
      // Through the same enrolment helper the standalone route uses, so the "one case per prospect
      // per campaign" invariant is enforced in ONE place. A caller who posts the same prospect twice
      // in one body used to get two cases, i.e. two parallel sequences at one person.
      const enrolment = await enrolProspects(store, domain, campaign, b.prospects);
      // The ticker is created here rather than at boot: a project that has never run a campaign
      // does not need a schedule waking up every five minutes on its behalf.
      await ensureSequenceSchedule(domain, projectId);
      return c.json(
        {
          campaign_id: campaign.id,
          approval_id,
          artifact_id: campaign.artifact_id,
          task_id: task.id,
          cases: enrolment.enrolled,
          duplicates: enrolment.already,
          unkeyable: enrolment.unkeyable,
        },
        201,
      );
    } catch (e) {
      await store.setStatus(task.id, "failed", String((e as Error)?.message ?? e));
      if (e instanceof CampaignError) return c.json({ error: e.message }, 400);
      throw e;
    }
  });

  /**
   * "Draft for me" — ONE model call that writes a short, human first message, grounded in what this
   * founder sells and who the campaign is reaching. The founder edits whatever it returns.
   *
   * A 200 either way. `{ ok: true, message }` when the model wrote a line; `{ ok: false }` when
   * there was nothing to ground on, no org, or the proxy was unreachable — the composer degrades to
   * the founder writing their own, and a red error box over a nice-to-have would be the wrong shape.
   */
  app.post("/v1/gtm/draft-message", async (c) => {
    const projectId = deps.writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    if (!deps.inScope(deps.accessible(c), projectId)) return c.json({ error: "unknown project" }, 404);
    const b = (await c.req.json().catch(() => ({}))) as { audience?: string; offer?: string };
    const orgId = (c.get("scope") as AuthScope | undefined)?.org_id;
    const shape = await readBusinessShape(store, projectId);
    const message = await draftFirstMessage({
      orgId,
      audience: b.audience,
      // A founder-provided offer overrides the shape's, for a campaign about one specific thing.
      sells: b.offer?.trim() || shape.sells,
      sells_to: shape.sells_to,
      name: shape.name,
    });
    /**
     * `{ ok: false }` WITH A REASON, because three unrelated failures shared one silent boolean.
     *
     * A 200 either way is right — the composer degrades to the founder writing their own, and a red
     * error box over a nice-to-have would be the wrong shape. But the founder was told nothing, and
     * neither was anybody debugging it: "we do not know what you sell yet" is something they can
     * fix in a minute, "the model is unreachable" is not theirs to fix at all, and the two arrived
     * identically.
     *
     * Found by driving the loop end to end: the run stopped here on `200 {"ok":false}` and the
     * response could not say which of the three it was.
     */
    if (message) return c.json({ ok: true, message });
    const reason = !orgId
      ? "this business has no organisation behind it, so there is no model budget to draft with"
      : !(b.offer?.trim() || shape.sells) && !b.audience
        ? "nothing to ground on yet — describe what you sell, or name the audience for this campaign"
        : "the model could not be reached just now; write the first line yourself and it will learn from it";
    return c.json({ ok: false, reason });
  });

  /**
   * Per-person campaign copy — the `draft_campaign_copy` job, run at propose time.
   *
   * This is the richer path the composer was missing. `draft-message` writes ONE opener pasted onto
   * everyone; this writes a DISTINCT message for each prospect, grounded in that person's own role,
   * company and city on top of what the founder sells. The founder's typed line arrives as `goal` —
   * the intent of the campaign — and is used as guidance, never sent verbatim to all.
   *
   * A 200 either way, per-person fail-soft: a prospect the model gives nothing for comes back with no
   * `message`, and the composer leaves that row for the founder to write. Nothing is sent here.
   */
  app.post("/v1/gtm/draft-campaign", async (c) => {
    const projectId = deps.writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    if (!deps.inScope(deps.accessible(c), projectId)) return c.json({ error: "unknown project" }, 404);
    const b = (await c.req.json().catch(() => ({}))) as {
      goal?: string;
      offer?: string;
      prospects?: ProspectWorld[];
    };
    if (!Array.isArray(b.prospects) || !b.prospects.length) {
      return c.json({ error: "no prospects to draft for" }, 400);
    }
    const orgId = (c.get("scope") as AuthScope | undefined)?.org_id;
    const shape = await readBusinessShape(store, projectId);
    // A hard cap so a mistyped list cannot fan out into an unbounded run of model calls.
    const prospects = b.prospects.filter((p) => p?.profile_id).slice(0, 100);
    const drafts = await draftPerProspect({
      orgId,
      prospects,
      goal: b.goal,
      sells: b.offer?.trim() || shape.sells,
      sells_to: shape.sells_to,
      name: shape.name,
    });
    return c.json({ ok: true, drafts });
  });

  app.get("/v1/gtm/campaigns/:id", async (c) => {
    const projectId = deps.writeProjectId(c);
    const campaign = await loadCampaign(domain, projectId, c.req.param("id") ?? "");
    if (!campaign || !deps.inScope(deps.accessible(c), campaign.project_id)) return c.json({ error: "not found" }, 404);
    const approval = await store.getApproval(campaign.approval_id);
    return c.json({ ...campaign, approval_status: approval?.status ?? "missing" });
  });

  const decide = (decision: "approved" | "rejected") => async (c: any) => {
    const projectId = deps.writeProjectId(c);
    const campaign = await loadCampaign(domain, projectId, c.req.param("id") ?? "");
    if (!campaign || !deps.inScope(deps.accessible(c), campaign.project_id)) return c.json({ error: "not found" }, 404);
    const approval = await store.getApproval(campaign.approval_id);
    if (!approval) return c.json({ error: "not found" }, 404);
    // Only the first transition off "pending" wins — the same no-TOCTOU rule the task gate uses.
    if (approval.status !== "pending") return c.json({ error: `already ${approval.status}` }, 409);
    await store.setApproval(campaign.approval_id, decision);
    await store.setStatus(campaign.task_id, decision === "approved" ? "succeeded" : "rejected");
    await audit({
      project_id: campaign.project_id,
      actor: "member",
      action: decision === "approved" ? "approval.granted" : "approval.rejected",
      entity: "task",
      entity_id: campaign.task_id,
      detail: { campaign_id: campaign.id, approval_id: campaign.approval_id, prospects_scope: campaign.connection_id },
    });

    /**
     * ═══════════════════════════════════════════════════════════════════════════════════════════
     * THE SECOND DOOR A HUMAN DECISION COMES THROUGH — AND IT WAS LEARNING NOTHING
     * ═══════════════════════════════════════════════════════════════════════════════════════════
     *
     * `recordApprovalOutcome` is what turns a decision into knowledge: the observation saying whether
     * the agent got it right, and the scoped rule the next run retrieves. It was moved onto
     * `POST /v1/approvals/:id/approve` on 6 September, after the discovery that capturing it inside
     * the waiting run meant it never fired — a founder who decides two hours later decides after a
     * deploy has killed the run that was waiting.
     *
     * That fix moved it to "where a human decision enters the system". THIS is the other place a
     * human decision enters the system, and the capture did not move here. The separation is correct
     * and deliberate — see the header: a campaign has nobody blocked on purpose, so the waiter route
     * answers 409 — but the capture followed the reason for the split instead of following the
     * decision.
     *
     * Measured 2026-09-10: `observations` held ZERO rows, and all 22 rules in production were stamped
     * `"source": "onboarding"`. The only two human approvals since the September fix were campaigns,
     * and both came through here. Across the product's entire history nothing has ever been learned
     * from a correction, while the landing page says "you correct it once, and it stops needing you".
     *
     * Knowledge capture is orthogonal to whether a run is blocked. Any door a person decides through
     * has to file the lesson, or the door is a hole in the only compounding asset this product has.
     */
    const task = await store.getTask(campaign.task_id).catch(() => undefined);
    if (!task) {
      /*
        NO TASK, NO LESSON — and deliberately not a default of `""`.

        `wedge` and `task_type` are how a lesson is SCOPED, and scope is what stops an old note about
        a different service competing on equal terms with this client's correction from last week.
        Filing against an empty wedge does not preserve the lesson, it pollutes retrieval for every
        service in the project with a rule that matches nothing and ranks against everything.
      */
      console.error(`[mycel] campaign ${campaign.id} decided but its task could not be read — no lesson filed`);
    } else {
      /*
        Fail-soft, for the same reason the other call site is: the founder has decided and the
        campaign is live. Failing their approval because a lesson could not be filed trades the job
        for the note.
      */
      await recordApprovalOutcome(getKnowledgeStore(), {
        project_id: campaign.project_id,
        wedge: task.wedge,
        task_type: task.task_type,
        action: approval.action,
        decision,
        proposed: (approval.preview ?? {}) as Record<string, unknown>,
        task_id: campaign.task_id,
        approval_id: campaign.approval_id,
      }).catch((e) => console.error("[mycel] could not distil a campaign approval:", e));
    }

    return c.json({ ok: true, campaign_id: campaign.id, decision });
  };
  app.post("/v1/gtm/campaigns/:id/approve", decide("approved"));
  app.post("/v1/gtm/campaigns/:id/reject", decide("rejected"));

  /**
   * ═══ STOP THIS CAMPAIGN ═══
   *
   * There was no way to. `Campaign` carried steps, an approval, an expiry and a calendar link, and
   * `advanceCase` checked that the campaign existed, had a step, passed cadence and had a connection
   * — it never asked whether the founder still wanted it running. The only stops available were
   * revoking the approval envelope and waiting for `expires_at`.
   *
   * For a product whose whole pitch is "nothing reaches anyone until you approve it", *stop this*
   * having no button is the sharpest contradiction in the codebase, and the window matters: the
   * sequencer ticks every few minutes, so a founder who spots bad copy has minutes, not hours.
   *
   * Two routes rather than one with a body field. `POST …/pause` and `POST …/resume` are what a
   * button calls, they read correctly in an audit log, and neither can be got wrong by sending the
   * wrong string.
   */
  const setStatus = (status: "active" | "paused") => async (c: any) => {
    const projectId = deps.writeProjectId(c);
    const existing = await loadCampaign(domain, projectId, c.req.param("id") ?? "");
    if (!existing || !deps.inScope(deps.accessible(c), existing.project_id)) return c.json({ error: "not found" }, 404);
    const b = (await c.req.json().catch(() => ({}))) as { reason?: unknown };
    const reason = typeof b.reason === "string" ? b.reason : undefined;
    const campaign = await setCampaignStatus(domain, projectId, existing.id, status, reason);
    if (!campaign) return c.json({ error: "not found" }, 404);
    await audit({
      project_id: existing.project_id,
      actor: "member",
      action: status === "paused" ? "campaign.paused" : "campaign.resumed",
      entity: "task",
      entity_id: existing.task_id,
      detail: { campaign_id: existing.id, ...(reason ? { reason } : {}) },
    });
    return c.json({ ok: true, campaign_id: campaign.id, status: campaign.status ?? "active" });
  };
  app.post("/v1/gtm/campaigns/:id/pause", setStatus("paused"));
  app.post("/v1/gtm/campaigns/:id/resume", setStatus("active"));

  /**
   * Find prospects. A READ: it changes nothing on LinkedIn, so there is no approval on this path.
   *
   * What it leaves behind is the point — every person found is written into the `people` collection
   * under their public identifier, and the employers named on the cards become stub `companies`
   * rows. That is what fills the CRM screens, and it is why this returns a summary rather than a
   * blob: the rows are the artifact, the response is just the receipt.
   */
  app.post("/v1/gtm/prospects/search", async (c) => {
    const projectId = deps.writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    const b = (await c.req.json().catch(() => ({}))) as {
      connection_id?: string;
      query?: string;
      title?: string;
      company?: string;
      location?: string;
      industries?: string[];
      keywords?: string;
      limit?: number;
      start?: number;
      case_id?: string;
    };
    if (!b.query && !b.title && !b.company && !(b.industries && b.industries.length) && !b.keywords) {
      // Voyager needs keywords; an empty search returns an empty page and looks like a bug.
      return c.json({ error: "give the search something to go on: query, title or company" }, 400);
    }

    // Search creates a task via the store (not POST /v1/tasks), so the plan gate on that route
    // never runs. Refuse here with the same sentence — unpaid look-around must not look live.
    const orgId = (c.get("scope") as AuthScope | undefined)?.org_id;
    const planStatus = orgId ? getIdentityStore().workBlockedBy(orgId) : null;
    if (planStatus) {
      return c.json(
        {
          error:
            planStatus === "none"
              ? "this business doesn't have a subscription yet — start a plan to find people. Everything already here stays where it is."
              : "your subscription ended, so finding people is paused. Everything already here stays where it is, and starting a plan again resumes it.",
          code: "plan_inactive",
          plan_status: planStatus,
        },
        402,
      );
    }

    // Enrich-first: a LinkedIn seat is for sending. FullEnrich web discovery finds people without
    // touching the member session. Require a connection only when we would need Voyager fallback.
    let conn: Connection | null = null;
    if (b.connection_id) {
      const found = await deps.getConnection(b.connection_id);
      if (!found || !deps.inScope(deps.accessible(c), found.project_id)) return c.json({ error: "unknown connection" }, 404);
      if (found.project_id !== projectId) return c.json({ error: "that account belongs to another project" }, 403);
      conn = found;
    } else if (!fullEnrichConfigured() && !serperConfigured()) {
      return c.json(
        {
          error:
            "Connect a LinkedIn account to search, or configure search so people can be found without one.",
        },
        400,
      );
    }

    const r = await findProspects(store, domain, conn, {
      ...b,
      connection_id: b.connection_id,
      project_id: projectId,
    });
    // A named quota is 429, not 502: nothing is broken and retrying will not help. Anything else
    // that failed is LinkedIn or the transport, which is a gateway problem.
    const status = r.ok ? 200 : r.code === "linkedin_commercial_search_limit" ? 429 : 502;
    return c.json(r, status);
  });

  /**
   * Enrol people from the graph into a campaign: one Case each, at stage `queued`.
   *
   * Only into a campaign the founder has not yet decided — see `enrolProspects` for why a decided
   * list must not grow. Cases enrolled this way carry no copy, so message steps will park rather
   * than improvise; warm-ups and bare invitations run normally.
   */
  app.post("/v1/gtm/campaigns/:id/enrol", async (c) => {
    const projectId = deps.writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    const campaign = await loadCampaign(domain, projectId, c.req.param("id") ?? "");
    if (!campaign || !deps.inScope(deps.accessible(c), campaign.project_id)) return c.json({ error: "not found" }, 404);
    const b = (await c.req.json().catch(() => ({}))) as { profile_ids?: string[]; prospects?: ProspectDraft[] };

    // Either a list of identifiers (hydrated from the graph, which is the normal path after a
    // search) or full drafts with copy (what `propose` passes).
    const prospects = b.prospects?.length
      ? b.prospects
      : await prospectsFromGraph(domain, projectId, b.profile_ids ?? []);
    if (!prospects.length) {
      return c.json({ error: "none of those people are in this project's graph — search for them first" }, 400);
    }
    const r = await enrolProspects(store, domain, campaign, prospects);
    await ensureSequenceSchedule(domain, projectId);
    return c.json(r, r.enrolled || r.already ? 200 : 409);
  });

  /** Who is in a campaign and where they have got to. The pipeline, read back. */
  app.get("/v1/gtm/campaigns/:id/cases", async (c) => {
    const projectId = deps.writeProjectId(c);
    const campaign = await loadCampaign(domain, projectId, c.req.param("id") ?? "");
    if (!campaign || !deps.inScope(deps.accessible(c), campaign.project_id)) return c.json({ error: "not found" }, 404);
    const cases = await casesForCampaign(domain, campaign.project_id, campaign.id);
    return c.json({
      campaign_id: campaign.id,
      cases: cases.map((k) => {
        const d = (k.data ?? {}) as Record<string, unknown>;
        return {
          case_id: k.id,
          profile_id: d.profile_id,
          name: k.title,
          stage: k.stage,
          status: k.status,
          due_at: k.due_at,
          paused_reason: d.paused_reason,
        };
      }),
    });
  });

  /**
   * Resolve email addresses for people already in this project's graph.
   *
   * SEPARATE FROM SEARCH for the PAID hop. Search runs the free half of the same waterfall
   * (pattern + MX, then a public-page scrape) so the faces land with whatever we can get for
   * nothing. FullEnrich is the one call that spends per row, and that still waits for this
   * route — or for enrolment — rather than firing on look-around.
   *
   * 501 when no resolver is configured, and that is the correct code rather than 500: nothing is
   * broken, a capability is simply not installed. `FULLENRICH_API_KEY` is unset in every environment
   * as this ships (see gtm/enrich.ts), so this is the answer a founder gets today, and it names the
   * variable so it is actionable rather than mysterious.
   */
  app.post("/v1/gtm/prospects/enrich", async (c) => {
    const projectId = deps.writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    if (!deps.inScope(deps.accessible(c), projectId)) return c.json({ error: "unknown project" }, 404);
    if (!enrichmentConfigured()) {
      return c.json(
        {
          error: "email enrichment is not configured",
          detail: `set ${FIRECRAWL_KEY_ENV} to crawl public company pages, or ${FULLENRICH_KEY_ENV} for the paid waterfall. Everything else in GTM runs on the LinkedIn session.`,
        },
        501,
      );
    }
    const b = (await c.req.json().catch(() => ({}))) as { profile_ids?: string[]; case_id?: string };
    const targets = await enrichableFromGraph(domain, projectId, b.profile_ids ?? []);
    if (!targets.length) {
      return c.json({ error: "none of those people are in this project's graph, or they all have an address already" }, 400);
    }
    const r = await enrichEmails(domain, { project_id: projectId, case_id: b.case_id }, targets);
    return c.json(r, r.ok ? 200 : 502);
  });

  /** Run one tick now. The schedule does this every five minutes; this is for a founder in a hurry. */
  app.post("/v1/gtm/tick", async (c) => {
    const projectId = deps.writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    return c.json(await advanceSequences(store, domain, { project_id: projectId }));
  });

  /**
   * Queue a post-reply DM for human approval. Outside the campaign envelope on purpose — see
   * `gtm/reply.ts`. Nothing is sent by this route.
   */
  app.post("/v1/gtm/cases/:id/propose-reply", async (c) => {
    const projectId = deps.writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    const kase = await domain.getCase(c.req.param("id") ?? "");
    // Three checks, not one: the case exists, it is in the project this request names, and the
    // caller can reach that project at all. A case id is a bare uuid — the only thing standing
    // between one tenant and another's prospect list is this line.
    if (!kase || kase.project_id !== projectId || !deps.inScope(deps.accessible(c), kase.project_id)) {
      return c.json({ error: "not found" }, 404);
    }
    const b = (await c.req.json().catch(() => ({}))) as { body?: string; connection_id?: string };
    const data = (kase.data ?? {}) as Record<string, unknown>;
    const connectionId =
      (typeof b.connection_id === "string" && b.connection_id) ||
      (typeof data.connection_id === "string" ? data.connection_id : "");
    if (!connectionId) return c.json({ error: "connection_id is required" }, 400);
    const conn = await deps.getConnection(connectionId);
    if (!conn || !deps.inScope(deps.accessible(c), conn.project_id)) return c.json({ error: "unknown connection" }, 404);
    if (conn.project_id !== projectId) return c.json({ error: "that account belongs to another project" }, 403);
    try {
      return c.json(
        await proposeReply(store, domain, {
          project_id: projectId,
          kase,
          connection: conn,
          body: String(b.body ?? ""),
        }),
        201,
      );
    } catch (e) {
      if (e instanceof ReplyError) return c.json({ error: e.message }, 400);
      throw e;
    }
  });

  /**
   * "Draft a proposal" — the closer asset after a prospect REPLIES. ONE model call turns what the
   * founder sells plus the little we honestly know about the person who answered into a short,
   * personalised one-pager, rendered through the SAME branded report renderer the fulfillment path
   * uses, and stored as an artifact against this case's project for the founder to review and send.
   *
   * DRAFTS ONLY. Nothing is sent — same safety posture as propose-reply. A 200 either way:
   * `{ ok: true, artifact_id }` when a document was drafted and stored, `{ ok: false }` when there
   * was nothing to ground on, no org, no brand kit, or the proxy was unreachable.
   */
  app.post("/v1/gtm/cases/:id/draft-proposal", async (c) => {
    const projectId = deps.writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    const kase = await domain.getCase(c.req.param("id") ?? "");
    // Three checks, exactly as propose-reply: the case exists, it is in the named project, and the
    // caller can reach that project at all. A case id is a bare uuid.
    if (!kase || kase.project_id !== projectId || !deps.inScope(deps.accessible(c), kase.project_id)) {
      return c.json({ error: "not found" }, 404);
    }

    // The prospect facts, read off the case and the graph — never invented. Name comes off the case;
    // headline and company come off the `people` row the search wrote, keyed by profile_id.
    const data = (kase.data ?? {}) as Record<string, unknown>;
    const profileId = typeof data.profile_id === "string" ? data.profile_id.trim() : "";
    let headline: string | undefined;
    let company: string | undefined;
    if (profileId) {
      const rows = await domain
        .queryRecords({ project_id: projectId, wedge: gtmWedge(), collection: PEOPLE_COLLECTION, where: { profile_id: profileId }, limit: 1 })
        .catch(() => []);
      const person = (rows[0]?.data ?? {}) as Record<string, unknown>;
      headline = typeof person.headline === "string" ? person.headline : undefined;
      company = typeof person.company === "string" ? person.company : undefined;
    }
    const prospect = {
      name: (typeof data.name === "string" && data.name) || kase.title || undefined,
      company,
      headline,
    };

    const orgId = (c.get("scope") as AuthScope | undefined)?.org_id;
    const shape = await readBusinessShape(store, projectId);
    const doc = await draftProposal({ orgId, prospect, sells: shape.sells, sells_to: shape.sells_to, name: shape.name });
    /**
     * A REASON, for the same argument as `/v1/gtm/draft-message` above.
     *
     * `{ ok: false }` on its own is three unrelated failures wearing one boolean: no org behind the
     * business, nothing describing what it sells, or the model being unreachable. The first two the
     * founder can fix in a minute and the third is not theirs to fix at all — and they arrived
     * identically. Found by driving the loop end to end, where the run stopped here on
     * `200 {"ok":false}` and could say nothing more.
     */
    if (!doc) {
      return c.json({
        ok: false,
        reason: !orgId
          ? "this business has no organisation behind it, so there is no model budget to draft with"
          : !shape.sells
            ? "nothing to ground a proposal on — describe what this business sells first"
            : "the model could not be reached just now; try again, or write the proposal yourself",
      });
    }

    // Render through the SAME pipeline the fulfillment deliverable path uses: resolve the project's
    // brand kit (fails closed on an unknown project, so nothing renders under house branding), render
    // to a branded PDF, and store it through the same artifact backend, keyed to this case's task.
    const kit = getIdentityStore().brandKit(projectId);
    // Fails closed rather than rendering somebody's proposal under house branding — but it says so.
    if (!kit) return c.json({ ok: false, reason: "this business has no brand kit yet, and a proposal must not go out under Mycel's branding" });
    const rendered = render("report", doc, kit);

    // The proposal is its own task — the thing the artifact hangs off, and what the founder-facing
    // download route authorises through (`GET /v1/artifacts/:id` resolves the artifact's task and
    // checks project scope). It succeeds on creation: it drafted and stored, and nothing sends.
    const iso = new Date().toISOString();
    const task: Task = {
      id: randomUUID(),
      project_id: projectId,
      wedge: gtmWedge(),
      task_type: "draft_proposal",
      case_id: kase.id,
      actor: { kind: "user", id: "member" },
      input: { case_id: kase.id, title: doc.title },
      constraints: { max_runtime_s: 60, max_cost_usd: 0, approval_required: false },
      tools: [],
      status: "succeeded",
      cost_usd: 0,
      created_at: iso,
      updated_at: iso,
    };
    await store.createTask(task);

    const backend = await getArtifactBackend();
    const art = await store.addArtifact({
      task_id: task.id,
      name: rendered.name,
      content_type: rendered.content_type,
      content: backend.inline ? rendered.content : "",
      encoding: rendered.encoding,
      size_bytes: rendered.size_bytes,
      source: "agent",
      client_id: kase.client_id,
    });
    if (!backend.inline) await backend.put(art.id, rendered.content);

    return c.json({ ok: true, artifact_id: art.id, task_id: task.id });
  });

  /**
   * Settle a queued reply. Approving EXECUTES the send here, because there is no in-process waiter
   * to wake — same shape as campaign approval, and the reason `POST /v1/approvals/:id/approve`
   * cannot be reused for either.
   */
  const settleReply = (decision: "approved" | "rejected") => async (c: any) => {
    const projectId = deps.writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    if (!deps.inScope(deps.accessible(c), projectId)) return c.json({ error: "unknown project" }, 404);
    const b =
      decision === "approved"
        ? ((await c.req.json().catch(() => ({}))) as { edited_body?: string })
        : {};
    try {
      return c.json(
        await decideReply(store, domain, {
          project_id: projectId,
          approval_id: c.req.param("approvalId") ?? "",
          decision,
          edited_body: b.edited_body,
          getConnection: deps.getConnection,
        }),
      );
    } catch (e) {
      // 502, not 400. The founder's approval was accepted and recorded; LinkedIn is what failed,
      // and calling that a bad request would have the product tell them they did something wrong.
      if (e instanceof ReplySendError) {
        return c.json({ error: e.message, approved: true, sent: false, approval_id: e.approval_id }, 502);
      }
      if (e instanceof ReplyError) return c.json({ error: e.message }, 400);
      throw e;
    }
  };
  app.post("/v1/gtm/replies/:approvalId/approve", settleReply("approved"));
  app.post("/v1/gtm/replies/:approvalId/reject", settleReply("rejected"));

  /**
   * Search outward from the people who actually bought. A READ, like `prospects/search`: it fills
   * the graph and returns a list, and enrolling any of them is still a separate approved campaign.
   */
  app.post("/v1/gtm/prospects/lookalike", async (c) => {
    const projectId = deps.writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    const b = (await c.req.json().catch(() => ({}))) as { connection_id?: string; limit?: number };
    if (!b.connection_id) return c.json({ error: "connection_id is required" }, 400);
    const conn = await deps.getConnection(b.connection_id);
    if (!conn || !deps.inScope(deps.accessible(c), conn.project_id)) return c.json({ error: "unknown connection" }, 404);
    if (conn.project_id !== projectId) return c.json({ error: "that account belongs to another project" }, 403);
    const r = await expandLookalikes(store, domain, conn, { project_id: projectId, limit: b.limit });
    // "You have no wins yet" is a 200 with a sentence, not an error: nothing failed, the feature
    // simply has nothing to work from, and answering 4xx would have the UI show a red box for the
    // normal state of a new account.
    //
    // A TENANCY REFUSAL IS NOT THAT, and it used to be served as exactly that. `expandLookalikes`
    // re-checks the project itself (defence in depth, correctly) and returned `ok: false` with no
    // `task_id` — the same shape as the empty state — so a cross-tenant attempt came back as a
    // plain 200. It now carries `code: "wrong_project"` and is answered 403, matching the check
    // above it. Two cross-tenant leaks have shipped in this repo; one that answers 200 is one
    // nobody would ever see in a log.
    if (r.code === "wrong_project") return c.json(r, 403);
    // A graph write that lost everything it found is a real failure and must not read as an empty
    // result — see `findProspects`, which this shares its result shape with.
    if (r.code === "graph_write_failed") return c.json(r, 502);
    return c.json(r, r.ok ? 200 : r.task_id ? 502 : 200);
  });

  /**
   * Ingest signal-tagged people (hiring / job change / open to work). Graph only — no case, no
   * campaign, no outreach. What it buys is "why them, why now" being evidence on a row rather than
   * an assertion in a message.
   */
  app.post("/v1/gtm/prospects/signals", async (c) => {
    const projectId = deps.writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    if (!deps.inScope(deps.accessible(c), projectId)) return c.json({ error: "unknown project" }, 404);
    const b = (await c.req.json().catch(() => ({}))) as {
      people?: Array<{ profile_id?: string; name?: string; headline?: string; text?: string }>;
    };
    const hits: SignalHit[] = [];
    for (const p of b.people ?? []) {
      const detected = detectSignals(p.text ?? p.headline ?? "");
      if (!detected || !p.profile_id?.trim()) continue;
      hits.push({
        profile_id: p.profile_id.trim(),
        name: p.name,
        headline: p.headline,
        signal: detected.signal,
        evidence: detected.evidence,
      });
    }
    // Zero hits is a real answer, and naming it is the point: "none of these people said anything
    // that reads as a signal" is information, whereas a silent `{written: 0}` looks like a bug.
    const r = await ingestSignals(domain, projectId, hits);
    /**
     * `ok` is COMPUTED, not asserted. It was hardcoded `true`, which meant a run that detected
     * twelve signals and wrote none of them still answered `ok: true` — the same shape as the
     * genuine "nobody said anything signal-shaped" answer, and indistinguishable from it. Zero hits
     * is a real success; zero writes from a non-zero set of hits is not.
     */
    const ok = hits.length === 0 || r.written > 0;
    return c.json({ ok, considered: b.people?.length ?? 0, ...r }, ok ? 200 : 502);
  });
}
