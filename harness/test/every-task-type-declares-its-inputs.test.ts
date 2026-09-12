// EVERY TASK TYPE SAYS WHAT IT NEEDS, AND A PER-ITEM JOB REFUSES TO RUN WITHOUT ITS ITEM.
//
// ═══ WHAT THIS ENDS ═══
//
// 22 of 43 task types declared no `input_schema` at all — including the volume carriers. So the
// kernel could not refuse a job it had no chance of finishing: the schedule fired, a sandbox
// booted, the run discovered there was no bank statement and asked, and the clock fired again.
// 3,077 `monthly_close` runs across two engagements in a fortnight, one every 31 minutes, and 90%
// of model spend on runs that produced no deliverable while every one of them SUCCEEDED.
//
// `inputFaults` was already correct and already wired to `POST /v1/tasks`. What was missing was the
// contracts for it to read.
//
// ═══ THE RULE THE CONTRACTS FOLLOW, AND WHY BOTH HALVES MATTER ═══
//
//   REQUIRED = the caller must supply it and the run cannot derive it. A task without it is
//              guaranteed waste, so it is refused at the door, where refusing costs nothing.
//   OPTIONAL = the run can find it. Declared anyway, because `describeInputContract` tells the
//              agent what it is HOLDING rather than what it must go and gather — the fix for the
//              `weekly_report` that ignored eight already-measured probes and re-measured them all.
//
// Getting this backwards in either direction is expensive, so both are asserted below: a sweep that
// requires something refuses every blueprint at once, and a per-item job that requires nothing is
// the 3,077-run shape wearing a different name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { SPINE_TASK_TYPES } from "../src/spine";

const WEDGES = join(import.meta.dirname, "..", "..", "wedges");

interface TT {
  wedge: string;
  name: string;
  schema?: { required?: unknown; properties?: Record<string, unknown> };
}

function taskTypes(): TT[] {
  const out: TT[] = [];
  for (const slug of readdirSync(WEDGES).filter((d) => !d.startsWith("."))) {
    const p = join(WEDGES, slug, "wedge.json");
    if (!existsSync(p)) continue;
    const m = JSON.parse(readFileSync(p, "utf8"));
    for (const [name, tt] of Object.entries((m.task_types ?? {}) as Record<string, TT["schema"] & { input_schema?: TT["schema"] }>)) {
      /*
        A spine job declared bare in a manifest INHERITS its contract — `spine-is-inherited` is the
        test that keeps those from being copied eighteen times, and re-declaring one here to satisfy
        this check would be that drift arriving through the front door. So the spine's own schema is
        what gets read for them.
      */
      const own = (tt as { input_schema?: TT["schema"] }).input_schema;
      const inherited = (SPINE_TASK_TYPES[name] as { input_schema?: TT["schema"] } | undefined)?.input_schema;
      out.push({ wedge: slug, name, schema: own ?? inherited });
    }
  }
  return out;
}

test("EVERY TASK TYPE DECLARES WHAT ITS INPUT MUST CONTAIN", () => {
  const silent = taskTypes()
    .filter((t) => !t.schema)
    .map((t) => `${t.wedge}/${t.name}`);
  assert.deepEqual(
    silent,
    [],
    "a task type that cannot say what it needs cannot be refused before it spends a sandbox " +
      `discovering it: ${silent.join(", ")}\n` +
      "Declare an `input_schema`. If the job is a scheduled SWEEP, `required: []` is the right " +
      "answer and the optional fields still earn their place — the agent is told what it holds.",
  );
});

test("a declared contract is a real one, not an empty object standing in for the work", () => {
  /**
   * The cheap way to pass the test above is `{"type":"object"}`. That satisfies the letter and
   * changes nothing: `inputFaults` has no opinion on an input with no declared properties, so the
   * job is exactly as unrefusable as before.
   */
  const hollow = taskTypes()
    .filter((t) => t.schema && Object.keys(t.schema.properties ?? {}).length === 0)
    /*
      UNLESS IT SAYS IT TAKES NOTHING, ON PURPOSE. Four sweeps genuinely have no arguments — what
      they act on is stored rows, and an argument would be a second source of truth about what is
      due. `additionalProperties: false` is what makes that a DECISION rather than a gap: an
      inputless job and an undeclared one look identical from outside, and only one of them is
      finished. It is also enforceable — `inputFaults` refuses an unexpected field against it, so
      the declaration does real work rather than passing a test.
    */
    .filter((t) => (t.schema as { additionalProperties?: unknown }).additionalProperties !== false)
    .map((t) => `${t.wedge}/${t.name}`);
  assert.deepEqual(
    hollow,
    [],
    `an input contract with no properties refuses nothing: ${hollow.join(", ")}\n` +
      "Declare the fields it can narrow on, or `additionalProperties: false` if it truly takes none.",
  );
});

test("A PER-ITEM JOB REQUIRES ITS ITEM", () => {
  /**
   * The half that actually saves money, and the reason the list is written out by name rather than
   * inferred: "does this job act on one specific thing" is a fact about the trade, not about the
   * manifest, and a heuristic that guessed it wrong in either direction would be worse than no test.
   *
   * Every one of these is created by a fan-out or from something already found — a candidate, an
   * invoice, a questionnaire item — and every one of them, given nothing, has an agent with no
   * subject and every opportunity to invent one. `dunning.ts` names that exact failure in its own
   * header, about `chase_invoice`, which is on this list.
   */
  const PER_ITEM: Record<string, string> = {
    send_receipt: "invoice_id",
    chase_invoice: "invoice_id",
    nudge_client_request: "request_id",
    deliverable_verdict: "deliverable_id",
    check_in_case: "case_id",
    screen_candidate: "candidate",
    screen_longlist: "candidates",
    answer_question: "question",
    fill_questionnaire: "questionnaire",
    build_feature: "brief",
    review_diff: "diff",
    design_identity: "brand",
    draft_engagement: "call_notes",
    draft_practice: "exemplar",
  };

  const wrong: string[] = [];
  for (const t of taskTypes()) {
    const need = PER_ITEM[t.name];
    if (!need) continue;
    const required = (t.schema?.required ?? []) as string[];
    if (!required.includes(need)) wrong.push(`${t.wedge}/${t.name} does not require \`${need}\``);
  }
  assert.deepEqual(wrong, [], wrong.join("\n"));
});

test("A SWEEP REQUIRES NOTHING, because it is scheduled with an empty input on purpose", () => {
  /**
   * The opposite failure and the more dangerous one: requiring a field of a sweep refuses every
   * blueprint that schedules it, all at once, and the product simply goes quiet. `contract-desk`'s
   * blueprint already wrote this rule down — a per-item job scheduled empty is "this repo's most
   * expensive bug shape wearing a cron entry" — and these are the jobs on the other side of it.
   */
  const SWEEPS = ["daily_sync", "chase_receipts", "weekly_run", "desk_run", "source_candidates"];
  const wrong: string[] = [];
  for (const t of taskTypes()) {
    if (!SWEEPS.includes(t.name)) continue;
    const required = (t.schema?.required ?? []) as string[];
    if (required.length) wrong.push(`${t.wedge}/${t.name} requires ${required.join(", ")} — it fires on a schedule with an empty input`);
  }
  assert.deepEqual(wrong, [], wrong.join("\n"));
});
