/**
 * Pull CRM contacts and calendar events into Mycel — the beachhead twin of payment reconcile.
 *
 * Connect grants the capability; Check now / go-live / the schedule is when we pull. Same honesty
 * rules as payments.ts: project-scoped, founder-owned only, a failed read is a sentence not silence,
 * and confidence is durable so Home can say how old the evidence is.
 */
import type { ActionResult } from "./actions";
import type { Connection, Schedule } from "./contract";
import type { DomainStore } from "./domain";
import { normalizeHandle } from "./domain";
import { readCapability, whyNothingRead } from "./capabilities.read";
import { resolveCapability } from "./capabilities";
import {
  CALENDAR_SHAPES,
  CRM_SHAPES,
  busyIntervals,
  type ObservedContact,
  type ObservedEvent,
} from "./capabilities.normalise";

export const CRM_IMPORT_TASK_TYPE = "import_crm_clients";
export const CALENDAR_SYNC_TASK_TYPE = "sync_calendar";
export const IMPORT_SYNC_SECONDS = 900;
export const IMPORT_STALE_AFTER_HOURS = 26;

const CHECK_WEDGE = "kernel";
const CHECK_COLLECTION = "capability_checks";

export interface ImportDeps {
  listConnections(): Promise<Connection[]>;
  execute(conn: Connection, capability: string, payload: Record<string, unknown>): Promise<ActionResult>;
  domain: DomainStore;
}

let deps: ImportDeps | null = null;

export function setImportDeps(d: ImportDeps | null): void {
  deps = d;
}

export interface CapabilityCheck {
  project_id: string;
  capability: "read_crm" | "read_calendar";
  confirmed_at?: string;
  attempted_at: string;
  ok: boolean;
  detail: string;
  /** Extra facts for the Home line (counts, next busy, …). */
  meta?: Record<string, unknown>;
}

async function recordCheck(check: CapabilityCheck): Promise<void> {
  if (!deps) return;
  await deps.domain.upsertRecord({
    project_id: check.project_id,
    wedge: CHECK_WEDGE,
    collection: CHECK_COLLECTION,
    key: check.capability,
    data: {
      confirmed_at: check.confirmed_at ?? null,
      attempted_at: check.attempted_at,
      ok: check.ok,
      detail: check.detail,
      ...(check.meta ?? {}),
    },
  });
}

async function readCheck(
  projectId: string,
  capability: "read_crm" | "read_calendar",
): Promise<CapabilityCheck | undefined> {
  if (!deps) return undefined;
  const rows = await deps.domain.queryRecords({
    project_id: projectId,
    wedge: CHECK_WEDGE,
    collection: CHECK_COLLECTION,
  });
  const row = rows.find((r) => r.key === capability);
  if (!row) return undefined;
  const d = row.data ?? {};
  return {
    project_id: projectId,
    capability,
    confirmed_at: typeof d.confirmed_at === "string" ? d.confirmed_at : undefined,
    attempted_at: typeof d.attempted_at === "string" ? d.attempted_at : new Date(0).toISOString(),
    ok: d.ok === true,
    detail: typeof d.detail === "string" ? d.detail : "no detail",
    meta: d,
  };
}

export interface CrmImportSummary {
  project_id: string;
  observed: number;
  created: number;
  matched: number;
  skipped: number;
  ok: boolean;
  detail: string;
}

/**
 * Read CRM contacts and upsert Mycel clients by email handle.
 *
 * Matching is by handle only — never by display name. Two contacts with the same name and different
 * emails are two clients; inventing a merge is how chase mail goes to the wrong person.
 */
export async function importCrmClients(args: { project_id: string; now?: Date }): Promise<CrmImportSummary> {
  const projectId = args.project_id;
  if (!projectId) throw new Error("a CRM import must be scoped to a project");
  const now = args.now ?? new Date();
  const base: CrmImportSummary = {
    project_id: projectId,
    observed: 0,
    created: 0,
    matched: 0,
    skipped: 0,
    ok: false,
    detail: "",
  };

  const finish = async (s: CrmImportSummary): Promise<CrmImportSummary> => {
    await recordCheck({
      project_id: projectId,
      capability: "read_crm",
      confirmed_at: s.ok ? now.toISOString() : undefined,
      attempted_at: now.toISOString(),
      ok: s.ok,
      detail: s.detail,
      meta: { observed: s.observed, created: s.created, matched: s.matched, skipped: s.skipped },
    }).catch((e) => console.error(`[mycel] could not record CRM check for ${projectId}:`, e));
    if (!s.ok) console.error(`[mycel] CRM import for project ${projectId} did not run: ${s.detail}`);
    return s;
  };

  if (!deps) {
    return finish({ ...base, detail: "CRM import is not wired up in this deployment" });
  }

  const all = await deps.listConnections();
  const read = await readCapability<ObservedContact>({
    capability: "read_crm",
    project_id: projectId,
    connections: all,
    execute: deps.execute,
    shapes: CRM_SHAPES,
  });

  if (!read.reached) {
    return finish({
      ...base,
      detail: whyNothingRead(read) ?? "nothing was read from the connected CRM",
      skipped: read.skipped.length,
    });
  }

  base.observed = read.items.length;
  base.skipped = read.skipped.length;
  const failures = [...read.failures];

  for (const contact of read.items) {
    const handle = normalizeHandle(contact.email);
    const existing = await deps.domain.findClientByHandle(handle);
    if (existing) {
      // Same project only — a handle match in another tenant must never attach.
      if (existing.project_id && existing.project_id !== projectId) {
        failures.push(`contact ${contact.email} matches a client in another project and was not imported`);
        continue;
      }
      const handles = new Set(existing.handles ?? []);
      handles.add(handle);
      if (contact.phone) handles.add(normalizeHandle(contact.phone));
      await deps.domain.updateClient(existing.id, {
        ...(contact.display_name && !existing.display_name ? { display_name: contact.display_name } : {}),
        handles: [...handles],
        metadata: {
          ...(existing.metadata ?? {}),
          crm_external_id: contact.external_id,
          crm_imported_at: now.toISOString(),
        },
      });
      base.matched++;
      continue;
    }
    await deps.domain.createClient({
      project_id: projectId,
      display_name: contact.display_name || contact.email,
      handles: contact.phone ? [handle, normalizeHandle(contact.phone)] : [handle],
      metadata: {
        crm_external_id: contact.external_id,
        crm_imported_at: now.toISOString(),
      },
      preferences: {},
    });
    base.created++;
  }

  const detailParts = [
    `read ${base.observed} contact(s)`,
    base.created ? `created ${base.created}` : undefined,
    base.matched ? `matched ${base.matched} existing` : undefined,
    base.skipped ? `skipped ${base.skipped}` : undefined,
    failures.length ? failures.slice(0, 3).join("; ") : undefined,
  ].filter(Boolean);

  return finish({
    ...base,
    ok: true,
    detail: detailParts.join(" — ") || "CRM import completed with nothing to do",
  });
}

export interface CalendarSyncSummary {
  project_id: string;
  observed: number;
  busy_next?: string;
  ok: boolean;
  detail: string;
}

/**
 * Read calendar events, persist them as records, and surface the next busy instant for Home.
 */
export async function syncCalendar(args: { project_id: string; now?: Date }): Promise<CalendarSyncSummary> {
  const projectId = args.project_id;
  if (!projectId) throw new Error("a calendar sync must be scoped to a project");
  const now = args.now ?? new Date();
  const base: CalendarSyncSummary = {
    project_id: projectId,
    observed: 0,
    ok: false,
    detail: "",
  };

  const finish = async (s: CalendarSyncSummary): Promise<CalendarSyncSummary> => {
    await recordCheck({
      project_id: projectId,
      capability: "read_calendar",
      confirmed_at: s.ok ? now.toISOString() : undefined,
      attempted_at: now.toISOString(),
      ok: s.ok,
      detail: s.detail,
      meta: { observed: s.observed, busy_next: s.busy_next ?? null },
    }).catch((e) => console.error(`[mycel] could not record calendar check for ${projectId}:`, e));
    if (!s.ok) console.error(`[mycel] calendar sync for project ${projectId} did not run: ${s.detail}`);
    return s;
  };

  if (!deps) {
    return finish({ ...base, detail: "calendar sync is not wired up in this deployment" });
  }

  const all = await deps.listConnections();
  const read = await readCapability<ObservedEvent>({
    capability: "read_calendar",
    project_id: projectId,
    connections: all,
    execute: deps.execute,
    shapes: CALENDAR_SHAPES,
  });

  if (!read.reached) {
    return finish({
      ...base,
      detail: whyNothingRead(read) ?? "nothing was read from the connected calendar",
    });
  }

  base.observed = read.items.length;
  for (const event of read.items) {
    await deps.domain.upsertRecord({
      project_id: projectId,
      wedge: CHECK_WEDGE,
      collection: "calendar_events",
      key: event.external_id,
      data: { ...event },
      observed_at: event.starts_at ?? event.day,
    });
  }

  const upcoming = busyIntervals(read.items).find((b) => Date.parse(b.to) > now.getTime());
  base.busy_next = upcoming?.from;

  return finish({
    ...base,
    ok: true,
    detail:
      base.observed === 0
        ? "calendar reached and returned no events"
        : `read ${base.observed} event(s)` +
          (base.busy_next ? ` — next busy from ${base.busy_next}` : " — nothing busy ahead"),
  });
}

export type ImportConfidenceLevel = "fresh" | "stale" | "unverifiable" | "unknown";

export interface ImportConfidence {
  level: ImportConfidenceLevel;
  confirmed_at?: string;
  age_hours?: number;
  detail: string;
  meta?: Record<string, unknown>;
}

function confidenceFromCheck(
  check: CapabilityCheck | undefined,
  nothingConnectedPrefix: string,
): ImportConfidence {
  if (!check) {
    return {
      level: "unverifiable",
      detail: nothingConnectedPrefix,
    };
  }
  const ageMs = check.confirmed_at ? Date.now() - Date.parse(check.confirmed_at) : undefined;
  const ageHours =
    ageMs === undefined || !Number.isFinite(ageMs) ? undefined : Math.max(0, Math.floor(ageMs / 3_600_000));

  if (!check.ok || !check.confirmed_at) {
    const nothing =
      check.detail.startsWith("no ") ||
      check.detail.includes("nothing is connected") ||
      check.detail.includes("no CRM is connected") ||
      check.detail.includes("no calendar is connected");
    return {
      level: nothing ? "unverifiable" : "unknown",
      detail: check.detail,
      meta: check.meta,
    };
  }
  if (ageHours !== undefined && ageHours > IMPORT_STALE_AFTER_HOURS) {
    return {
      level: "stale",
      confirmed_at: check.confirmed_at,
      age_hours: ageHours,
      detail: `last successful check was ${ageHours}h ago — ${check.detail}`,
      meta: check.meta,
    };
  }
  return {
    level: "fresh",
    confirmed_at: check.confirmed_at,
    age_hours: ageHours,
    detail: check.detail,
    meta: check.meta,
  };
}

export async function crmImportConfidence(projectId: string): Promise<ImportConfidence> {
  if (!projectId) throw new Error("CRM confidence must be scoped to a project");
  return confidenceFromCheck(
    await readCheck(projectId, "read_crm"),
    "no CRM has ever been checked for this business, so contacts will not appear until one is connected and imported",
  );
}

export async function calendarSyncConfidence(projectId: string): Promise<ImportConfidence> {
  if (!projectId) throw new Error("calendar confidence must be scoped to a project");
  return confidenceFromCheck(
    await readCheck(projectId, "read_calendar"),
    "no calendar has ever been checked for this business, so free/busy will not appear until one is connected and synced",
  );
}

export async function ensureCrmImportSchedule(
  domain: DomainStore,
  projectId: string,
  wedge: string,
  now: Date = new Date(),
): Promise<Schedule> {
  if (!projectId) throw new Error("a CRM import schedule must be scoped to a project");
  const existing = (await domain.listSchedules()).find(
    (s) => s.project_id === projectId && s.task_type === CRM_IMPORT_TASK_TYPE,
  );
  if (existing) return existing;
  return domain.createSchedule({
    project_id: projectId,
    name: "CRM import",
    wedge,
    task_type: CRM_IMPORT_TASK_TYPE,
    input: {},
    cadence: { kind: "every", seconds: IMPORT_SYNC_SECONDS },
    enabled: true,
    next_run_at: new Date(now.getTime() + 60_000).toISOString(),
  });
}

export async function ensureCalendarSyncSchedule(
  domain: DomainStore,
  projectId: string,
  wedge: string,
  now: Date = new Date(),
): Promise<Schedule> {
  if (!projectId) throw new Error("a calendar sync schedule must be scoped to a project");
  const existing = (await domain.listSchedules()).find(
    (s) => s.project_id === projectId && s.task_type === CALENDAR_SYNC_TASK_TYPE,
  );
  if (existing) return existing;
  return domain.createSchedule({
    project_id: projectId,
    name: "calendar sync",
    wedge,
    task_type: CALENDAR_SYNC_TASK_TYPE,
    input: {},
    cadence: { kind: "every", seconds: IMPORT_SYNC_SECONDS },
    enabled: true,
    next_run_at: new Date(now.getTime() + 60_000).toISOString(),
  });
}

/** True when a founder-owned CRM is bound for this project. */
export function crmWanted(connections: readonly Connection[], projectId: string): boolean {
  return resolveCapability("read_crm", connections, projectId).bound.length > 0;
}

/** True when a founder-owned calendar is bound for this project. */
export function calendarWanted(connections: readonly Connection[], projectId: string): boolean {
  return resolveCapability("read_calendar", connections, projectId).bound.length > 0;
}
