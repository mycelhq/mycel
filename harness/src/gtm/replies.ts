// A reply arrived: stop the sequence, and tell pacing.
//
// This is deliberately a leaf module (domain store + stage vocabulary, nothing else). It is called
// from the LinkedIn inbox sync, and the sequencer calls into the LinkedIn send path — putting this
// logic in sequence.ts would close that ring into an import cycle.
//
// Two things happen when someone answers, and they are easy to confuse:
//
//   1. THE SEQUENCE STOPS. Not "pauses", not "skips one step" — a human being replied to a message
//      with the founder's name on it, and the next thing they hear must not be an automated
//      follow-up. `replied` is a terminal stage, so the tick never selects the case again.
//   2. PACING LEARNS. Reply rate is the strongest positive signal LinkedIn scores, and the account
//      earns budget for it. Counted once per case, at the moment the stage flips, which is what
//      makes it a real dedupe: a prospect who sends four messages is one reply.
import type { Connection } from "../contract";
import type { DomainStore } from "../domain";
import { GTM_WEDGE, isActive } from "./stages";

/** The shape the LinkedIn inbox sync hands us. Structural, so this does not import voyager. */
export interface InboundLike {
  thread_id: string;
  from: { id: string; name?: string };
  sent_at?: string;
}

/**
 * Flip every case these inbound messages answer, and return how many were NEWLY flipped.
 *
 * The return value is the engagement delta, and "newly" is doing the work: it is the number of
 * PEOPLE WE CONTACTED who have now answered for the first time. Counting raw inbound instead would
 * both double-count a chatty prospect and count strangers, and since replies only ever raise the
 * multiplier, an inflated numerator is the account EARNING budget it did not earn — the one
 * direction this file must not be wrong in.
 */
export async function noteInboundReplies(
  domain: DomainStore,
  conn: Pick<Connection, "id" | "project_id">,
  inbound: InboundLike[],
): Promise<number> {
  if (!inbound?.length) return 0;
  // Fails closed on tenancy exactly like every other Case read: a connection with no project can
  // only see cases with no project, never everyone's.
  const cases = await domain.listCases({ project_id: conn.project_id, wedge: GTM_WEDGE, status: "open" });
  const mine = cases.filter((k) => isActive(k.stage) && (k.data as Record<string, unknown>)?.connection_id === conn.id);
  if (!mine.length) return 0;

  const byThread = new Map<string, (typeof mine)[number]>();
  const byPerson = new Map<string, (typeof mine)[number]>();
  for (const k of mine) {
    const d = (k.data ?? {}) as Record<string, unknown>;
    if (typeof d.thread === "string") byThread.set(d.thread, k);
    if (typeof d.profile_id === "string") byPerson.set(d.profile_id, k);
  }

  const flipped = new Set<string>();
  for (const msg of inbound) {
    // Thread first: it is the identifier we ourselves sent to. The profile id is the fallback for a
    // prospect who opened a NEW conversation rather than answering in ours.
    const kase = byThread.get(msg.thread_id) ?? byPerson.get(msg.from?.id ?? "");
    if (!kase || flipped.has(kase.id)) continue;
    flipped.add(kase.id);
    await domain.updateCase(
      kase.id,
      {
        stage: "replied",
        data: { ...(kase.data ?? {}), has_reply: true, replied_at: msg.sent_at ?? new Date().toISOString(), paused_reason: undefined },
      },
      {
        at: new Date().toISOString(),
        kind: "stage_changed",
        from: kase.stage,
        to: "replied",
        // Written for the founder scanning a list, not for a log grep.
        note: `${msg.from?.name ?? "they"} replied — sequence stopped, this one is yours`,
        actor: "system",
      },
    );
  }
  return flipped.size;
}
