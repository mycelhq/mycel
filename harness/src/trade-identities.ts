// The relations a trade's own deliverable has to satisfy, learned rather than hard-coded.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// EVERY TRADE HAS ARITHMETIC, AND IT IS THE TRADE'S, NOT OURS
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// books-keeper carries eleven `ship_checks` and every one was written after a paying client objected
// to a deliverable — a total that disagreed with its lines, a profit that was not revenue minus
// costs, £34,000.00 printed for 34000 minor units. Thirty-two runs of hardening, on ONE service.
//
// `infer-checks.ts` recovers some of that from the shape of a schema, and it is deliberately
// conservative: a list of objects with a numeric field beside a matching total is `sums_to`, and
// that is a join rather than a judgement. What it cannot recover is anything the SCHEMA does not
// already imply — because the relation lives in the trade, not in the field names.
//
//   A recruiter's longlist: presented + rejected + shortlisted = screened.
//   A GEO report: share of voice is mentions over queries.
//   A studio's invoice: hours × rate, less the deposit, is the balance.
//   A surveyor's schedule: measured quantities × unit rates is the total.
//
// None of those is derivable from property names. All of them are the first thing a practitioner
// would tell you, and all of them are on the internet.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// SO THE RESEARCH GOES AND ASKS, AND THIS TURNS THE ANSWER INTO A GATE
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// `research_service` already leaves the building to find out how a trade is delivered. It now also
// reports the trade's identities — in plain words, with the role each field plays — and this module
// maps them onto the closed `ShipCheck` vocabulary.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// WHY THE MODEL NEVER NAMES A CHECK KIND
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// It reports a SHAPE — "a total of a list", "one figure less another" — and the mapping to `kind` is
// here, in code. infer-checks.ts states the hazard: `ship_checks` is a closed vocabulary parsed by
// `readShipChecks`, and a model inventing `kind: "looks_right"` produces a check that is silently
// dropped at load. A gate that reports as present and does nothing is worse than no gate, because
// somebody stops looking.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// AND A CHECK NAMING A FIELD THAT DOES NOT EXIST IS REFUSED
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// This is the whole safety of the thing. The research learned the trade; it did NOT write the output
// schema, so it is guessing at field names. A `sums_to` pointing at `line_items` when the schema says
// `lines` never fires — silently, forever — and the service ships believing it is gated.
//
// So every field named by an identity is checked against the schema the draft actually declares, and
// an identity that does not resolve completely is DROPPED. Better four checks that certainly fire
// than eleven that mostly do; the same bar infer-checks.ts sets for itself.
import type { ShipCheck } from "./ship-checks";

/** The shapes a trade's arithmetic comes in. Deliberately not `ShipCheck["kind"]` — see the header. */
export type IdentityShape = "sum_of_list" | "difference" | "ratio" | "count_of_list" | "unknowable";

export interface TradeIdentity {
  /** The relation in the practitioner's words. Carried into the skill, never into a check. */
  says: string;
  shape: IdentityShape;
  /** Which output field plays which role. Names are the research's guess and are verified below. */
  fields: {
    /** `sum_of_list`, `count_of_list`: the list. */
    items?: string;
    /** `sum_of_list`: the numeric field on each entry. */
    each?: string;
    /** `sum_of_list`, `difference`: the figure that must equal the rest. */
    total?: string;
    /** `difference`: total = minuend - subtrahend. */
    minuend?: string;
    subtrahend?: string;
    /** `ratio`: pct = numerator / denominator. */
    numerator?: string;
    denominator?: string;
    pct?: string;
    /** `count_of_list`, `unknowable`: the stated figure. */
    field?: string;
    /** `unknowable`: the boolean that says the figure cannot be established. */
    unknown_when?: string;
  };
  /** Where the research found it. Required by the research contract; unused here except in logs. */
  source?: string;
}

interface JsonSchema {
  properties?: Record<string, { type?: unknown; items?: { properties?: Record<string, unknown> } }>;
}

/** Every field path the output schema declares, including one level into an array's entries. */
function declaredPaths(schema: unknown): Set<string> {
  const out = new Set<string>();
  const props = (schema as JsonSchema | undefined)?.properties;
  if (!props) return out;
  for (const [name, spec] of Object.entries(props)) {
    out.add(name);
    // `sums_to.each` names a field on the ENTRIES, not on the object — `lines[].charge_minor` is
    // written as `charge_minor`. Without this the most valuable check in the vocabulary never maps.
    for (const inner of Object.keys(spec?.items?.properties ?? {})) out.add(inner);
  }
  return out;
}

/**
 * Turn what the research learned into gates the kernel will actually run.
 *
 * Pure, and takes the schema rather than reading one, so every drop below is testable against a
 * fixture without a model or a store.
 */
export function identitiesToChecks(identities: readonly TradeIdentity[], outputSchema: unknown): ShipCheck[] {
  const known = declaredPaths(outputSchema);
  const has = (...names: (string | undefined)[]): boolean =>
    names.every((n) => typeof n === "string" && n.length > 0 && known.has(n));

  const out: ShipCheck[] = [];
  for (const id of identities ?? []) {
    const f = id?.fields ?? {};
    switch (id?.shape) {
      case "sum_of_list":
        if (has(f.items, f.each, f.total)) {
          out.push({ kind: "sums_to", items: f.items!, each: f.each!, total: f.total! });
        }
        break;
      case "difference":
        if (has(f.minuend, f.subtrahend, f.total)) {
          out.push({ kind: "nets_to", minuend: f.minuend!, subtrahend: f.subtrahend!, total: f.total! });
        }
        break;
      case "ratio":
        if (has(f.numerator, f.denominator, f.pct)) {
          out.push({ kind: "ratio_of", numerator: f.numerator!, denominator: f.denominator!, pct: f.pct! });
        }
        break;
      case "count_of_list":
        if (has(f.items, f.field)) out.push({ kind: "counts", items: f.items!, field: f.field! });
        break;
      case "unknowable":
        if (has(f.field, f.unknown_when)) {
          out.push({ kind: "not_when", field: f.field!, unknown_when: f.unknown_when! });
        }
        break;
      default:
        // An unrecognised shape is dropped in silence, like a malformed check in `readShipChecks`.
        break;
    }
  }
  return dedupe(out);
}

/**
 * The same relation learned twice is one gate.
 *
 * Research reads several sources and two of them will state the same identity in different words.
 * Two identical `sums_to` entries would fail a deliverable once and report it twice, which reads to
 * a founder like two separate problems with their work.
 */
function dedupe(checks: ShipCheck[]): ShipCheck[] {
  const seen = new Set<string>();
  return checks.filter((c) => {
    const key = JSON.stringify(c);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The identities as a skill page, for the ones that could not become checks.
 *
 * A relation that names a field the schema does not have is still TRUE about the trade — it just
 * cannot be enforced. Dropping it entirely would throw away the most valuable thing the research
 * found, so it goes where a practitioner would put it: in the instructions the run reads before it
 * starts, where the agent can honour it even though nothing verifies that it did.
 */
export function identitiesAsSkill(identities: readonly TradeIdentity[]): string | undefined {
  const said = (identities ?? []).map((i) => i?.says).filter((s): s is string => !!s?.trim());
  if (!said.length) return undefined;
  return [
    "# What has to add up in this trade",
    "",
    "These are the relations practitioners expect to hold in this deliverable. Some are enforced by",
    "the gate before a client sees the work; the rest are on you.",
    "",
    ...said.map((s) => `- ${s}`),
    "",
    "If one of these cannot be made true, say so in the output and say why. A figure that does not",
    "reconcile, reported as reconciled, is the one thing a client checks and the one thing that ends",
    "the engagement.",
  ].join("\n");
}

export interface TradeMechanic {
  /** The structural rule, stated so it can be followed. */
  rule: string;
  /** What goes wrong without it. This is what makes a rule stick rather than get skipped. */
  why?: string;
  source?: string;
}

/**
 * The trade's structural rules as a page the run reads before it starts.
 *
 * NOT GATEABLE, and that is the point of having it. `identitiesToChecks` handles the relations that
 * can be verified arithmetically; this is everything a practitioner knows that cannot be checked by
 * comparing two numbers — how pages link to each other, the order reliefs are applied, how a
 * scorecard is anchored so two interviewers agree.
 *
 * It is the part of a trade that reads as arbitrary until somebody explains it, and it is usually
 * the difference between work that passes and work that wins. Nothing verifies the run honoured it.
 * An instruction followed most of the time still beats a fact nobody was told.
 */
export function mechanicsAsSkill(mechanics: readonly TradeMechanic[]): string | undefined {
  const rules = (mechanics ?? []).filter((m) => m?.rule?.trim());
  if (!rules.length) return undefined;
  return [
    "# How this trade is judged",
    "",
    "These are the structural rules practitioners in this trade follow. They are not the steps — they",
    "are the shape the work has to have to be taken seriously by somebody who buys it often.",
    "",
    ...rules.flatMap((m) => [`## ${m.rule.trim()}`, "", ...(m.why?.trim() ? [m.why.trim(), ""] : [])]),
    "If following one of these is impossible for this client, say so in the output rather than",
    "quietly skipping it. A deliverable that ignores the trade's own conventions reads as amateur to",
    "the one person whose opinion decides whether there is a second engagement.",
  ].join("\n");
}
