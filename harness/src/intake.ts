// Intake — getting what's in the founder's head into the harness.
//
// This is the part of the product that actually decides quality. The harness is generic; the wedge
// is config; what makes a bookkeeping agent good at *your* bookkeeping is a hundred small judgments
// you already hold — what you charge, when you escalate, which supplier is always late, how you
// phrase a chase so it doesn't sound like a debt collector. None of that is in the code, and asking
// someone to sit down and write markdown files produces either nothing or generic filler.
//
// So the harness asks. Two sources of questions, one queue:
//
//   1. DECLARED — the wedge ships an `intake` list: the things it knows it can't do well without.
//      Authored once by whoever built the wedge, answered once by each founder who runs it.
//
//   2. DISCOVERED — the agent hits something it doesn't know mid-run and records the gap. This is
//      the more valuable half, because it's specific and it's evidence-backed: it happened on a real
//      job. A gap that keeps recurring rises to the top of the queue.
//
// An answer becomes a knowledge item the agent is grounded on. Same store as everything else — this
// isn't a parallel system, it's a front door to the one that already exists.
//
// The deliberate omission: nothing here paraphrases the founder's words with a model. It stores what
// they wrote, verbatim, under a stable name. A "distilled" summary that quietly drops the one clause
// that mattered is worse than no answer, and the founder would have no way to tell.
import type { KnowledgeItem } from "./contract";
import type { DomainStore } from "./domain";

/** A question the wedge declares it needs answered. Authored in wedge.json. */
export interface IntakeQuestion {
  /** Stable id — the answer's knowledge file is named after it, so re-answering updates. */
  id: string;
  /** The question, in the founder's language. */
  ask: string;
  /** Why the business needs it. Founders answer better when they know what it changes. */
  why?: string;
  /** A concrete example answer. The single biggest lever on answer quality. */
  example?: string;
  kind?: KnowledgeItem["kind"];
  /** Roughly how much this matters. Ordered high → low in the queue. */
  weight?: number;
}

/** A gap the agent hit at run time: something it needed and didn't have. */
export interface KnowledgeGap {
  id: string;
  project_id: string;
  wedge: string;
  /** What it needed to know, phrased as a question for the founder. */
  question: string;
  /** What it did instead — so the founder can judge how bad the guess was. */
  fallback?: string;
  /** How many times this has blocked real work. Recurrence is the ranking signal. */
  hits: number;
  task_ids: string[];
  status: "open" | "answered" | "dismissed";
  first_seen: string;
  last_seen: string;
}

// ---------------------------------------------------------------------------------------------
// The seam: a gap only the CLIENT can close is not a gap
// ---------------------------------------------------------------------------------------------
//
// Read the header of `requests.ts` first; this is the other end of the sentence it finishes with.
//
// Everything above assumes the person who can answer is the FOUNDER, and every mechanism here is
// built on that assumption: an answer becomes a `KnowledgeItem` mounted into runs of this wedge,
// ranking is by recurrence across many jobs, and coverage is a percentage of what the BUSINESS
// knows. All three are wrong for "where is your receipt for the 14 March payment?".
//
// THE FAILURE THIS PREVENTS. Before this existed, an agent that needed a document from a customer
// had exactly one thing it could do: `POST /v1/internal/knowledge/gap`. So the question landed in
// the founder's intake queue, where it is unanswerable — the founder does not have the receipt —
// and it sat there accruing `hits` while the run guessed. Worse, if the founder ever DID answer it
// (by pasting what the client eventually emailed them), `recordAnswer` would file that customer's
// document as wedge-scoped grounding mounted into every OTHER customer's run. The intake loop's one
// purpose is the one thing this must never do.
//
// So the routing decision is made HERE, as a pure function, rather than inline at the endpoint:
// which queue a question goes to is a data-protection decision, and it should be readable and
// testable in one place instead of being an `if` buried in a route handler.
//
// The signal is the AGENT'S OWN DECLARATION (`ask_client`), not a guess from the question's
// wording. A regex over English deciding whether a customer gets emailed is the kind of cleverness
// that looks fine in review and then asks nine customers for their bank statements because someone
// wrote a chase template containing the word "your".

/** What an agent reports when it hits something it does not know. */
export interface GapReport {
  question: string;
  /** What it did instead. Only meaningful for a founder gap — see `routeGap`. */
  fallback?: string;
  /**
   * The agent saying "only this run's customer can answer this". Absent means the founder, which is
   * the safe default: a question in the founder's queue is at worst noise, whereas a question sent
   * to a customer is an email from the business that cannot be unsent.
   */
  ask_client?: boolean;
  /** What kind of thing is being asked for. Ignored unless the question routes to the client. */
  kind?: "document" | "answer" | "decision";
  /** Where to find it, what format. Ignored unless the question routes to the client. */
  detail?: string;
}

/** What the run knows about itself. Everything optional, because a task may carry none of it. */
export interface GapContext {
  project_id: string;
  wedge: string;
  task_id: string;
  client_id?: string;
  case_id?: string;
}

export type GapRoute =
  | {
      to: "founder";
      /** Why it went here. Returned to the agent and put on the timeline — never a silent choice. */
      because: string;
      gap: { id: string; project_id: string; wedge: string; question: string; fallback?: string; task_id: string };
    }
  | {
      to: "client";
      because: string;
      /** Shaped for `RequestStore.createRequest`. `client_id` is present by construction. */
      request: {
        project_id: string;
        client_id: string;
        case_id?: string;
        task_id: string;
        kind: "document" | "answer" | "decision";
        ask: string;
        detail?: string;
      };
    };

/**
 * Decide which queue a reported gap belongs in.
 *
 * Three rules, and the second is the one that earns the function:
 *
 *  1. **No `ask_client` → the founder.** Unchanged behaviour, and the default on purpose. See above.
 *  2. **`ask_client` with no client on the run → the founder, and say so.** A `ClientRequest`
 *     without a `client_id` is rejected by `createRequest` (correctly — it is a row every tenant's
 *     portal would have to defend against), so the alternative here is throwing away the agent's
 *     report entirely. An agent that has to admit ignorance and gets a 400 for it will guess
 *     instead, which is the exact failure the ungated gap endpoint exists to avoid. It degrades to
 *     the founder queue with the reason attached, so the founder can see a question their agent
 *     wanted to ask a customer on a run that had no customer attached — which is itself a bug
 *     report worth reading.
 *  3. **Otherwise the client**, and the question becomes a request that BLOCKS the work rather than
 *     a knowledge file that grounds it. Note what does not travel: `fallback`. "What it did
 *     instead" is founder-plane information — telling a customer what the agent guessed about their
 *     own affairs while asking them for the real answer is not a thing a business says.
 */
export function routeGap(report: GapReport, ctx: GapContext): GapRoute {
  const question = report.question.trim();
  const founder = (because: string): GapRoute => ({
    to: "founder",
    because,
    gap: {
      id: gapId(question),
      project_id: ctx.project_id,
      wedge: ctx.wedge,
      question,
      fallback: report.fallback,
      task_id: ctx.task_id,
    },
  });

  if (!report.ask_client) return founder("Only the founder can answer this.");
  if (!ctx.client_id) {
    return founder(
      "The agent asked for this from the client, but this run has no client attached — recorded as a founder gap instead.",
    );
  }
  return {
    to: "client",
    because: "Only this client can answer this, so it was raised as a request that blocks the work.",
    request: {
      project_id: ctx.project_id,
      client_id: ctx.client_id,
      ...(ctx.case_id ? { case_id: ctx.case_id } : {}),
      task_id: ctx.task_id,
      kind: report.kind ?? "answer",
      // The client reads this. It is capped and trimmed by the same function the founder-authored
      // route uses, so an agent cannot post a 40KB "ask" into a customer's portal.
      ask: question.slice(0, 500),
      ...(report.detail ? { detail: report.detail.trim().slice(0, 2000) } : {}),
    },
  };
}

/**
 * A question an agent proposed for THIS business, from what the founder said they sell.
 *
 * The third source, and the one onboarding runs on. Declared questions come from a wedge author who
 * has never met this founder; discovered gaps require a run to have already happened, which on the
 * first screen it has not. Neither can ask a driving school about its cancellation policy.
 *
 * The output of `business-shaper` / `draft_questions`. It is a CANDIDATE list, not a script — the
 * agent proposes and `buildInterview` below decides, because a model asked for questions will
 * cheerfully produce nine and a founder shown nine answers none.
 */
export interface DraftedQuestion {
  id: string;
  ask: string;
  /** Why the business needs it, in the founder's terms. */
  why?: string;
  /**
   * What changes in the agent's behaviour once this is answered. The field that makes the selection
   * defensible: a question that cannot name what it changes is a question that changes nothing, and
   * `buildInterview` drops it.
   */
  decides?: string;
  example?: string;
  weight?: number;
  kind?: KnowledgeItem["kind"];
}

export interface OpenQuestion {
  id: string;
  source: "declared" | "discovered" | "drafted";
  ask: string;
  why?: string;
  example?: string;
  fallback?: string;
  /** How many real jobs this has blocked. 0 for declared questions nobody has hit yet. */
  hits: number;
  /**
   * The wedge author's judgement of how much this question matters, roughly 0–10. Undefined for a
   * discovered gap — nobody authored it, and `hits` is the honest signal there.
   *
   * On the response, not just in the sort: a UI that can't see it can't tell "you haven't answered
   * the question that decides everything" from "you haven't answered a nice-to-have", so it renders
   * five identical rows and the founder answers them in whatever order they appear.
   */
  weight?: number;
  /** What answering it changes. Only drafted questions carry one — see `DraftedQuestion.decides`. */
  decides?: string;
  answered: boolean;
  /** The knowledge item holding the answer, when there is one. */
  knowledge_id?: string;
  answer?: string;
}

export interface Coverage {
  wedge: string;
  total: number;
  answered: number;
  /** 0–100. What share of what this business needs to know, it knows. */
  percent: number;
  questions: OpenQuestion[];
}

/**
 * The knowledge file an intake answer is stored as. Stable, so re-answering updates in place.
 *
 * A CLIENT-scoped answer lives under that client's own segment. Two reasons, and the second is the
 * one that matters: "what is their agreed rate?" has a different answer per client, so a single
 * `intake/<question>.md` would have one client's negotiated rate silently overwrite another's — and
 * the surviving row would then be the one every future run read. The path also makes the scope
 * visible in the founder's own file list, which a metadata field alone does not.
 */
export function intakeFileName(questionId: string, clientId?: string): string {
  return clientId ? `intake/${clientId}/${questionId}.md` : `intake/${questionId}.md`;
}

/**
 * The question an intake file answers, whichever scope it was filed under.
 *
 * Coverage counts a question as answered if ANY answer exists for it, house or per-client.
 * Matching on the literal house path instead would have reported a gap the founder had already
 * answered — on a client's task, which is the only place some questions can be answered — as still
 * open, and kept asking it forever. That counter is the whole point of the gap loop.
 */
export function intakeQuestionOf(name: string): string | undefined {
  return /^intake\/(?:[^/]+\/)?(.+)\.md$/.exec(name)?.[1];
}

const GAP_PREFIX = "gap:";

/** Normalise a question into a stable id, so the same gap asked twice lands on one row. */
export function gapId(question: string): string {
  return (
    GAP_PREFIX +
    question
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60)
  );
}

export function isGapId(id: string): boolean {
  return id.startsWith(GAP_PREFIX);
}

/**
 * Merge the wedge's declared questions with the gaps the agent discovered, mark what's answered, and
 * order the result: unanswered first, then by how often it has actually blocked work, then by the
 * wedge author's weight. Evidence outranks opinion — a question that stopped three real jobs matters
 * more than one someone thought would matter.
 */
export function buildCoverage(
  wedge: string,
  declared: IntakeQuestion[],
  gaps: KnowledgeGap[],
  knowledge: KnowledgeItem[],
): Coverage {
  // Keyed by the QUESTION, not the path, so a client-scoped answer still marks its question
  // answered. See `intakeQuestionOf`.
  const byName = new Map<string, KnowledgeItem>();
  for (const k of knowledge) {
    const q = intakeQuestionOf(k.name);
    if (q && !byName.has(q)) byName.set(q, k);
  }
  const gapByQuestion = new Map(gaps.map((g) => [g.id, g]));

  const questions: OpenQuestion[] = [];

  for (const q of declared) {
    const item = byName.get(q.id);
    questions.push({
      id: q.id,
      source: "declared",
      ask: q.ask,
      why: q.why,
      example: q.example,
      // A declared question can also have been hit for real; that's worth showing.
      hits: gapByQuestion.get(q.id)?.hits ?? 0,
      weight: q.weight,
      answered: !!item,
      knowledge_id: item?.id,
      answer: item?.content,
    });
  }

  const declaredIds = new Set(declared.map((q) => q.id));
  for (const g of gaps) {
    if (g.status === "dismissed" || declaredIds.has(g.id)) continue;
    const item = byName.get(g.id);
    questions.push({
      id: g.id,
      source: "discovered",
      ask: g.question,
      why: `The agent hit this on ${g.hits === 1 ? "a real job" : `${g.hits} real jobs`}.`,
      fallback: g.fallback,
      hits: g.hits,
      answered: !!item,
      knowledge_id: item?.id,
      answer: item?.content,
    });
  }

  // The weight now travels on the question itself, so the sort reads it from there rather than
  // rebuilding a lookup — one source, and the order the API returns matches the field it exposes.
  questions.sort((a, b) => {
    if (a.answered !== b.answered) return a.answered ? 1 : -1;
    if (a.hits !== b.hits) return b.hits - a.hits;
    return (b.weight ?? 0) - (a.weight ?? 0);
  });

  const answered = questions.filter((q) => q.answered).length;
  return {
    wedge,
    total: questions.length,
    answered,
    /**
     * NO QUESTIONS MEANS NOTHING IS KNOWN — 0%, NOT 100%.
     *
     * This returned `100` for an empty question set, on the vacuous-truth reading that every
     * question that exists has been answered. Every consumer reads it as "how much of this business
     * has been taught", and under that reading it is a fabrication.
     *
     * OBSERVED IN PRODUCTION: with shaping failing 100% of the time, no wedge intake and no gaps
     * ever existed, so `/setup` rendered "0 of 0 questions answered — 100% covered" and ticked the
     * step Done, on an account that had taught it nothing and could not have. The Work page's own
     * copy promises "a failed one says why it failed rather than reporting a hollow success"; this
     * was the product doing the opposite on the screen the funnel ends on.
     *
     * An empty denominator is not evidence of coverage. It is the absence of evidence, and the
     * honest number for that is zero.
     */
    percent: questions.length ? Math.round((answered / questions.length) * 100) : 0,
    questions,
  };
}

// ---------------------------------------------------------------------------------------------
// The interview — choosing which few questions are worth a founder's patience
// ---------------------------------------------------------------------------------------------
//
// `buildCoverage` above answers "what does this business still not know?" and is right to be
// exhaustive: it backs a page someone opens on purpose, to work through a queue.
//
// This is the other problem, and it is the harder one. During onboarding nobody has opted into a
// queue. The founder's brief was one word where it mattered — swift — and the founder named the
// hard part directly: "first it should ask what are the good questions to ask. Like, we should only
// ask the high-quality ones, the ones that matter."
//
// So QUESTION SELECTION IS THE FEATURE, and it is deterministic code rather than a second prompt.
// A model asked "which of your questions matter?" will rank its own output favourably and cannot be
// tested; this function can be, and every question it returns carries `selected_because` — one
// sentence naming the evidence that put it in the interview. The UI prints it. A question whose
// reason would embarrass us on screen is a question we should not be asking.
//
// The ordering is EVIDENCE FIRST, the same rule `buildCoverage` sorts by, for the same reason: a
// gap that stopped a real job outranks anything anyone imagined would matter.

/** A question that made the cut, with the reason it did. */
export interface SelectedQuestion extends OpenQuestion {
  /** Why this one is being asked, in a sentence the founder can read. */
  selected_because: string;
}

/** A candidate that did not make the cut, with the reason. Nothing is dropped silently. */
export interface DroppedQuestion {
  id: string;
  ask: string;
  reason: string;
}

export interface Interview {
  wedge: string;
  /** The questions to ask, in order. Never more than `budget`. */
  questions: SelectedQuestion[];
  /** Everything considered and rejected, with reasons. The selection, made inspectable. */
  dropped: DroppedQuestion[];
  /** How many of `questions` already have an answer — the conversation resumes rather than repeats. */
  answered: number;
  budget: number;
}

/**
 * How many questions an onboarding conversation gets.
 *
 * Not a tuning constant so much as a product decision. Five is about the number of turns someone
 * will sit through before they start looking for the way out, and every question past the point of
 * diminishing patience does not merely fail to help — it costs the answers to the ones already
 * asked, because a founder who abandons the flow at question seven has given us six answers we
 * never distilled and a first impression of paperwork.
 */
export const INTERVIEW_BUDGET = 5;

/** Two questions are the same question if they read the same. Cheap, and catches the real case. */
function askKey(ask: string): string {
  return ask
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Choose the interview.
 *
 * The rules, in the order they apply — this list IS the selection logic and is meant to be read
 * next to the code:
 *
 *  1. **A question must name what it changes.** A drafted question with no `decides` and no `why`
 *     is dropped outright, however plausible it reads. This is the filter that removes generic
 *     filler ("what are your business hours?"), because filler cannot survive being asked to state
 *     its consequence.
 *  2. **Evidence outranks opinion.** A discovered gap that has blocked N real jobs sorts above
 *     everything, by N.
 *  3. **Specific outranks generic.** A question drafted from what this founder actually said beats
 *     a wedge author's declared question, which was written before anyone knew who would answer it.
 *     Declared questions are still in the pool — they encode what a wedge genuinely cannot do well
 *     without — but they come second.
 *  4. **Duplicates collapse onto the stable id.** If the agent drafts a question the wedge already
 *     declares, the declared one wins, so the answer lands on the knowledge file the agent already
 *     reads rather than on a parallel one it doesn't.
 *  5. **Answered questions still count against the budget and stay in the list.** They are shown as
 *     already answered rather than re-asked, which is what makes a resumed conversation feel like
 *     being remembered instead of like starting over.
 *  6. **The budget is hard.** Everything past it is dropped with "the interview was already full",
 *     not quietly truncated.
 */
export function buildInterview(args: {
  wedge: string;
  /** Proposed by `draft_questions` for this specific business. */
  drafted: DraftedQuestion[];
  /** The wedge's authored `intake` list. */
  declared: IntakeQuestion[];
  gaps: KnowledgeGap[];
  knowledge: KnowledgeItem[];
  budget?: number;
}): Interview {
  const budget = args.budget ?? INTERVIEW_BUDGET;
  // By question rather than by path, for the same reason as `buildCoverage`: an answer filed under
  // a client still answers the question, and the interview must stop asking it.
  const byQuestion = new Map<string, KnowledgeItem>();
  for (const k of args.knowledge) {
    const q = intakeQuestionOf(k.name);
    if (q && !byQuestion.has(q)) byQuestion.set(q, k);
  }
  const dropped: DroppedQuestion[] = [];

  // Rank is the sort key AND the explanation, held together so the two cannot drift: whatever put a
  // question at the top is the sentence printed under it.
  interface Candidate {
    q: OpenQuestion;
    /** Higher wins. Tiers, not a blend — a blended score is a score nobody can explain. */
    tier: number;
    within: number;
    because: string;
  }
  const candidates: Candidate[] = [];
  const seen = new Set<string>();

  const answeredItem = (id: string) => byQuestion.get(id);

  // Rule 2 — evidence. Gaps the agent hit on real work in THIS project.
  for (const g of args.gaps) {
    if (g.status === "dismissed") continue;
    const item = answeredItem(g.id);
    seen.add(askKey(g.question));
    candidates.push({
      q: {
        id: g.id,
        source: "discovered",
        ask: g.question,
        why: `The agent hit this on ${g.hits === 1 ? "a real job" : `${g.hits} real jobs`}.`,
        fallback: g.fallback,
        hits: g.hits,
        answered: !!item,
        knowledge_id: item?.id,
        answer: item?.content,
      },
      tier: 3,
      within: g.hits,
      because:
        g.hits === 1
          ? "The agent already needed this on a real job and had to guess."
          : `The agent has needed this on ${g.hits} real jobs and guessed every time.`,
    });
  }

  // Rule 3 — specific. Drafted for this business, from what the founder said they sell.
  for (const d of args.drafted) {
    const key = askKey(d.ask);
    if (!d.ask.trim()) continue;
    // Rule 1 — a question that cannot say what it changes changes nothing.
    if (!d.decides?.trim() && !d.why?.trim()) {
      dropped.push({ id: d.id, ask: d.ask, reason: "It couldn't say what answering it would change." });
      continue;
    }
    // Rule 4 — the wedge already asks this, under an id the agent already reads.
    const declaredDupe = args.declared.find((q) => askKey(q.ask) === key);
    if (declaredDupe) {
      dropped.push({
        id: d.id,
        ask: d.ask,
        reason: `Already asked as "${declaredDupe.id}" — the answer belongs on that file.`,
      });
      continue;
    }
    if (seen.has(key)) {
      dropped.push({ id: d.id, ask: d.ask, reason: "A question already in the interview asks this." });
      continue;
    }
    seen.add(key);
    const item = answeredItem(d.id);
    candidates.push({
      q: {
        id: d.id,
        source: "drafted",
        ask: d.ask,
        why: d.why,
        example: d.example,
        decides: d.decides,
        hits: 0,
        weight: d.weight,
        answered: !!item,
        knowledge_id: item?.id,
        answer: item?.content,
      },
      tier: 2,
      within: d.weight ?? 0,
      // `why` FIRST, and that ordering is the whole fix.
      //
      // The interview renders two lines per question: "Why we're asking: <selected_because>" and
      // "What it changes: <decides>". Deriving `because` from `decides` made both lines the same
      // sentence, word for word — every drafted question in every interview printed itself twice,
      // and the independent reason the drafter actually wrote (`why`, carried on the question just
      // above) was rendered nowhere at all. Two lines that agree carry one line's information and
      // cost twice the reading.
      because:
        d.why?.trim() ||
        (d.decides?.trim()
          ? `Your answer decides ${d.decides.trim().replace(/\.$/, "")}.`
          : "Drafted from what you told us you sell."),
    });
  }

  // Rule 3, second half — the wedge's own declared questions.
  for (const q of args.declared) {
    const key = askKey(q.ask);
    if (seen.has(key)) continue;
    seen.add(key);
    const item = answeredItem(q.id);
    candidates.push({
      q: {
        id: q.id,
        source: "declared",
        ask: q.ask,
        why: q.why,
        example: q.example,
        hits: 0,
        weight: q.weight,
        answered: !!item,
        knowledge_id: item?.id,
        answer: item?.content,
      },
      tier: 1,
      within: q.weight ?? 0,
      because: "The work you're about to run can't be done well without it.",
    });
  }

  candidates.sort((a, b) => b.tier - a.tier || b.within - a.within || a.q.ask.localeCompare(b.q.ask));

  const questions: SelectedQuestion[] = [];
  for (const c of candidates) {
    if (questions.length >= budget) {
      // Rule 6. Named, not truncated — a founder who asks "is that all you wanted to know?" and a
      // developer debugging "why wasn't X asked?" get the same honest answer from one place.
      dropped.push({ id: c.q.id, ask: c.q.ask, reason: "The interview was already full." });
      continue;
    }
    questions.push({ ...c.q, selected_because: c.because });
  }

  return {
    wedge: args.wedge,
    questions,
    dropped,
    answered: questions.filter((q) => q.answered).length,
    budget,
  };
}

/**
 * Store an answer as knowledge. Idempotent on the question id, so correcting an answer replaces it
 * rather than leaving the agent grounded on two contradictory versions of your pricing.
 *
 * EVERY ANSWER IS LABELLED. `sensitivity` is required and has no default here on purpose: this
 * function wrote the rows that leaked. It filed a founder's answer with `{ intake: true }` and no
 * client attribution at all, retrieval read an absent client as "belongs to everyone", and the
 * `intake` flag then scored it +15 — so a sentence about one client's overdue invoice was mounted,
 * near the top of the index, into every other client's run. A default would let the next call site
 * reintroduce that by omission, which is exactly how it happened the first time.
 *
 * `clientId` is required whenever `sensitivity` is `client`, enforced by the parameter type: a
 * client-sensitive fact with no owner is unreadable by anyone (see `mayMount`), so accepting one
 * would be silently discarding the founder's answer.
 */
export async function recordAnswer(
  domain: DomainStore,
  args: {
    projectId: string;
    wedge: string;
    questionId: string;
    ask: string;
    answer: string;
    kind?: KnowledgeItem["kind"];
  } & (
    | { sensitivity: "house"; clientId?: undefined }
    | { sensitivity: "client"; clientId: string }
  ),
): Promise<KnowledgeItem> {
  const name = intakeFileName(args.questionId, args.clientId);
  // The question is kept alongside the answer: months later, "$45" on its own is unreadable, and
  // the agent reads this file as prose too.
  const content = `# ${args.ask}\n\n${args.answer.trim()}\n`;
  // The project filter now lives in the query rather than after it. Post-filtering was correct here
  // but it read every tenant's rows to find one, and the pattern is how the leak elsewhere survived.
  const existing = (await domain.listKnowledge(args.wedge, args.projectId)).find((k) => k.name === name);
  if (existing) {
    const updated = await domain.updateKnowledge(existing.id, { content });
    if (updated) return updated;
  }
  return domain.createKnowledge({
    project_id: args.projectId,
    wedge: args.wedge,
    name,
    content,
    kind: args.kind ?? "fact",
    source: "authored",
    metadata: {
      intake: true,
      question_id: args.questionId,
      question: args.ask,
      // Both, always. `sensitivity` decides whether it may be mounted at all; `client_id` decides
      // for whom. Writing one without the other is what produced a row nobody could scope.
      sensitivity: args.sensitivity,
      ...(args.clientId ? { client_id: args.clientId } : {}),
    },
  });
}
