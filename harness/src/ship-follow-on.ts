// After a GEO week reports, the retainer is not a PDF. The agency's client pays for a page they
// can open — a live URL, not a file to preview. This is the seam that starts that page from the
// week's lead recommendation, without asking the model to remember to POST a second task.
//
// ═══ THE GAP THIS CLOSES ═══
//
// `weekly_report` already names the work (`recommendations[]`, leading with Small). Nothing ever
// DID the work. The portal filled with branded diagnoses, the founder forwarded them, and the
// client still had to write the comparison page themselves. That is the product telling an SEO
// studio they bought a screenshot.
//
// ═══ WHY THE KERNEL SPAWNS IT, NOT THE REPORT SKILL ═══
//
// A skill that says "now POST ship_page" is a hope. The report run is already at the end of its
// budget, it is a `decide` shape with no workspace, and a missed POST is silent — the week looks
// complete. Spawning here, after wrap has already filed the report, is the same pattern as
// ignition: the kernel starts the next production step because it can SEE the recommendation.
//
// Fail-soft: a spawn miss leaves the report delivered. The founder still has the diagnosis. A
// failed page must not un-file the measurement.
import type { Task, TaskSource, TaskStatus } from "./contract";
import type { Store } from "./store";

export const SHIP_PAGE_TASK_TYPE = "ship_page";
export const SHIP_SOURCE_TASK_TYPE = "weekly_report";

/** One page per engagement per week. A retry inside the same week would draft the same page twice. */
const WEEK_MS = 6 * 24 * 60 * 60 * 1000;

const IN_FLIGHT: readonly TaskStatus[] = [
  "queued",
  "provisioning",
  "running",
  "awaiting_approval",
  "awaiting_batch",
  "validating",
];

export type ShipRecommendation = {
  what: string;
  why?: string;
  effort?: string;
  genre?: string;
};

/**
 * The page we can actually draft from this report.
 *
 * Large recommendations are original data or a rebuild — we do not have the survey, and inventing
 * one is the claim that destroys the retainer. Small and medium are edits and new pages, which is
 * the work this task type was taught.
 */
export function pickShipableRecommendation(
  parsed: Record<string, unknown> | null | undefined,
): ShipRecommendation | undefined {
  if (!parsed || parsed.status !== "reported") return undefined;
  const recs = parsed.recommendations;
  if (!Array.isArray(recs) || !recs.length) return undefined;
  const items: ShipRecommendation[] = [];
  for (const r of recs) {
    if (!r || typeof r !== "object" || Array.isArray(r)) continue;
    const o = r as Record<string, unknown>;
    const what = typeof o.what === "string" ? o.what.trim() : "";
    if (!what) continue;
    const effort = typeof o.effort === "string" ? o.effort.trim().toLowerCase() : undefined;
    if (effort === "large") continue;
    items.push({
      what,
      why: typeof o.why === "string" ? o.why.trim() : undefined,
      effort,
      genre: typeof o.genre === "string" ? o.genre.trim() : undefined,
    });
  }
  return items.find((i) => i.effort === "small") ?? items.find((i) => i.effort === "medium") ?? items[0];
}

export interface ShipDeps {
  spawnTask(args: {
    project_id: string;
    wedge: string;
    task_type: string;
    client_id?: string;
    case_id?: string;
    source: TaskSource;
    input: Record<string, unknown>;
  }): Promise<string>;
}

let deps: ShipDeps | null = null;
export function setShipDeps(d: ShipDeps | null): void {
  deps = d;
}

export async function spawnShipFollowOn(args: {
  task: Task;
  parsed: Record<string, unknown> | null;
  store: Store;
}): Promise<string | undefined> {
  const { task, parsed, store } = args;
  if (!deps) return undefined;
  if (task.task_type !== SHIP_SOURCE_TASK_TYPE) return undefined;
  if (!task.project_id || !task.case_id) return undefined;
  const rec = pickShipableRecommendation(parsed);
  if (!rec) return undefined;

  const recent = await store.listTasks({
    wedge: task.wedge,
    client_id: task.client_id,
    limit: 200,
  });
  const cutoff = Date.now() - WEEK_MS;
  const already = recent.some((t) => {
    if (t.case_id !== task.case_id) return false;
    if (t.task_type !== SHIP_PAGE_TASK_TYPE) return false;
    if (IN_FLIGHT.includes(t.status)) return true;
    if (t.status === "succeeded" && Date.parse(t.created_at) >= cutoff) return true;
    return false;
  });
  if (already) return undefined;

  const client = typeof parsed?.client === "string" ? parsed.client.trim() : undefined;
  return deps.spawnTask({
    project_id: task.project_id,
    wedge: task.wedge,
    task_type: SHIP_PAGE_TASK_TYPE,
    client_id: task.client_id,
    case_id: task.case_id,
    source: "schedule",
    input: {
      because: "weekly_recommendation",
      client,
      recommendation: rec,
    },
  });
}
