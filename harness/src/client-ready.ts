// What a client is allowed to receive, and what happens to everything else.
//
// ═══ THE FAILURE THIS EXISTS TO STOP ═══
//
// Every deliverable in production on the day this was written was a REFUSAL, rendered as a branded
// PDF and put in front of a client as work to review. Their portal summaries read:
//
//   {"query":"AI that runs the back office for a small agency","surface":"unavailable","cited":[]}
//   Retry the weekly run after the probe and measurement endpoints are available.
//   No candidates were sourced. The case does not contain a role brief or connected
//   candidate-source ID, and the business knowledge search returned nothing.
//
// Each is the truth. Not one is addressed to a customer. The first is a serialised object; the other
// two are addressed to whoever operates the machine — they name endpoints, case data and sources,
// which are nouns from our implementation that the client did not buy and cannot act on.
//
// `orchestrator` already reaches for `client_summary` first and falls back to the raw run text. The
// fallback is the whole bug: when a wedge omits its plain-language field, the machine's own output
// is what ships. A fallback that can leak is not a fallback, it is a default.
//
// ═══ THREE FATES, AND NEVER A FOURTH ═══
//
// A finished run's output can be one of exactly three things, and this module's only job is to say
// which:
//
//   DELIVER — prose about work that was done, in the client's vocabulary. Becomes a deliverable.
//   ASK     — the run could not proceed without something only the client has. Becomes a REQUEST
//             for that material, which the portal already knows how to collect. Not a deliverable:
//             nobody should be asked to "review and accept" a list of things they failed to send.
//   HOLD    — machine text, an internal fault, a serialised object. The founder sees it on the task.
//             The client sees nothing, because nothing happened that concerns them.
//
// The fourth fate — ship it anyway — is what shipped, and it is the one this file removes.
//
// ═══ WHY REFUSING IS THE SAFE DIRECTION ═══
//
// A held deliverable costs a founder one look at a task that did not produce client-ready work,
// which is information they want anyway. A shipped one costs them the client's belief that there is
// a professional on the other end — and unlike a late report, that does not come back. The whole
// product promise is that a small business appears to have a competent back office. One JSON blob
// in a portal falsifies it more completely than a week of silence.

// The declared output assertions. This file stays trade-blind: it knows what "the total does not
// match the lines" means and nothing about invoices.
import { shipFaults, type ShipCheck } from "./ship-checks";

/** What should happen to a finished run's output. */
export type Fate = "deliver" | "ask" | "hold";

export interface Verdict {
  fate: Fate;
  /** Client-facing prose. Present only for `deliver`. */
  body?: string;
  /** What the client must provide. Present only for `ask`, never empty when present. */
  needs?: string[];
  /** Why, in a sentence a founder reads on the task. Always present. */
  reason: string;
  /**
   * The declared output gates this run failed, when that is why it was held.
   *
   * Present ONLY for a hold caused by `ship_checks`, and that narrowness is the point: it is what
   * lets the orchestrator tell a REPAIRABLE hold from every other kind. A run held because the
   * client has to answer a question cannot be fixed by trying again; a run held because a summary is
   * fourteen words long can be fixed in one turn by the agent that wrote it.
   *
   * Carries the sentences rather than the check objects, because those sentences are already written
   * for a person and the agent is the reader here too.
   */
  faults?: string[];
}

/**
 * Vocabulary that proves the text is addressed to an operator rather than a customer.
 *
 * Every entry is a noun from OUR implementation. A client bought bookkeeping, a shortlist or a
 * visibility report; they did not buy a case, a probe or a connection id, and a sentence that names
 * one is a sentence written for the wrong reader — regardless of how polite it is.
 *
 * ═══ WHAT IS DELIBERATELY NOT HERE, AND WHY THE LIST IS SHORT ═══
 *
 * The obvious list is longer — "endpoint", "api", "payload", "pipeline", "database", "workflow",
 * "knowledge base". Every one of those was in the first draft and every one is wrong, because they
 * are ALSO the client's words for the client's things:
 *
 *   - a `security-questionnaire` customer answers forty questions about API and endpoint security
 *   - every service business has a sales PIPELINE and a customer DATABASE
 *   - "we documented your onboarding workflow" is the deliverable, not a leak
 *
 * A guard that holds real work is worse than no guard, because it gets switched off — and then the
 * genuine leaks come back with it. So this list contains only nouns that belong to US and to nobody
 * else. The refusals it must catch are caught two or three times over anyway: the real geo-monitor
 * example trips "probe", "retry the weekly" AND `readsAsMissingInput`. Breadth here buys nothing
 * and costs the whole mechanism.
 *
 * Also not here: "report", "invoice", "statement", "document", "account".
 *
 * EXPORTED, BECAUSE A RULE ONLY ENFORCED AT THE GATE IS A TRAP. This list decided whether real work
 * reached a client and the RUN HAD NEVER SEEN IT. A deliverable was asked for a covering note, told
 * nothing about which words were forbidden, and then held for using one — a test nothing could pass
 * except by luck, paid for at full cost every time. `runtime.ts` mounts it into the instruction that
 * asks for the note, so the run is told the rule before it is judged by it.
 */
export const INTERNAL_VOCABULARY = [
  "harness",
  "sandbox",
  "wedge",
  "task_type",
  "connection_id",
  "connection id",
  "output schema",
  "json",
  "null",
  "undefined",
  "case data",
  "this case",
  "probe",
  "probes",
  "re-run",
  "rerun",
  "retry the run",
  "retry the weekly",
  "artifact",
  "artifacts",
];

/**
 * Phrases that mean "we are missing something the client holds".
 *
 * These are how a competent run refuses, and refusing is CORRECT behaviour — the wedges that
 * produced the four refusals above were each right to stop. The defect was never the refusal; it
 * was routing it to the wrong noun. Detecting the shape is what lets it become a request instead.
 */
const MISSING_INPUT_PHRASES = [
  "not yet available",
  "not available",
  "does not contain",
  "do not contain",
  "was not provided",
  "were not provided",
  "not been provided",
  "no candidates were sourced",
  "could not be completed because",
  "is not live yet",
  "not connected",
  "no source",
  "missing",
  "we need",
  "required before",
  "awaiting",
];

const MAX_BODY = 4_000;

/**
 * ═══ NEVER CUT A CLIENT'S DOCUMENT MID-SENTENCE ═══
 *
 * A covering note reached a client ending, exactly, "...if personal, book it to drawings, and if
 * business". Two thousand characters on the nose. They said what anyone would: "the covering note
 * appears incomplete, ending mid-sentence."
 *
 * There is no version of that which is acceptable. A document that stops mid-word is the single most
 * obvious sign that nobody read it before it went, and it undoes every careful thing above it — the
 * reconciliation, the recommendations, the honest caveats. A reader who sees it stops trusting the
 * figures too, and they are right to.
 *
 * So cut on a boundary and say that you did. Paragraph if there is one in reach, then sentence, then
 * word; a hard cut only if the text has no break at all in the last fifth of the budget, which in
 * practice means it is not prose. The marker matters as much as the cut — a note that ends early
 * with "[…]" is a note the reader knows is abridged, and one that just stops is a broken product.
 */
export function clipToBoundary(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const marker = "\n\n[…]";
  const budget = max - marker.length;
  const head = t.slice(0, budget);
  // In reach = the last fifth of the budget. A paragraph break 200 characters in is not a boundary
  // for a 2,000-character note, it is throwing the note away.
  const floor = Math.floor(budget * 0.8);
  const at = (i: number) => (i >= floor ? i : -1);
  const structural = Math.max(
    at(head.lastIndexOf("\n\n")),
    at(Math.max(head.lastIndexOf(". "), head.lastIndexOf(".\n"))) + 1,
    at(head.lastIndexOf("\n")),
  );
  // No paragraph or sentence in reach still never means mid-word. That was the whole complaint, and
  // a word boundary is always available in prose — the raw cut below is for text with no spaces at
  // all, which is not something a client is reading.
  const cut = structural > 0 ? structural : head.lastIndexOf(" ");
  return (cut > 0 ? head.slice(0, cut) : head).trimEnd() + marker;
}

/** A serialised object or array, whether or not it parses cleanly. */
export function looksMachine(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (/^[[{]/.test(t)) return true;
  // A fragment of one — a truncated blob does not start with a brace but is no more readable.
  if (/"[a-z_]+"\s*:/.test(t)) return true;
  return false;
}

/**
 * Does this text speak to a customer?
 *
 * Word-boundary matched, because substring matching turns "api" into a hit on "capital" and
 * "rapidly" — a guard that fires on ordinary prose gets switched off within a week, and then the
 * real leaks come back with it.
 */
export function internalTerms(text: string): string[] {
  const lower = text.toLowerCase();
  const hits: string[] = [];
  for (const term of INTERNAL_VOCABULARY) {
    const pattern = new RegExp(`(^|[^a-z0-9_])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9_]|$)`, "i");
    if (pattern.test(lower)) hits.push(term);
  }
  return hits;
}

/** Does this read like a run that stopped for want of the client's material? */
export function readsAsMissingInput(text: string): boolean {
  const lower = text.toLowerCase();
  return MISSING_INPUT_PHRASES.some((p) => lower.includes(p));
}

/**
 * What the client actually has to hand over, taken from the run's own structured output.
 *
 * STRUCTURE FIRST, prose never. A wedge that declares `questions` (books-keeper) or `needs` has
 * named its asks in a field, and those are the strings to put in front of a client. Mining the
 * refusal sentence for nouns would produce "a connected candidate-source ID" — our vocabulary,
 * verbatim, which is the failure one layer down rather than fixed.
 *
 * So: no structured asks means no request. The run refused without saying what would unblock it,
 * and inventing the answer on its behalf is how a client gets asked for the wrong document.
 */
/**
 * ═══ TWO DIFFERENT THINGS WERE ONE LIST, AND IT BLOCKED THE LOOP ═══
 *
 * `needs`, `blocked_on`, `missing` and `required_from_client` all mean the same thing: THE RUN COULD
 * NOT FINISH. The comment below is right about them and the production refusal it describes is why.
 *
 * `questions` does not mean that. books-keeper's own schema defines it as "what could NOT be decided
 * alone" — the close balanced, the ledger is written, and three transactions need the owner to say
 * whether a payment was equipment or an expense. That is finished work with an attached ask, which
 * is exactly what a real bookkeeper sends.
 *
 * Treating them as one list meant every monthly close returned `ask` and NO DELIVERABLE WAS EVER
 * CREATED. The client never saw the close, the founder could not invoice it, and the loop could not
 * complete — because the bookkeeper had asked three sensible questions.
 *
 * So they are separated. Only a BLOCKING need forces `ask`. Questions ride along with the work.
 */
const BLOCKING_KEYS = ["needs", "blocked_on", "missing", "required_from_client"] as const;

/** Things the run said stopped it finishing. These, and only these, mean it could not deliver. */
export function blockingNeeds(parsed: Record<string, unknown> | null): string[] {
  return collectAsks(parsed, BLOCKING_KEYS);
}

/**
 * Questions attached to finished work.
 *
 * Kept separate from `blockingNeeds` because they travel WITH a deliverable rather than instead of
 * one — see the note above.
 */
export function openQuestions(parsed: Record<string, unknown> | null): string[] {
  return collectAsks(parsed, ["questions"]);
}

/** Both, for callers that genuinely want everything the run wants from a human. */
export function declaredNeeds(parsed: Record<string, unknown> | null): string[] {
  return [...new Set([...blockingNeeds(parsed), ...openQuestions(parsed)])];
}

function collectAsks(parsed: Record<string, unknown> | null, keys: readonly string[]): string[] {
  if (!parsed) return [];
  const out: string[] = [];
  for (const key of keys) {
    const v = parsed[key];
    if (!Array.isArray(v)) continue;
    for (const item of v) {
      if (typeof item === "string" && item.trim()) out.push(item.trim().slice(0, 300));
      else if (item && typeof item === "object") {
        // `questions` in books-keeper is `{question, best_guess}`; take the readable half.
        const o = item as Record<string, unknown>;
        /**
         * `about` FIRST, and its absence was a silent hole.
         *
         * books-keeper's `questions` are `{about, best_guess, why_asking, recommendation}` — the
         * readable half is `about`, and it was not in this list. So the one wedge whose schema
         * documents its questions most carefully had every one of them extracted as nothing.
         *
         * The list is a union of the shapes wedges actually emit, and a field missing from it fails
         * SILENTLY: the question exists in the output, the founder can read it, and nothing
         * downstream ever sees it. Adding a key to a question object is not enough — it has to be
         * named here too, which is exactly the kind of coupling worth writing down.
         */
        const s = [o.about, o.ask, o.question, o.detail, o.text, o.label].find(
          (x) => typeof x === "string" && x.trim(),
        );
        if (typeof s === "string") out.push(s.trim().slice(0, 300));
      }
      if (out.length >= 8) break;
    }
  }
  return [...new Set(out)];
}

/**
 * The decision.
 *
 * `clientSummary` is the wedge's declared plain-language field when it has one. It is TRUSTED as
 * intent but still CHECKED for vocabulary: a wedge author writing "retry after the probe endpoint
 * is available" into `client_summary` has mislabelled operator text, and the label is not evidence.
 * Trusting the field name was how the second geo-monitor refusal reached a portal.
 */
export function decideFate(args: {
  text: string;
  clientSummary?: string;
  parsed?: Record<string, unknown> | null;
  /**
   * Output fields the WEDGE declared must carry substance before this work may ship —
   * `task_types.<type>.ship_requires` in the manifest, read by the orchestrator and handed in.
   * Declared there and not sniffed here, because this function must stay trade-blind: the day it
   * knows what a share-of-voice percentage looks like is the day it stops being a compiler rule
   * and becomes a GEO feature.
   */
  shipRequires?: readonly string[];
  /**
   * `task_types.<type>.ship_checks` — declared assertions about the output AGREEING WITH ITSELF.
   *
   * The rung above `shipRequires`, which only asks whether a field carries anything. Read by the
   * orchestrator from the manifest and handed in, exactly like `shipRequires`, so this file stays
   * trade-blind: it knows what "the total does not match the lines" means, and nothing about
   * invoices.
   */
  shipChecks?: readonly ShipCheck[];
  /**
   * Capabilities this wedge normally uses that the business has NOT connected.
   *
   * Resolved by the runtime when it built the run's credentials and handed straight through, for
   * the same reason `shipRequires` is: this file stays trade-blind. It does not know what "read
   * payments" means, only that the platform knew a piece of the job could not run.
   */
  capabilityGaps?: readonly string[];
  /** Declared files that exist and do not parse as the format their name claims. */
  brokenArtifacts?: readonly string[];
  /**
   * Files the run named in `artifacts` that do not exist.
   *
   * A deliverable that lists a ledger it never wrote is worse than one that lists nothing: the
   * founder reads "September ledger" on the card, releases it, and the client opens an empty
   * envelope. Checked against the sandbox in runtime.ts, because naming a file satisfies a schema
   * exactly as well as writing one does.
   */
  missingArtifacts?: readonly string[];
}): Verdict {
  /**
   * A PROMISED FILE THAT DOES NOT EXIST IS NOT A NEAR-MISS.
   *
   * FIRST, before every other verdict, and that ordering was learned by getting it wrong.
   *
   * I put this check last, after the ask and hold branches. A monthly close ALWAYS has questions —
   * it is designed to ask rather than guess — so it always returned `ask` and the check never ran
   * once. A run that both asks the client something and names files it never wrote is doing two
   * things, and the second one is a falsehood in what we are about to send.
   *
   * So it goes first. Every other verdict here is about whether the work is FINISHED; this one is
   * about whether it is TRUE, and there is no state of the work that makes a phantom file
   * acceptable.
   *
   * Held with `faults`, unlike a capability gap: this IS repairable by the agent — it has the data
   * and simply did not write the file — and one repair round is cheaper than a founder discovering
   * it after release.
   */
  /**
   * A DELIVERED FILE THAT DOES NOT PARSE, held beside the phantom check for the same reason.
   *
   * The ledger shipped with `Studio rent, July` unquoted — CSV's one rule — so every column after it
   * shifted right and the client opened a file whose counterparty column held descriptions. "Not
   * reliably machine-readable", and they were right.
   *
   * Repairable with `faults`, exactly like a phantom path: the agent has the data and simply wrote
   * the file wrong, and one repair round is cheaper than a founder finding it after release. Second,
   * because a file that is missing outranks one that is malformed.
   */
  const broken = args.brokenArtifacts ?? [];

  const phantom = args.missingArtifacts ?? [];
  if (phantom.length) {
    const list = phantom.slice(0, 3).join(", ");
    const msg =
      `this names ${phantom.length} file${phantom.length === 1 ? "" : "s"} that were never written ` +
      `(${list}) — write them to ./output/ or take them out of \`artifacts\``;
    return { fate: "hold", reason: msg, faults: [msg] };
  }

  if (broken.length) {
    return { fate: "hold", reason: broken[0]!, faults: [...broken] };
  }

  const parsed = args.parsed ?? null;
  const summary = (args.clientSummary ?? "").trim();
  const raw = (args.text ?? "").trim();
  /**
   * BLOCKING needs only. Questions are collected separately and attached to the delivery below —
   * see the note on `declaredNeeds` for why conflating them stopped every monthly close reaching a
   * client.
   */
  const blocking = blockingNeeds(parsed);
  const questions = openQuestions(parsed);

  // Candidate prose, in order of how deliberately it was written for a person.
  const candidate = summary || (looksMachine(raw) ? "" : raw);

  if (!candidate) {
    // Nothing addressed to a human anywhere in the output. If it named its asks, it is a request;
    // otherwise the founder owns it.
    if (blocking.length || questions.length) {
      // With NO client-facing prose, a question is as blocking as a need: there is nothing to send
      // alongside it, so it cannot ride along with anything.
      return {
        fate: "ask",
        needs: [...blocking, ...questions],
        reason: "the run produced no client-facing text but named what it needs",
      };
    }
    return {
      fate: "hold",
      reason: "the run's output is machine text with no client-facing summary — held from the portal",
    };
  }

  const leaks = internalTerms(candidate);

  // DECLARED NEEDS ARE SUFFICIENT ON THEIR OWN. This used to also require the prose to trip
  // `readsAsMissingInput`, and production found the hole within an hour: books-keeper returned a
  // genuinely well-written refusal —
  //
  //   "Brightline Dental's books are not closed: no month or source records were provided, so I
  //    could not verify that the books balance. Please provide the requested bank statement..."
  //
  // — which names no internal noun and matches no refusal phrase ("were provided", not "were NOT
  // provided"). So it scored `deliver`, and a client was invited to review and accept the news that
  // their books are not done.
  //
  // The phrase list was doing work the structure already does better. A run that populated `needs`
  // has SAID it could not finish; no amount of good prose changes that, and weighing the two
  // together means the better the refusal is written the more likely it ships as work. Structure
  // first, prose never — which is what `declaredNeeds` says three functions up, and what this line
  // was quietly contradicting.
  /**
   * ═══ A DECLARED NEED IS DECISIVE ONLY WHEN THE WORK IS NOT THERE ═══
   *
   * This branch was unconditional, and it threw away good work. The August close for a Bristol
   * design studio reconciled sixteen transactions to the statement to the penny, wrote a P&L, a
   * ledger and a VAT worksheet, and a client summary that opens "August 2026 bank activity
   * reconciles exactly to the statement." It cleared every ship gate. And it wrote four items into
   * `needs` — the VAT scheme, the purchase invoices, and the two transactions it could not
   * classify — of which two also appear in `questions`, worded almost identically.
   *
   * So the client received nothing. Not the close, not the P&L, not the reconciliation: four
   * questions and no work. That is the platform being precious with a good month's bookkeeping,
   * and it is the opposite of what a bookkeeper does — they send you the close AND ask about the
   * two payments they could not place.
   *
   * The model is not going to reliably keep `needs` and `questions` apart. They are two words for
   * the same instinct and it wrote the same item under both. Asking it more firmly in the schema
   * helps and is worth doing, but a rule that depends on a model choosing the right synonym is not
   * a rule.
   *
   * WHAT ACTUALLY SEPARATES THE TWO CASES IS ALREADY COMPUTED. The production failure this branch
   * was written for — books-keeper returning "no month or source records were provided, so I could
   * not verify that the books balance", which read as prose and shipped as work — did not clear the
   * ship bar. It had no reconciliation, no P&L, no artifacts. Today's close cleared all of it.
   *
   * So the bar decides. `needs` beside an output that fails the bar means the run is telling us why
   * it could not finish: ask the client. `needs` beside an output that clears the bar means the run
   * finished and has open items: they travel with the delivery, as `questions` already do.
   *
   * This is deliberately the bar and not a new heuristic. If work can clear `ship_requires` and
   * `ship_checks` while being undone, that is a hole in the bar and it gets fixed there — where
   * every other verdict in this file would be wrong too — not patched here with a second opinion.
   */
  const shipRequires = args.shipRequires ?? [];
  const unsubstantiated = missingSubstance(parsed, shipRequires);
  const faults = shipFaults(parsed, shipRequires.length ? args.shipChecks : undefined);
  /**
   * NO BAR IS NOT A CLEARED BAR — and the first version of this got that wrong.
   *
   * Written as "needs is overridden unless the output falls short", it read an EMPTY
   * `ship_requires` as nothing to fall short of, so a task type that declares no bar would deliver
   * every refusal that ever named what it wanted. Four tests caught it, each one a production
   * failure someone had already paid for.
   *
   * The override is earned, never assumed. It takes a declared bar AND an output that clears it;
   * absent a bar there is nothing to demonstrate with, so what the run said about itself stands.
   * `compile()` already refuses a client-facing job with no `ship_requires` — see
   * `ships_without_a_bar` — so every wedge that reaches a client has one, and this costs nothing
   * except in the case it is protecting.
   */
  const clearedTheBar = shipRequires.length > 0 && !unsubstantiated.length && !faults.length;
  if (blocking.length && !clearedTheBar) {
    return { fate: "ask", needs: blocking, reason: "the run named what it still needs from the client" };
  }

  if (leaks.length) {
    return {
      fate: "hold",
      reason: `the summary is written for an operator, not a client (${leaks.slice(0, 3).join(", ")}) — held from the portal`,
    };
  }

  // Reads as a refusal but never said what would fix it. Not a deliverable and not an answerable
  // request; a founder has to look. Holding is the only honest option.
  // Neither kind of ask: not blocked, and nothing it wanted answered. Prose that reads as a refusal
  // with no ask of any sort behind it is a run that stopped for a reason it did not name.
  if (readsAsMissingInput(candidate) && !blocking.length && !questions.length) {
    return {
      fate: "hold",
      reason: "the run stopped for something it did not name — held until a person decides the ask",
    };
  }

  // THE DECLARED SHIP BAR — the compiler's rule, not a trade's.
  //
  // This used to be an `if (geo)` in all but name: it sniffed `status === "reported"` and the
  // shape of `recommendations`, which is the GEO weekly report's schema spelled into the one
  // function that is supposed to be trade-blind. The compiler note calls that the hardcoding
  // problem, and its test is exact: "if we have to write an `if (geo)` branch to make the work
  // real, we do not have a compiler yet."
  //
  // Now the WEDGE declares it. A task type carries `ship_requires: ["recommendations"]` next to
  // its output schema, and this function checks substance generically. A GEO week that measured
  // and named no work holds — same behaviour as before, but because geo-monitor DECLARED that a
  // report without work is a screenshot, not because this file knows what a share-of-voice
  // percentage is. books-keeper can declare `ship_requires: ["questions"]` on a close, and a web
  // wedge can require the change list, without anyone touching this file again.
  if (unsubstantiated.length) {
    return {
      fate: "hold",
      reason: `this work promises \`${unsubstantiated[0]}\` and delivered it empty — held until it says what to do`,
    };
  }

  /**
   * ═══ AND DO THE FIELDS AGREE WITH EACH OTHER ═══
   *
   * Everything above this line passes on output that is confidently wrong. `missingSubstance` is a
   * non-emptiness test, so a monthly close reporting `reconciled: true` beside
   * `difference_cents: 4200` clears every gate — a bookkeeper telling a client the books balance
   * while holding a hole — and so does an invoice whose total disagrees with its own lines.
   *
   * `PLATFORM.md` §6: "our runs prove they finished; they mostly do not prove they were right."
   * These are the cases where being right is arithmetic rather than judgement, so they can be
   * checked here, in the kernel, with no model and the same answer every time. See ship-checks.ts
   * for why the set is closed.
   *
   * HELD, not failed. The work exists and the founder can read it; what changes is that it does not
   * reach a client and does not count toward a track record. A check that failed the whole run would
   * turn one wrong number into half an hour of lost work, and the second time that happened somebody
   * would delete the check.
   */
  if (faults.length) {
    // Every fault, not only the first. The orchestrator hands these back to the agent, and fixing
    // one thing at a time across three rounds is how a repair loop burns its budget without
    // finishing — see the `MAX_SHIP_REPAIR` note in orchestrator.ts.
    return { fate: "hold", reason: faults[0]!.message, faults: faults.map((f) => f.message) };
  }

  /**
   * ═══ A RUN THAT COULD NOT DO PART OF THE JOB DOES NOT GO STRAIGHT TO A CLIENT ═══
   *
   * The runtime already tells the agent what it cannot do this run and asks it to "SAY plainly in
   * your result which step you could not complete and why" (see the `capabilityGaps` block in
   * runtime.ts). That instruction is the right one and it is the last line of defence in the wrong
   * place: it is a REQUEST TO A MODEL, checked by nothing. The failure it is guarding against —
   * work that reads as finished and quietly did three fifths of the job — is exactly the failure a
   * model under pressure produces, and asking the same model to confess it is not an architecture.
   *
   * So the platform decides it instead, from what the platform already knows. No parse of the
   * answer, no search for a disclosure sentence, no model in the path: if the run was short a
   * capability, a human sees it before a client does.
   *
   * HELD, NOT FAILED, and held with NO `faults`. Both halves matter:
   *   · The work is real and often most of the job. The founder reads it, and can send it with the
   *     missing piece filled in by hand, which is a good afternoon rather than a lost one.
   *   · `faults` is what marks a hold REPAIRABLE (see the `MAX_SHIP_REPAIR` loop in
   *     orchestrator.ts). Nothing the agent writes next turn conjures a Gmail connection, so a
   *     repair round here would spend model time to arrive at the same hold. The fix is a founder
   *     connecting an account, and the reason below is what tells them which one.
   *
   * LAST, after the arithmetic. A gapped run whose invoice total is also wrong should report the
   * wrong total — that is the more actionable of the two, and it is the one that is repairable.
   */
  const gaps = args.capabilityGaps ?? [];
  if (gaps.length) {
    return {
      fate: "hold",
      /**
       * The gap strings are whole sentences — `whyNoProvider` returns a capability's `absent` line,
       * "no accounting system is connected to this business, so nothing here can see invoices raised
       * outside Mycel". Slotted after "this run could not" they read as
       *
       *   not delivered — this run could not no accounting system is connected to this business…
       *
       * which is what a founder actually saw on the timeline. The sentence carries itself; it needs
       * a colon, not a verb.
       */
      reason:
        `this run was short of something it needed, so the work is here for you to check before a ` +
        `client sees it: ${gaps[0]}${gaps.length > 1 ? ` (and ${gaps.length - 1} more)` : ""}`,
    };
  }

  /**
   * The questions travel WITH the work, and this is the half that makes separating them honest.
   *
   * Splitting `questions` out of the blocking set means a close with open questions now delivers.
   * If the questions did not go with it, the split would have replaced "the client never sees the
   * work" with something worse: the client sees a close and is never told three transactions are
   * still unclassified, and the founder has no record of having asked.
   *
   * `needs` on a `deliver` verdict is what `openMaterialRequests` reads, so the same requests the
   * client would have received from an `ask` are opened — alongside the deliverable rather than
   * instead of it.
   */
  /**
   * Everything the run wants from the client, deduplicated, riding WITH the work.
   *
   * Both keys, because a run that cleared the bar and still wrote `needs` was naming open items, not
   * refusing — and the close above proved the model writes the same item under both words. Merged
   * and deduped so the client is not asked twice about the same £340 card payment.
   */
  const asks = [...new Set([...blocking, ...questions])];
  return {
    fate: "deliver",
    body: clipToBoundary(weekBody(candidate, parsed), MAX_BODY),
    ...(asks.length ? { needs: asks } : {}),
    reason: asks.length
      ? `client-ready, with ${asks.length} question${asks.length === 1 ? "" : "s"} for the client`
      : "client-ready",
  };
}

/**
 * Which declared ship-bar fields lack substance in this output.
 *
 * ═══ WHAT "SUBSTANCE" MEANS, AND WHAT IS DELIBERATELY OUT OF SCOPE ═══
 *
 * A field has substance when a client could actually read something in it: a non-blank string, a
 * finite number, or an array with at least one entry that itself has substance (a non-blank
 * string, or an object carrying at least one non-blank string value). An array of empty objects is
 * the model dressing an empty answer in the schema's clothes, and it is precisely what this exists
 * to catch — the GEO week that emitted `recommendations: [{}]` would read as work to a length
 * check.
 *
 * Booleans are OUT of scope on purpose. "This field must be true to ship" is a different rule
 * (that is what `needs` and the reconciliation guards are for), and folding it in here would make
 * `ship_requires: ["reconciled"]` silently mean something no one declared.
 *
 * ORDER IS PRESERVED so the hold reason names the FIRST missing field — the wedge listed them by
 * importance, and a founder fixing the run should be pointed at the one that matters most.
 */
export function missingSubstance(parsed: Record<string, unknown> | null, fields: readonly string[]): string[] {
  if (!fields.length) return [];
  const hasSubstance = (v: unknown): boolean => {
    if (typeof v === "string") return v.trim().length > 0;
    if (typeof v === "number") return Number.isFinite(v);
    if (Array.isArray(v)) return v.some(hasSubstance);
    if (v && typeof v === "object") {
      /**
       * RECURSIVE, and it was not — which is why a monthly close could never clear its own bar.
       *
       * This asked only for a non-blank STRING among an object's values. A P&L is
       * `{income_minor: 984000, expenses_minor: 446939}` and a reconciliation is
       * `{opening_minor, closing_minor, difference_minor}`: correct, complete, entirely numeric, and
       * judged empty. books-keeper declares `ship_requires: ["profit_and_loss", "reconciliation"]`,
       * so every close held on "this work promises `profit_and_loss` and delivered it empty" while
       * the P&L sat right there in the output. Every trade that reports figures had the same hole —
       * an invoice total, a tax box, a measured week.
       *
       * The rule it was reaching for is "at least one value that itself has substance", which is
       * this function. Recursing gets that and keeps the case it was written for: `{}` has no values
       * to find, `[{}]` finds an object with no values, and `{what: ""}` finds a blank string. The
       * GEO week that emitted `recommendations: [{}]` is still caught.
       *
       * Booleans stay out of scope, so `{reconciled: true}` alone is still not substance — that is
       * the documented decision above and recursion does not quietly change it.
       */
      return Object.values(v as Record<string, unknown>).some(hasSubstance);
    }
    return false;
  };
  return fields.filter((f) => !hasSubstance(parsed?.[f]));
}

/**
 * The PDF the client opens: where they stand, what to do this week (sized), what happens next.
 * `client_summary` stays the lead. The structured recs are the Friday packet, not a second report.
 */
export function weekBody(summary: string, parsed: Record<string, unknown> | null): string {
  const parts = [summary.trim()];
  const recs = Array.isArray(parsed?.recommendations) ? parsed.recommendations : [];
  const lines: string[] = [];
  for (const r of recs) {
    if (!r || typeof r !== "object" || Array.isArray(r)) continue;
    const o = r as Record<string, unknown>;
    const what = typeof o.what === "string" ? o.what.trim() : "";
    if (!what) continue;
    const effort = typeof o.effort === "string" ? o.effort.trim() : "";
    const why = typeof o.why === "string" ? o.why.trim() : "";
    const size = effort === "small" ? "Hours" : effort === "medium" ? "A day or two" : effort === "large" ? "Weeks" : "";
    lines.push(`- ${size ? `${size}: ` : ""}${what}${why ? ` (${why})` : ""}`);
  }
  if (lines.length) {
    parts.push("", "This week:", ...lines);
  }
  /**
   * ═══ THE QUESTIONS, IN THE DOCUMENT, WITH WHAT WE RECOMMEND ═══
   *
   * They were not here, and everything upstream assumed they were.
   *
   * `delivering-work.md` rule 7 is "every question carries a recommendation", and books-keeper backs
   * it with `ship_checks: each_has questions[].recommendation`, so a close that asks without advising
   * is held. The close then emits four carefully built objects — what it is about, the best guess,
   * why it is ambiguous, what we would do — and this function rendered `client_summary`,
   * `recommendations` and `happens_next`, and dropped every one of them.
   *
   * The client's document therefore said "four items need confirmation" and did not say which four.
   * Two runs in a row they asked for the same thing:
   *
   *   The promised "three questions" are not actually set out as clear, answerable questions with
   *   transaction dates, payees, references and requested evidence.
   *
   *   What is your recommended treatment for each review item, rather than simply asking me to
   *   decide?
   *
   * The recommendations existed. They were written, checked, and delivered to nobody. The requests
   * opened in the portal are the ANSWER channel and were never a substitute for the work saying what
   * it advises — a client reading a close should not have to click into a form to learn what their
   * bookkeeper thinks.
   *
   * Field names are read tolerantly, like `collectAsks`: a wedge outside bookkeeping writes
   * `question`/`detail` rather than `about`, and a body that silently renders nothing for them would
   * be this same bug with a different trade in it.
   */
  const questions = Array.isArray(parsed?.questions) ? parsed.questions : [];
  const asks: string[] = [];
  for (const q of questions) {
    if (typeof q === "string" && q.trim()) {
      asks.push(`- ${q.trim()}`);
      continue;
    }
    if (!q || typeof q !== "object" || Array.isArray(q)) continue;
    const o = q as Record<string, unknown>;
    const str = (...keys: string[]) => {
      for (const k of keys) {
        const v = o[k];
        if (typeof v === "string" && v.trim()) return v.trim();
      }
      return "";
    };
    const about = str("about", "question", "detail", "text", "label", "ask");
    if (!about) continue;
    // The advice, then the fallback that is still advice. A bare `why_asking` is not a recommendation
    // and is not offered as one.
    const advice = str("recommendation", "best_guess");
    const why = str("why_asking", "why", "reason");
    /**
     * ONE bullet, not a bullet and a labelled line under it.
     *
     * The why used to be emitted as `\n  Why I am asking: <sentence>`, which the report parser read
     * as a stat row — short label, colon, value — and drew right-aligned across the question it was
     * explaining. A client's PDF had four of them overlapping into mush.
     *
     * Folded into the sentence it belongs to, it wraps like prose and reads like a person wrote it,
     * which it should have done anyway: "confirm the business purpose. Asking because the bank line
     * does not show who attended."
     */
    const tail = why ? ` Asking because ${why.charAt(0).toLowerCase()}${why.slice(1)}` : "";
    asks.push(`- ${about}${advice ? ` — ${advice}` : ""}${tail}`);
  }
  if (asks.length) {
    parts.push(
      "",
      asks.length === 1 ? "One thing I need from you:" : `${asks.length} things I need from you:`,
      ...asks,
    );
  }

  const next = typeof parsed?.happens_next === "string" ? parsed.happens_next.trim() : "";
  if (next) parts.push("", `What happens next: ${next}`);
  return parts.join("\n");
}

/**
 * How many open questions one engagement may put to a client at once.
 *
 * Three, for the reason books-keeper's `what-not-to-guess` gives about batching: a client with a
 * short list answers it, and a client with a wall of homework answers none of it and starts to
 * wonder what they are paying for.
 */
export const MAX_OPEN_ASKS = 3;

/**
 * Which of these needs actually become new questions.
 *
 * Pure, because the two guards it applies are the ones most likely to be got wrong quietly. The
 * ceiling in particular is the difference between an engagement that asks three things and one that
 * accumulates paraphrases every five minutes forever — and neither failure shows up until a real
 * client is looking at it.
 */
export function asksToOpen(needs: string[], openAsks: string[], ceiling = MAX_OPEN_ASKS): string[] {
  const seen = new Set(openAsks.map((a) => a.trim().toLowerCase()));
  let room = ceiling - openAsks.length;
  const out: string[] = [];
  for (const need of needs) {
    if (room <= 0) break;
    const key = need.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(need);
    room--;
  }
  return out;
}

/**
 * May a RUN put one more question to this client on this engagement?
 *
 * ═══ WHY THIS IS SEPARATE FROM `asksToOpen`, AND WHY BOTH EXIST ═══
 *
 * There are two doors a client question can come through and they had no idea about each other:
 *
 *   1. `openMaterialRequests` — the refusal path, this file's own.
 *   2. The agent's `ask_client` tool — a run deciding mid-episode that it needs something.
 *
 * A single production run used BOTH, and the Brightline case ended up with three distinct questions
 * asked three times each:
 *
 *   "Please confirm that we should start the monthly close for this engagement."   (agent)
 *   "Confirmation that we should start the monthly close"                          (refusal path)
 *   "Confirm we can start the monthly close on this engagement"                    (kickoff)
 *
 * Putting the ceiling in only one door is the same mistake as putting a concurrency guard on one of
 * two writers. So both call this.
 *
 * ═══ WHY KICKOFF IS EXEMPT ═══
 *
 * Kickoff's `intake_asks` are AUTHORED — a person wrote them into the manifest and chose how many
 * an engagement opens with. Generated asks are a model's judgement in the moment, made without
 * sight of what anyone else already asked. Those are the ones that need a ceiling; silently
 * dropping a founder's third declared intake ask would be this module overruling a human decision
 * it knows nothing about.
 */
export function mayAskClient(openAsks: string[], ask: string, ceiling = MAX_OPEN_ASKS): boolean {
  return asksToOpen([ask], openAsks, ceiling).length === 1;
}

/**
 * The sentence a client reads when we ask for their material.
 *
 * Written here rather than by the model on purpose: this is the one message in the fulfilment loop
 * that admits we cannot proceed, and its tone is the difference between "they are on top of this"
 * and "they are stuck". It names the work, asks plainly, and never apologises for needing the thing
 * — a bookkeeper asking for a bank statement is doing their job, not imposing.
 */
export function materialsAsk(caseTitle: string, need: string): { ask: string; detail: string } {
  return {
    ask: need.length > 120 ? `${need.slice(0, 117)}...` : need,
    detail: `We need this to continue with ${caseTitle || "your work"}. You can upload it or reply here.`,
  };
}
