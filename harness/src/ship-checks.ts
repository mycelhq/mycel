// Was the work RIGHT — not merely finished, and not merely non-empty.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// THE RUNG ABOVE `ship_requires`
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// There are three gates on a piece of work today and they answer three different questions:
//
//   · `output_schema` + `strict_output` — is it the right SHAPE. A schema-valid object.
//   · `ship_requires` + `missingSubstance` — do the fields that matter carry ANYTHING. Non-empty.
//   · this file                          — do the fields AGREE WITH EACH OTHER.
//
// Everything before this passes on output that is confidently wrong. `missingSubstance` accepts
// `client_summary: "We analysed your visibility."` because the string is non-empty. It accepts a
// monthly close that reports `reconciled: true` alongside `difference_cents: 4200`, which is a
// bookkeeper telling a client their books balance while carrying a forty-two pound hole. It accepts
// an invoice whose `total_minor` does not equal the sum of its own `lines` — a wrong number, in the
// firm's name, in a document the client pays from.
//
// `PLATFORM.md` §6 names this exactly: "our runs prove they finished; they mostly do not prove they
// were right. That is the frontier everyone serious is working on, and it is what would let the
// approval gates lift faster." That last clause is the commercial argument. Selective auto-release
// is bounded by how much we can prove without a human, and today we can prove almost nothing.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// WHY A CLOSED SET, AND NOT A SCRIPT
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// `product-builder` verifies with a shell script, which is right for it: the thing being checked is
// a running application, the check is arbitrary, and it executes inside a disposable sandbox that
// already holds the agent.
//
// None of that is true here. These checks run in the KERNEL, against JSON, on the founder's own
// process — so arbitrary code from a manifest would be arbitrary code in the control plane, which is
// the line `vision.md` draws in its own words: "The agent may not author, patch, or hot-swap
// executable logic on a live path."
//
// So the set is closed and small. Each member exists because a real task type in this repo has a
// pair of fields that can contradict each other, and each is stated as arithmetic rather than as
// judgement — no model, no ambiguity, and the same answer every time it runs.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// A FAILED CHECK IS NOT A FAILED RUN
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// It is a refusal to SHIP, which is a different thing and a much cheaper one. The work exists, the
// founder can read it, and what changes is that it does not go to a client unreviewed and it does
// not count toward a track record. That ordering matters: a check that fails a whole run turns one
// bad number into thirty minutes of lost work, and the second time that happens somebody deletes
// the check.

/** The closed set. Adding a member is a deliberate act; there is no escape hatch to arbitrary code. */
export type ShipCheck =
  /**
   * A boolean field must agree with a number being zero.
   *
   * `books-keeper/monthly_close` is why this exists: `reconciled: true` with
   * `difference_cents: 4200` satisfies the schema, satisfies `ship_requires`, and is a bookkeeper
   * telling a client the books balance while holding a hole. The manifest's own description of the
   * field says "A close that balances because something was forced is worse than an open one" — this
   * is that sentence, made checkable.
   */
  | { kind: "agrees"; flag: string; zero_when_true: string }
  /**
   * A total must equal the sum of the lines it claims to total.
   *
   * `contract-desk/prepare_invoice` emits `lines[].charge_minor` and `total_minor`. A mismatch is a
   * wrong figure in a document a client pays from, and it is the highest-stakes arithmetic error the
   * product can make. Integer minor units throughout, so the comparison is exact and there is no
   * tolerance to argue about.
   */
  | { kind: "sums_to"; items: string; each: string; total: string }
  /**
   * A figure must not be stated when the run has said it cannot be established.
   *
   * ═══ THE COMPLAINT THAT COMES FIRST, EVERY TIME ═══
   *
   * A client reading the August close: "They simultaneously show £1,640.00 as net due in the
   * sales-tax summary and say input VAT is unquantified and the net VAT due is not established in
   * their own VAT working paper. Those positions cannot both be used to tell me what I owe."
   *
   * They are right, and this is the worst thing the product can do. Everything else the client
   * disliked was a gap; this one is the document telling them a number to pay while also saying it
   * does not know the number. A gap costs a follow-up email. This costs the relationship, and if
   * they act on it, money.
   *
   * `field` is the figure; `unknown_when` is the flag that says it cannot be known. `sales_tax.net_due`
   * with `sales_tax.input_tax_unquantified` is the case it was written for, but nothing here is
   * about tax: a lift percentage beside "the baseline could not be measured", a delivery date beside
   * "the dependency is unresolved", the same shape and the same damage.
   */
  | { kind: "not_when"; field: string; unknown_when: string }
  /**
   * A stated count must equal the list it counts.
   *
   * "The work calls for confirmation of four review items, but the ledger contains five lines marked
   * owner confirmation required" — a client, reading a close, having counted. Two numbers about the
   * same thing that disagree do not cost them the four they can see; they cost the credibility of
   * every other number in the document, because now the client is auditing rather than reading.
   *
   * Faults when the list has entries and the number is absent, too: a total that is simply missing
   * is the same failure with the discrepancy hidden.
   */
  | { kind: "counts"; items: string; field: string }
  /**
   * One figure must equal another minus a third. The identity at the bottom of every P&L.
   *
   * `sums_to` checks a total against a LIST, and the most consequential arithmetic in a close is not
   * a list: profit is revenue minus expenses, three declared fields, and nothing compared them. A
   * close reported `revenue 8,200.00`, `expenses 4,129.39` and `net 3,730.61` — the first two imply
   * 4,070.61 — and then quoted 4,070.61 in the covering note and 3,730.61 in the attached P&L. The
   * client had to find it: "I should not have to identify and resolve a £340.00 contradiction in a
   * paid month-end close, or choose between two different profits."
   *
   * Nothing about it is bookkeeping. An invoice total less a discount equals the amount due; gross
   * less tax equals net; a budget less spend equals what is left. Wherever a document states all
   * three, the third is checkable and someone will eventually pay for it not being checked.
   */
  | { kind: "nets_to"; minuend: string; subtrahend: string; total: string }
  /**
   * A stated PERCENTAGE must equal the two numbers it is a percentage of.
   *
   * ═══ THE THIRD SHAPE OF THE SAME BETRAYAL ═══
   *
   * `sums_to` catches a total that disagrees with its lines. `nets_to` catches a bottom line that
   * disagrees with the two figures above it. Neither catches the most common number in a service
   * business report, which is a RATE: share of voice, conversion, utilisation, margin, on-time
   * delivery. Every one of them is a percentage printed beside the two counts it came from.
   *
   * geo-monitor's `weekly_report` is the live example, and it is the flagship deliverable. It states
   * `share_of_voice_pct`, `mentions` and `queries`, all three carried by hand out of a pack that
   * computed them together. Nothing compared them. "Share of voice 60%" beside "mentioned in 2 of 8"
   * satisfies the schema, satisfies `ship_requires`, and is 25% — and the client can do that division
   * in their head faster than they can read the sentence around it.
   *
   * ═══ WHY THERE IS A TOLERANCE HERE AND NOWHERE ELSE ═══
   *
   * `sums_to` is exact because money is integer minor units. A percentage is not: 2/3 is 66.7 to one
   * decimal and 66.67 to two, and both are honest. `TOLERANCE_PCT` is a tenth of a point — wide
   * enough that rounding never fails, far too narrow for a number somebody made up.
   *
   * A zero denominator is not a violation. Nought out of nought is not a percentage anybody should
   * state, and it is `not_when`'s job to say so — a check that reported "0% is wrong" would be
   * arguing with a run that correctly has nothing to report.
   */
  | { kind: "ratio_of"; numerator: string; denominator: string; pct: string }
  /**
   * A figure printed in prose without converting out of minor units.
   *
   * ═══ A HUNDREDFOLD ERROR IN A DOCUMENT ABOUT MONEY ═══
   *
   * The covering note said "total payments of £4,469.39 include £34,000.00 in suspense". The suspense
   * item is `-34000` minor units — £340.00. The client did the only arithmetic available: "£34,000.00
   * already exceeds the stated total by £29,530.61. A £33,660.00 mistake in a short client summary
   * damages confidence in the rest of the work."
   *
   * Every money field in this system is `_minor`, and every sentence a client reads is major. That
   * conversion happens in prose, by a model, once per figure, and getting it wrong by 100× is the
   * worst arithmetic error the product can make — larger than a wrong number, because it is a wrong
   * number that looks deliberate.
   *
   * It is also exactly checkable, with no fuzziness. Take a figure P from the prose. If P × 100
   * appears among the output's numbers, P was converted correctly. If P × 100 does NOT appear and P
   * itself DOES — as an integer, in a field the schema holds in minor units — then the model copied
   * the minor value into the sentence. That is the whole test, and it does not fire on a figure the
   * output never held.
   */
  | { kind: "minor_units"; field: string }
  /**
   * The tells that mark a sentence as machine-written — SHAPE, not vocabulary.
   *
   * `forbids` catches the easy half, and a model told not to say "leverage" says "utilise" and
   * produces the same empty sentence. What actually gives machine writing away is structure:
   * sentences all the same length, three parallel items, "not only X but also Y", a summary of
   * something too short to need one, two hedges in a row, a closing question that asks for nothing
   * answerable. None of those is a word.
   *
   * `social: true` loosens what only applies to a short direct message — an article may legitimately
   * summarise itself — and tightens the two that only exist in a feed: stacked one-line paragraphs,
   * and emoji used as bullets.
   *
   * See tells.ts, ported from the founder-side linter every outbound draft already passes through.
   */
  | { kind: "no_tells"; field: string; social?: boolean }
  /**
   * A list has to have something in it.
   *
   * `missingSubstance` accepts an array with one empty-ish element. `STANDARD.md` §6 asks GEO for a
   * scorecard "plus three sized recommendations"; a report with none is the screenshot that section
   * exists to forbid.
   */
  | { kind: "min_items"; field: string; n: number }
  /**
   * A prose field has to be long enough to be advice.
   *
   * The failure this catches is the refusal wearing a deliverable's clothes — `STANDARD.md` §2 lists
   * it as a metric with a target of zero. "We analysed your visibility." is eight words, passes every
   * other gate, and is the single most common way an agent reports success having said nothing.
   *
   * A word count is a crude proxy and it is deliberately crude: anything cleverer needs a model,
   * and a model in this path would make the gate probabilistic — which is the property it exists
   * not to have.
   */
  | { kind: "min_words"; field: string; n: number }
  /**
   * A prose field must not be longer than a person will read.
   *
   * The other end of `min_words`, and the failure is different in kind rather than in degree: a
   * short summary says nothing, a 900-word one says everything and is therefore not a summary. Both
   * end with a client not knowing what to do, which is the only outcome the deliverable is judged on.
   */
  | { kind: "max_words"; field: string; n: number }
  /**
   * Every entry in a list carries the field that makes it worth having.
   *
   * `missingSubstance` accepts an array whose FIRST element has substance. This is per-item, and it
   * is the difference between "there are three recommendations" and "there are three
   * recommendations you can act on" — the shape a model reliably produces under pressure is one good
   * entry followed by two that satisfy the schema.
   */
  | { kind: "each_has"; items: string; field: string }
  /**
   * The list has to COVER something, not repeat itself.
   *
   * `STANDARD.md` §6 on GEO, verbatim: "A scorecard plus three sized recommendations — one Small (an
   * edit to an existing page, hours), one Medium (a new page in a citation-earning genre, a day or
   * two), one Large (original data, weeks). Lead with the Small." Three recommendations that are all
   * Large is a quarter of work nobody starts on Friday, and it satisfies `min_items` perfectly.
   *
   * Stated as distinct values rather than as named ones, so the check knows nothing about what
   * "small" means — the wedge's own schema enumerates the values and this only asks for a spread.
   */
  | { kind: "spread"; items: string; field: string; distinct: number }
  /**
   * The words that make a client stop believing the firm wrote this.
   *
   * ═══ WHY NAMED VOCABULARIES AND NOT A LIST PER WEDGE ═══
   *
   * This taste already exists in this repo THREE TIMES and nowhere a customer's deliverable can
   * reach it: `growth/lib/copy-gate.ts` (the founder's own outbound, well tuned, forty phrases),
   * `growth/lib/copy/tells.ts` (the AI-tell pass), and a `BAN=` regex buried in `product-builder`'s
   * shell verify. So the craft that protects OUR outreach has never protected a customer's work.
   *
   * A per-wedge list would make every trade author reinvent it badly. A named vocabulary hands them
   * the accumulated taste, and `extra` lets a trade add its own without forking the shared one.
   *
   * ═══ WHY IT IS OPT-IN PER FIELD ═══
   *
   * "Leverage" is marketing slop in a homepage and an ordinary word in a bookkeeping note about a
   * leverage ratio. There is no vocabulary that is right for every field, so the wedge author says
   * which fields are prose-for-a-client and which are working records.
   */
  | { kind: "forbids"; field: string; vocabulary: ForbiddenVocabulary; extra?: string[] };

/** The shared vocabularies. Adding one is a deliberate act; a wedge cannot invent a name. */
import { lintTells } from "./tells";

export type ForbiddenVocabulary = "brand_poetry" | "placeholder";

/**
 * Marketing language that says nothing — the register a model reaches for when it has no facts.
 *
 * Seeded from `product-builder`'s own verify, which was written against a real failure: a build
 * shipped a site whose services were "Direction", "Identity", "Experience" under the headline "Make
 * the next move feel inevitable", and its note says what is wrong with that better than a rule can —
 * "which tells a visitor nothing about what this business actually does for them."
 */
const BRAND_POETRY = [
  "inevitable", "seamless", "cutting-edge", "cutting edge", "world-class", "world class",
  "best-in-class", "best in class", "passionate", "we believe", "elevate your", "unlock your",
  "transform your", "reimagine", "bespoke journey", "holistic approach", "synergy",
  "next-level", "game-chang", "supercharge", "empower", "move the needle", "revolutionize",
  "revolutionise", "unleash", "streamline", "leverage", "delve", "low-hanging fruit",
  "in today's fast-paced", "state-of-the-art", "one-stop shop", "tailored solutions",
];

/**
 * The tells of work that was never finished.
 *
 * Different in kind from the list above and much more serious: brand poetry is bad writing, and a
 * placeholder is a draft that reached a client. `.example` domains resolve nowhere, so every link
 * built on one is dead on the live site — `product-builder`'s verify learned that one the hard way.
 */
const PLACEHOLDER = [
  "lorem ipsum", "tbd", "to be determined", "[insert", "{{", "xxx-xxx", "todo:",
  "placeholder", "example.com", ".example", "your company name", "client name here",
  "coming soon", "under construction",
];

/**
 * ═══ UNRESOLVED SLOTS — the pattern the literal list above could never catch ═══
 *
 * The list is substrings, and it holds `"[insert"`. The failure that actually reached a real eval
 * was `[amount]`, `[due date]`, `[invoice number]`, `[payment link]` — a chase message the judge
 * scored BELOW BAR with the note "the placeholders need to be replaced with actual data before
 * sending." Not one of those contains a listed phrase, so the gate passed it. The prose was
 * send-quality; the DATA was never bound; and a founder cannot send it.
 *
 * A slot is a bracket holding a short field-ish name — the shape a model emits when it is writing
 * around a value it does not have. Deliberately narrow, because square brackets have honest uses in
 * client prose:
 *   · citations — `[1]`, `[12]`: digits only, allowed.
 *   · editorial — `[sic]`, `[emphasis added]`: allowlisted below.
 *   · quoted insertion — `the client [Acme Ltd] said`: Capitalised, so it reads as a real name.
 * What is refused is a lowercase, short, unpunctuated noun phrase — `[amount]`, `[client name]` —
 * which is never something a person typed on purpose into a message they were about to send.
 *
 * Also caught: the template syntaxes a model reaches for when it half-remembers being a mail merge.
 */
const SLOT_ALLOW = new Set(["sic", "emphasis added", "verbatim", "translated", "redacted", "cont", "cont.", "…", "..."]);

export function unresolvedSlots(text: string): string[] {
  const hits: string[] = [];
  const push = (m: string) => { if (!hits.includes(m) && hits.length < 8) hits.push(m); };

  // `[field name]` — the dominant shape.
  for (const m of text.matchAll(/\[([^\]\n]{1,40})\]/g)) {
    const inner = m[1]!.trim();
    if (!inner) continue;
    if (/^\d+$/.test(inner)) continue;                       // a citation
    if (SLOT_ALLOW.has(inner.toLowerCase())) continue;        // editorial convention
    if (/[.!?,;:]$/.test(inner)) continue;                    // a real clause, not a slot
    const parts = inner.split(/\s+/);
    if (parts.length > 4) continue;                           // prose in brackets, not a field name
    if (/[A-Z]/.test(inner.replace(/^[A-Z]/, ""))) continue;  // inner caps → a proper noun
    if (/^[A-Z]/.test(inner) && parts.length > 1) continue;   // "Acme Ltd" → a real name
    push(m[0]!);
  }
  // Mail-merge syntaxes: {{x}}, {x}, <x>, %x%, $VAR, and the typed blank ____.
  for (const re of [/\{\{[^}\n]{1,40}\}\}/g, /\{[a-z_][a-z0-9_ .]{0,38}\}/gi,
                    /<[a-z_][a-z0-9_ ]{1,30}>/gi, /%[A-Za-z_][A-Za-z0-9_]{1,28}%/g,
                    /\$\{[^}\n]{1,40}\}/g, /_{3,}/g]) {
    for (const m of text.matchAll(re)) push(m[0]!);
  }
  return hits;
}

const VOCABULARIES: Record<ForbiddenVocabulary, readonly string[]> = {
  brand_poetry: BRAND_POETRY,
  placeholder: PLACEHOLDER,
};

/** A name the kernel knows. A manifest cannot invent a vocabulary — see the note on the kind. */
export const isVocabulary = (v: unknown): v is ForbiddenVocabulary =>
  typeof v === "string" && Object.prototype.hasOwnProperty.call(VOCABULARIES, v);

/** Exported so a console can show a founder what a trade is being held to. */
export const forbiddenPhrases = (v: ForbiddenVocabulary): readonly string[] => VOCABULARIES[v] ?? [];

/**
 * ═══ THE SAME TASTE, TOLD TO THE AGENT BEFORE IT WRITES ═══
 *
 * These lists have only ever been a GATE: the run finishes, the words are found, the work is held,
 * and the founder waits while it is written again. That is a linter, and a linter is the wrong shape
 * for this problem twice over — it pays the full cost of the bad draft before rejecting it, and it
 * teaches the model nothing, because the model never sees the rule.
 *
 * A separate "now check your writing" pass was the obvious alternative and is worse: it is another
 * turn, another minute, and another chance to rewrite something that was fine. The cheapest place to
 * not produce slop is before producing it.
 *
 * So the rules are rendered into the prompt from THESE CONSTANTS. One source, two consumers — the
 * gate that catches it and the instruction that prevents it cannot drift apart, which they would
 * within a month if the prompt held its own copy of the list.
 *
 * THE BAN LIST IS THE SMALLER HALF. A model told only what not to say writes evasively: it swaps
 * "leverage" for "utilise" and produces the same empty sentence. The positive rules below are what
 * actually move the writing, and they are ordered that way on purpose.
 */
export function antiSlopRules(): string[] {
  return [
    "## How to write",
    "",
    "You are writing as a professional in this trade, to a client who is paying for it. Not as an",
    "assistant, and not as a brand.",
    "",
    "**Say the thing.** Lead with what happened, what it means, and what to do. A sentence that",
    "could open any document about anything is a wasted sentence — delete it and start at the",
    "second one.",
    "",
    "**Be specific or say you cannot be.** A number, a name, a date, a page. Where you do not have",
    "one, write that you do not have one. \"Several improvements were identified\" is a way of",
    "saying nothing that reads like saying something.",
    "",
    "**Recommendations name the work.** Not \"optimise your content strategy\" but the page, the",
    "change, and roughly how long it takes.",
    "",
    "**Short words. Ordinary ones.** If you would not say it to the client across a table, do not",
    "write it. No throat-clearing, no summarising what you are about to say before you say it, and",
    "no closing paragraph that repeats the opening.",
    "",
    "**Never claim you did something you did not do.** This is the one that ends a relationship.",
    "",
    "Do not use these words and phrases. They are how a reader knows a machine wrote it, and the",
    "output is checked against this exact list before it can reach anybody:",
    "",
    `${BRAND_POETRY.map((p) => `"${p}"`).join(", ")}.`,
    "",
    "And never ship a placeholder — a document containing any of these is unfinished, not draft:",
    "",
    `${PLACEHOLDER.map((p) => `"${p}"`).join(", ")}.`,
  ];
}

export interface ShipFault {
  /** The check that failed, for a log. */
  kind: ShipCheck["kind"];
  /** A sentence a FOUNDER can act on. Never a field path on its own. */
  message: string;
}

/**
 * Read a field, which may be nested — `profit_and_loss.net_minor`.
 *
 * Checks used to read `at(parsed, c.field)` flat. That is fine while every output is one level deep and
 * silently wrong the moment one is not: a manifest naming `profit_and_loss.net_minor` resolves to
 * `undefined`, the check finds nothing to compare, and the gate PASSES. A gate that passes because
 * it could not find its subject is worse than no gate — it reports the work as checked.
 *
 * This repo has paid for that once already: an `each_has` pointed at a string array did nothing, and
 * the test that caught it said "a typo here silently disables the gate".
 */
function at(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const words = (v: unknown): number => (typeof v === "string" ? v.trim().split(/\s+/).filter(Boolean).length : 0);

/**
 * Run the declared checks against one run's parsed output.
 *
 * Returns the faults, newest concern first, or an empty array. NEVER throws: this sits on the path
 * between a finished run and a founder's screen, and an exception here would turn "the number is
 * wrong" into "the run crashed", which is a worse and much more confusing failure.
 *
 * A check whose fields are ABSENT passes. That is deliberate and it is the division of labour:
 * whether a field must exist at all is `output_schema`'s question and `ship_requires`'s question,
 * both of which run first. This one is only ever about fields that are present disagreeing.
 */
export function shipFaults(
  parsed: Record<string, unknown> | null,
  checks: readonly ShipCheck[] | undefined,
): ShipFault[] {
  if (!parsed || !checks?.length) return [];
  const out: ShipFault[] = [];

  for (const c of checks) {
    try {
      if (c.kind === "no_tells") {
        const text = at(parsed, c.field);
        if (typeof text === "string" && text.trim()) {
          const tells = lintTells(text, { social: c.social });
          if (tells.length) {
            out.push({
              kind: c.kind,
              // Every one, not the first. The orchestrator hands these back for repair, and fixing a
              // shape one tell at a time across three rounds is how a repair loop burns its budget
              // without finishing — the same reason the arithmetic faults are all reported at once.
              message: `"${c.field}" reads as machine-written: ${tells.map((t) => t.detail).join("; ")}.`,
            });
          }
        }
      }

      if (c.kind === "minor_units") {
        const text = at(parsed, c.field);
        if (typeof text === "string" && text.trim()) {
          // Every number the output holds, at any depth. The comparison set for both directions.
          const held = new Set<number>();
          const walk = (v: unknown, depth = 0): void => {
            if (depth > 8) return;
            if (typeof v === "number" && Number.isFinite(v)) held.add(v);
            else if (Array.isArray(v)) for (const x of v) walk(x, depth + 1);
            else if (v && typeof v === "object") for (const x of Object.values(v)) walk(x, depth + 1);
          };
          walk(parsed);
          const bad: string[] = [];
          // A currency figure: a symbol or code, then digits with optional thousands separators and
          // exactly two decimals. Two decimals matter — it is what makes it a money amount rather
          // than a count, a year or a percentage.
          const re = /(?:[£$€]|\b(?:GBP|USD|EUR)\s*)(\d{1,3}(?:,\d{3})*|\d+)\.(\d{2})\b/g;
          for (const m of text.matchAll(re)) {
            const major = Number(`${m[1]!.replace(/,/g, "")}.${m[2]}`);
            if (!Number.isFinite(major)) continue;
            const asMinor = Math.round(major * 100);
            // Correctly converted: the output holds this figure in minor units.
            if (held.has(asMinor) || held.has(-asMinor)) continue;
            // Not converted: the output holds the PROSE number itself as minor units. Whole pounds
            // only — a figure with real pence cannot be a minor-unit integer that was copied.
            if (Number.isInteger(major) && (held.has(major) || held.has(-major))) {
              bad.push(`${m[0]} (the output holds ${major}, which is ${(major / 100).toFixed(2)})`);
            }
          }
          if (bad.length) {
            out.push({
              kind: c.kind,
              message:
                `"${c.field}" prints ${bad.length === 1 ? "a figure" : "figures"} straight out of minor ` +
                `units: ${bad.slice(0, 3).join("; ")}. Divide by 100 before it goes in a sentence — a ` +
                `hundredfold error in a document about money reads as deliberate.`,
            });
          }
        }
      }

      if (c.kind === "nets_to") {
        const a = num(at(parsed, c.minuend));
        const b = num(at(parsed, c.subtrahend));
        const t = num(at(parsed, c.total));
        if (a !== undefined && b !== undefined && t !== undefined && a - b !== t) {
          out.push({
            kind: c.kind,
            message:
              `\`${c.total}\` says ${t}, and \`${c.minuend}\` minus \`${c.subtrahend}\` is ` +
              `${a} - ${b} = ${a - b}. Set \`${c.total}\` to ${a - b}, or correct the two it comes ` +
              `from. A client reading two different bottom lines has to pick one, and they will pick ` +
              `neither and ask.`,
          });
        }
      }

      if (c.kind === "ratio_of") {
        const n = num(at(parsed, c.numerator));
        const d = num(at(parsed, c.denominator));
        const p = num(at(parsed, c.pct));
        // A zero or absent denominator is `not_when`'s business, not this one.
        if (n !== undefined && d !== undefined && d > 0 && p !== undefined) {
          const want = Math.round((n / d) * 1000) / 10;
          if (Math.abs(want - p) > TOLERANCE_PCT) {
            out.push({
              kind: c.kind,
              message:
                `\`${c.pct}\` says ${p}%, and \`${c.numerator}\` out of \`${c.denominator}\` is ` +
                `${n} of ${d}, which is ${want}%. Set \`${c.pct}\` to ${want}, or correct the two ` +
                `counts. A client can do that division in their head faster than they can read the ` +
                `sentence around it.`,
            });
          }
        }
      }

      if (c.kind === "counts") {
        const list = at(parsed, c.items);
        const n = num(at(parsed, c.field));
        const len = Array.isArray(list) ? list.length : 0;
        if (len > 0 && n === undefined) {
          out.push({
            kind: c.kind,
            message:
              `"${c.items}" has ${len} entr${len === 1 ? "y" : "ies"} and "${c.field}" is missing. ` +
              `State the total — a client counts the list, and a count they cannot check against ` +
              `anything is one they will do themselves.`,
          });
        } else if (n !== undefined && n !== len) {
          out.push({
            kind: c.kind,
            message:
              `"${c.field}" says ${n} but "${c.items}" has ${len}. A client who counts the list and ` +
              `reads a different number stops trusting both — make them agree.`,
          });
        }
      }

      if (c.kind === "not_when") {
        const flagged = at(parsed, c.unknown_when) === true;
        const stated = at(parsed, c.field);
        const isStated =
          typeof stated === "number"
            ? Number.isFinite(stated)
            : typeof stated === "string"
              ? stated.trim().length > 0
              : false;
        if (flagged && isStated) {
          out.push({
            kind: c.kind,
            message:
              `It states "${c.field}" as ${JSON.stringify(stated)} while "${c.unknown_when}" is true. ` +
              `You cannot tell a client a figure and also tell them it cannot be established — take ` +
              `the figure out, or establish it.`,
          });
        }
      }

      if (c.kind === "agrees") {
        const flag = at(parsed, c.flag);
        const n = num(at(parsed, c.zero_when_true));
        if (flag === true && n !== undefined && n !== 0) {
          out.push({
            kind: c.kind,
            message:
              `It reports "${c.flag}" as true while "${c.zero_when_true}" is ${n}. Those cannot both ` +
              `be right — either the period does not balance, or the difference is stale.`,
          });
        }
        // The other direction, which is the quieter mistake: a difference of zero reported as NOT
        // reconciled understates the work and asks the client a question that has been answered.
        if (flag === false && n === 0) {
          out.push({
            kind: c.kind,
            message:
              `It reports "${c.flag}" as false while "${c.zero_when_true}" is 0. If nothing is ` +
              `outstanding, say so — this reads as unfinished work to the client.`,
          });
        }
      }

      if (c.kind === "sums_to") {
        const items = at(parsed, c.items);
        const total = num(at(parsed, c.total));
        if (Array.isArray(items) && items.length > 0 && total !== undefined) {
          let sum = 0;
          let readable = true;
          for (const it of items) {
            const v = num((it as Record<string, unknown>)?.[c.each]);
            if (v === undefined) {
              // A line with no amount is `output_schema`'s problem, not this one. Bailing out is
              // better than summing a partial list and reporting a mismatch that is really a
              // missing field — a fault that points at the wrong thing is worse than no fault.
              readable = false;
              break;
            }
            sum += v;
          }
          if (readable && sum !== total) {
            out.push({
              kind: c.kind,
              /**
               * NAMES THE FIELDS AND THE FIX, because a repair round is only worth what it tells the
               * model. This said "the total says 97290 and the 5 lines add up to -97290" and nothing
               * else. The repair returned the identical answer — reasonably, since a reader of that
               * sentence concludes the total is right and the lines merely carry minus signs. Once the
               * fault does not say which side to move, the round is a re-roll.
               *
               * `${c.total}` and `${c.items}[].${c.each}` are the paths the model wrote, so it can
               * find them without guessing which of its fields we mean.
               */
              message:
                `\`${c.total}\` says ${total}, and \`${c.items}[].${c.each}\` across ` +
                `${items.length} line${items.length === 1 ? "" : "s"} adds up to ${sum}` +
                (total === -sum ? " — the same magnitude with the opposite sign" : "") +
                `. Set \`${c.total}\` to ${sum}, or correct the lines. A client pays from that ` +
                `number, so it does not go out until the two agree.`,
            });
          }
        }
      }

      if (c.kind === "min_items") {
        const v = at(parsed, c.field);
        if (Array.isArray(v) && v.length < c.n) {
          out.push({
            kind: c.kind,
            message:
              `"${c.field}" has ${v.length} where the service promises at least ${c.n}. ` +
              `A report with nothing to do next is a measurement, not a deliverable.`,
          });
        }
      }

      if (c.kind === "each_has") {
        const items = at(parsed, c.items);
        if (Array.isArray(items) && items.length > 0) {
          const bad = items.filter((it) => {
            const v = (it as Record<string, unknown>)?.[c.field];
            if (typeof v === "string") return v.trim().length === 0;
            if (typeof v === "number") return !Number.isFinite(v);
            return v === undefined || v === null;
          }).length;
          if (bad > 0) {
            /**
             * The sentence changes with the count, and that is not decoration.
             *
             * "1 of 1 entry in redirects have no to. A list where only the first one is filled in
             * reads as three things and is one" is what the single-message version produced, and it
             * is both ungrammatical and about a different problem — a reader stops trusting a gate
             * that describes their situation wrongly, however right the verdict is.
             */
            const one = items.length === 1;
            out.push({
              kind: c.kind,
              message: one
                ? `The single entry in "${c.items}" has no "${c.field}", which is the field that makes it worth having.`
                : `${bad} of ${items.length} entries in "${c.items}" have no "${c.field}". A list where ` +
                  `only some are filled in reads as ${items.length} things and is ${items.length - bad}.`,
            });
          }
        }
      }

      if (c.kind === "spread") {
        const items = at(parsed, c.items);
        if (Array.isArray(items) && items.length > 0) {
          const seen = new Set<string>();
          for (const it of items) {
            const v = (it as Record<string, unknown>)?.[c.field];
            if (typeof v === "string" && v.trim()) seen.add(v.trim().toLowerCase());
          }
          if (seen.size < c.distinct) {
            out.push({
              kind: c.kind,
              message:
                `All ${items.length} entries in "${c.items}" are ${seen.size === 1 ? `the same "${c.field}"` : `only ${seen.size} kinds of "${c.field}"`}, ` +
                `where the service promises ${c.distinct}. Work that is all one size is a plan nobody starts.`,
            });
          }
        }
      }

      if (c.kind === "forbids") {
        const v = at(parsed, c.field);
        if (typeof v === "string" && v.trim()) {
          const hay = v.toLowerCase();
          const list = [...forbiddenPhrases(c.vocabulary), ...(c.extra ?? []).map((x) => x.toLowerCase())];
          const hits = list.filter((phrase) => hay.includes(phrase));
          // The pattern half. Only for `placeholder` — an unfilled slot is a data-binding failure,
          // where `brand_poetry` is about wording and has no equivalent shape.
          if (c.vocabulary === "placeholder") hits.push(...unresolvedSlots(v));
          if (hits.length) {
            out.push({
              kind: c.kind,
              message:
                c.vocabulary === "placeholder"
                  ? `"${c.field}" still contains ${hits.slice(0, 3).map((h) => `"${h}"`).join(", ")}. That is a draft, not a deliverable — it would reach the client as-is.`
                  : `"${c.field}" reads as marketing rather than as the work: ${hits.slice(0, 3).map((h) => `"${h}"`).join(", ")}. Say what was done and what it means for them.`,
            });
          }
        }
      }

      if (c.kind === "max_words") {
        const n = words(at(parsed, c.field));
        if (n > c.n) {
          out.push({
            kind: c.kind,
            message:
              `"${c.field}" is ${n} words. It is meant to be the part they read first, and at that ` +
              `length nobody does — the point ends up somewhere in the middle.`,
          });
        }
      }

      if (c.kind === "min_words") {
        const n = words(at(parsed, c.field));
        // Absent is not short — see the note above about the division of labour.
        if (at(parsed, c.field) !== undefined && n > 0 && n < c.n) {
          out.push({
            kind: c.kind,
            message:
              `"${c.field}" is ${n} word${n === 1 ? "" : "s"} long. That is a note, not the ` +
              `explanation the client is paying for.`,
          });
        }
      }
    } catch {
      // A malformed check must not break the path between a finished run and a founder's screen.
      // Skipping it is the gated direction: the work still stops at review, which is where it was.
    }
  }
  return out;
}

/**
 * ═══ THE CONTRACT, WRITTEN OUT FOR THE AGENT THAT HAS TO SATISFY IT ═══
 *
 * THE FAILURE THIS EXISTS FOR. Every gate in this file ran on the way OUT and nothing told the agent
 * on the way in. So a run produced a monthly close with a fourteen-word summary, satisfied its
 * schema, satisfied `ship_requires`, reported success — and the kernel held it, for a rule the run
 * had never been shown. The founder gets a hold with a good reason; the agent gets nothing, and
 * would produce exactly the same output again.
 *
 * That is the worst shape a quality gate can have: it converts a fixable near-miss into a wasted run
 * plus a human's afternoon, and the agent cannot learn from it because it never sees it. A contract
 * you are graded against and not shown is not a contract.
 *
 * ═══ WHY PROSE AND NOT THE JSON ═══
 *
 * Pasting `[{"kind":"min_words","field":"client_summary","n":25}]` into a prompt would be honest and
 * useless: it reads as configuration rather than as an instruction, and an agent skims it. These are
 * sentences in the imperative, in the order they will be checked, and each one says the NUMBER —
 * because "be thorough" changes nothing and "at least 25 words" changes the output.
 *
 * IT NEVER EXPLAINS WHY. The reasoning belongs in the wedge's skills, where it is a paragraph a
 * practitioner wrote. Repeating a compressed version here would give the agent two sources for one
 * rule, and the day they disagree the prompt wins over the craft.
 */
/**
 * ═══ THE SAME GUARANTEES, FOR THE PERSON PAYING FOR THEM ═══
 *
 * `describeShipContract` is written to instruct a MODEL. It names fields, quotes paths and says
 * things like "set `reconciled` false". Rendered to a founder reviewing a service, it reads:
 *
 *   monthly close: `reconciled` and `difference_cents` must agree: reconciled is true ONLY when
 *   difference_cents is 0.
 *
 * The founder this product is for runs an agency. They are not going to read that, and the only
 * thing it teaches them is that the software is for somebody else. Reaching for the nearest existing
 * string was the mistake; a human needs a different sentence, not the same sentence.
 *
 * So: grouped by KIND rather than listed per field, because nobody wants twenty-four rules — they
 * want to know what is guaranteed. Six sentences with no field name in them beats twenty-four with
 * a schema path in every one, and it is the same set of guarantees either way.
 *
 * Ordered by what a founder cares about most: money first, then what reaches their client, then the
 * shape of the work.
 */
export function plainChecks(shipRequires: readonly string[] | undefined, checks: readonly ShipCheck[]): string[] {
  const kinds = new Set(checks.map((c) => c.kind));
  const out: string[] = [];

  if (kinds.has("sums_to")) out.push("Every total is added up from its own lines, not typed in.");
  if (kinds.has("nets_to")) out.push("The bottom line has to match the figures above it.");
  if (kinds.has("agrees")) out.push("We never tell a client something balances while showing a difference.");
  if (kinds.has("minor_units")) out.push("Amounts are checked so a figure can't come out a hundred times too big.");
  if (kinds.has("not_when")) out.push("We won't quote a figure and also say we couldn't work it out.");
  if (kinds.has("counts")) out.push("If we say there are four things to look at, there are four.");
  if (kinds.has("each_has") && checks.some((c) => c.kind === "each_has" && c.field === "recommendation")) {
    out.push("Anything we ask you comes with what we'd recommend, so it's a yes or no.");
  }
  if (kinds.has("min_words") || kinds.has("max_words")) {
    out.push("The covering note can't go out as one line, or as five pages.");
  }
  if (kinds.has("forbids")) out.push("Nothing ships with a placeholder still in it.");

  /**
   * The ship bar, as ONE sentence naming the things in the founder's own words rather than a bullet
   * per field. `artifacts` becomes "the files" — the word `artifacts` is ours, not theirs, and it is
   * the single most common piece of our vocabulary to leak into a screen.
   */
  const human = (f: string): string =>
    ({
      artifacts: "the files",
      client_summary: "a summary",
      covering_note: "a covering note",
      profit_and_loss: "the profit and loss",
      reconciliation: "the reconciliation",
      message: "the message",
      lines: "the lines",
    })[f] ?? f.replace(/_/g, " ");
  const required = [...new Set((shipRequires ?? []).map(human))];
  if (required.length) {
    const list =
      required.length === 1
        ? required[0]!
        : `${required.slice(0, -1).join(", ")} and ${required[required.length - 1]}`;
    out.push(`Nothing goes out without ${list}.`);
  }
  return out;
}

export function describeShipContract(
  shipRequires: readonly string[] | undefined,
  checks: readonly ShipCheck[] | undefined,
): string[] {
  const lines: string[] = [];
  for (const f of shipRequires ?? []) lines.push(`\`${f}\` must not be empty.`);

  for (const c of checks ?? []) {
    switch (c.kind) {
      case "agrees":
        lines.push(
          `\`${c.flag}\` and \`${c.zero_when_true}\` must agree: ${c.flag} is true ONLY when ` +
            `${c.zero_when_true} is 0. If it is not 0, say so and set ${c.flag} false.`,
        );
        break;
      case "no_tells":
        lines.push(
          `\`${c.field}\` must not read as machine-written. Vary your sentence lengths — human ` +
            `writing is lopsided. No "not only… but also", no list of three, no summary of something ` +
            `short, one hedge at most, and no closing question that asks for engagement rather than ` +
            `for something answerable in a word.`,
        );
        break;
      case "minor_units":
        lines.push(
          `Every money field here is in MINOR units and every figure in \`${c.field}\` is what a ` +
            `client reads. Divide by 100 on the way out: 34000 is £340.00, not £34,000.00.`,
        );
        break;
      case "nets_to":
        lines.push(
          `\`${c.total}\` must equal \`${c.minuend}\` minus \`${c.subtrahend}\`, exactly. Do the ` +
            `subtraction before you answer, and quote that same figure everywhere you mention it.`,
        );
        break;
      case "ratio_of":
        lines.push(
          `\`${c.pct}\` must be \`${c.numerator}\` out of \`${c.denominator}\`, worked out rather ` +
            `than estimated. A client checks a percentage against the two counts beside it.`,
        );
        break;
      case "counts":
        lines.push(
          `\`${c.field}\` must equal the number of entries in \`${c.items}\`. The client counts the ` +
            `list; two numbers about the same thing that disagree cost you every other number too.`,
        );
        break;
      case "not_when":
        lines.push(
          `\`${c.field}\` must be absent whenever \`${c.unknown_when}\` is true. Never state a figure ` +
            `you have also said cannot be established — a client acts on the number and is entitled ` +
            `to believe it.`,
        );
        break;
      case "sums_to":
        lines.push(
          `\`${c.total}\` must equal the sum of every \`${c.items}[].${c.each}\`, exactly. ` +
            `Add them up before you answer — a client pays from that number.`,
        );
        break;
      case "min_items":
        lines.push(`\`${c.field}\` needs at least ${c.n} entr${c.n === 1 ? "y" : "ies"}.`);
        break;
      case "each_has":
        lines.push(
          `EVERY entry in \`${c.items}\` needs a \`${c.field}\` — not just the first one. ` +
            `An entry you cannot fill in should not be in the list.`,
        );
        break;
      case "spread":
        lines.push(
          `\`${c.items}\` must cover at least ${c.distinct} different values of \`${c.field}\`. ` +
            `All of them the same is not a spread.`,
        );
        break;
      case "min_words":
        lines.push(`\`${c.field}\` must be at least ${c.n} words. It is what the client reads first.`);
        break;
      case "max_words":
        lines.push(`\`${c.field}\` must be under ${c.n} words. Longer and nobody reads it.`);
        break;
      case "forbids": {
        const sample = forbiddenPhrases(c.vocabulary).slice(0, 6).join('", "');
        lines.push(
          c.vocabulary === "placeholder"
            ? `\`${c.field}\` must contain no placeholders — no "${sample}", no invented names, ` +
              `no example domains. If you do not know a value, say you do not know it.`
            : `\`${c.field}\` must not read as marketing. Banned outright: "${sample}"` +
              `${c.extra?.length ? `, "${c.extra.join('", "')}"` : ""}. Say what was done and what it means.`,
        );
        break;
      }
    }
  }
  return lines;
}

/** Parse and validate a manifest's `ship_checks`. Unknown kinds are dropped, never guessed at. */
/**
 * How far a stated percentage may sit from the division it claims to be.
 *
 * A tenth of a point. `sums_to` is exact because money is integer minor units; a percentage is not —
 * 2/3 is 66.7 to one decimal and 66.67 to two, and both are honest. Wide enough that rounding never
 * fails a truthful run, far too narrow for a number somebody made up.
 */
const TOLERANCE_PCT = 0.1;

export function readShipChecks(raw: unknown): ShipCheck[] {
  if (!Array.isArray(raw)) return [];
  const out: ShipCheck[] = [];
  for (const r of raw) {
    const c = r as Record<string, unknown>;
    const s = (k: string) => (typeof c[k] === "string" && c[k] ? (c[k] as string) : undefined);
    const n = (k: string) => (typeof c[k] === "number" && Number.isFinite(c[k]) ? (c[k] as number) : undefined);
    if (c.kind === "agrees" && s("flag") && s("zero_when_true")) {
      out.push({ kind: "agrees", flag: s("flag")!, zero_when_true: s("zero_when_true")! });
    } else if (c.kind === "no_tells" && s("field")) {
      out.push({ kind: "no_tells", field: s("field")!, ...(c.social === true ? { social: true } : {}) });
    } else if (c.kind === "minor_units" && s("field")) {
      out.push({ kind: "minor_units", field: s("field")! });
    } else if (c.kind === "nets_to" && s("minuend") && s("subtrahend") && s("total")) {
      out.push({ kind: "nets_to", minuend: s("minuend")!, subtrahend: s("subtrahend")!, total: s("total")! });
    } else if (c.kind === "ratio_of" && s("numerator") && s("denominator") && s("pct")) {
      out.push({ kind: "ratio_of", numerator: s("numerator")!, denominator: s("denominator")!, pct: s("pct")! });
    } else if (c.kind === "counts" && s("items") && s("field")) {
      out.push({ kind: "counts", items: s("items")!, field: s("field")! });
    } else if (c.kind === "not_when" && s("field") && s("unknown_when")) {
      out.push({ kind: "not_when", field: s("field")!, unknown_when: s("unknown_when")! });
    } else if (c.kind === "sums_to" && s("items") && s("each") && s("total")) {
      out.push({ kind: "sums_to", items: s("items")!, each: s("each")!, total: s("total")! });
    } else if (c.kind === "min_items" && s("field") && n("n") !== undefined) {
      out.push({ kind: "min_items", field: s("field")!, n: n("n")! });
    } else if (c.kind === "min_words" && s("field") && n("n") !== undefined) {
      out.push({ kind: "min_words", field: s("field")!, n: n("n")! });
    } else if (c.kind === "max_words" && s("field") && n("n") !== undefined) {
      out.push({ kind: "max_words", field: s("field")!, n: n("n")! });
    } else if (c.kind === "each_has" && s("items") && s("field")) {
      out.push({ kind: "each_has", items: s("items")!, field: s("field")! });
    } else if (c.kind === "spread" && s("items") && s("field") && n("distinct") !== undefined) {
      out.push({ kind: "spread", items: s("items")!, field: s("field")!, distinct: n("distinct")! });
    } else if (c.kind === "forbids" && s("field") && isVocabulary(c.vocabulary)) {
      // `extra` is a trade's own additions. Filtered to strings rather than trusted, because an
      // object in that array would make `.includes` throw inside the gate on every run.
      const extra = Array.isArray(c.extra)
        ? (c.extra as unknown[]).filter((x): x is string => typeof x === "string" && !!x.trim())
        : undefined;
      out.push({
        kind: "forbids",
        field: s("field")!,
        vocabulary: c.vocabulary as ForbiddenVocabulary,
        ...(extra?.length ? { extra } : {}),
      });
    }
  }
  return out;
}
