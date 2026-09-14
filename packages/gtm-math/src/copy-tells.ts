// The AI tells. Rules that fire on the RESIDUE of machine text, not on bad marketing.
//
// This file is the second half of one idea. The first half lives in lib/copy/grounding.ts: a
// message that says something specific and checkable about this person cannot read as generated,
// because no template knows it. You cannot get there from a rule — grounding is what makes copy
// human, and these rules only strip what is left over. That ordering matters for how they are
// tuned: they are a SUBTRACTIVE pass, so every one of them has to be safe to apply to a sentence a
// person actually wrote.
//
// ── THE PRECISION BUDGET ────────────────────────────────────────────────────
//
// A linter that fires on everything gets its ceiling raised until it means nothing. Every rule here
// is therefore tuned to REJECT CONFIDENTLY, not to nag, and the tuning is stated per rule in the
// comment above it. The three levers used, in order of preference:
//
//   1. Phrase, not word. "in short" is a summary marker; "short" is a word.
//   2. Position. "I came across your post" as the FIRST line is throat-clearing; the same clause in
//      the middle of a message is narration, and it is left alone.
//   3. Count. One hedge is a human softening a claim, and lib/reddit/draft.ts explicitly asks for
//      exactly one. Two hedges is a machine softening everything.
//
// Rules deliberately NOT implemented, and why:
//
//   - Em-dash overuse. The brief asked for "more than one em dash". `no-em-dash` in copy-gate.ts
//     already rejects the FIRST one on every channel, so a count rule would be dead code behind a
//     stricter rule. Nothing was added.
//   - Generic "perfectly balanced clause pairs". Detecting clause symmetry without a parser means
//     comparing clause word counts, and a two-clause sentence with equal halves is an extremely
//     common thing for a person to write ("I built it, she sold it"). Only the two high-precision
//     symmetry forms are implemented: the explicit "not only X but also Y", and the syndetic
//     tricolon. The asyndetic tricolon ("fast, cheap, good") is also skipped — too close to an
//     ordinary two-item list with an appositive.
//   - Passive voice, nominalisation, "delve"-style single-word bans beyond what already exists.
//     Single words are where a linter loses its precision fastest, and BANNED_PHRASES already owns
//     that territory with a hand-curated list.

import type { Violation } from "./copy-gate";

const countWords = (s: string): number => s.split(/\s+/).filter(Boolean).length;

export function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ── opening-formula ─────────────────────────────────────────────────────────
// Machine text clears its throat before it says anything. A person opens with the thing they
// noticed, because that is why they are writing. These are only matched in the OPENING — after a
// greeting and inside roughly the first sentence — because the same words mid-message are
// narration and perfectly human ("...then I came across your careers page").
const OPENING_FORMULAS: readonly RegExp[] = [
  /\bi hope (this|you|your)\b/i,
  /\bhope (this finds|you're doing|you are doing|all is|things are)\b/i,
  /\bi (just )?wanted to (reach|connect|drop|touch|check|share|introduce)\b/i,
  /\b(i|just) came across\b/i,
  /\bcame across (your|you|the)\b/i,
  /\b(i'?m|i am|just) reaching out\b/i,
  /\bi'?m writing to\b/i,
  /\bmy name is\b/i, // in a first line this is a letter template; the profile already says who we are
  /\bi'?ll keep this (short|brief)\b/i,
];

/**
 * The opening window: greeting stripped, then the first sentence, capped at 15 words so a single
 * run-on sentence cannot drag the whole message into the window.
 */
function openingOf(text: string): string {
  const withoutGreeting = text.replace(
    /^\s*(hi|hey|hello|dear|good (morning|afternoon|evening))\b[^,\n.!?]{0,24}[,\n]?\s*/i,
    "",
  );
  const first = sentencesOf(withoutGreeting)[0] ?? "";
  return first.split(/\s+/).slice(0, 15).join(" ");
}

// ── corporate-register ──────────────────────────────────────────────────────
// The enthusiast dialect. Nobody typing a note to one stranger is "thrilled"; that register belongs
// to a press release, and a model reaches for it because press releases are what it read.
//
// Words already in BANNED_PHRASES (leverage, streamline, seamless, supercharge, empower,
// game-changer, cutting-edge, revolutionize, elevate, unleash, world-class, best-in-class) are NOT
// repeated here — they keep firing under their stable `banned-phrase` id, and duplicating them
// would double-report the same word under two rules and make the rejection list read as noise.
//
// Tuned lenient: "innovative" and "bespoke" were considered and left out. Agencies describe
// themselves that way in their own copy, so the word can arrive from a grounded site fact rather
// than from the model's register, and rejecting a quoted fact is the wrong failure.
const CORPORATE_REGISTER: readonly RegExp[] = [
  /\b(excited|thrilled|delighted|passionate|stoked)\b/i,
  /\bunlock(s|ing|ed)?\b/i,
  /\brobust\b/i,
  /\btransformative\b/i,
  /\bstate[- ]of[- ]the[- ]art\b/i,
  /\bnext[- ]level\b/i,
  /\bturbo[- ]?charge/i,
  /\bcraft(ed|ing)? (a|the|your) (solution|experience|journey)\b/i,
];

// ── structural-symmetry ─────────────────────────────────────────────────────
// Real people are lopsided. Balanced structure is the loudest shape tell there is, because the
// model is optimising a sentence and a person is just finishing a thought.
// "but also", "but it also", "but they also" — the pronoun between the two halves is optional and
// the construction is the same tell either way.
const NOT_ONLY = /\bnot only\b[^.!?]{0,80}?\bbut\b[^.!?]{0,20}?\b(also|as well)\b/i;
/**
 * The syndetic tricolon: three short parallel items joined by a final "and"/"or". Items are capped
 * at four words each, which is what keeps this off ordinary prose — "I called the office manager,
 * asked for the PO number, and the invoice cleared" has long items and does not match.
 */
const TRICOLON = /\b[\w'-]+(?:\s+[\w'-]+){0,3},\s+[\w'-]+(?:\s+[\w'-]+){0,3},\s+(?:and|or)\s+[\w'-]+(?:\s+[\w'-]+){0,3}\b/i;

// ── self-summary ────────────────────────────────────────────────────────────
// A message that summarises itself was written by something that forgot how short it was. Scoped to
// short messages on purpose: a 45-second video script (lib/assets/script.ts) is long enough that a
// closing restatement is a legitimate rhetorical move.
const SELF_SUMMARY: readonly RegExp[] = [
  /\bin short\b/i,
  /\bin summary\b/i,
  /\bto summari[sz]e\b/i,
  /\bessentially\b/i,
  /\bto put it simply\b/i,
  /\bsimply put\b/i,
  /\bin a nutshell\b/i,
  /\bthe bottom line is\b/i,
  /\bat the end of the day\b/i,
];
const SELF_SUMMARY_MAX_WORDS = 80;

// ── hedge-stacking ──────────────────────────────────────────────────────────
// One hedge is a person being honest about the limits of what they know. Two is a machine sanding
// every edge off the message so nothing in it can be wrong. The threshold is therefore 2, not 1,
// and that is the single most important leniency decision in this file.
const HEDGES: readonly RegExp[] = [
  /\bjust\b/gi,
  /\bsimply\b/gi,
  /\ba bit\b/gi,
  /\bkind of\b/gi,
  /\bsort of\b/gi,
  /\bsomewhat\b/gi,
  /\bperhaps\b/gi,
  /\bi think maybe\b/gi,
];

// ── adverb-stacking ─────────────────────────────────────────────────────────
// Stacked qualifiers are where a model pads a sentence it has nothing more to say in.
// The -ly test needs an exception list or it fires on ordinary nouns and time words; without this
// list "bill weekly" and "reply" would both read as adverbs.
const NOT_ADVERBS = new Set([
  "only", "family", "early", "reply", "weekly", "monthly", "daily", "quarterly", "yearly", "hourly",
  "ugly", "holy", "apply", "supply", "rely", "fly", "july", "italy", "likely", "friendly", "lonely",
  "lovely", "silly", "belly", "rally", "ally", "jelly", "assembly", "anomaly", "italy", "costly",
  "timely", "orderly", "elderly", "curly", "burly",
]);
const INTENSIFIERS = /\b(very|really|quite|extremely|incredibly|truly|highly|absolutely|genuinely|significantly)\b/gi;
const ADVERB_TOTAL = 3;
const ADVERB_PER_SENTENCE = 2;

function adverbsIn(text: string): string[] {
  const ly = (text.match(/\b[a-z]+ly\b/gi) ?? []).filter((w) => !NOT_ADVERBS.has(w.toLowerCase()));
  const intens = text.match(INTENSIFIERS) ?? [];
  return [...ly, ...intens];
}

// ── vague-cta ───────────────────────────────────────────────────────────────
// The curiosity gap. "Worth a chat?" is not a question, it is a trap that asks the recipient to
// volunteer for an unspecified amount of their time, and everyone who has ever received one knows
// it. The replacement is an ask answerable in one word: "want me to send the audit?"
//
// Tuned lenient in one specific way: "worth a look?" is NOT here. It points at a named thing the
// sender is about to hand over rather than at an open-ended meeting, it is the shape our own
// existing clean drafts use, and rejecting it would be a taste claim rather than a tell.
const VAGUE_CTAS: readonly RegExp[] = [
  /\bworth a (quick |short |brief |fast )?(chat|conversation|call|catch[- ]?up|convo)\b/i,
  /\bworth (exploring|discussing|connecting)\b/i,
  /\bopen to (learning more|chatting|connecting|a (quick )?(call|chat))\b/i,
  /\bany interest\b/i,
  /\binterested in learning more\b/i,
  /\b(does that |)sound interesting\b/i,
  /\blet'?s connect\b/i,
  /\bmake sense to connect\b/i,
  /\bup for a (quick )?(call|chat)\b/i,
  /\bcan i pick your brain\b/i,
  // The calendar ask wearing a small number as a disguise. Scoped to the "of your time" / "to chat"
  // completions on purpose: a bare "15 minutes" is very often a grounded fact about how long
  // something took, and rejecting that would be rejecting the specificity we are trying to buy.
  /\b(10|15|20|30) ?(min|mins|minutes) (of your time|to (chat|talk|walk|show|run))\b/i,
  /\bgrab (15|20|30) ?(min|mins|minutes)\b/i,
];

// ── generic-praise ──────────────────────────────────────────────────────────
// The single loudest tell that nobody looked. Every one of these is true of every company, which
// makes it evidence of nothing, and the recipient reads it as exactly that. This is the rule the
// specificity floor in lib/copy/grounding.ts exists to make unnecessary — it is here as the
// backstop for a model that had grounded facts and reached for flattery anyway.
const GENERIC_PRAISE: readonly RegExp[] = [
  /\blove what (you|you're|you are|your team|they'?re) (do|doing|building|built|up to)\b/i,
  /\b(really |very |super |so |quite )?impressive (work|stuff|growth|things|what)\b/i,
  /\b(big|huge|long[- ]?time) fan of\b/i,
  /\b(great|amazing|awesome|fantastic|incredible) (work|stuff|things|job) (you|your|over)\b/i,
  /\bi'?ve been following (your|you|the) (work|journey|growth|company)\b/i,
  /\byour (work|website|site|brand|portfolio) is (really |truly |very )?(impressive|amazing|great|stunning|beautiful)\b/i,
  /\bcongrats on (all|the amazing|the incredible|everything)\b/i,
  /\bwhat you'?ve built is\b/i,
];

/** How the shape rules decide whether a message counts as "short". */
const SHORT_MESSAGE_WORDS = 70;

/**
 * The uniformity rule gets a TIGHTER budget than the other shape rules, and this is the most
 * deliberate leniency decision in the file after the hedge threshold.
 *
 * At the 40-word DM ceiling, a rhythm of three same-length sentences IS the message — there is
 * nothing else in it, and the metronome is unmissable. At 60 to 90 words (cold email, a Reddit
 * reply, a video script) runs of similar-length sentences occur naturally in prose people actually
 * write, so firing there would be guessing. The rule is scoped to the channel where it is a
 * certainty rather than the channels where it is a suspicion.
 */
const UNIFORM_MAX_WORDS = 45;

/**
 * The tell pass. Returns violations to be concatenated onto `lint()`'s own list; every rule id here
 * is NEW, because the stored `copy_rejected` events key off the existing ids and those must not move.
 */
export function lintTells(
  text: string,
  opts: { maxWords?: number; conversational?: boolean } = {},
): Violation[] {
  const out: Violation[] = [];
  const push = (rule: string, detail: string) => out.push({ rule, detail });

  const total = countWords(text);
  const sentences = sentencesOf(text);
  const isShort = total <= SHORT_MESSAGE_WORDS;

  const opening = openingOf(text);
  for (const re of OPENING_FORMULAS) {
    const hit = opening.match(re);
    if (hit) {
      push("opening-formula", `"${hit[0]}" opens the message; start with what you noticed instead`);
      break; // one complaint: the rewrite is the same either way
    }
  }

  for (const re of CORPORATE_REGISTER) {
    const hit = text.match(re);
    if (hit) push("corporate-register", `"${hit[0]}" is press-release register, not one person typing`);
  }

  const notOnly = text.match(NOT_ONLY);
  if (notOnly) {
    push("structural-symmetry", `"not only… but also" is a constructed sentence, not a typed one`);
  } else {
    const tri = text.match(TRICOLON);
    // Only a symmetry tell in a SHORT message: a list of three in a long script is a list of three.
    /**
     * ═══ A LIST IS A TELL IN AN OPENER AND ORDINARY IN A REPLY ═══
     *
     * "Three parallel items" is a real signature of generated prose when it appears in a cold first
     * touch: nobody writing to a stranger naturally produces a balanced triad in forty words.
     *
     * In an ANSWER it is how people write. The message this rule threw away, to a prospect who had
     * just asked "can we talk this week?", was:
     *
     *     Yes. We can cover pricing, start date, and what we run each month for Idgroup's clients.
     *     Pick a time here: <booking link>
     *
     * That is the reply this entire system exists to send, and it was refused for naming the three
     * things the call would cover. Twice, so the prospect got nothing at all. The rule was right
     * about the shape and wrong about the situation.
     */
    if (tri && isShort && !opts.conversational) {
      push("structural-symmetry", `three parallel items ("${tri[0].slice(0, 48)}") reads as generated`);
    }
  }

  // Uniform sentence length. Requires three or more sentences, all of them substantial, all within
  // two words of each other. The "all substantial" clause (min 5 words) is deliberate: a short
  // fragment dropped after a long sentence is a human fingerprint, and a message containing one is
  // exempt by construction rather than by exception.
  if (total <= UNIFORM_MAX_WORDS && sentences.length >= 3) {
    const lens = sentences.map(countWords);
    const min = Math.min(...lens);
    const max = Math.max(...lens);
    if (min >= 5 && max - min <= 2) {
      push(
        "uniform-sentences",
        `every sentence is ${min}-${max} words; human writing is lopsided, so break one short`,
      );
    }
  }

  if (total <= SELF_SUMMARY_MAX_WORDS) {
    for (const re of SELF_SUMMARY) {
      const hit = text.match(re);
      if (hit) {
        push("self-summary", `"${hit[0]}" summarises a ${total}-word message that needs no summary`);
        break;
      }
    }
  }

  const hedges = HEDGES.flatMap((re) => text.match(re) ?? []);
  if (hedges.length > 1) {
    push("hedge-stacking", `${hedges.length} hedges (${hedges.join(", ")}); one is human, two is padding`);
  }

  const adverbs = adverbsIn(text);
  const perSentence = Math.max(0, ...sentences.map((s) => adverbsIn(s).length));
  if (adverbs.length >= ADVERB_TOTAL || perSentence >= ADVERB_PER_SENTENCE) {
    push("adverb-stacking", `stacked qualifiers (${adverbs.join(", ")}); cut them and the claim gets stronger`);
  }

  for (const re of VAGUE_CTAS) {
    const hit = text.match(re);
    if (hit) {
      push(
        "vague-cta",
        `"${hit[0]}" is a curiosity gap; ask for something answerable in one word ("want me to send it?")`,
      );
      break;
    }
  }

  for (const re of GENERIC_PRAISE) {
    const hit = text.match(re);
    if (hit) {
      push("generic-praise", `"${hit[0]}" is true of everyone, so it is evidence nobody looked`);
      break;
    }
  }

  // Nothing here reads the ceiling directly; it is accepted so callers can pass their lint options
  // through unchanged, and so a future rule can scope itself by channel budget.
  void opts.maxWords;
  return out;
}
