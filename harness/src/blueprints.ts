// Blueprints — the deployable unit of a *business*, not a task.
//
// This is what Cloud's "describe it and it goes live" actually resolves to: a named bundle of
// wedge + schedules + the connections it needs + seed knowledge. Applying one to a project creates
// everything in a single call and returns a readiness checklist of what the founder must still
// supply (credentials, mostly — the things only they have).
//
// Two deliberate choices:
//  - Schedules are provisioned DISABLED. A business whose bank feed has no token yet would
//    otherwise start firing daily syncs that fail, burning model spend and filling the timeline
//    with noise. They flip on when the project is ready (`activate`).
//  - Connections are created WITHOUT secrets, so the blueprint carries config and intent while the
//    founder supplies credentials through the normal encrypted path. A blueprint file is safe to
//    commit, share, and read.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Cadence, ConnectionKind } from "./contract";
import type { DomainStore } from "./domain";
import { firstRun } from "./scheduler";
import { hasSecret } from "./secrets";
import { loadWedge } from "./wedge";

export interface BlueprintConnection {
  name: string;
  kind: ConnectionKind;
  why: string;
  config?: Record<string, unknown>;
  secret_hint?: string;
}

export interface Blueprint {
  blueprint: string;
  title: string;
  summary: string;
  wedge: string;
  sells_as?: string;
  requires_connections: BlueprintConnection[];
  schedules: { name: string; task_type: string; cadence: Cadence; input?: Record<string, unknown> }[];
  seed_knowledge: { name: string; content: string; kind?: string }[];
  first_case?: { title: string; stage?: string };
}

export function blueprintsDir(): string {
  return process.env.MYCEL_BLUEPRINTS_DIR ?? join(process.cwd(), "blueprints");
}

export function listBlueprints(): Blueprint[] {
  const dir = blueprintsDir();
  if (!existsSync(dir)) return [];
  const out: Blueprint[] = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
    try {
      out.push(JSON.parse(readFileSync(join(dir, f), "utf8")) as Blueprint);
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

export function loadBlueprint(slug: string): Blueprint | null {
  if (!/^[a-z0-9_-]{1,64}$/i.test(slug)) return null; // no traversal
  const file = join(blueprintsDir(), `${slug}.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Blueprint;
  } catch {
    return null;
  }
}

export interface ChecklistItem {
  what: string;
  why: string;
  done: boolean;
  /** How the founder finishes it — an actual call, not a vague instruction. */
  action?: string;
  connection_id?: string;
}

export interface ProvisionResult {
  blueprint: string;
  project_id: string;
  created: { connections: string[]; schedules: string[]; knowledge: string[] };
  /** Existing things we left alone — provisioning twice must not duplicate a business. */
  reused: { connections: string[]; schedules: string[] };
  checklist: ChecklistItem[];
  ready: boolean;
}

/**
 * Apply a blueprint to a project. Idempotent: re-provisioning reuses connections and schedules that
 * already exist by name, so a retry (or a founder clicking twice) doesn't create a second business.
 */
export async function provision(
  domain: DomainStore,
  blueprint: Blueprint,
  projectId: string,
): Promise<ProvisionResult> {
  const created = { connections: [] as string[], schedules: [] as string[], knowledge: [] as string[] };
  const reused = { connections: [] as string[], schedules: [] as string[] };

  const existingConns = (await domain.listConnections()).filter((c) => c.project_id === projectId);
  const connByName = new Map(existingConns.map((c) => [c.name, c]));

  // 1. connections — config + intent, never secrets
  for (const spec of blueprint.requires_connections ?? []) {
    const existing = connByName.get(spec.name);
    if (existing) {
      reused.connections.push(spec.name);
      continue;
    }
    const conn = await domain.createConnection({
      project_id: projectId,
      kind: spec.kind,
      name: spec.name,
      owner: { kind: "founder", id: "founder" },
      config: spec.config ?? {},
    });
    connByName.set(conn.name, conn);
    created.connections.push(spec.name);
  }

  // 2. schedules — DISABLED until the project is ready (see the header note)
  const existingScheds = (await domain.listSchedules()).filter((s) => s.project_id === projectId);
  const schedByName = new Set(existingScheds.map((s) => s.name));
  for (const spec of blueprint.schedules ?? []) {
    if (schedByName.has(spec.name)) {
      reused.schedules.push(spec.name);
      continue;
    }
    await domain.createSchedule({
      project_id: projectId,
      name: spec.name,
      wedge: blueprint.wedge,
      task_type: spec.task_type,
      input: spec.input ?? {},
      cadence: spec.cadence,
      enabled: false,
      next_run_at: firstRun(spec.cadence),
    });
    created.schedules.push(spec.name);
  }

  // 3. seed knowledge — skip names that already exist so a re-provision can't clobber edits
  const existingKnowledge = new Set((await domain.listKnowledge(blueprint.wedge)).map((k) => k.name));
  for (const k of blueprint.seed_knowledge ?? []) {
    if (existingKnowledge.has(k.name)) continue;
    await domain.createKnowledge({
      project_id: projectId,
      wedge: blueprint.wedge,
      name: k.name,
      content: k.content,
      kind: (k.kind as "document" | "fact" | "example" | "correction") ?? "document",
      source: "authored",
      metadata: { from_blueprint: blueprint.blueprint },
    });
    created.knowledge.push(k.name);
  }

  const checklist = await buildChecklist(domain, blueprint, projectId);
  return {
    blueprint: blueprint.blueprint,
    project_id: projectId,
    created,
    reused,
    checklist,
    ready: checklist.every((i) => i.done),
  };
}

/** What's still missing before this business can actually run. */
export async function buildChecklist(
  domain: DomainStore,
  blueprint: Blueprint,
  projectId: string,
): Promise<ChecklistItem[]> {
  const items: ChecklistItem[] = [];
  const conns = (await domain.listConnections()).filter((c) => c.project_id === projectId);

  for (const spec of blueprint.requires_connections ?? []) {
    const conn = conns.find((c) => c.name === spec.name);
    const hasCred = conn ? !!conn.secret_ref || (await hasSecret(conn.id)) : false;
    items.push({
      what: `Credential for “${spec.name}”`,
      why: spec.secret_hint ?? spec.why,
      done: hasCred,
      connection_id: conn?.id,
      action: conn ? `POST /v1/connections/${conn.id}/secret {"value":"…"}` : undefined,
    });
  }

  // The wedge has to exist, or nothing else matters.
  items.push({
    what: `Wedge “${blueprint.wedge}” installed`,
    why: "Defines the task types, skills and knowledge this business runs on.",
    done: !!loadWedge(blueprint.wedge),
  });

  return items;
}
