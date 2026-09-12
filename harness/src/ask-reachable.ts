/**
 * CAN THIS CLIENT ACTUALLY BE ASKED ANYTHING?
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * FIFTY-ONE ASKS, ZERO DELIVERED
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Every client request in production has `thread_id` NULL. Not most — all fifty-one. Forty-one are
 * still open, the median has been open eleven and a half days, and across twenty-one projects there
 * is ONE channel, ONE thread and ONE message ever sent.
 *
 * So the chain that makes this product autonomous has never once completed: a run discovers it needs
 * a document, raises a question, the question is filed against a client who is never told, the
 * client never answers, the work starves, and the engine — correctly — produces a beautifully
 * typeset report saying the inputs were not supplied.
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * THE ASYMMETRY THAT ALLOWED IT
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `portal-threads.ts` already refuses to open a conversation when there is no channel, with a 409
 * that says so. That is exactly right. Meanwhile a run raising a question in the same situation gets
 * a 201 and a request id. One path refuses loudly and the other files silently, for the identical
 * missing thing — and the silent one is the path the product's whole value runs through.
 *
 * `lib/home-alerts.ts` diagnosed this and built an alert for it. The alert measured thirty-seven at
 * the time. It is fifty-one now. An alert nobody acts on is not a fix.
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * REFUSE, BUT DO NOT DISCARD
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The tempting fix is a hard refusal. It is wrong: the run genuinely does not know something, and
 * throwing that away leaves it to guess — the exact failure `/v1/internal/knowledge/gap` exists to
 * remove, and its own comment says an agent that must ask permission to admit ignorance will guess
 * instead.
 *
 * So an unreachable client ask becomes a FOUNDER ask. The information survives, it lands in front of
 * the one person who can act on it, and the founder can answer on the client's behalf — which the
 * portal route already supports. Nothing is lost except the pretence that a customer was contacted.
 */

import { resolveCapability } from "./capabilities";
import type { Connection } from "./contract";

export interface Reachability {
  ok: boolean;
  /** Why not, in words a run can put in its own progress note. Absent when reachable. */
  because?: string;
}

interface ClientLike {
  handles?: unknown;
}

/**
 * Reachable means BOTH halves: somewhere to send FROM, and an address to send TO.
 *
 * ── THE SEND CHECK IS THE SENDER'S OWN, NOT A SECOND OPINION ──
 *
 * The first version of this counted `channels`, because that is what `portal-threads.ts` refuses on
 * and what `cannotReachClients` measures. It was wrong, and four existing wait tests caught it
 * within a minute: deliverability is decided by `resolveCapability("send_email", connections, …)`,
 * which is what `startNudge` actually calls before it will send. A project can hold an email
 * CONNECTION and no channel and send perfectly well.
 *
 * Two functions answering "can this go out" is two answers, and the one that is wrong is the one
 * that never runs at send time. So this calls the sender's.
 *
 * (Corrected production figure: 2 of 21 projects hold an email connection. Of the six holding an
 * open ask, one can send. The shape of the finding survived the correction; the number changed.)
 */
export function clientReachable(
  connections: readonly Connection[],
  projectId: string,
  client: ClientLike | undefined,
): Reachability {
  const canSend = projectId ? resolveCapability("send_email", connections, projectId) : { ok: false, detail: "" };
  const handles = Array.isArray(client?.handles) ? client!.handles.filter((h) => String(h ?? "").trim()) : [];

  if (!canSend.ok && !handles.length) {
    return {
      ok: false,
      because:
        "this business has nothing connected that can send email and this client has no address on " +
        "file, so a question sent to them would go nowhere",
    };
  }
  if (!canSend.ok) {
    return {
      ok: false,
      because:
        "this business has no mailbox connected, so there is nothing to send a client question FROM " +
        "(Settings → Addresses connects one)",
    };
  }
  if (!handles.length) {
    return {
      ok: false,
      because: "this client has no email address on file, so there is nowhere to send a question TO",
    };
  }
  return { ok: true };
}

export function redirectedNote(question: string, because: string): string {
  return (
    `Not sent to the client — ${because}. The question is now in front of the founder instead: ` +
    `"${question}". Do not wait on a client reply for it.`
  );
}
