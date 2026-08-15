// Mock runtime — streams canned contract events and returns a schema-conforming result, with no
// sandbox, no OpenCode, no provider key. Selected by MYCEL_RUNTIME=mock. Lets anyone run the
// kernel end-to-end out of the box (demos), and powers the test suite. It honors cancel/runtime
// aborts so the abort paths are exercised too.
import type { Task } from "./contract";
import type { RuntimeCtx } from "./runtime";
import { loadProjectWedge } from "./authored";
import { wedgeForRole, wedgeHasRole } from "./roles";

export async function runMockTask(task: Task, ctx: RuntimeCtx): Promise<{ text: string }> {
  // Project-scoped, like every other load site that has a task in hand: a service Mycel wrote for
  // this business is reachable only through the resolver that takes the tenant. `loadWedge` cannot
  // see one at all (see AUTHORED_SLUG_PREFIX in wedge.ts), so the mock would otherwise produce a
  // schema-less result for exactly the services this change exists to support.
  const wedge = await loadProjectWedge(task.project_id ?? "", task.wedge);

  /**
   * Simulate a LiteLLM / Anthropic hang or 500 without standing up OpenCode.
   *
   * The real path is: sandbox → `/v1/internal/llm` → upstream abort/500 → OpenCode fails the
   * prompt → `runTask` catch → `task.finished` with `status: "failed"`. This throws the same class
   * of error so the orchestrator failure path (and the SSE that depends on it) can be asserted in
   * the mock suite. Only honoured when the test opts in via `input.simulate_llm_failure`.
   */
  const sim = task.input?.simulate_llm_failure;
  if (sim === "timeout") {
    throw new Error("LLM upstream timeout: LiteLLM did not respond within the deadline");
  }
  if (sim === "500" || sim === 500) {
    throw new Error("LiteLLM returned 500: Internal Server Error");
  }

  await ctx.emit("step.started", { step: "mock_runtime" });
  await ctx.emit("progress", { note: "mock runtime — no sandbox, canned result" });

  const message = typeof task.input?.message === "string" ? task.input.message : "";
  const reply =
    `[mock] handled "${task.task_type}" for wedge "${task.wedge}"` +
    (message ? ` — re: ${message.slice(0, 60)}` : "");

  // fake token streaming (abortable)
  for (const tok of reply.split(" ")) {
    const reason = ctx.shouldAbort();
    if (reason) throw new Error(`aborted: ${reason}`);
    await ctx.emit("token.delta", { text: tok + " " });
    await new Promise((r) => setTimeout(r, 2));
  }
  await ctx.emit("tool.called", { tool: "mock.tool", args: {} });
  await ctx.emit("tool.result", { tool: "mock.tool", ok: true });
  ctx.onCost(0.0001);

  // Onboarding's first screens refuse placeholder prose on purpose (cloud checks for a leading
  // `[mock]`). A schema walk that fills every string with that marker therefore makes "Work it out"
  // succeed and then show "the draft came back empty" — which is how a zero-key local install
  // looked broken at the exact step it was meant to demo. These two jobs get fixtures grounded in
  // the founder's own input instead; everything else keeps the `[mock]` signal.
  const onboarding = onboardingFixture(task);
  if (onboarding) return { text: JSON.stringify(onboarding) };

  // produce output conforming to the wedge/task output_schema (so output.validated passes)
  const schema = (wedge?.manifest.task_types?.[task.task_type]?.output_schema ??
    task.output_schema) as JsonSchema | undefined;
  if (schema && typeof schema === "object" && schema.type === "object") {
    return { text: JSON.stringify(sample(schema, reply)) };
  }
  return { text: reply };
}

/**
 * Usable drafts for the two onboarding jobs that the cloud product will not render if they look
 * like placeholders. Built from the task input so a local founder still sees *their* sentence back,
 * not a canned industry.
 */
function onboardingFixture(task: Task): Record<string, unknown> | null {
  // Role, not directory name — same rule as the rest of the kernel (roles.test.ts).
  if (!wedgeHasRole(task.wedge, "business_shaping")) return null;

  if (task.task_type === "draft_shape") {
    const description =
      typeof task.input?.description === "string" && task.input.description.trim()
        ? task.input.description.trim()
        : "the service you described";
    const businessName =
      typeof task.input?.business_name === "string" && task.input.business_name.trim()
        ? task.input.business_name.trim()
        : "Your business";
    const catalogue = Array.isArray(task.input?.catalogue) ? task.input.catalogue : [];
    // Prefer wedges the install actually claims via roles (dunning/receipts/outreach first), then
    // any other role-resolved slug present in the catalogue — never a hardcoded directory list.
    const preferred = (
      ["dunning", "receipts", "outreach", "business_shaping", "self_improvement", "app_building"] as const
    )
      .map((role) => wedgeForRole(role))
      .filter((slug): slug is string => !!slug);
    const hit = preferred.find((slug) =>
      catalogue.some((c) => c && typeof c === "object" && (c as { wedge?: string }).wedge === slug),
    );

    return {
      name: businessName,
      sells: description.length > 280 ? `${description.slice(0, 277)}…` : description,
      sells_to: "the clients you work with",
      runs_as: hit
        ? {
            fit: "adjacent",
            wedge: hit,
            covers: "The parts of this work we already have a service for.",
            not_covered: "Anything outside that service stays with you for now.",
          }
        : {
            fit: "none",
            covers: "We can still draft a service from what you described.",
            not_covered: "Nothing installed covers this trade yet.",
          },
      first_job: {
        title: "First weekly pass",
        why: "A concrete first run so you can see the desk before you connect anything.",
        cadence: "weekly",
      },
      connections: [],
      confidence: "low",
      assumptions: [
        "This reading came from the mock runtime (no model key). Connect a real model for a sharper fit.",
      ],
    };
  }

  if (task.task_type === "draft_questions") {
    return {
      questions: [
        {
          id: "clients",
          ask: "Who are the clients this is for?",
          why: "Tone and examples have to match the people you actually serve.",
          decides: "Who we address, and which examples we treat as typical.",
          example: "UK creative agencies, roughly five to twenty people",
          weight: 1,
        },
        {
          id: "cadence",
          ask: "How often does the work need to happen?",
          why: "A weekly sweep is a different machine from an inbox that waits for a message.",
          decides: "Whether we schedule a pass or wait for something to arrive.",
          example: "Every Monday morning, and whenever a client emails",
          weight: 1,
        },
        {
          id: "red-lines",
          ask: "What must never go out without you seeing it first?",
          why: "The approval gate is only useful if it stops the things you care about.",
          decides: "Which outward actions always wait for you.",
          example: "Anything that names a price, or goes to a client for the first time",
          weight: 1,
        },
      ],
    };
  }

  return null;
}

/** The subset of JSON Schema the mock needs to walk. Widened to nested shapes — see `sample`. */
interface JsonSchema {
  type?: string;
  enum?: unknown[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
}

/**
 * A value this schema will accept.
 *
 * RECURSIVE, which it did not used to be: a nested object got `{}` and a nested array got `[]`, so
 * any wedge declaring `required` fields inside a nested object could never produce a passing run
 * under the mock at all. The task failed with "$.first_job.title: required" — a validator error that
 * looks exactly like a broken wedge and is in fact a limitation of the fake runtime, which is about
 * the most expensive kind of confusion a test double can create.
 *
 * `enum` is still honoured first, for the original reason: without it the mock emits output its own
 * wedge's schema rejects.
 *
 * Every string is still the same `[mock]` placeholder. That is deliberate and load-bearing — it is
 * the signal a product can check to tell "the kernel answered" apart from "the kernel answered with
 * something worth showing a human".
 */
function sample(schema: JsonSchema, filler: string): unknown {
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  switch (schema.type) {
    case "number":
    case "integer":
      return 0;
    case "boolean":
      return true;
    case "array":
      // One element rather than none, so a `minItems` of 1 is satisfied and a consumer walking the
      // array has something to walk. Untyped items degrade to the filler string.
      return [schema.items ? sample(schema.items, filler) : filler];
    case "object": {
      const obj: Record<string, unknown> = {};
      for (const [k, spec] of Object.entries(schema.properties ?? {})) {
        obj[k] = sample(spec, filler);
      }
      return obj;
    }
    default:
      return filler;
  }
}
