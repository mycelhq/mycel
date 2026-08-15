// The AUTONOMOUS GTM loop: a business that finds its own prospects and proposes its own campaigns,
// so the founder only has to APPROVE — instead of clicking Search → Draft → Propose in the composer
// on a schedule they have to remember to keep.
//
// WHAT THIS DOES, AND — MORE IMPORTANTLY — WHAT IT DOES NOT.
//
// It automates the two READ/DRAFT steps at the front of outreach and nothing past them:
//
//   1. FIND. FullEnrich people-discovery (gtm/discover-web.ts) from a STORED audience — the founder's
//      standing "who to reach" filters. This spends no LinkedIn search quota and costs a few credits,
//      which is the entire reason it is safe to run unattended (see the note on `webDiscoverPeople`).
//   2. PROPOSE. If the find turned up people the project has not seen before, draft ONE grounded
//      opener and raise a normal `propose_campaign` approval — the SAME envelope a manual propose
//      creates. It lands in the founder's Approvals and NOTHING is sent until they approve it.
//
// Every actual outbound touch still waits for the founder's approval envelope, unchanged. This loop
// never approves a campaign, never sends a message, never widens a consent. It is discovery and a
// draft; the human is still the only thing that can put a message on the wire.
//
// SAFETY POSTURE, stated so it can be checked:
//   · IDEMPOTENT. A double-fire within one cadence window must not raise two proposals for the same
//     batch. We dedupe on the audience + a TIME BUCKET (`bucketKey`): once a bucket has run, the
//     second fire in that bucket is a clean no-op. This is the "run ceiling" for this loop — at most
//     one proposal per audience per window, a bound nobody can raise from a payload.
//   · FAILS SOFT. A discovery hiccup (proxy down, FullEnrich 5xx) SKIPS this tick, logged, and never
//     wedges the schedule — the next window tries again. It never throws to the scheduler.
//   · HONEST NO-OP. FullEnrich unconfigured, audience disabled/empty, no connection, or nobody new
//     found → the tick does nothing and says why, and the scheduler records no phantom "work".
import { randomUUID } from "node:crypto";
import type { Cadence, Connection, Task } from "../contract";
import type { DomainStore } from "../domain";
import { emitEvent } from "../events";
import { getIdentityStore } from "../identity";
import type { Store } from "../store";
import {
  CampaignError,
  proposeCampaign,
  type ProspectDraft,
} from "./campaign";
import { webDiscoverPeople } from "./discover-web";
import { draftFirstMessage } from "./draft-message";
import { fullEnrichConfigured } from "./enrich";
import { enrolProspects, findProspects, type FindProspectsResult } from "./prospects";
import { gtmWedge } from "./stages";

/**
 * The scheduler task type for one turn of the loop. Declared in wedges/gtm-operator/wedge.json so a
 * Schedule may name it, and matched in scheduler.ts to `runAutonomousGtm` — HARNESS work, not agent
 * work, exactly like `advance_sequences`: the founder's filters are the whole input and there is
 * nothing for a model to decide about running a search.
 */
export const AUTONOMOUS_GTM_TASK_TYPE = "gtm_autonomous";

/** The records collection holding one audience per project. */
export const AUDIENCE_COLLECTION = "gtm_audience";

/** The default cadence when a founder enables the loop without naming one: weekly. */
export const DEFAULT_AUDIENCE_CADENCE: Cadence = { kind: "every", seconds: 7 * 24 * 60 * 60 };

/** Hard cap on people one autonomous find may propose in a single campaign. A blast-radius bound. */
const MAX_PROSPECTS_PER_RUN = 25;

/**
 * The standing target the loop searches for — FullEnrich-style filters the founder sets ONCE, plus
 * the switch and the cadence. This is the "the founder pre-authorised this loop to run" record: it
 * is the only thing that turns the timer on, and disabling it is how the timer comes off.
 */
export interface AudienceFilters {
  titles?: string[];
  location?: string;
  company_industries?: string[];
  keywords?: string;
}

export interface GtmAudience {
  project_id: string;
  enabled: boolean;
  filters: AudienceFilters;
  cadence: Cadence;
  /** The LinkedIn account campaigns run on. When absent the loop uses the project's only account. */
  connection_id?: string;
  /** Booking link the proposed campaign carries to the handoff. Never sent by the sequencer. */
  calendar_url?: string;
  updated_at: string;
  /** IDEMPOTENCY KEY. The last time-bucket a proposal was raised for. See `bucketKey`. */
  last_bucket?: string;
  last_proposed_at?: string;
}

const audienceKey = (projectId: string) => `audience:${projectId}`;

/**
 * A stable string for the cadence window `now` falls in. Two fires in the same window share a
 * bucket, which is the whole dedupe: the loop refuses to propose twice for one window.
 */
export function bucketKey(cadence: Cadence, now: Date): string {
  if (cadence.kind === "every") {
    const ms = Math.max(1, Math.floor(cadence.seconds)) * 1000;
    return `e${Math.floor(now.getTime() / ms)}`;
  }
  if (cadence.kind === "daily") {
    return `d${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}`;
  }
  return `m${now.getUTCFullYear()}-${now.getUTCMonth()}`;
}

// ── storage ──────────────────────────────────────────────────────────────────────────────────────

/** Load a project's audience, if it has one. Scoped — another tenant's audience is not found. */
export async function loadAudience(
  domain: DomainStore,
  projectId: string,
): Promise<GtmAudience | undefined> {
  if (!projectId) return undefined;
  const rows = await domain.queryRecords({
    project_id: projectId,
    wedge: gtmWedge(),
    collection: AUDIENCE_COLLECTION,
    where: { project_id: projectId },
    limit: 1,
  });
  return rows[0] ? (rows[0].data as unknown as GtmAudience) : undefined;
}

/** Write a project's audience, merging over whatever is stored. Returns the merged record. */
export async function saveAudience(
  domain: DomainStore,
  projectId: string,
  patch: Partial<Omit<GtmAudience, "project_id" | "updated_at">>,
  now: Date = new Date(),
): Promise<GtmAudience> {
  if (!projectId) throw new Error("an audience must be scoped to a project");
  const existing = await loadAudience(domain, projectId);
  const merged: GtmAudience = {
    project_id: projectId,
    enabled: patch.enabled ?? existing?.enabled ?? false,
    filters: patch.filters ?? existing?.filters ?? {},
    cadence: patch.cadence ?? existing?.cadence ?? DEFAULT_AUDIENCE_CADENCE,
    connection_id: patch.connection_id ?? existing?.connection_id,
    calendar_url: patch.calendar_url ?? existing?.calendar_url,
    last_bucket: patch.last_bucket ?? existing?.last_bucket,
    last_proposed_at: patch.last_proposed_at ?? existing?.last_proposed_at,
    updated_at: now.toISOString(),
  };
  await domain.upsertRecord({
    project_id: projectId,
    wedge: gtmWedge(),
    collection: AUDIENCE_COLLECTION,
    key: audienceKey(projectId),
    data: merged as unknown as Record<string, unknown>,
  });
  return merged;
}

// ── schedule wiring ──────────────────────────────────────────────────────────────────────────────

/**
 * Turn the loop on: create or re-point the ONE recurring schedule for this project's audience.
 *
 * Reuses the scheduler's Cadence/claim model exactly — there is no second timer. With N replicas
 * `claimDueSchedules` still guarantees exactly one fires each window.
 */
export async function ensureAudienceSchedule(
  domain: DomainStore,
  projectId: string,
  cadence: Cadence,
  now: Date = new Date(),
): Promise<void> {
  if (!projectId) throw new Error("an autonomous GTM schedule must be scoped to a project");
  const { nextRun } = await import("../scheduler");
  const existing = (await domain.listSchedules()).find(
    (s) => s.project_id === projectId && s.task_type === AUTONOMOUS_GTM_TASK_TYPE,
  );
  const next_run_at = nextRun(cadence, now).toISOString();
  if (existing) {
    await domain.updateSchedule(existing.id, { enabled: true, cadence, next_run_at });
    return;
  }
  await domain.createSchedule({
    project_id: projectId,
    name: "autonomous GTM",
    wedge: gtmWedge(),
    task_type: AUTONOMOUS_GTM_TASK_TYPE,
    input: {},
    cadence,
    enabled: true,
    next_run_at,
  });
}

/** Turn the loop off: remove the recurring schedule. Disabling the audience calls this. */
export async function removeAudienceSchedule(domain: DomainStore, projectId: string): Promise<void> {
  if (!projectId) return;
  const existing = (await domain.listSchedules()).find(
    (s) => s.project_id === projectId && s.task_type === AUTONOMOUS_GTM_TASK_TYPE,
  );
  if (existing) await domain.deleteSchedule(existing.id);
}

// ── the loop ─────────────────────────────────────────────────────────────────────────────────────

export interface AutonomousResult {
  /** True when the tick did nothing worth recording — the scheduler's `skipIdle` reads this. */
  idle: boolean;
  found: number;
  /** Prospects the project had never seen, that this run proposed. */
  proposed: number;
  campaign_id?: string;
  approval_id?: string;
  /** Always set — a no-op that cannot say why is indistinguishable from a bug. */
  reason: string;
}

export interface RunAutonomousArgs {
  store: Store;
  domain: DomainStore;
  project_id: string;
  now?: Date;
  /** Discovery seam — defaults to `findProspects`. Injected in tests so the loop runs offline. */
  discover?: (conn: Connection, input: DiscoverInput) => Promise<FindProspectsResult>;
  /** Opener seam — defaults to `draftFirstMessage`. Injected so tests need no model. */
  draft?: typeof draftFirstMessage;
}

interface DiscoverInput {
  project_id: string;
  connection_id: string;
  query?: string;
  title?: string;
  location?: string;
  limit: number;
  actor: Task["actor"];
  now: Date;
}

/** The founder's stored filters → the single `{query,title,location}` `findProspects` takes. */
function filtersToQuery(f: AudienceFilters): { query?: string; title?: string; location?: string } {
  const title = (f.titles ?? []).map((t) => t.trim()).filter(Boolean).join(", ") || undefined;
  const query = f.keywords?.trim() || undefined;
  const location = f.location?.trim() || undefined;
  return { query, title, location };
}

/** A short human label for the audience, for the campaign name and the drafted opener's grounding. */
function audienceLabel(f: AudienceFilters): string {
  return (
    [...(f.titles ?? []), f.keywords, f.location].map((s) => s?.trim()).filter(Boolean).join(" · ") ||
    "your audience"
  );
}

/**
 * One turn of the autonomous loop. Never throws — every failure path returns an idle result with a
 * reason, so the scheduler is never wedged by a bad tick.
 */
export async function runAutonomousGtm(args: RunAutonomousArgs): Promise<AutonomousResult> {
  const { store, domain, project_id } = args;
  const now = args.now ?? new Date();
  const discover = args.discover ?? ((conn, input) => findProspects(store, domain, conn, input));
  const draft = args.draft ?? draftFirstMessage;
  const idle = (reason: string, extra: Partial<AutonomousResult> = {}): AutonomousResult => ({
    idle: true,
    found: 0,
    proposed: 0,
    reason,
    ...extra,
  });

  try {
    if (!project_id) return idle("no project");

    const audience = await loadAudience(domain, project_id);
    if (!audience || !audience.enabled) return idle("audience is disabled or unset");

    const q = filtersToQuery(audience.filters);
    if (!q.query && !q.title && !q.location) return idle("audience has no filters to search on");

    // FullEnrich is what makes unattended discovery safe (no LinkedIn quota). Without it we do NOT
    // fall back to the metered LinkedIn search on a timer — an automated loop must never burn the
    // monthly Commercial Search Limit on the founder's behalf.
    if (!fullEnrichConfigured()) return idle("FullEnrich is not configured — automated discovery is off");

    // IDEMPOTENCY, checked before any spend: one proposal per audience per cadence window.
    const bucket = bucketKey(audience.cadence, now);
    if (audience.last_bucket === bucket) return idle("already ran this cadence window");

    // The account campaigns run on: the audience's, else the project's only LinkedIn connection.
    const conn = await resolveConnection(domain, project_id, audience.connection_id);
    if (!conn) return idle("no LinkedIn account to run outreach on");

    // ── FIND ───────────────────────────────────────────────────────────────────────────────────
    let result: FindProspectsResult;
    try {
      result = await discover(conn, {
        project_id,
        connection_id: conn.id,
        ...q,
        limit: MAX_PROSPECTS_PER_RUN,
        actor: { kind: "system", id: `autonomous-gtm:${project_id}` },
        now,
      });
    } catch (e) {
      // FAIL SOFT: a hiccup skips this tick and is logged. The bucket is NOT consumed, so the next
      // window retries rather than the founder losing a whole cadence to one flaky proxy read.
      console.error("[mycel] autonomous GTM: discovery threw — skipping this tick:", e);
      return idle("discovery error — skipped");
    }
    if (!result.ok) {
      // A named condition (a FullEnrich 5xx, say) is a soft skip too. Do not consume the bucket.
      console.warn(`[mycel] autonomous GTM: discovery not ok (${result.code ?? "?"}): ${result.detail}`);
      return idle(`discovery returned nothing usable (${result.code ?? "no code"})`);
    }

    // NEW people only — the ones the project has no case for yet. Re-proposing people already in a
    // campaign is exactly the double-decision the manual path refuses; the loop must not create it.
    const cases = await domain.listCases({ project_id, wedge: gtmWedge() });
    const known = new Set(
      cases.map((k) => String((k.data as Record<string, unknown> | undefined)?.profile_id ?? "")).filter(Boolean),
    );
    const fresh = result.people.filter((p) => p.profile_id && !known.has(p.profile_id));

    if (fresh.length === 0) {
      // A clean no-op — but the search DID run, so consume the bucket: a double-fire this window must
      // not pay FullEnrich twice for the same empty answer.
      await saveAudience(domain, project_id, { last_bucket: bucket }, now);
      return idle("found nobody new this window", { found: result.found });
    }

    // ── PROPOSE ────────────────────────────────────────────────────────────────────────────────
    // One grounded opener, best-effort. No org / no proxy → undefined, and the campaign is proposed
    // without copy (message steps park rather than improvise — the same rule as enrol-from-graph).
    const orgId = await getIdentityStore().orgIdForProject(project_id).catch(() => undefined);
    const label = audienceLabel(audience.filters);
    let opener: string | undefined;
    try {
      opener = await draft({ orgId, audience: label });
    } catch (e) {
      console.error("[mycel] autonomous GTM: opener draft failed — proposing without copy:", e);
    }
    const copy = opener ? { send_invite: opener, send_message: opener } : undefined;
    const prospects: ProspectDraft[] = fresh.slice(0, MAX_PROSPECTS_PER_RUN).map((p) => ({
      profile_id: p.profile_id,
      name: p.name,
      ...(copy ? { copy } : {}),
    }));

    // The propose is its own task — what the approval and the artifact hang off, exactly as the
    // manual `POST /v1/gtm/campaigns` route does. It sits `awaiting_approval`; nothing sends.
    const iso = now.toISOString();
    const task: Task = {
      id: randomUUID(),
      project_id,
      wedge: gtmWedge(),
      task_type: "propose_campaign",
      actor: { kind: "system", id: `autonomous-gtm:${project_id}` },
      input: { name: `Auto: ${label}`, prospects: prospects.length, autonomous: true },
      constraints: { max_runtime_s: 60, max_cost_usd: 0, approval_required: true },
      tools: [],
      status: "awaiting_approval",
      cost_usd: 0,
      created_at: iso,
      updated_at: iso,
    };
    await store.createTask(task);

    let campaign_id: string;
    let approval_id: string;
    try {
      const proposed = await proposeCampaign(store, domain, {
        task_id: task.id,
        project_id,
        connection_id: conn.id,
        name: `Auto: ${label} · ${now.toISOString().slice(0, 10)}`,
        prospects,
        calendar_url: audience.calendar_url,
      });
      campaign_id = proposed.campaign.id;
      approval_id = proposed.approval_id;
      // Enrol the fresh prospects into the (still-pending) campaign, through the SAME helper the
      // manual route uses — one case per prospect per campaign. Approving the campaign then has real
      // cases for the sequencer to advance; nothing sends until that approval lands.
      await enrolProspects(store, domain, proposed.campaign, prospects, now);
    } catch (e) {
      await store.setStatus(task.id, "failed", String((e as Error)?.message ?? e)).catch(() => {});
      if (e instanceof CampaignError) return idle(`could not propose: ${e.message}`, { found: result.found });
      // Unexpected — soft-skip rather than wedge the schedule.
      console.error("[mycel] autonomous GTM: proposeCampaign threw:", e);
      return idle("propose error — skipped", { found: result.found });
    }

    // Consume the bucket ONLY now that a proposal exists — the idempotency guarantee is "one proposal
    // per window", and the marker is written after the proposal it protects, never before.
    await saveAudience(domain, project_id, { last_bucket: bucket, last_proposed_at: iso }, now);

    // The feed event a founder sees: "found N, proposed a campaign for M new people".
    await emitEvent(store, task.id, "progress", {
      gtm: {
        autonomous: {
          found: result.found,
          proposed: prospects.length,
          campaign_id,
          approval_id,
          audience: label,
        },
      },
    }).catch((e) => console.error("[mycel] autonomous GTM: could not emit feed event:", e));

    return {
      idle: false,
      found: result.found,
      proposed: prospects.length,
      campaign_id,
      approval_id,
      reason: `proposed a campaign for ${prospects.length} new prospect(s)`,
    };
  } catch (e) {
    // The outer net: the whole point of this loop is that a bad tick is a skipped tick, never a dead
    // schedule. Nothing above should reach here, but if it does, we skip softly.
    console.error("[mycel] autonomous GTM: unexpected error — skipping this tick:", e);
    return idle("unexpected error — skipped");
  }
}

/** The account to run on: the named one (if it belongs to the project), else the sole LinkedIn one. */
async function resolveConnection(
  domain: DomainStore,
  projectId: string,
  connectionId?: string,
): Promise<Connection | undefined> {
  const all = (await domain.listConnections()).filter(
    (c) => c.project_id === projectId && c.kind === "linkedin",
  );
  if (connectionId) return all.find((c) => c.id === connectionId);
  // Exactly one is unambiguous; more than one and we refuse to guess which account to outreach from.
  return all.length === 1 ? all[0] : undefined;
}
