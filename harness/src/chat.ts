// The front door — one text box, two completely different things a founder can put in it.
//
// ═══ THE PROBLEM, STATED EXACTLY ═══
//
//   "who owes me money?"            → a QUESTION. ask.ts answers it from state, with citations.
//   "chase everyone who owes me"    → a REQUEST. That is work: six emails to six clients.
//
// They arrive through the same input, one character apart in intent and a world apart in
// consequence. Routing them is this module's whole job.
//
// ═══ THE RULE THAT MAKES THIS SAFE, AND IT IS A STRUCTURAL ONE ═══
//
// A REQUEST IS NEVER CARRIED OUT BY THIS FILE. There is exactly one line in here that causes
// anything to happen in the world, and it is a call to `takeMove` — the same function the "Take this
// on" button on the home surface calls, through the same `MoveAuthority`, which re-proposes under
// that authority before acting, applies `takeability`, applies the dunning ladder's claim, spawns the
// wedge's own carrier run, and lands that run in front of `awaitApproval` before a single byte leaves
// the building.
//
// So the chat is not a second way to make things happen. It is a second way to REACH the first way.
// Everything that gates a founder clicking a button — the carrier gate, the pacing claim, the tenant
// re-proposal, policy, ceilings, Approvals — applies here because it is not re-implemented here.
// `chat.test.ts` asserts that by taking the same move down both paths and comparing the refusals,
// and by taking a carrier-less kind through the chat and getting `no_carrier` back.
//
// ═══ AND THE RULE THAT MAKES IT HONEST ═══
//
// A MODEL CLASSIFIES; A MODEL NEVER AUTHORISES. `classifyIntent` may return `request`, and a request
// resolves to a NAMED LIST OF MOVES the founder is shown and must confirm. The model's output cannot
// become an action in one turn, so the worst a misclassification can do is show someone a list of six
// chases and ask whether they meant it. That is a bad guess with a visible cost of one click — not a
// bad guess that emailed six clients.
//
// When the sentence is genuinely both ("how much do they owe and can you chase them"), we say so and
// ask. vision.md: gates at consequence, and no fully-autonomous theatre.
//
// ═══ TENANCY ═══
//
// Same discipline as ask.ts, and for the same reason: there is no `project_id: string` parameter
// anywhere in this file. Authorities are branded, derived by their own modules from the session's
// project, and passed down untouched. There is nothing here for a route to forget.
import { getDeliverableStore } from "./deliverables";
import { ask, type AskAttachment, type AskAuthorities, type AskResult, type AskStores } from "./ask";
import { takeMove, type Move, type MoveStores, type TakeOutcome } from "./moves";
import { chatComplete } from "./litellm";

// ── bounds ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Longest message accepted.
 *
 * Larger than `ask.MAX_QUESTION` (500) because the composer is multiline now and a founder pasting a
 * client's three-paragraph email and asking "what do I do about this" is the product working. It is
 * still a ceiling: past this it is a document, and a document belongs on an attachment where it is
 * bounded, named and cited separately.
 */
export const MAX_MESSAGE = 4_000;

/**
 * Moves one confirmation may take.
 *
 * "Chase everyone who owes me money" against a business with forty overdue invoices must not be one
 * click that starts forty runs. Ten is roughly a screenful — the number a founder can actually read
 * before agreeing to it — and the remainder stays on the list for a second, deliberate confirmation.
 */
export const MAX_TAKE = 10;

/** Moves a request resolves to. Same ceiling `ask` already applies to the moves it returns. */
export const MAX_PROPOSED = 5;

// ── intent ───────────────────────────────────────────────────────────────────────────────────────

export type IntentKind = "question" | "request" | "ambiguous";

export interface IntentVerdict {
  kind: IntentKind;
  /** How the verdict was reached. Surfaced in traces, never in the founder's answer. */
  by: "heuristic" | "model";
  /** One clause, for the log. */
  reason: string;
}

/**
 * Verbs that mean "do this", at the head of a sentence.
 *
 * Deliberately verbs of CONSEQUENCE and their neighbours, not every verb in English. "Tell me",
 * "show", "list" and "explain" are reads and are absent on purpose — a founder saying "show me who
 * owes me" is asking, and treating it as work would put a confirmation gate in front of a question,
 * which trains people to click through gates.
 */
const ACT_VERBS = new Set([
  "chase","chases","chasing","send","sends","email","emails","remind","reminds","nudge","nudges",
  "follow","followup","ping","pings","invoice","invoices","bill","bills","charge","charges",
  "collect","collects","draft","drafts","write","writes","start","starts","run","begin","kick",
  "close","closes","cancel","publish","post","reply","respond","chaseup","escalate","push",
]);

/** Words that open a question, and the ones that carry no verb of their own. */
const ASK_HEADS = new Set([
  "who","what","when","where","why","which","how","whose","is","are","was","were","do","does","did",
  "can","could","should","would","will","has","have","had","am","tell","show","list","explain",
  "summarise","summarize","describe",
]);

/** Words that make a sentence a wish rather than an order — "can you chase them" is still work. */
const POLITE_HEADS = new Set(["can","could","would","will","please","pls"]);

const words = (s: string): string[] =>
  s.toLowerCase().split(/[^\p{L}\p{N}']+/u).filter(Boolean);

/**
 * The intent a sentence has on its face, with no model involved.
 *
 * THIS IS NOT A FALLBACK. It runs first, it is what ships when LiteLLM is unconfigured or slow, and
 * — critically — it is the FLOOR the model may not go under: `classifyIntent` lets a model turn a
 * heuristic `question` into `ambiguous` and back, but the safe direction is always available and
 * always cheap. A grounded-answering product whose front door stops routing when a proxy is down is
 * a front door that locks.
 *
 * The default is `question`, and that asymmetry is the whole design. Answering a request is a wasted
 * paragraph. Acting on a question is an email to a client. Only one of those is recoverable.
 */
export function heuristicIntent(message: string): IntentVerdict {
  const w = words(message);
  if (!w.length) return { kind: "question", by: "heuristic", reason: "empty" };

  const head = w.slice(0, 3);
  /**
   * "can you chase", "could you please send", "and can you chase them" — the polite opener is not
   * the verb, and there are usually one or two words ("you", "please") between them. So an act verb
   * counts wherever it appears if a polite head sits within the two tokens before it, not only
   * immediately before it. A one-token window read "can you chase them" as a pure question, which is
   * the single most common way a founder asks for work and the worst thing to misread as idle
   * curiosity.
   */
  const POLITE_WINDOW = 2;
  const politelyOrdered = w.some(
    (t, i) => ACT_VERBS.has(t) && w.slice(Math.max(0, i - POLITE_WINDOW), i).some((p) => POLITE_HEADS.has(p)),
  );
  const acts = head.some((t) => ACT_VERBS.has(t)) || politelyOrdered;
  const asksHead = ASK_HEADS.has(w[0]!) && !(POLITE_HEADS.has(w[0]!) && acts);
  const asksMark = /\?\s*$/.test(message.trim());
  const asks = asksHead || asksMark;

  if (acts && asks) return { kind: "ambiguous", by: "heuristic", reason: "an imperative and a question in one sentence" };
  if (acts) return { kind: "request", by: "heuristic", reason: `imperative verb (${head.find((t) => ACT_VERBS.has(t)) ?? "act"})` };
  return { kind: "question", by: "heuristic", reason: asks ? "interrogative" : "no imperative" };
}

const CLASSIFY_SYSTEM = [
  "Classify one message a business owner typed into their operations software.",
  "Answer with exactly one word and nothing else:",
  "  question  — they want to know something about their business. Answering is enough.",
  "  request   — they are telling the software to do work: send, chase, draft, invoice, remind.",
  "  ambiguous — it could genuinely be either, or it asks something AND orders something.",
  "Rules: a polite order ('can you chase them') is a request. 'show me', 'list', 'how much' are questions.",
  "If you are not sure, answer ambiguous. Never explain. One word.",
].join("\n");

export interface ClassifyOptions {
  /** The org whose LiteLLM key pays for the classification. Absent ⇒ heuristic only. */
  orgId?: string;
  /** Injectable for tests. Defaults to `chatComplete` on the cheap tier. */
  classify?: (args: { system: string; user: string }) => Promise<string | undefined>;
}

/**
 * Heuristic first, model second, and the model may only move the verdict along a fixed path.
 *
 * The model is allowed to say `ambiguous` about anything, and allowed to agree. It is NOT allowed to
 * turn a heuristic `question` straight into a `request`: a sentence with no imperative verb in it
 * that a model has decided is an order is exactly the misread we cannot afford, and the honest
 * product answer when the two disagree in that direction is to ask. It IS allowed to soften a
 * heuristic `request` to `question` or `ambiguous`, because both of those directions are safer than
 * the verdict they replace.
 */
export async function classifyIntent(message: string, opts: ClassifyOptions = {}): Promise<IntentVerdict> {
  const base = heuristicIntent(message);
  const classifier =
    opts.classify ??
    (opts.orgId
      ? async ({ system, user }: { system: string; user: string }) =>
          // `fast`, and clamped by `resolveTier` against the org's plan like every other model call in
          // the kernel. One word of output does not need a deep model, and this runs on every single
          // thing anybody types — a `deep` classifier would cost more than the answer it routes to.
          chatComplete({ orgId: opts.orgId as string, tier: "fast", system, user, maxTokens: 4, timeoutMs: 6_000 })
      : undefined);
  if (!classifier) return base;

  const raw = await classifier({ system: CLASSIFY_SYSTEM, user: message.slice(0, MAX_MESSAGE) }).catch(() => undefined);
  const said = String(raw ?? "").toLowerCase().match(/question|request|ambiguous/)?.[0];
  if (!said) return base;

  if (said === base.kind) return { ...base, by: "model", reason: `${base.reason}; model agreed` };
  if (base.kind === "question" && said === "request") {
    return { kind: "ambiguous", by: "model", reason: "no imperative in the text, but the model read it as an order" };
  }
  return { kind: said as IntentKind, by: "model", reason: `heuristic said ${base.kind}, model said ${said}` };
}

// ── the turn ─────────────────────────────────────────────────────────────────────────────────────

export interface ChatInput {
  message: string;
  /** Text of documents attached to THIS turn. See `AskOptions.attachments` for where they do not go. */
  attachments?: AskAttachment[];
  /**
   * Move ids the founder has explicitly agreed to, having seen them named on screen.
   *
   * The ONLY field on this input that can cause anything to happen, and it cannot be produced by a
   * model — it is echoed back from a list the previous turn returned. A route may not synthesise it
   * from the message text, and `takeMove` would refuse an id that is not in the live proposal anyway.
   */
  confirm?: string[];
}

export type Disposition =
  /** A question, answered. */
  | "answered"
  /** A request, resolved to named moves that are waiting for a click. Nothing has happened. */
  | "awaiting_confirmation"
  /** A request we could not turn into any move this business can carry. Nothing has happened. */
  | "no_carrier"
  /** Genuinely both. We asked. Nothing has happened. */
  | "clarify"
  /** A confirmation. `takeMove` ran; every outcome, including refusals, is in `taken`. */
  | "taken";

export interface ChatResult {
  intent: IntentKind;
  disposition: Disposition;
  /**
   * Always present, even for a request.
   *
   * "Chase everyone who owes me money" deserves to be shown WHO and HOW MUCH before it is agreed to,
   * with the citations that prove the list is real. A confirmation dialog that names six clients and
   * cannot show you their balances is asking you to trust it, which is the opposite of the argument
   * this product makes.
   */
  answer: AskResult;
  /** What the request resolved to. Empty for a question. Never acted on without `confirm`. */
  proposed: Move[];
  /** The question back, when the sentence was both. */
  clarify?: string;
  /** One outcome per confirmed id, in the order confirmed. Refusals are outcomes, not errors. */
  taken?: TakeOutcome[];
  /** How the verdict was reached. For traces and for the tests; not for the founder's paragraph. */
  intent_by: IntentVerdict["by"];
  intent_reason: string;
}

export interface ChatOptions extends ClassifyOptions {
  /** Passed through to `ask` for grounded composition. Same org, same key, same tiering. */
  compose?: (args: { system: string; user: string }) => Promise<string | undefined>;
}

/**
 * One turn of the front door.
 *
 * ORDER MATTERS AND IT IS THIS: confirmations are handled before anything else, because a
 * confirmation is not a sentence to be understood — it is a decision already made, naming ids the
 * previous turn produced. Re-classifying it would put a model between a founder's click and the
 * action they clicked, which is a place a model has no business being.
 */
export async function chat(
  stores: AskStores,
  auths: AskAuthorities,
  input: ChatInput,
  opts: ChatOptions = {},
): Promise<ChatResult> {
  const message = String(input.message ?? "").trim().slice(0, MAX_MESSAGE);
  const attachments = (input.attachments ?? []).slice(0, 4);
  const confirmed = [...new Set((input.confirm ?? []).map((s) => String(s ?? "").trim()).filter(Boolean))].slice(
    0,
    MAX_TAKE,
  );

  const answerFor = () => ask(stores, auths, message, { orgId: opts.orgId, compose: opts.compose, attachments });

  // ── the confirmation path ──────────────────────────────────────────────────
  //
  // Every id goes through `takeMove` under the SAME `MoveAuthority` the proposal was drawn under.
  // Sequentially, not in parallel: two chases against the same client racing each other through the
  // dunning ladder's compare-and-set is a coin flip about which one wins, and a founder watching a
  // list resolve wants it to resolve in the order they read it.
  if (confirmed.length) {
    const moveStores: MoveStores = { domain: stores.domain, billing: stores.billing, requests: stores.requests, deliverables: getDeliverableStore() };
    const taken: TakeOutcome[] = [];
    for (const id of confirmed) taken.push(await takeMove(moveStores, auths.moves, id));
    return {
      intent: "request",
      disposition: "taken",
      /**
       * The state AFTER the takes when there is a question to answer — and NOTHING when there is
       * not.
       *
       * A confirmation usually arrives with no message: the founder pressed a button. Running the
       * grounded answer over an empty string returns `insufficient: "Ask a question."`, and the
       * first build of this rendered that under the outcomes — "NOT ENOUGH TO ANSWER · Ask a
       * question" stapled to three chases that had just started successfully. It read as a failure
       * of the thing that had just worked. The outcomes ARE the answer to a click.
       */
      answer: message
        ? await answerFor()
        : { answer: "", cited: [], moves: [], unseen: 0 },
      proposed: [],
      taken,
      intent_by: "heuristic",
      intent_reason: "confirmed move ids — not classified",
    };
  }

  const verdict = await classifyIntent(message, opts);
  const answer = await answerFor();
  const base = { intent: verdict.kind, answer, intent_by: verdict.by, intent_reason: verdict.reason };

  if (verdict.kind === "question") return { ...base, disposition: "answered", proposed: [] };

  /**
   * A request resolves to moves — and it resolves to the moves `ask` ALREADY FOUND.
   *
   * Not a second proposal drawn with a second set of filters. `ask` narrowed `proposeMoves` to what
   * the question is actually about (the entities retrieval turned up, or the money moves for a money
   * question), under the same authority, and a request is the same sentence with a different mood.
   * Two narrowings would be two answers to "which six clients", and the one on screen would not be
   * the one that gets acted on.
   */
  const proposed = answer.moves.slice(0, MAX_PROPOSED);

  if (!proposed.length) {
    return {
      ...base,
      disposition: "no_carrier",
      proposed: [],
      clarify:
        answer.cited.length > 0
          ? "I can see the situation but there is no move in this business that carries that yet, so it is still yours to do by hand."
          : "I could not find anything here to act on. Tell me which client or invoice you mean.",
    };
  }

  if (verdict.kind === "ambiguous") {
    return { ...base, disposition: "clarify", proposed, clarify: clarifyQuestion(proposed) };
  }

  return { ...base, disposition: "awaiting_confirmation", proposed };
}

/**
 * The sentence we ask back when the message was both.
 *
 * Built from the resolved moves rather than from a model, because it must name the SAME COUNT the
 * confirm button will act on. A model-written "shall I chase a few of these?" over a list of six is
 * a small lie in the one place a founder is being asked to consent.
 */
export function clarifyQuestion(moves: Move[]): string {
  const n = moves.length;
  const verb = moves.every((m) => m.kind === "chase_invoice")
    ? n === 1
      ? "chase this invoice"
      : `chase these ${n} invoices`
    : n === 1
      ? "take this on"
      : `take these ${n} on`;
  return `Do you want me to ${verb}, or were you asking about them? Nothing has been sent.`;
}
