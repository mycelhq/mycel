// Apply founder-stated rules at RANK time, not only at draft time.
//
// ═══════════════════════════ WHY THIS EXISTS ═══════════════════════════
//
// Onboarding stores the founder's answers as rules (`distillFromOnboarding`). Those rules reach an
// agent prompt via `groundRun` — which is to say, they reach a job that has already been chosen.
// Ranking never read them. A founder who typed "Never chase anyone at Ravel Systems" then saw
// "Chase Invoice INV-0001 · Ravel Systems" as the #1 move, with a "Why here?" that cited only
// money, deadline and silence. The Learning page confirmed it: all five rules "never used on a job".
//
// If rules only apply at draft time, onboarding — currently this product's best asset — is theatre.
//
// ═══════════════════════════ WHY MATCHING, NOT EXTRACTION ═══════════════════════════
//
// The alternative is to parse a structured constraint at onboarding time (subject + verb) and have
// the ranker evaluate that. Extraction that fails silently is a worse lie than a rule that stays
// unused: the founder thinks we understood "never chase Ravel" and we filed a fact about weekends.
// Matching at rank time keeps the failure mode loud — a vague rule matches nothing, stays "never
// used", and the Learning page keeps telling the truth about it.
//
// Matching is conservative on purpose. A prohibition needs THREE things before it holds a move:
//
//   1. Prohibit language ("never", "don't", "do not", "stop", "avoid") — or `kind: "never"`.
//   2. An action that names this kind of move (chase, nudge, email, …).
//   3. A named party that appears on the move (client display name, invoice number, entity label).
//
// Missing any one of those is "too vague to apply", not "apply to everything". A rule that says
// "be polite" does not demote a chase, and a rule that says "never chase" with no named party does
// not halt the whole AR book. Both stay unused, which is the honest counter.
//
// ═══════════════════════════ TRANSPARENCY IS THE FEATURE ═══════════════════════════
//
// A held move is NOT deleted. Silent suppression would be a different lie — the founder would not
// know we heard them. The move stays in the proposal, `takeable: false`, with a `rule` score term
// whose `because` quotes their words, and `unavailable_reason` says the same sentence. "Why here?"
// is how they see it.
import type { Rule } from "./knowledge";
import type { Move, MoveKind, ScoreTerm } from "./moves";

/** Enough to bury any money/deadline/staleness stack. A held move must rank last, visibly. */
export const RULE_HOLD_POINTS = -50;

const PROHIBIT = /\b(never|don't|do not|dont|stop|avoid|mustn't|must not|no longer)\b/i;

const KIND_VERBS: Record<MoveKind, RegExp> = {
  chase_invoice: /\b(chase|chasing|dunn|overdue|collect|collection|remind.*invoice|invoice.*remind)\b/i,
  nudge_client_request: /\b(nudge|nudge them|chase them|follow.?up|remind)\b/i,
  invoice_accepted_work: /\b(invoice|bill|charge)\b/i,
  release_deliverable: /\b(release|ship|send.*client|deliver|hand over)\b/i,
  advance_case: /\b(advance|push|progress)\b/i,
  check_in_case: /\b(check.?in|chase the (case|engagement)|follow.?up)\b/i,
  gtm_next_touch: /\b(email|outreach|touch|sequence|prospect|linkedin)\b/i,
  rewrite_losing_arm: /\b(rewrite|experiment|arm|hero)\b/i,
  unblock_wait: /\b(wait|unblock)\b/i,
};

export interface RuleMatch {
  rule: Rule;
  /** The named party we matched on, when there was one. */
  party?: string;
}

/**
 * The text we match against. Onboarding rules are `"question — answer"`; the answer also lives in
 * `provenance.after`. Both, because a match on the question alone ("Who should we never chase?")
 * would fire on every chase.
 */
function haystack(rule: Rule): string {
  return `${rule.text}\n${rule.provenance.after ?? ""}\n${rule.provenance.question ?? ""}`;
}

function isProhibition(rule: Rule): boolean {
  if (rule.kind === "never") return true;
  return PROHIBIT.test(haystack(rule));
}

function namesMoveKind(rule: Rule, kind: MoveKind): boolean {
  const re = KIND_VERBS[kind];
  return re ? re.test(haystack(rule)) : false;
}

/**
 * Words that appear on every chase (the entity kind, the why-sentence) and must never count as a
 * named party. Without this, "Never chase invoices" tokenises against `Invoice INV-0001` and holds
 * the whole book — the failure matching was designed not to have.
 */
const TOO_COMMON = new Set([
  "invoice",
  "invoices",
  "overdue",
  "outstanding",
  "days",
  "chase",
  "chasing",
  "client",
  "request",
  "anyone",
  "engagement",
  "email",
  "case",
  "nudge",
]);

/**
 * Named parties on this move. The client display name, and the entity label (so "Never chase
 * INV-0001" can hold that row). Not `why` — that sentence is full of "overdue" / "outstanding" and
 * is not a party.
 */
function partiesOf(move: Move, clientName?: string): string[] {
  const raw = [clientName, move.entity.label];
  const out: string[] = [];
  for (const r of raw) {
    const t = (r ?? "").trim();
    if (t.length >= 3) out.push(t);
  }
  return out;
}

function partyTokens(party: string): string[] {
  // Keep hyphens so "INV-0001" stays one token. Split the rest.
  return party
    .toLowerCase()
    .split(/[^a-z0-9-]+/i)
    .map((t) => t.replace(/^-+|-+$/g, ""))
    .filter((t) => t.length >= 4 && !TOO_COMMON.has(t));
}

/**
 * Does this rule name a party that is on this move?
 *
 * Conservative: the party string from the move must appear as a whole-word-ish run inside the rule
 * (or vice versa, for "Ravel" vs "Ravel Systems"). We do not stem, and we do not match on common
 * English. A rule that names nobody cannot hold a move.
 */
export function namedPartyIn(rule: Rule, parties: readonly string[]): string | undefined {
  const text = haystack(rule).toLowerCase();
  for (const p of parties) {
    const needle = p.toLowerCase();
    if (needle.length < 4) continue;
    if (text.includes(needle)) return p;
    // "Ravel Systems" on the move, "Ravel" in the rule (or the reverse).
    if (partyTokens(needle).some((t) => text.includes(t))) return p;
  }
  return undefined;
}

/**
 * Whether this rule holds this move. Undefined = too vague, or not about this move.
 *
 * A rule scoped to a `client_id` only ever holds moves for that client — "Northwind wants Friday
 * summaries" is not a house rule.
 */
export function matchRuleToMove(rule: Rule, move: Move, clientName?: string): RuleMatch | undefined {
  if (rule.status !== "active") return undefined;
  if (rule.client_id && rule.client_id !== move.client_id) return undefined;
  if (rule.task_types.length && !rule.task_types.includes(move.carrier.task_type) && !rule.task_types.includes(move.kind)) {
    return undefined;
  }
  if (!isProhibition(rule)) return undefined;
  if (!namesMoveKind(rule, move.kind)) return undefined;
  const party = namedPartyIn(rule, partiesOf(move, clientName));
  if (!party) return undefined;
  return { rule, party };
}

function quoted(rule: Rule): string {
  const own = (rule.provenance.after ?? "").trim();
  if (own) return own;
  return rule.text.trim();
}

/**
 * Hold a move that a stated rule forbids. Returns the same object when nothing matches.
 *
 * Recalculates `score` from the terms so it can never disagree with `score_terms` — the same
 * invariant `assemble` enforces.
 */
export function applyStatedRules(move: Move, rules: readonly Rule[], clientName?: string): Move {
  const hits: RuleMatch[] = [];
  for (const r of rules) {
    const hit = matchRuleToMove(r, move, clientName);
    if (hit) hits.push(hit);
  }
  if (!hits.length) return move;

  const first = hits[0]!;
  const because = `you said “${quoted(first.rule)}”`;
  const term: ScoreTerm = { term: "rule", points: RULE_HOLD_POINTS, because };
  const terms = [...move.score_terms.filter((t) => t.term !== "rule"), term];
  const score = round(terms.reduce((sum, t) => sum + t.points, 0));
  return {
    ...move,
    score,
    score_terms: terms,
    takeable: false,
    unavailable_reason: because,
  };
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

export function appliedRuleIds(move: Move, rules: readonly Rule[], clientName?: string): string[] {
  return rules.filter((r) => matchRuleToMove(r, move, clientName)).map((r) => r.id);
}
