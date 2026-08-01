// A "wedge" is a service the kernel can fulfill. The founder brings four things:
//   wedge.json  — definition (task types + output schema/rubric, tools, approvals, model)
//   skills/     — procedures / know-how (SKILL.md files: how to do the job well)
//   knowledge/  — documents that ground the agent (playbooks, policies, pricing, examples)
//   (per task)  — uploaded documents + connected accounts, passed in task.input
// At run time the harness mounts skills + knowledge (+ task documents) into the sandbox so
// OpenCode can actually do the work. This is how a service becomes solvable.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Risk } from "./contract";
import type { HarnessProfileSpec } from "./harness";
import type { IntakeQuestion } from "./intake";

export interface WedgeTaskType {
  /**
   * How hard this job actually is: "fast" | "standard" | "deep".
   *
   * Declared per task_type because a wedge does several different things — classifying an inbound
   * message is not the same work as reconciling a month. Clamped by the org's plan at run time.
   *
   * Kept alongside `harness.tier` as the shorter spelling: wedges already use it, and forcing a
   * nesting level on every existing manifest to gain nothing would be a poor trade.
   */
  tier?: string;
  description?: string;
  input_schema?: unknown;
  output_schema?: unknown;
  /**
   * How to engineer the harness for THIS task type — tools, permissions, tier, budgets, whether
   * the run may hold the action token. See harness.ts; every field is a request, clamped by the
   * org's plan and the server's ceilings. Absent means the permissive `general` shape, i.e. exactly
   * what every task got before profiles existed.
   */
  harness?: HarnessProfileSpec;
}

export interface WedgeApproval {
  action: string;
  risk: Risk;
  required: boolean;
}

export interface WedgeManifest {
  /** Default tier for every task_type that does not declare one. */
  tier?: string;
  /** Wedge-wide harness defaults, overridden per task_type. See harness.ts. */
  harness?: HarnessProfileSpec;
  wedge: string;
  title?: string;
  model?: string;
  task_types?: Record<string, WedgeTaskType>;
  tools?: string[];
  approvals?: WedgeApproval[];
  /** Connection names/ids this wedge's agent may act through (via the action proxy). */
  connections?: string[];
  /** Long-lived engagements: the stage machine a Case moves through. */
  cases?: { stages: string[]; initial?: string };
  /** Deterministic functions the agent may call (files: workflows/<name>.mjs). Founder code —
   *  the agent picks which one and the args, never the logic. */
  workflows?: Array<{ name: string; description?: string; input_schema?: unknown; output_schema?: unknown }>;
  /** Policy-bounded autonomy: envelopes inside which actions auto-approve (see policy.ts).
   *  Absent means every action is gated — the safe default. */
  policy?: { auto_approve?: Array<{ action: string; max_amount_usd?: number; max_per_task?: number; max_per_day?: number }> };
  /** What this wedge needs to be told before it can do the job well. Answered once per project;
   *  each answer becomes a knowledge file the agent is grounded on. See intake.ts. */
  intake?: IntakeQuestion[];
  /** Skill filenames under skills/ (with or without .md). Omit to load all. */
  skills?: string[];
  /** Knowledge filenames under knowledge/. Omit to load all. */
  knowledge?: string[];
}

export interface WedgeFile {
  name: string;
  content: string;
}

export interface LoadedWedge {
  manifest: WedgeManifest;
  dir: string;
  skills: WedgeFile[];
  knowledge: WedgeFile[];
}

export function wedgesDir(): string {
  return process.env.MYCEL_WEDGES_DIR ?? join(process.cwd(), "wedges");
}

export function loadWedge(slug: string): LoadedWedge | null {
  const dir = join(wedgesDir(), slug);
  const manifestPath = join(dir, "wedge.json");
  if (!existsSync(manifestPath)) return null;
  let manifest: WedgeManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as WedgeManifest;
  } catch {
    return null;
  }
  const skills = readFiles(
    join(dir, "skills"),
    manifest.skills?.map((s) => (s.endsWith(".md") ? s : `${s}.md`)),
  );
  const knowledge = readFiles(join(dir, "knowledge"), manifest.knowledge);
  return { manifest, dir, skills, knowledge };
}

function readFiles(dir: string, only?: string[]): WedgeFile[] {
  if (!existsSync(dir)) return [];
  const names = only ?? readdirSync(dir).filter((f) => !f.startsWith("."));
  const out: WedgeFile[] = [];
  for (const name of names) {
    const p = join(dir, name);
    if (existsSync(p)) {
      try {
        out.push({ name, content: readFileSync(p, "utf8") });
      } catch {
        /* skip unreadable */
      }
    }
  }
  return out;
}
