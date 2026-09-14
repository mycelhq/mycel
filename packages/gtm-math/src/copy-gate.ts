// CopyGate: the anti-AI linter. Every outbound draft passes through lint() before any port sends
// it — LinkedIn DMs, invite notes, emails, and Reddit comments. The rules encode one taste: short,
// plain, one ask, and none of the phrases that mark a message as machine-written. This one is
// implemented for real; the send ports are stubs.
//
// THERE IS ONLY ONE LINTER. The launch-era outreach stack carried a second copy checker
// (`scripts/lib/outreach-quality.mjs` + `pitchLeak` in `reddit-ops.ts`); its copy rules were folded
// in here rather than run alongside. What did NOT come here are that file's *lead* rules — famous
// hunters, ghost profiles, name collapsing — because those judge a person, not a sentence, and they
// live in `lib/sourcing/producthunt.ts` where they belong.
//
// The channel differences (Reddit replies run longer than a DM and may carry one own-domain link)
// are OPTIONS on this function, not a second gate.

import { lintFrame } from "./copy-frame";
import { lintTells } from "./copy-tells";

export interface Violation {
  rule: string;
  detail: string;
}

// The AI-tell rules live in lib/copy/tells.ts, imported here rather than inlined so this file stays
// the list of rules that predate them and their (much longer) tuning rationale has somewhere to
// live. They run as part of `lint()`; there is still only one linter.
//
// EVERY RULE ID BELOW THIS LINE IS STABLE. Stored `copy_rejected` events key off them, so a rename
// silently orphans history. New rules get new ids; they never reuse or split an old one.

export interface LintOptions {
  /** Word ceiling. A LinkedIn DM is 40; a Reddit reply that reads like a person is ~60. */
  maxWords?: number;
  maxSentenceWords?: number;
  /**
   * Links stop counting as CTAs (a Reddit tool-ask reply may end with one own-domain link).
   * Foreign links are still rejected by `pitch-leak` — this loosens the ask count, not the pitch.
   */
  allowLink?: boolean;
  /**
   * Which host a link is allowed to point at when `allowLink` is set. Anything else is a leak.
   */
  ownDomain?: string;
  /**
   * This message ANSWERS one, rather than opening a conversation.
   *
   * Relaxes only the rules that are about the shape of an unprompted first touch — a triad is a
   * tell in a cold open and ordinary English in a reply. Everything that is about what we may CLAIM
   * (the frame, the resale line, the banned phrases, the invented link) applies identically,
   * because those are wrong to say to anybody at any point in a conversation.
   */
  conversational?: boolean;
  /**
   * Turn off the AI-tell pass (lib/copy/tells.ts). Default is ON for every channel.
   *
   * This exists for ONE case: linting a string a human definitely wrote and definitely meant, where
   * the tell rules would be second-guessing a person rather than catching a machine. No production
   * caller sets it today, and it is not a "the model kept failing" escape hatch — a draft that
   * cannot clear the tells is a draft that reads as generated, and sending it is the loss.
   */
  skipTells?: boolean;
  /**
   * What the recipient's company is called: the CRM name, the brand the audit inferred, anything
   * else they answer to. Used by lib/copy/frame.ts to catch a verdict written in the third person
   * — "not Spilt Media" is the same message as "not you", and without this the linter cannot tell.
   *
   * Optional, and absent is a real loss rather than a neutral default. See the header of frame.ts.
   */
  subject?: readonly string[];
}

export const BANNED_PHRASES: readonly string[] = [
  // The original gate.
  "i hope this email finds you well",
  "delve",
  "leverage",
  "testament",
  "game-changer",
  "game changer",
  "streamline",
  "elevate",
  "cutting-edge",
  "cutting edge",
  "unleash",
  "revolutionize",
  "synergy",
  "circle back",
  "touch base",
  "quick question",
  "i wanted to reach out",
  // Ported from the launch-era outreach stack: phrases its prompts banned outright and its
  // reviewers kept catching by hand.
  "great question",
  "happy to help",
  "hope you are doing well",
  "hope you're doing well",
  "at your earliest convenience",
  "best-in-class",
  "best in class",
  "world-class",
  "world class",
  "seamless",
  "supercharge",
  "empower",
  "move the needle",
  "low-hanging fruit",
  "low hanging fruit",
  "in today's fast-paced",
  "in todays fast-paced",
  "let me know if you have any questions",
];

/**
 * Launch-pitch tells. Ported from `pitchLeak` in the old reddit-ops.ts, generalised to every
 * channel: a message that begs for an upvote or points at a signup form is a broadcast, not a note
 * to a person, and on Reddit specifically it is the fastest way to get the account banned.
 */
const PITCH_LEAKS: readonly { re: RegExp; what: string }[] = [
  { re: /\bwaitlist\b/i, what: "waitlist" },
  { re: /\bsign[- ]?up here\b/i, what: "signup ask" },
  { re: /\bupvote\b/i, what: "upvote ask" },
  { re: /\bproduct\s*hunt\b/i, what: "Product Hunt plug" },
  { re: /\b(dm|pm) me\b|\bshoot me a (dm|pm)\b|\bsend me a (dm|pm)\b/i, what: "DM-me ask" },
  { re: /\b(x\.com|twitter\.com)\b/i, what: "social plug" },
];

/** "You should…" is advice grammar. "What fixed it for me was…" is experience grammar. */
const ADVICE_GRAMMAR: readonly RegExp[] = [
  /\byou should\b/i,
  /\byou need to\b/i,
  /\bthe best way (is|to)\b/i,
  /\bhave you (tried|considered)\b/i,
  /\bwhat you (want|need) (is|to)\b/i,
];

const AI_DISCLOSURE = /\b(as an? (ai|language model)|i am an ai|i'm an ai|as a bot)\b/i;

/**
 * ═══ THE THREE THINGS THAT WERE IN THE MESSAGES PEOPLE OPTED OUT OF ═══
 *
 * 74 emails produced 12 one-click unsubscribes — 16%, against an industry norm under 1%, and the
 * scanner guard in app/u/[token] means every one of those was a person. Reading the twelve, the
 * same three defects run through them, and none of the fifteen rules above caught any of them:
 * message #1 passed this linter completely clean.
 */

/**
 * A model's version string, in a message to a stranger. One draft opened:
 *
 *     "Claude (gpt-5.6-luna) names Hughes Supply, Ferguson and WinWholesale."
 *
 * NOT a ban on naming an assistant. "We put eight buyer questions to ChatGPT" is the finding and
 * the whole product — `\bgpt` cannot match inside "ChatGPT" (no word boundary mid-word) and a bare
 * "Claude" is left alone. What is banned is a FAMILY FOLLOWED BY A VERSION, which is a string that
 * only exists inside our own configuration and reads, to a reader, as machinery left on the table.
 */
const MODEL_IDENTIFIER = /\b(?:gpt|claude|gemini|llama|mistral|sonnet|opus|haiku)[-_][a-z0-9.]*\d/i;

/**
 * Signing off as the company, or as the product, instead of as a person.
 *
 * One message ended "Mycel AI". Cold mail is one human writing to another; a sign-off that names a
 * vendor turns the whole thing into a broadcast retrospectively, on the last line, after the reader
 * has already decided they were reading a note. Only the final short line is inspected, because
 * "Mycel" appearing in the body is ordinary and only the SIGNATURE position makes it a vendor.
 */
const VENDOR_SIGNOFF = /^(mycel(\s*ai)?|the mycel team|team mycel|.*\bteam\b)$/i;

/**
 * ═══ THE PRE-PIVOT BUSINESS, STILL BEING SOLD ═══
 *
 * Four of the twelve opted-out messages offered a thing we stopped selling on 3 September:
 *
 *     "under YLA's logo, billed through monthly reports"
 *     "under AJR's logo and on your invoice"
 *     "The same check runs across a client list under Carrhill's name."
 *     "Want a line you can bill for in client monthly reports, under your logo?"
 *
 * That is the white-label subscription we used to sell, and no longer do. We RUN the work on a
 * retainer and own the outcome — the product brief says so to the drafter, and it shipped on
 * 6 September, AFTER every one of these went out.
 *
 * A prompt is a suggestion and a gate is a guarantee, and this is the single highest-evidence
 * defect in the corpus, so it gets the guarantee. Redraftable: the model is choosing the wrong
 * frame for one message, and a second sample genuinely fixes it.
 *
 * "UNDER their logo", not "WITH their logo". The first attributes the WORK to them, which is the
 * resale claim and is what all four of those messages made. The second describes where a finished
 * deliverable appears — lib/assets/script.ts says it "lands in a portal with your logo on it",
 * which is the current product exactly: we do the work and they sign it off. A rule that cannot
 * tell those apart would refuse an accurate description of what we sell.
 */
const RESALE_FRAME =
  new RegExp(
    [
      // "under your logo", "under AJR's name", "under their own brand"
      "\\bunder (?:your|their|his|her|its|[A-Z][\\w'\u2019]*(?:'s|\u2019s))\\s+(?:own\\s+)?(?:logo|name|brand|banner)\\b",
      "\\bon your invoice\\b",
      "\\bwhite[-\\s]?label(?:led|ed)?\\b",
      // every way the drafter has phrased the margin: "you can bill for it", "for you to bill for",
      // "you bill it", "billed through monthly reports".
      // THE MARGIN CLAIM, IN EVERY INFLECTION IT HAS ACTUALLY ARRIVED IN.
      //
      // Three previews, three spellings, each one a redeploy: "you can bill for" (31 Aug), "for
      // you to bill for" (6 Sept), then "with you billing for the resulting work" — which walked
      // past a rule written that morning to stop it, because `bill\\b` has no boundary before the
      // "i" of billing. The verb is what matters, not the tense somebody reached for.
      "\\b(?:to|can|and|you|for|while|so) bill(?:s|ed|ing)?\\b",
      "\\bbill(?:s|ed|ing)? (?:it )?(?:through|for)\\b",
      "\\bresell\\b",
    ].join("|"),
    "i",
  );

/**
 * "under TJA Strategies" — the same claim with the possessive dropped.
 *
 * Found in a live preview AFTER the first version of the rule above shipped, which is the only
 * reason it is here: the drafter wrote "under TJA Strategies, for you to bill for" and the rule
 * that had just been written to stop exactly that watched it go past.
 *
 * SEPARATE AND CASE-SENSITIVE, and that is the whole point of it being its own regex. Capitalisation
 * is the entire signal — "under Acme Media" is the prospect's brand, "in under two minutes" is the
 * ordinary preposition — and folding this into the case-insensitive list above made the linter
 * refuse "it ran in under two minutes". A flag on the wrong branch is how a good rule starts
 * rejecting true sentences.
 */
const RESALE_ATTRIBUTION = /\bunder [A-Z][\w'\u2019]+(?:\s+[A-Z][\w'\u2019]+)*/;

// Astral-aware: emoji live outside the BMP, plus the dingbat and misc-symbol blocks.
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F0FF}\u{2600}-\u{27BF}\u{FE0F}]/u;
const HASHTAG = /(^|\s)#[A-Za-z][A-Za-z0-9_]{1,}/;

const DEFAULT_MAX_WORDS = 40;
const DEFAULT_MAX_SENTENCE_WORDS = 14;

const countWords = (s: string): number => s.split(/\s+/).filter(Boolean).length;

const LINK_RE = /https?:\/\/\S+|www\.\S+/gi;

/**
 * A QUOTATION IS NOT THE WRITER'S PROSE.
 *
 * The rules below measure rhythm — how long a sentence runs, whether it falls into a list of three,
 * whether every clause is the same length. Every one of them is a test for "did a machine compose
 * this", and every one of them is meaningless applied to words somebody else said.
 *
 * The best sentence the outbound copy has is a quoted buyer question lifted straight out of an
 * audit run: `We put "Which digital marketing agencies are best for generating exclusive leads for
 * HVAC, plumbing, roofing, or electrical companies" to Claude for promotionmg.com.` It is 24 words,
 * it contains a list of three, and it ends in a question mark. Unmasked, it trips
 * `max-14-word-sentences`, `structural-symmetry` AND `one-cta` at once — three rejections for
 * quoting a customer accurately, which is the one thing in the message that proves a person ran
 * something. Two of the first four live drafts died exactly this way.
 *
 * So the rhythm rules and the ask count read the text with quoted spans collapsed to one token.
 * WHAT IS DELIBERATELY NOT MASKED IS LENGTH: `max-40-words` counts the whole message, because a
 * 90-word email is 90 words to read no matter who said them, and an unbounded quote would otherwise
 * be a hole straight through the ceiling.
 *
 * Only double quotes, straight or curly. Single quotes are apostrophes far more often than they are
 * quotations, and masking from "don't" to the next apostrophe would eat half a message.
 */
const QUOTED_SPAN = /["\u201c][^"\u201d\n]{0,400}["\u201d]/g;

export const maskQuotes = (text: string): string => text.replace(QUOTED_SPAN, '"q"');

/** A house number and a street word, or a state-and-ZIP tail, or a UK postcode. See the caller. */
const STREET_ADDRESS =
  /\b\d{1,6}[a-z]?\s+[A-Z][\w'-]*(\s+[\w'-]+){0,4}\s+(st|street|ave|avenue|rd|road|dr|drive|blvd|boulevard|ln|lane|ct|court|pl|place|hwy|highway|pkwy|parkway)\b|,\s*[A-Z]{2}\s+\d{5}(-\d{4})?\b|\b(suite|ste\.?|unit)\s+\d+[a-z]?\b/i;

/** Links + CTAs. A URL is a CTA; so is a question or an imperative booking ask. Max one total. */
function countCtas(text: string, allowLink: boolean): number {
  const links = allowLink ? [] : (text.match(LINK_RE) ?? []);
  // A question mark inside a quotation belongs to the person being quoted. It is not an ask.
  const questions = maskQuotes(text).match(/\?/g) ?? [];
  return links.length + questions.length;
}

export function lint(draft: string, opts: LintOptions = {}): Violation[] {
  const violations: Violation[] = [];
  const text = draft.trim();
  const lower = text.toLowerCase();
  const maxWords = opts.maxWords ?? DEFAULT_MAX_WORDS;
  const maxSentenceWords = opts.maxSentenceWords ?? DEFAULT_MAX_SENTENCE_WORDS;

  if (text.includes("—") || text.includes("–")) {
    violations.push({ rule: "no-em-dash", detail: "em/en dashes read as machine-written; use a period" });
  }

  /**
   * NOBODY RENDERS THIS. The message is plain text in a mail client.
   *
   * A draft cleared every rule here on 7 September opening "Wrote you a **Small-business growth
   * marketing guide** from your site" — the model formatting the deliverable's title the way it
   * formats everything, and the recipient seeing the asterisks. The gate had no opinion about
   * markdown at all, so the only thing between that and a prospect was luck.
   *
   * It is the same defect the work-sample page had, where the model's markdown reached the page as
   * literal characters and the founder's verdict was "we don't render markdown". Fixed there by
   * taking typed blocks instead of a string; fixed here by refusing the syntax, because an email
   * body has no renderer to fix it in.
   *
   * Bare `*` is deliberately not matched: a single asterisk is rare in prose and banning it would
   * refuse a real sentence to catch a mistake nobody has made.
   */
  const md = text.match(/\*\*[^*\n]+\*\*|__[^_\n]+__|\[[^\]\n]+\]\([^)\n]+\)|`[^`\n]+`|^#{1,6}\s/m);
  if (md) {
    violations.push({
      rule: "markdown-syntax",
      detail: `"${md[0].slice(0, 40)}" is markdown, and a mail client renders none of it — the reader sees the characters`,
    });
  }

  // NO STREET ADDRESSES. A live draft opened "We ran one against 21484 East 39th Street South,
  // Broken Arrow, OK 74014" — the model had the prospect's postal address in its facts and treated
  // it as the thing we audited. Even used correctly, quoting a stranger's address does not read as
  // research; it reads as surveillance, and it is the fastest way to be reported rather than
  // ignored. Fixed at source in lib/copy/grounding.ts too; this is the backstop, because there is
  // no message where this is the right thing to send.
  //
  // Safe against our own CAN-SPAM footer: lib/email/port.ts lints the BODY ONLY, and the postal
  // address required by §7704(a)(5) is added by the compliance builder afterwards.
  const postal = STREET_ADDRESS.exec(text);
  if (postal) {
    violations.push({
      rule: "no-postal-address",
      detail: `"${postal[0].trim()}" is a street address. Never put one in a message — it reads as surveillance, not research.`,
    });
  }

  const words = countWords(text);
  if (words > maxWords) {
    // Rule id is stable at the DM default even when a channel raises the ceiling: it is what the
    // retry prompt and every stored `copy_rejected` event key off.
    violations.push({ rule: "max-40-words", detail: `${words} words; the ceiling is ${maxWords}` });
  }

  const ctas = countCtas(text, Boolean(opts.allowLink));
  if (ctas > 1) {
    violations.push({ rule: "one-cta", detail: `${ctas} CTAs/links; one ask per message` });
  }

  if (/^\s*([-*•]|\d+[.)])\s+/m.test(text)) {
    violations.push({ rule: "no-bullets", detail: "bullet lists do not belong in a first touch" });
  }

  for (const phrase of BANNED_PHRASES) {
    if (lower.includes(phrase)) {
      violations.push({ rule: "banned-phrase", detail: `"${phrase}"` });
    }
  }

  for (const { re, what } of PITCH_LEAKS) {
    if (re.test(text)) {
      violations.push({ rule: "pitch-leak", detail: `${what} — this is a note to a person, not a broadcast` });
    }
  }

  // A foreign link is a leak even when links are allowed: "one link to our own domain" is the
  // whole permission, and pasting someone else's URL is either a citation dump or a pitch.
  if (opts.allowLink) {
    const foreign = (text.match(LINK_RE) ?? []).filter(
      (u) => !opts.ownDomain || !u.toLowerCase().includes(opts.ownDomain.toLowerCase()),
    );
    if (foreign.length > 0) {
      violations.push({ rule: "pitch-leak", detail: `link to ${foreign[0]} is not our own domain` });
    }
    if ((text.match(LINK_RE) ?? []).length > 1) {
      violations.push({ rule: "one-cta", detail: "more than one link; one is the whole allowance" });
    }
  }

  if (EMOJI.test(text)) {
    violations.push({ rule: "no-emoji", detail: "emoji read as brand voice, not a person typing" });
  }

  if (HASHTAG.test(text)) {
    violations.push({ rule: "no-hashtag", detail: "hashtags belong to marketing accounts" });
  }

  if (AI_DISCLOSURE.test(text)) {
    violations.push({ rule: "no-ai-disclosure", detail: "never announce the machine; write as the founder" });
  }

  const model = text.match(MODEL_IDENTIFIER);
  if (model) {
    violations.push({
      rule: "model-identifier",
      detail: `"${model[0]}" is a model version string — it exists only in our config and reads as machinery`,
    });
  }

  const lines = text.split(/\n/).map((l) => l.trim()).filter(Boolean);
  const signoff = lines[lines.length - 1] ?? "";
  if (lines.length > 1 && signoff.split(/\s+/).length <= 4 && VENDOR_SIGNOFF.test(signoff)) {
    violations.push({
      rule: "vendor-signature",
      detail: `signs off "${signoff}" — a person wrote this, so a person signs it`,
    });
  }

  const resale = text.match(RESALE_FRAME) ?? text.match(RESALE_ATTRIBUTION);
  if (resale) {
    violations.push({
      rule: "resale-frame",
      detail:
        `"${resale[0]}" sells the white-label line we stopped selling on 3 September. ` +
        "We run the work on a retainer and own the outcome; nothing goes out under their name.",
    });
  }

  for (const re of ADVICE_GRAMMAR) {
    const hit = text.match(re);
    if (hit) {
      violations.push({
        rule: "no-advice-grammar",
        detail: `"${hit[0]}" — use experience grammar ("what fixed it for me was…")`,
      });
      break; // one complaint is enough; the rewrite is the same either way
    }
  }

  /**
   * ═══ THE FIRST SENTENCE IS ABOUT THEM, OR IT IS ABOUT US ═══
   *
   * Measured over every email this system has sent: since 2 September, between a third and
   * two-thirds of them open with "We put…", and NOT ONE has ever opened with the reader. Sep 2:
   * 10 of 15. Sep 3: 8 of 15. Sep 4: 5 of 15. Zero reader-first, on every day.
   *
   * That is the oldest rule in cold email and the easiest to lose, because the grounded fact we
   * are proudest of is a thing WE DID — we ran the check — and the natural way to report an action
   * is to name its actor. So the drafter reaches for "We put eight buyer questions to ChatGPT for
   * LayerLogix", which is true, specific, checkable, and still spends the one line they are certain
   * to read on our activity instead of their situation.
   *
   * The same fact survives the flip intact: "LayerLogix, and 7 buyer questions, put to ChatGPT:
   * <link>". Nothing is lost but the actor, and the actor was never the interesting part.
   *
   * A RHYTHM COMPLAINT, NOT A REFUSAL. This is in REDRAFTABLE (lib/engine/tick.ts), so it costs a
   * redraft rather than the prospect — `draftCopy` samples at temperature and a second attempt is
   * a genuinely different sentence. It is exactly the class `max-14-word-sentences` is in: the
   * model failed, not the person.
   *
   * Only the FIRST sentence, and only after the greeting. "We" later in the message is ordinary
   * English and banning it outright would produce contortions worse than the problem.
   */
  const firstSentence = text
    .replace(/^\s*(hi|hey|hello)\b[^\n]*\n+/i, "")
    .split(/(?<=[.!?])\s+|\n+/)[0]
    ?.trim() ?? "";
  if (/^(we|our|i|i'm|i've|my)\b/i.test(firstSentence)) {
    violations.push({
      rule: "reader-first",
      detail:
        `opens "${firstSentence.split(/\s+/).slice(0, 4).join(" ")}…" — the first line is the one ` +
        "line they are certain to read, and it is about us. Lead with them or with the fact itself.",
    });
  }

  const sentences = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const sentence of sentences) {
    const n = countWords(maskQuotes(sentence));
    if (n > maxSentenceWords) {
      violations.push({
        rule: "max-14-word-sentences",
        detail: `${n} words: "${sentence.slice(0, 60)}${sentence.length > 60 ? "…" : ""}"`,
      });
    }
  }

  // The tell pass runs last, so the cheap structural complaints (too long, two CTAs) come first in
  // the list a human reads and in the retry prompt the model reads.
  if (!opts.skipTells) {
    violations.push(...lintTells(maskQuotes(text), { maxWords, conversational: opts.conversational }));
  }

  // The FRAME pass (lib/copy/frame.ts) is NOT behind `skipTells`, and that is deliberate. `skipTells`
  // exists for text a human definitely wrote and definitely meant, where second-guessing their
  // prose is the wrong move. Frame is not prose: `wrong-frame` and `explained-premise` catch a
  // message that insults the recipient's profession or explains their own business to them, and a
  // human writing that by hand is making the same mistake a model does. There is no channel on
  // which it is right, so there is no option to turn it off.
  violations.push(...lintFrame(text, { subject: opts.subject }));

  return violations;
}
