// An invitation was accepted: move the case, and tell pacing.
//
// This is `replies.ts` for the other inbound event, and it is deliberately the same shape — a leaf
// module over the domain store and the stage vocabulary, nothing else, so that the LinkedIn poller
// can call it without closing an import ring with the send path.
//
// ── THE BUG THIS FILE EXISTS TO CLOSE ────────────────────────────────────────────────────────────
// `factsFor` in sequence.ts reads `data.connected`, `DEFAULT_SEQUENCE` gates its first DM on
// `only_if: "connected AND !replied"`, and the `connected` stage sat between `invited` and `dm1`.
// Nothing in the entire repository ever wrote that field or that stage. So in production every
// prospect walked view_profile → send_invite → `invited`, waited, and was closed `lost` at
// twenty-one days. The pipeline had no state after "we asked" — a prospect could never become a
// conversation, let alone a client, and nothing anywhere failed or logged. The loop was open and it
// looked exactly like a quiet week.
//
// ── TWO THINGS HAPPEN ON AN ACCEPTANCE, AND THEY ARE EASY TO CONFUSE ─────────────────────────────
//   1. THE SEQUENCE MOVES. `invited` → `connected`, and `due_at` is set to NOW rather than to the
//      usual jittered gap. That is not impatience: capabilities.ts is right that a first message
//      within a day of acceptance dramatically outperforms one sent a week later, and pacing still
//      has the final say on the send itself — the tick will refuse it if the account has no room.
//   2. PACING LEARNS. Acceptance rate is the dominant term in `engagementMultiplier`, and the
//      denominator (`engagement.sent`) has been incrementing on every invitation since the send
//      path was closed. With nothing ever writing the numerator, an account that had sent twenty
//      invitations read as 0% acceptance and was throttled toward the 0.2 pause — the safety system
//      slowly strangling a healthy account on evidence it had refused to collect.
//
// ── COUNTED ONCE, BY CONSTRUCTION ────────────────────────────────────────────────────────────────
// The count is the number of cases that MOVED from `invited` to `connected` in this call, not the
// number of connections observed. A founder's connections list is full of people this system never
// touched; a poll that ran twice would see the same list twice. Both would inflate the numerator,
// and since acceptance only ever RAISES the multiplier, an inflated numerator is an account earning
// budget it did not earn — the one direction this file must not be wrong in.
import type { DomainStore } from "../domain";
import { gtmWedge } from "./stages";

/**
 * The trigger id this fires, as declared in linkedin/capabilities.ts.
 *
 * `invite_accepted` was in the trigger table with nothing behind it. It is named here rather than
 * spelled as a literal at each site so the declaration and the implementation cannot drift.
 */
export const INVITE_ACCEPTED = "invite_accepted";

/** What one poll saw. Public identifiers, because that is the key a case carries as `profile_id`. */
export interface NetworkObservation {
  /** Members who are first-degree connections right now, newest first. */
  connected: readonly string[];
}

export interface AcceptanceResult {
  /** Cases that moved `invited` → `connected` in THIS call. The engagement delta, deduped. */
  accepted: number;
  /** Case ids that moved, so the caller can name them in an event without a second read. */
  case_ids: string[];
  /** How many cases were sitting at `invited` — context for "nothing happened" being unmysterious. */
  pending: number;
}

/**
 * Flip every case this observation answers, and return how many were NEWLY flipped.
 *
 * `project_id` is a REQUIRED string and this throws without one. That is not defensiveness: pass
 * `undefined` to `listCases` and it applies NO tenant filter, so every case in the deployment comes
 * back. A previous incident in this codebase was exactly that shape — a scoping argument that was
 * optional-with-a-default, and one caller that did not pass it. `replies.ts` reads the same table
 * through the same door and its comment claims it "fails closed on tenancy"; it does not, it is
 * saved only by a post-filter on the connection id. This one refuses instead.
 */
export async function noteAcceptedInvitations(
  domain: DomainStore,
  conn: { id: string; project_id: string },
  observed: NetworkObservation,
  now: Date = new Date(),
): Promise<AcceptanceResult> {
  if (!conn.project_id) {
    throw new Error("noteAcceptedInvitations needs the connection's project — an unscoped case read sees every tenant");
  }
  const empty: AcceptanceResult = { accepted: 0, case_ids: [], pending: 0 };
  if (!observed.connected?.length) return empty;

  const cases = await domain.listCases({ project_id: conn.project_id, wedge: gtmWedge(), status: "open" });
  // Only `invited` — the one stage where "they are now a first-degree connection" can only be
  // explained by our own invitation having been accepted. A case at `queued` whose prospect the
  // founder happens to already know is not an acceptance, and counting it would be free budget.
  const invited = cases.filter(
    (k) => k.stage === "invited" && (k.data as Record<string, unknown> | undefined)?.connection_id === conn.id,
  );
  if (!invited.length) return empty;

  const now1st = new Set(observed.connected);
  const iso = now.toISOString();
  const result: AcceptanceResult = { accepted: 0, case_ids: [], pending: invited.length };

  for (const kase of invited) {
    const d = (kase.data ?? {}) as Record<string, unknown>;
    const profileId = typeof d.profile_id === "string" ? d.profile_id : "";
    if (!profileId || !now1st.has(profileId)) continue;

    await domain.updateCase(
      kase.id,
      {
        stage: "connected",
        // Due immediately. The jittered spacing that normally goes here is the WITHIN-DAY spacing
        // for a send, and the send has not happened yet — pacing is consulted on the next tick and
        // will impose it then. Putting a gap here as well would delay the one message in the whole
        // sequence whose timing measurably matters.
        due_at: iso,
        data: {
          ...d,
          // THE FIELD NOTHING WROTE. `factsFor` has read `d.connected` since the sequencer shipped.
          connected: true,
          // The trigger's own timestamp, which is what makes `invite_accepted` a fact a step can be
          // gated on rather than a synonym for the stage.
          invite_accepted_at: iso,
          paused_reason: undefined,
        },
      },
      {
        at: iso,
        kind: "stage_changed",
        from: kase.stage,
        to: "connected",
        // Written for a founder scanning a pipeline, not for a log grep.
        note: `${kase.title} accepted the invitation — ${INVITE_ACCEPTED}`,
        actor: "system",
      },
    );
    result.accepted++;
    result.case_ids.push(kase.id);
  }
  return result;
}
