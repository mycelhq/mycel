// The stage vocabulary for an outreach sequence, and which wedge owns it.
//
// It lives in its own file and imports only roles.ts because three modules need it and two of them
// must not depend on each other: `replies.ts` is reached from the LinkedIn inbox sync, and
// `sequence.ts` reaches back into the LinkedIn send path. A near-leaf keeps that from becoming an
// import cycle (roles.ts imports only wedge.ts and node:fs, so it cannot close one).
//
// The stages ARE the sequence. A Case per prospect per campaign, moving along this list, is the
// whole state machine — there is no separate queue, no per-prospect timer, and no row that means
// "a send is pending". `Case.due_at` is indexed and already means "look at me at this time", which
// is exactly what a sequencer needs and the reason this is built on Cases at all.

import { requireWedgeForRole, wedgeForRole } from "../roles";

/** A prospect's position in one campaign. Ordered — position in this array is progress. */
export const STAGES = [
  "queued", // enrolled, nothing done yet
  "warmed", // a free warm-up touch has landed (a profile view)
  "invited", // a connection request is out and unanswered
  "connected", // they accepted — the moment the sequence is actually worth something
  "dm1", // first message sent
  "dm2", // LinkedIn follow-up sent
  "em1", // email nudge after LinkedIn silence (AgentMail / Gmail)
  "replied", // they answered: STOP. A human takes it from here.
  "booked", // a meeting is on the calendar — still terminal for the sequencer
  "won",
  "lost",
] as const;

export type Stage = (typeof STAGES)[number];

/**
 * Stages the sequencer will act on.
 *
 * `replied`, `booked`, `won` and `lost` are terminal on purpose and that is how stopping works: a
 * case that reaches one is never selected again, so a reply ends the sequence by construction
 * rather than by a check somebody has to remember to write. (`next_touch.mjs` reaches the same
 * verdict from the facts — this is the structural version of it.)
 *
 * `booked` is terminal for the SEQUENCER and not for the founder: a meeting on the calendar is the
 * outcome the whole machine exists to produce, and it is emphatically not `won`. Held apart from
 * `replied` because the two want different things from a human — a reply wants an answer, a booking
 * wants preparation — and because a funnel that cannot count meetings cannot be tuned.
 */
export const ACTIVE_STAGES: readonly string[] = ["queued", "warmed", "invited", "connected", "dm1", "dm2", "em1"];

export const isActive = (stage: string): boolean => ACTIVE_STAGES.includes(stage);

/**
 * The wedge these cases belong to — the one that DECLARES `provides: ["outreach"]`.
 *
 * ═══ WHY THIS IS NO LONGER `const GTM_WEDGE = "gtm-operator"` ═══
 *
 * That constant's own comment said "one constant so a typo cannot silently select nothing", which was
 * true and not enough: it protected against a typo in this repo and not against the directory being
 * named anything else. Forty call sites across `gtm/` and `linkedin/` filter Cases and Records by that
 * exact string, so an install whose outbound wedge is called `sales-machine` had a sequencer that
 * queried a wedge with no rows and reported zero due touches — a silent, permanent no-op.
 *
 * ═══ WHY IT THROWS INSTEAD OF RETURNING undefined ═══
 *
 * Every caller of this is already INSIDE outbound machinery: a campaign was proposed, a Case exists,
 * an inbox sync matched a prospect. Reaching them on an install with no outreach wedge means something
 * upstream is broken, and forty sites each inventing a graceful degradation would be forty chances to
 * degrade into "found nothing". The BOUNDARIES degrade instead and each says why — `mountGtmRoutes`
 * refuses with a 501, `advanceSequences` returns a named reason — which is the entry-point/interior
 * split described in roles.ts.
 */
export const gtmWedge = (): string => requireWedgeForRole("outreach");

/** Is there outbound machinery on this install at all? What the boundaries ask before entering. */
export const hasGtmWedge = (): boolean => wedgeForRole("outreach") !== undefined;

/** Records collection holding campaign definitions (see campaign.ts). */
export const CAMPAIGN_COLLECTION = "campaign";
