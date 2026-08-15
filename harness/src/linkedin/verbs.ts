// What LinkedIn can actually do HERE, versus what the catalogue merely names.
//
// `capabilities.ts` is the surface an agent might wish existed. This file is the conscience the
// sequence builder is allowed to plan against: verbs with an executor, verbs a campaign may name,
// and verbs that stay out of the composer because they are unwired, public, or a credit spend.
// One table, so the skill, the prompt, and `validateSteps` cannot disagree.
//
// Do not invent notification polls. Voyager has no webhook; inbound is the two polls in
// `WIRED_LINKEDIN_TRIGGERS`. Everything else in the trigger catalogue is a named gap.

/** Sequence steps `propose_campaign` will accept. Must stay inside the campaign envelope. */
export const SEQUENCE_LIVE = ["view_profile", "send_invite", "send_message", "send_email"] as const;

/** Reads the finder uses. Not sequence steps — they change nothing on LinkedIn. */
export const READ_LIVE = ["search_people", "company_people", "get_profile", "get_company"] as const;

/**
 * Wired writes that recover budget or tidy state. Never a campaign step: withdrawing is not
 * outreach, and putting it on a sequencer would withdraw people the founder meant to wait on.
 */
export const RECOVERY_LIVE = ["withdraw_invite"] as const;

/**
 * Warm-up engagement: HAS an executor, but disarmed behind the `MYCEL_LINKEDIN_WARMUP` kill-switch
 * (see engage.ts) and NEVER in a sequence. These are the human-like touches before a DM and the
 * ban-risk zone, so they are reachable by an explicit action only, never composed into a cadence,
 * and inert until a human verifies the (INFERRED) Voyager endpoints and turns the flag on.
 */
export const WARMUP_GATED = ["follow_person", "react_to_post"] as const;

/**
 * Declared in the catalogue, no executor, no sequencer. Endorse / InMail / accept stay out of the
 * composer until they are wired with pacing caps. Do not plan around them.
 */
export const DECLARED_UNWIRED = ["endorse_skill", "accept_invite", "send_inmail"] as const;

/** Public and permanent under the founder's name. Banned from automation, not "coming soon". */
export const PUBLIC_BANNED = ["comment_on_post", "create_post", "reply_to_comment"] as const;

export type SequenceLive = (typeof SEQUENCE_LIVE)[number];

const asSet = (ids: readonly string[]) => new Set<string>(ids);

export const SEQUENCE_LIVE_SET = asSet(SEQUENCE_LIVE);
export const READ_LIVE_SET = asSet(READ_LIVE);
export const RECOVERY_LIVE_SET = asSet(RECOVERY_LIVE);
export const WARMUP_GATED_SET = asSet(WARMUP_GATED);
export const DECLARED_UNWIRED_SET = asSet(DECLARED_UNWIRED);
export const PUBLIC_BANNED_SET = asSet(PUBLIC_BANNED);
