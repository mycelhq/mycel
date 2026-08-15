// Post-reply conversation: one human-gated DM at a time, after the sequencer has stopped.
//
// Deliberately NOT the campaign envelope. The envelope is batch consent to a sequence a founder
// read in full before anyone was contacted; once a stranger has answered in their own words, the
// next message is a reply to a person rather than the next item on a list, and no batch consent
// covers it. `replied` and `booked` are terminal stages precisely so the machine cannot keep
// talking — this module is the only way words go out after that, and every one of them costs a
// human an explicit approve.
import { randomUUID } from "node:crypto";
import { executeAction } from "../actions";
import type { Case, Connection, Task } from "../contract";
import type { DomainStore } from "../domain";
import type { Store } from "../store";
import { gtmWedge } from "./stages";

export const PROPOSE_REPLY_TASK = "propose_reply";

/** A refusal the caller asked for: bad stage, bad body, wrong project. Answered 400. */
export class ReplyError extends Error {}

/**
 * The send itself failed at LinkedIn — the founder's decision was fine, the transport was not.
 *
 * A SEPARATE CLASS BECAUSE THE RECORD MUST MATCH WHAT HAPPENED. The first version of this collapsed
 * a Voyager outage into `ReplyError`, which meant the route answered 400 ("you sent me a bad
 * request") and the approval row was written `rejected` — i.e. the audit trail said the founder had
 * read the draft and turned it down, when in fact they approved it and LinkedIn was down. That is
 * the exact class of bug this repo keeps paying for: a failure recorded as something other than
 * itself. The approval stays `approved`, the task goes `failed` with the transport detail, and the
 * route answers 502.
 */
export class ReplySendError extends Error {
  constructor(
    message: string,
    readonly approval_id: string,
    readonly task_id: string,
  ) {
    super(message);
  }
}

/**
 * Queue a draft reply for human approval. Sends nothing.
 *
 * Stage must be `replied` (or already `booked`, for a confirmation note). `won`/`lost` refuse: those
 * are closed, and re-opening a conversation from a closed case is a different decision.
 */
export async function proposeReply(
  store: Store,
  domain: DomainStore,
  args: {
    project_id: string;
    kase: Case;
    connection: Connection;
    body: string;
    actor?: string;
  },
): Promise<{ approval_id: string; task_id: string }> {
  // Tenancy, both halves, before anything is written. The case is fetched by the route from a
  // project-scoped read, but this function is also called from the wedge task path, so it verifies
  // rather than assumes: a case and a connection from two different projects must never meet here.
  if (!args.project_id) throw new ReplyError("propose_reply needs a project");
  if (args.kase.project_id !== args.project_id) throw new ReplyError("that prospect belongs to another project");
  if (args.connection.project_id !== args.project_id) throw new ReplyError("that account belongs to another project");

  const stage = args.kase.stage;
  if (stage !== "replied" && stage !== "booked") {
    throw new ReplyError(`propose a reply only after they answered (stage is "${stage}")`);
  }
  const text = args.body.trim();
  if (!text) throw new ReplyError("a reply needs message text");
  if (args.connection.kind !== "linkedin") throw new ReplyError("replies go out on a LinkedIn account");

  const data = (args.kase.data ?? {}) as Record<string, unknown>;
  const connectionId = typeof data.connection_id === "string" ? data.connection_id : "";
  if (connectionId && connectionId !== args.connection.id) {
    // Multi-seat campaigns exist: a reply must go out from the seat that opened the conversation,
    // or the prospect gets a message from a stranger in a thread they have never seen.
    throw new ReplyError("this prospect belongs to a different LinkedIn account");
  }
  const thread = typeof data.thread === "string" ? data.thread.trim() : "";
  const profileId = typeof data.profile_id === "string" ? data.profile_id.trim() : "";
  if (!thread && !profileId) {
    throw new ReplyError("this prospect has neither a conversation urn nor a profile id");
  }

  const iso = new Date().toISOString();
  const task: Task = {
    id: randomUUID(),
    project_id: args.project_id,
    wedge: gtmWedge(),
    task_type: PROPOSE_REPLY_TASK,
    case_id: args.kase.id,
    actor: { kind: "user", id: args.actor ?? "member" },
    input: { case_id: args.kase.id, preview: text.slice(0, 200) },
    constraints: { max_runtime_s: 60, max_cost_usd: 0, approval_required: true },
    tools: [],
    status: "awaiting_approval",
    cost_usd: 0,
    created_at: iso,
    updated_at: iso,
  };
  await store.createTask(task);

  const approval = await store.createApproval({
    task_id: task.id,
    action: "linkedin:send_message",
    risk: "high",
    preview: {
      // The one flag Cloud's approval card routes on. An ordinary approval wakes an in-process
      // waiter; this one has none, and settling it down the ordinary route would answer 409 and
      // change nothing while telling the founder it worked.
      gtm_reply: true,
      case_id: args.kase.id,
      connection_id: args.connection.id,
      thread: thread || undefined,
      profile_id: profileId || undefined,
      body: text,
      to: (args.kase.title || profileId || "prospect") as string,
      preview: `Reply to ${args.kase.title || profileId}: ${text.slice(0, 140)}${text.length > 140 ? "…" : ""}`,
    },
    ttlMs: 7 * 24 * 60 * 60 * 1000,
  });

  return { approval_id: approval.approval_id, task_id: task.id };
}

/**
 * Approve (or reject) a queued reply. On approve, execute the send — outside the campaign envelope —
 * and record it on the case history.
 */
export async function decideReply(
  store: Store,
  domain: DomainStore,
  args: {
    project_id: string;
    approval_id: string;
    decision: "approved" | "rejected";
    /** Human rewrite of the body before send. Whatever is here is what ships. */
    edited_body?: string;
    getConnection: (id: string) => Promise<Connection | undefined>;
  },
): Promise<{ ok: true; sent?: boolean; detail?: string }> {
  const approval = await store.getApproval(args.approval_id);
  if (!approval) throw new ReplyError("unknown approval");
  if (approval.status !== "pending") throw new ReplyError(`already ${approval.status}`);

  const task = await store.getTask(approval.task_id);
  // Project first: an approval id is a guessable-shaped handle, and settling somebody else's
  // approval must be indistinguishable from settling one that does not exist.
  if (!task || task.project_id !== args.project_id || task.wedge !== gtmWedge()) {
    throw new ReplyError("unknown approval");
  }
  if (task.task_type !== PROPOSE_REPLY_TASK) throw new ReplyError("not a reply approval");

  const preview = (approval.preview ?? {}) as Record<string, unknown>;
  if (preview.gtm_reply !== true) throw new ReplyError("not a reply approval");

  if (args.decision === "rejected") {
    await store.setApproval(args.approval_id, "rejected");
    await store.setStatus(task.id, "rejected");
    return { ok: true, sent: false };
  }

  const body =
    (typeof args.edited_body === "string" && args.edited_body.trim()) ||
    (typeof preview.body === "string" ? preview.body.trim() : "");
  if (!body) throw new ReplyError("nothing to send");

  const connectionId = typeof preview.connection_id === "string" ? preview.connection_id : "";
  const conn = connectionId ? await args.getConnection(connectionId) : undefined;
  if (!conn || conn.project_id !== args.project_id) throw new ReplyError("unknown connection");

  const payload: Record<string, unknown> = {
    body,
    case_id: preview.case_id,
    ...(typeof preview.thread === "string" && preview.thread ? { thread: preview.thread } : {}),
    ...(typeof preview.profile_id === "string" && preview.profile_id ? { profile_id: preview.profile_id } : {}),
  };

  // A human read these words and clicked approve — say so, so the platform guard inside
  // `executeAction` can tell this apart from an unattended cold open.
  const result = await executeAction(conn, "send_message", payload, {
    approved: `approval ${args.approval_id} was approved by the founder`,
  });
  if (!result.ok) {
    // The founder DID approve. Record that, and record separately that the send failed — see
    // `ReplySendError`. The approval is settled `approved` so it leaves the queue and cannot be
    // double-sent by a second click; the task carries the transport detail so the failure is
    // visible rather than silent, and the caller answers 502 rather than 400.
    await store.setApproval(args.approval_id, "approved");
    await store.setStatus(task.id, "failed", result.detail ?? "linkedin send failed");
    throw new ReplySendError(result.detail ?? "linkedin send failed", args.approval_id, task.id);
  }

  await store.setApproval(args.approval_id, "approved");
  await store.setStatus(task.id, "succeeded");

  const caseId = typeof preview.case_id === "string" ? preview.case_id : task.case_id;
  if (caseId) {
    const kase = await domain.getCase(caseId);
    // Re-check the tenant on the case as well: `preview.case_id` came off a stored row, and a row is
    // not an authorisation.
    if (kase && kase.project_id === args.project_id) {
      const prev = (kase.data ?? {}) as Record<string, unknown>;
      const data = (result.data ?? {}) as Record<string, unknown>;
      await domain.updateCase(
        kase.id,
        {
          data: {
            ...prev,
            // The first post-reply DM can be the one that mints the conversation urn. Persist it or
            // the next reply opens a SECOND thread with the same person.
            ...(typeof data.thread === "string" && data.thread ? { thread: data.thread } : {}),
            ...(typeof data.message_id === "string" ? { last_message_id: data.message_id } : {}),
            last_touch_at: new Date().toISOString(),
            touch_count: Number(prev.touch_count ?? 0) + 1,
          },
        },
        {
          at: new Date().toISOString(),
          kind: "note",
          note: "human-approved reply sent",
          actor: "member",
          task_id: task.id,
        },
      );
    }

    // Learning: if they rewrote the draft, keep both versions as grounding for the next one. The
    // correction is the most valuable thing in this whole flow — it is the founder's own voice,
    // captured during a review they were doing anyway.
    if (args.edited_body?.trim() && args.edited_body.trim() !== String(preview.body ?? "").trim()) {
      await domain
        .createKnowledge({
          project_id: args.project_id,
          wedge: gtmWedge(),
          name: `reply-correction-${new Date().toISOString().slice(0, 19)}.md`,
          content: [
            "# A reply the founder rewrote before it went out",
            "",
            "## Draft",
            String(preview.body ?? ""),
            "",
            "## Sent",
            args.edited_body.trim(),
            "",
            "Match the second, not the first.",
          ].join("\n"),
          kind: "correction",
          source: "feedback",
          metadata: { case_id: caseId, approval_id: args.approval_id, action: "linkedin:send_message" },
        })
        // Best-effort: the message is already out. Losing the grounding example makes the next draft
        // worse, it does not make this send wrong — so it is logged and swallowed rather than
        // turned into an error for something that already succeeded.
        .catch((e) => console.error(`[mycel] could not store the reply correction for case ${caseId}:`, e));
    }
  }

  return { ok: true, sent: true, detail: result.detail };
}
