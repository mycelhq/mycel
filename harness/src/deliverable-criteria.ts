// ═══ WHAT "GOOD" MEANS FOR A PIECE OF KNOWLEDGE WORK, IN GRADABLE TERMS ═══
//
// Anthropic's harness-design post (Mar 2026) makes two findings that apply here almost unchanged.
//
// The first is about self-evaluation: "When asked to evaluate work they've produced, agents tend to
// respond by confidently praising the work—even when, to a human observer, the quality is obviously
// mediocre... Separating the agent doing the work from the agent judging it proves to be a strong
// lever." Tuning a skeptical evaluator is tractable; making a generator self-critical is not.
//
// The second is why this file can exist before that evaluator does: "Even on the first iteration,
// outputs were noticeably better than a baseline with no prompting at all, suggesting the criteria
// and associated language themselves steered the model." The criteria pay before the loop is built.
//
// Their move is to turn a subjective question into a gradable one — "is this design beautiful" is
// unanswerable, "does this follow our principles" is not. These are that, for a deliverable a
// service business sends a client.
//
// ═══ THE WEIGHTS COME FROM A MEASUREMENT, NOT A PREFERENCE ═══
//
// They weighted design and originality over craft and functionality because Claude "already scored
// well on craft and functionality by default" — weight what the model is bad at, not what sounds
// most important.
//
// So these weights come from an actual run. On 3 September a `write_post` for a landscaping firm
// produced 688 words with no marketing slop, no invented figures, a correct derivation of
// distribution uniformity, and an explicit refusal to state a price it had not been given — and
// handed back a text blob a founder would have to format before sending. Grounding and trade
// fluency were already excellent unprompted. The OBJECT was unusable.
//
// That is the opposite of where a naive rubric would put the emphasis, and it is why `artefact` is
// weighted highest here and `grounding` is not, despite grounding being the more expensive failure
// in principle. The point of a weight is to move behaviour that needs moving.
//
// ═══ THEY ALSO WARN THAT THE WORDING ITSELF STEERS ═══
//
// "Including phrases like 'the best designs are museum quality' pushed designs toward a particular
// visual convergence." So the language below is deliberately plain and deliberately about the
// READER — a property manager, a bookkeeper's client — rather than about excellence in the
// abstract. Every criterion names who is disappointed and how, because a criterion a model cannot
// picture failing is one it cannot grade.

export interface DeliverableCriterion {
  id: string;
  /** 1–3. Higher is weighted more heavily in an evaluator's overall verdict. */
  weight: 1 | 2 | 3;
  title: string;
  /** The gradable question. Answerable about a specific artefact, not about work in general. */
  asks: string;
  /** What failing looks like, concretely, and who notices. */
  fails: string;
}

export const DELIVERABLE_CRITERIA: readonly DeliverableCriterion[] = [
  {
    id: "artefact",
    weight: 3,
    title: "It is the thing they asked for",
    asks:
      "Is this the artefact the engagement promised — the report, the sheet, the deck — finished and " +
      "ready to forward without anyone reformatting it?",
    fails:
      "Markdown, a wall of prose, or notes ABOUT the deliverable rather than the deliverable. The " +
      "founder has to spend an hour formatting before a client can see it, which is the hour they " +
      "were paying to avoid. This is the one that actually fails today: measured on a real run, the " +
      "words were excellent and the object was unusable.",
  },
  {
    id: "grounding",
    weight: 3,
    title: "Every number and claim is traceable",
    asks:
      "Can each figure, date, name and assertion be traced to something supplied — the brief, the " +
      "client's own data, a cited source? Where a fact was missing, does the work SAY so rather than " +
      "fill the gap?",
    fails:
      "An invented figure. It is the most expensive failure on this list because it is the one a " +
      "client can catch, and catching one makes them re-audit everything else you ever sent them.",
  },
  {
    id: "trade",
    weight: 2,
    title: "A practitioner would recognise their own work",
    asks:
      "Does this use the trade's artefacts, counterparties, clock and money path — the specific nouns " +
      "— rather than general business language dressed in the trade's vocabulary?",
    fails:
      "'Deliverables' where a practitioner would say an EOB, a rate confirmation, a validation notice. " +
      "It reads as competent and generic, and a client who does this work every day can tell in a " +
      "paragraph that whoever wrote it does not.",
  },
  {
    id: "decision",
    weight: 2,
    title: "The reader knows what to do next",
    asks:
      "After reading, does the recipient know what changed, what it means for them, and what happens " +
      "next — without a follow-up call to interpret it?",
    fails:
      "Findings with no consequence attached. Accurate, complete, and it lands on a desk where nobody " +
      "can tell whether to act. A report that needs a phone call to explain it has not been delivered.",
  },
  {
    id: "craft",
    weight: 1,
    title: "It reads as finished",
    asks:
      "Does it read as finished — consistent hierarchy and structure, no placeholder text, no " +
      "marketing filler, and figures laid out so they can actually be compared?",
    fails:
      "Broken fundamentals. Weighted lowest deliberately — like Anthropic's craft criterion, this is " +
      "the one models mostly get right unprompted, and weighting it higher spends attention where it " +
      "is not needed.",
  },
];

/**
 * The criteria as prompt lines.
 *
 * Given to the GENERATOR, which is the cheap half of the loop and the half that already pays. When
 * an evaluator exists it gets exactly this text, because a generator and an evaluator grading
 * against different words is how a feedback loop teaches drift.
 */
export function criteriaAsPromptLines(): string[] {
  const lines = [
    "",
    "## What this deliverable is judged on",
    "",
    "Not a checklist to satisfy at the end — these are what a demanding founder checks before putting",
    "their name on it and sending it to somebody who pays them. They are ordered by how often they",
    "are what actually goes wrong.",
    "",
  ];
  for (const c of [...DELIVERABLE_CRITERIA].sort((a, b) => b.weight - a.weight)) {
    lines.push(`### ${c.title}${c.weight === 3 ? " — weighted heaviest" : ""}`);
    lines.push("");
    lines.push(c.asks);
    lines.push("");
    lines.push(`_Failing looks like:_ ${c.fails}`);
    lines.push("");
  }
  lines.push(
    "If you cannot satisfy one of these because something was not given to you, say which and why in",
    "the work itself. A named gap is a professional answer; a filled one is not.",
  );
  return lines;
}

/**
 * The same criteria as an evaluator's instruction.
 *
 * Not wired into a run yet — the generator half is where the measured gain is and it carries no
 * orchestration cost. This exists so that when the evaluator pass is built it grades against the
 * IDENTICAL words the generator was given, and so the skeptical framing lives beside the criteria
 * rather than being reinvented at the call site.
 *
 * The skepticism is explicit because it has to be: an evaluator is still an LLM inclined to be
 * generous toward LLM output, and Anthropic found that tuning that out of a standalone evaluator is
 * tractable where making a generator self-critical is not.
 */
export function evaluatorPrompt(): string {
  return [
    "You are grading a deliverable a service business is about to send a paying client under their",
    "own name. You did not write it. Your default is that it is not ready.",
    "",
    "Grade each criterion 0–5 and say what specifically would have to change to gain one point. A",
    "score with no attached change is not useful to the agent that has to act on it.",
    "",
    "Be harder on the heavily weighted criteria. Do not average your way to a passing verdict: one",
    "invented figure or an artefact that is not the thing promised fails the whole piece regardless",
    "of how well everything else reads.",
    ...criteriaAsPromptLines(),
  ].join("\n");
}
