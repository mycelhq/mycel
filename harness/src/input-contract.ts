// WHAT THE RUN WAS HANDED, said in words rather than left as anonymous JSON.
//
// ═══ THE RUN THAT MADE THIS NECESSARY ═══
//
// A `weekly_report` was created with eight queries, each already carrying a measured `present` and
// `cited` from a probe that had already happened. The run ignored them, fanned out into eleven
// `probe_mention` children, most of which failed, and joined on "batch joined with no successful
// children". It never wrote a report.
//
// The agent had the measurements. It could not tell they were measurements. `buildAgentsMd` renders
// exactly one line — `Input: {…raw JSON…}` — so a field called `cited` arrives with no more standing
// than a field called `note`, and a model with a skill telling it to go and measure will go and
// measure.
//
// ═══ WHY THE SCHEMA WAS ALREADY THERE AND ALREADY USELESS ═══
//
// Twenty-three task types declare `input_schema`. NOTHING READ IT. `validateOutput` is called on
// pack and workflow arguments and never on a task's own input, and no prompt has ever mentioned it.
// So the field was documentation for whoever opened the manifest, and the runtime — the one reader
// that could have acted on it — was blind to it.
//
// Every other contract in this system is enforced at both ends: `output_schema` is validated AND
// described to the agent (`describeShipContract`). The input side had neither.
//
// ═══ THE TWO HALVES ═══
//
//   1. `inputFaults` — refuse a task whose input does not satisfy its declared contract, at
//      creation, where the caller is still listening. A task that runs for twenty minutes and then
//      says "the accounting period is missing" cost a sandbox to discover something the route knew.
//   2. `describeInputContract` — tell the agent, field by field, what it holds and that those values
//      are GIVEN rather than to be gathered. This is the half that fixes the report above.
import { validateOutput } from "./validate";

interface JsonSchema {
  type?: unknown;
  required?: unknown;
  properties?: Record<string, { type?: unknown; description?: unknown; enum?: unknown }>;
}

/**
 * Schema violations in a task's input, or `[]` when there is nothing declared to violate.
 *
 * NO SCHEMA MEANS NO OPINION, deliberately. Thirty-seven task types declare nothing, and a change
 * that started rejecting their inputs on a guess would break every one of them at once. A missing
 * contract is a gap in the manifest, not a licence to invent one.
 */
export function inputFaults(input: unknown, schema: unknown): string[] {
  if (!schema || typeof schema !== "object") return [];
  const v = validateOutput(JSON.stringify(input ?? {}), schema);
  return v.ok ? [] : v.errors;
}

/**
 * The input contract, as prose the agent reads before it reads the input itself.
 *
 * Required fields are marked because "you were given this" and "you may have been given this" are
 * different instructions, and the second one is where a model decides to go and find out for itself.
 *
 * Returns `[]` for an undeclared contract rather than inventing a description of whatever keys
 * happen to be present — describing the SHAPE OF THIS ONE PAYLOAD as though it were the contract
 * would teach the agent that an absent optional field is an error.
 */
export function describeInputContract(schema: unknown): string[] {
  if (!schema || typeof schema !== "object") return [];
  const s = schema as JsonSchema;
  const props = s.properties;
  if (!props || typeof props !== "object") return [];
  const required = new Set((Array.isArray(s.required) ? s.required : []).map(String));
  const lines: string[] = [];
  for (const [name, spec] of Object.entries(props)) {
    const bits: string[] = [];
    if (typeof spec?.type === "string") bits.push(String(spec.type));
    if (Array.isArray(spec?.enum)) bits.push(`one of: ${spec.enum.map(String).join(", ")}`);
    const meta = bits.length ? ` (${bits.join("; ")})` : "";
    const req = required.has(name) ? " — REQUIRED" : "";
    const desc = typeof spec?.description === "string" && spec.description ? ` ${spec.description}` : "";
    lines.push(`- \`${name}\`${meta}${req}${desc}`.trimEnd());
  }
  if (!lines.length) return [];
  return [
    "## What you have been given",
    "",
    "These fields arrived WITH the task. They are the ground truth for this run — already gathered,",
    "already checked. Read them and use them. Do not go and measure, fetch or look up something you",
    "were handed: a run that re-gathers what it already holds spends its budget arriving back where",
    "it started, and if the gathering fails it reports failure over data that was never missing.",
    "",
    ...lines,
    "",
    "A field that is absent is absent. Say so in your output — never fill it in from somewhere else.",
  ];
}
