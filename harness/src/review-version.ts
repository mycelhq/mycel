// The independent read, in ONE place, because it was in one place and that place was a route.
//
// ═══ THE GATE THAT DID NOT RUN WHERE IT MATTERED ═══
//
// `reviewDeliverable` is the product's differentiating claim: a second model that did not write the
// work grades it before a founder ever opens it. It lived as a private helper inside
// `deliverables.routes.ts` and was called from exactly one place — the HTTP route an agent hits to
// submit a version.
//
// That is not the path most work takes. `orchestrator.ts` finishes a run, decides `fate === deliver`
// and calls `wrapFulfillmentDeliverable`, which calls `store.submitVersion` DIRECTLY. No review. And
// that path carries `autoRelease`, so on a standing permission the work could go to a client with no
// human and no independent read of any kind — the exact combination the reviewer exists to prevent,
// on the exact path where the founder is not present to catch it.
//
// So it moves here and both callers use it. A gate whose coverage depends on which function
// happened to be called is not a gate.
import type { Artifact, DeliverableVersion } from "./contract";
import type { Store } from "./store";
import { getIdentityStore } from "./identity";
import { chatComplete } from "./litellm";
import { readableText, reviewDeliverable, type ReviewableFile } from "./deliverable-review";
import { getArtifactBackend } from "./artifacts";

/**
 * Default byte-fetch, so a caller that has no `withContent` of its own can still review.
 *
 * The routes inject theirs (it is already built there, with the misconfiguration diagnostics an HTTP
 * caller needs). The orchestrator has none, and requiring one there would have meant either
 * threading a dep through the whole run path or — far more likely, given how this bug started —
 * quietly not reviewing.
 *
 * Returns the artifact unchanged when the bytes cannot be produced. `reviewability` then refuses
 * honestly on what it could open rather than grading a blank.
 */
async function defaultWithContent(a: Artifact): Promise<Artifact> {
  if (a.content) return a;
  try {
    const fetched = await (await getArtifactBackend()).get(a.id);
    return fetched === null ? a : { ...a, content: fetched };
  } catch {
    return a;
  }
}

const nowIso = (): string => new Date().toISOString();

/**
 * A second reader on the version, before the founder opens it.
 *
 * ═══ WHY IT RUNS HERE AND NOT INSIDE THE RUN ═══
 *
 * The run cannot be trusted to grade itself — that is the entire finding this is built on — and it
 * also cannot be trusted to CALL a grader. Anything the agent invokes, the agent can skip, and a
 * quality gate an agent may decline is a quality gate on the runs that did not need it. Here it is
 * unavoidable: every version any run submits passes through this function.
 *
 * ═══ IT NEVER FAILS THE SUBMIT ═══
 *
 * The work is already written. If the reviewer is unreachable, slow, unconfigured or incoherent,
 * the correct outcome is a version with `reviewed: false` and a reason on it — not a lost
 * deliverable and a run that has to redo an hour of work because a grader had a bad minute. Every
 * path here returns a value; none throws.
 *
 * `standard` rather than `deep`. What the criteria actually ask for is careful reading — is this the
 * object that was promised, is every figure traceable — not multi-step reasoning, and putting the
 * deep tier on every version submitted would make reviewing a short deliverable cost more than
 * writing it. If the verdicts prove noisy in practice this is one constant.
 */
export async function reviewVersion(args: {
  store: Store;
  withContent?: (a: Artifact) => Promise<Artifact>;
  projectId: string;
  artifactIds: readonly string[];
  kind: string;
  summary?: string;
}): Promise<DeliverableVersion["review"]> {
  const at = nowIso();
  const files: ReviewableFile[] = [];
  for (const id of args.artifactIds) {
    const a = await args.store.getArtifact(id);
    if (!a) continue;
    try {
      const full = await (args.withContent ?? defaultWithContent)(a);
      files.push({
        name: full.name ?? id,
        content_type: full.content_type ?? "",
        content: String(full.content ?? ""),
        encoding: full.encoding,
      });
    } catch {
      // Unreadable bytes are `artifactFault`'s business. Here they simply contribute no text, and
      // `reviewability` then refuses honestly rather than grading what it could open.
      continue;
    }
  }

  const orgId = getIdentityStore().getProject(args.projectId)?.org_id ?? "";
  const result = await reviewDeliverable({
    text: readableText(files),
    kind: args.kind,
    summary: args.summary,
    complete: async ({ system, user }) =>
      orgId
        ? await chatComplete({ orgId, tier: "standard", system, user, maxTokens: 1200, timeoutMs: 45_000 })
        : undefined,
  });
  return { reviewed: result.reviewed, because: result.because, verdict: result.verdict, at };
}
