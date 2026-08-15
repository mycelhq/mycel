// After a fulfillment run succeeds, the work has to become a Deliverable — not stay an artifact
// keyed to a task id that the founder never opens and the client can never see.
//
// ═══ THE GAP THIS CLOSES ═══
//
// `runTask` writes `result.txt`, the run goes green, and there it stopped. Deliverables already
// exist as a noun (portal, versions, founder gate, accept → invoice). Almost nothing created one.
// Kickoff does not start production work. So Deliverables stayed empty on a business that was
// doing the work, which is the most expensive empty screen in the product: the founder thinks
// nothing shipped, the client has nothing to accept, and accepted work never becomes an invoice.
//
// ═══ WHAT THIS WILL NOT WRAP ═══
//
// Chase, nudge, GTM, clock ticks, shaping — either they declare no `fulfillment.deliverable_shapes`,
// or they share a wedge that does (books-keeper chase_receipts) and are skipped by task type.
// A mock run (`MYCEL_RUNTIME=mock`) is the caller's to skip — `[mock]` strings are not a delivery.
// A run with no case or no client cannot be billed or shown, so it is refused here the same way
// the founder-plane route refuses it.
import { loadProjectWedge } from "./authored";
import type { Deliverable, Task } from "./contract";
import { getDeliverableStore } from "./deliverables";
import { getDomainStore } from "./domain";
import { fulfillmentOf } from "./kickoff";

/** Task types that speak to a client but are not a piece of work they review. */
const OPERATIONAL_TASK =
  /^(chase_|nudge_|check_in|send_receipt|daily_sync|outreach_|propose_|find_prospects|advance_)/;

/**
 * Exported so the ignition sweep and this wrapper share ONE definition of "operational" — the sweep
 * must never pick an operational type as the thing to produce, for the same reason the wrapper never
 * turns one into a deliverable. Two copies of this regex would drift; see the shared-lookup argument.
 */
export function isOperationalTaskType(taskType: string): boolean {
  return OPERATIONAL_TASK.test(taskType);
}

export async function wrapFulfillmentDeliverable(args: {
  task: Task;
  artifactId: string;
  summary: string;
  /** The run's full text output — rendered into a branded PDF for a `document` deliverable. */
  content?: string;
  /**
   * Turn the run's markdown into a branded document artifact, returning its id. Injected by the
   * caller because rendering needs the main store, the project's brand kit and the artifact backend,
   * none of which this wrapper reaches. Absent (or returning undefined) keeps the plain-text
   * artifact, so a document deliverable is never blocked on a render.
   */
  renderDocument?: (a: { task: Task; content: string; title: string }) => Promise<string | undefined>;
}): Promise<Deliverable | undefined> {
  const { task, artifactId, summary, content, renderDocument } = args;
  const projectId = task.project_id;
  if (!projectId || !task.case_id) return undefined;

  // Chases, nudges, check-ins and receipts are operational — wrapping them as something the client
  // must "accept" fills Deliverables with mail the founder already sent and never becomes an invoice.
  if (OPERATIONAL_TASK.test(task.task_type)) return undefined;

  const loaded = await loadProjectWedge(projectId, task.wedge).catch(() => null);
  const spec = fulfillmentOf(task.wedge, loaded?.manifest);
  const kind = spec?.deliverable_shapes?.find((s) => s === "document" || s === "file_set");
  if (!kind) return undefined;

  const kase = await getDomainStore().getCase(task.case_id);
  if (!kase || !kase.client_id) return undefined;
  if (kase.project_id && kase.project_id !== projectId) return undefined;
  const clientId = task.client_id || kase.client_id;

  const store = getDeliverableStore();
  const open = await store.listDeliverables({ project_id: projectId, case_id: kase.id, open: true });
  for (const d of open) {
    const versions = await store.listVersions(projectId, d.id);
    if (versions.some((v) => v.task_id === task.id)) return d;
  }

  const at = new Date().toISOString();
  const note = (summary.trim() || "First version from this run.").slice(0, 2_000);
  const title = (kase.title || "Work ready for review").slice(0, 200);

  // The document half of the top-20: a `document` deliverable ships as a branded PDF, not the raw
  // `result.txt` the run wrote. Only `document` (exactly one artifact) is rendered — a `file_set` is
  // several files the run authored on purpose, and reducing them to one PDF would be lossy. A failed
  // render falls back to the plain-text artifact, because a document a client can read beats a
  // delivery blocked on a renderer.
  let deliveredArtifactId = artifactId;
  if (kind === "document" && content && renderDocument) {
    const rendered = await renderDocument({ task, content, title }).catch(() => undefined);
    if (rendered) deliveredArtifactId = rendered;
  }

  const target =
    open.find((d) => d.status === "changes_requested" || d.status === "drafting") ??
    (await store.createDeliverable({
      project_id: projectId,
      case_id: kase.id,
      client_id: clientId,
      title,
      kind,
    }));

  const result = await store.submitVersion({
    project_id: projectId,
    deliverable_id: target.id,
    allowedFrom: ["drafting", "changes_requested"],
    version: { summary: note, artifact_ids: [deliveredArtifactId], task_id: task.id },
    at,
  });
  return result?.deliverable ?? target;
}
