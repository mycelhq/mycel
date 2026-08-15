// Knowledge distillation — the mechanism that turns a founder's corrections into durable expertise.
//
// The commercial claim this product is sold on is that the agent gets better at YOUR business the
// more you use it. Intake already got half of that right: the agent records what it didn't know
// (`$MYCEL_GAPS_URL`), the founder answers, and the answer is mounted as a knowledge file on the
// next run. But an answered question is not expertise, and this is where the previous design ran
// out: a correction was filed as a markdown file next to a hundred other markdown files, nothing
// noticed the same gap being asked for the fourth time, nothing noticed that last month's pricing
// note now contradicts this month's, and nothing could tell you whether any of it worked.
//
// WHAT MAKES A PRACTITIONER AN EXPERT
//
// Not more context. A domain expert holds four things that are almost never written down:
//
//   1. Tacit rules      — "we never chase a client in their first 30 days".
//   2. Exceptions       — "…except Northwind, who asked us to".
//   3. House style      — how a chase is worded so it doesn't read like a debt collector.
//   4. Prohibitions     — the things that must never happen, whatever else is true.
//
// You cannot get those by asking. A founder asked "what's your house style?" writes three bland
// sentences. But a founder shown a draft they don't like will REWRITE IT, and the delta between
// what the agent proposed and what the human actually sent is the house style, stated precisely, in
// their own words, on a real job. That delta is the highest-signal input in the whole system, and
// it is free — it is a by-product of the approval gate that already exists.
//
// So distillation is grounded in exactly two things, and deliberately nothing else:
//
//   • HUMAN CORRECTIONS — an approve-with-edit, a gap answer, a rejection, a written feedback note.
//   • OBSERVED OUTCOMES — what actually happened afterwards (was the next draft edited again?).
//
// THE DELIBERATE OMISSION, KEPT
//
// intake.ts refuses to paraphrase a founder's answer with a model, on the grounds that a summary
// that quietly drops the one clause that mattered is worse than no answer and the founder has no
// way to tell. That reasoning holds here and this module obeys it. Distillation is DETERMINISTIC:
// the rule's scope, subject and strength are computed from the structure of the correction, and its
// evidence is the human's own bytes, verbatim. Nothing here asks a model what it learned — a model
// asserting it has learned something is not evidence of anything, and a system that believed such
// assertions would confidently accumulate its own hallucinations as "expertise".
//
// What IS distilled, then? The framing. A raw transcript ("agent wrote X, founder sent Y") is not
// usable at prompt time: it has no scope, so it can't be retrieved; no subject, so it can't be
// deduplicated or contradicted; and no strength, so it can't be prioritised when the budget is
// tight. Distillation attaches those three, and keeps the human's words untouched underneath.
import { randomUUID } from "node:crypto";
// Type-only, deliberately. knowledge.store.ts imports this module for its types, so a value import
// in this direction would close a cycle; `import type` is erased and cannot. Every function below
// that touches persistence takes the store as an argument instead of reaching for the singleton,
// which is also what makes them testable without booting anything.
import type { KnowledgeStore, Observation } from "./knowledge.store";

/** How hard a rule binds. The ordering matters — see `STRENGTH` and the retrieval budget. */
export type RuleKind = "never" | "always" | "prefer" | "fact";

/**
 * Ranked strength. Used in two places, both of which are about not losing the important thing:
 * supersession (a prohibition should not be silently downgraded) and budget selection (if only
 * some rules fit, drop the stylistic preference before the prohibition).
 */
export const STRENGTH: Record<RuleKind, number> = { never: 3, always: 2, prefer: 1, fact: 0 };

/**
 * Where a rule came from. Every value here names a HUMAN act or an agent-reported gap on a real
 * job. There is deliberately no "inferred" or "self_reported" source: if the only witness to a
 * lesson is the model that claims to have learned it, it is not a lesson, it's a guess with
 * provenance-shaped decoration.
 *
 * `onboarding` is the newest value and the one that needed the most argument, because it very
 * nearly WAS that forbidden source. A founder answering questions on the setup screen has a human
 * witness — them, typing — so it clears the bar the paragraph above sets. But it is a categorically
 * weaker fact than everything else in this union, and pretending otherwise would poison the learned
 * layer permanently:
 *
 *   • Every other source is OBSERVED. Something was proposed on a real job with real consequences
 *     and a human reacted to it. The lesson is grounded in an event that happened.
 *   • `onboarding` is STATED. It is what someone believes about their own business at the moment
 *     they are trying to get through a signup flow, before a single job has run. People describe
 *     their own working rules inaccurately — not dishonestly, just from memory, and optimistically
 *     ("we always reply within the hour"). The screen also rewards finishing, which is exactly the
 *     wrong incentive for an accurate answer.
 *
 * Filing that as `gap_answer` — which is what the onboarding interview did before this value
 * existed — was the most damaging option available. `gap_answer` means "the agent hit this on a
 * real job and the founder told it the truth"; mixing the two makes the distinction unrecoverable,
 * and there is no migration back from a mislabelled provenance. Every rule seeded at signup would
 * have been indistinguishable, forever, from one earned by working.
 *
 * So it is labelled, and `EVIDENCE` below is what makes the label bind rather than decorate.
 */
export type RuleSource =
  | "approval_edit"
  | "gap_answer"
  | "task_feedback"
  | "rejection"
  | "authored"
  | "onboarding";

/**
 * How good the witness is. Two ranks, and the boundary is observed-versus-stated.
 *
 * This is NOT a second `STRENGTH`. `STRENGTH` ranks how hard a rule binds once you believe it
 * ("never" beats "prefer"); `EVIDENCE` ranks whether it should be believed at all. They are
 * orthogonal, which is precisely why a stated `never` must not outrank an observed `prefer`: a
 * founder who typed "we never work weekends" into a signup form and then approved a Saturday send
 * has told us two things, and the second one is the one that happened.
 *
 * `authored` sits at 1 deliberately, even though nobody observed it either. It is product content
 * shipped in the wedge, written by someone who studied the trade, and it is the baseline the wedge
 * was designed against — and it is never tenant-specific, so it cannot be contradicted by one
 * business's own behaviour the way a stated claim about THAT business can.
 */
export const EVIDENCE: Record<RuleSource, number> = {
  approval_edit: 1,
  gap_answer: 1,
  task_feedback: 1,
  rejection: 1,
  authored: 1,
  onboarding: 0,
};

/** Was this learned by watching, or by asking before anything had happened? */
export const isStated = (r: { provenance: RuleProvenance }): boolean =>
  EVIDENCE[r.provenance.source] === 0;

export interface RuleProvenance {
  source: RuleSource;
  /** The job this was learned on. The founder can open it and see the context. */
  task_id?: string;
  approval_id?: string;
  gap_id?: string;
  /** The question, when the rule came from one. */
  question?: string;
  /**
   * The agent's version and the human's version, VERBATIM and untruncated at the point of capture.
   * "Here is what good looks like" teaches far less than "here is what it wrote and here is what I
   * sent instead" — the contrast is where the style is legible.
   */
  before?: string;
  after?: string;
  at: string;
}

/** A durable, retrievable unit of domain expertise. */
export interface Rule {
  id: string;
  /** Tenant. Never optional: a rule learned from one business must be unreachable from another. */
  project_id: string;
  wedge: string;
  /**
   * The exception scope. A rule learned while working for one client governs that client only —
   * "Northwind wants Friday summaries" is not a house rule, and applying it to everyone is exactly
   * how a system that "learns" makes a business worse.
   */
  client_id?: string;
  /**
   * WHO THIS RULE MAY REACH. See `KnowledgeSensitivity` and `ruleMayApply`.
   *
   * Optional in the type only because rows written before this field existed do not have it; those
   * default CLOSED (`client`), which with no `client_id` means they reach nobody. Every write site
   * sets it via `scopeMeta`, so an unlabelled row is by definition legacy, never new.
   */
  sensitivity?: KnowledgeSensitivity;
  /**
   * Task types this applies to. Empty means the whole wedge. A correction is captured against the
   * task type it happened on, because "how to word a chase" and "how to word a monthly summary"
   * are different jobs and a rule that leaks between them is noise at best.
   */
  task_types: string[];
  /**
   * WHAT THE RULE IS ABOUT — e.g. `send_email.subject`, `gap:late-payment-fee`.
   *
   * This is the load-bearing field. It is what makes two rules comparable without understanding
   * them: same subject + same scope = same question, so a later answer contradicts an earlier one.
   * Derived structurally (action + field, or the gap's stable id), never guessed from prose.
   */
  subject: string;
  /** The rule, one imperative line. The evidence lives in `provenance`. */
  text: string;
  kind: RuleKind;
  status: "active" | "superseded";
  /** The rule that replaced this one. Set on supersession; the row is kept, never deleted. */
  superseded_by?: string;
  /**
   * How many times a human independently produced the same correction. Two founders' worth of
   * evidence is not available, but the same founder making the same edit twice is: it promotes a
   * one-off to a habit, and habits outrank one-offs when the prompt budget is tight.
   */
  corroborations: number;
  /**
   * Corrections on this subject AFTER this rule became active. The honest per-rule measurement:
   * if the agent is still being corrected on something a rule already covers, the rule is not
   * working — it is badly worded, or it is never being retrieved — and no amount of accumulation
   * fixes that. Surfaced rather than silently tolerated.
   */
  corrections_since: number;
  /** Times this rule was actually selected into a prompt. Distinguishes "wrong" from "never read". */
  uses: number;
  /**
   * A supersession a human should look at: something weaker replaced a prohibition. Automatic
   * "newer wins" is right for pricing and wrong for "never email this client after 6pm".
   */
  needs_review: boolean;
  provenance: RuleProvenance;
  created_at: string;
  updated_at: string;
}

export type NewRule = Omit<
  Rule,
  "id" | "status" | "superseded_by" | "corroborations" | "corrections_since" | "uses" | "needs_review" | "created_at" | "updated_at"
> &
  Partial<Pick<Rule, "corroborations" | "needs_review">>;

/** A single field the human changed. The atom distillation is built from. */
export interface FieldChange {
  field: string;
  before?: string;
  after?: string;
  change: "rewritten" | "added" | "removed";
}

const str = (v: unknown): string =>
  v === undefined || v === null ? "" : typeof v === "string" ? v : JSON.stringify(v);

/** Whitespace/case-insensitive equality — "the same correction", as a human would judge it. */
export const sameText = (a?: string, b?: string): boolean =>
  (a ?? "").trim().replace(/\s+/g, " ").toLowerCase() === (b ?? "").trim().replace(/\s+/g, " ").toLowerCase();

/**
 * What the human changed, field by field.
 *
 * Top-level keys only, on purpose. The approval preview is the shape a human was shown and edited;
 * recursing into nested structures would manufacture subjects like `payload.meta.headers.0` that
 * nobody can read, can't be contradicted meaningfully, and would fragment one edit into six rules.
 */
export function diffPayload(
  proposed: Record<string, unknown>,
  edited: Record<string, unknown>,
): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const field of new Set([...Object.keys(proposed ?? {}), ...Object.keys(edited ?? {})])) {
    const before = str(proposed?.[field]);
    const after = str(edited?.[field]);
    if (sameText(before, after)) continue;
    // An approve-with-edit sends the payload the human wants sent. A key that is simply absent from
    // it was not necessarily deleted — some UIs send only what changed — so absence is only read as
    // a removal when the edit is clearly a full payload (it carries other fields too).
    const wholePayload = Object.keys(edited ?? {}).length > 1;
    if (!after && before && wholePayload) changes.push({ field, before, change: "removed" });
    else if (!after) continue;
    else if (!before) changes.push({ field, after, change: "added" });
    else changes.push({ field, before, after, change: "rewritten" });
  }
  return changes;
}

/**
 * Turn an approve-with-edit into candidate rules — one per field the human actually changed.
 *
 * The wording is deliberately thin. It says WHERE the rule applies and WHICH VERSION to match; the
 * teaching is done by the verbatim before/after that travels in provenance and is rendered with the
 * rule. Anything cleverer would be this module inventing an interpretation of the founder's edit,
 * which is the one thing it must not do.
 */
export function distillFromApprovalEdit(args: {
  project_id: string;
  wedge: string;
  task_type: string;
  client_id?: string;
  action: string;
  proposed: Record<string, unknown>;
  edited: Record<string, unknown>;
  task_id?: string;
  approval_id?: string;
  at?: string;
}): NewRule[] {
  const at = args.at ?? new Date().toISOString();
  return diffPayload(args.proposed, args.edited).map((ch) => {
    const base = {
      project_id: args.project_id,
      wedge: args.wedge,
      ...scopeMeta(args.client_id),
      task_types: args.task_type ? [args.task_type] : [],
      subject: `${args.action}.${ch.field}`,
      provenance: {
        source: "approval_edit" as const,
        task_id: args.task_id,
        approval_id: args.approval_id,
        before: ch.before,
        after: ch.after,
        at,
      },
    };
    if (ch.change === "removed") {
      // The founder deleted something the agent chose to include. That is a prohibition, and it is
      // the kind of lesson that is expensive to relearn: nobody notices a field that shouldn't be
      // there until a client does.
      return {
        ...base,
        kind: "never" as const,
        text: `Do not include \`${ch.field}\` when you ${args.action} — the founder removed it before this went out.`,
      };
    }
    if (ch.change === "added") {
      return {
        ...base,
        kind: "always" as const,
        text: `Always set \`${ch.field}\` when you ${args.action} — the founder had to add it before this went out.`,
      };
    }
    return {
      ...base,
      kind: "prefer" as const,
      text: `When you ${args.action}, write \`${ch.field}\` the founder's way (below), not the way you drafted it.`,
    };
  });
}

/**
 * Turn a founder's answer to a gap into a rule.
 *
 * The gap's stable id is the subject, which is what lets the recurrence loop close: answer it once
 * and every future occurrence of that gap is covered by a rule that can be retrieved, rather than
 * by a markdown file that may or may not be in the prompt. Kind is `fact` — an answer to "what is
 * the late fee?" is a fact about the business, not an instruction, and pretending otherwise would
 * put it ahead of an actual prohibition in the budget.
 */
export function distillFromAnswer(args: {
  project_id: string;
  wedge: string;
  client_id?: string;
  task_types?: string[];
  question_id: string;
  question: string;
  answer: string;
  gap_id?: string;
  at?: string;
}): NewRule {
  return {
    project_id: args.project_id,
    wedge: args.wedge,
    ...scopeMeta(args.client_id),
    task_types: args.task_types ?? [],
    subject: args.question_id,
    kind: "fact",
    // Question and answer together: months later "$45" alone is unreadable, and the agent reads
    // this as prose too.
    text: `${args.question.trim().replace(/\s+/g, " ")} — ${args.answer.trim()}`,
    provenance: {
      source: "gap_answer",
      gap_id: args.gap_id,
      question: args.question,
      after: args.answer,
      at: args.at ?? new Date().toISOString(),
    },
  };
}

/**
 * Turn something a founder told us at setup into a rule.
 *
 * Structurally identical to `distillFromAnswer` — same subject, same `fact` kind, same verbatim
 * answer — and differing in exactly one field, which is the entire point. The source is
 * `onboarding`, so `EVIDENCE` ranks it below everything learned by watching, `reconcile` refuses to
 * let it displace an observed rule, and `scoreRule` puts it behind one when the prompt budget is
 * tight.
 *
 * WHY SEED AT ALL, given all that hedging. Because the alternative is a first week in which the
 * agent knows nothing and every draft is wrong in ways the founder has already explained to three
 * employees. A stated rule is worse than an observed one and enormously better than silence — it
 * just has to be unable to outlive its own contradiction, which is what the machinery above buys.
 *
 * It is a SEPARATE function rather than a `source` parameter on `distillFromAnswer` because a
 * defaulted parameter is a mislabelling waiting to happen: the wrong call site gets the strong
 * label by omission, which is the failure this whole distinction exists to prevent.
 */
export function distillFromOnboarding(args: {
  project_id: string;
  wedge: string;
  client_id?: string;
  task_types?: string[];
  question_id: string;
  question: string;
  answer: string;
  at?: string;
}): NewRule {
  return {
    ...distillFromAnswer(args),
    provenance: {
      source: "onboarding",
      question: args.question,
      after: args.answer,
      at: args.at ?? new Date().toISOString(),
    },
  };
}

/**
 * Turn a rejection into a rule.
 *
 * Weaker evidence than an edit and treated as such: a rejection says "not this", never "that
 * instead", so it can only ever produce a prohibition about the action as proposed. It is recorded
 * because the alternative — throwing away the clearest possible "no" a founder can give — is worse,
 * but it is not allowed to masquerade as house style.
 */
export function distillFromRejection(args: {
  project_id: string;
  wedge: string;
  task_type: string;
  client_id?: string;
  action: string;
  proposed: Record<string, unknown>;
  reason?: string;
  task_id?: string;
  approval_id?: string;
  at?: string;
}): NewRule {
  return {
    project_id: args.project_id,
    wedge: args.wedge,
    ...scopeMeta(args.client_id),
    task_types: args.task_type ? [args.task_type] : [],
    subject: `${args.action}.rejected`,
    kind: "never",
    text: args.reason
      ? `A \`${args.action}\` like the one below was refused: ${args.reason.trim()}`
      : `A \`${args.action}\` like the one below was refused. Do not propose this shape again without checking.`,
    provenance: {
      source: "rejection",
      task_id: args.task_id,
      approval_id: args.approval_id,
      before: JSON.stringify(args.proposed ?? {}, null, 2),
      at: args.at ?? new Date().toISOString(),
    },
  };
}

/**
 * The scope a rule competes within.
 *
 * Contradiction is only meaningful inside one scope. A client-specific rule and a house rule about
 * the same subject are NOT in conflict — the first is an exception to the second, which is exactly
 * how real domain knowledge is shaped, and collapsing them would destroy the most valuable thing a
 * specialist knows. Task type is in the key for the same reason: how you word a chase and how you
 * word a monthly summary are different questions that happen to touch the same field.
 */
export function scopeKey(r: Pick<Rule, "project_id" | "wedge" | "client_id" | "task_types" | "subject">): string {
  return [r.project_id, r.wedge, r.client_id ?? "*", [...r.task_types].sort().join(",") || "*", r.subject].join("|");
}

export interface Reconciliation {
  /** What should be done with the incoming rule. */
  outcome: "created" | "corroborated" | "superseded" | "declined";
  /** The rule that should now be active (a new row for created/superseded; the existing one for corroborated). */
  rule: Rule;
  /** The rule that was displaced. Kept, never deleted — see below. */
  superseded?: Rule;
}

const nowIso = () => new Date().toISOString();

/** Materialise a candidate into a full Rule row. */
export function materialize(n: NewRule, at = nowIso()): Rule {
  return {
    id: randomUUID(),
    status: "active",
    corroborations: n.corroborations ?? 1,
    corrections_since: 0,
    uses: 0,
    needs_review: n.needs_review ?? false,
    ...n,
    created_at: at,
    updated_at: at,
  };
}

/**
 * Decide what an incoming correction means given what is already known.
 *
 * Three outcomes, and the distinction between the first two is the whole point:
 *
 *   • CORROBORATED — the founder made the same correction again. Not a new rule; the existing one
 *     just got stronger. Storing it twice would be the accumulation failure this module exists to
 *     avoid: two identical rules cost twice the budget and teach nothing extra.
 *
 *   • SUPERSEDED — the founder made a DIFFERENT correction on the same subject in the same scope.
 *     These two rules cannot both be true, and letting both sit in the knowledge base is worse than
 *     having neither: the agent picks one at random and the founder cannot tell which. Newer wins,
 *     because a correction made today is a statement about how the business works today.
 *
 *     The old row is kept with `status: "superseded"` and a pointer to its replacement. Deleting it
 *     would leave the founder unable to answer "why did it start doing that?" — and a system whose
 *     behaviour changes for reasons nobody can reconstruct does not get trusted with a business.
 *
 *   • CREATED — nothing about this subject was known.
 *
 * `needs_review` is raised when something weaker replaces a prohibition. "Newer wins" is right for
 * pricing and dangerous for "never contact this client at the weekend": a stylistic edit that
 * happens to touch the same field should not quietly repeal a hard rule. It still applies — the
 * founder's most recent instruction is not overridden by the system's caution — but it is flagged.
 */
export function reconcile(existing: Rule[], incoming: NewRule, at = nowIso()): Reconciliation {
  const key = scopeKey(incoming);
  const prior = existing
    .filter((r) => r.status === "active" && scopeKey(r) === key)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];

  if (!prior) return { outcome: "created", rule: materialize(incoming, at) };

  /**
   * "The same point" means the human produced the same EVIDENCE, not the same sentence.
   *
   * This used to be `sameText(after) || sameText(text)`, and the `||` made supersession unreachable
   * for the most common correction there is. A rewrite's text is generated from the field name —
   * "When you send_email, write `body` the founder's way" — so it is byte-identical no matter what
   * the founder actually wrote. Two completely different rewrites of the same field therefore
   * matched on `text` and were filed as corroboration: `corroborations` inflated (which promotes the
   * rule in the budget on the strength of evidence that does not exist), no supersession row was
   * written, and the trail showing that the founder changed their mind was lost. The system was
   * measuring its own template.
   *
   * So: when either side carries the human's own bytes, those decide it. Only when neither does — a
   * deletion, a rejection, where "no field" IS the whole lesson — does the text stand in, and there
   * it is a genuine statement about the correction rather than a template.
   */
  const hasEvidence = !!(prior.provenance.after || incoming.provenance.after);
  const samePoint =
    prior.kind === incoming.kind &&
    (hasEvidence
      ? sameText(prior.provenance.after, incoming.provenance.after)
      : sameText(prior.text, incoming.text));
  if (samePoint) {
    return {
      outcome: "corroborated",
      rule: {
        ...prior,
        corroborations: prior.corroborations + 1,
        // Adopt the candidate's label. `scopeKey` already required an identical `client_id`, and
        // sensitivity is derived from exactly that, so this cannot widen the audience — it only
        // heals a legacy row that predates the field, which would otherwise stay dark forever
        // however many times the founder repeated the same correction.
        sensitivity: incoming.sensitivity,
        // The evidence is refreshed to the most recent instance so the rendered example is the
        // freshest one the founder actually wrote, not the oldest — UNLESS that would downgrade the
        // witness. A founder who says at signup exactly what a real job already taught us has
        // corroborated it, not un-observed it; overwriting a `gap_answer` provenance with an
        // `onboarding` one because it arrived later would silently demote an earned rule to a
        // stated one and hand it `scoreRule`'s penalty for the rest of its life.
        provenance:
          EVIDENCE[incoming.provenance.source] >= EVIDENCE[prior.provenance.source]
            ? { ...incoming.provenance }
            : prior.provenance,
        updated_at: at,
      },
    };
  }

  /**
   * ═══ STATED NEVER BEATS OBSERVED ═══
   *
   * The founder said one thing at signup and the business then did another. These two rows disagree
   * about the same subject in the same scope, so exactly one of them can be active, and "newer
   * wins" — right everywhere else in this function — is wrong in both directions here.
   *
   * INCOMING IS STATED, PRIOR IS OBSERVED → the incoming rule is DECLINED and never written.
   * This is the ordering that actually happens: someone skips a question during onboarding, works
   * for three weeks, gets corrected on a real job, and then goes back and finishes the setup flow.
   * Letting the setup answer supersede the correction would let a signup form quietly repeal
   * something the agent learned the expensive way, and the founder would have no idea it happened —
   * they answered a question, they did not think they were overruling anything.
   *
   * Not written as `created`, and this is the part worth being careful about: two active rules on
   * one subject is the state this module exists to make impossible. The agent would pick one at
   * random and nobody could say which. So the candidate is dropped entirely, `rule` is the prior
   * that stands, and the caller writes nothing. Nothing is lost that matters — the founder's actual
   * words are stored verbatim as a knowledge FILE by the caller regardless, so the answer is still
   * readable, editable, and there to be promoted by a real correction later.
   *
   * PRIOR IS STATED, INCOMING IS OBSERVED → supersede, and `needs_review` is forced OFF even when
   * the incoming rule is weaker in kind. `needs_review` means "a human should look at this, a
   * prohibition may have been quietly repealed". Reality contradicting a signup-form claim is not
   * suspicious, it is the system working exactly as designed, and flagging it would fill the review
   * queue with the single most expected event in the product.
   */
  const priorObserved = !isStated(prior);
  const incomingStated = EVIDENCE[incoming.provenance.source] === 0;
  if (incomingStated && priorObserved) return { outcome: "declined", rule: prior };

  const weaker = STRENGTH[incoming.kind] < STRENGTH[prior.kind];
  const replacement = materialize({ ...incoming, needs_review: weaker && priorObserved }, at);
  return {
    outcome: "superseded",
    rule: replacement,
    superseded: { ...prior, status: "superseded", superseded_by: replacement.id, updated_at: at },
  };
}

/**
 * A gap that keeps coming back, or a rule that keeps being corrected. Both mean the same thing:
 * something the business knows has not made it into the agent's head, and asking the founder one
 * good question would retire it permanently.
 */
export interface RecurrenceSignal {
  kind: "unanswered_gap" | "ineffective_rule";
  subject: string;
  /** How many times this has cost someone something — gap hits, or corrections since the rule. */
  occurrences: number;
  /** For an unanswered gap, the question to put in front of the founder. */
  question?: string;
  /** Everything already said on this subject, so answering once can actually retire it. */
  previous_answers: Array<{ rule_id: string; text: string; at: string; status: Rule["status"] }>;
  task_ids: string[];
  rule_id?: string;
}

/** The default recurrence threshold: the same thing going wrong three times is a pattern, not luck. */
export const RECURRENCE_THRESHOLD = 3;

/**
 * Find the things that should be a rule and aren't — or are, and aren't working.
 *
 * Two distinct failures, deliberately reported together because they land on the founder's desk as
 * the same task ("answer this once"):
 *
 *   1. A gap the agent has hit `threshold` times with no rule covering it. Every one of those hits
 *      was a real job completed on a stated assumption instead of on fact.
 *
 *   2. A rule that EXISTS and is still being corrected. This is the failure mode nobody instruments
 *      and everybody has: knowledge accumulates, the metric "rules learned" goes up, and the agent
 *      is exactly as wrong as it was. A rule with corrections against it is either badly worded or
 *      never retrieved, and both need a human, not another row.
 *
 * The founder's previous answers ride along — including superseded ones — because the question
 * "why does it still not know this?" is usually answered by reading what was said last time.
 */
export function detectRecurrence(
  gaps: Array<{ id: string; question: string; hits: number; task_ids: string[]; status: string }>,
  rules: Rule[],
  threshold = RECURRENCE_THRESHOLD,
): RecurrenceSignal[] {
  const bySubject = new Map<string, Rule[]>();
  for (const r of rules) bySubject.set(r.subject, [...(bySubject.get(r.subject) ?? []), r]);
  const answers = (subject: string) =>
    (bySubject.get(subject) ?? [])
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .map((r) => ({ rule_id: r.id, text: r.text, at: r.updated_at, status: r.status }));

  const signals: RecurrenceSignal[] = [];

  for (const g of gaps) {
    if (g.status === "dismissed" || g.hits < threshold) continue;
    const covered = (bySubject.get(g.id) ?? []).some((r) => r.status === "active");
    // A gap that recurs DESPITE an active rule is reported below as an ineffective rule, not here —
    // the founder's next action is different in each case (answer vs. rewrite).
    if (covered) continue;
    signals.push({
      kind: "unanswered_gap",
      subject: g.id,
      occurrences: g.hits,
      question: g.question,
      previous_answers: answers(g.id),
      task_ids: g.task_ids,
    });
  }

  for (const r of rules) {
    if (r.status !== "active" || r.corrections_since < threshold) continue;
    signals.push({
      kind: "ineffective_rule",
      subject: r.subject,
      occurrences: r.corrections_since,
      question: `The agent has been corrected ${r.corrections_since} times on "${r.subject}" since this rule was written. Is it right?`,
      previous_answers: answers(r.subject),
      task_ids: r.provenance.task_id ? [r.provenance.task_id] : [],
      rule_id: r.id,
    });
  }

  return signals.sort((a, b) => b.occurrences - a.occurrences);
}

// ─────────────────────────────────────────────────────────────────────────────
// RETRIEVAL — deciding what actually reaches the prompt
//
// The failure this replaces: the runtime mounted EVERY knowledge file for the wedge on EVERY run.
// That is O(business history) per job, it gets slower and more expensive precisely as a customer
// becomes more valuable, and — worse than the cost — it has no notion of relevance, so the one note
// that governs this job arrives buried in ninety that don't. "More context" is not expertise; a
// specialist's skill is largely knowing which three things matter here.
//
// So retrieval, not accumulation. Three properties it must have, and each is load-bearing:
//
//   • IT FAILS CLOSED ON TENANCY. A rule with no project belongs to nobody. `listKnowledge` gained a
//     required `projectId` after the old version leaked every tenant's knowledge into every sandbox;
//     this is the same boundary at the same moment (the point where bytes go in front of a model),
//     so it is enforced the same way — no project id, nothing retrieved, never "everything".
//
//   • IT HAS A HARD BUDGET. runtime.ts says the prompt is a cost decision and it is right. A budget
//     that is a suggestion is not a budget: the cap here is applied to the rendered characters, not
//     to a rule count that could each be a page long.
//
//   • WHAT IT DROPS IS PRINCIPLED. If only some rules fit, the stylistic preference goes before the
//     prohibition. A budget that silently drops "never email this client after 6pm" in favour of a
//     tone note has made the system worse than having no rules at all.
// ─────────────────────────────────────────────────────────────────────────────

/** Everything retrieval needs to know about the run it is grounding. */
export interface RetrievalContext {
  /** Tenant. Empty means nothing is retrieved — see the header. */
  project_id: string;
  wedge: string;
  task_type: string;
  client_id?: string;
  /** Reference instant for recency. Injectable so a test is an assertion, not a race with the clock. */
  now?: string;
}

export interface RuleBudget {
  /** Hard cap on rendered characters. The real currency: rules differ in size by 20x. */
  max_chars: number;
  /** A second cap on count, because thirty one-liners is also a worse prompt than eight good ones. */
  max_rules: number;
  /** Per-side cap on the verbatim before/after. The evidence teaches, and it is also the bulk. */
  evidence_chars: number;
}

/**
 * The default budget, in the same units the rest of the prompt is reasoned about in.
 *
 * ~6,000 characters is roughly 1,500 tokens: a real cost on every run, and small enough that it
 * cannot crowd out the task. It is deliberately a number and not "whatever there is": the point of
 * the whole module is that knowledge stops being free the moment it is unbounded.
 */
export const DEFAULT_RULE_BUDGET: RuleBudget = { max_chars: 6000, max_rules: 20, evidence_chars: 400 };

const DAY_MS = 86_400_000;

/**
 * Is this rule even eligible for this run?
 *
 * Every clause is an exclusion, and each one is a correctness boundary rather than a ranking
 * preference — a rule that fails any of these must not appear at ANY budget:
 *
 *   • wrong project — cross-tenant disclosure, the thing `listKnowledge` was fixed for.
 *   • wrong audience — `ruleMayApply`, the same gate `mayMount` applies to knowledge files, and for
 *     a stronger reason: a knowledge file is OFFERED to the agent, a rule is INLINED into the
 *     prompt as a standing instruction it has no way to decline. "Northwind wants Friday
 *     summaries" applied to everyone is how a system that "learns" actively makes a business worse,
 *     and the rule text quotes Northwind by name while doing it.
 *   • wrong task type — how you word a chase and how you word a monthly summary are different
 *     questions that happen to touch the same field.
 *   • superseded — the founder replaced it. Kept for the audit trail, never prompted again.
 */
export function ruleApplies(r: Rule, ctx: RetrievalContext): boolean {
  if (!ctx.project_id || r.project_id !== ctx.project_id) return false;
  if (r.status !== "active") return false;
  if (r.wedge !== ctx.wedge) return false;
  if (!ruleMayApply(r, ctx.client_id)) return false;
  if (r.task_types.length > 0 && !r.task_types.includes(ctx.task_type)) return false;
  return true;
}

/**
 * Read a rule's sensitivity, defaulting CLOSED.
 *
 * There is no `created_at`-shaped exception here, unlike `sensitivityOf`. A wedge ships knowledge
 * FILES on disk; it does not ship rules. Every row in this table was distilled from one tenant's own
 * runtime — an approve-with-edit, a rejection, a gap answer — so there is no such thing as a rule
 * that is `house` by construction, and inventing one would be a hole in the exact place the leak
 * was.
 */
export function ruleSensitivityOf(r: Pick<Rule, "sensitivity">): KnowledgeSensitivity {
  return r.sensitivity === "house" || r.sensitivity === "client" ? r.sensitivity : "client";
}

/**
 * May this rule be inlined into a run for `clientId`?
 *
 * `mayMount` for rules, with the same inversion and the same reasoning. Retrieval used to read an
 * absent `client_id` as "applies to everyone": every rule distilled from work whose client
 * attribution nobody had recorded — and until recently that included every gap answer, see the
 * comment at the `recordGapAnswer` call in server.ts — was inlined verbatim into every OTHER
 * client's run. A distilled rule is the worse half of that family of leaks, because it carries the
 * founder's own words about one client into another client's prompt as an instruction.
 *
 *   · `house`  reaches every run, unless it also names a client, in which case it narrows to that
 *              client. A label can only ever restrict.
 *   · `client` reaches ONLY a run whose client is named and matches. A client-sensitive rule with no
 *              owner recorded reaches NOBODY: we do not know whose lesson it was, so it is not
 *              anyone's to be taught.
 *
 * The migration is the one already decided for knowledge: unlabelled legacy goes dark rather than
 * public. A house rule that goes dark costs one worse draft and is recovered by relabelling it. A
 * client rule that goes public is a disclosure of one customer's business to another, and nothing
 * recovers that.
 */
export function ruleMayApply(r: Pick<Rule, "sensitivity" | "client_id">, clientId?: string): boolean {
  const named = r.client_id && r.client_id.length > 0 ? r.client_id : undefined;
  if (ruleSensitivityOf(r) === "house") return named === undefined || named === clientId;
  return named !== undefined && !!clientId && named === clientId;
}

/**
 * How much this rule deserves the space it would take.
 *
 * The weights encode judgements, not tuning:
 *
 *   • A client-specific rule outranks a house rule (+40). The exception IS the expertise; a
 *     generalist knows the house rule, the specialist knows who it doesn't apply to.
 *   • A rule written for THIS task type outranks a wedge-wide one (+25 vs +8) — it was learned on
 *     this exact job.
 *   • Strength (x10) puts prohibitions above preferences before anything else is considered.
 *   • Corroboration (x3, capped) promotes a habit over a one-off: the same correction made twice is
 *     a standing instruction, once is an incident.
 *   • Recency decays smoothly rather than cutting off — a two-year-old prohibition is still a
 *     prohibition, it just yields to a fresher rule when they compete for the last slot.
 *   • `uses` is a deliberately WEAK tiebreaker (x0.25, capped). It is a popularity signal fed by
 *     this very function, so weighting it heavily would make retrieval self-confirming: whatever was
 *     picked first would keep being picked, and a good rule that started unlucky could never recover.
 *
 * `corrections_since` deliberately does NOT lower the score. A rule the agent is still being
 * corrected against is failing, but starving it of retrieval would only make the failure permanent
 * and unmeasurable — you could no longer tell "wrong rule" from "never read". It is escalated to a
 * human by `detectRecurrence` instead, which is the only thing that can actually fix it.
 */
export function scoreRule(r: Rule, ctx: RetrievalContext): number {
  const now = Date.parse(ctx.now ?? new Date().toISOString());
  const ageDays = Math.max(0, (now - Date.parse(r.updated_at)) / DAY_MS);
  return (
    (r.client_id ? 40 : 0) +
    (r.task_types.length ? 25 : 8) +
    STRENGTH[r.kind] * 10 +
    /**
     * A stated rule yields the last slot to an observed one (−18).
     *
     * `reconcile` already stops a stated rule from displacing an observed one on the SAME subject.
     * This covers the other half: different subjects, competing for a budget that only fits some of
     * them. Sized to be decisive against the two terms a seeded rule can otherwise win on — task
     * scoping (25 vs 8) and recency, where a rule written this morning at signup would otherwise
     * beat a correction earned two months ago — without being absolute. A stated rule about THIS
     * client (+40) still gets in ahead of a generic observed one, which is right: it is the only
     * thing in the prompt that knows the client exists.
     */
    (isStated(r) ? -18 : 0) +
    Math.min(r.corroborations, 5) * 3 +
    20 / (1 + ageDays / 30) +
    Math.min(r.uses, 20) * 0.25
  );
}

const clip = (s: string, n: number): string =>
  s.length <= n ? s : `${s.slice(0, n)}… [${s.length - n} more characters]`;

/**
 * One rule as the agent reads it.
 *
 * The imperative line alone is nearly useless for a style correction — "write the subject the
 * founder's way" says nothing without the founder's way next to it. So the verbatim before/after
 * rides along, clipped rather than summarised: a paraphrase is this module inventing an
 * interpretation of the founder's edit, which is the one thing it must not do (see the header).
 *
 * The id is printed because a founder asking "why did it say that?" needs to be able to find the
 * rule, and because it is what makes `uses` legible against a real prompt.
 */
export function renderRule(r: Rule, evidenceChars = DEFAULT_RULE_BUDGET.evidence_chars): string {
  const lines = [`- **${r.kind.toUpperCase()}** ${r.text}  \`[${r.id}]\``];
  // The agent is told when a rule is only what someone said, so it can weigh it as such. A model
  // reading a flat list has no way to tell a signup-form answer from something a founder rewrote by
  // hand on a real job, and it will treat the two identically unless the difference is on the page.
  if (isStated(r)) lines.push("  - source: told to us during setup, before any job had run");
  if (r.provenance.before) lines.push(`  - it drafted: ${JSON.stringify(clip(r.provenance.before, evidenceChars))}`);
  if (r.provenance.after) lines.push(`  - you sent: ${JSON.stringify(clip(r.provenance.after, evidenceChars))}`);
  return lines.join("\n");
}

export interface RuleRetrieval {
  /** In render order — what will actually be in the prompt. */
  selected: Rule[];
  markdown: string;
  /** How many eligible rules did not fit. Counted, because a silent truncation is a lie. */
  dropped: number;
  /** How many were eligible at all, before the budget. */
  considered: number;
  chars: number;
}

/**
 * Choose the rules for one run.
 *
 * Two orderings, on purpose, and the difference between them is the whole safety property:
 *
 *   • ADMISSION is strength-major. A `never` is admitted before any `prefer`, whatever their scores,
 *     so the budget can never drop a prohibition in favour of a tone note.
 *   • RENDERING is score-major, so the most relevant thing the agent reads is at the top — models
 *     weight position and the founder's exception for this client should not be item nineteen.
 *
 * An oversized rule is SKIPPED rather than ending the loop: one pathological 8KB evidence blob must
 * not silently swallow the entire knowledge base for that run.
 */
export function retrieveRules(
  rules: Rule[],
  ctx: RetrievalContext,
  budget: RuleBudget = DEFAULT_RULE_BUDGET,
): RuleRetrieval {
  const eligible = rules.filter((r) => ruleApplies(r, ctx)).map((r) => ({ r, score: scoreRule(r, ctx) }));

  const admission = [...eligible].sort(
    (a, b) => STRENGTH[b.r.kind] - STRENGTH[a.r.kind] || b.score - a.score || a.r.id.localeCompare(b.r.id),
  );

  const taken: Array<{ r: Rule; score: number; text: string }> = [];
  let chars = 0;
  for (const cand of admission) {
    if (taken.length >= budget.max_rules) break;
    const text = renderRule(cand.r, budget.evidence_chars);
    if (chars + text.length + 1 > budget.max_chars) continue;
    chars += text.length + 1;
    taken.push({ ...cand, text });
  }

  const ordered = taken.sort((a, b) => b.score - a.score || a.r.id.localeCompare(b.r.id));
  return {
    selected: ordered.map((t) => t.r),
    markdown: ordered.map((t) => t.text).join("\n"),
    dropped: eligible.length - ordered.length,
    considered: eligible.length,
    chars,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The same argument, applied to the knowledge FILES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * WHO A FACT IS ALLOWED TO REACH.
 *
 *   · `house`  — about the BUSINESS. "Our late fee is $45", the chase wording, the refund policy.
 *                Safe in any run, because it is the founder's own operating knowledge.
 *   · `client` — about or belonging to a NAMED client. A bank statement, a negotiated rate, a
 *                dispute. Reaches that client's runs and nothing else.
 *
 * `client` is the DEFAULT, and that inversion is the whole point. Retrieval used to read an absent
 * `metadata.client_id` as "applies to everyone", so a fact whose attribution nobody had recorded
 * was mounted into every other client's run — and intake answers, which are exactly the facts most
 * likely to be about one client, scored +15 and were mounted preferentially. Now an unattributed
 * fact is retrievable by NOBODY until something labels it.
 *
 * The two failure directions are not symmetric, which is why the default sits where it does: too
 * little knowledge is a worse answer, and a worse answer is recoverable. Too much is a disclosure
 * of one customer's business to another, and that is not.
 */
export type KnowledgeSensitivity = "house" | "client";

/** The metadata key. One constant so a writer and a reader cannot disagree about the spelling. */
export const SENSITIVITY_KEY = "sensitivity";

/**
 * Read a file's sensitivity, defaulting CLOSED.
 *
 * The one exception is the wedge's OWN on-disk knowledge, identified by having no `created_at`
 * because it is not runtime data — it is part of the product, shipped in the wedge, authored by
 * someone who has never seen this tenant let alone one of its clients. It cannot be about a client
 * and there is nowhere to put a label on it, so it is `house` by construction.
 *
 * Everything else — every row a customer's business actually produced — defaults to `client`.
 */
export function sensitivityOf(f: Pick<GroundingFile, "metadata" | "created_at">): KnowledgeSensitivity {
  const declared = (f.metadata ?? {})[SENSITIVITY_KEY];
  if (declared === "house" || declared === "client") return declared;
  return f.created_at ? "client" : "house";
}

/**
 * May this file be mounted into a run for `clientId`?
 *
 * The single gate. Split out of `retrieveFiles` so it can be asserted directly, and so any future
 * reader of knowledge (a brain, an export, a portal view) has one function to call rather than a
 * re-derivation to get subtly wrong.
 *
 *   · `house` reaches every run, unless it also names a client — a house fact tagged to a client
 *     narrows to that client, because a label can only ever restrict.
 *   · `client` reaches ONLY a run whose client is named and matches. A client-sensitive row with no
 *     owner recorded reaches nothing at all: we do not know whose it is, so we cannot show it to
 *     anyone.
 */
export function mayMount(f: Pick<GroundingFile, "metadata" | "created_at">, clientId?: string): boolean {
  const owner = (f.metadata ?? {}).client_id;
  const named = typeof owner === "string" && owner.length > 0 ? owner : undefined;
  if (sensitivityOf(f) === "house") return named === undefined || named === clientId;
  return named !== undefined && !!clientId && named === clientId;
}

/**
 * The sensitivity half of a knowledge row's metadata, derived from the work it came out of.
 *
 * The rule, stated once so four call sites cannot each decide it differently: knowledge produced by
 * work FOR A NAMED CLIENT is about that client. A correction to a chase message sent to Northwind
 * quotes Northwind's balance and Northwind's excuses; it is not house style, however much it also
 * teaches house style. Work with no client attached could only ever have been about the business,
 * so it is `house`.
 *
 * Spread into `metadata` at the write site. Nothing may write `client_id` without also writing
 * `sensitivity` — that combination is precisely the row that leaked.
 */
export function scopeMeta(clientId?: string): { sensitivity: KnowledgeSensitivity; client_id?: string } {
  return clientId ? { sensitivity: "client", client_id: clientId } : { sensitivity: "house" };
}

/** A knowledge file as the runtime holds it: the wedge's own on-disk notes plus the live items. */
export interface GroundingFile {
  name: string;
  content: string;
  kind?: string;
  source?: string;
  /** Absent for the wedge's on-disk knowledge, which has no runtime history. See `retrieveFiles`. */
  created_at?: string;
  metadata?: Record<string, unknown>;
}

export interface FileBudget {
  max_files: number;
  max_bytes: number;
}

/**
 * The file budget.
 *
 * Not a token budget — the files are mounted, not inlined, so what they cost is one sandbox write
 * each plus the index line in AGENTS.md. That is still a real, growing per-run cost (a customer two
 * years in had hundreds), and the relevance cost is the larger one: an index of ninety files is an
 * index the agent cannot use.
 */
export const DEFAULT_FILE_BUDGET: FileBudget = { max_files: 24, max_bytes: 256_000 };

/**
 * Rank and cap the mounted knowledge files.
 *
 * The wedge's OWN on-disk knowledge is pinned: it has no `created_at` because it is not runtime
 * data, it is part of the product — curated, small, and the baseline the wedge was authored against.
 * Dropping it for a fresher correction would mean a wedge that behaves differently depending on how
 * much a customer has used it.
 *
 * Live items are ranked by the same logic as rules — this client, this task type, corrections and
 * answered gaps first, then recency — but only AFTER `mayMount` has decided what is allowed to be
 * ranked at all. Exclusion is by sensitivity, not by tag mismatch: it is not enough to drop a file
 * tagged for a different client, because the dangerous file is the one tagged for nobody.
 */
export function retrieveFiles(
  files: GroundingFile[],
  ctx: RetrievalContext,
  budget: FileBudget = DEFAULT_FILE_BUDGET,
): { mounted: GroundingFile[]; omitted: number } {
  const now = Date.parse(ctx.now ?? new Date().toISOString());
  const score = (f: GroundingFile): number => {
    const meta = f.metadata ?? {};
    const ageDays = f.created_at ? Math.max(0, (now - Date.parse(f.created_at)) / DAY_MS) : 0;
    return (
      (meta.client_id === ctx.client_id && ctx.client_id ? 40 : 0) +
      (meta.task_type === ctx.task_type ? 25 : 0) +
      (f.kind === "correction" ? 12 : 0) +
      // An answered gap is a question that actually blocked a real job. Evidence outranks opinion.
      (meta.intake === true ? 15 : 0) +
      (f.source === "feedback" ? 8 : 0) +
      20 / (1 + ageDays / 30)
    );
  };

  // Eligibility is `mayMount` and nothing else, and it runs BEFORE scoring. The +15 on an intake
  // answer below is a ranking preference; it was never a permission, but with an absent client_id
  // reading as "everyone" it behaved like one — a founder's answer about one client's dispute was
  // mounted into every other client's run, ranked near the top.
  const eligible = files.filter((f) => mayMount(f, ctx.client_id));
  const pinned = eligible.filter((f) => !f.created_at);
  const ranked = eligible
    .filter((f) => f.created_at)
    .sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name));

  const mounted: GroundingFile[] = [];
  let bytes = 0;
  for (const f of [...pinned, ...ranked]) {
    if (mounted.length >= budget.max_files) break;
    if (bytes + f.content.length > budget.max_bytes) continue;
    bytes += f.content.length;
    mounted.push(f);
  }
  return { mounted, omitted: eligible.length - mounted.length };
}

/** Everything one run is grounded in, after tenancy, relevance and the budgets have had their say. */
export interface Grounding {
  rules: RuleRetrieval;
  files: GroundingFile[];
  omitted_files: number;
}

/**
 * Ground one run, and COUNT WHAT WAS USED.
 *
 * `noteUses` fires here for exactly the rules that reached the prompt, and once more in
 * `proposeMoves` the first time a stated prohibition holds a ranked move. That second site exists
 * so the Learning page does not say "never used on a job" about a rule that just stopped a chase —
 * ranking never used to read rules at all. It increments only from `uses: 0`, because a proposal is
 * recomputed on every page load and counting each pass would turn the counter into a refresh tally.
 *
 * The counter is the difference between two failures that look identical from the outside and need
 * opposite fixes: a rule with corrections against it and `uses: 0` was never retrieved (a retrieval
 * bug), the same rule with `uses: 40` is simply wrong (a knowledge bug, and only a human can fix
 * it). Counting every rule in the table — or counting at write time — would erase that distinction,
 * which is why the increment lives next to the selection rather than anywhere more convenient.
 *
 * A failure to record use must never fail the run: the agent is already grounded by the time we get
 * here, and losing a counter is strictly better than losing the job.
 */
export async function groundRun(
  store: KnowledgeStore,
  args: {
    ctx: RetrievalContext;
    files: GroundingFile[];
    ruleBudget?: RuleBudget;
    fileBudget?: FileBudget;
  },
): Promise<Grounding> {
  const { ctx } = args;
  // Fails closed inside the store too, but asked for explicitly here: an unscoped run grounds on
  // nothing rather than on someone else's business.
  const active = ctx.project_id
    ? await store.listRules(ctx.project_id, { wedge: ctx.wedge, status: "active" })
    : [];
  const rules = retrieveRules(active, ctx, args.ruleBudget);
  if (rules.selected.length) {
    try {
      await store.noteUses(ctx.project_id, rules.selected.map((r) => r.id));
    } catch (e) {
      console.error("[mycel] could not record rule uses:", e);
    }
  }
  const { mounted, omitted } = retrieveFiles(args.files, ctx, args.fileBudget);
  return { rules, files: mounted, omitted_files: omitted };
}

// ─────────────────────────────────────────────────────────────────────────────
// LEARNING — turning one human decision into durable, reconciled knowledge
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Persist a batch of candidates, reconciling each against what is already known.
 *
 * Order matters and is not obvious: `noteCorrectionOn` fires BEFORE the new rule is written. The
 * correction that produced this candidate is evidence against whatever was already active on that
 * subject — the agent was corrected on ground a rule already claimed to cover. Writing first would
 * attribute the correction to the rule the correction just created, which is both nonsense and
 * self-flattering: every rule would look like it had immediately started failing.
 *
 * A candidate with no project is dropped. A rule that belongs to nobody is reachable by nobody, and
 * writing it would put an unowned row in a table whose entire tenancy story is that there aren't any.
 */
export async function applyDistilled(
  store: KnowledgeStore,
  candidates: NewRule[],
  at = nowIso(),
): Promise<Reconciliation[]> {
  const out: Reconciliation[] = [];
  for (const cand of candidates) {
    if (!cand.project_id) continue;
    /**
     * A STATED candidate is not a correction, so it must not be counted as one.
     *
     * `corrections_since` measures "the agent was corrected on ground a rule already claimed to
     * cover" — the honest per-rule failure signal, and the thing `detectRecurrence` escalates to a
     * human at three. Someone finishing the setup flow has corrected nothing; nothing was proposed
     * and nothing went wrong. Counting it would let a founder answering questions at signup
     * manufacture "this rule is not working" reports about rules that are working fine, and the
     * review queue would fill with the one event in this product that is guaranteed to happen.
     */
    if (EVIDENCE[cand.provenance.source] > 0) {
      await store.noteCorrectionOn(cand.project_id, cand.wedge, cand.subject);
    }
    // Read AFTER the increment, not before. `reconcile` writes the displaced rule back wholesale, so
    // a copy taken beforehand would carry a stale `corrections_since` and the write would silently
    // undo the increment that had just been made — the failing rule would look like it had never
    // failed, which is precisely the measurement this counter exists to make impossible to lose.
    const existing = await store.listRules(cand.project_id, { wedge: cand.wedge, subject: cand.subject });
    const rec = reconcile(existing, cand, at);
    // A declined candidate is a stated claim that lost to an observed one. `rec.rule` is the PRIOR,
    // untouched, so writing it back would be a no-op at best and would bump `updated_at` — which
    // feeds `scoreRule`'s recency term — at worst, letting a rejected candidate promote the rule it
    // failed to replace. Report it and write nothing.
    if (rec.outcome === "declined") {
      out.push(rec);
      continue;
    }
    // The displaced rule is written first. If the process dies between the two writes, the worse
    // outcome by far is two active rules contradicting each other with nothing to say which won.
    if (rec.superseded) await store.putRule(rec.superseded);
    await store.putRule(rec.rule);
    out.push(rec);
  }
  return out;
}

/** What an approval taught, if anything. */
export interface ApprovalLearning {
  rules: Rule[];
  outcomes: Reconciliation["outcome"][];
}

/**
 * The capture point: one settled approval, turned into knowledge.
 *
 * This is the highest-signal event in the system and it was being thrown away. A human looked at
 * exactly what the agent was about to do, on a real job, with real consequences, and either let it
 * through, rewrote it, or refused it. Each of those three is a different kind of evidence and is
 * treated as one:
 *
 *   • EDITED   — the delta is house style, stated precisely, in the founder's own words. Distilled
 *     per changed field so it can be retrieved, contradicted and superseded later.
 *   • REJECTED — the clearest possible "no", but it says nothing about what to do instead, so it can
 *     only ever produce a prohibition about the shape that was proposed.
 *   • APPROVED CLEAN — the agent got it right. No rule (a knowledge base full of "it was fine" is
 *     noise), but an observation, because a quality metric with only failures in it is a complaint
 *     log, not a measurement.
 *
 * `auto_approved` is deliberately NOT clean evidence. No human looked at it; a policy did. Counting
 * it as a success would let a wedge that auto-approves everything report a rising quality score
 * while its actual output got worse — the exact self-congratulating metric this module refuses to
 * build. Expired is not evidence of anything either.
 *
 * Never throws. The action has already happened and the human has already decided; failing their
 * approval because we could not file the lesson would be trading the job for the note.
 */
export async function recordApprovalOutcome(
  store: KnowledgeStore,
  args: {
    project_id?: string;
    wedge: string;
    task_type: string;
    client_id?: string;
    action: string;
    decision: string;
    proposed: Record<string, unknown>;
    edited?: Record<string, unknown>;
    reason?: string;
    task_id?: string;
    approval_id?: string;
    at?: string;
  },
): Promise<ApprovalLearning> {
  const empty: ApprovalLearning = { rules: [], outcomes: [] };
  // Fail closed: an approval whose task has no project cannot be attributed to a tenant, and an
  // unattributed rule is either useless or a leak. Say nothing rather than guess.
  if (!args.project_id) return empty;
  const at = args.at ?? new Date().toISOString();
  const edited = args.edited && Object.keys(args.edited).length ? args.edited : undefined;

  const observe = async (kind: Observation["kind"], subject?: string) => {
    await store.recordObservation({
      project_id: args.project_id!,
      wedge: args.wedge,
      task_type: args.task_type,
      client_id: args.client_id,
      kind,
      subject,
      task_id: args.task_id,
      at,
    });
  };

  try {
    if (args.decision === "approved" && edited) {
      const candidates = distillFromApprovalEdit({
        project_id: args.project_id,
        wedge: args.wedge,
        task_type: args.task_type,
        client_id: args.client_id,
        action: args.action,
        proposed: args.proposed ?? {},
        edited,
        task_id: args.task_id,
        approval_id: args.approval_id,
        at,
      });
      // No field actually changed (a UI that echoes the payload back verbatim does this) — that is
      // a clean approval wearing an edit's clothes, and recording it as a correction would poison
      // both the metric and `corrections_since`.
      if (!candidates.length) {
        await observe("approval_clean");
        return empty;
      }
      const recs = await applyDistilled(store, candidates, at);
      for (const r of recs) await observe("approval_edited", r.rule.subject);
      return { rules: recs.map((r) => r.rule), outcomes: recs.map((r) => r.outcome) };
    }

    if (args.decision === "approved") {
      await observe("approval_clean");
      return empty;
    }

    if (args.decision === "rejected") {
      const cand = distillFromRejection({
        project_id: args.project_id,
        wedge: args.wedge,
        task_type: args.task_type,
        client_id: args.client_id,
        action: args.action,
        proposed: args.proposed ?? {},
        reason: args.reason,
        task_id: args.task_id,
        approval_id: args.approval_id,
        at,
      });
      const recs = await applyDistilled(store, [cand], at);
      await observe("approval_rejected", cand.subject);
      return { rules: recs.map((r) => r.rule), outcomes: recs.map((r) => r.outcome) };
    }

    return empty;
  } catch (e) {
    console.error("[mycel] could not distil an approval outcome:", e);
    return empty;
  }
}

/**
 * A founder's answer to a gap, turned into a rule.
 *
 * The half of the loop that lets `detectRecurrence` ever close: the rule's subject IS the gap's
 * stable id, so the next time that gap is hit the recurrence check can see it is covered and stop
 * putting the same question in front of the founder. Without this, answering a question filed a
 * markdown file and the gap counter kept climbing forever.
 *
 * `stated` routes the same answer through `distillFromOnboarding` instead — see `RuleSource`. It is
 * a required-by-convention flag at every onboarding call site rather than a default, because the
 * dangerous direction is silent: an unmarked onboarding answer becomes indistinguishable from one
 * earned on a real job, and nothing downstream can ever tell them apart again.
 */
export async function recordGapAnswer(
  store: KnowledgeStore,
  args: {
    project_id?: string;
    wedge: string;
    question_id: string;
    question: string;
    answer: string;
    client_id?: string;
    task_types?: string[];
    /** True when this came from the setup flow rather than from a gap hit on a real job. */
    stated?: boolean;
    at?: string;
  },
): Promise<{ rule?: Rule; outcome?: Reconciliation["outcome"] }> {
  if (!args.project_id || !args.answer.trim()) return {};
  try {
    const distil = args.stated ? distillFromOnboarding : distillFromAnswer;
    const cand = distil({
      project_id: args.project_id,
      wedge: args.wedge,
      client_id: args.client_id,
      task_types: args.task_types,
      question_id: args.question_id,
      question: args.question,
      answer: args.answer,
      at: args.at,
    });
    const [rec] = await applyDistilled(store, [cand], args.at);
    // The outcome travels with the rule because the onboarding screen has to be honest about what
    // it did. "Declined — a real job already taught us otherwise" is a true and useful thing to
    // show a founder, and it is unrecoverable from the returned row alone: on a decline that row is
    // the PRIOR, which looks exactly like a successful write.
    return { rule: rec?.rule, outcome: rec?.outcome };
  } catch (e) {
    // Same rule as everywhere else in this module: the founder's answer is already saved as
    // knowledge by the caller. Losing the distilled form must not lose the answer.
    console.error("[mycel] could not distil a gap answer:", e);
    return {};
  }
}
