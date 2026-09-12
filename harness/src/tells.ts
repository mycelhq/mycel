// The tells that mark a sentence as machine-written, checked before it reaches a person.
//
// ═══ WHY A SECOND LINTER, AND WHY IT IS NOT A WORD LIST ═══
//
// `ship-checks.ts` already forbids vocabularies — `brand_poetry`, `placeholder` — and a word list
// catches the easy half. A model told not to say "leverage" says "utilise" and produces the same
// empty sentence: the register is unchanged and the reader still knows.
//
// What actually gives machine writing away is SHAPE. Sentences all the same length. Three parallel
// items. "Not only X but also Y". A summary of a message too short to need one. Two hedges in a row.
// A closing question that asks for nothing answerable. None of those is a word, and none can be
// caught by forbidding one.
//
// ═══ WHERE THIS CAME FROM ═══
//
// Ported from `growth/lib/copy/tells.ts`, the founder-side linter every outbound draft already
// passes through, rather than written fresh. Those rules are tuned against real sends and their
// thresholds carry arguments somebody has already had — the 2-word uniformity band, the 70-word
// short-message boundary, the "one hedge is human, two is padding" line. Re-deriving them here would
// have produced different numbers with none of the evidence, which is the mistake this codebase made
// with the Xero tool slugs.
//
// What is NEW is the social dialect: LinkedIn and Reddit have their own slop, and it is not the slop
// of a cold email. A post opening "Here's the thing:" and closing "Thoughts? 👇" is instantly
// recognisable and neither phrase appears in an outbound linter.
//
// ═══ THE POSTURE: IT REPORTS, IT DOES NOT REWRITE ═══
//
// Every violation names the tell and says what to do instead. A gate that only says "no" teaches
// nothing, and the same draft comes back with the same shape wearing different words.

/** One thing wrong, and what to do about it. */
export interface Tell {
  /** Stable id. A rename orphans any history keyed on it. */
  rule: string;
  detail: string;
}

const words = (s: string): number => (s.trim().match(/\S+/g) ?? []).length;

/** Sentences, roughly. Abbreviations will split wrong occasionally; no rule here is worth a parser. */
export function sentencesOf(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The first sentence, which is where a formula opening does its damage. */
const openingOf = (text: string): string => sentencesOf(text)[0] ?? "";

const OPENING_FORMULAS: readonly RegExp[] = [
  /\bi hope (this|you|your)\b/i,
  /\bhope (this finds|you're doing|you are doing|all is|things are)\b/i,
  /\bi (just )?wanted to (reach|connect|drop|touch|check|share|introduce)\b/i,
  /\b(i|just) came across\b/i,
  /\bcame across (your|you|the)\b/i,
  /\b(i'?m|i am|just) reaching out\b/i,
  /\bi'?m writing to\b/i,
  /\bi'?ll keep this (short|brief)\b/i,
  // The social dialect. These open roughly one LinkedIn post in four.
  /^here'?s the thing\b/i,
  /^let'?s (talk|be honest|dive in)\b/i,
  /^(i'?m|i am) (excited|thrilled|humbled|proud) to (share|announce)\b/i,
  /^unpopular opinion\b/i,
  /^hot take\b/i,
];

const CORPORATE_REGISTER: readonly RegExp[] = [
  /\b(excited|thrilled|delighted|passionate|stoked)\b/i,
  /\bunlock(s|ing|ed)?\b/i,
  /\brobust\b/i,
  /\btransformative\b/i,
  /\bstate[- ]of[- ]the[- ]art\b/i,
  /\bnext[- ]level\b/i,
  /\bturbo[- ]?charge/i,
  /\bgame[- ]chang(er|ing)\b/i,
  /\bcraft(ed|ing)? (a|the|your) (solution|experience|journey)\b/i,
  /\bin today'?s (fast[- ]paced|digital|competitive|ever[- ]changing)\b/i,
  /\bdelve\b/i,
  /\btapestry\b/i,
];

/** A constructed sentence, not a typed one. */
const NOT_ONLY = /\bnot only\b[^.!?]{0,80}?\bbut\b[^.!?]{0,20}?\b(also|as well)\b/i;
/** Three parallel items. Only a tell in short writing — a list of three in an essay is a list of three. */
const TRICOLON =
  /\b[\w'-]+(?:\s+[\w'-]+){0,3},\s+[\w'-]+(?:\s+[\w'-]+){0,3},\s+(?:and|or)\s+[\w'-]+(?:\s+[\w'-]+){0,3}\b/i;
/** The LinkedIn cadence: a negation followed by its reveal, usually on two lines. */
const NOT_X_BUT_Y = /\bit'?s not (about )?[^.!?\n]{2,40}\.\s*(it'?s|it is)\b/i;

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
  /\blet that sink in\b/i,
];

const HEDGES: readonly RegExp[] = [
  /\bjust\b/gi,
  /\bsimply\b/gi,
  /\ba bit\b/gi,
  /\bkind of\b/gi,
  /\bsort of\b/gi,
  /\bsomewhat\b/gi,
  /\bperhaps\b/gi,
];

const VAGUE_CTAS: readonly RegExp[] = [
  /\bworth a (quick |short |brief |fast )?(chat|conversation|call|catch[- ]?up|convo)\b/i,
  /\bworth (exploring|discussing|connecting)\b/i,
  /\bopen to (learning more|chatting|connecting|a (quick )?(call|chat))\b/i,
  /\bany interest\b/i,
  // The social close. Asks for engagement rather than for anything a person can answer.
  /\bthoughts\?/i,
  /\bagree\?/i,
  /\bwhat do you think\?\s*$/i,
  /\bdrop a comment\b/i,
  /\blet me know (your thoughts|in the comments)\b/i,
];

const GENERIC_PRAISE: readonly RegExp[] = [
  /\blove what (you|you're|you are|your team|they'?re) (do|doing|building|built|up to)\b/i,
  /\b(really |very |super |so |quite )?impressive (work|stuff|growth|things|what)\b/i,
  /\b(big|huge|long[- ]?time) fan of\b/i,
];

const adverbsIn = (s: string): string[] => s.match(/\b\w+ly\b/gi)?.filter((w) => !/^(only|reply|weekly|monthly|daily|quarterly|yearly|hourly|early|family|apply|supply|rely|july|italy|likely|friendly|lonely|lovely|ugly|holy)$/i.test(w)) ?? [];

const SHORT_MESSAGE_WORDS = 70;
const UNIFORM_MAX_WORDS = 45;
const SELF_SUMMARY_MAX_WORDS = 80;
const ADVERB_TOTAL = 3;
const ADVERB_PER_SENTENCE = 2;

/**
 * Every tell in a piece of writing.
 *
 * `social` loosens the rules that only make sense for a short direct message — a blog post may
 * legitimately summarise itself, and a long essay may contain a list of three — and tightens the two
 * that only apply in a feed: stacked one-line paragraphs, and emoji used as bullets.
 */
export function lintTells(text: string, opts: { social?: boolean } = {}): Tell[] {
  const out: Tell[] = [];
  const push = (rule: string, detail: string): void => {
    out.push({ rule, detail });
  };
  const body = String(text ?? "");
  if (!body.trim()) return out;

  const total = words(body);
  const sentences = sentencesOf(body);
  const isShort = total <= SHORT_MESSAGE_WORDS;

  const opening = openingOf(body);
  for (const re of OPENING_FORMULAS) {
    const hit = opening.match(re);
    if (hit) {
      push("opening-formula", `"${hit[0]}" opens it; start with the thing you actually noticed instead`);
      break; // One complaint. The rewrite is the same either way.
    }
  }

  for (const re of CORPORATE_REGISTER) {
    const hit = body.match(re);
    if (hit) push("corporate-register", `"${hit[0]}" is press-release register, not one person typing`);
  }

  if (NOT_ONLY.test(body)) {
    push("structural-symmetry", `"not only… but also" is a constructed sentence, not a typed one`);
  } else if (isShort) {
    const tri = body.match(TRICOLON);
    if (tri) push("structural-symmetry", `three parallel items ("${tri[0].slice(0, 48)}") reads as generated`);
  }
  const notXButY = body.match(NOT_X_BUT_Y);
  if (notXButY) {
    push("structural-symmetry", `"${notXButY[0].slice(0, 48)}" is the reveal cadence every feed is full of`);
  }

  /**
   * Uniform sentence length. Human writing is lopsided; a paragraph where every sentence lands
   * within two words of the others is the clearest structural tell there is.
   *
   * The "all substantial" clause is deliberate: a short fragment dropped after a long sentence is a
   * human fingerprint, so a message containing one is exempt by construction rather than by
   * exception.
   */
  if (total <= UNIFORM_MAX_WORDS && sentences.length >= 3) {
    const lens = sentences.map(words);
    const min = Math.min(...lens);
    const max = Math.max(...lens);
    if (min >= 5 && max - min <= 2) {
      push("uniform-sentences", `every sentence is ${min}-${max} words; break one short and it reads human`);
    }
  }

  // A short message does not need summarising. A long article legitimately might.
  if (total <= SELF_SUMMARY_MAX_WORDS || !opts.social) {
    for (const re of SELF_SUMMARY) {
      const hit = body.match(re);
      if (hit) {
        push("self-summary", `"${hit[0]}" summarises a ${total}-word piece that needs no summary`);
        break;
      }
    }
  }

  const hedges = HEDGES.flatMap((re) => body.match(re) ?? []);
  if (hedges.length > 1) {
    push("hedge-stacking", `${hedges.length} hedges (${hedges.join(", ")}); one is human, two is padding`);
  }

  const adverbs = adverbsIn(body);
  const perSentence = Math.max(0, ...sentences.map((s) => adverbsIn(s).length));
  if (adverbs.length >= ADVERB_TOTAL || perSentence >= ADVERB_PER_SENTENCE) {
    push("adverb-stacking", `stacked qualifiers (${adverbs.slice(0, 4).join(", ")}); cut them and the claim gets stronger`);
  }

  for (const re of VAGUE_CTAS) {
    const hit = body.match(re);
    if (hit) {
      push("vague-cta", `"${hit[0]}" asks for engagement, not for something answerable in one word`);
      break;
    }
  }

  for (const re of GENERIC_PRAISE) {
    const hit = body.match(re);
    if (hit) {
      push("generic-praise", `"${hit[0]}" is true of everyone, so it is evidence nobody looked`);
      break;
    }
  }

  if (opts.social) {
    /**
     * BROETRY. One sentence per paragraph, stacked down the feed for rhythm. It is the single most
     * recognisable shape in social writing and it is almost never how a person writes when they have
     * something to say — it is how a person writes when they have been told line breaks perform.
     *
     * Four or more in a row, because two or three is emphasis and a reader would not blink.
     */
    const paras = body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    let run = 0;
    let worst = 0;
    for (const p of paras) {
      if (sentencesOf(p).length === 1 && words(p) <= 18) {
        run += 1;
        worst = Math.max(worst, run);
      } else run = 0;
    }
    if (worst >= 4) {
      push("broetry", `${worst} one-line paragraphs in a row; join some of them into real paragraphs`);
    }

    // Emoji as furniture. One is a person; a bulleted list of them is a template.
    const emoji = body.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu) ?? [];
    if (emoji.length >= 3) {
      push("emoji-furniture", `${emoji.length} emoji; they are decoration standing in for a point`);
    }
  }

  return out;
}
