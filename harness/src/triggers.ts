// Triggers — what turns "your business runs at 6am" into "your business answers when something
// happens".
//
// A schedule is a clock. A trigger is a doorbell. Both end in exactly the same place: a queued task
// in a project, attributed to a client, metered against a plan. That sameness is the point — a
// trigger must not be a second, softer way to start a run, because the moment it is, every limit
// and every attribution rule in the kernel has a hole in it.
//
// The three things this file is responsible for, in order of how badly each one hurts if it's wrong:
//
//   1. ROUTING IS NOT TAKEN FROM THE PAYLOAD. Composio delivers every trigger for every one of a
//      founder's customers to ONE project-wide webhook URL, signed with ONE project-wide secret.
//      So a valid signature proves only "Composio sent this" — it says nothing about whose run it
//      should become. The `trigger_id` in the delivery is looked up in `trigger_subs`, and the
//      stored row decides the project, the client and the wedge. If the payload claimed a
//      `user_id`, it is checked against the subscription and a mismatch is refused, never obeyed.
//
//   2. IDEMPOTENCY IS STRUCTURAL, NOT BEST-EFFORT. Webhooks are redelivered — on our 5xx, on their
//      retry timer, on a network blip that dropped our 200. The task id is DERIVED from Composio's
//      delivery id, so a duplicate delivery computes the same id, finds the task already there, and
//      stops. That also means `enqueueTask`'s existing `jobKey` (which is the task id) dedupes the
//      run itself, and it survives a restart because the check is a row in the store rather than a
//      map in a process. No third idempotency mechanism.
//
//   3. PLAN LIMITS APPLY. Identical checks to `POST /v1/tasks`, on the same numbers, or triggers
//      would be a hole straight through the metering: a customer whose Gmail is busy would cost
//      more than their plan allows and nothing would notice.
import { createHash } from "node:crypto";
import type { Connection, Task, TriggerSub } from "./contract";
import { composioUserId } from "./composio";
import type { TriggerEvent } from "./composio";
import { loadConfig } from "./config";
import type { DomainStore } from "./domain";
import { getIdentityStore } from "./identity";
import { enqueueTask } from "./queue";
import type { Store } from "./store";
import { loadWedge } from "./wedge";

/**
 * A stable UUID for a delivery.
 *
 * `tasks.id` is a real `uuid` column in Postgres, so this has to be UUID-shaped rather than just
 * unique. Deterministic on the delivery id, which is the whole trick: the second delivery of the
 * same event computes the same id and collides with the row the first one wrote, instead of
 * relying on an in-process set that a deploy would forget.
 *
 * Namespaced by the subscription as well as the event, so two subscriptions that somehow saw the
 * same delivery id can't silently share one run.
 */
export function taskIdForEvent(subId: string, eventId: string): string {
  const h = createHash("sha256").update(`mycel:composio-trigger:${subId}:${eventId}`).digest("hex");
  // v5-shaped: version nibble 5, variant nibble 8. Same construction as identity.ts's stableUuid.
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export type TriggerOutcome =
  | { ok: true; task_id: string; duplicate?: true }
  | { ok: false; status: 200 | 402 | 404; reason: string };

/**
 * Turn a VERIFIED delivery into a queued task. The caller has already checked the signature; this
 * function assumes nothing else about the payload.
 */
export async function startRunFromTrigger(args: {
  store: Store;
  domain: DomainStore;
  event: TriggerEvent;
  sub: TriggerSub;
  connection?: Connection;
}): Promise<TriggerOutcome> {
  const { store, domain, event, sub, connection } = args;
  const identity = getIdentityStore();

  if (!sub.enabled) return { ok: false, status: 200, reason: "subscription is disabled" };

  const projectId = sub.project_id;
  if (!projectId) return { ok: false, status: 404, reason: "subscription has no project" };

  /**
   * The user_id cross-check.
   *
   * Composio derives this from the connected account, and `composioUserId` derives the same string
   * from the connection's owner. If they disagree, the delivery is not for this subscription —
   * which would mean either their routing is wrong or ours is. Either way the safe answer is to
   * start nothing, because the failure mode is running one customer's job against another
   * customer's data. Only checked when both sides actually supply it.
   */
  if (event.user_id && connection) {
    const expected = composioUserId(connection);
    if (event.user_id !== expected) {
      return { ok: false, status: 404, reason: "delivery does not match this subscription's account" };
    }
  }

  // The wedge must still exist and still be enabled for the project. A founder who removes a wedge
  // shouldn't discover it's still running because a webhook kept firing.
  const wedge = loadWedge(sub.wedge);
  if (!wedge) return { ok: false, status: 404, reason: `unknown wedge: ${sub.wedge}` };
  const types = wedge.manifest.task_types;
  if (types && Object.keys(types).length && !types[sub.task_type]) {
    return { ok: false, status: 404, reason: `unknown task_type "${sub.task_type}"` };
  }
  if (!identity.projectAllowsWedge(projectId, sub.wedge)) {
    return { ok: false, status: 404, reason: `wedge "${sub.wedge}" is not enabled for this project` };
  }

  // Idempotency, before any limit is spent: a redelivery must not consume plan budget either.
  const eventId = event.event_id || `${event.trigger_id ?? sub.id}:${event.timestamp ?? ""}`;
  const taskId = taskIdForEvent(sub.id, eventId);
  const existing = await store.getTask(taskId);
  if (existing) return { ok: true, task_id: taskId, duplicate: true };

  /**
   * The metered limits — the same two checks, in the same order, on the same numbers as
   * `POST /v1/tasks`. Deliberately duplicated in shape rather than shared through a helper the API
   * route doesn't use, so that a future change to one is visibly a change to only one.
   */
  const project = identity.getProject(projectId);
  const orgId = project?.org_id;
  if (orgId) {
    /**
     * The subscription check, ahead of the numbers, exactly as on `POST /v1/tasks`.
     *
     * This is the scheduled-work path — a trigger fires with no human watching — so it is the one
     * that must not stop for an unexplained reason. Falling through to the numeric check would
     * refuse a lapsed org as `task_limit`, the identical code a Growth customer gets at their
     * ten-thousandth job, making "they cancelled" and "they had a busy month" indistinguishable in
     * the logs and in whatever the product renders from them.
     *
     * THE ONE PLACE THIS PATH DELIBERATELY DIVERGES FROM `POST /v1/tasks`, now that that route has
     * a pre-subscription exemption (`presubscription.ts`): there is none here, and there must not
     * be. That exemption is for work a human is watching, that only ever drafts, and that IS the
     * sales pitch — without it a founder could not reach the card at all, which is what production
     * did to every new signup. A trigger is the opposite of all three: nobody is watching, it acts
     * on a real client's inbound message, and it is the metered product itself.
     */
    const blocked = identity.workBlockedBy(orgId);
    if (blocked) return { ok: false, status: 402, reason: "plan_inactive" };

    const limits = identity.limitsFor(orgId);
    const orgProjects = identity.listProjects(orgId).map((p) => p.id);
    if (limits.tasks_per_month !== null) {
      const used = await store.countTasksSince(orgProjects, monthStart());
      if (used >= limits.tasks_per_month) {
        return { ok: false, status: 402, reason: "task_limit" };
      }
    }
    if (limits.model_spend_usd_per_month !== null) {
      const spent = await store.sumCostSince(orgProjects, monthStart());
      if (spent >= limits.model_spend_usd_per_month) {
        return { ok: false, status: 402, reason: "spend_limit" };
      }
    }
  }

  const cfg = loadConfig();
  const now = new Date().toISOString();
  const task: Task = {
    id: taskId,
    project_id: projectId,
    wedge: sub.wedge,
    task_type: sub.task_type,
    /**
     * Attribution. `kind: "user"` with the client's id is what `selectGrantableConnections` reads
     * to scope the run to that client's connections — the same thing an inbound portal message
     * does. A founder-owned trigger stays a business actor, so it gets the founder's connections
     * and no client's.
     */
    actor:
      sub.owner.kind === "client"
        ? { kind: "user", id: sub.owner.id }
        : { kind: "business", id: "founder" },
    input: {
      trigger: {
        slug: event.trigger_slug,
        subscription_id: sub.id,
        connection_id: sub.connection_id,
        at: event.timestamp ?? now,
      },
      ...(sub.owner.kind === "client" ? { client_id: sub.owner.id } : {}),
      // The event body, handed to the agent as data. Not logged anywhere on the way in — see the
      // webhook route; these carry customers' email contents.
      event: event.data,
    },
    constraints: {
      max_cost_usd: Math.min(1, cfg.maxCostCeilingUsd),
      // 300 was three model completions when it was written and is three at 95s each today only if
      // nothing goes wrong — a trigger-fired run reads knowledge and calls tools like any other. It
      // matches the `decide` shape default for the same reason that one moved: the unit here is
      // completions, not minutes. See SHAPE_DEFAULTS.decide in harness.ts.
      max_runtime_s: Math.min(420, cfg.maxRuntimeCeilingS),
      approval_required: false,
    },
    tools: [],
    output_schema: types?.[sub.task_type]?.output_schema,
    status: "queued",
    cost_usd: 0,
    created_at: now,
    updated_at: now,
  };

  await store.createTask(task);
  await domain.updateTriggerSub(sub.id, { last_event_at: now, last_task_id: task.id });
  // jobKey is the task id, so even if two deliveries raced past the `getTask` check above, the
  // queue still admits exactly one run.
  await enqueueTask(store, task.id);
  return { ok: true, task_id: task.id };
}

function monthStart(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}
