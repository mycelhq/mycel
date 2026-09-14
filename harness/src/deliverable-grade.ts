// Will this service produce work a client would actually pay for?
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// VALID IS NOT THE SAME AS GOOD, AND ONLY ONE OF THEM WAS CHECKED
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// `authoredFaults` refuses a manifest that cannot run: unknown fields, unknown capabilities, a role
// claimed without the task types that prove it. `loop-coverage` says whether the business can find,
// win, do, bill and keep. Both are structural, and a service can pass both and still hand a client
// a document with a contradiction in it.
//
// That gap matters more here than in a hand-authored wedge, because the thing being graded was
// written by a model twenty seconds ago from one paragraph a founder typed. Nobody has read it. The
// founder is about to decide whether to point it at a real client, and "it validated" is not what
// they are asking.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// EVERY RULE HERE IS A FAILURE THAT ALREADY HAPPENED
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// This is not a rubric somebody invented. Each rule cites the run that made it necessary, because a
// quality bar nobody can trace the reason for is a bar that gets argued away the first time it is
// inconvenient — and because a founder reading "nothing checks the numbers" deserves to know that
// the alternative is a client finding a £340 contradiction in a paid month-end close.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// AND IT GRADES WHAT IS CARRIED, NOT WHAT IS CLAIMED
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// Same rule as loop-coverage.ts. A generated manifest asserting `"quality": "high"` would be worth
// exactly nothing; what is worth something is whether a `sums_to` exists, because that one is
// enforced by machinery on every run whether anybody remembers it or not.
import { readShipChecks, type ShipCheck } from "./ship-checks";
import { isOperationalTaskType } from "./deliverables.wrap";
import { RESPONSIVE_TASKS } from "./client-touch";
import { isAuthoredSlug, type WedgeManifest } from "./wedge";

export type Severity = "blocking" | "weak" | "note";

/**
 * A job or field name as a founder should read it.
 *
 * `generate_monthly_invoices` is what the manifest calls it and `Generate monthly invoices` is what
 * it IS. The founder, on seeing the raw form on the screen where they first meet their own service:
 * *"it shouldn't display these kind of underscore slabs of text ... it should be as obstructed as
 * possible, show them what's related to their service business."* `reviewDraft` already did this for
 * the job list next door; the grade did not, so the two halves of one screen disagreed about whether
 * this founder runs a "patient recall" or a `patient_recall`.
 */
const said = (name: string): string => {
  const words = name.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** The same, for a name that appears MID-SENTENCE — "a list of lines", not "a list of Lines". */
const saidInline = (name: string): string => name.replace(/_/g, " ").trim();

export interface Finding {
  /** Stable id, so a founder dismissing one and a test asserting one mean the same thing. */
  rule: string;
  severity: Severity;
  /** The task type, when the finding is about one job rather than the whole service. */
  task?: string;
  /** What is wrong, in the founder's terms. Never a field name on its own. */
  says: string;
  /**
   * The one thing to add. A finding without this is a complaint.
   *
   * WRITTEN FOR US, and that is why it has an audience beside it. "Add `sums_to` for a total against
   * its lines" is the correct instruction and belongs in a pull request, not on the screen where a
   * founder meets the service written for their clinic — they cannot add a `sums_to`, and being told
   * to is the product handing its own job to the person paying for it (`UX.md` rule 1).
   */
  fix: string;
  /**
   * Who can act on `fix`.
   *
   * Absent means US: the finding is worth SHOWING a founder — they are accepting a service that
   * cannot check its own numbers and are entitled to know — but the remedy is ours, so a surface
   * they read shows `says` and stops. `"founder"` means the fix is genuinely theirs to perform, like
   * uploading an example of the work, and those are the only ones where an instruction helps.
   */
  audience?: "founder";
  /** The run that made this a rule. Empty only for rules with no incident behind them yet. */
  because?: string;
}

export interface Grade {
  findings: Finding[];
  /** Nothing a client receives can be trusted until these are fixed. */
  blocking: number;
  /** It will produce work, and nothing checks whether the work is right. */
  weak: number;
  /** One sentence a founder reads first. */
  verdict: string;
}

/**
 * Checks that are about TRUTH, as against shape or voice.
 *
 * The distinction is the whole file. `max_words` and `forbids` make a document read like a person
 * wrote it; `sums_to` and `nets_to` make it correct. A service with only the first has a style
 * guide, and a client who finds a wrong number stops trusting every other number in the document —
 * they do not grade it as mostly right.
 */
const ARITHMETIC: ReadonlySet<ShipCheck["kind"]> = new Set([
  "sums_to",
  "nets_to",
  "ratio_of",
  "counts",
  "agrees",
  "minor_units",
]);

/** Checks that tie a claim to something outside the model's imagination. */
const EVIDENCE: ReadonlySet<ShipCheck["kind"]> = new Set(["each_has", "not_when"]);

interface TaskSpec {
  internal?: boolean;
  deliverable_kind?: string;
  input_schema?: { properties?: Record<string, unknown> };
  output_schema?: JsonSchema;
  ship_requires?: string[];
  ship_checks?: unknown[];
  harness?: { strict_output?: boolean };
}

interface JsonSchema {
  required?: unknown;
  properties?: Record<string, { type?: unknown; enum?: unknown; items?: unknown }>;
}

/**
 * Field names that mean money or a count, when the schema does not say `number`.
 *
 * ON WORD BOUNDARIES, and that is not fussiness. The first version was a bare substring match and
 * `sum` fired on `client_summary` — which is on nearly every deliverable in the product — so almost
 * every job in every wedge was reported as having unchecked numbers. A quality tool that cries wolf
 * on ninety per cent of its subjects teaches people to skip it, which costs the ten per cent.
 */
const NUMERIC_NAME =
  /(^|_)(amount|total|sum|subtotal|balance|net|gross|price|cost|fee|minor|pct|percent|count|hours|qty|quantity|rate)(_|$)/i;

function looksNumeric(schema: JsonSchema | undefined): boolean {
  for (const [name, spec] of Object.entries(schema?.properties ?? {})) {
    const t = spec?.type;
    if (t === "number" || t === "integer") return true;
    if (Array.isArray(t) && t.some((x) => x === "number" || x === "integer")) return true;
    // A model writing "£4,469.39" into a string field is still a number a client will check.
    if (NUMERIC_NAME.test(name)) return true;
  }
  return false;
}

/**
 * The lists in this output that COULD name where each entry came from.
 *
 * ═══ ARRAYS OF OBJECTS ONLY, AND THAT IS A CORRECTION ═══
 *
 * This counted every array, and `claims-without-evidence` told the founder to "add `each_has` on
 * `color_palette` naming the field that carries the source". `color_palette` is an array of strings.
 * A string has no fields, so there is nothing for `each_has` to name — and `ship-checks.ts` already
 * records what happens if you try: *"an `each_has` pointed at a string array did nothing, and the
 * test that caught it said 'a typo here silently disables the gate'."*
 *
 * So the old rule produced a finding whose remedy provably cannot work, which is worse than no
 * finding: a founder who follows it installs a gate that passes forever.
 *
 * Measured against every service the meta-agent has written in production, 14 September: **24 of 30
 * flagged lists were arrays of strings** — `color_palette`, `typography_system`, `launch_checklist`,
 * `open_questions`. Four fifths of this rule's output was noise, and it was the joint-largest source
 * of weak findings on the screen where a founder decides whether to trust the service.
 *
 * It is also the right rule on its own terms. "Every claim names its source" is a demand about
 * CLAIMS. A checklist of typefaces is not a claim about the world; a finding, a risk or an
 * observation is, and those arrive as objects because they have more than one thing to say.
 */
function listFields(schema: JsonSchema | undefined): string[] {
  return Object.entries(schema?.properties ?? {})
    .filter(([, spec]) => {
      if (spec?.type !== "array") return false;
      const items = (spec as { items?: { type?: string; properties?: unknown } }).items;
      return items?.type === "object" && !!items.properties;
    })
    .map(([name]) => name);
}

/**
 * Can this job say "I could not"?
 *
 * Either a `not_when` check, or a status enum with a member that is plainly a refusal. geo-monitor's
 * `weekly_report` is the worked example: `status: "not_set_up"` with the measurement fields left
 * ABSENT rather than zeroed, because zero is a measurement and absence is the truth.
 */
function hasRefusal(spec: TaskSpec, checks: ShipCheck[]): boolean {
  if (checks.some((c) => c.kind === "not_when")) return true;
  for (const [name, prop] of Object.entries(spec.output_schema?.properties ?? {})) {
    /**
     * A BOOLEAN FLAG IS THE THIRD VALID SHAPE, and it was not recognised.
     *
     * This knew two: a `not_when` check, and a status enum carrying a refusing value. A plain
     * boolean — `could_not_complete: true` — is the shape `not_when` itself requires, because
     * `shipFaults` evaluates `at(parsed, unknown_when) === true` and can never read an enum value.
     * So a job could carry the exact field the enforcement mechanism needs and still be reported as
     * having no way to refuse.
     *
     * Matched on the NAME as well as the type: `sent: boolean` is not a refusal, and treating every
     * boolean as one would silence this finding on almost every job that has ever been written.
     */
    if (prop?.type === "boolean" && /^(could_not|cannot|no_|not_|unable)/i.test(name)) return true;
    const en = prop?.enum;
    if (!Array.isArray(en)) continue;
    if (en.some((v) => typeof v === "string" && /^(not_|no_|none|unavailable|blocked|insufficient|cannot)/i.test(v))) {
      return true;
    }
  }
  return false;
}

/**
 * The jobs a client actually receives something from. Everything else is machinery.
 *
 * ═══ AN AUTHORED SERVICE HANDS OVER A DOCUMENT EVEN WHEN IT NEVER SAYS SO ═══
 *
 * `kickoff.ts`'s `fulfillmentOf` defaults an authored wedge with no `fulfillment` block to
 * `["document"]`, with a comment saying exactly why: "otherwise the run goes green and Deliverables
 * stay empty." Nothing in the authoring path writes that block — `wedgeauthor.ts` never mentions
 * `fulfillment`, and the authoring contract skill never mentions `deliverable_kind` — so EVERY
 * generated service relies on that default.
 *
 * Without mirroring it here, this grader would tell a founder their new service delivers nothing, at
 * the exact moment they are deciding whether to trust it, about the one thing it definitely does.
 * Third time today that "agree with the machinery rather than re-deriving it" has been the fix.
 */
function clientFacing(m: WedgeManifest): Array<[string, TaskSpec]> {
  const declared = (m as { fulfillment?: { deliverable_shapes?: string[] } }).fulfillment?.deliverable_shapes ?? [];
  const wedgeShapes = declared.length ? declared : isAuthoredSlug(m.wedge) ? ["document"] : [];
  return Object.entries((m.task_types ?? {}) as Record<string, TaskSpec>).filter(([name, spec]) => {
    // `isOperationalTaskType` reads `internal` and `client_facing` itself now — see its header for
    // the three vocabularies this used to be one of. Asking it the whole question keeps this module
    // and the wrapper from disagreeing about the same task type, which they did.
    if (isOperationalTaskType(name, spec) || RESPONSIVE_TASKS.has(name)) return false;
    return !!(spec.deliverable_kind ?? wedgeShapes[0]);
  });
}

/**
 * Grade a service on whether its output can be trusted.
 *
 * `exemplars` is how many the RUN would actually mount, which is not the same as how many sit in
 * this wedge's directory. `exemplarSkills` reads one the founder uploaded, keyed to the project, and
 * it wins outright over a shipped one; `shippedExemplarSkills` is the floor beneath it. So the
 * caller counts what `runtime.ts` would mount, and passing a directory listing here would report a
 * gap the run does not have.
 */
export function gradeDeliverables(
  m: WedgeManifest,
  opts: {
    exemplars?: number;
    /**
     * The integrations that actually exist, when the caller could find out.
     *
     * PASSED IN rather than fetched, so this function stays pure and synchronous: a review screen
     * must not go red because Composio is slow, and a grade that makes a network call cannot be
     * tested without one. `undefined` means "could not check", which is treated as no finding — see
     * `unknown-toolkit` below for why that direction is the safe one.
     */
    knownToolkits?: ReadonlySet<string>;
  } = {},
): Grade {
  const findings: Finding[] = [];
  const add = (f: Finding) => findings.push(f);
  const jobs = clientFacing(m);

  /**
   * ═══ AN INTEGRATION THAT DOES NOT EXIST IS A SERVICE THAT CAN NEVER RUN ═══
   *
   * `fulfillment.client_connections[].toolkit` is validated by `TOOLKIT_RE` — `/^[a-z0-9_-]{1,64}$/`
   * — which checks the SHAPE of the string and nothing else. Nothing has ever compared it to the
   * catalogue. So `draft_service`, writing a manifest for a trade it has just been told about, can
   * emit `toolkit: "clio"` or `"sage_accounting"`, and it validates, promotes, and goes on the
   * clock.
   *
   * What the client then sees is "Connect your clio" over a button that cannot complete. The
   * ingredient is never obtained, so every run of that service ends by writing down what it needed
   * — which is measured, in production, at 1,924 such artifacts against 138 that were work.
   *
   * BLOCKING, because it is the same failure the `output_schema` rule already blocks on, one layer
   * earlier: the service will run, report success, and hand back a list. And it is overridable like
   * every other blocking finding — a founder who knows the client will email the file anyway is
   * entitled to run it.
   *
   * NO FINDING WHEN THE CATALOGUE COULD NOT BE READ. A blocking finding raised because our own
   * network was down would stop a founder promoting a perfectly good service, which is a worse
   * failure than the one being prevented and is not one they could diagnose.
   */
  /**
   * ═══ A SERVICE THAT CAN THINK AND CANNOT TRADE ═══
   *
   * FOUND IN PRODUCTION. `drafted:brand-and-website-projects` was authored from a founder's own
   * description, promoted on 14 August, and ran five times. Four task types with real schemas, eight
   * intake questions, a `waits_for` correctly gating visual work behind a client review — good work.
   * And NO `fulfillment` block, so kickoff raised no asks, no invoice was drafted, and ignition never
   * started production. Five runs, no deliverable, $0.23. It graded clean.
   *
   * Two fixes upstream of this one, and this rule is what is left over after both.
   *
   * `draft_service`'s schema now REQUIRES `fulfillment`, so the model is asked for it. And
   * `repairAuthoredManifest` DERIVES the structural half — `production_task_type` and
   * `deliverable_shapes` are facts about the task types already in the manifest, so refusing a
   * service for not restating them would be a gate with no door: there is no route that edits a
   * draft, only promote and reject.
   *
   * ═══ SO WHAT IS LEFT IS THE HALF NOBODY CAN DERIVE, AND IT IS WEAK, NOT BLOCKING ═══
   *
   * `money_plan` is the founder's pricing and `intake_asks` is trade knowledge. Guessing either
   * would be worse than leaving it blank — a plausible invented number on an invoice is the one
   * nobody thinks to check. They are named, so a founder knows what is missing and why nothing is
   * being billed, and the service can still run: a run that discovers it needs something raises the
   * ask itself, and a founder can invoice by hand.
   *
   * Blocking is reserved for "there is no path by which a client receives anything", which after the
   * repair pass can only happen when the manifest has no client-facing job at all — and
   * `delivers-nothing` above already says that.
   */
  const fulfillment = (m as { fulfillment?: Record<string, unknown> }).fulfillment;
  if (isAuthoredSlug(m.wedge) && fulfillment) {
    const plan = fulfillment.money_plan as { lines?: unknown[] } | undefined;
    if (!plan?.lines?.length) {
      add({
        rule: "no-money-plan",
        severity: "weak",
        // Theirs by definition: what a business charges is not derivable and must never be guessed.
        audience: "founder",
        says: "Nothing here says what this engagement charges, so no invoice will ever be drafted for it.",
        fix: "Set a deposit and/or a monthly fee for this service.",
        because:
          "The work still runs and still reaches the client. It just never turns into an invoice, and the first time anyone notices is when the month ends.",
      });
    }
  }

  if (opts.knownToolkits) {
    for (const conn of m.fulfillment?.client_connections ?? []) {
      const toolkit = String((conn as { toolkit?: unknown }).toolkit ?? "").trim().toLowerCase();
      if (!toolkit || opts.knownToolkits.has(toolkit)) continue;
      add({
        rule: "unknown-toolkit",
        severity: "blocking",
        // `saidInline`, not the raw slug: `dentally_practice_manager` is a key in a catalogue, and
        // this sentence is read by a founder who never typed it — the author did. What they need
        // from it is "the thing this wants to connect to does not exist", and an underscored
        // identifier only makes that harder to read.
        says: `This service asks the client to connect "${saidInline(toolkit)}", which is not an integration that exists.`,
        fix: `Either name an integration we have, or ask for the file instead — an intake ask ("send us your latest export") always works and an integration we do not have never does.`,
        because:
          "A connection ask that cannot complete leaves the run without its inputs forever, so the service succeeds every month and delivers a list of what it needed.",
      });
    }
  }

  if (!jobs.length) {
    /**
     * MACHINERY IS NOT A FAILED TRADE.
     *
     * gtm-operator finds clients, invoice-chaser chases money, business-shaper reads a description.
     * None of them hands a client a deliverable and all of them are working correctly. The first
     * version graded them "Not ready for a client", which is both wrong and the loudest thing on the
     * screen — and it is the same insight loop-coverage.ts turns on: only DELIVER is the trade.
     *
     * A role is the manifest's own statement that it is machinery, so it is the right signal. A
     * wedge claiming no role and delivering nothing is the real finding: it is neither.
     */
    if ((m.provides ?? []).length > 0) {
      return {
        findings,
        blocking: 0,
        weak: 0,
        verdict: "This is machinery rather than a trade — it hands a client nothing, which is correct for what it does.",
      };
    }
    add({
      rule: "delivers-nothing",
      severity: "blocking",
      says: "Nothing in this service hands anything to a client, and it claims no machinery role either.",
      fix: "Give the job that produces the client's work a `deliverable_kind`, or declare `fulfillment.deliverable_shapes` for the whole service.",
      because: "A service that neither delivers nor runs machinery is neither. There is nothing to invoice for.",
    });
  }

  for (const [name, spec] of jobs) {
    const checks = readShipChecks(spec.ship_checks);
    const requires = spec.ship_requires ?? [];
    const required = Array.isArray(spec.output_schema?.required) ? (spec.output_schema!.required as string[]) : [];

    /**
     * ═══ BLOCKING IS "NOTHING STOPS A BLANK", AND BOTH GATES HAVE TO BE ABSENT ═══
     *
     * The first version fired on a missing `output_schema.required` alone, and that was stricter
     * than the machinery. `isObjectSchema` demands `properties` and not `required`, so a real
     * generated draft often has none — and `repairAuthoredManifest` infers `ship_requires` from the
     * schema, which catches an empty output at the ship gate whether `required` is there or not.
     *
     * So a draft with inferred `ship_requires` and no `required` is protected, and blocking it would
     * have refused most of what the generator legitimately produces. Two gates, and the finding is
     * that BOTH are missing: then nothing at all stands between an empty object and a client.
     */
    if (!required.length && !requires.length) {
      add({
        rule: "no-output-contract",
        severity: "blocking",
        task: name,
        says: `"${said(name)}" is what a client receives, and nothing says the work has to contain anything.`,
        fix: "Name the fields the work is not finished without, in `ship_requires` — or in `output_schema.required`.",
        because:
          "With neither, an empty object validates and ships. The run reports success and the client gets a blank.",
      });
    } else if (!checks.length) {
      add({
        rule: "unchecked-output",
        severity: "weak",
        task: name,
        says: `Something must be in what "${said(name)}" produces, and nothing checks whether it is right.`,
        fix: "Add at least one `ship_checks` entry about the truth of the output, not just its presence.",
        because:
          "An empty-section report scored 0/1.0 with a judge for exactly this: it looks like work and carries no truth.",
      });
    }

    if (looksNumeric(spec.output_schema) && !checks.some((c) => ARITHMETIC.has(c.kind))) {
      add({
        rule: "numbers-unchecked",
        severity: "weak",
        task: name,
        says: `"${said(name)}" puts numbers in front of a client and nothing checks them against each other.`,
        fix: "Add `sums_to` for a total against its lines, `ratio_of` for a percentage against the two counts it comes from, `nets_to` for one figure equalling another minus a third, or `minor_units` for money printed in the wrong scale.",
        because:
          "A close reported revenue 8,200.00, expenses 4,129.39 and net 3,730.61 — the first two imply 4,070.61 — then quoted both. The client had to find it, and a client who finds one wrong number stops trusting the rest.",
      });
    }

    const lists = listFields(spec.output_schema);
    if (lists.length && !checks.some((c) => EVIDENCE.has(c.kind))) {
      add({
        rule: "claims-without-evidence",
        severity: "weak",
        task: name,
        says: `"${said(name)}" produces a list of ${saidInline(lists[0]!)} and nothing makes each entry name where it came from.`,
        fix: `Add \`each_has\` on \`${lists[0]}\` naming the field that carries the source.`,
        because:
          "A proposal written from a transcript is one prompt away from a proposal written from the model's idea of what a bakery needs. The difference is invisible to the founder skimming it and obvious to the client, who was on the call.",
      });
    }

    if (!hasRefusal(spec, checks)) {
      add({
        rule: "no-refusal-path",
        severity: "weak",
        task: name,
        says: `"${said(name)}" has no way to say it could not do the job, so when it has nothing it will produce something anyway.`,
        fix: "Give the output a status with a plainly-named refusal, and leave the measurement fields ABSENT in that state rather than zero.",
        because:
          "Zero is a measurement; absence is the truth. A client reading 'no mentions this week' believes you looked.",
      });
    }

    if (checks.length && !checks.some((c) => ARITHMETIC.has(c.kind) || EVIDENCE.has(c.kind))) {
      add({
        rule: "style-only-bar",
        severity: "note",
        task: name,
        says: `The checks on "${said(name)}" are all about how the work reads, not whether it is right.`,
        fix: "Keep them, and add one that could catch a wrong answer rather than an ugly one.",
        because: "A style guide is not a quality bar. It makes a wrong document read well.",
      });
    }

    if (!spec.input_schema?.properties) {
      add({
        rule: "input-unspecified",
        severity: "note",
        task: name,
        says: `"${said(name)}" does not say what it is given, so a run cannot tell a measurement from a suggestion.`,
        fix: "Declare `input_schema`, describing each field as something already established.",
        because:
          "A weekly_report was handed eight already-measured queries, could not tell they were measurements, went and re-probed, and joined having written nothing.",
      });
    }
  }

  if (jobs.length && !(m.capabilities ?? []).length && !(m.intake ?? []).length) {
    add({
      rule: "needs-nothing",
      severity: "weak",
      says: "This service asks for nothing — no connection, and no question at intake.",
      /*
        Reworded to the half a founder can act on. The original named `capabilities` and intake
        questions — the first is ours to declare and the second is a manifest field, so the sentence
        asked them to edit a file. What they CAN do is say which of their systems the work comes out
        of, which is the same requirement in their own terms.
      */
      audience: "founder",
      fix: "Say which of your systems this work comes out of, so it can be connected — or what you would have to be asked before it could start.",
      because:
        "Real work needs the client's material. A service that needs nothing is usually one that will invent what it does not have.",
    });
  }

  if (jobs.length && !opts.exemplars) {
    /**
     * THE FOUNDER'S ACTION, NOT A DEFECT IN THE SERVICE — and the first wording had that backwards.
     *
     * It read "nothing here shows how good the work has to be", which sounds like something wrong
     * with what was just written for them. It is not. `exemplarSkills` mounts an example the founder
     * uploaded at onboarding, keyed to the PROJECT rather than the wedge, so it reaches every trade
     * they run including this one — and `runtime.ts` says the quiet part in its own comment: most
     * accounts never reach that screen, so the path mounts nothing and the run is back to prose
     * rules with no demonstration.
     *
     * So the finding is about a thirty-second action with the highest signal available to them.
     * Their own work carries their voice, their client's expectations and their firm's habits, none
     * of which is ours to invent — which is exactly why a generated example would be worthless here:
     * a model grading itself against its own idea of good.
     */
    add({
      rule: "no-exemplar",
      severity: "note",
      // Only they have it. A generated example would be the model grading itself.
      audience: "founder",
      says: "It has rules for the work and no example of it done well.",
      fix: "Upload one deliverable you have already sent a client. It becomes the bar for every job this runs, not just this service.",
      because:
        "A run shown a finished piece by a professional in the trade produces different work from one told the rules. Yours carries your voice and your clients' expectations — a generated example would be the model grading itself against its own idea of good.",
    });
  }

  const blocking = findings.filter((f) => f.severity === "blocking").length;
  const weak = findings.filter((f) => f.severity === "weak").length;
  /*
    The verdict counts JOBS WITH NO GATE, not findings. See `verdictFor` — a count of findings does
    not know how big the service is, and it was calling a six-job service with seven gates
    "almost nothing checks whether the work is right".
  */
  const unchecked = findings.filter((f) => f.rule === "unchecked-output" || f.rule === "no-output-contract").length;
  return { findings, blocking, weak, verdict: verdictFor(jobs.length, blocking, unchecked, weak) };
}

/**
 * The one sentence at the top of the review screen, and the only part of the grade most founders will
 * read.
 *
 * ═══ IT COUNTS COVERAGE, NOT FINDINGS, AND THAT IS A CORRECTION ═══
 *
 * This was `weak >= 3 → "almost nothing checks whether the work is right"`. An absolute count knows
 * nothing about how big the service is, so a two-job service and a nine-job service are judged on the
 * same threshold, and a service earns the worst sentence available by being LARGER.
 *
 * Measured on production, 14 September, after the refusal and evidence gates started reaching stored
 * services: `drafted:geo-audit-and-action-plan` carried SEVEN `ship_checks` — an `each_has` on each of
 * three evidence lists, a word floor and a forbidden-phrase gate on the summary — and was still told
 * "almost nothing checks whether the work is right". That is not a harsh verdict, it is a false one,
 * and a false verdict on this screen is worse than a harsh one: a founder who reads it, looks at the
 * gates, and sees they disagree has learned the grade is decoration.
 *
 * So it counts the thing the sentence is ABOUT — how many jobs hand a client something with no gate
 * on it at all. Each tier below is literally checkable against the manifest by anybody who doubts it.
 */
function verdictFor(jobs: number, blocking: number, unchecked: number, weak: number): string {
  if (blocking) {
    return "Not ready for a client. What this hands over is not checked at all, and a run could report success on an empty document.";
  }
  if (!jobs) return "This has no client work in it.";
  if (unchecked >= jobs) {
    return "It will produce work, and nothing checks whether the work is right. Fine to try on your own business, not on a client who is paying.";
  }
  if (unchecked * 2 > jobs) {
    return "Some of this is checked before it goes out and most of it is not. Worth closing that before a client pays for it.";
  }
  if (unchecked) {
    return "Most of what this hands over is checked, and a few jobs are not. Those are the ones to watch on the first run.";
  }
  if (weak) {
    return "It will produce checked work, with gaps worth closing before a client pays for it.";
  }
  return "What this hands over is checked before a client sees it.";
}


/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * THE SAME FINDING, FIVE TIMES, IS ONE FACT AND FOUR ROWS OF NOISE
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `findings` is per-job on purpose: it is the diagnostic truth, every test in this repo enumerates it,
 * and `the-catalogue-is-graded.test.ts` ratchets on the count. This is what a FOUNDER sees instead.
 *
 * Measured on `drafted:brand-and-website-projects`, 14 September. Four of its jobs have no gate, so
 * the review card rendered:
 *
 *     Something must be in what "Shape brand strategy" produces, and nothing checks whether it is right.
 *     Something must be in what "Develop brand identity" produces, and nothing checks whether it is right.
 *     Something must be in what "Build marketing website" produces, and nothing checks whether it is right.
 *     2 more, and everything blocking is listed first.
 *
 * Three near-identical sentences and a promise of more, in the place where somebody decides whether to
 * trust a machine-written service. `UX.md` rule 2 is "no list of near-identical rows", and the
 * founder's own words for this pattern were *"we shouldn't bombard them with these cards ... they feel
 * panicked"*. The information is one fact — four jobs are ungated — and reading it four times does not
 * make it four facts.
 *
 * ═══ WHY THE PLURAL PROSE LIVES HERE AND NOT IN THE CARD ═══
 *
 * The singular sentences are in this file. Writing their plurals in the console would put two
 * descriptions of one finding in two repos, and the one nobody is looking at goes stale. So the
 * collapse happens beside the prose it collapses, and the card renders whatever it is handed.
 *
 * SEVERITY AND AUDIENCE SURVIVE. A collapsed row keeps the worst severity of its group and the
 * `audience` of the first — the fix is identical across a group by construction, since it is the same
 * rule.
 */
export function collapseForFounder(findings: readonly Finding[]): Finding[] {
  const order: string[] = [];
  const groups = new Map<string, Finding[]>();
  for (const f of findings) {
    if (!groups.has(f.rule)) { groups.set(f.rule, []); order.push(f.rule); }
    groups.get(f.rule)!.push(f);
  }
  const worst = (g: readonly Finding[]): Finding["severity"] =>
    g.some((f) => f.severity === "blocking") ? "blocking" : g.some((f) => f.severity === "weak") ? "weak" : "note";

  return order.map((rule) => {
    const g = groups.get(rule)!;
    const first = g[0]!;
    if (g.length === 1) return first;
    return { ...first, severity: worst(g), says: MANY[rule]?.(g.length) ?? `${first.says} (and ${g.length - 1} other jobs)` };
  });
}

/**
 * One sentence for a finding that fired on several jobs at once.
 *
 * Every rule that CAN repeat has an entry, and `a-grade-a-founder-can-read.test.ts` enumerates the
 * rules to prove it — the fallback above is a safety net, not a plan, because "(and 3 other jobs)"
 * appended to a sentence that names one job by title reads like a mistake.
 */
const MANY: Record<string, (n: number) => string> = {
  "no-output-contract": (n) =>
    `${n} jobs hand something to a client, and nothing says the work has to contain anything.`,
  "unchecked-output": (n) =>
    `${n} jobs produce work for a client and nothing checks whether it is right.`,
  "numbers-unchecked": (n) =>
    `${n} jobs put numbers in front of a client and nothing checks them against each other.`,
  "claims-without-evidence": (n) =>
    `${n} jobs produce lists where nothing makes each entry say where it came from.`,
  "no-refusal-path": (n) =>
    `${n} jobs have no way to say they could not do the work, so when they have nothing they will produce something anyway.`,
  "style-only-bar": (n) =>
    `The checks on ${n} jobs are all about how the work reads, not whether it is right.`,
  "input-unspecified": (n) =>
    `${n} jobs do not say what they are given, so a run cannot tell a measurement from a suggestion.`,
  "unknown-toolkit": (n) =>
    `This service asks the client to connect ${n} integrations that do not exist.`,
};
