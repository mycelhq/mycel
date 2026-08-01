// The stage vocabulary for an outreach sequence, and nothing else.
//
// It lives in its own file with no imports because three modules need it and two of them must not
// depend on each other: `replies.ts` is reached from the LinkedIn inbox sync, and `sequence.ts`
// reaches back into the LinkedIn send path. A shared leaf keeps that from becoming an import cycle.
//
// The stages ARE the sequence. A Case per prospect per campaign, moving along this list, is the
// whole state machine — there is no separate queue, no per-prospect timer, and no row that means
// "a send is pending". `Case.due_at` is indexed and already means "look at me at this time", which
// is exactly what a sequencer needs and the reason this is built on Cases at all.

/** A prospect's position in one campaign. Ordered — position in this array is progress. */
export const STAGES = [
  "queued", // enrolled, nothing done yet
  "warmed", // a free warm-up touch has landed (a profile view)
  "invited", // a connection request is out and unanswered
  "connected", // they accepted — the moment the sequence is actually worth something
  "dm1", // first message sent
  "dm2", // follow-up sent
  "replied", // they answered: STOP. A human takes it from here.
  "won",
  "lost",
] as const;

export type Stage = (typeof STAGES)[number];

/**
 * Stages the sequencer will act on.
 *
 * `replied`, `won` and `lost` are terminal on purpose and that is how stopping works: a case that
 * reaches one is never selected again, so a reply ends the sequence by construction rather than by
 * a check somebody has to remember to write. (`next_touch.mjs` reaches the same verdict from the
 * facts — this is the structural version of it.)
 */
export const ACTIVE_STAGES: readonly string[] = ["queued", "warmed", "invited", "connected", "dm1", "dm2"];

export const isActive = (stage: string): boolean => ACTIVE_STAGES.includes(stage);

/** The wedge these cases belong to. One constant so a typo cannot silently select nothing. */
export const GTM_WEDGE = "gtm-operator";

/** Records collection holding campaign definitions (see campaign.ts). */
export const CAMPAIGN_COLLECTION = "campaign";
