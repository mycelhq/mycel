// What this business's own closed deals say about how it prices and negotiates.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// EVERY REVISION CHAIN IS A WORKED EXAMPLE, AND NOTHING WAS READING THEM
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// A founder sends a proposal. The client asks for six months instead of twelve. A second goes out.
// They ask for the setup fee to come out. A third goes out and is signed.
//
// That sequence is a complete, evidenced account of how this business loses a week and some margin,
// and it happens again next month with a different client and the same two asks. The founder feels
// it and cannot see it, because each deal is remembered on its own and the pattern only exists
// across them.
//
// `Envelope.terms` and the revision chain make it computable. Thirty deals through here is thirty
// worked examples of this specific business's negotiation, in a form nothing has to guess at.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// THE DISTINCTION THE WHOLE FILE TURNS ON
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// WHAT THEY ASKED is not what it cost. A client asks about the term in eight of ten deals and the
// founder holds firm in seven — that is a fine outcome and a bad lesson to draw. What costs money is
// what MOVED: the difference between the terms first proposed and the terms signed.
//
// So `asked` and `conceded` are separate counts throughout, and every finding says which it is
// reporting. Reporting the first as if it were the second would tell a founder to pre-emptively
// discount against an objection they usually win, which is the single most expensive advice this
// module could give.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// AND IT REFUSES TO GENERALISE FROM ONE DEAL
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// Two clients asking about the same thing is a coincidence. `MIN_DEALS` is where it stops being one.
// Every finding carries its sample, because "in 3 of your last 4" is actionable and "clients often
// ask about the term" is a horoscope.
import type { Envelope } from "./signing";

/** Below this there is no pattern, only two clients who happened to say the same thing. */
export const MIN_DEALS = 3;

/**
 * The topics a proposal gets pushed back on.
 *
 * A CLOSED LIST, matched on words, and deliberately not a model call. The point of this module is
 * that its findings are checkable — a founder reading "you conceded on term in 4 of 5" can go and
 * look at those five. A clustering model would produce better topics and nothing anybody could
 * verify, and an unverifiable finding about somebody's pricing is worse than no finding.
 *
 * The list is short because it is the list that actually recurs in service-business negotiation.
 * Anything unmatched is counted under `other` and reported as such rather than forced into a bucket.
 */
const TOPICS = [
  { key: "price", words: ["price", "cost", "expensive", "cheaper", "budget", "discount", "rate", "fee"] },
  { key: "term", words: ["term", "months", "commitment", "lock", "notice", "shorter", "rolling", "annual"] },
  /**
   * `instead` and `also` were here and are gone.
   *
   * They appear in every comparative sentence a client writes — "six months instead of twelve" is
   * about the TERM, and it was being counted as a scope ask as well. A weak word in a topic list
   * does not add recall, it adds a second topic to half the findings and quietly inflates the
   * denominator of the one that mattered.
   *
   * What is left is what a client says when they genuinely mean the deliverable.
   */
  { key: "scope", words: ["scope", "include", "add", "remove", "extra", "swap", "deliverable"] },
  { key: "start", words: ["start", "begin", "timing", "date", "later", "sooner", "delay", "kick"] },
  { key: "payment", words: ["invoice", "payment", "terms", "upfront", "deposit", "monthly", "net", "billing"] },
] as const;

export type TopicKey = (typeof TOPICS)[number]["key"] | "other";

/** Which topics a sentence touches. More than one is normal — "cheaper and shorter" is both. */
export function topicsIn(text: string): TopicKey[] {
  const t = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  const hits = TOPICS.filter((topic) => topic.words.some((w) => t.includes(` ${w}`))).map((topic) => topic.key);
  return hits.length ? (hits as TopicKey[]) : ["other"];
}

/** One negotiation, start to finish. */
export interface DealChain {
  /** Oldest first. `[0]` is what was proposed; the last is what happened. */
  envelopes: Envelope[];
}

/**
 * Group a project's envelopes into chains.
 *
 * By `supersedes`, not by client or case: one client can have three unrelated agreements and a
 * single agreement can outlive the case it started on. The link is the only thing that says "this
 * paper replaced that one".
 */
export function chainsFrom(envelopes: readonly Envelope[]): DealChain[] {
  const byId = new Map(envelopes.map((e) => [e.id, e]));
  /**
   * A HEAD IS AN ENVELOPE THAT SUPERSEDES NOTHING — the first paper of its negotiation.
   *
   * Written first as "the set of ids that appear in somebody's `supersedes`, excluded", which is the
   * set of PREDECESSORS. Filtering those out kept every tail and dropped every head, so a
   * three-round negotiation came back as a one-envelope chain containing only the signed paper —
   * and every lesson about what was asked along the way silently disappeared.
   *
   * The test caught it because it asserts the walk starts at revision 1.
   */
  const heads = envelopes.filter((e) => !e.supersedes);

  return heads.map((head) => {
    const chain: Envelope[] = [head];
    // Walk forward, bounded. A cycle cannot happen through `reviseEnvelope`, and a bound is cheaper
    // than trusting that for ever on data a repair script can also write.
    let cur = head;
    for (let i = 0; i < 50 && cur.superseded_by; i++) {
      const next = byId.get(cur.superseded_by);
      if (!next) break;
      chain.push(next);
      cur = next;
    }
    return { envelopes: chain };
  });
}

export interface DealLesson {
  topic: TopicKey;
  /** How many closed deals were pushed back on this. */
  asked: number;
  /** And how many of those actually moved. The number that costs money. */
  conceded: number;
  /** Out of how many closed deals. Every finding carries its sample. */
  of: number;
  /** One sentence, naming both numbers. */
  says: string;
}

export interface DealSummary {
  /** Chains that reached a terminal state. An open negotiation is not evidence yet. */
  closed: number;
  signed: number;
  /** Signed on the first paper, with no revision. The number a founder wants to move. */
  signed_first_time: number;
  /** Median revisions on the deals that were signed. */
  median_rounds: number | null;
  /**
   * Median percentage the price moved from first proposal to signed, on deals where it moved.
   *
   * Negative is a discount. Reported only where terms exist on both ends — a chain that predates
   * `Envelope.terms` is excluded rather than assumed flat, because "it did not move" and "we cannot
   * see whether it moved" are different facts and only one of them is good news.
   */
  median_price_move_pct: number | null;
  price_moves_seen: number;
  lessons: DealLesson[];
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round(((s[mid - 1]! + s[mid]!) / 2) * 10) / 10;
};

/**
 * What the closed deals say.
 *
 * Pure — envelopes in, findings out. Every judgement in this module is testable against a fixture
 * because none of it needs a store, and the findings are about somebody's pricing, which is not a
 * place to be approximately right in a way nobody can check.
 */
export function dealLessons(envelopes: readonly Envelope[]): DealSummary {
  const chains = chainsFrom(envelopes).filter((c) => {
    const last = c.envelopes.at(-1)!;
    return last.status === "executed" || last.status === "declined" || last.status === "expired";
  });

  const signedChains = chains.filter((c) => c.envelopes.at(-1)!.status === "executed");
  const rounds = signedChains.map((c) => c.envelopes.length - 1);

  // Price movement, first proposal to signed, only where both ends carry terms.
  const moves: number[] = [];
  for (const c of signedChains) {
    const first = c.envelopes[0]!.terms;
    const last = c.envelopes.at(-1)!.terms;
    if (!first?.price_minor || !last?.price_minor) continue;
    if (first.currency !== last.currency) continue; // a currency change is not a discount
    if (first.price_minor === last.price_minor) {
      moves.push(0);
      continue;
    }
    moves.push(Math.round(((last.price_minor - first.price_minor) / first.price_minor) * 1000) / 10);
  }

  // What was asked, and what moved. Counted per CHAIN, not per envelope: a client who mentions the
  // price in two consecutive requests has raised it once as far as a pattern is concerned.
  const askedBy = new Map<TopicKey, number>();
  const concededBy = new Map<TopicKey, number>();
  for (const c of chains) {
    const asks = c.envelopes.flatMap((e) => (e.change_requested ? topicsIn(e.change_requested.asked) : []));
    for (const topic of new Set(asks)) askedBy.set(topic, (askedBy.get(topic) ?? 0) + 1);

    const first = c.envelopes[0]!.terms;
    const last = c.envelopes.at(-1)!.terms;
    if (!first || !last) continue;
    const movedTopics = new Set<TopicKey>();
    if (first.price_minor !== last.price_minor) movedTopics.add("price");
    if ((first.term_months ?? null) !== (last.term_months ?? null)) movedTopics.add("term");
    if ((first.cadence ?? null) !== (last.cadence ?? null)) movedTopics.add("payment");
    for (const topic of movedTopics) concededBy.set(topic, (concededBy.get(topic) ?? 0) + 1);
  }

  const lessons: DealLesson[] = [];
  for (const [topic, asked] of askedBy) {
    if (asked < MIN_DEALS) continue;
    const conceded = concededBy.get(topic) ?? 0;
    lessons.push({
      topic,
      asked,
      conceded,
      of: chains.length,
      /**
       * Two sentences, because the two numbers mean opposite things.
       *
       * A topic asked about often and conceded rarely is a good outcome — the founder is winning
       * that argument. Reporting only the ask would tell them to pre-emptively discount against an
       * objection they usually beat, which is the most expensive advice this file could give.
       */
      says:
        conceded === 0
          ? `Clients asked about ${label(topic)} in ${asked} of your last ${chains.length} deals, and you held every time.`
          : `Clients asked about ${label(topic)} in ${asked} of your last ${chains.length} deals, and it moved in ${conceded}.`,
    });
  }
  lessons.sort((a, b) => b.conceded - a.conceded || b.asked - a.asked);

  return {
    closed: chains.length,
    signed: signedChains.length,
    signed_first_time: signedChains.filter((c) => c.envelopes.length === 1).length,
    median_rounds: median(rounds),
    median_price_move_pct: median(moves.filter((m) => m !== 0)),
    price_moves_seen: moves.length,
    lessons,
  };
}

function label(t: TopicKey): string {
  return t === "other" ? "something else" : t === "payment" ? "payment terms" : t === "start" ? "the start date" : `the ${t}`;
}

/**
 * The lessons, shaped for a prompt.
 *
 * ═══ WHY THIS IS NOT JUST THE `DealSummary` ═══
 *
 * `buildPrompt` renders one line — `Input: {…raw JSON…}` — and `describeInputContract` only speaks
 * for fields a task type declares. `draft_engagement` declares no `input_schema`, so a `DealSummary`
 * dropped into the input arrives as anonymous JSON: a key called `conceded` with exactly as much
 * standing as a key called `note`. That is the failure input-contract.ts exists to describe, and
 * adding a second instance of it while citing the first would be its own kind of joke.
 *
 * So the payload says what it is IN ITSELF. Every value is a sentence a person could read aloud, the
 * key names the provenance, and `read_this_as` carries the one instruction that stops the model
 * drawing the expensive conclusion.
 *
 * ═══ THE EXPENSIVE CONCLUSION ═══
 *
 * A model handed "clients asked about the price in 4 of your last 6 deals" will helpfully open at a
 * lower price. That is precisely backwards when the founder HELD all four times: it hands over,
 * unprompted, the margin they won four arguments to keep. The `says` sentences always state the
 * concession count alongside the ask, and `read_this_as` says what to do with it, because the gap
 * between those two numbers is the entire value of this module.
 */
export function lessonsForPrompt(s: DealSummary): Record<string, unknown> | undefined {
  if (s.closed < MIN_DEALS || !s.lessons.length) return undefined;
  const held = s.lessons.filter((l) => l.conceded === 0).map((l) => label(l.topic));
  return {
    from: `This business's own last ${s.closed} closed negotiations. Not benchmarks, not guesses.`,
    read_this_as:
      "Where they ASKED and it did not move, that argument is being won — price and term as you " +
      "normally would and do not pre-emptively discount there. Where it MOVED, expect the same ask " +
      "again and decide deliberately whether to price it in or hold the line." +
      (held.length ? ` Held every time so far on: ${held.join(", ")}.` : ""),
    what_happened: s.lessons.map((l) => l.says),
    signed_without_revision: `${s.signed_first_time} of ${s.signed} signed deals`,
    ...(s.median_rounds !== null ? { median_revisions_before_signature: s.median_rounds } : {}),
    ...(s.median_price_move_pct !== null
      ? {
          typical_price_move:
            `${s.median_price_move_pct > 0 ? "+" : ""}${s.median_price_move_pct}% from first proposal ` +
            `to signature, on the ${s.price_moves_seen} deals where the price is on record`,
        }
      : {}),
  };
}
