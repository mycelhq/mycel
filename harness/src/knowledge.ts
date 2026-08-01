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
 */
export type RuleSource = "approval_edit" | "gap_answer" | "task_feedback" | "rejection" | "authored";

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
      client_id: args.client_id,
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
    client_id: args.client_id,
    task_types: args.task_types ?? [],
    subject: args.question_id,
    kind: "fact",
    // Question and answer together: months later "£45" alone is unreadable, and the agent reads
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
    client_id: args.client_id,
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
  outcome: "created" | "corroborated" | "superseded";
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

  const samePoint =
    prior.kind === incoming.kind &&
    (sameText(prior.provenance.after, incoming.provenance.after) || sameText(prior.text, incoming.text));
  if (samePoint) {
    return {
      outcome: "corroborated",
      rule: {
        ...prior,
        corroborations: prior.corroborations + 1,
        // The evidence is refreshed to the most recent instance so the rendered example is the
        // freshest one the founder actually wrote, not the oldest.
        provenance: { ...incoming.provenance },
        updated_at: at,
      },
    };
  }

  const weaker = STRENGTH[incoming.kind] < STRENGTH[prior.kind];
  const replacement = materialize({ ...incoming, needs_review: weaker }, at);
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
