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
import type { Hono } from "hono";
import type { Artifact, Case, Deliverable, DeliverableVersion, TaskSource } from "./contract";
import type { DomainStore } from "./domain";
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
import { recordDeliverableVerdict } from "./skill-scales";
import { armWait, evaluateWait, resumeWait } from "./waits";

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

/** Read and normalise the payload half of a version body. Shared by the agent and founder submits. */
function readVersionBody(b: Record<string, unknown>): { summary: string; artifact_ids: string[]; url?: string } {
  return {
    summary: String(b.summary ?? "").slice(0, 4000),
    artifact_ids: Array.isArray(b.artifact_ids) ? (b.artifact_ids as unknown[]).map(String).slice(0, 51) : [],
    url: typeof b.url === "string" && b.url.trim() ? b.url.trim() : undefined,
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
      const kindFault = deliverableKindFault(b.kind);
      if (kindFault) return c.json({ ok: false, error: kindFault }, 400);
      const title = String(b.title ?? "").trim();
      if (!title) return c.json({ ok: false, error: "a deliverable needs a title — it is what your client sees" }, 400);
      d = await deliverables.createDeliverable({
        project_id: projectId,
        case_id: kase.id,
        client_id: kase.client_id,
        title: title.slice(0, 200),
        kind: b.kind as Deliverable["kind"],
      });
    }

    const body = readVersionBody(b);
    const bad = payloadFault(d.kind, body);
    if (bad) return c.json({ ok: false, error: bad }, 400);
    const artFault = await artifactFault(store, projectId, body.artifact_ids);
    if (artFault) return c.json({ ok: false, error: artFault }, 400);

    const result = await deliverables.submitVersion({
      project_id: projectId,
      deliverable_id: d.id,
      // NOT `with_client`. A run must not be able to replace a version a client is currently
      // looking at: the client would leave a verdict on something that had silently changed
      // underneath them, and the change request would point at the wrong thing forever.
      allowedFrom: ["drafting", "changes_requested"],
      version: { ...body, task_id: task.id },
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
      deliverables: rows.map((d) => ({ ...d, state_note: DELIVERABLE_STATES[d.status].founder_sees })),
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
      });
    }

    const body = readVersionBody(b);
    const bad = payloadFault(d.kind, body);
    if (bad) return c.json({ error: bad }, 400);
    const artFault = await artifactFault(store, pid, body.artifact_ids);
    if (artFault) return c.json({ error: artFault }, 400);

    const result = await deliverables.submitVersion({
      project_id: pid,
      deliverable_id: d.id,
      allowedFrom: ["drafting", "changes_requested"],
      version: body,
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
  app.post("/v1/deliverables/:id/release", async (c) => {
    const pid = writeProjectId(c);
    if (!pid || !accessible(c).has(pid)) return c.json({ error: "not found" }, 404);
    const d = await deliverables.getDeliverable(pid, c.req.param("id"));
    if (!d) return c.json({ error: "not found" }, 404);
    if (d.status !== "in_review") {
      return c.json({ error: `"${d.title}" is ${d.status} — there is nothing waiting for your approval on it` }, 409);
    }
    const at = nowIso();
    await deliverables.releaseVersion(pid, d.id, d.current_version, at);
    const moved = await deliverables.transitionDeliverable(pid, d.id, "with_client", ["in_review"], at);
    if (!moved) return c.json({ error: "someone else moved this while you were looking at it" }, 409);

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
    return c.json({ ok: true, deliverable: await toOperator(store, moved, await deliverables.listVersions(pid, d.id)), parked });
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
