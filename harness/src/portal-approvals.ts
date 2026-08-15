// Client-facing approvals — the sign-off that actually matters in an agency.
//
// The approval machinery was already solid and already correct: `awaitApproval` suspends the run,
// `resolveApproval` releases it, and the wedge policy envelope can settle one without a human. All
// of it was OPERATOR-PLANE ONLY, which means the approval a service business genuinely lives on —
// the CLIENT signing off a deliverable before it goes out — was modelled nowhere. The founder
// approved on the client's behalf, from a screen the client could not see, which is not sign-off.
//
// So this file adds no new primitive. It reuses `resolveApproval` verbatim; the entire work is
// scoping and redaction, and those are the two things worth being careful about.
//
// ── Which approvals a client may see, and why it is an allowlist ──
//
// NOT "every approval on a task attributed to this client". Most approvals on a client's task are
// the business's own outbound actions — `email:send_reminder`, `linkedin:connect` — and letting the
// customer decide those would hand them a veto over how the business operates, plus a live feed of
// every action it takes on their file. The founder's plane already covers those.
//
// A client-facing approval is one whose action is namespaced `client:`. The namespace is the
// declaration: a wedge that wants a customer to sign something off asks for `client:sign_off` and
// gets a portal card; everything else stays where it was. Fails closed — an action nobody has
// thought about is operator-only, which is the safe default and the one that does not need a
// migration when a new capability lands.
import type { Hono } from "hono";
import type { Approval } from "./contract";
import { resolveApproval } from "./approvals";
import type { ClientScope } from "./portal";
import { taskClientId } from "./runtime";
import type { Store } from "./store";

/** The namespace that makes an approval the customer's decision rather than the operator's. */
export const CLIENT_ACTION_PREFIX = "client:";

export function isClientFacing(action: string): boolean {
  return typeof action === "string" && action.startsWith(CLIENT_ACTION_PREFIX);
}

/**
 * What a client may see INSIDE an approval preview.
 *
 * The same reasoning as `PORTAL_FIELDS` on the event stream: a type allowlist is only half the
 * boundary. A preview is a free-form object built by whatever raised the approval, so forwarding it
 * verbatim means every field a wedge author ever adds — internal notes, cost estimates, the
 * operator's draft reasoning — reaches the customer the moment it is added. This is a field
 * allowlist, and it fails closed: an unknown key is dropped, so the worst outcome is a card with
 * less on it than intended rather than one with an operator's private note on it.
 */
const PREVIEW_FIELDS: readonly string[] = [
  "summary",
  "title",
  "description",
  "body",
  "artifact_id",
  "artifact_name",
  "amount",
  "currency",
  "due_at",
  "url",
];

export function redactPreview(preview: Record<string, unknown> | undefined): Record<string, unknown> {
  const src = preview ?? {};
  const out: Record<string, unknown> = {};
  for (const k of PREVIEW_FIELDS) if (k in src) out[k] = src[k];
  return out;
}

/** The portal projection. No `risk`, no `policy_reason` — both describe the operator's posture. */
export function toPortalApproval(a: Approval, taskId: string) {
  return {
    approval_id: a.approval_id,
    task_id: taskId,
    // The bare verb, without the plane marker. "sign_off", not "client:sign_off".
    action: a.action.slice(CLIENT_ACTION_PREFIX.length),
    preview: redactPreview(a.preview),
    status: a.status,
    expires_at: a.expires_at,
    created_at: a.created_at,
    decided_at: a.decided_at,
  };
}

export interface PortalApprovalDeps {
  store: Store;
}

export function mountPortalApprovals(app: Hono, deps: PortalApprovalDeps): void {
  const { store } = deps;
  const session = (c: any) => c.get("client") as ClientScope;

  /**
   * Is this approval this client's to make?
   *
   * Four conditions, all required, and none of them taken from the request: the approval must be
   * client-facing by namespace, its task must exist, be in the SESSION's project, and be attributed
   * to the SESSION's client. Checking the task's project alone would let a client sign off work on
   * a colleague's file inside the same business; checking `client_id` alone would let a stale id
   * cross a tenant.
   */
  const ownedApproval = async (sc: ClientScope, id: string): Promise<{ a: Approval; taskId: string } | undefined> => {
    if (!id) return undefined;
    const a = await store.getApproval(id);
    if (!a || !isClientFacing(a.action)) return undefined;
    const t = await store.getTask(a.task_id);
    if (!t || t.project_id !== sc.project_id || taskClientId(t) !== sc.client_id) return undefined;
    return { a, taskId: t.id };
  };

  /** What this client is being asked to sign off. */
  app.get("/v1/portal/approvals", async (c) => {
    const sc = session(c);
    const status = c.req.query("status");
    const wanted = status === "pending" || status === "approved" || status === "rejected" ? status : undefined;
    const all = await store.listApprovals(wanted === "pending" ? "pending" : undefined);
    const out: ReturnType<typeof toPortalApproval>[] = [];
    for (const a of all) {
      if (!isClientFacing(a.action)) continue;
      if (wanted && a.status !== wanted) continue;
      const t = await store.getTask(a.task_id);
      // Both halves, every row. This loop is the only place the list is filtered, so a missed
      // condition here is the whole leak.
      if (!t || t.project_id !== sc.project_id || taskClientId(t) !== sc.client_id) continue;
      out.push(toPortalApproval(a, t.id));
    }
    out.sort((x, y) => y.created_at.localeCompare(x.created_at));
    return c.json(out);
  });

  /**
   * The client's decision.
   *
   * `resolveApproval` is called EXACTLY as the founder route calls it — same function, same
   * atomicity, same waiter. The only difference between the planes is who was allowed to get here.
   *
   * Note what is not accepted: `edited`. Approve-with-edit is the operator correcting the agent, and
   * that correction is filed as a grounding example for the whole wedge. A customer's edit is not
   * that; it is feedback on one deliverable, and it belongs in the thread as a rejection reason.
   */
  const decide = (decision: "approved" | "rejected") => async (c: any) => {
    const sc = session(c);
    const owned = await ownedApproval(sc, c.req.param("id"));
    // 404, not 403: telling a prober that an approval id is real but not theirs is the same leak as
    // returning it.
    if (!owned) return c.json({ error: "not found" }, 404);
    if (owned.a.status !== "pending") return c.json({ error: `already ${owned.a.status}` }, 409);
    const settled = resolveApproval(owned.a.approval_id, decision);
    if (!settled) {
      // No live waiter: expired, or settled between the read and here. Reflect the terminal state
      // rather than overriding a decision that has already had effects.
      const fresh = await store.getApproval(owned.a.approval_id);
      return c.json({ error: `already ${fresh?.status ?? "resolved"}` }, 409);
    }
    return c.json({ ok: true, decision });
  };

  app.post("/v1/portal/approvals/:id/approve", decide("approved"));
  app.post("/v1/portal/approvals/:id/reject", decide("rejected"));
}
