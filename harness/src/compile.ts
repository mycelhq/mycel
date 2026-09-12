// THE COMPILER. One function, on the trusted side, before the model is called.
//
// ═══ WHAT THIS IS, IN ONE SENTENCE ═══
//
// Source (what this job is) + library (how this job is done) + policy (what this run may touch)
// → a session the model works INSIDE and does not get to design.
//
// ═══ WHY IT EXISTS, AND THE TEST IT HAS TO PASS ═══
//
// The pieces already existed and none of them was one function: `resolveHarnessProfile` picks the
// shape and budget, `capabilityConnections` intersects access, `profileSkills` mounts craft,
// `validateOutput` checks the result — scattered through `runtime.ts`, interleaved with sandbox
// provisioning, with no single object anyone can look at and no single place that can say no.
//
// The test, stated in the compiler note and worth keeping verbatim: **if we have to write an
// `if (geo)` branch to make the work real, we do not have a compiler yet.** Nothing in this file
// knows what a share-of-voice percentage is, what a bank statement is, or what a staging URL is.
// It knows what a JOB is, and it knows what a job needs in order to be worth running.
//
// ═══ THE REAL PURPOSE: FULFILMENT QUALITY, ENFORCED BEFORE THE SPEND ═══
//
// The product's whole claim is that the work is as good as an expert inside the firm would do it.
// So the useful question is not "can this run?" but "is this job EQUIPPED to produce expert work?"
// — and that is answerable from data, before a sandbox boots and before a token is spent.
//
// What an expert has that an improvising model does not, and what each maps to here:
//
//   a definition of done      → an output schema. An expert knows when the month is closed.
//   written craft             → mounted skills. Judgement, not improvisation from two sentences.
//   a human ceiling           → a Never in that craft. An expert knows what they must not decide.
//   the access to do the job  → the connections its capabilities resolve to. An expert has the login.
//   a bar for what ships      → `ship_requires`. An expert does not send a number with no advice.
//
// A job missing one of those does not produce mediocre work; it produces work that LOOKS finished
// and is not, which is the single most expensive output this system can make. So the compiler
// refuses, by name, with a sentence a founder can act on — and refusing costs one run, while
// shipping it costs the client relationship.
//
// ═══ FAIL CLOSED, AND NEVER "GIVE IT EVERYTHING" ═══
//
// A compile failure is a refusal to run. It is never a fallback to a wider toolset, a longer
// budget, or an unmounted skill set. That inversion — degrade-open on error — is the specific way
// harness compilers become unsafe, and it is the one thing this file must never do.

import type { Task } from "./contract";

/** Craft the job would mount, already resolved by the caller from wedge + library. */
export interface MountedSkill {
  name: string;
  /** The prose. Read for its human ceiling; never executed. */
  content: string;
}

/** Everything the compiler reads. Gathered by the caller; this file performs no I/O. */
export interface CompileInput {
  task: Pick<Task, "task_type" | "wedge" | "project_id" | "case_id" | "client_id">;
  /** The resolved harness shape and its budget — `resolveHarnessProfile`'s answer. */
  profile: {
    shape: string;
    strict_output: boolean;
    max_runtime_s: number;
    max_cost_usd: number;
    grants_actions: boolean;
  };
  /** `task_types.<type>.output_schema`. The definition of done. */
  outputSchema?: Record<string, unknown> | null;
  /** `task_types.<type>.ship_requires` — fields that must carry substance before work ships. */
  shipRequires?: readonly string[];
  /** What the wedge declares it delivers, if anything. Absent = an internal job. */
  deliverableShapes?: readonly string[];
  /** `task_types.<type>.internal` — machinery, so no client ever opens this step's output. */
  internalTaskType?: boolean;
  /** Craft resolved for THIS task type. */
  skills: readonly MountedSkill[];
  /**
   * Does this job declare what the finished artefact LOOKS like — sections, order, depth?
   *
   * Distinct from every other input here. `outputSchema` is what the JSON must contain and
   * `shipRequires` is which of it must carry substance; both describe the DATA. This is the
   * OBJECT the client opens, and a job can satisfy both of the others and still hand back a text
   * blob a founder has to format — measured, not theorised: see `deliverable-shape.ts`.
   *
   * Reported, not refused. Only seven of forty-one client-facing task types declare a shape
   * today, so refusing would stop work that is running; and unlike `ship_requires`, a shape is
   * knowledge about a trade rather than a field anyone can fill in. What it must not do is be
   * invisible, which is how the last one of these sat unmounted for a whole population.
   */
  hasDeclaredShape?: boolean;
  /** Capabilities the wedge declared that no connection satisfies. */
  capabilityGaps?: readonly string[];
  /** Connection ids this run would actually be granted. */
  connections?: readonly string[];
}

export interface Refusal {
  /** Stable, greppable, and the thing a dashboard groups by. */
  code:
    | "no_definition_of_done"
    | "no_craft"
    | "no_human_ceiling"
    | "missing_access"
    | "ships_without_a_bar";
  /** One sentence a founder can act on. Never names a file or a symbol. */
  message: string;
}

export interface SessionSpec {
  wedge: string;
  task_type: string;
  shape: string;
  skills: readonly string[];
  schemaRequired: readonly string[];
  shipRequires: readonly string[];
  connections: readonly string[];
  budget: { runtime_s: number; cost_usd: number };
  /** True when the mounted craft states a human ceiling. */
  hasHumanCeiling: boolean;
  /** True when this job's output is something a client receives. */
  clientFacing: boolean;
  /** True when the finished artefact's sections and depth are declared, not improvised per run. */
  hasDeclaredShape: boolean;
}

export type CompileResult =
  | { ok: true; spec: SessionSpec; warnings: readonly string[] }
  | { ok: false; refusals: readonly Refusal[] };

/**
 * Does this craft state what it must not do?
 *
 * Four spellings, because the shelf already uses all four: a `## Never` heading, a bolded
 * **Never**, a bullet or line opening with "Never ", and an imperative "Never …" that begins a
 * SENTENCE inside a paragraph.
 *
 * That last one was missing from the first version of this function, and it immediately did the
 * damage the comment warned about: `security-questionnaire/answer-one.md` ends "…that says what is
 * missing. Never invent a control." — a real, well-placed ceiling — and the checker reported the
 * job as having none. A checker that reports healthy craft as missing gets deleted, and takes the
 * real check with it. So it was the checker that was wrong, not the file.
 *
 * Sentence-initial is the whole distinction. "Never invent a control" is an instruction;
 * "this has never been easy" is prose, and matching that would make the check meaningless in the
 * other direction.
 *
 * Deliberately NOT a semantic judgement. This asks whether the author wrote a ceiling down, which
 * is checkable; whether the ceiling is the RIGHT one is a review question and belongs to a person.
 */
export function statesACeiling(content: string): boolean {
  return /^\s{0,3}#{1,6}\s*never\b/im.test(content)
    || /\*\*never\b/i.test(content)
    || /^\s*[-*]?\s*never\s+\w/im.test(content)
    || /[.!?]\s+never\s+\w/i.test(content);
}

/** Required-field names off a JSON Schema, tolerant of the shapes manifests actually use. */
function requiredOf(schema?: Record<string, unknown> | null): string[] {
  const req = schema?.required;
  return Array.isArray(req) ? req.filter((x): x is string => typeof x === "string") : [];
}

/**
 * Compile a job into a session, or refuse it.
 *
 * Every refusal below is a thing an expert firm has and this job would not. They are collected
 * rather than short-circuited: a founder fixing a wedge wants the whole list, not one item at a
 * time across five runs.
 */
export function compile(input: CompileInput): CompileResult {
  const refusals: Refusal[] = [];
  const warnings: string[] = [];
  const job = `${input.task.wedge}/${input.task.task_type}`;
  // Both must hold. The wedge has to ship something at all, AND this particular step has to be one
  // a client ever opens — a measurement probe inside a shipping wedge is not a deliverable. See
  // `WedgeTaskType.internal` for the inflation this second half removes.
  const clientFacing = (input.deliverableShapes?.length ?? 0) > 0 && !input.internalTaskType;

  // ── A DEFINITION OF DONE ────────────────────────────────────────────────────────────────────
  //
  // Only where the job claims to be strict. A `general` research run legitimately answers in prose,
  // and demanding a schema of it would be this file inventing a policy nobody declared.
  const required = requiredOf(input.outputSchema);
  if (input.profile.strict_output && required.length === 0) {
    refusals.push({
      code: "no_definition_of_done",
      message:
        `"${job}" is held to a strict result but names nothing that must be in it. ` +
        "A run with no definition of done stops when the model stops, which is not the same as finished.",
    });
  }

  // ── WRITTEN CRAFT ───────────────────────────────────────────────────────────────────────────
  //
  // The difference between judgement and improvisation. A client-facing job with no craft produces
  // something plausible and generic, which is precisely the output a firm cannot sell.
  if (input.skills.length === 0) {
    if (clientFacing) {
      refusals.push({
        code: "no_craft",
        message:
          `"${job}" delivers work to a client and has no procedure written for it. ` +
          "It would improvise, and improvised work is the kind that reads fine and is wrong.",
      });
    } else {
      warnings.push(`${job} mounts no craft — fine for an internal tick, wrong for anything a client reads`);
    }
  }

  // ── A HUMAN CEILING ─────────────────────────────────────────────────────────────────────────
  //
  // Enforced for every job that reaches a client, not only authored ones. `wedgeauthor` already
  // refuses an authored skill with no Never; the shipped wedges running real engagements were
  // never held to the same bar, which is exactly backwards — those are the ones with customers.
  const hasHumanCeiling = input.skills.some((s) => statesACeiling(s.content));
  if (clientFacing && input.skills.length > 0 && !hasHumanCeiling) {
    refusals.push({
      code: "no_human_ceiling",
      message:
        `None of the procedures for "${job}" says what it must NOT do. ` +
        "A procedure without a ceiling will eventually invent a number, send something, or decide for the client.",
    });
  }

  // ── THE ACCESS TO ACTUALLY DO IT ────────────────────────────────────────────────────────────
  //
  // A declared capability with nothing behind it is a job that will discover halfway through that
  // it cannot finish — and then either refuse late, having spent the budget, or fabricate.
  const gaps = input.capabilityGaps ?? [];
  if (gaps.length) {
    refusals.push({
      code: "missing_access",
      message:
        `"${job}" needs ${gaps.length === 1 ? "access" : "access"} it does not have: ${gaps.join(", ")}. ` +
        "Connect it, or the run will get partway in and stop.",
    });
  }

  // ── A BAR FOR WHAT SHIPS ────────────────────────────────────────────────────────────────────
  //
  // A REFUSAL, as of the pass that made it one. It was a warning, and the reasoning was sound at the
  // time: refusing would have made `ship_requires` mandatory boilerplate, "which is how a real guard
  // becomes a field everyone fills in with whatever passes". Two things were true underneath that.
  //
  // The first is that the warning was never read. It is pushed onto `warnings`, `describe()` prints
  // it into a progress note, and the run proceeds — so a job shipping with no bar at all looked
  // exactly like a job shipping with one, which is this codebase's most-repeated failure and the
  // reason this check existed in the first place.
  //
  // The second is that the boilerplate worry was measuring the wrong population. `clientFacing` was
  // read off the WEDGE, so measurement probes and sync steps counted as shipping, and the only way
  // to quiet them would indeed have been a meaningless bar. `WedgeTaskType.internal` now lets a step
  // say it is machinery, and with the population honest, every one of the 34 client-facing jobs in
  // this kernel declares a real bar derived from its own schema. The refusal stops nothing that
  // works today — it stops the NEXT job that ships without one.
  //
  // `required.length > 1` still gates it: a single-field output really can be one honest piece of
  // prose with nothing to cross-check, and that was never the case this was aimed at.
  if (clientFacing && (input.shipRequires?.length ?? 0) === 0 && required.length > 1) {
    refusals.push({
      code: "ships_without_a_bar",
      message:
        `"${job}" ships to a client and declares no ship_requires. ` +
        "Name the fields of its output that must actually carry something — the finding, the advice, " +
        "the next step — or it will one day deliver a result that satisfies its schema and says nothing.",
    });
  }

  if (refusals.length) return { ok: false, refusals };

  return {
    ok: true,
    warnings,
    spec: {
      wedge: input.task.wedge,
      task_type: input.task.task_type,
      shape: input.profile.shape,
      skills: input.skills.map((s) => s.name),
      schemaRequired: required,
      shipRequires: [...(input.shipRequires ?? [])],
      connections: [...(input.connections ?? [])],
      budget: { runtime_s: input.profile.max_runtime_s, cost_usd: input.profile.max_cost_usd },
      hasHumanCeiling,
      clientFacing,
      hasDeclaredShape: input.hasDeclaredShape === true,
    },
  };
}

/**
 * The compile, as one line on the run's feed.
 *
 * A founder watching a job start should be able to see what it was equipped with without opening
 * anything. This is the whole session in a sentence — and when it refuses, the reason is the first
 * thing on the timeline rather than a silent absence.
 */
export function describe(result: CompileResult): string {
  if (!result.ok) {
    return `not equipped to run — ${result.refusals.map((r) => r.message).join(" ")}`;
  }
  const s = result.spec;
  const bits = [
    `${s.shape} job`,
    `${s.skills.length} procedure(s)`,
    s.schemaRequired.length ? `${s.schemaRequired.length} required field(s)` : "no required fields",
  ];
  if (s.connections.length) bits.push(`${s.connections.length} connection(s)`);
  if (s.clientFacing) bits.push(s.hasHumanCeiling ? "human ceiling stated" : "NO human ceiling");
  // On the feed for client-facing jobs only, and only ever as the presence or absence of a
  // template — not a quality claim about it. A founder reading "improvises its layout" against a
  // deliverable that came back looking different from last month's has their answer in one line.
  if (s.clientFacing) bits.push(s.hasDeclaredShape ? "shape declared" : "improvises its layout");
  return `compiled: ${bits.join(", ")}`;
}
