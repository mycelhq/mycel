import { randomUUID } from "node:crypto";

/**
 * A suggestion produced by a reflection run. This is deliberately not a Rule: model output is a
 * hypothesis until a human accepts it, and putting it straight into retrieval would let the
 * system teach itself unsupported facts.
 */
export type ImprovementTarget = "memory" | "procedure" | "artifact" | "capability" | "guardrail";
export type ImprovementStatus = "proposed" | "approved" | "rejected" | "applied";
export type ImprovementConfidence = "low" | "medium" | "high";

export interface ImprovementProposal {
  id: string;
  project_id: string;
  wedge: string;
  task_id: string;
  task_type: string;
  target: ImprovementTarget;
  title: string;
  summary: string;
  proposed_change: string;
  evidence: string[];
  confidence: ImprovementConfidence;
  status: ImprovementStatus;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export type NewImprovementProposal = Omit<
  ImprovementProposal,
  "status" | "created_at" | "updated_at"
>;

const TARGETS: readonly ImprovementTarget[] = ["memory", "procedure", "artifact", "capability", "guardrail"];
const CONFIDENCES: readonly ImprovementConfidence[] = ["low", "medium", "high"];

const text = (value: unknown, max: number): string =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

/** Parse the only shape a reflection agent is allowed to persist. */
export function parseImprovementProposal(raw: unknown, context: {
  project_id: string;
  wedge: string;
  task_id: string;
  task_type: string;
}): NewImprovementProposal | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (value.should_change === false) return null;

  const target = value.target as ImprovementTarget;
  const confidence = value.confidence as ImprovementConfidence;
  const title = text(value.title, 160);
  const summary = text(value.summary, 1200);
  const proposed_change = text(value.proposed_change, 4000);
  if (!TARGETS.includes(target) || !CONFIDENCES.includes(confidence) || !title || !summary || !proposed_change) {
    return null;
  }

  const evidence = Array.isArray(value.evidence)
    ? value.evidence.filter((item): item is string => typeof item === "string").map((item) => item.trim().slice(0, 500)).filter(Boolean).slice(0, 20)
    : [];
  if (!evidence.length) return null;

  return {
    id: randomUUID(),
    project_id: context.project_id,
    wedge: context.wedge,
    task_id: context.task_id,
    task_type: context.task_type,
    target,
    title,
    summary,
    proposed_change,
    evidence,
    confidence,
    metadata: { source: "reflection_run" },
  };
}
