// Warm-up engagement: react to a post, follow a person — the human-like touches BEFORE a DM.
//
// ── WHY THIS FILE IS SCAFFOLDING, AND OFF BY DEFAULT ─────────────────────────────────────────────
// The natural shape of good outreach is connect → accepted → view → react/follow → wait → DM. A
// reaction and a follow are the cheap, human warm-ups in the middle of that, and they are also the
// single most ban-adjacent thing an automated LinkedIn account can do: they appear in a stranger's
// notifications under the founder's real name, and reacting to a year-old post (or following forty
// people in a minute) is the textbook bot tell. So this file is deliberately WIRED BUT DISARMED.
// It mirrors invites.ts — pure body-builders, a single Voyager door, quota detection — but every
// executor refuses with `warmup_disabled` and makes NO network call until a human sets the flag AND
// has verified the endpoints below against a live browser capture. Nothing here has been run against
// a real account; treat it as a draft of the request, not a proven one.
//
// ── ENDPOINT CONFIDENCE ──────────────────────────────────────────────────────────────────────────
//   · `POST /voyager/api/voyagerSocialDashReactions?action=...` — INFERRED. Path, the `?action`
//     verb, and the `{ reactionType, threadUrn }` body are reconstructed from the shape of the
//     sibling social endpoints and the known reaction enum, NOT observed on the wire. Must be
//     confirmed from a devtools network log of a real reaction before the flag is turned on.
//   · `POST /voyager/api/feed/dash/followingStates` — INFERRED. The dash following-state resource;
//     the `{ followeeUrn, following: true }` body is reconstructed, not observed. Same rule.
//
// Both address the target by URN — a post urn / a member urn — exactly like an invitation addresses
// a member urn. A slug cannot be turned into either, so when the urn is missing this refuses cleanly
// rather than guessing.
import { VOYAGER, voyagerCall, type LinkedInSession, type VoyagerCtx } from "./voyager";
import { isQuotaRefusal } from "./invites";

/**
 * THE KILL-SWITCH. Default FALSE.
 *
 * Warm-up engagement is off unless `MYCEL_LINKEDIN_WARMUP=1` is set in the environment. When it is
 * unset — which is every environment until a human deliberately changes it — the executors below
 * return `warmup_disabled` and never reach `voyagerCall`. This is the one line that stands between
 * an unverified request body and a real founder's account, so it is read once, here, and checked at
 * the very top of each executor before anything else happens.
 */
export const WARMUP_ENABLED = process.env.MYCEL_LINKEDIN_WARMUP === "1";

/** The refusal returned while the flag is off. A named code so callers can tell it from a failure. */
export const WARMUP_DISABLED: EngageResult = {
  ok: false,
  code: "warmup_disabled",
  detail:
    "LinkedIn warm-up engagement (react/follow) is disabled. It is scaffolding whose Voyager " +
    "endpoints are INFERRED and unverified, and it stays off until a human confirms them against a " +
    "live capture and sets MYCEL_LINKEDIN_WARMUP=1.",
};

export interface EngageResult {
  ok: boolean;
  /** A named, actionable outcome — `warmup_disabled`, `linkedin_engage_quota`, … */
  code?: string;
  detail?: string;
}

/**
 * The reactions LinkedIn offers, mapped from the agent-facing word to LinkedIn's own enum.
 *
 * The enum values are LinkedIn's, not ours (PRAISE is "celebrate", EMPATHY is "support"). Kept as a
 * closed map so an unknown reaction is refused rather than sent as a string LinkedIn will reject.
 */
export const REACTION_TYPES = {
  like: "LIKE",
  celebrate: "PRAISE",
  support: "EMPATHY",
  insightful: "INTEREST",
  funny: "ENTERTAINMENT",
  love: "APPRECIATION",
} as const;

export type Reaction = keyof typeof REACTION_TYPES;

export const isReaction = (v: unknown): v is Reaction =>
  typeof v === "string" && Object.prototype.hasOwnProperty.call(REACTION_TYPES, v);

/** A post/activity urn, normalised. Reactions address the post by urn; a bare id is not enough. */
export function asPostUrn(raw: unknown): string | undefined {
  const s = String(raw ?? "").trim();
  return /^urn:li:(activity|ugcPost|share|fsd_update|fs_updateV2):[A-Za-z0-9_:()-]+$/.test(s) ? s : undefined;
}

/** A member urn, normalised to the fsd_profile form the following-state resource expects. */
export function asMemberUrn(raw: unknown): string | undefined {
  const s = String(raw ?? "").trim();
  if (/^urn:li:(fsd_profile|fs_miniProfile|member):[A-Za-z0-9_-]+$/.test(s)) {
    return `urn:li:fsd_profile:${s.split(":").pop()}`;
  }
  return undefined;
}

/**
 * The reaction request body, as a pure function of (postUrn, reaction). Exported so it is unit
 * testable: like an invitation, this reaches a stranger's notifications, and "did we put the post in
 * the right field, with the right enum" should not be a question answered only in production.
 *
 * INFERRED shape — see the header. Verify against a live capture before enabling.
 */
export function reactionBody(postUrn: string, reaction: Reaction): Record<string, unknown> {
  return {
    reactionType: REACTION_TYPES[reaction],
    threadUrn: postUrn,
  };
}

/**
 * The follow request body, as a pure function of (memberUrn). Exported for the same reason.
 *
 * INFERRED shape — see the header. Verify against a live capture before enabling.
 */
export function followBody(memberUrn: string): Record<string, unknown> {
  return {
    followeeUrn: memberUrn,
    following: true,
  };
}

/**
 * React to a post.
 *
 * `call` is injected (defaulting to the one Voyager door) purely so a test can prove the disabled
 * path makes NO network call — it is not a second outbound path.
 */
export async function reactToPost(
  session: LinkedInSession,
  ctx: VoyagerCtx,
  post: unknown,
  reaction: unknown,
  call: typeof voyagerCall = voyagerCall,
): Promise<EngageResult> {
  if (!WARMUP_ENABLED) return WARMUP_DISABLED;
  const postUrn = asPostUrn(post);
  if (!postUrn) return { ok: false, detail: `"${String(post)}" is not a post urn — nothing reacted to` };
  if (!isReaction(reaction)) {
    return { ok: false, detail: `"${String(reaction)}" is not one of ${Object.keys(REACTION_TYPES).join(", ")}` };
  }
  const r = await call(
    `${VOYAGER}/voyagerSocialDashReactions?action=react`,
    session,
    ctx,
    "react",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(reactionBody(postUrn, reaction)),
    },
  );
  if (isQuotaRefusal(r.status, r.json)) return { ok: false, code: "linkedin_engage_quota", detail: `HTTP ${r.status}` };
  return r.ok ? { ok: true, detail: "reacted" } : { ok: false, detail: `voyager react ${r.status}` };
}

/**
 * Follow a person without connecting.
 */
export async function followPerson(
  session: LinkedInSession,
  ctx: VoyagerCtx,
  member: unknown,
  call: typeof voyagerCall = voyagerCall,
): Promise<EngageResult> {
  if (!WARMUP_ENABLED) return WARMUP_DISABLED;
  const memberUrn = asMemberUrn(member);
  if (!memberUrn) return { ok: false, detail: `"${String(member)}" is not a member urn — nobody followed` };
  const r = await call(
    `${VOYAGER}/feed/dash/followingStates`,
    session,
    ctx,
    "follow",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(followBody(memberUrn)),
    },
  );
  if (isQuotaRefusal(r.status, r.json)) return { ok: false, code: "linkedin_engage_quota", detail: `HTTP ${r.status}` };
  return r.ok ? { ok: true, detail: "followed" } : { ok: false, detail: `voyager follow ${r.status}` };
}
