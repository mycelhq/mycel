/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * THE MESSAGE A RUN WROTE, ACTUALLY SENT
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * MEASURED IN PRODUCTION, and this is the most expensive fact in the product:
 *
 *     51 client requests raised. ZERO ever answered. 41 still open.
 *
 * The obvious reading is that clients ignore us. The truth is worse: the ask never leaves the
 * building. `nudge_client_request` runs, and of the four that have ever SUCCEEDED, all four:
 *
 *   · booted a Daytona sandbox,
 *   · called `todowrite`, `glob` and `read`,
 *   · produced a validated reminder in `message`,
 *   · called `send_email` ZERO times,
 *   · and reported success.
 *
 * Every one of those runs has no approval row against it, which is the proof — nothing outbound can
 * happen in this kernel without one. The job is a message generator with no outbox.
 *
 * And it is not the model's fault. The task type's description says "Remind this client about ONE
 * thing…" and its schema asks for `{ step, channel, message }`. A model reading that produces the
 * message and stops, correctly: the schema IS the deliverable. Nothing ever said "send it", and
 * `ship_requires: ["message"]` plus a `channel` enum reads exactly like a design where the KERNEL
 * does the sending. It just never did.
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS CALLS THE ACTION PROXY OVER HTTP INSTEAD OF SENDING DIRECTLY
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Because server.ts says, at the one place a capability verb is resolved:
 *
 *     "Everything below this block is the human approval gate, the risk assessment, the platform
 *      guard, the audit row and the outbound message record. A capability verb that resolved
 *      anywhere else would need all of that again, and the second copy is the one that eventually
 *      drifts."
 *
 * That is right, and it applies to us. So this takes the same route the sandbox takes — a real
 * action grant, a POST to `/v1/internal/actions/send_email` — and inherits the gate rather than
 * reimplementing it. A founder still approves the send. Nothing here can put words in front of a
 * client that the existing path would have stopped.
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * IT NEVER FAILS THE RUN
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A reminder that could not be sent is a reminder that has to be sent again tomorrow, and the nudge
 * ladder is already built to do that. A run marked failed because the mailbox was unreachable would
 * lose the drafted message as well, and burn one of the client's `MAX_NUDGES` on nothing.
 */

import { loadConfig } from "./config";
import type { Client, Task } from "./contract";
import { getDomainStore } from "./domain";
import { registerActionGrant, revokeActionGrant } from "./actiongrants";
import { clientEmailHandle } from "./dunning";
import { selectGrantableConnections } from "./runtime";

export interface DeliveryOutcome {
  sent: boolean;
  /** Always populated when `sent` is false. Written to the run's timeline, so it is a sentence. */
  reason?: string;
}

/** The fields a sending task type is expected to have produced. Absent ones are refusals, not throws. */
interface Composed {
  step?: string;
  channel?: string;
  subject?: string;
  message?: string;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/**
 * Send what the run composed, through the same gate the sandbox would have used.
 *
 * Returns rather than throws on every refusal — see the header. The caller writes the reason to the
 * timeline so a founder can see WHY a reminder did not go, which is the thing that was invisible
 * for the whole time this was broken.
 */
export async function deliverRunMessage(args: {
  task: Task;
  parsed: Record<string, unknown> | null;
  /** Injected so tests can drive this without a live server. Defaults to `fetch`. */
  post?: (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number; body: string }>;
}): Promise<DeliveryOutcome> {
  const { task, parsed } = args;
  if (!parsed) return { sent: false, reason: "the run produced no structured output to send" };

  const out = parsed as Composed;
  const message = str(out.message);
  const channel = (str(out.channel) ?? "").toLowerCase();

  /**
   * `hold` is a DECISION, not a failure. The ladder gives the agent an explicit way to say "this one
   * should not be chased again yet", and overriding it here would make that enum decorative.
   */
  if (str(out.step) === "hold") return { sent: false, reason: "the run decided to hold this one rather than chase it again" };
  if (channel === "none") return { sent: false, reason: "the run chose not to send on any channel" };
  if (channel && channel !== "email") return { sent: false, reason: `this kernel cannot send on "${channel}" yet` };
  if (!message) return { sent: false, reason: "the run produced no message to send" };

  if (!task.project_id) return { sent: false, reason: "this run has no business to send from" };
  const clientId = recipientClientId(task);
  if (!clientId) return { sent: false, reason: "this run names no client to send to" };

  const domain = getDomainStore();
  const client = (await domain.getClient(clientId)) as Client | undefined;
  if (!client) return { sent: false, reason: "the client on this run no longer exists" };
  const to = clientEmailHandle(client);
  // The commonest real refusal, and it must name the fix. A client added by hand with only a company
  // name has no address, and "could not send" tells the founder nothing they can act on.
  if (!to) return { sent: false, reason: `${client.display_name} has no email address on file — add one and this will send` };

  const all = await domain.listConnections();
  const grantable = selectGrantableConnections(all, new Set(all.map((c) => c.id)), task.project_id, clientId);
  if (!grantable.length) return { sent: false, reason: "no mailbox is connected to send this from" };

  const subject = str(out.subject) ?? defaultSubject(task, client);
  const cfg = loadConfig();
  const nonce = await registerActionGrant({
    task_id: task.id,
    connectionIds: grantable.map((c) => c.id),
    caseId: task.case_id,
  });
  try {
    const post =
      args.post ??
      (async (url, init) => {
        const res = await fetch(url, init);
        return { ok: res.ok, status: res.status, body: await res.text().catch(() => "") };
      });
    const res = await post(`${cfg.publicUrl}/v1/internal/actions/send_email`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${nonce}` },
      body: JSON.stringify({ task_id: task.id, to: [to], subject, text: message, body: message }),
    });
    if (!res.ok) return { sent: false, reason: `the mailbox refused this send (${res.status})` };
    // The proxy answers 200 with `ok:false` for a refusal it wants stated in words — a missing
    // provider, a guard, a rejected approval. Those are answers, not errors, and the founder should
    // read them rather than see a generic failure.
    let parsedRes: { ok?: boolean; error?: string; decision?: string } = {};
    try {
      parsedRes = JSON.parse(res.body) as typeof parsedRes;
    } catch {
      /* a non-JSON 200 is a success we cannot read further */
    }
    if (parsedRes.ok === false) {
      return { sent: false, reason: parsedRes.error ?? `the send was ${parsedRes.decision ?? "refused"}` };
    }
    return { sent: true };
  } catch (e) {
    return { sent: false, reason: `the send could not be attempted: ${(e as Error).message}` };
  } finally {
    // The grant is single-purpose and short-lived. Leaving it alive would be a credential for a
    // mailbox sitting around for the lifetime of the process.
    await revokeActionGrant(nonce).catch(() => undefined);
  }
}

/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * WHO THIS EMAIL GOES TO — DELIBERATELY NOT `taskClientId`
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `taskClientId` exists and is used across the kernel, and it is the wrong function HERE for two
 * reasons.
 *
 * It never reads `task.client_id`. It looks at `input.client_id`, then `input.client.id`, then the
 * actor — while `Task.client_id` is the field the contract calls the customer this work is for,
 * "duplicated top-level so list/filter and the client-context façade don't need a join". A nudge
 * spawned by the sweep carries the client there and nowhere else, so `taskClientId` misses it.
 *
 * And its last resort is `task.actor.id` when the actor is a user. For retrieval scoping that is a
 * reasonable guess. For ADDRESSING AN EMAIL it is not a guess we may make: the actor is whoever or
 * whatever started the run, and the failure mode is a chase sent to the wrong person's inbox.
 *
 * So this reads the three places a CLIENT is actually named and stops. No actor fallback: a run
 * that cannot say who it is writing to does not get to send.
 */
function recipientClientId(task: Task): string | undefined {
  const inputClient = task.input?.client as { id?: string } | undefined;
  return (
    (typeof task.client_id === "string" && task.client_id ? task.client_id : undefined) ??
    (typeof task.input?.client_id === "string" ? task.input.client_id : undefined) ??
    inputClient?.id
  );
}

/**
 * A subject when the run did not write one.
 *
 * Deliberately dull and deliberately not a guess at content. "Following up" over the business's own
 * name is a subject a client recognises; inventing something specific from a task type slug is how
 * you get "Nudge client request" in somebody's inbox.
 */
function defaultSubject(task: Task, client: Pick<Client, "display_name">): string {
  return task.case_id ? `Following up on your ${client.display_name} work` : "Following up";
}
