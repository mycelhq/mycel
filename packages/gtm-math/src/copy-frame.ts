// The FRAME rules. Two of them, both new ids, both about what the message is DOING rather than how
// it sounds.
//
// lib/copy-gate.ts rejects machine residue. lib/copy/tells.ts rejects the shapes a model falls into.
// Neither of them can see the failure this file exists for, because both of the drafts below are
// clean, specific, grounded, well-punctuated English:
//
//   "ChatGPT names three other Austin SEO shops for 'best technical SEO agency'. Not you."
//   "Your clients are starting to ask what AI says about them. You can't run that for 30 accounts."
//
// The first insults a professional at his own trade. The second explains his business to him. Both
// are strategy errors that arrive fully formed as good sentences, so they need their own pass.
//
// ── THE PRECISION BUDGET, INHERITED ─────────────────────────────────────────
//
// Same discipline as lib/copy/tells.ts: reject confidently, do not nag. Every pattern below is
// SECOND PERSON and ASSERTIVE, and that pairing is what does the work. The reason is worth stating
// once, because it is the whole tuning argument:
//
//   A finding about the AGENCY'S OWN domain, reframed as a sample of the deliverable, does not
//   contain any of these. It says what the tool produced. It is the DIAGNOSTIC grammar — "you do
//   not show up", "your competitors beat you", "your clients want X", "you can't do Y" — that is
//   unrecoverable, and diagnostic grammar is second person and assertive by construction.
//
// So a message about a real finding passes, and a message that turns the same finding into a verdict
// on the reader does not. That is exactly the line the strategy correction drew.
//
// ── WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────────────
//
//   - A "does this message explain too much" length or ratio heuristic. Word counts do not
//     distinguish explaining from describing, and `max-40-words` already owns length.
//   - Detecting that the finding names the AGENCY rather than one of their clients. That needs the
//     brand string, the linter only gets a string, and the caller that has both is
//     lib/engine/copy.ts — which handles it by prompt, in `findingAsSampleLines`.
//   - Banning the word "clients". It is the single most load-bearing word in the correct frame
//     ("run it for your client list"). Only ASSERTIONS about what their clients are doing fire.

import type { Violation } from "./copy-gate";

// ── THE HOLE THIS SECTION CLOSES ────────────────────────────────────────────
//
// Every pattern in SELF_DIAGNOSIS below is SECOND PERSON. That was a deliberate tuning decision and
// it was wrong, and the evidence is the four emails that went out on 31 August:
//
//   "Claude names Red Antler, Collins and Pentagram, not Spilt Media"
//   "Claude names Custom Ink, RushOrderTees and 4imprint, not Cloud 9 Everything"
//   "Claude names Common Thread Collective, Tinuiti and Power Digital, not Human"
//   "...names FINN Partners, MMGY Global and GainingEdge... Discover the World isn't named."
//
// Four for four, every one of them the exact sentence this file exists to prevent, every one of
// them clean through the gate. The model did not defeat the rule. It moved the subject: write the
// verdict in the THIRD person, with their brand where "you" would be, and there is no "you" and no
// "your" left to match. `not Spilt Media` is the same insult as `not you` and the linter could not
// see it, because a linter that only gets a string does not know what the agency is called.
//
// So the caller passes the names. `lint()` takes `subject`, `lintOptsFor` in lib/engine/copy.ts
// fills it from the company name and the brand the audit inferred, and the diagnosis patterns are
// rebuilt against `(you|your|<their name>)`. THE NAMES ARE NOT OPTIONAL IN SPIRIT: a caller with no
// subject gets the old second-person-only behaviour, which is strictly better than nothing and
// strictly worse than the truth.

/** Regex-escape, so a brand containing `.` or `+` matches itself rather than anything. */
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The forms of a company name a model will actually write.
 *
 * "The Marketing Arm" gets written as "Marketing Arm" about as often as in full, and "Spilt Media"
 * as "Spilt". So: the name as given, the name with a leading article stripped, and the first word
 * when it is long enough to be a brand rather than an English word. The 5-character floor on that
 * last one is what keeps "Human" from being reduced to nothing and "The Agency" from matching the
 * word "agency" in a sentence about agencies.
 */
/**
 * First words that are industry, not brand.
 *
 * The reduction to a first word is what catches "Marketing Arm" written as "Marketing"... and it is
 * also how a linter starts rejecting the sentence "this is not marketing, it is a report". A generic
 * word is the agency's category, shared with several thousand other shops, and as a standalone
 * pattern it matches English rather than a company. The full name and the article-stripped name are
 * still matched for these — only the one-word reduction is withheld.
 */
const GENERIC_FIRST = new Set([
  "agency", "digital", "marketing", "creative", "studio", "media", "group", "global", "social",
  "search", "content", "brand", "design", "growth", "online", "modern", "simple", "smart", "first",
  "north", "south", "east", "west", "united", "national", "premier", "elite", "prime", "apex",
  "human", "people", "impact", "future", "forward", "bright", "clear", "direct", "local",
]);

export function subjectForms(names: readonly (string | null | undefined)[]): string[] {
  const out = new Set<string>();
  for (const raw of names) {
    const name = (raw ?? "").trim().replace(/[.,]+$/, "");
    if (name.length < 3) continue;
    out.add(name);
    const noArticle = name.replace(/^(the|a)\s+/i, "").trim();
    if (noArticle.length >= 3) out.add(noArticle);
    const first = noArticle.split(/\s+/)[0] ?? "";
    if (first.length >= 5 && !GENERIC_FIRST.has(first.toLowerCase()) && /^[A-Za-z][A-Za-z0-9'-]*$/.test(first)) {
      out.add(first);
    }
  }
  return [...out];
}

/**
 * The diagnosis patterns, rebuilt with their name standing in for "you".
 *
 * Built per call rather than cached: the subject changes every message, and a regex cache keyed on
 * a company name is a memory leak with a bad reason. There are six of them and they run on 40 words.
 */
function namedDiagnosis(forms: readonly string[]): RegExp[] {
  if (forms.length === 0) return [];
  const B = `(?:${forms.map(esc).join("|")})`;
  return [
    // The construction that actually shipped: a list of competitors, then the agency, negated.
    new RegExp(`\\b(?:not|nowhere near|never|instead of|rather than|over)\\s+${B}\\b`, "i"),
    new RegExp(`${B}\\b[^.!?]{0,20}\\b(?:is ?n'?t|isn't|is not|are ?n'?t|are not|was ?n'?t|was not|does ?n'?t|does not|do ?n'?t|do not|has ?n'?t|has not|never|fails? to)\\b`, "i"),
    new RegExp(`${B}\\b[^.!?]{0,20}\\b(?:is|are|was|were)\\s+(?:invisible|nowhere|absent|missing|unnamed|unranked|behind|losing|last)\\b`, "i"),
    new RegExp(`\\b(?:without|minus|omits?|omitting|excludes?|excluding|skips?|skipping)\\s+${B}\\b`, "i"),
    new RegExp(`${B}\\b[^.!?]{0,24}\\b(?:did ?n'?t|did not)\\s+(?:show|appear|rank|come up|make)`, "i"),
  ];
}


// ── wrong-frame, part A: self-diagnosis ─────────────────────────────────────
//
// Telling a GEO/SEO agency that AI does not name it is telling a dentist he has a cavity. Either he
// knows, and we have insulted him, or he does not, and we have embarrassed him. There is no version
// of this that is the right thing to send, which is why these fire unconditionally rather than
// looking for a redeeming resale clause elsewhere in the message: a message with this grammar in it
// has already made the reader defensive by the time the good clause arrives.
const SELF_DIAGNOSIS: readonly RegExp[] = [
  /\bdoes ?n'?t (name|mention|list|include|surface|recommend) (you|your)\b/i,
  /\b(do|does) not (name|mention|list|include|surface|recommend) (you|your)\b/i,
  /\b(never|not) (names?|mention(s|ed)?|lists?|surfaces?) (you|your (agency|firm|shop|studio))\b/i,
  /\byou('?re| are)? ?n('|o)t (in|on) (there|the list|that list)\b/i,
  /\byou (don'?t|do not|never) (show up|rank|appear|come up|get named|get mentioned|make the list)\b/i,
  /\byour (competitors?|rivals?) (are|is|show|shows|rank|ranks|come up|beat|beats|get named)\b/i,
  /\b(two|three|four|several|other|all) of your competitors\b/i,
  /\byou('?re| are) (behind|losing|missing out|falling behind|invisible|nowhere)\b/i,
  /\byour (agency|firm|shop|studio|site|brand) is (invisible|nowhere|absent|missing)\b/i,
  /\byour (visibility|ranking|rankings|presence|share of voice) is (low|poor|weak|zero|bad|nonexistent)\b/i,
];

// ── wrong-frame, part B: vendor, not leverage ───────────────────────────────
//
// "We will do it for you" makes us their supplier. "It runs under your name" makes us their margin.
// The difference is the entire business model, and it is visible in the preposition.
//
// Tuned on ONE word: `for you`. "We fixed that for two agencies" is a credential and stays legal —
// it is a fact about our past, not an offer to absorb their work. Only the second-person completion
// fires.
const VENDOR_FRAME: readonly RegExp[] = [
  /\b(we|i)(?:'ll| will| can| could)? ?(handle|manage|take care of|run|do|fix|sort|cover) (it|this|that|everything|your [a-z ]{2,24}?) for you\b/i,
  /\blet (us|me) (handle|manage|take care of|run|fix|sort|do) \b/i,
  /\bwe(?:'ll| will)? take (it|this|that|them) off your (plate|hands)\b/i,
  /\boutsourc(e|ing) [^.!?]{0,32}\bto (us|me)\b/i,
  /\bdone[- ]for[- ]you\b/i,
  /\bwe (do|run|handle|manage) (this|it|that|the work) for (agencies|shops|studios|firms)\b/i,
];

// ── explained-premise ───────────────────────────────────────────────────────
//
// The founder's correction, made mechanical: DO NOT EXPLAIN THE VALUE PROPOSITION.
//
// A premise is a claim about the reader's world offered as setup. It fails three ways at once. It
// is unverifiable, so it violates the grounding rule in spirit — we cannot check what their clients
// are asking. It is presumptuous, because they know their business. And it spends the reader's
// attention before the message has shown them anything, which is the definition of a deck slide.
//
// Three families, each second person or market-wide and each stated as fact:

/** Market education. Nobody types "increasingly" in a note to one person. */
const MARKET_EDUCATION: readonly RegExp[] = [
  /\b(more and more|increasingly|these days|nowadays|right now,? more)\b/i,
  /\bas you (probably |may |might |already )?know\b/i,
  /\bthe (industry|market|landscape|game|world) (is|has) (changing|changed|shifting|shifted|moving|moved)\b/i,
  /\b\d+ ?% of (buyers|searches|consumers|people|shoppers|traffic|queries|users)\b/i,
  /\b(ai|chatgpt|llms?|assistants?) (is|are) (the future|taking over|replacing|becoming the|where)\b/i,
  /\bthe way (people|buyers|customers|clients) (search|buy|discover|shop|find)\b/i,
  /\b(search|seo|discovery) is (shifting|moving|changing|dying|dead)\b/i,
  /\bever since (ai|chatgpt|llms)\b/i,
];

/** Claims about THEIR clients. We have never met their clients. */
const CLIENT_PREMISE: readonly RegExp[] = [
  // `the` as well as `your`/`their`: "the client wants to know what those summaries say" is the same
  // claim about somebody we have never met, and swapping the determiner is not a change of meaning.
  //
  // THE VERB LIST IS THE BARE FORMS THAT WERE ALREADY HERE, PLUS THE -S FORMS AND NOTHING ELSE, and
  // that distinction is doing real work. English forms a question with the bare verb — "do your
  // clients ask about this?" — and an assertion with the inflected one — "the client asks about
  // this". Asking is the opposite of asserting and is a legitimate ask; there is a test for it. So
  // `asks` fires and `ask` must not, and adding the bare form breaks the good message.
  /\b(your|their|the) (clients?|customers?|accounts?) (are|is|have|has|keep|keeps|will|want|wants|expect|expects|need|needs|asks|started|starting)\b/i,
  /\b(clients?|customers?) (are|have) (start|starting|started|begun|beginning|asking|demanding|wondering)\b/i,
  /\bevery (client|agency|shop|studio) (is|wants|needs|asks)\b/i,
  // Their STAFF, which is a claim about the inside of a company we have never been in.
  /\bevery (account manager|am|strategist|analyst|marketer|designer|developer|team|person|one of them)\b/i,
  /\ba (studio|agency|shop|firm|practice) (bills|charges|prices|sells|works|runs)\b/i,
];

/** Claims about their capacity. Telling someone what they cannot do is the rudest of the three. */
const CAPACITY_PREMISE: readonly RegExp[] = [
  /\byou (can'?t|cannot|could ?n'?t) (really |possibly |realistically )?(run|do|scale|handle|manage|track|monitor|produce|deliver|keep up|check)\b/i,
  /\byou (don'?t|do not) have (the )?(time|bandwidth|capacity|headcount|hours)\b/i,
  /\bthere(?:'s| is) no way (you|your team)\b/i,
  /\b(too (much|many)|impossible|not feasible|unrealistic) to (do|run|handle|check|track) (it |this |them )?(by hand|manually)\b/i,
  /\b(by hand|manually) (for|across) \d+\b/i,
  /\bdoing (that|this|it) (by hand|manually) (is|takes|costs|means)\b/i,
  /\byou'?d (have to|need to) (do|run|check|track) (it|that|this) (by hand|manually|one by one)\b/i,

  // ── AND THE SAME CLAIM WITH THE "YOU" TAKEN OUT ──────────────────────────
  //
  // Everything above needs a second person, which is the hole `namedDiagnosis` was added to close
  // for the other family. It is open here too, and the proof is in our own source: `whyNotByHand`
  // on the seo-geo wedge reads "an afternoon per client per month across four assistants, which is
  // not billable at the price a client will pay" and passed this linter clean. That sentence is a
  // stranger telling an agency owner what his own hours cost and what his clients will pay, which
  // is the rudest thing in this file, and it does not contain the word "you".
  //
  // A test in test/copy-frame.test.ts asserts every internal wedge field is refused by these rules,
  // so the sharpest examples of the mistake we have written down stay a canary for the gate.
  /\b(not|is ?n'?t|are ?n'?t) (billable|profitable|economic|viable|worth (it|doing|the time|the hours))\b/i,
  /\bat the price (a|the|their|any) (client|customer|account)s? (will|would|can|could) pay\b/i,
  /\b(an?|one|half) (afternoon|day|week|morning|hour)s? (per|a|each) (client|account|site|domain|month)\b/i,
  /\bdoes ?n'?t scale\b/i,
  /\bburns? (an?|half|another) (afternoon|day|morning|hour|week)\b/i,
  /\bno ?body (has|is going to|will) (do|run|check) that (by hand|manually)\b/i,
];

/**
 * The frame pass. Runs inside `lint()` for every channel.
 *
 * Both ids are NEW (`wrong-frame`, `explained-premise`); nothing here reuses or splits an existing
 * rule id, because stored `copy_rejected` events key off those and a rename orphans history.
 *
 * One complaint per family. The rewrite for a second hit is the same as for the first, and a
 * rejection list that repeats itself reads as noise — which is how a linter gets its ceiling raised
 * until it means nothing.
 */
export function lintFrame(text: string, opts: { subject?: readonly string[] } = {}): Violation[] {
  const out: Violation[] = [];

  // Their name where "you" would be. Reported under the SAME rule id — it is the same defect, and a
  // second id would split the `copy_rejected` history of one thing across two names.
  for (const re of namedDiagnosis(subjectForms(opts.subject ?? []))) {
    const hit = text.match(re);
    if (hit) {
      out.push({
        rule: "wrong-frame",
        detail:
          `"${hit[0].trim()}" is a verdict on the agency with their own name in it instead of ` +
          `"you". Naming who the assistants picked INSTEAD of them is the same insult as saying ` +
          "they do not rank. Never say who was named in their place, and never say they were not " +
          "named. Say what the check DID and offer to run it for their client list.",
      });
      break;
    }
  }

  for (const re of SELF_DIAGNOSIS) {
    const hit = text.match(re);
    if (hit) {
      out.push({
        rule: "wrong-frame",
        detail:
          `"${hit[0]}" tells the agency it is failing at its own discipline. They are the ` +
          "professionals; a finding is a SAMPLE of what we would run for their clients, never a " +
          "verdict on them. Show what the tool produced and offer to run their client list.",
      });
      break;
    }
  }

  for (const re of VENDOR_FRAME) {
    const hit = text.match(re);
    if (hit) {
      out.push({
        rule: "wrong-frame",
        detail:
          `"${hit[0]}" positions us as doing their job FOR them, which makes us a cost. It runs ` +
          "WITH them and under their name, and they bill for it. Say it that way or not at all.",
      });
      break;
    }
  }

  for (const [family, patterns] of [
    ["what their market is doing", MARKET_EDUCATION],
    ["what their clients want", CLIENT_PREMISE],
    ["what they are unable to do", CAPACITY_PREMISE],
  ] as const) {
    for (const re of patterns) {
      const hit = text.match(re);
      if (hit) {
        out.push({
          rule: "explained-premise",
          detail:
            `"${hit[0]}" asserts ${family}. They know, and we cannot check it. Do not explain the ` +
            "offer: show the thing that already exists, say in one line what it is, and make the " +
            "offer. Cut the setup entirely.",
        });
        break;
      }
    }
  }

  return out;
}
