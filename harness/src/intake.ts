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

export interface OpenQuestion {
  id: string;
  source: "declared" | "discovered";
  ask: string;
  why?: string;
  example?: string;
  fallback?: string;
  /** How many real jobs this has blocked. 0 for declared questions nobody has hit yet. */
  hits: number;
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

/** The knowledge file an intake answer is stored as. Stable, so re-answering updates in place. */
export function intakeFileName(questionId: string): string {
  return `intake/${questionId}.md`;
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
  const byName = new Map(knowledge.map((k) => [k.name, k]));
  const gapByQuestion = new Map(gaps.map((g) => [g.id, g]));

  const questions: OpenQuestion[] = [];

  for (const q of declared) {
    const item = byName.get(intakeFileName(q.id));
    questions.push({
      id: q.id,
      source: "declared",
      ask: q.ask,
      why: q.why,
      example: q.example,
      // A declared question can also have been hit for real; that's worth showing.
      hits: gapByQuestion.get(q.id)?.hits ?? 0,
      answered: !!item,
      knowledge_id: item?.id,
      answer: item?.content,
    });
  }

  const declaredIds = new Set(declared.map((q) => q.id));
  for (const g of gaps) {
    if (g.status === "dismissed" || declaredIds.has(g.id)) continue;
    const item = byName.get(intakeFileName(g.id));
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

  const weight = new Map(declared.map((q) => [q.id, q.weight ?? 0]));
  questions.sort((a, b) => {
    if (a.answered !== b.answered) return a.answered ? 1 : -1;
    if (a.hits !== b.hits) return b.hits - a.hits;
    return (weight.get(b.id) ?? 0) - (weight.get(a.id) ?? 0);
  });

  const answered = questions.filter((q) => q.answered).length;
  return {
    wedge,
    total: questions.length,
    answered,
    percent: questions.length ? Math.round((answered / questions.length) * 100) : 100,
    questions,
  };
}

/**
 * Store an answer as knowledge. Idempotent on the question id, so correcting an answer replaces it
 * rather than leaving the agent grounded on two contradictory versions of your pricing.
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
  },
): Promise<KnowledgeItem> {
  const name = intakeFileName(args.questionId);
  // The question is kept alongside the answer: months later, "£45" on its own is unreadable, and
  // the agent reads this file as prose too.
  const content = `# ${args.ask}\n\n${args.answer.trim()}\n`;
  const existing = (await domain.listKnowledge(args.wedge)).find(
    (k) => k.name === name && k.project_id === args.projectId,
  );
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
    metadata: { intake: true, question_id: args.questionId, question: args.ask },
  });
}
