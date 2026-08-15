// Deterministic workflows: named, tested functions a wedge ships so the agent stops doing
// arithmetic in prose. Reconciliation, yields, fees, budget pacing — the mechanics. Skills stay
// prose (judgment); workflows are code (exactness).
//
// TRUST MODEL — read this before extending:
//   A workflow is FOUNDER code, authored in the wedge and deployed with the kernel. It runs in the
//   harness process, at the same trust level as the wedge manifest itself. The AGENT can only
//   *call* one by name with JSON args — it can never define, edit, or inject code. That asymmetry
//   is the whole point: the model chooses WHICH computation and WHAT inputs, never the logic.
//   Workflows should be pure computation. Anything with a real-world side effect belongs behind a
//   connection + the approval gate, not here.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { validateOutput } from "./validate";
import { loadWedge, wedgesDir, workflowLibDir } from "./wedge";

/**
 * The verified SHARED workflow library — a CLOSED vocabulary, like CAPABILITIES and WEDGE_ROLES. A
 * wedge references one of these by `lib`, and the reference is checkable at author time because the
 * set is here in code, not on disk. Add a primitive here and drop its `<name>.mjs` in workflowLibDir.
 */
export const SHARED_WORKFLOWS = ["dunning-ladder", "reconcile", "next-touch"] as const;
export type SharedWorkflow = (typeof SHARED_WORKFLOWS)[number];

export function isSharedWorkflow(name: unknown): name is SharedWorkflow {
  return typeof name === "string" && (SHARED_WORKFLOWS as readonly string[]).includes(name);
}

export interface WorkflowResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  ms?: number;
}

const TIMEOUT_MS = Number(process.env.MYCEL_WORKFLOW_TIMEOUT_MS ?? 5_000);
const MAX_RESULT_BYTES = 128 * 1024;

/** Module cache — a workflow file is loaded once per process. */
const cache = new Map<string, (args: Record<string, unknown>) => unknown>();

/** Only simple names, and only ones the manifest declares. No path traversal into the filesystem. */
export function validWorkflowName(name: unknown): name is string {
  return typeof name === "string" && /^[a-z0-9_-]{1,64}$/i.test(name);
}

export async function runWorkflow(
  wedgeSlug: string,
  name: string,
  args: Record<string, unknown>,
): Promise<WorkflowResult> {
  if (!validWorkflowName(name)) return { ok: false, error: "invalid workflow name" };

  const wedge = loadWedge(wedgeSlug);
  const declared = wedge?.manifest.workflows ?? [];
  const spec = declared.find((w) => w.name === name);
  if (!spec) {
    return { ok: false, error: `wedge "${wedgeSlug}" does not declare a workflow named "${name}"` };
  }

  // Validate the agent's arguments before running the founder's code.
  if (spec.input_schema) {
    const v = validateOutput(JSON.stringify(args ?? {}), spec.input_schema);
    if (!v.ok) return { ok: false, error: `invalid args: ${v.errors.join("; ")}` };
  }

  // A `lib` reference resolves to the shared library; otherwise the per-wedge file. The shared name
  // is checked against the closed vocabulary, never used as a raw path — a manifest cannot point the
  // loader anywhere it likes.
  const usesLib = spec.lib !== undefined;
  if (usesLib && !isSharedWorkflow(spec.lib)) {
    return { ok: false, error: `workflow "${name}" references unknown shared library "${spec.lib}"` };
  }
  const key = usesLib ? `lib:${spec.lib}` : `${wedgeSlug}:${name}`;
  let fn = cache.get(key);
  if (!fn) {
    const file = usesLib
      ? join(workflowLibDir(), `${spec.lib}.mjs`)
      : join(wedgesDir(), wedgeSlug, "workflows", `${name}.mjs`);
    if (!existsSync(file)) {
      return { ok: false, error: usesLib ? `shared workflow missing: ${spec.lib}.mjs` : `workflow file missing: workflows/${name}.mjs` };
    }
    try {
      const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
      const candidate = (mod.default ?? mod.run) as unknown;
      if (typeof candidate !== "function") {
        return { ok: false, error: `workflows/${name}.mjs must export a default function (or \`run\`)` };
      }
      fn = candidate as (a: Record<string, unknown>) => unknown;
      cache.set(key, fn);
    } catch (e) {
      return { ok: false, error: `failed to load workflow: ${String((e as Error)?.message ?? e)}` };
    }
  }

  const started = Date.now();
  try {
    // A workflow is meant to be a fast pure computation; a hang must not wedge the task.
    const data = await Promise.race([
      Promise.resolve(fn(args ?? {})),
      new Promise((_r, reject) => setTimeout(() => reject(new Error(`workflow timed out after ${TIMEOUT_MS}ms`)), TIMEOUT_MS)),
    ]);
    const ms = Date.now() - started;

    const serialized = JSON.stringify(data ?? null);
    if (serialized.length > MAX_RESULT_BYTES) {
      return { ok: false, error: `workflow result too large (${serialized.length} bytes)`, ms };
    }
    // Validate what the founder's code returned, so a broken workflow fails loudly.
    if (spec.output_schema) {
      const v = validateOutput(serialized, spec.output_schema);
      if (!v.ok) return { ok: false, error: `workflow returned invalid output: ${v.errors.join("; ")}`, ms };
    }
    return { ok: true, data, ms };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e), ms: Date.now() - started };
  }
}

/** What the agent is told it can call. */
export function describeWorkflows(wedgeSlug: string): { name: string; description?: string }[] {
  return (loadWedge(wedgeSlug)?.manifest.workflows ?? []).map((w) => ({ name: w.name, description: w.description }));
}
