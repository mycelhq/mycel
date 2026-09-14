// The three planes of the fulfilment loop, mounted with one line. Read the header of
// deliverables.ts first — the state machine and the authority argument are there, and this file is
// only the transport.
//
// AGENT PLANE (`/v1/internal/deliverables*`): the work gets made. Authorised by an action grant, so
// a run can only ever touch its own task's project and its own task's case. The agent may create a
// deliverable and submit versions. It CANNOT release one, and there is no route here that would let
// it — see below.
//
// FOUNDER PLANE (`/v1/deliverables*`): the work gets reviewed, released, or pulled. Scoped by
// `writeProjectId`/`accessible` like every other founder route.
//
// CLIENT PLANE (`/v1/portal/deliverables*`): the work gets a verdict. Scoped by the portal SESSION
// and nothing else. The only identifiers a client supplies are a deliverable id and an artifact id,
// and both are resolved with `(session.project_id, id)` — so an id belonging to another tenant reads
// as "not found" rather than as a row to be checked afterwards. Every failure here is a 404 and
// never a 403, for the reason portal-approvals.ts gives: a 403 confirms the row exists.
//
// ═══ WHY RELEASE IS A ROUTE AND NOT `awaitApproval` ═══
//
// This is the one design decision in the loop that departs from an existing mechanism, so it is
// argued rather than assumed.
//
// The kernel's human gate is `awaitApproval`: the run blocks, the founder clicks, the run continues.
// That is exactly right for the gates it already guards — sending an email, issuing an invoice —
// because those are decisions a founder makes in seconds and the run has nothing useful to do
// meanwhile. It is wrong for this one, for two reasons that are both about time:
//
//   · THE TTL. `awaitApproval` defaults to five minutes and then EXPIRES, which for an outbound
//     email is a sensible safety valve and here would mean a founder who reviews a statement of work
//     after lunch finds the run aborted and the work thrown away.
//   · THE SANDBOX. A blocked run holds its sandbox open. Reviewing a deliverable takes hours or
//     days. Paying for a container to sit idle across a weekend is the least of it; `runTask`
//     destroys the sandbox in its `finally`, so the run would not survive the wait it was waiting
//     for anyway.
//
// So the gate is not weakened, it is moved from a promise to the data. `released_at` is the only
// thing any client-facing read consults (`visibleVersions`), the only writer of it is
// `releaseVersion`, and the only caller of that is the founder route below. A run submits and
// finishes; the decision outlives it. That is strictly stronger than a blocking call, because a
// blocking call is a promise about the order in which functions happen to be invoked and this is a
// property of the row.
import { applyDistilled, distillFromApprovalEdit, distillFromChangeRequest } from "./knowledge";
import { getKnowledgeStore } from "./knowledge.store";
import type { Hono } from "hono";
import type { Artifact, Case, Deliverable, DeliverableVersion, TaskSource, VersionEdit } from "./contract";
import { getIdentityStore } from "./identity";
import { chatComplete } from "./litellm";
import { reviewVersion } from "./review-version";
import { getGrantStore, grantTtlMs } from "./store";
import { loadProjectWedge } from "./authored";
import type { DomainStore } from "./domain";
import { reachMilestone } from "./milestones";
import type { Store } from "./store";
import type { ClientScope } from "./portal";
import {
  DELIVERABLE_KINDS,
  DELIVERABLE_STATES,
  DELIVERABLE_VERDICT_TASK_TYPE,
  artifactReleasedTo,
  deliverableKindFault,
  formatChangeBrief,
  getDeliverableStore,
  payloadFault,
  qualitySignals,
  timelineNote,
  toPortalDeliverable,
  verdictCarrier,
  verdictInput,
  visibleVersions,
  type ChangeComment,
} from "./deliverables";
import { artifactFileMeta, buildArtifactPreview, type ArtifactFileMeta } from "./artifact-preview";
import { applyBlockEdits, editableFormat, parseBlocks, type BlockEdit } from "./doc-blocks";
import { rerenderDocument } from "./rerender";
import { getArtifactBackend } from "./artifacts";
import { lintArtifact } from "./design-lint";
import { recordDeliverableVerdict } from "./skill-scales";
import { armWait, evaluateWait, resumeWait } from "./waits";
import { type PinnedStyle, describeStyle, resolveStyle } from "./house-style";
import { fidelityRefusal, styleFidelity } from "./style-fidelity";
import { designSystem } from "./design-systems";

export interface DeliverableRouteDeps {
  /** The task store — used ONLY to validate that submitted artifacts exist inside the same project. */
  store: Store;
  domain: DomainStore;
  /** The projects the caller may READ. Fails closed; see `identity.accessibleProjectIds`. */
  accessible(c: any): Set<string>;
  /** The project a write lands in, or undefined when the caller named none. */
  writeProjectId(c: any): string | undefined;
  /** Resolve an action grant to the run that holds it. The agent plane's only identity. */
  getActionGrant(token: string): Promise<{ task_id: string } | undefined>;
  /** Pull an artifact's bytes from whichever backend holds them. Injected — see server.ts. */
  withContent(a: Artifact): Promise<Artifact>;
  /**
   * TELL THE CLIENT THE WORK IS READY.
   *
   * Injected for the same reason `spawnTask` is: reaching a customer means the connection planner,
   * the action executor and the tenant's portal address, all of which live in `server.ts`. A route
   * that reached for them directly would drag the server graph in here.
   *
   * OPTIONAL, and that is deliberate rather than lazy. Every test in this file constructs these deps
   * by hand, and a required field would have meant fifty call sites growing a stub that announces
   * nothing — which is precisely the state this was added to fix, written down fifty times.
   * `announceOnRelease.test.ts` pins that `server.ts` supplies it.
   */
  announceRelease?(
    d: { project_id: string; client_id: string; title: string },
    version: { summary?: string },
  ): Promise<{ sent: boolean; detail: string; to?: string }>;
  /** Stream an artifact with the download headers that are already correct. Injected, never re-derived. */
  serveArtifact(a: Artifact): Response;
  /**
   * Spawn an episode on a case — same closure waits/nudges use. Injected so regenerate cannot invent
   * a second spawn path that drifts on ceilings or output_schema.
   */
  spawnTask(args: {
    project_id: string;
    wedge: string;
    task_type: string;
    client_id?: string;
    case_id?: string;
    source: TaskSource;
    input: Record<string, unknown>;
  }): Promise<string>;
}

const nowIso = () => new Date().toISOString();
const bearer = (c: any) => (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");

/** Attach file meta to each version so the inspector does not guess names from "File 1". */
async function withFiles(
  store: Store,
  versions: DeliverableVersion[],
): Promise<(DeliverableVersion & { files: ArtifactFileMeta[] })[]> {
  return Promise.all(
    versions.map(async (v) => {
      const files: ArtifactFileMeta[] = [];
      for (const id of v.artifact_ids) {
        const a = await store.getArtifact(id);
        if (a) files.push(artifactFileMeta(a));
        else files.push({ id, name: id, content_type: "application/octet-stream", size_bytes: 0, encoding: "utf8", preview: "none" });
      }
      return { ...v, files };
    }),
  );
}

/**
 * The founder's view. The row plus every version, including the unreleased ones — this is the plane
 * that is allowed to see drafts, and the only one.
 */
async function toOperator(store: Store, d: Deliverable, versions: DeliverableVersion[]) {
  return {
    ...d,
    /** The sentence for this state, resolved from the one table that holds it. Never re-worded here. */
    state_note: DELIVERABLE_STATES[d.status].founder_sees,
    /** Whether the client can currently see anything at all. Cheaper than making a UI derive it. */
    released_versions: visibleVersions(versions).length,
    quality: qualitySignals(d, versions),
    /**
     * THE LOOK, AND WHOSE DECISION IT WAS.
     *
     * A sentence rather than the raw pin, because the useful part is the provenance and a founder
     * cannot read `evidence: "derived"`. "our default — you have not chosen one" is an invitation to
     * fix it; the field name is not. Derived here rather than in the UI so every surface says the
     * same thing, and so the wording lives next to the rule that produced it.
     */
    style_note: describeStyle(d.style),
    versions: await withFiles(store, versions),
  };
}

/**
 * Every artifact id must name an artifact whose task is in THIS project.
 *
 * ═══ THE BUG THIS PREVENTS ═══
 *
 * Without it, a deliverable is a list of arbitrary strings, and `POST /v1/deliverables/:id/versions`
 * with an artifact id copied from another tenant would produce a version that looks perfectly
 * normal, passes review, gets released, and hands another business's file to a client — with the
 * portal download route's own check satisfied, because that check asks "is this artifact listed on a
 * released version this client owns" and the answer would be yes.
 *
 * So the tenant boundary is enforced when the list is WRITTEN, where the project is known and the
 * caller is authenticated, rather than when it is read. Returns a sentence naming the first bad id.
 */
async function artifactFault(store: Store, projectId: string, ids: string[]): Promise<string | undefined> {
  if (ids.length > 50) return "a version may carry at most 50 files";
  for (const id of ids) {
    const a = await store.getArtifact(id);
    if (!a) return `there is no file with id ${id}`;
    const t = await store.getTask(a.task_id);
    if (!t || t.project_id !== projectId) return `there is no file with id ${id}`;
  }
  return undefined;
}

/**
 * ═══ THE ANTI-SLOP GATE ═══
 *
 * Every HTML file on a submitted version, run through `lintArtifact`. P0 findings are the seven
 * tells that make a document read as machine-made before anyone has assessed a number in it:
 * default indigo, a purple hero gradient, emoji as feature icons, invented metrics, lorem ipsum.
 *
 * ═══ WHY THIS ONE IS SAFE TO BLOCK ON, WHEN THE COPY GATE WAS NOT ═══
 *
 * This repo has been bitten three times by two gates disagreeing about one message: the drafter is
 * told one rule, the send port checks a different one, and the model produces something legal to
 * the first and refused by the second FOREVER, because re-drafting yields the same output. Each
 * time it cost a day of sending.
 *
 * The condition that makes that happen is the two gates having separate definitions. Here they have
 * one: `craft/anti-ai-slop.md` is mounted on every deliverable run and is the document these rules
 * were written from — the same list, upstream and here. An agent that has read its craft cannot
 * write something this refuses without ignoring what it was handed, and the refusal quotes the rule
 * and the fix, so a retry has somewhere to go. `design-lint-agrees.test.ts` fails if they drift.
 *
 * P1/P2 are NOT blocking. They are judgement calls (contrast ratios, motion durations) where a
 * confident refusal would be wrong often enough to cost more than it saves.
 */

async function slopFault(
  store: Store,
  withContent: (a: Artifact) => Promise<Artifact>,
  ids: string[],
  /**
   * The look this deliverable was pinned to, when it has one. Present, every HTML file is also
   * checked for whether it actually WORE it — see style-fidelity.ts. Absent, that half is skipped
   * entirely: an artefact with no pinned system has nothing to be unfaithful to, and inventing a
   * standard would gate work against a look nobody chose.
   */
  pinned?: PinnedStyle,
): Promise<string | undefined> {
  for (const id of ids) {
    const a = await store.getArtifact(id);
    if (!a) continue; // artifactFault already refused these; do not report the same thing twice
    const name = a.name ?? "";
    const type = a.content_type ?? "";
    if (!/^text\/html|application\/xhtml/i.test(type) && !/\.html?$/i.test(name)) continue;

    let html = "";
    try {
      html = String((await withContent(a)).content ?? "");
    } catch {
      continue; // unreadable bytes are artifactFault's business, not this gate's
    }
    if (!html) continue;

    /**
     * FIDELITY FIRST, because it is the more specific complaint. "You ignored the house style" and
     * "your gradient is purple" can both be true, and telling a run about its gradient while it is
     * styling past the brand entirely sends it to fix the smaller thing.
     */
    const refusal = fidelityRefusal(styleFidelity(html, pinned ? designSystem(pinned.system) : undefined));
    if (refusal) return `${name || "the HTML file"}: ${refusal}`;

    const p0 = lintArtifact(html).filter((f) => f.severity === "P0");
    if (!p0.length) continue;

    // Every P0, not just the first. A revision that fixes one and leaves three is a second refusal
    // the agent could have avoided, and each round trip is a run's budget.
    const lines = p0.slice(0, 8).map((f) => `  · ${f.message} — ${f.fix}`);
    return (
      `${name || "the HTML file"} breaks ${p0.length} of the rules in craft/anti-ai-slop.md, which are what make a document look machine-made:\n` +
      `${lines.join("\n")}\n` +
      `Fix these in the file and submit again.`
    );
  }
  return undefined;
}

/**
 * The run's own reading of how well this answers the brief.
 *
 * CLAMPED AND CAPPED, not validated-or-refused. This is a self-report from a model: a missing
 * field, a number outside 0..1, a string where a list belongs are all things it will do
 * occasionally, and none of them is worth failing a finished deliverable over. What cannot happen
 * is unbounded text riding on every version read.
 *
 * `fit` absent means the run said nothing, which is different from saying zero — the field stays
 * undefined and the review queue sorts it as unknown rather than as terrible.
 */
export function readConfidence(v: unknown): DeliverableVersion["confidence"] | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const c = v as Record<string, unknown>;
  const raw = typeof c.fit === "number" ? c.fit : Number(c.fit);
  if (!Number.isFinite(raw)) return undefined;
  const fit = Math.max(0, Math.min(1, raw));
  const brief = typeof c.brief === "string" && c.brief.trim() ? c.brief.trim().slice(0, 600) : undefined;
  const unsure = Array.isArray(c.unsure)
    ? (c.unsure as unknown[]).map((x) => String(x).trim()).filter(Boolean).slice(0, 8).map((s) => s.slice(0, 300))
    : undefined;
  return { fit, ...(brief ? { brief } : {}), ...(unsure?.length ? { unsure } : {}) };
}

/**
 * The sentence a client reads. Prose, or the closest prose we can find inside what we were handed.
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * TWO PRODUCTION VERSIONS HAVE A JSON BLOB WHERE THEIR SUMMARY SHOULD BE
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 *   {"query":"AI that runs the back office for a small agency","surface":"unavailable","cited":[],…}
 *   {"role":"Northwing","candidates":[],"summary":"No candidates were sourced. The case does not …"}
 *
 * The second is the instructive one: it contains a perfectly good sentence, under a `summary` key,
 * and the whole object was stored instead of it. A run that produces structured output and hands
 * the envelope over verbatim gets its envelope shown to the customer.
 *
 * `String(b.summary ?? "")` accepted it without comment, because it is a string — the agent had
 * already stringified it. So the check cannot be a type check; it has to look at the shape.
 *
 * Order matters: unwrap first, and only then give up. Returning "" for a blob would have thrown
 * away a written sentence in the case where one exists, which is the case we have.
 */
const PROSE_KEYS = ["summary", "note", "message", "text", "finding"];

export function humanSummary(raw: unknown): string {
  const unwrap = (v: unknown, depth = 0): string => {
    if (typeof v === "string") {
      const t = v.trim();
      if (!(t.startsWith("{") && t.endsWith("}"))) return t;
      if (depth > 2) return "";
      try {
        return unwrap(JSON.parse(t), depth + 1);
      } catch {
        // Looks like an object and does not parse as one. Not prose either way.
        return "";
      }
    }
    if (v && typeof v === "object" && !Array.isArray(v)) {
      if (depth > 2) return "";
      const o = v as Record<string, unknown>;
      for (const k of PROSE_KEYS) {
        const hit = unwrap(o[k], depth + 1);
        if (hit) return hit;
      }
      return "";
    }
    return "";
  };
  return unwrap(raw).slice(0, 4000);
}

/**
 * Why the summary we ended up with is not usable, if it is not.
 *
 * Split from `payloadFault`, which is about artifacts and URLs. Refusing matters here because
 * `humanSummary` turns an unreadable blob into "", and storing "" is worse than storing the blob:
 * the client opens a deliverable with no sentence on it and nothing anywhere says why.
 *
 * The message is written to be read by the MODEL, since that is who receives it — it names the
 * mistake ("you sent structured data") rather than the symptom ("summary is empty"), because the
 * run can correct the first and not the second.
 */
function summaryFault(raw: unknown, cleaned: string): string | undefined {
  if (cleaned) return undefined;
  /**
   * ONLY when structured data was SENT and no sentence could be found in it.
   *
   * A version with no summary at all is a shape this route has always accepted — an artifact with
   * no covering note — and making it mandatory here would be a second, unrelated behaviour change
   * riding along on a bug fix. Not the job. The defect is a blob being shown to a client as prose,
   * and that is the only case refused.
   */
  const looksStructured =
    (typeof raw === "string" && raw.trim().startsWith("{")) ||
    (!!raw && typeof raw === "object" && !Array.isArray(raw));
  if (!looksStructured) return undefined;
  return (
    "`summary` came through as structured data, not a sentence. Send the plain-English summary " +
    "the client will read — put the structured output in an artifact instead."
  );
}

/** Read and normalise the payload half of a version body. Shared by the agent and founder submits. */
function readVersionBody(b: Record<string, unknown>): {
  summary: string;
  artifact_ids: string[];
  url?: string;
  confidence?: DeliverableVersion["confidence"];
} {
  return {
    summary: humanSummary(b.summary),
    artifact_ids: Array.isArray(b.artifact_ids) ? (b.artifact_ids as unknown[]).map(String).slice(0, 51) : [],
    url: typeof b.url === "string" && b.url.trim() ? b.url.trim() : undefined,
    confidence: readConfidence(b.confidence),
  };
}



export function mountDeliverableRoutes(app: Hono, deps: DeliverableRouteDeps): void {
  const { store, domain, accessible, writeProjectId, getActionGrant, withContent, serveArtifact, spawnTask } = deps;
  const deliverables = getDeliverableStore();

  /** A case, re-read and tenant-checked. Never trusted from a body — see `armWait`'s identical rule. */
  const ownedCase = async (projectId: string, caseId: string): Promise<Case | undefined> => {
    const k = await domain.getCase(caseId);
    return k && k.project_id === projectId ? k : undefined;
  };

  /** One timeline line on the engagement. Fail-soft: a note that cannot be written must not undo a verdict. */
  const note = async (d: Deliverable, text: string) => {
    await domain.updateCase(d.case_id, {}, { at: nowIso(), kind: "note", note: text, actor: "system" }).catch(() => {});
  };

  /**
   * Resume the wait that was parked on this deliverable — NOW, not on the five-minute sweep.
   *
   * Same `resumeWait` the sweep uses, so the claim is still exactly-once. A second spawn path here
   * would be two runs; this is the first path, fired at the moment the client answered instead of
   * waiting for the next tick. If the wait is already claimed, we say so and do not spawn again.
   */
  const resumeSettledDeliverable = async (
    d: Deliverable,
  ): Promise<{ task_id?: string; why?: string }> => {
    const waits = await domain.listWaits({ project_id: d.project_id, case_id: d.case_id, status: "waiting" });
    const wait = waits.find((w) =>
      (w.conditions ?? []).some((c) => c.kind === "deliverable_settled" && c.deliverable_id === d.id),
    );
    if (!wait) return { why: "no wait parked on this work" };
    const verdict = await evaluateWait(domain, wait);
    if (verdict.state !== "satisfied") return { why: "the wait is not yet satisfied" };
    const r = await resumeWait(domain, wait, verdict.by, new Date(), verdict.index);
    if (!r.ok) return { why: r.message };
    return { task_id: r.task_id };
  };

  const spawnRevision = async (d: Deliverable, reason: "client_asked_for_changes" | "founder_sent_back") => {
    const kase = await ownedCase(d.project_id, d.case_id);
    if (!kase || kase.status === "closed") return { why: "this engagement is closed or gone" };
    const carrier = verdictCarrier({ project_id: d.project_id, wedge: kase.wedge });
    if ("why" in carrier) return { why: carrier.why };
    const versions = await deliverables.listVersions(d.project_id, d.id);
    const current = versions.find((v) => v.version === d.current_version) ?? versions[versions.length - 1];
    const input = current
      ? { ...verdictInput(d, current), regenerate: true, reason }
      : { deliverable_id: d.id, regenerate: true, verdict: "none" };
    const taskId = await spawnTask({
      project_id: d.project_id,
      wedge: carrier.wedge,
      task_type: DELIVERABLE_VERDICT_TASK_TYPE,
      client_id: d.client_id,
      case_id: d.case_id,
      source: "case",
      input: {
        ...input,
        case: { id: kase.id, title: kase.title, stage: kase.stage, data: kase.data },
        client_id: d.client_id,
      },
    });
    return { task_id: taskId };
  };

  const readComments = (b: Record<string, unknown>): ChangeComment[] => {
    if (!Array.isArray(b.comments)) return [];
    const out: ChangeComment[] = [];
    for (const item of b.comments.slice(0, 20)) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const o = item as Record<string, unknown>;
      const noteText = String(o.note ?? "").trim().slice(0, 1000);
      if (!noteText) continue;
      out.push({
        artifact_id: typeof o.artifact_id === "string" ? o.artifact_id.slice(0, 80) : undefined,
        file: typeof o.file === "string" ? o.file.trim().slice(0, 200) : undefined,
        // Which block, and what it said at the time. Both client-supplied and both capped: they are
        // going into a prompt, and `where` is a label rather than an id precisely so a stale one is
        // harmless prose instead of a wrong address.
        where: typeof o.where === "string" ? o.where.trim().slice(0, 80) : undefined,
        quote: typeof o.quote === "string" ? o.quote.trim().slice(0, 300) : undefined,
        note: noteText,
      });
    }
    return out;
  };

  // ── agent plane ────────────────────────────────────────────────────────────────────────────────

  /**
   * The run offers finished work.
   *
   * Creates the deliverable if this is the first version and adds a version either way, so a wedge
   * that produces the same artefact every month does not have to decide whether it is inventing a
   * new thing or revising one — it passes `deliverable_id` when it is revising and does not when it
   * is not. `case_id` comes from the RUN'S OWN TASK, never from the body: a run that could name its
   * own case could attach work to another client's engagement inside the same project.
   */
  app.post("/v1/internal/deliverables", async (c) => {
    const grant = await getActionGrant(bearer(c));
    if (!grant) return c.json({ ok: false, error: "invalid action token" }, 401);
    const task = await store.getTask(grant.task_id);
    if (!task?.project_id) return c.json({ ok: false, error: "unknown task" }, 404);
    const projectId = task.project_id;
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

    const existingId = typeof b.deliverable_id === "string" ? b.deliverable_id : undefined;
    let d = existingId ? await deliverables.getDeliverable(projectId, existingId) : undefined;
    if (existingId && !d) return c.json({ ok: false, error: "not found" }, 404);

    /**
     * ═══ VALIDATE BEFORE CREATING, WHICH IS THE BUG ═══
     *
     * This route used to create the deliverable row and THEN check the version. So a submission the
     * route was always going to refuse — a `document` with no artifact, an artifact from another
     * project — left a `drafting` row behind anyway. The agent retried, sent no `deliverable_id`
     * because it had never been given one, and got another row. A single monthly close produced
     * SEVEN, and six of them would sit in `drafting` for ever because nothing ever submits a version
     * to them.
     *
     * Nothing about that needed the row to exist. `payloadFault` reads the KIND and the body;
     * `artifactFault` reads the artifact ids and the project. Both were computable before a single
     * write, and running them after it is what turned a rejected request into a persistent artifact
     * of the rejection.
     *
     * So the refusal happens first and the store is never touched. A request that cannot succeed now
     * changes nothing, which is the property the route should always have had.
     *
     * `kind` comes from the existing row when one was named and from the body otherwise, because
     * that is what the version will actually be checked against either way.
     */
    const kindFaultEarly = d ? undefined : deliverableKindFault(b.kind);
    if (kindFaultEarly) return c.json({ ok: false, error: kindFaultEarly }, 400);
    const effectiveKind = (d?.kind ?? b.kind) as Deliverable["kind"];
    const body = readVersionBody(b);
    const bad = payloadFault(effectiveKind, body);
    if (bad) return c.json({ ok: false, error: bad }, 400);
    const summaryBad = summaryFault(b.summary, body.summary);
    if (summaryBad) return c.json({ ok: false, error: summaryBad }, 400);
    const artFault = await artifactFault(store, projectId, body.artifact_ids);
    if (artFault) return c.json({ ok: false, error: artFault }, 400);
    /**
     * The pin for a revision; for a FIRST version, the pin this submission is about to be given.
     *
     * Resolving it early matters: a new deliverable has no `style` yet at this point, so keying on
     * `d?.style` alone would skip the fidelity check on version 1 — the version that sets the tone
     * for the whole engagement and the only one a client sees before deciding what this firm is.
     * The value resolved here is the same one `createDeliverable` pins a few lines down.
     */
    const slopStyle = d?.style ?? resolveStyle(getIdentityStore().brandKit(projectId));
    const slop = await slopFault(store, withContent, body.artifact_ids, slopStyle);
    if (slop) return c.json({ ok: false, error: slop, code: "design_rejected" }, 400);

    if (!d) {
      // The run's own case. `task.case_id` is set by every spawn path in the kernel; a run with no
      // case genuinely cannot produce a deliverable, because there would be nothing to bill it
      // against and nothing to park on the client's answer.
      if (!task.case_id) {
        return c.json({ ok: false, error: "this run is not attached to an engagement, so it cannot deliver anything" }, 409);
      }
      const kase = await ownedCase(projectId, task.case_id);
      if (!kase?.client_id) {
        return c.json({ ok: false, error: "this engagement has no client, so there is nobody to deliver to" }, 409);
      }
      const title = String(b.title ?? "").trim();
      if (!title) return c.json({ ok: false, error: "a deliverable needs a title — it is what your client sees" }, 400);

      /**
       * ═══ ONE RUN, ONE DELIVERABLE — the contract, not the bug fix ═══
       *
       * The BUG was create-before-validate, above, and it is fixed there: a request that cannot
       * succeed no longer writes anything. This is the separate and still-true contract.
       *
       * A single monthly close produced SEVEN, all `drafting`, all on the same case, created eight
       * seconds apart — the agent called this route once per attempt and every call made a new row.
       * The founder's deliverables list showed the same August close seven times, and six of them
       * would have sat in `drafting` for ever because nothing ever submits a version to them.
       *
       * The route was already idempotent when the caller passes `deliverable_id`. It just had no
       * answer for the far more common case: an agent that did not keep the id from its own previous
       * call, which is most agents, most of the time.
       *
       * So a `drafting` deliverable on this case is REUSED rather than duplicated. `drafting`
       * specifically — a deliverable that has reached `in_review` or beyond is a real prior piece of
       * work and a second one on the same engagement is legitimate. `drafting` means nobody has ever
       * seen it, which makes it this run's own scratch space by definition.
       *
       * Same shape as the idempotency key on POST /v1/tasks: the fix for "the same intent arriving
       * twice" is to make the second arrival find the first, not to trust the caller to remember.
       */
      // Defensive on BOTH sides: a store that rejects and a store that answers undefined are the
      // same thing here — no evidence of a prior draft — and neither may stop a run delivering.
      const priorDrafts = await deliverables
        .listDeliverables({ project_id: projectId, case_id: kase.id, status: "drafting", limit: 1 })
        .catch(() => [] as Awaited<ReturnType<typeof deliverables.listDeliverables>>);
      const openDraft = Array.isArray(priorDrafts) ? priorDrafts[0] : undefined;
      if (openDraft) {
        return c.json({ ok: true, deliverable_id: openDraft.id, reused: true });
      }

      d = await deliverables.createDeliverable({
        project_id: projectId,
        case_id: kase.id,
        client_id: kase.client_id,
        title: title.slice(0, 200),
        kind: b.kind as Deliverable["kind"],
        /**
         * PINNED HERE, ONCE, AND NEVER RESOLVED AGAIN FOR THIS DELIVERABLE.
         *
         * At creation rather than at render, because that is the only moment the answer is allowed
         * to be "whatever the brand says now". Every version after this reads the pin, so a founder
         * who restyles mid-engagement changes the next piece of work and nothing a client has
         * already been shown. See house-style.ts.
         */
        style: resolveStyle(getIdentityStore().brandKit(projectId)),
      });
    }

    /**
     * Explicitly after the `...body` spread below, so a run that put a `review` in its JSON cannot
     * have it survive. `readVersionBody` does not read the field either — belt and braces, because
     * a forged review is worse than no review: it is a fabricated second opinion wearing the
     * authority of an independent one.
     */
    /**
     * WHAT A PERSON WOULD HAVE TAKEN OVER THIS, from the authored job that produced it.
     *
     * Explicitly set below rather than read from the body, exactly like `review`: a run that put its
     * own `human_hours` in the JSON would be reporting how long IT took, which is a fact about us,
     * and it would be multiplied by the founder's rate and shown to them as what they saved.
     *
     * Best-effort and silent on failure. A manifest we cannot load is a missing figure, which the
     * measurement counts as unestimated — never a reason to refuse finished work.
     */
    const humanHours = await loadProjectWedge(projectId, task.wedge)
      .then((w: Awaited<ReturnType<typeof loadProjectWedge>>) => {
        const declared = w?.manifest.task_types?.[task.task_type]?.typical_hours;
        return typeof declared === "number" && Number.isFinite(declared) && declared > 0
          ? declared
          : undefined;
      })
      .catch(() => undefined);

    const review = await reviewVersion({
      store,
      withContent,
      projectId,
      artifactIds: body.artifact_ids,
      kind: effectiveKind,
      summary: body.summary,
    });

    /**
     * ═══ HAND A DISQUALIFYING VERDICT BACK TO THE AGENT, ONCE, BEFORE THE FOUNDER SEES IT ═══
     *
     * The review already runs here and its verdict already reaches the founder's card. That is the
     * right place for a SCORE. It is the wrong place for the two findings that are not scores:
     * `grounding` at 2 or below means a figure traces to nothing, and `artefact` at 2 or below means
     * this is not the object the engagement promised. Neither is an average to be weighed — the
     * evaluator prompt says so — and both are things the agent that is still running can fix in one
     * turn, at a cost of nothing, while the founder is not yet involved.
     *
     * This is the split Replit make and this codebase already agreed with elsewhere: HALT THE AGENT,
     * never the human. A machine opinion that blocks a founder from sending their own client work
     * gets switched off the first Friday it is wrong; a machine opinion that costs the agent one
     * more turn costs a turn.
     *
     * REJECTING A SUBMISSION ON QUALITY IS NOT NEW HERE. `slopFault` two lines above answers 400
     * with `code: "design_rejected"` for exactly this reason. This is that pattern, for the half of
     * the artefact a design linter cannot see.
     *
     * ═══ ONCE. NEVER TWICE ═══
     *
     * `putIfAbsent` is the claim — the loser gets the winner's payload, so the second submission is
     * accepted whatever the verdict says. That bound is not a nicety: the reviewer is an LLM, a
     * wrong `serious` is possible, and a gate that can fire repeatedly would spend a run's whole
     * budget arguing with itself and deliver nothing. One bounce is a correction; two is a loop.
     *
     * FAILS OPEN EVERYWHERE ELSE. No review, an unreadable payload, a verdict that would not parse,
     * a claim store that is down — all of them submit exactly as before. The work is already
     * written, and a reviewer having a bad minute must never be able to lose it.
     */
    const serious = review?.reviewed ? (review.verdict?.serious ?? []) : [];
    if (d && serious.length > 0) {
      const bounced = await getGrantStore()
        .then((g) =>
          g.putIfAbsent(
            "idem",
            `review-bounce:${d!.id}`,
            { at: nowIso() },
            new Date(Date.now() + grantTtlMs()),
          ),
        )
        // A claim we could not take is not evidence that we already bounced. Treat it as "already
        // bounced" so the failure mode is accepting work, never rejecting it twice.
        .catch(() => ({}) as Record<string, unknown>);

      if (bounced === undefined) {
        const v = review!.verdict!;
        const titles = v.scores.filter((x) => serious.includes(x.id));
        return c.json(
          {
            ok: false,
            code: "review_rejected",
            /**
             * THE ID COMES BACK, and the message says to use it.
             *
             * Without it a bounced agent resubmits with no `deliverable_id`, hits the open-draft
             * reuse above, and is answered `{ ok: true, reused: true }` — a success, with its
             * version silently not submitted. A gate that loses the work it asked to have improved
             * is worse than no gate.
             */
            deliverable_id: d!.id,
            error:
              `A reader that did not write this found something disqualifying, so it has NOT been ` +
              `submitted. Fix it and submit again with "deliverable_id": "${d!.id}" — this check ` +
              `does not run twice.\n\n` +
              titles
                .map((x) => `- ${x.title} (${x.score}/5): ${x.toGainAPoint}`)
                .join("\n") +
              (v.note ? `\n\n${v.note}` : ""),
          },
          400,
        );
      }
    }

    const result = await deliverables.submitVersion({
      project_id: projectId,
      deliverable_id: d.id,
      // NOT `with_client`. A run must not be able to replace a version a client is currently
      // looking at: the client would leave a verdict on something that had silently changed
      // underneath them, and the change request would point at the wrong thing forever.
      allowedFrom: ["drafting", "changes_requested"],
      version: { ...body, task_id: task.id, review, human_hours: humanHours },
      at: nowIso(),
    });
    if (!result) {
      const fresh = await deliverables.getDeliverable(projectId, d.id);
      return c.json(
        { ok: false, error: `"${d.title}" is ${fresh?.status ?? "gone"} — a new version cannot be submitted against it now` },
        409,
      );
    }
    await note(result.deliverable, timelineNote("submitted", result.deliverable));
    return c.json({ ok: true, deliverable: result.deliverable, version: result.version }, 201);
  });

  /**
   * What the client said, read at the moment the run asks — not frozen into the resume input.
   *
   * This is `resumeInput`'s "INTENT FROZEN, FACTS LIVE" rule applied to the verdict. The wait carries
   * only the deliverable id; the answer itself is read here, live. The difference is not academic: a
   * wait sweeps every five minutes and a resumed run starts after that, which is long enough for a
   * client to have accepted and then immediately asked for one more thing. A run acting on a
   * snapshot taken at claim time would send a thank-you for work the client had already reopened.
   *
   * Scoped to the grant's own task's project, and additionally to its own CASE. One run cannot read
   * another engagement's deliverable even inside the same business — the same narrowing
   * `GET /v1/internal/artifacts` applies to a run's own files.
   */
  app.get("/v1/internal/deliverables/:id", async (c) => {
    const grant = await getActionGrant(bearer(c));
    if (!grant) return c.json({ ok: false, error: "invalid action token" }, 401);
    const task = await store.getTask(grant.task_id);
    if (!task?.project_id) return c.json({ ok: false, error: "unknown task" }, 404);
    const d = await deliverables.getDeliverable(task.project_id, c.req.param("id"));
    if (!d || (task.case_id && d.case_id !== task.case_id)) return c.json({ ok: false, error: "not found" }, 404);
    const versions = await deliverables.listVersions(task.project_id, d.id);
    const current = versions.find((v) => v.version === d.current_version);
    if (!current) return c.json({ ok: false, error: "not found" }, 404);
    return c.json({ ok: true, status: d.status, ...verdictInput(d, current) });
  });

  // ── founder plane ──────────────────────────────────────────────────────────────────────────────

  app.get("/v1/deliverables", async (c) => {
    const pid = writeProjectId(c);
    if (!pid || !accessible(c).has(pid)) return c.json({ error: "no project" }, 400);
    const q = c.req.query();
    const rows = await deliverables.listDeliverables({
      project_id: pid,
      client_id: q.client_id || undefined,
      case_id: q.case_id || undefined,
      status: q.status && q.status in DELIVERABLE_STATES ? (q.status as Deliverable["status"]) : undefined,
      open: q.open === "1" || q.open === "true",
      limit: q.limit ? Number(q.limit) : 200,
    });
    // Deliberately WITHOUT versions: a list of forty deliverables would be forty version reads, and
    // nothing on a list screen renders them. The detail route is one click away.
    return c.json({
      /*
        ═══ A STATUS NOT IN THE MAP MUST NOT 500 THE WHOLE LIST ═══

        This was `DELIVERABLE_STATES[d.status].founder_sees`, and `DELIVERABLE_STATES` has exactly the
        six members of the status union. Production holds rows with `status: "released"` and
        `"delivered"` — an older vocabulary that predates this map and was never migrated — so the
        lookup is `undefined` and `.founder_sees` throws.

        Not a hypothetical, and not a narrow blast radius: it takes down the ENTIRE endpoint for any
        project holding one such row. Every deliverable in that project becomes unreadable, on every
        surface, because one row has a word in a column that this build stopped writing.

        The founder-facing sentence degrades to the status itself, which is honest — we genuinely do
        not have a written explanation for a state this build has never heard of, and the row's own
        word is more use than a crash.
      */
      deliverables: rows.map((d) => ({
        ...d,
        state_note: DELIVERABLE_STATES[d.status]?.founder_sees ?? String(d.status).replace(/_/g, " "),
      })),
      kinds: DELIVERABLE_KINDS,
    });
  });

  /**
   * The founder delivering something themselves.
   *
   * ═══ WHY THIS EXISTS ALONGSIDE THE AGENT ROUTE ═══
   *
   * Not for symmetry, and not to make the demo work. It is the day-one case: a founder who has
   * written the statement of work in Pages and wants their client to sign it off has finished work
   * with no run behind it, and without this route the only way to put it in front of a client is to
   * email it — which is precisely the untracked, unversioned, un-acceptable path this whole loop
   * exists to replace. A product that can only deliver what an agent produced is a product that
   * cannot be adopted before the agent is trusted.
   *
   * IT IS THE SAME SUBMIT, not a parallel one. Same `readVersionBody`, same `payloadFault`, same
   * `artifactFault`, same `submitVersion` with the same `allowedFrom`, and the result lands in
   * `in_review` exactly as an agent's does — so the founder still has to press send, and the
   * structural gate is untouched. A second creation path with its own validation is how one of them
   * ends up missing the tenant check on `artifact_ids`.
   *
   * `case_id` is REQUIRED and re-read against the project. It is the only field the agent route gets
   * for free (from its own task) and the only one a founder can get wrong, and getting it wrong
   * means work attached to another client's engagement.
   */
  const founderSubmit = async (c: any, existingId?: string) => {
    const pid = writeProjectId(c);
    if (!pid || !accessible(c).has(pid)) return c.json({ error: "no project" }, 400);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

    let d = existingId ? await deliverables.getDeliverable(pid, existingId) : undefined;
    if (existingId && !d) return c.json({ error: "not found" }, 404);

    if (!d) {
      const kase = await ownedCase(pid, String(b.case_id ?? ""));
      if (!kase) return c.json({ error: "that engagement is not in this business" }, 400);
      if (!kase.client_id) return c.json({ error: "that engagement has no client, so there is nobody to deliver to" }, 409);
      const kindFault = deliverableKindFault(b.kind);
      if (kindFault) return c.json({ error: kindFault }, 400);
      const title = String(b.title ?? "").trim();
      if (!title) return c.json({ error: "a deliverable needs a title — it is what your client sees" }, 400);
      d = await deliverables.createDeliverable({
        project_id: pid,
        case_id: kase.id,
        client_id: kase.client_id,
        title: title.slice(0, 200),
        kind: b.kind as Deliverable["kind"],
        /**
         * PINNED HERE, ONCE, AND NEVER RESOLVED AGAIN FOR THIS DELIVERABLE.
         *
         * At creation rather than at render, because that is the only moment the answer is allowed
         * to be "whatever the brand says now". Every version after this reads the pin, so a founder
         * who restyles mid-engagement changes the next piece of work and nothing a client has
         * already been shown. See house-style.ts.
         */
        style: resolveStyle(getIdentityStore().brandKit(pid)),
      });
    }

    const body = readVersionBody(b);
    const bad = payloadFault(d.kind, body);
    if (bad) return c.json({ error: bad }, 400);
    const summaryBad = summaryFault(b.summary, body.summary);
    if (summaryBad) return c.json({ error: summaryBad }, 400);
    const artFault = await artifactFault(store, pid, body.artifact_ids);
    if (artFault) return c.json({ error: artFault }, 400);

    const result = await deliverables.submitVersion({
      project_id: pid,
      deliverable_id: d.id,
      allowedFrom: ["drafting", "changes_requested"],
      /**
       * STAMPED `founder`, BECAUSE THAT IS WHO THIS ROUTE IS.
       *
       * `author` was written in exactly one place — the `/edit` route — so a version submitted
       * through the founder plane was recorded with no author at all and read, everywhere
       * downstream, as indistinguishable from the agent's own work.
       *
       * That is not cosmetic. `deliverables.ts` states the reason `author` exists: "the difference
       * between what the agent wrote and what the founder sent is the most valuable training signal
       * this product can generate". An unattributed founder upload silently joins the agent's side
       * of that comparison, so the one thing the field is for is wrong for every deliverable an
       * agency produced itself — which, for a firm that does half its work in its own tools, is most
       * of them.
       *
       * NOT read from the body, which is what the seed first tried. Who submitted a version is a
       * property of the ROUTE — this one is reachable only from the founder plane — and a caller
       * that could name itself could name the other side.
       */
      version: { ...body, author: "founder" },
      at: nowIso(),
    });
    if (!result) {
      const fresh = await deliverables.getDeliverable(pid, d.id);
      return c.json({ error: `"${d.title}" is ${fresh?.status ?? "gone"} — a new version cannot be added now` }, 409);
    }
    await note(result.deliverable, timelineNote("submitted", result.deliverable));
    return c.json(
      { ok: true, deliverable: await toOperator(store, result.deliverable, await deliverables.listVersions(pid, d.id)) },
      201,
    );
  };

  app.post("/v1/deliverables", (c) => founderSubmit(c));
  app.post("/v1/deliverables/:id/versions", (c) => founderSubmit(c, c.req.param("id")));

  app.get("/v1/deliverables/:id", async (c) => {
    const pid = writeProjectId(c);
    if (!pid || !accessible(c).has(pid)) return c.json({ error: "not found" }, 404);
    const d = await deliverables.getDeliverable(pid, c.req.param("id"));
    if (!d) return c.json({ error: "not found" }, 404);
    return c.json(await toOperator(store, d, await deliverables.listVersions(pid, d.id)));
  });

  /**
   * THE GATE. The founder says the client may see this version.
   *
   * Two writes, in this order, and the order is the point: stamp `released_at` FIRST, then move the
   * status. A status of `with_client` over a version with no `released_at` is a deliverable the
   * founder believes was sent and the portal renders as empty — the exact "succeeded while failing"
   * shape. Stamped-but-not-transitioned is the survivable half: it shows as still in review and a
   * second click fixes it, because `releaseVersion` is a no-op the second time.
   */
  /**
   * THE FOUNDER FIXES ONE LINE AND SENDS IT.
   *
   * ═══ THE GAP THIS CLOSES ═══
   *
   * Review was a binary: release it, or send it back to be redone. Every service business owner's
   * actual instinct is the third thing — change one sentence, then send. A bookkeeper who spots a
   * wrong date does not want a whole new close; they want that date fixed, now, by them.
   *
   * Without this, the only way to fix a small thing is to reject the work and hope the rewrite is
   * better, which costs a full run, costs minutes the client is waiting through, and often produces
   * a different document with a different mistake. It is the most frustrating shape a review tool
   * can have, and it is the one most likely to make a founder stop delegating.
   *
   * ═══ WHY IT IS A NEW VERSION AND NOT AN OVERWRITE ═══
   *
   * The edited text becomes version N+1 with the founder recorded as its author. It does not mutate
   * the version the agent produced.
   *
   * Two reasons, and the second is the one that matters. First: the client may already have seen the
   * earlier version, and rewriting history under someone who is mid-review is the bug that
   * `submitVersion`'s compare-and-set exists to prevent.
   *
   * Second, and more important: **the difference between what the agent wrote and what the founder
   * sent is the most valuable training signal this product can generate.** It is a labelled
   * correction, on real work, by the person whose judgement we are trying to learn. Overwriting the
   * original destroys it. Keeping both means the release policy can eventually notice that this
   * wedge, for this client, has needed no edits in a month.
   */

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════════════
   * WHICH JOB A LESSON FROM A CORRECTION BELONGS TO
   * ═══════════════════════════════════════════════════════════════════════════════════════════════
   *
   * Both edit routes filed their lesson under `deliverable_verdict`, and `ruleApplies` refuses a
   * rule whose `task_types` does not contain the RUNNING task's type:
   *
   *     if (r.task_types.length > 0 && !r.task_types.includes(ctx.task_type)) return false;
   *
   * `deliverable_verdict` is the spine job that handles a CLIENT'S verdict on finished work. It has
   * never written a report and never will. So every lesson a founder taught us by rewriting their
   * own deliverable was filed against a job that cannot use it, and the run that writes next
   * month's report — `monthly_close`, `write_visibility_report`, whatever this trade calls it —
   * retrieved none of them. Measured directly: 0 rules returned for `monthly_close`, 1 for
   * `deliverable_verdict`.
   *
   * The correction machinery was working perfectly and posting its output to an empty room.
   *
   * The right key is the job that PRODUCED the thing being corrected, which the version already
   * names: `task_id` → the run → its `task_type`. A rule learned by fixing a monthly close is a
   * rule about writing monthly closes.
   *
   * ═══ WHY THE FALLBACK IS EMPTY AND NOT THE OLD VALUE ═══
   *
   * A founder can deliver work by hand, with no run behind it, so there is sometimes no task type
   * to name. `[]` means "every job in this wedge" — broader than ideal and scored lower for it
   * (`scoreRule` gives 8 instead of 25), but RETRIEVABLE. A precise key that matches nothing is
   * worth strictly less than a vague key that matches something.
   */
  const producingTaskType = async (version: { task_id?: string } | undefined): Promise<string> => {
    if (!version?.task_id) return "";
    const t = await store.getTask(version.task_id).catch(() => undefined);
    return t?.task_type ?? "";
  };

  app.post("/v1/deliverables/:id/edit", async (c) => {
    const pid = writeProjectId(c);
    if (!pid || !accessible(c).has(pid)) return c.json({ error: "not found" }, 404);
    const d = await deliverables.getDeliverable(pid, c.req.param("id"));
    if (!d) return c.json({ error: "not found" }, 404);
    if (d.status !== "in_review") {
      return c.json({ error: `"${d.title}" is ${d.status} — there is nothing waiting for your approval on it` }, 409);
    }
    const b = (await c.req.json().catch(() => ({}))) as { summary?: unknown; release?: unknown; note?: unknown; scope?: unknown };
    const summary = typeof b.summary === "string" ? b.summary.trim() : "";
    /**
     * ═══ THE FOUNDER'S OWN WORDS, WHICH WE WERE THROWING AWAY ═══
     *
     * The console has always had a note box above the edit controls, and it only ever reached
     * `reject`. A founder who typed "too formal for this client" and then FIXED the text — the most
     * common thing they do — sent the fix and lost the sentence explaining it.
     *
     * That sentence is worth more than the diff. A diff says two paragraphs differ; "too formal for
     * this client" says why, in the vocabulary of the firm, and is exactly what the next run needs
     * to read. The distiller already receives the before and after verbatim; this gives it the one
     * thing it could not infer.
     */
    // `whyChanged`, not `note` — `note(...)` is the timeline writer a few lines down.
    const whyChanged = typeof b.note === "string" ? b.note.trim().slice(0, 500) : "";
    /**
     * ═══ WHOSE RULE IS THIS? ═══
     *
     * `scopeMeta` makes a rule client-scoped whenever a `client_id` is passed, and this route always
     * passed one. So EVERY correction a founder has ever made was silently filed against that one
     * client: edit "net margin" to "EBITDA" on one report and next month every other client's report
     * still says net margin. A product whose pitch is that corrections compound was compounding them
     * into a single-client corner.
     *
     * Client-scoped stays the DEFAULT and the argument for it is unchanged — "Brightline wants Friday
     * summaries" is not a house rule, and applying one client's preference to everybody is how a
     * system that learns makes a business worse. What was missing is the founder's ability to say
     * which kind of correction they just made. Only they know.
     *
     * An unknown value falls back to client scope rather than being refused: the narrow reading is
     * the safe one, and a typo in a request must not quietly widen a rule to the whole book.
     */
    const houseRule = b.scope === "house";
    if (!summary) return c.json({ error: "send the text you want the client to read" }, 400);

    const versions = await deliverables.listVersions(pid, d.id);
    const current = versions.find((v) => v.version === d.current_version) ?? versions[versions.length - 1];
    const at = nowIso();

    // The files come across unchanged. Editing the note a client reads is a different act from
    // replacing the work, and conflating them would let a one-word fix silently drop the PDF.
    const submitted = await deliverables.submitVersion({
      project_id: pid,
      deliverable_id: d.id,
      allowedFrom: ["in_review"],
      version: {
        summary: summary.slice(0, 4_000),
        artifact_ids: current?.artifact_ids ?? [],
        url: current?.url,
        task_id: current?.task_id,
        author: "founder",
      },
      at,
    });
    if (!submitted) return c.json({ error: "someone else moved this while you were editing it" }, 409);

    await note(d, `you edited "${d.title}" before it went out`);

    // Against the version being REPLACED — the agent's — not the one just written. The skill got
    // close enough to be worth fixing and not close enough to send, which is its own verdict and is
    // neither a win nor an outright failure.
    weighFounder(pid, current, "edited");

    /**
     * THE EDIT IS THE LESSON.
     *
     * This is how a service business teaches the harness what it actually wants, and it is the only
     * mechanism here that requires nothing of them beyond doing their job. Nobody writes down their
     * standard. They demonstrate it, by changing what was drafted and sending that instead.
     *
     * The distiller is deliberately given the BEFORE and AFTER verbatim and told nothing else. It
     * records where the rule applies and which version to match; it does not interpret. An
     * interpretation invented here would be this route deciding what the founder meant, which is
     * exactly the thing the founder just told us themselves.
     *
     * Fail-soft: a lesson that cannot be written must never undo an edit the founder is waiting to
     * send. Losing the rule costs one repetition; losing the edit costs their afternoon.
     */
    if (current && current.summary !== summary) {
      try {
        const kase = await ownedCase(pid, d.case_id);
        const rules = distillFromApprovalEdit({
          project_id: pid,
          wedge: kase?.wedge ?? "",
          // The job that WROTE this, not the one that reviews it. See `producingTaskType`.
          task_type: await producingTaskType(current),
          // Omitted for a house rule — see `houseRule` above and `scopeMeta`.
          ...(houseRule ? {} : { client_id: d.client_id }),
          action: "deliverable",
          proposed: { client_summary: current.summary },
          edited: { client_summary: summary },
          // Their own explanation, when they gave one. Never invented: an empty note stays empty
          // rather than becoming a guess about what they meant.
          ...(whyChanged ? { reason: whyChanged } : {}),
          task_id: current.task_id,
          at,
        });
        const store = getKnowledgeStore();
        for (const r of rules) await store.putRule(r);
      } catch (e) {
        console.error("[mycel] could not distil the founder's edit into a rule:", e);
      }
    }

    // `release: false` lets a founder save an edit and keep thinking. The default is to send,
    // because the whole point of editing rather than rejecting is that they are ready NOW.
    if (b.release === false) {
      return c.json({ ok: true, released: false, deliverable: submitted.deliverable, version: submitted.version });
    }
    await deliverables.releaseVersion(pid, d.id, submitted.version.version, at);
    const moved = await deliverables.transitionDeliverable(pid, d.id, "with_client", ["in_review"], at);
    if (!moved) return c.json({ error: "someone else moved this while you were editing it" }, 409);
    const told = await tellClient(moved, submitted.version);
    return c.json({ ok: true, released: true, deliverable: moved, version: submitted.version, told });
  });


  /**
   * THE FOUNDER STAGE OF THE SCALE.
   *
   * `recordDeliverableVerdict` has always been fed by the client's answer, which is the slower, rarer
   * signal — it needs a client, it arrives days later, and for a business still finding its first one
   * it never arrives at all. The founder decides on EVERY deliverable within minutes of it existing,
   * and is the harsher judge, which makes this most of the signal the library actually has.
   *
   * Attributed to the task that produced THE VERSION BEING DECIDED ON, not the deliverable's original
   * run. That distinction does the work: a founder edit creates a new version authored by `founder`,
   * so releasing an edited deliverable credits nothing to the agent — which is correct, because what
   * went out was not what the agent wrote. The agent's version already took its `edited` vote at the
   * moment it was rewritten.
   *
   * Fail-soft everywhere. A founder's release must never fail because a scoreboard could not be
   * written, and the release has already happened by the time this is called.
   */

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════════════
   * EVERY RELEASE TELLS THE CLIENT, OR SAYS WHY IT COULD NOT
   * ═══════════════════════════════════════════════════════════════════════════════════════════════
   *
   * Three routes move a deliverable to `with_client` — release, release-with-edit, and the document
   * editor's save-and-send. All three used to return `ok` and stop. Measured in production on
   * 14 September: fifteen of fifteen released deliverables, across every tenant, with zero outbound
   * messages to that client within a day. `THE-BAR.md` gate 1 — "0 of 8 accepted", "the single most
   * important number in this document" — had been read as a quality problem for weeks.
   *
   * ONE HELPER, so a fourth release route cannot be written that forgets. `every-door-learns.test.ts`
   * exists because the same class of omission has already happened three times with the lesson
   * capture; this is the same shape and gets the same treatment.
   *
   * THE OUTCOME RIDES BACK ON THE RESPONSE. A founder who releases work to a client with no email
   * address needs to know that in the second they are looking at it, not on a sweep tomorrow, and
   * `announceRelease` returns a sentence for every outcome including success.
   */
  const tellClient = async (
    moved: { project_id: string; client_id: string; title: string },
    version: { summary?: string },
  ): Promise<{ sent: boolean; detail: string; to?: string } | undefined> => {
    if (!deps.announceRelease) return undefined;
    return deps
      .announceRelease(moved, version)
      .catch((e) => ({ sent: false, detail: e instanceof Error ? e.message : String(e) }));
  };

  const weighFounder = (
    projectId: string,
    version: { task_id?: string; author?: string } | undefined,
    verdict: "released" | "edited" | "sent_back",
  ): void => {
    if (!version?.task_id) return;
    // A version the founder wrote is not evidence about a skill. Only `released` can reach here with
    // a founder-authored version, and crediting the agent for prose a human typed would be the
    // clearest possible way to make the whole scale lie.
    if (verdict === "released" && version.author === "founder") return;
    void recordDeliverableVerdict(domain, {
      project_id: projectId,
      task_id: version.task_id,
      verdict,
    }).catch((e) => console.error("[mycel] founder skill verdict failed:", e));
  };

  app.post("/v1/deliverables/:id/release", async (c) => {
    const pid = writeProjectId(c);
    if (!pid || !accessible(c).has(pid)) return c.json({ error: "not found" }, 404);
    const d = await deliverables.getDeliverable(pid, c.req.param("id"));
    if (!d) return c.json({ error: "not found" }, 404);
    if (d.status !== "in_review") {
      return c.json({ error: `"${d.title}" is ${d.status} — there is nothing waiting for your approval on it` }, 409);
    }
    const at = nowIso();
    const releasing = (await deliverables.listVersions(pid, d.id)).find((v) => v.version === d.current_version);
    await deliverables.releaseVersion(pid, d.id, d.current_version, at);
    const moved = await deliverables.transitionDeliverable(pid, d.id, "with_client", ["in_review"], at);
    if (!moved) return c.json({ error: "someone else moved this while you were looking at it" }, 409);

    // The agent's work went out as written. The strongest routine signal the library gets.
    weighFounder(pid, releasing, "released");

    // ═══ PARK THE ENGAGEMENT ON THE CLIENT'S ANSWER ═══
    //
    // No new timer, no new sweep, no new ladder. `waits.ts` already owns "this engagement is blocked
    // on the customer": it nudges on an escalating interval, gives up after three, writes the
    // timeline notes, expires at ninety days, and shows the engagement in `/next`'s waiting list
    // rather than in the list of things a founder could act on. A client who goes quiet on a
    // deliverable is the single most common way this loop stalls, and it is the same stall
    // `armWait` was written for.
    const kase = await ownedCase(pid, d.case_id);
    const carrier = kase ? verdictCarrier({ project_id: pid, wedge: kase.wedge }) : { why: "this engagement no longer exists" };
    let parked: string;
    if ("why" in carrier) {
      // FAIL SOFT, LOUDLY. The release itself has already happened and must stand — losing the
      // release because we could not arm a chase would be strictly worse than not chasing. But it is
      // said on the timeline, because the recurring expensive bug here is something failing while
      // reporting success, and "we are watching for their answer" is precisely the sort of thing a
      // founder assumes silently.
      parked = carrier.why;
    } else {
      const armed = await armWait(domain, {
        project_id: pid,
        case_id: d.case_id,
        reason: `${d.title}: waiting for your client to accept it or ask for changes`,
        condition: { kind: "deliverable_settled", deliverable_id: d.id, label: `their answer on "${d.title}"` },
        resume: { task_type: DELIVERABLE_VERDICT_TASK_TYPE, input: { deliverable_id: d.id } },
      });
      // The one-live-wait-per-case index refusing a second wait is the common failure and it is not
      // an error: the engagement is already parked on something else, which a founder can read.
      parked = armed.ok ? "we will chase them if they go quiet" : `not chasing automatically — ${armed.error}`;
    }
    await note(moved, timelineNote("released", moved, parked));
    const told = await tellClient(moved, releasing ?? {});
    return c.json({
      ok: true,
      deliverable: await toOperator(store, moved, await deliverables.listVersions(pid, d.id)),
      parked,
      told,
    });
  });

  /**
   * The founder sends it back to be redone. NOT a rejection of the deliverable — a rejection of this
   * version, which puts the work back where it came from with the note attached to the timeline.
   */
  app.post("/v1/deliverables/:id/reject", async (c) => {
    const pid = writeProjectId(c);
    if (!pid || !accessible(c).has(pid)) return c.json({ error: "not found" }, 404);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const d = await deliverables.transitionDeliverable(pid, c.req.param("id"), "drafting", ["in_review"], nowIso());
    if (!d) return c.json({ error: "not found" }, 404);
    await note(d, `you sent "${d.title}" v${d.current_version} back${b.note ? `: ${String(b.note).slice(0, 1000)}` : ""}`);

    // Refused outright, before a client ever saw it.
    weighFounder(pid, (await deliverables.listVersions(pid, d.id)).find((v) => v.version === d.current_version), "sent_back");
    return c.json({ ok: true, deliverable: await toOperator(store, d, await deliverables.listVersions(pid, d.id)) });
  });

  app.post("/v1/deliverables/:id/withdraw", async (c) => {
    const pid = writeProjectId(c);
    if (!pid || !accessible(c).has(pid)) return c.json({ error: "not found" }, 404);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const reason = String(b.reason ?? "").trim().slice(0, 500);
    if (!reason) return c.json({ error: "say why — a withdrawal with no reason is a disappearance" }, 400);
    const d = await deliverables.transitionDeliverable(
      pid,
      c.req.param("id"),
      "withdrawn",
      // Not from `accepted`. Work a client accepted is billable and may already be invoiced;
      // un-accepting it from the operator plane would let a business erase its own obligation.
      ["drafting", "in_review", "with_client", "changes_requested"],
      nowIso(),
      { withdrawn_reason: reason },
    );
    if (!d) return c.json({ error: "not found" }, 404);
    await note(d, timelineNote("withdrawn", d, reason));
    return c.json({ ok: true, deliverable: await toOperator(store, d, await deliverables.listVersions(pid, d.id)) });
  });

  /**
   * Kick another episode so the engagement produces the next version.
   *
   * Multi-shot fulfilment: work is not one-shot. After a founder sends a draft back, or a client
   * asks for changes and the automatic wait did not fire (or the founder wants it now), this is the
   * door that resumes the case's own wedge with the verdict / change-request context. Same task type
   * the wait would have used — one voice, one contract.
   */
  app.post("/v1/deliverables/:id/regenerate", async (c) => {
    const pid = writeProjectId(c);
    if (!pid || !accessible(c).has(pid)) return c.json({ error: "not found" }, 404);
    const d = await deliverables.getDeliverable(pid, c.req.param("id"));
    if (!d) return c.json({ error: "not found" }, 404);
    if (d.status !== "drafting" && d.status !== "changes_requested") {
      return c.json(
        {
          error:
            d.status === "in_review"
              ? "this version is waiting for your review — send it back first if you want it redone"
              : d.status === "with_client"
                ? "your client still has this — wait for their answer, or withdraw it"
                : `"${d.title}" is ${d.status} — nothing to regenerate`,
        },
        409,
      );
    }
    const kase = await ownedCase(pid, d.case_id);
    if (!kase) return c.json({ error: "this engagement no longer exists" }, 404);
    if (kase.status === "closed") return c.json({ error: "this engagement is closed — reopen it before regenerating" }, 409);
    const recent = await store.listTasks({ client_id: d.client_id, limit: 50 });
    const live = recent.filter(
      (t) =>
        t.project_id === pid &&
        t.case_id === d.case_id &&
        t.task_type === DELIVERABLE_VERDICT_TASK_TYPE &&
        t.status !== "succeeded" &&
        t.status !== "failed" &&
        t.status !== "rejected" &&
        t.status !== "expired" &&
        t.status !== "cancelled",
    );
    if (live.length) {
      return c.json(
        { error: "a revision is already running on this engagement — wait for it, or look at Work" },
        409,
      );
    }
    const carrier = verdictCarrier({ project_id: pid, wedge: kase.wedge });
    if ("why" in carrier) return c.json({ error: carrier.why }, 409);
    const versions = await deliverables.listVersions(pid, d.id);
    const current = versions.find((v) => v.version === d.current_version) ?? versions[versions.length - 1];
    const input = current
      ? {
          ...verdictInput(d, current),
          /** Founder-forced redo — distinct from a wait resume so the skill can acknowledge it. */
          regenerate: true,
          reason: d.status === "changes_requested" ? "client_asked_for_changes" : "founder_sent_back",
        }
      : { deliverable_id: d.id, regenerate: true, verdict: "none" };
    const taskId = await spawnTask({
      project_id: pid,
      wedge: carrier.wedge,
      task_type: DELIVERABLE_VERDICT_TASK_TYPE,
      client_id: d.client_id,
      case_id: d.case_id,
      source: "case",
      input: {
        ...input,
        case: { id: kase.id, title: kase.title, stage: kase.stage, data: kase.data },
        client_id: d.client_id,
      },
    });
    await note(d, `you asked "${d.title}" to be regenerated (run ${taskId})`);
    return c.json({
      ok: true,
      task_id: taskId,
      deliverable: await toOperator(store, d, versions),
    });
  });

  /**
   * Draft an invoice from the engagement's money plan for an ACCEPTED deliverable.
   *
   * Founder still sends/charges — this only closes the "accepted and never billed" leak by picking
   * the planned line and writing a draft. Refuses when there is no plan or no priced line left.
   *
   * ═══ THE BUG THIS ROUTE USED TO HAVE ═══
   *
   * `lineForAcceptedDeliverable` fell back to the first planned line IN ARRAY ORDER, retainer lines
   * included. On an engagement with twelve monthly retainer lines, accepting any deliverable billed
   * an arbitrary month — chosen by JSON ordering, not by anybody's decision — and that month then
   * billed again when the retainer clock came round. The picker now returns a REASON when it cannot
   * be sure, and the body may carry `line_id` so the founder answers the ambiguity instead of the
   * array doing it for them.
   */
  app.post("/v1/deliverables/:id/draft-invoice", async (c) => {
    const pid = writeProjectId(c);
    if (!pid || !accessible(c).has(pid)) return c.json({ error: "not found" }, 404);
    const d = await deliverables.getDeliverable(pid, c.req.param("id"));
    if (!d) return c.json({ error: "not found" }, 404);
    if (d.status !== "accepted") {
      return c.json({ error: "only accepted work can be drafted into an invoice from the money plan" }, 409);
    }
    const kase = await ownedCase(pid, d.case_id);
    if (!kase) return c.json({ error: "this engagement no longer exists" }, 404);
    const { readMoneyPlan, lineForAcceptedDeliverable, draftInvoiceFromPlanLine } = await import("./money-plan");
    const plan = readMoneyPlan(kase.data);
    if (!plan) return c.json({ error: "this engagement has no money plan — add one on the case first" }, 409);
    const body = (await c.req.json().catch(() => ({}))) as { line_id?: unknown };
    const named = typeof body.line_id === "string" ? body.line_id : undefined;
    let line;
    if (named) {
      // The founder named the line. The only checks are the ones the picker would have made anyway,
      // and they are made HERE rather than trusted from the body: a line id from another engagement
      // would bill this client for another client's promise.
      const found = plan.lines.find((l) => l.id === named);
      if (!found) return c.json({ error: "that money-plan line is not on this engagement" }, 404);
      if (found.status !== "planned" || found.amount_minor <= 0) {
        return c.json({ error: `“${found.label}” is not a planned line with an amount on it` }, 409);
      }
      if (found.recurrence) {
        return c.json(
          { error: `“${found.label}” is a recurring retainer — it bills on its own schedule, not on acceptance` },
          409,
        );
      }
      line = found;
    } else {
      const pick = lineForAcceptedDeliverable(plan, d.id);
      if (!pick.ok) {
        // 409 with the sentence and the candidates, so a UI can offer the choice rather than a retry
        // that would fail identically. `ambiguous` and `none` send a founder to different screens.
        return c.json(
          {
            error: pick.message,
            code: `money_plan.${pick.reason}`,
            candidates: pick.candidates.map((l) => ({ id: l.id, label: l.label, amount_minor: l.amount_minor })),
          },
          409,
        );
      }
      line = pick.line;
    }
    try {
      const out = await draftInvoiceFromPlanLine({ domain, kase, line, deliverable: d });
      await note(d, `draft invoice ${out.invoice.number} from money plan (“${line.label}”)`);
      return c.json({ ok: true, invoice: out.invoice, money_plan: readMoneyPlan(out.case.data) });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  /**
   * Founder-plane preview of one file on a deliverable version (including unreleased drafts).
   * Authorised by deliverable ownership in this project — drafts are what the founder is reviewing.
   */
  app.get("/v1/deliverables/:id/files/:artifact/preview", async (c) => {
    const pid = writeProjectId(c);
    if (!pid || !accessible(c).has(pid)) return c.json({ error: "not found" }, 404);
    const d = await deliverables.getDeliverable(pid, c.req.param("id"));
    if (!d) return c.json({ error: "not found" }, 404);
    const versions = await deliverables.listVersions(pid, d.id);
    const artifactId = c.req.param("artifact");
    if (!versions.some((v) => v.artifact_ids.includes(artifactId))) return c.json({ error: "not found" }, 404);
    const a = await store.getArtifact(artifactId);
    if (!a) return c.json({ error: "not found" }, 404);
    const preview = buildArtifactPreview(await withContent(a));
    if (!preview.ok) return c.json({ error: preview.error }, preview.status);
    if (preview.kind === "bytes") return preview.response;
    return c.json(preview.body);
  });


  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════════════
   * THE DOCUMENT, IN THE PIECES A FOUNDER CAN CLICK
   * ═══════════════════════════════════════════════════════════════════════════════════════════════
   *
   * The parse lives HERE and not in the console, and that is the whole reason this route exists
   * rather than the console splitting the text it already fetches for the preview.
   *
   * A block's id is its position in the parse — `b0`, `b1`, `b7`. If the console parsed with its own
   * copy of the splitter, then any divergence between the two implementations, in either direction,
   * would not fail: it would RENUMBER. The founder clicks the third bullet, the console calls it
   * `b12`, the kernel's parse has `b12` as the second paragraph, and the save silently overwrites a
   * sentence nobody looked at. Serving the blocks from the same function that will resolve them
   * makes that class of bug unrepresentable.
   */

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════════════
   * WHAT A FOUNDER IS ACTUALLY EDITING WHEN THEY CLICK A PDF
   * ═══════════════════════════════════════════════════════════════════════════════════════════════
   *
   * A `document` deliverable is exactly one file — the kernel enforces it — so the client's version
   * carries the PDF and only the PDF. The markdown it was rendered from is attached to the RUN,
   * which is correct: the client should receive a report, not a report and its own source.
   *
   * But the founder clicks the PDF, because the PDF is what is on the screen. Making them go and
   * find "the source file" would be exposing our rendering pipeline as a step in their review, which
   * is precisely the kind of plumbing this product is supposed to keep out of their way.
   *
   * So the indirection is resolved here, once, for both the read and the write:
   *
   *   · an ordinary file            → edit it, render nothing
   *   · a PDF with a stored source  → edit the SOURCE, re-render the PDF from it
   *   · a PDF with no source        → refuse, in words (every PDF written before this existed)
   *
   * Scoped to the run that produced the file, which is the only place a source can legitimately be:
   * resolving `renders_to` by a global lookup would let an artifact from another tenant nominate
   * itself as the source of this one.
   */
  const editTarget = async (
    onVersion: Artifact,
  ): Promise<{ edit: Artifact; rendersTo?: string } | undefined> => {
    if (editableFormat(onVersion.content_type, onVersion.name)) return { edit: onVersion };
    const siblings = await store.listArtifacts(onVersion.task_id).catch(() => []);
    const src = siblings.find((x) => (x as { renders_to?: string }).renders_to === onVersion.id);
    if (!src) return undefined;
    const full = await store.getArtifact(src.id);
    if (!full || !editableFormat(full.content_type, full.name)) return undefined;
    return { edit: full, rendersTo: onVersion.id };
  };

  app.get("/v1/deliverables/:id/files/:artifact/blocks", async (c) => {
    const pid = writeProjectId(c);
    if (!pid || !accessible(c).has(pid)) return c.json({ error: "not found" }, 404);
    const d = await deliverables.getDeliverable(pid, c.req.param("id"));
    if (!d) return c.json({ error: "not found" }, 404);
    const versions = await deliverables.listVersions(pid, d.id);
    const artifactId = c.req.param("artifact");
    if (!versions.some((v) => v.artifact_ids.includes(artifactId))) return c.json({ error: "not found" }, 404);
    const a = await store.getArtifact(artifactId);
    if (!a) return c.json({ error: "not found" }, 404);

    const target = await editTarget(a);
    if (!target) {
      // Named in words, because "you cannot edit this" with no reason reads as a broken feature. The
      // console shows this sentence and offers the two things that DO work on a PDF.
      return c.json(
        {
          editable: false,
          reason:
            `A ${a.name.split(".").pop()?.toUpperCase() ?? "file"} is a finished rendering, not a source we can safely rewrite. ` +
            `Change the note your client reads, or send it back with what to fix.`,
        },
        200,
      );
    }
    const format = editableFormat(target.edit.content_type, target.edit.name)!;

    const full = await withContent(target.edit);
    const source = full.encoding === "base64" ? Buffer.from(full.content, "base64").toString("utf8") : full.content;
    const blocks = parseBlocks(source, format);
    return c.json({
      editable: true,
      format,
      // The name the FOUNDER clicked, so the console does not suddenly start talking about a file
      // they have never seen. `rebuilds` is what tells it the client's copy will be regenerated.
      name: a.name,
      ...(target.rendersTo ? { rebuilds: true } : {}),
      // `text`, `kind`, `label` and `id` only. `start`/`end` are the kernel's business and sending
      // them would invite a console that computes its own splices.
      blocks: blocks.map((b) => ({
        id: b.id,
        kind: b.kind,
        text: b.text,
        label: b.label,
        ...(b.row !== undefined ? { row: b.row, col: b.col } : {}),
        ...(b.level !== undefined ? { level: b.level } : {}),
      })),
    });
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════════════
   * SAVING A FOUNDER'S REWRITE OF THE WORK ITSELF
   * ═══════════════════════════════════════════════════════════════════════════════════════════════
   *
   * `/edit` replaces the covering summary and passes `artifact_ids` through untouched, deliberately:
   * changing the note a client reads is a different act from replacing the work. This is the other
   * act, and it was missing. Until now the answer to "the third paragraph is wrong" was to send the
   * whole thing back and wait for another run.
   *
   * WHAT IT WRITES. A NEW artifact, never a mutation of the old one. The agent's original bytes stay
   * exactly where they are, under their own id, still attached to the version they were written for
   * — because the difference between those two files is the most valuable thing this product
   * produces and overwriting the old one destroys it to save a row.
   */
  app.post("/v1/deliverables/:id/files/:artifact/blocks", async (c) => {
    const pid = writeProjectId(c);
    if (!pid || !accessible(c).has(pid)) return c.json({ error: "not found" }, 404);
    const d = await deliverables.getDeliverable(pid, c.req.param("id"));
    if (!d) return c.json({ error: "not found" }, 404);
    if (d.status !== "in_review") {
      return c.json({ error: `"${d.title}" is ${d.status} — there is nothing waiting for your approval on it` }, 409);
    }

    const versions = await deliverables.listVersions(pid, d.id);
    const current = versions.find((v) => v.version === d.current_version) ?? versions[versions.length - 1];
    const artifactId = c.req.param("artifact");
    if (!current || !current.artifact_ids.includes(artifactId)) {
      // Deliberately not "that file is on an older version". Editing a superseded file would produce
      // a version mixing the newest work with a correction to work that has already been replaced.
      return c.json({ error: "that file is not part of the version waiting for you" }, 404);
    }

    const body = (await c.req.json().catch(() => ({}))) as { edits?: unknown; note?: unknown; release?: unknown };
    const submitted = Array.isArray(body.edits) ? body.edits : [];
    const edits: BlockEdit[] = [];
    for (const e of submitted) {
      if (!e || typeof e !== "object") continue;
      const { id, text } = e as { id?: unknown; text?: unknown };
      if (typeof id !== "string" || typeof text !== "string") continue;
      edits.push({ id, text });
    }
    if (!edits.length) return c.json({ error: "send the blocks you changed" }, 400);
    const whyChanged = typeof body.note === "string" ? body.note.trim().slice(0, 500) : "";

    const onVersion = await store.getArtifact(artifactId);
    if (!onVersion) return c.json({ error: "not found" }, 404);
    // Same resolution as the read, so the console can post against the file the founder clicked.
    const target = await editTarget(onVersion);
    if (!target) return c.json({ error: `${onVersion.name} is not a file we can edit in place` }, 415);
    const a = target.edit;
    const format = editableFormat(a.content_type, a.name)!;

    const full = await withContent(a);
    if (full.encoding === "base64") {
      // Reachable only if `editableFormat` ever says yes to something stored base64. It does not
      // today; the guard is here so that if it ever does, the failure is a sentence and not a file
      // written back as mojibake.
      return c.json({ error: `${a.name} is stored in a form we cannot edit in place` }, 415);
    }

    const source = full.content;
    const blocks = parseBlocks(source, format);
    const { text: next, changes } = applyBlockEdits(source, blocks, edits, format);
    if (!changes.length) {
      // Every submitted edit matched what was already there. Writing a version for that would put a
      // "you edited this" in their timeline for pressing save twice.
      return c.json({ ok: true, changed: false, deliverable: d, version: current });
    }

    const at = nowIso();
    const written = await store.addArtifact({
      task_id: a.task_id,
      name: a.name,
      content_type: a.content_type,
      content: next,
      encoding: "utf8",
      size_bytes: Buffer.byteLength(next, "utf8"),
      // The founder's hand is on these bytes. `upload` is the existing value for "a human put this
      // here", and the version's `author` plus `edits` carry the rest of the provenance.
      source: "upload",
      ...(d.client_id ? { client_id: d.client_id } : {}),
    });
    const backend = await getArtifactBackend();
    if (!backend.inline) await backend.put(written.id, next);

    /**
     * ═══════════════════════════════════════════════════════════════════════════════════════════
     * IF THIS MARKDOWN IS A PDF'S SOURCE, THE CLIENT'S PDF CHANGES TOO
     * ═══════════════════════════════════════════════════════════════════════════════════════════
     *
     * Without this the founder corrects the report, the version swaps in their markdown, and the
     * client still receives the PDF rendered from the sentence they just deleted. Two files
     * disagreeing about what the work says, with the wrong one being the one that gets read.
     *
     * FAIL-SOFT, and deliberately. A re-render that cannot happen — no brand kit, a template throw
     * — leaves the markdown edit standing and the old PDF in place. Losing the PDF costs a file
     * that can be regenerated; failing the save costs the correction, which is the thing we have
     * spent this whole feature trying to capture.
     */
    let rerenderedId: string | undefined;
    let replacedPdfId: string | undefined;
    if (target.rendersTo && current.artifact_ids.includes(target.rendersTo)) {
      const rendered = await store.getArtifact(target.rendersTo);
      if (rendered) {
        const out = rerenderDocument({
          projectId: pid,
          markdown: next,
          title: d.title,
          // How the run rendered it the first time, recorded on the source at that moment.
          deck: /profile=deck/i.test(a.content_type ?? ""),
        });
        if (out) {
          const be = await getArtifactBackend();
          const fresh = await store.addArtifact({
            task_id: rendered.task_id,
            // The client's file keeps ITS name, not the one the renderer just derived from the
            // title — a document that changes filename because a heading was reworded looks to the
            // client like a different document.
            name: rendered.name,
            content_type: out.content_type,
            content: be.inline ? out.content : "",
            encoding: out.encoding,
            size_bytes: out.size_bytes,
            source: "upload",
            ...(d.client_id ? { client_id: d.client_id } : {}),
          });
          if (!be.inline) await be.put(fresh.id, out.content);
          rerenderedId = fresh.id;
          replacedPdfId = target.rendersTo;
        }
      }
    }

    const versionEdits: VersionEdit[] = changes.map((ch) => ({
      block_id: ch.id,
      kind: ch.kind,
      label: ch.label,
      artifact_name: a.name,
      before: ch.before,
      after: ch.after,
    }));

    const saved = await deliverables.submitVersion({
      project_id: pid,
      deliverable_id: d.id,
      allowedFrom: ["in_review"],
      version: {
        // The covering note is not what they edited. Carrying it forward unchanged keeps this route
        // to one act, the same way `/edit` keeps the files unchanged when they only fix the note.
        summary: current.summary,
        /**
         * Two ids can move: the file the founder edited, and the PDF re-rendered from it. Every
         * other file on the version passes through untouched — a version carrying three files must
         * still carry three.
         *
         * When they edited a PDF, the SOURCE was never on the version (a `document` deliverable is
         * one file), so `id === artifactId` matches the PDF and the re-render branch replaces it.
         * When they edited a plain markdown file, `rendersTo` is undefined and only the first
         * branch fires. Ordering the re-render first makes both cases one expression.
         */
        artifact_ids: current.artifact_ids.map((id) =>
          id === replacedPdfId && rerenderedId ? rerenderedId : id === artifactId ? written.id : id,
        ),
        url: current.url,
        task_id: current.task_id,
        author: "founder",
        edits: versionEdits,
      },
      at,
    });
    if (!saved) return c.json({ error: "someone else moved this while you were editing it" }, 409);

    const what =
      changes.length === 1
        ? `you rewrote ${changes[0]!.label.toLowerCase()} in ${a.name}`
        : `you rewrote ${changes.length} parts of ${a.name}`;
    await note(d, rerenderedId ? `${what}, and the PDF was rebuilt from it` : `${what} before it went out`);

    // Against the version being replaced — the agent's. Same reasoning as `/edit`: close enough to
    // fix and not close enough to send is its own verdict.
    weighFounder(pid, current, "edited");

    /**
     * ═══ THE LESSON, KEYED ON THE KIND OF BLOCK AND NOT ITS POSITION ═══
     *
     * The tempting build is one rule per changed block. It is wrong twice over: a founder who fixes
     * six numbers in a table generates six rules, and every one of them is keyed to a POSITION —
     * "Row 4, column 2" — which will mean something different in next month's report and nothing at
     * all in a different client's.
     *
     * Grouping by block KIND is the generalisation that survives. "When you write bullets, write
     * them the founder's way" is a rule the next run can act on; the specific before and after ride
     * along in `provenance` as the evidence for it. Six numeric corrections in one table collapse to
     * one rule about table cells, which is the honest size of what was learned.
     */
    if (changes.length) {
      try {
        const kase = await ownedCase(pid, d.case_id);
        const groupBefore: Record<string, string> = {};
        const groupAfter: Record<string, string> = {};
        for (const ch of changes) {
          const field = ch.kind;
          groupBefore[field] = groupBefore[field] ? `${groupBefore[field]}\n${ch.before}` : ch.before;
          groupAfter[field] = groupAfter[field] ? `${groupAfter[field]}\n${ch.after}` : ch.after;
        }
        const rules = distillFromApprovalEdit({
          project_id: pid,
          wedge: kase?.wedge ?? "",
          // The job that WROTE this, not the one that reviews it. See `producingTaskType`.
          task_type: await producingTaskType(current),
          client_id: d.client_id,
          action: "deliverable",
          proposed: groupBefore,
          edited: groupAfter,
          ...(whyChanged ? { reason: whyChanged } : {}),
          task_id: current.task_id,
          at,
        });
        const store2 = getKnowledgeStore();
        for (const r of rules) await store2.putRule(r);
      } catch (e) {
        // Fail-soft, for the reason `/edit` gives: losing the rule costs one repetition, losing the
        // edit costs their afternoon.
        console.error("[mycel] could not distil the founder's document edit into a rule:", e);
      }
    }

    if (body.release === false) {
      return c.json({ ok: true, changed: true, released: false, deliverable: saved.deliverable, version: saved.version });
    }
    await deliverables.releaseVersion(pid, d.id, saved.version.version, at);
    const moved = await deliverables.transitionDeliverable(pid, d.id, "with_client", ["in_review"], at);
    if (!moved) return c.json({ error: "someone else moved this while you were editing it" }, 409);
    const told = await tellClient(moved, saved.version);
    return c.json({ ok: true, changed: true, released: true, deliverable: moved, version: saved.version, told });
  });

  // ── client plane ───────────────────────────────────────────────────────────────────────────────

  /** The scope is the only source of identity here — never a path or body parameter. */
  const client = (c: any) => c.get("client") as ClientScope;

  /**
   * Owned by THIS client, in THIS project. Two conditions, neither of them from the request.
   *
   * Returns undefined rather than throwing, and every caller answers 404 — the same shape
   * `ownedApproval` uses in portal-approvals.ts, for the same reason: a 403 tells the caller the row
   * exists, which is half of what they were trying to find out.
   */
  const ownedDeliverable = async (sc: ClientScope, id: string): Promise<Deliverable | undefined> => {
    if (!id) return undefined;
    const d = await deliverables.getDeliverable(sc.project_id, id);
    return d && d.client_id === sc.client_id ? d : undefined;
  };

  /**
   * Owned AND released. What a client may see at all.
   *
   * ═══ WHY THIS IS SEPARATE FROM `ownedDeliverable`, AND WHY EVERY ROUTE USES IT ═══
   *
   * A test caught this, and it is worth recording because the shape recurs. The verdict routes
   * originally used `ownedDeliverable` alone and then relied on the status transition to refuse —
   * which it did, with a 409 reading "this is no longer waiting on you". Correct outcome, wrong
   * disclosure: a client POSTing `accept` at a deliverable the founder had NOT yet released got a
   * 409 where an id belonging to another tenant got a 404. The difference between those two status
   * codes is a confirmation that the row exists, which is the whole thing portal-approvals.ts
   * returns 404-not-403 to avoid, and it turns "guess an id" into a working probe for whether a
   * business is quietly preparing work for a given client.
   *
   * So the visibility gate is applied BEFORE any state reasoning, on every client-plane route
   * without exception. Unreleased and non-existent are one answer.
   */
  const visibleDeliverable = async (
    sc: ClientScope,
    id: string,
  ): Promise<{ d: Deliverable; versions: DeliverableVersion[] } | undefined> => {
    const d = await ownedDeliverable(sc, id);
    if (!d) return undefined;
    const versions = await deliverables.listVersions(sc.project_id, d.id);
    return visibleVersions(versions).length ? { d, versions } : undefined;
  };

  app.get("/v1/portal/deliverables", async (c) => {
    const sc = client(c);
    // The scope is pushed INTO the query rather than filtered out of the result. A post-filter only
    // protects the rows the query happened to return and leaks the moment a limit truncates.
    const rows = await deliverables.listDeliverables({ project_id: sc.project_id, client_id: sc.client_id, limit: 200 });
    const out = [];
    for (const d of rows) {
      const versions = await deliverables.listVersions(sc.project_id, d.id);
      // A deliverable whose every version is still unreleased is not "an empty card", it is nothing
      // at all: the client must not learn that work exists before the founder has released any of
      // it. `DELIVERABLE_STATES.in_review.client_sees` is null for the same reason.
      if (!visibleVersions(versions).length) continue;
      const portal = toPortalDeliverable(d, versions);
      const shown = visibleVersions(versions);
      const enriched = await withFiles(store, shown);
      const byVersion = new Map(enriched.map((v) => [v.version, v.files]));
      out.push({
        ...portal,
        versions: portal.versions.map((v) => ({ ...v, files: byVersion.get(v.version) ?? [] })),
      });
    }
    return c.json({ deliverables: out });
  });

  app.get("/v1/portal/deliverables/:id", async (c) => {
    const sc = client(c);
    const seen = await visibleDeliverable(sc, c.req.param("id"));
    if (!seen) return c.json({ error: "not found" }, 404);
    const portal = toPortalDeliverable(seen.d, seen.versions);
    const shown = visibleVersions(seen.versions);
    const enriched = await withFiles(store, shown);
    const byVersion = new Map(enriched.map((v) => [v.version, v.files]));
    return c.json({
      ...portal,
      versions: portal.versions.map((v) => ({ ...v, files: byVersion.get(v.version) ?? [] })),
    });
  });

  /**
   * Download one file off a released version.
   *
   * THE AUTHORISATION RUNS FROM THE DELIVERABLE, NOT FROM THE ARTIFACT. `artifactReleasedTo` says
   * why at length: asking "does this artifact's task belong to this client" — which is how
   * `GET /v1/portal/artifacts/:id` correctly authorises a thread attachment — would also say yes to
   * a working file, a rejected draft, and an unreleased version, all of which live on tasks in this
   * client's project. The deliverable is the authority and the release is the gate.
   */
  app.get("/v1/portal/deliverables/:id/files/:artifact", async (c) => {
    const sc = client(c);
    const seen = await visibleDeliverable(sc, c.req.param("id"));
    if (!seen) return c.json({ error: "not found" }, 404);
    if (!artifactReleasedTo(seen.versions, c.req.param("artifact"))) return c.json({ error: "not found" }, 404);
    const a = await store.getArtifact(c.req.param("artifact"));
    if (!a) return c.json({ error: "not found" }, 404);
    return serveArtifact(await withContent(a));
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════════════
   * THE SAME DOCUMENT, IN THE SAME PIECES, FOR THE PERSON RECEIVING IT
   * ═══════════════════════════════════════════════════════════════════════════════════════════════
   *
   * A client could already ask for changes, and the box they typed into was the whole deliverable.
   * "The numbers look off" sends the founder back to read twelve pages; the client knew exactly
   * which cell they meant and had nowhere to put it.
   *
   * So the portal renders the blocks too — from `parseBlocks`, the SAME function the founder's
   * editor uses, so both sides of the review are pointing at the same piece of the document rather
   * than at two independent splits of it that agree until they don't.
   *
   * ═══ READ-ONLY, AND THAT IS THE PRODUCT, NOT A LIMITATION ═══
   *
   * There is no client-side write route and there must not be. The founder's whole promise is that
   * nothing reaches a client without them, and its mirror is that nothing the client touches
   * changes the work without the founder either. A client marks a sentence and says what is wrong;
   * the founder decides what to do about it. Letting a customer edit the deliverable directly would
   * make the version history unanswerable about who wrote what.
   *
   * The same release gate as every other client-plane read, applied before any state reasoning:
   * an unreleased file and a non-existent one are one answer.
   */
  app.get("/v1/portal/deliverables/:id/files/:artifact/blocks", async (c) => {
    const sc = client(c);
    const seen = await visibleDeliverable(sc, c.req.param("id"));
    if (!seen) return c.json({ error: "not found" }, 404);
    if (!artifactReleasedTo(seen.versions, c.req.param("artifact"))) return c.json({ error: "not found" }, 404);
    const a = await store.getArtifact(c.req.param("artifact"));
    if (!a) return c.json({ error: "not found" }, 404);

    const target = await editTarget(a);
    // A PDF with no stored source is not markable. Said plainly rather than as an empty list, which
    // a client would read as "this document has nothing in it".
    if (!target) {
      return c.json({ markable: false, reason: "You can ask for changes on this file as a whole." }, 200);
    }
    const full = await withContent(target.edit);
    const source = full.encoding === "base64" ? Buffer.from(full.content, "base64").toString("utf8") : full.content;
    const format = editableFormat(target.edit.content_type, target.edit.name)!;
    return c.json({
      markable: true,
      format,
      name: a.name,
      // `text` and `label` only — no ids the client could post back as an address, because nothing
      // they send resolves to a block. `label` and the quoted text are what travel with a comment.
      blocks: parseBlocks(source, format).map((b) => ({
        id: b.id,
        kind: b.kind,
        text: b.text,
        label: b.label,
        ...(b.row !== undefined ? { row: b.row, col: b.col } : {}),
        ...(b.level !== undefined ? { level: b.level } : {}),
      })),
    });
  });

  /**
   * Preview one RELEASED file. Same release gate as download; separate door so disposition can be
   * inline without weakening the download path.
   */
  app.get("/v1/portal/deliverables/:id/files/:artifact/preview", async (c) => {
    const sc = client(c);
    const seen = await visibleDeliverable(sc, c.req.param("id"));
    if (!seen) return c.json({ error: "not found" }, 404);
    if (!artifactReleasedTo(seen.versions, c.req.param("artifact"))) return c.json({ error: "not found" }, 404);
    const a = await store.getArtifact(c.req.param("artifact"));
    if (!a) return c.json({ error: "not found" }, 404);
    const preview = buildArtifactPreview(await withContent(a));
    if (!preview.ok) return c.json({ error: preview.error }, preview.status);
    if (preview.kind === "bytes") return preview.response;
    return c.json(preview.body);
  });

  /**
   * The client's verdict. ONE implementation for both verbs, because they differ in exactly two
   * places — the state they move to and what they record — and two copies of the ordering below is
   * two chances to get the ordering wrong.
   *
   * ═══ THE ORDER: TRANSITION, THEN SETTLE ═══
   *
   * The status move is the CLAIM, and it comes first. `transitionDeliverable` puts the legal-source
   * allowlist in the WHERE clause, so of two tabs — or a double-clicked button, which is the real
   * case — exactly one gets a row back and the other gets undefined. Everything after it runs on a
   * verdict this request provably owns.
   *
   * Settling the version first and transitioning second would invert that: both clicks would write
   * a verdict onto the version, the second overwriting the first, and only then would one of them
   * lose the status race. A client who clicked "accept" and then "request changes" a second later
   * would end up accepted with a change request attached, which is the shape that gets somebody
   * paid for work that was not finished.
   *
   * ACCEPTANCE IS IDEMPOTENT, and this is where. A second accept loses the claim, and rather than
   * a 409 the route re-reads and — if the deliverable is already in the state being asked for and
   * the client asking is the one who put it there — answers 200 with the same body. Retrying a
   * request that already succeeded is not an error, and a portal on a flaky train connection does
   * it constantly.
   */
  const verdict = (kind: "accepted" | "changes_requested") => async (c: any) => {
    const sc = client(c);
    // The visibility gate FIRST, before any state reasoning — see `visibleDeliverable`. An
    // unreleased deliverable and one that does not exist must be the same answer.
    const seen = await visibleDeliverable(sc, c.req.param("id"));
    if (!seen) return c.json({ error: "not found" }, 404);
    const d = seen.d;
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const text = String(b.note ?? b.request ?? "").trim().slice(0, 4000);
    const comments = readComments(b);
    const brief = formatChangeBrief(text, comments);
    if (kind === "changes_requested" && !brief) {
      return c.json({ error: "tell us what you would like changed — that is the whole message" }, 400);
    }

    const at = nowIso();
    const moved = await deliverables.transitionDeliverable(sc.project_id, d.id, kind, ["with_client"], at, {
      accepted_at: kind === "accepted" ? at : undefined,
    });
    if (!moved) {
      const fresh = await deliverables.getDeliverable(sc.project_id, d.id);
      if (fresh?.status === kind) {
        // Already there. The same answer the first call gave — see the idempotency note above.
        return c.json({ ok: true, already: true, deliverable: toPortalDeliverable(fresh, await deliverables.listVersions(sc.project_id, d.id)) });
      }
      return c.json({ error: "this is no longer waiting on you" }, 409);
    }

    const settled = await deliverables.settleVersion({
      project_id: sc.project_id,
      deliverable_id: d.id,
      version: d.current_version,
      at,
      verdict: kind === "accepted" ? { kind: "accepted", note: text || undefined } : { kind: "changes_requested", request: brief },
    });
    if (!settled) {
      // The status moved and the version did not. This cannot happen through this route — the
      // transition guarantees the version was released and unsettled — so it means the row was
      // edited underneath us. It must be LOUD: a deliverable marked accepted whose version carries
      // no acceptance is precisely the "green while broken" state this codebase keeps paying for.
      return c.json({ error: "we recorded your answer but could not attach it to the version you were looking at — please tell us" }, 500);
    }

    await note(moved, timelineNote(kind === "accepted" ? "accepted" : "changes", moved, kind === "changes_requested" ? brief : undefined));

    /**
     * ═══════════════════════════════════════════════════════════════════════════════════════════
     * AND THE LESSON, WHICH THIS ROUTE HAS BEEN THROWING AWAY SINCE IT WAS WRITTEN
     * ═══════════════════════════════════════════════════════════════════════════════════════════
     *
     * The brief went three places: the version verdict, the timeline, and the redraft's input. All
     * three are about THIS deliverable. Nothing carried it forward, so the next one of the same kind
     * for the same client began from nothing and the same complaint could arrive every month.
     *
     * This is the third time the capture has followed the mechanism instead of the decision.
     * `every-door-learns.test.ts` records the first two — inside the waiting run, then only on the
     * approvals route while campaigns decided through their own — and the pattern each time is that
     * a new door opened and the lesson stayed at the old one. A client sending work back is a door.
     * It is also the best one: everything else here learns from a founder guessing what the customer
     * wants, and this is the customer saying it.
     *
     * Fail-soft, like every other capture. The client has decided and the redraft is already moving;
     * failing their request because a rule could not be filed would trade the job for the note.
     */
    if (kind === "changes_requested") {
      void (async () => {
        const store = getKnowledgeStore();
        /*
          THE WEDGE COMES FROM THE ENGAGEMENT. `Deliverable` carries no wedge and no task type — it
          knows its case, and the case knows the service. `task_types` is left empty on purpose,
          which this module documents as "the whole wedge": the complaint is about the KIND of thing
          the client received, and that kind is already the discriminating half of the subject.
          Guessing a task type to narrow it would make the lesson unreachable from the job that
          actually produces the next one.
        */
        const kase = await domain.getCase(moved.case_id).catch(() => undefined);
        const rule = distillFromChangeRequest({
          project_id: sc.project_id,
          wedge: kase?.wedge ?? "",
          task_type: "",
          client_id: d.client_id,
          deliverable_kind: d.kind ?? d.title ?? "",
          request: brief,
          deliverable_id: d.id,
          at,
        });
        if (rule) await applyDistilled(store, [rule], at);
        /*
          The observation goes in WHETHER OR NOT a rule was stored. `feedback_bad` is the measurement
          of "the agent got it wrong", and a change request with no client attached is still the
          agent getting it wrong — suppressing the count because the lesson could not be scoped would
          make the quality metric flattering for exactly the rows we understand least.
        */
        await store.recordObservation({
          project_id: sc.project_id,
          wedge: kase?.wedge ?? "",
          task_type: "",
          client_id: d.client_id,
          kind: "feedback_bad",
          subject: rule?.subject,
          at,
        });
      })().catch((e) => console.error("[mycel] could not learn from a change request:", e));
    }

    /**
     * THE FIRST TIME A CLIENT SIGNED OFF THE WORK — the moment the loop closed on quality rather
     * than on money. Recorded here, from the CLIENT plane, because this is the only route where the
     * customer themselves is the one saying it.
     *
     * The satisfaction check that hangs off this is due three weeks later, when they know whether
     * the second deliverable was as good as the first. Asked on the day, everybody says nine.
     */
    if (kind === "accepted") {
      await reachMilestone(domain, {
        project_id: moved.project_id,
        kind: "first_deliverable_accepted",
        at,
        subject: moved.title,
      }).catch((e) => console.error("[mycel] could not record the first-acceptance milestone:", e));
    }

    // The retainer stage: they asked for a change, we sent v2+, they signed off. Stamp it on the
    // case so lifecycle.observe can see `revision_accepted` from live data, not only from a
    // simulation that used the word `accept`.
    if (kind === "accepted" && (d.current_version ?? 1) >= 2) {
      const kase = await domain.getCase(moved.case_id).catch(() => undefined);
      if (kase) {
        await domain
          .updateCase(
            kase.id,
            { data: { ...(kase.data ?? {}), revision_accepted_at: at } },
            {
              at,
              kind: "note",
              note: `revision accepted — version ${d.current_version} signed off after changes`,
              actor: "client",
            },
          )
          .catch(() => {});
      }
    }

    // Weigh the skills the producing run used: accepting is a win for them, asking for changes a
    // loss. Tenant + global scale. Fail-soft — a verdict must never fail because the scale could not
    // be written. See skill-scales.ts.
    void recordDeliverableVerdict(domain, {
      project_id: sc.project_id,
      task_id: settled.task_id,
      verdict: kind,
    }).catch((e) => console.error("[mycel] recordDeliverableVerdict failed:", e));

    // ═══ THE LOOP RUNS NOW ═══
    //
    // The wait armed at release is the spawn path — one claim, one run. Firing it here rather than
    // on the five-minute sweep is what makes "ask for changes → we revise → founder approves →
    // back to you" feel like a service business instead of a mailbox. The sweep remains the backup
    // if this process dies between settle and resume; `claimWait` makes the two doors one run.
    //
    // A revision is not an acceptance. Nothing here drafts an invoice. The money-plan picker only
    // runs on `accepted`, and this branch is the other verdict.
    let revision_started: string | undefined;
    const resumed = await resumeSettledDeliverable(moved);
    if (resumed.task_id) {
      revision_started = resumed.task_id;
    } else if (kind === "changes_requested" && resumed.why === "no wait parked on this work") {
      // The wait never armed (one-live-wait, or the trade does not declare the verdict type). The
      // client still asked for work; spawn the same episode regenerate would, so the ask is not
      // a note on a silent engagement.
      const spawned = await spawnRevision(moved, "client_asked_for_changes").catch((e) => ({ why: (e as Error).message }));
      if ("task_id" in spawned && spawned.task_id) {
        revision_started = spawned.task_id;
        await note(moved, `started the next version of "${moved.title}" from your client's comments`);
      } else if ("why" in spawned && spawned.why) {
        await note(moved, `could not start the next version automatically — ${spawned.why}`);
      }
    } else if (resumed.why && resumed.why !== "no wait parked on this work") {
      await note(moved, `could not pick the work back up automatically — ${resumed.why}`);
    }

    return c.json({
      ok: true,
      deliverable: toPortalDeliverable(moved, await deliverables.listVersions(sc.project_id, d.id)),
      ...(revision_started ? { task_id: revision_started } : {}),
    });
  };

  app.post("/v1/portal/deliverables/:id/accept", verdict("accepted"));
  app.post("/v1/portal/deliverables/:id/request-changes", verdict("changes_requested"));
}
