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
import { codeSuffix, isQuotaRefusal } from "./invites";

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

/**
 * The executors check the environment AT CALL TIME (not the import-time snapshot above) so a host
 * that toggles the flag after module load — a test re-import, a long-lived process — gets the
 * current answer. The exported const stays for display and for hosts that re-read it themselves.
 */
export function warmupEnabled(): boolean {
  return process.env.MYCEL_LINKEDIN_WARMUP === "1";
}

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
/**
 * WHAT LINKEDIN SAID, not just the number it said it with.
 *
 * Every failure in this file reported `voyager <op> <status>` and dropped the response. On
 * 7 September `follow` had been answering 400 three times a tick for a week and the only thing
 * written anywhere was "voyager follow 400" — which cannot tell a malformed body from a retired
 * endpoint from an account restriction, and all three were live hypotheses.
 *
 * A 400 from Voyager carries a JSON body saying why. `codeSuffix` in invites.ts already pulls the
 * constant out of it, and the raw text is the fallback for the case it does not match: the whole
 * problem is that we do not know the shape, so refusing to print an unrecognised one repeats the
 * mistake. Bounded to 300 characters, and it is an error body — the request carried the secrets,
 * the response carries a complaint.
 */
function said(r: { json?: unknown; text?: string }): string {
  const code = codeSuffix(r.json);
  if (code) return code;
  const raw = (r.text ?? "").trim().replace(/\s+/g, " ");
  return raw ? ` — ${raw.slice(0, 300)}` : "";
}

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
  if (!warmupEnabled()) return WARMUP_DISABLED;
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
  return r.ok ? { ok: true, detail: "reacted" } : { ok: false, detail: `voyager react ${r.status}${said(r)}` };
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
  if (!warmupEnabled()) return WARMUP_DISABLED;
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
  return r.ok ? { ok: true, detail: "followed" } : { ok: false, detail: `voyager follow ${r.status}${said(r)}` };
}

// ── ENDORSING A SKILL ───────────────────────────────────────────────────────────────────────────
//
// WHY IT BELONGS IN THIS FILE AND NOT IN A SEQUENCE. An endorsement is the strongest cheap warm-up
// LinkedIn has: the recipient gets a notification and an email saying a named human vouched for
// something they are proud of, and the reciprocity it creates is real. It is also, for exactly the
// same reasons, the most conspicuous thing to automate — it lands under the founder's real name, on
// a stranger's profile, permanently, and an account that endorses forty strangers a week is doing
// something no human does.
//
// So it is scaffolding on the same terms as `reactToPost` and `followPerson`: behind the same
// kill-switch, refusing before any network call while the flag is off, and with its endpoint marked
// INFERRED until somebody confirms it from a live capture.
//
// ── ENDPOINT CONFIDENCE ─────────────────────────────────────────────────────────────────────────
//   · `POST /voyager/api/identity/dash/profileEndorsements` — INFERRED. The dash endorsements
//     resource is the sibling of the profile resources this package already reads, and the body
//     below is reconstructed from that family's shape, NOT observed on the wire. Confirm from a
//     devtools log of a real endorsement before MYCEL_LINKEDIN_WARMUP is set.
//
// ── THE RULE THAT IS NOT ABOUT ENDPOINTS ────────────────────────────────────────────────────────
//
// ENDORSE ONLY A SKILL THEY LIST. This function takes a skill urn read from their own profile; it
// cannot invent one. Endorsing somebody for a skill they never claimed is the tell that no human is
// involved, and it is worse than not endorsing at all — it converts a compliment into evidence.
// `skillsOf` is deliberately not implemented here: the caller reads the profile through the
// existing profile door and passes what it found, so this file gains no new read path.

/**
 * A skill urn as it appears on a profile. Endorsements address the skill, not its display name —
 * two people's "SEO" are different urns, and a name cannot be turned into one.
 */
export function asSkillUrn(raw: unknown): string | undefined {
  const s = String(raw ?? "").trim();
  return /^urn:li:(fsd_skill|fs_skill|skill):[A-Za-z0-9_:()-]+$/.test(s) ? s : undefined;
}

/**
 * The endorsement request body, as a pure function of (memberUrn, skillUrn). Exported so the shape
 * is unit testable for the same reason the others are: this reaches a stranger's notifications, and
 * "was the skill in the right field" should not be a question first answered in production.
 *
 * INFERRED shape — see above. Verify against a live capture before enabling.
 */
export function endorsementBody(memberUrn: string, skillUrn: string, endorsed = true): Record<string, unknown> {
  return {
    endorseeUrn: memberUrn,
    skillUrn,
    // LinkedIn models an endorsement as a STATE rather than an event, which is the whole reason
    // withdrawal is possible: the same endpoint with `false` takes it back.
    endorsed,
  };
}

/**
 * Endorse one skill on one profile.
 *
 * Takes a skill urn READ FROM THEIR PROFILE rather than a skill name, so it is structurally
 * incapable of endorsing somebody for something they do not claim.
 */
export async function endorseSkill(
  session: LinkedInSession,
  ctx: VoyagerCtx,
  member: unknown,
  skill: unknown,
  call: typeof voyagerCall = voyagerCall,
): Promise<EngageResult> {
  if (!warmupEnabled()) return WARMUP_DISABLED;
  const memberUrn = asMemberUrn(member);
  if (!memberUrn) return { ok: false, detail: `"${String(member)}" is not a member urn — nobody endorsed` };
  const skillUrn = asSkillUrn(skill);
  if (!skillUrn) {
    return {
      ok: false,
      detail:
        `"${String(skill)}" is not a skill urn. Endorsements address a skill the person LISTS; ` +
        "read it off their profile rather than passing a name.",
    };
  }
  const r = await call(
    `${VOYAGER}/identity/dash/profileEndorsements`,
    session,
    ctx,
    "endorse",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(endorsementBody(memberUrn, skillUrn)),
    },
  );
  if (isQuotaRefusal(r.status, r.json)) return { ok: false, code: "linkedin_engage_quota", detail: `HTTP ${r.status}` };
  return r.ok ? { ok: true, detail: "endorsed" } : { ok: false, detail: `voyager endorse ${r.status}${said(r)}` };
}


/**
 * TAKE IT BACK.
 *
 * ═══ WHY THIS EXISTS ═══
 *
 * The objection to endorsing a prospect is that it is permanent and public under a real name. That
 * objection is right, and it is only right because nothing ever removed it.
 *
 * LinkedIn stores an endorsement as a state, so the same endpoint with `endorsed: false` withdraws
 * it, silently — the platform notifies on the endorsement and says nothing on the withdrawal. So
 * the permanent artifact does not have to be permanent.
 *
 * ═══ WHEN TO CALL IT, WHICH IS THE PART THAT MATTERS ═══
 *
 * Not "when the sequence ends". The policy lives in the host (`lib/linkedin/endorsement-policy.ts`)
 * because it is a judgement, not a mechanism, and it comes down to one question: did anything real
 * happen?
 *
 *   they replied, or booked      LEAVE IT. There is a relationship now and the endorsement was the
 *                                start of it. Withdrawing would be the actually dishonest act.
 *   they asked to be left alone  WITHDRAW. They did not consent to carrying our name on their
 *                                profile, and honouring that costs us nothing.
 *   the sequence ran out         WITHDRAW. We endorsed a stranger to get noticed and it did not
 *                                work; leaving a permanent public claim about someone we never
 *                                spoke to is the part that was hard to defend.
 *
 * Withdrawal is a WRITE and it is metered like any other, but it deliberately does NOT check
 * `warmupEnabled()`: turning the warm-up kill switch off must never strand endorsements we can no
 * longer take back. A cleanup path gated behind the same flag as the thing it cleans up is not a
 * cleanup path.
 */
export async function withdrawEndorsement(
  session: LinkedInSession,
  ctx: VoyagerCtx,
  member: unknown,
  skill: unknown,
  call: typeof voyagerCall = voyagerCall,
): Promise<EngageResult> {
  const memberUrn = asMemberUrn(member);
  if (!memberUrn) return { ok: false, detail: `"${String(member)}" is not a member urn — nothing withdrawn` };
  const skillUrn = asSkillUrn(skill);
  if (!skillUrn) return { ok: false, detail: `"${String(skill)}" is not a skill urn — nothing withdrawn` };

  const r = await call(
    `${VOYAGER}/identity/dash/profileEndorsements`,
    session,
    ctx,
    "endorse",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(endorsementBody(memberUrn, skillUrn, false)),
    },
  );
  if (isQuotaRefusal(r.status, r.json)) return { ok: false, code: "linkedin_engage_quota", detail: `HTTP ${r.status}` };
  // A 404 means it is already gone, which is the state we wanted. Reporting that as a failure would
  // make the cleanup retry forever against an endorsement that no longer exists.
  if (r.status === 404) return { ok: true, detail: "already withdrawn" };
  return r.ok ? { ok: true, detail: "withdrawn" } : { ok: false, detail: `voyager withdraw ${r.status}${said(r)}` };
}
