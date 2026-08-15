// HARD EVAL — generation quality. "When a founder is lazy, does the kernel still write a GOOD business?"
//
// Mycel is GENERATIVE. A founder types one tired sentence — "I run a design studio, I send proposals
// and chase sign-off" — and the kernel composes a whole service from primitives. The danger of a
// generator is not that it fails loudly; it is that it succeeds THINLY: a manifest that parses, stores,
// and reads as a running business but describes a job with no output schema (so nothing checks the
// work), grants itself autonomy no human watched it earn, or references code nobody wrote. Every one of
// those is a service that reports success while doing nothing — this repo's most expensive bug shape,
// arriving through the onboarding funnel.
//
// The generator's QUALITY FLOOR is `authoredFaults`/`authorWedgeFromOutput`: whatever a weak prompt or a
// model having a bad day emits, a manifest that is thin or invalid is REFUSED with a sentence, and only
// a complete, best-practice-shaped one becomes a draft. The live LLM cannot run under MYCEL_RUNTIME=mock,
// so this evals the deterministic thing that IS testable now and is the actual guarantee: the shape
// rubric that separates a good generated service from a thin one. Grading is on the validator's real
// output, never a self-report.
import { test } from "node:test";
import assert from "node:assert/strict";
import { authorWedgeFromOutput, reviewDraft, AUTHOR_LIMITS } from "../src/wedgeauthor";

// ─────────────────────────── WHAT A LAZY PROMPT PRODUCES ───────────────────────────
//
// A weak or adversarial generation lands in one of TWO buckets, and the guarantee is different for each:
//
//   · UNREPAIRABLE (below, `THIN`) — a job with no output schema, no jobs at all, a surface too big to
//     review. There is no honest way to salvage these (you cannot invent the schema the model omitted),
//     so `authorWedgeFromOutput` must REFUSE with a founder-readable sentence and store NOTHING. A
//     half-authored service that looks like progress is worse than an honest refusal.
//
//   · REPAIRABLE-TO-SAFE (`SALVAGED`, further down) — a field the model copied from an example wedge
//     that a written service may never hold: a `policy` envelope, a claimed role, its own `workflows`,
//     an approval marked not-required. The old behaviour REFUSED these and the founder saw "we couldn't
//     build you a service" for a normal brief. `repairAuthoredManifest` now STRIPS the forbidden field
//     before judging — and the safety property the refusal protected is preserved MORE strongly, not
//     less: the repair only ever REMOVES authority, so the stored service provably cannot act without
//     asking. This half asserts the INVARIANT (no self-granted autonomy on a stored service), which is
//     what the refusal was ever a proxy for.
interface ThinCase {
  name: string;
  output: unknown; // what the "model" emitted for { manifest, skills, knowledge }
  expect: RegExp; // the sentence the founder must be shown
  why: string; // the business cost of storing this thin service instead of refusing it
}

// A best-practice job: it says what it produces, so `validateOutput` can actually check the work.
const goodJob = (description: string) => ({
  description,
  output_schema: {
    type: "object",
    properties: { sent: { type: "boolean" }, note: { type: "string" } },
    required: ["sent"],
  },
});

const THIN: ThinCase[] = [
  {
    name: "a service that describes no job at all is refused, not stored as an empty business",
    output: { manifest: { title: "Design Studio" } },
    expect: /not describe a single job/,
    why: "an empty service reads as onboarded and running, and the founder discovers it does nothing the day a client expects work",
  },
  {
    name: "a job with no output schema is refused — nothing could ever check its work",
    output: { manifest: { title: "Studio", task_types: { send_proposal: { description: "send it" } } } },
    expect: /does not say what it produces/,
    why: "a run with no schema reports success on whatever the model said, so a broken proposal ships stamped as delivered",
  },
  {
    name: "an output schema that validates everything (empty properties) is refused as no schema at all",
    output: {
      manifest: {
        title: "Studio",
        task_types: { send_proposal: { description: "x", output_schema: { type: "object", properties: {} } } },
      },
    },
    expect: /does not say what it produces/,
    why: "a schema that checks nothing is the thin failure that looks configured — it passes review and catches no bad run",
  },
  {
    name: "a bloated service with more jobs than a founder will read is refused",
    output: (() => {
      const task_types: Record<string, unknown> = {};
      for (let i = 0; i <= AUTHOR_LIMITS.max_task_types; i++) task_types[`job_${i}`] = goodJob("x");
      return { manifest: { title: "Studio", task_types } };
    })(),
    expect: /more than anybody will read/,
    why: "a surface too big to review is a surface nobody reviewed, and the promote button still says the same reassuring thing",
  },
];

// REPAIRABLE-TO-SAFE: a forbidden field the model copied from an example wedge. The service is STORED
// (a normal brief no longer dies on the magic moment), and the invariant the old refusal protected —
// a service no human has watched run cannot act on its own — is asserted DIRECTLY on the stored draft.
// Each `check` receives the stored manifest and must be true; the repair strips authority, never adds.
interface SalvageCase {
  name: string;
  output: unknown;
  check: (m: Record<string, any>) => boolean;
  why: string;
}

const SALVAGED: SalvageCase[] = [
  {
    name: "an auto-approve envelope is stripped, not stored — the service still asks before everything",
    output: {
      manifest: {
        title: "Studio",
        task_types: { send_proposal: goodJob("send the proposal") },
        policy: { auto_approve: [{ action: "email.send" }] },
      },
    },
    check: (m) => !m.policy,
    why: "the model tried to grant itself autonomy; stripping the policy is the SAFE salvage — the stored service can email nobody without a human, which is exactly what the refusal protected",
  },
  {
    name: "an approval marked not-required is forced back to required, never left as a false promise",
    output: {
      manifest: {
        title: "Studio",
        task_types: { send_proposal: goodJob("send") },
        approvals: [{ action: "email.send", risk: "high", required: false }],
      },
    },
    check: (m) => Array.isArray(m.approvals) && m.approvals.every((a: any) => a.required !== false),
    why: "the review card promises 'it always asks you'; the repair makes that true rather than refusing the whole service over one flag",
  },
  {
    name: "a claimed kernel role is stripped — a written service holds none",
    output: {
      manifest: { title: "Studio", provides: ["dunning"], task_types: { send_proposal: goodJob("send") } },
    },
    check: (m) => !m.provides || (Array.isArray(m.provides) && m.provides.length === 0),
    why: "roles are shared-install singletons; stripping the claim is safe and lets the real service run",
  },
  {
    name: "self-authored runnable code is stripped — no .mjs nobody wrote is left referenced",
    output: {
      manifest: { title: "Studio", task_types: { send_proposal: goodJob("send") }, workflows: [{ name: "do_math" }] },
    },
    check: (m) => !m.workflows,
    why: "a workflow with no verified lib points at code nobody wrote; stripping it removes the landmine and keeps the service",
  },
  {
    name: "a dangling client-wait resume is dropped — the job becomes single-shot, never parks",
    output: {
      manifest: {
        title: "Studio",
        task_types: {
          ask_brief: {
            description: "ask the client for the brief",
            output_schema: { type: "object", properties: { ok: { type: "boolean" } } },
            waits_for: { on: "client_request", resume: "no_such_job", reason: "waiting on the brief" },
          },
        },
      },
    },
    check: (m) => m.task_types.ask_brief.waits_for === undefined,
    why: "a resume naming no job would park the engagement forever; dropping the wait makes the job do its work and stop",
  },
  {
    name: "a near-miss capability name is mapped to the real one, not silently dropped or refused",
    output: {
      manifest: { title: "Studio", task_types: { send_proposal: goodJob("send") }, capabilities: ["send_emails"] },
    },
    check: (m) => Array.isArray(m.capabilities) && m.capabilities.includes("send_email") && !m.capabilities.includes("send_emails"),
    why: "a dropped capability resolves to no connection at grant time; mapping the plural to the real name keeps the hands the job needs",
  },
];

test("EVAL: a repairable generation is stored SAFE — forbidden authority stripped, never acts alone", () => {
  const failures: string[] = [];
  for (const c of SALVAGED) {
    const r = authorWedgeFromOutput(c.output, { slugBase: "Design Studio Delivery" });
    if (!r.draft) {
      failures.push(`✗ ${c.name}\n    expected a STORED, repaired draft, got refusal: ${r.faults.map((f) => f.message).join(" | ")}`);
      continue;
    }
    if (!c.check(r.draft.manifest as Record<string, any>)) {
      failures.push(`✗ ${c.name}\n    the stored service did not have the forbidden authority stripped\n    invariant: ${c.why}`);
    }
    // The safety backstop for EVERY salvage: a stored service can never carry a self-granted envelope.
    if ((r.draft.manifest as Record<string, any>).policy) {
      failures.push(`✗ ${c.name}\n    a stored service must never carry a policy envelope`);
    }
  }
  const passed = SALVAGED.length - failures.length;
  console.log(`\n  generation-quality (salvaged safe): ${passed}/${SALVAGED.length} passed`);
  assert.equal(
    failures.length,
    0,
    `\n${failures.join("\n")}\n\n  The repair must ONLY remove authority. A salvaged service that kept a policy, an unrequired approval or a role is autonomy nobody granted slipping through the funnel.`,
  );
});

test("EVAL: a thin or invalid generated service is refused with a founder-readable sentence — never stored", () => {
  const failures: string[] = [];
  for (const c of THIN) {
    const r = authorWedgeFromOutput(c.output, { slugBase: "Design Studio Delivery" });
    const msgs = r.faults.map((f) => f.message).join(" | ");
    const refusedWithReason = r.draft === undefined && r.faults.length > 0 && c.expect.test(msgs);
    if (!refusedWithReason) {
      failures.push(
        `✗ ${c.name}\n    expected a refusal matching ${c.expect}, got ${r.draft ? "a STORED DRAFT" : msgs || "no faults"}` +
          `\n    cost of this miss: ${c.why}`,
      );
    }
  }
  const passed = THIN.length - failures.length;
  console.log(`\n  generation-quality (thin refused): ${passed}/${THIN.length} passed`);
  assert.equal(
    failures.length,
    0,
    `\n${failures.join("\n")}\n\n  The validator IS the generator's quality floor. A thin service that slips through is a business Mycel wrote that does nothing while reporting success.`,
  );
});

// ─────────────────────────── THE BEST-PRACTICE SHAPE A GOOD GENERATION MUST HIT ───────────────────────────
//
// The other half of the guarantee: a complete, well-shaped output is not just accepted, it produces a
// draft that satisfies the rubric of a real service — jobs that declare their output, a money model so
// the work is priced, deliverable shapes, approvals that all genuinely gate, and the "never acts alone"
// guarantee stated as a fact. This is what a strong generation looks like, asserted so a regression that
// let a weaker shape pass would fail here.
const GOLD_OUTPUT = {
  slug: "Design Studio Delivery",
  manifest: {
    title: "Design studio: scope, propose, deliver",
    task_types: {
      draft_scope: {
        description: "Turn what the client asked for into a scope with deliverables and a price.",
        output_schema: {
          type: "object",
          properties: {
            deliverables: { type: "array", items: { type: "string" } },
            price_minor_units: { type: "integer" },
          },
          required: ["deliverables", "price_minor_units"],
        },
      },
      chase_signoff: {
        description: "The proposal has been out a week with no reply — draft the next nudge for approval.",
        output_schema: { type: "object", properties: { sent: { type: "boolean" } }, required: ["sent"] },
      },
    },
    capabilities: ["send_email"],
    approvals: [{ action: "email.send", risk: "medium", required: true }],
    cases: { stages: ["scoping", "proposed", "signed", "delivered"], initial: "scoping" },
    intake: [{ id: "day-rate", ask: "What's your day rate, and does it change for retainers?" }],
    // A real service prices its work. Not validated by authoredFaults, but part of what makes a
    // generated manifest complete rather than thin — asserted below.
    fulfillment: {
      money_plan: {
        currency: "USD",
        lines: [{ label: "Project deposit", amount_minor: 100000, kind: "deposit" }],
      },
      deliverable_shapes: ["document", "file_set"],
    },
  },
  skills: [{ name: "write-a-scope", content: "# Writing a scope\n\nStart from the deliverable, not the hours." }],
};

test("EVAL: a complete generation yields a VALID, best-practice-shaped service — the generator's positive floor", () => {
  const r = authorWedgeFromOutput(GOLD_OUTPUT, { slugBase: GOLD_OUTPUT.slug });
  assert.ok(r.draft, `a complete output must produce a draft, got faults: ${r.faults.map((f) => f.message).join("; ")}`);
  const m = r.draft!.manifest as Record<string, any>;

  const checks: Array<[boolean, string]> = [
    [Object.keys(m.task_types ?? {}).length >= 1, "has at least one job"],
    [
      Object.values(m.task_types ?? {}).every(
        (t: any) => t.output_schema?.type !== "string" && Object.keys(t.output_schema?.properties ?? {}).length > 0,
      ),
      "every job declares an object output schema that checks something",
    ],
    [Array.isArray(m.approvals) && m.approvals.every((a: any) => a.required !== false), "every declared approval genuinely gates"],
    [!m.policy, "no self-granted auto-approve envelope — it never acts alone"],
    [Array.isArray(m.fulfillment?.money_plan?.lines) && m.fulfillment.money_plan.lines.length > 0, "carries a money model"],
    [Array.isArray(m.fulfillment?.deliverable_shapes) && m.fulfillment.deliverable_shapes.length > 0, "declares deliverable shapes"],
    [Array.isArray(m.cases?.stages) && m.cases.stages.length > 0, "describes stages an engagement moves through"],
    [r.draft!.skills.length > 0, "mounts a real procedure, not an empty sandbox"],
  ];
  const failures = checks.filter(([ok]) => !ok).map(([, label]) => `✗ missing: ${label}`);

  // And the founder-facing review card is buildable and speaks the founder's language, not internals.
  const card = reviewDraft(r.draft!);
  if (!card.never_acts_alone) failures.push("✗ the review card cannot promise 'never acts alone'");
  const prose = [card.title, ...card.does.map((d) => d.description), ...card.always_asks].join(" ");
  if (/\bwedge|kernel|harness|provision/i.test(prose)) failures.push("✗ an internal word leaked onto the review card");

  const passed = checks.length + 2 - failures.length;
  console.log(`\n  generation-quality (best-practice shape): ${passed}/${checks.length + 2} passed`);
  assert.equal(
    failures.length,
    0,
    `\n${failures.join("\n")}\n\n  A complete generation must be a complete business. A missing money model or an unchecked job is a service that onboards a client it cannot actually serve.`,
  );
});
