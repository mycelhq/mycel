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
//      follow-up. `replied` (and `booked`) is a terminal stage, so the tick never selects the case
//      again.
//   2. PACING LEARNS. Reply rate is the strongest positive signal LinkedIn scores, and the account
//      earns budget for it. Counted once per case, at the moment the stage flips, which is what
//      makes it a real dedupe: a prospect who sends four messages is one reply.
import type { DomainStore } from "../domain";
import { noteReplyToTouch, systemMoveAuthority } from "../moves";
import { gtmWedge, isActive } from "./stages";

/**
 * The trigger id this fires, as declared in linkedin/capabilities.ts.
 *
 * Inbox sync has always stopped the sequence; until the sequencer tick started emitting this, the
 * trigger table was a caption with nothing behind it — the same shape `invite_accepted` had.
 */
export const MESSAGE_RECEIVED = "message_received";

/** The shape the LinkedIn inbox sync hands us. Structural, so this does not import voyager. */
export interface InboundLike {
  thread_id: string;
  from: { id: string; name?: string };
  sent_at?: string;
  /** Message body when the sync captured it — used only to detect an obvious booking signal. */
  text?: string;
}

/** A booking link, or an unambiguous statement that time is on the calendar. */
const BOOKING_LINK = /(calendly\.com|cal\.com\/|savvycal\.com\/|calendar\.app\.google|outlook\.office|meet\.google\.com\/[a-z])/;

const BOOKING_PHRASE =
  /\b(booked|booking confirmed|scheduled (a |our )?(call|meeting|chat)|see you (on|next) (mon|tue|wed|thu|fri|sat|sun)[a-z]*)\b/;

/**
 * Words that turn any of the above into its opposite, when they sit just in front of the match.
 *
 * THE BUG this guards: the phrase list contains a bare `booked`, which "not booked yet", "I haven\'t
 * booked anything" and "can we get booked in sometime?" all satisfy. Getting this wrong is not
 * symmetric — a false `booked` marks a live prospect as having a meeting that does not exist, and
 * the founder never prepares for it because they were never told to. So the check fails CLOSED,
 * toward `replied`, which loses nothing: a human still reads the message either way.
 */
const NEGATION = /\b(not|no|never|cannot|can'?t|won'?t|don'?t|doesn'?t|didn'?t|haven'?t|hasn'?t|isn'?t|aren'?t|unable|rather|before|once|when|if|unless|until|hoping|hope|want|wants|wanted|need|needs|like|love|happy|try|trying|can|could|shall|should|would)\s+((we|i|you|they|he|she|us|me|them|to|get|be|got|have|had|has)\s+){0,3}$/i;

/**
 * Does this inbound look like they booked time, rather than merely answering?
 *
 * Fail closed toward `replied`: only clear calendar language flips to `booked`, and a negation in
 * front of that language cancels it. A founder can still mark booked by hand when the signal is
 * ambiguous, which is the whole reason this is allowed to be conservative.
 */
export function looksLikeBooking(text: string | undefined): boolean {
  if (!text?.trim()) return false;
  const t = text.toLowerCase();

  // A link to a booking product is not something anyone types by accident, and no negation makes
  // sense in front of one — "I did not calendly you" is not a sentence.
  if (BOOKING_LINK.test(t)) return true;

  const m = BOOKING_PHRASE.exec(t);
  if (!m) return false;
  const before = t.slice(0, m.index);
  if (NEGATION.test(before)) return false;
  // "booked yet" is only ever said in the negative, whatever precedes it.
  if (/^\s*yet\b/.test(t.slice(m.index + m[0].length))) return false;
  return true;
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
  conn: { id: string; project_id: string },
  inbound: InboundLike[],
): Promise<number> {
  // THE TENANT SCOPE IS A PRECONDITION, and what stood here was a comment asserting something that
  // is not true: this read "fails closed on tenancy" only in the sense that `listCases` with an
  // UNDEFINED project applies no filter at all and hands back every tenant's cases. The
  // `connection_id` post-filter below happened to save it — which is precisely the shape of the leak
  // this codebase has already had once, a scoping argument that was optional and a caller that did
  // not pass it. Required now, and refused rather than defaulted.
  if (!conn.project_id) {
    throw new Error("noteInboundReplies needs the connection's project — an unscoped case read sees every tenant");
  }
  if (!inbound?.length) return 0;
  const cases = await domain.listCases({ project_id: conn.project_id, wedge: gtmWedge(), status: "open" });
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

    /**
     * A reply IS the outcome of the touch that earned it — record it before the row changes shape.
     *
     * THE BUG: the next-move engine learned only from a founder clicking "Worked" on `/next`, so
     * `gtm_next_touch` never crossed `MIN_EVIDENCE` and its learned term was permanently 0. The
     * engine could not tell outreach that works from outreach that does not, while sitting on the
     * exact event that answers the question.
     *
     * ORDER IS LOAD-BEARING, AND THE CALL BELOW MUST STAY ABOVE THE `updateCase`.
     * `noteReplyToTouch` attributes against `data.last_touch_at` and must see the case as it was
     * BEFORE the flip: once the stage is `replied` or `booked` the touch that earned it is no
     * longer identifiable from the row. Moving it down breaks nothing loudly — no throw, no log,
     * no failing type — it simply stops the learning loop and `gtm_next_touch` never again crosses
     * `MIN_EVIDENCE`. `replies.test.ts` pins the order for that reason.
     *
     * It refuses on its own when the gap is outside
     * `REPLY_ATTRIBUTION_DAYS`, or when this campaign never sent anything.
     *
     * Best effort, and that is not laziness. This function's contract is that a reply STOPS the
     * sequence; a bookkeeping write that threw would leave a prospect being sequenced at after they
     * answered, which is the single worst thing this module can do.
     */
    await noteReplyToTouch(
      domain,
      systemMoveAuthority(conn.project_id),
      kase,
      msg.sent_at ?? new Date().toISOString(),
    ).catch((e) => console.error(`[mycel] could not attribute the reply on case ${kase.id}:`, e));

    const at = msg.sent_at ?? new Date().toISOString();
    const booked = looksLikeBooking(msg.text);
    const to = booked ? "booked" : "replied";
    await domain.updateCase(
      kase.id,
      {
        stage: to,
        data: {
          ...(kase.data ?? {}),
          // Attach the conversation urn we just saw. A first DM opened by profile id can land
          // without one (see `createConversation`), and this inbound is the first time we are
          // certain of it — every later step addresses the thread by this value.
          thread: msg.thread_id,
          has_reply: true,
          replied_at: at,
          ...(booked ? { booked_at: at } : {}),
          paused_reason: undefined,
        },
      },
      {
        at: new Date().toISOString(),
        kind: "stage_changed",
        from: kase.stage,
        to,
        // Written for the founder scanning a list, not for a log grep.
        note: booked
          ? `${msg.from?.name ?? "they"} booked — sequence stopped, get ready for the call`
          : `${msg.from?.name ?? "they"} replied — sequence stopped, this one is yours`,
        actor: "system",
      },
    );
  }
  return flipped.size;
}
