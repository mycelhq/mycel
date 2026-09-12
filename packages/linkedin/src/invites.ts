// Connection requests: the scarcest thing LinkedIn gives an account, and the easiest way to lose it.
//
// ── WHY THIS FILE IS THE CAREFUL ONE ─────────────────────────────────────────────────────────────
// An invitation is rate-limited (~100/week), irreversible in the sense that the recipient sees it
// immediately under the founder's real name, SCORED (a low acceptance rate throttles the account
// automatically and silently), and it keeps costing budget while it sits unanswered. Every other
// action here can be undone or ignored; this one compounds. So it goes through the identical path
// `send_message` does — the human approval gate upstream, store-backed pacing at the door, the proxy
// underneath — and there is deliberately no shortcut past any of the three.
//
// ── ENDPOINT CONFIDENCE ──────────────────────────────────────────────────────────────────────────
//   · `POST /voyager/api/growth/normInvitations` — CONFIDENT on the path and on the `invitee` union
//     wrapper. It is the long-lived invitation endpoint and it is what most observed clients use.
//   · `POST /voyager/api/voyagerRelationshipsDashMemberRelationships?action=verifyQuotaAndCreateV2` —
//     INFERRED. The newer dash equivalent; the action name and the `inviteeProfileUrn` body are
//     reconstructed from observation. Opt-in behind an env var for that reason.
//   · `POST /voyager/api/relationships/invitations/{id}?action=withdraw` — CONFIDENT on the path,
//     INFERRED on whether `invitationSharedSecret` is required. LinkedIn returns that secret with the
//     invitation it minted, so it is passed through when we have it and omitted when we do not.
//
// ── WHAT AN INVITATION NEEDS THAT A SEARCH RESULT MAY NOT CARRY ──────────────────────────────────
// The endpoints address a member by PROFILE URN, not by public identifier. Search usually returns
// the urn; sometimes it does not. Rather than guess a urn from a slug — which cannot be done, they
// are unrelated identifiers — this resolves it with a profile read first, and that read is a real
// extra round-trip the caller should know about. It is also not wasted: looking at someone before
// inviting them is what capabilities.ts tells the agent to do anyway.
import { safeProfileId } from "./profile";
import { VOYAGER, voyagerCall, type LinkedInSession, type VoyagerCtx } from "./voyager";

/**
 * Which invitation endpoint to post to. DASH BY DEFAULT; set `MYCEL_LINKEDIN_DASH_INVITE=0` for the
 * legacy one.
 *
 * The comment here used to read "unset uses the confident legacy one", and the confidence was
 * misplaced. `/voyager/api/growth/normInvitations` is the pre-Dash invitation API. Production has
 * never had this variable set, so every invitation this system has ever attempted went there, and
 * the all-time record for the `connect` step is 0 sent against 39 failed — the last three as a flat
 * `voyager invite 422`, which is what a retired Rest.li endpoint returns when it still routes but
 * will not accept the body.
 *
 * The URN types corroborate it. `asProfileUrn` normalises everything to `urn:li:fsd_profile:<id>`,
 * which is exactly what the dash endpoint's `inviteeProfileUrn` field takes. The legacy branch then
 * does `.split(":").pop()` and hands that opaque `ACoAA…` identifier to `InviteeProfile.profileId`,
 * a field from the miniProfile era that predates those ids. So the legacy path was posting an
 * identifier of the wrong vintage to an endpoint of the wrong vintage.
 *
 * The dash body remains INFERRED and is still labelled as such below — this flips the default to the
 * endpoint LinkedIn's own web client uses, which is a better hypothesis than the one with a 0%
 * success rate, not a certainty. It is cheap to be wrong: a refused invitation costs no quota, and
 * `codeSuffix` now preserves LinkedIn's reason code, so the next failure will say what it is instead
 * of "422".
 */
const DASH_INVITE = process.env.MYCEL_LINKEDIN_DASH_INVITE !== "0";

/**
 * LinkedIn's own cap on an invitation note.
 *
 * 300 characters, and over-length is REJECTED here rather than truncated. Truncation would silently
 * send something other than the text a human approved — a note ending mid-sentence is worse than no
 * note, and the founder would never learn why their acceptance rate fell.
 */
export const MAX_NOTE = 300;

export interface InviteResult {
  ok: boolean;
  /** The invitation LinkedIn minted, when it told us. Needed to withdraw it later. */
  invitation_id?: string;
  /** Its shared secret, if returned — the withdraw endpoint wants it. */
  shared_secret?: string;
  detail?: string;
  /** A named, per-prospect outcome — currently only `linkedin_invite_duplicate`. */
  code?: string;
  /**
   * Which entry of DASH_INVITE_BODIES was accepted. Recorded so the first success answers a
   * question three deploys have failed to, rather than being lost in a 200.
   */
  bodyShape?: string;
}

/**
 * WHY THIS IS FOUR CAUSES AND NOT ONE.
 *
 * "LinkedIn refused the invitation" collapses four completely different situations that share a
 * status code and share nothing else:
 *
 *   · WEEKLY   — the ~100-per-rolling-week invitation allowance is spent. Only time fixes it.
 *   · PENDING  — the pile of unanswered sent invitations is at LinkedIn's ~1,500 cap. Time does
 *                NOT fix this one: it gets worse while you wait. Withdrawing old invitations does.
 *   · RESTRICTED — LinkedIn has taken invitations away from this account. Neither waiting nor
 *                withdrawing helps; a human has to open the account and clear whatever it is asking.
 *   · DUPLICATE — this ONE PERSON already has (or recently had) an invitation from this account, and
 *                LinkedIn blocks a re-invite for about three weeks. It says nothing at all about the
 *                account, and it is the only one of the four that is per-prospect.
 *
 * The version that collapsed them told a founder "you are at your weekly limit" when the truth was
 * "you have three thousand unanswered invitations" — so they waited a week, for nothing. Worse, it
 * treated the per-prospect DUPLICATE case as an account-level quota event, which is how a loop
 * re-walking the same prospect list could book hundreds of "the platform is refusing us" flags
 * against an account that was never refused anything.
 */
export type InviteRefusal = "weekly" | "pending" | "restricted" | "duplicate";

/**
 * Per-prospect: LinkedIn will not let this account re-invite this person yet. NOT an account signal.
 * `CANT_RESEND_YET` is LinkedIn's own name for it and it lived in the quota regex for a long time.
 */
const DUPLICATE_SIGNAL =
  /CANT_RESEND_YET|ALREADY_INVITED|ALREADY_CONNECTED|DUPLICATE_INVIT|INVITATION_ALREADY|CANT_INVITE_AGAIN/i;

/** The account has been told it may not invite, full stop. Not a counter — a decision about it. */
// Deliberately WITHOUT "challenge"/"checkpoint": those words mean a real checkpoint, and this
// predicate is allowed to demote a 403 out of the challenge path (see `INVITE_NOT_CHALLENGE`).
const RESTRICTED_SIGNAL =
  /RESTRICT|BLOCKED|SUSPEND|NOT_ELIGIBLE|UNAUTHORIZED|CANNOT_INVITE|ACCOUNT_LIMIT/i;

/** The outstanding pile, not the weekly window. Distinguished by the word "pending"/"outstanding". */
const PENDING_SIGNAL =
  /PENDING_INVIT|OUTSTANDING_INVIT|too many (pending|outstanding)|MAX_(SENT_)?INVIT|withdraw/i;

/** LinkedIn's copy for a spent weekly invitation allowance, in the forms it has been seen in. */
const WEEKLY_SIGNAL =
  /weekly|quota|reached the (weekly )?limit|INVITATION_LIMIT|LIMIT_REACHED|exceeded|RATE_LIMIT/i;

/** Statuses LinkedIn refuses an invitation with. Anything else is a plain transport failure. */
const REFUSAL_STATUS = new Set([400, 403, 409, 422, 429]);

/**
 * Which of the four this refusal is, or null if it is not one of them.
 *
 * Order is deliberate and is the whole point: DUPLICATE and RESTRICTED are checked before the
 * weekly copy, because LinkedIn's payloads routinely carry the generic word "limit" alongside the
 * specific reason, and the specific reason is the one with the remedy.
 *
 * A bare 429 with no readable copy is reported as WEEKLY — it is the likeliest cause and the message
 * for it says plainly that it is an inference, so nobody withdraws 1,500 invitations on a guess.
 */
export function classifyInviteRefusal(status: number, payload: unknown): InviteRefusal | null {
  if (!REFUSAL_STATUS.has(status)) return null;
  let text = "";
  try {
    text = JSON.stringify(payload ?? "").slice(0, 20_000);
  } catch {
    text = "";
  }
  if (DUPLICATE_SIGNAL.test(text)) return "duplicate";
  if (RESTRICTED_SIGNAL.test(text)) return "restricted";
  if (PENDING_SIGNAL.test(text)) return "pending";
  if (WEEKLY_SIGNAL.test(text)) return "weekly";
  // 429 is a refusal even when the body says nothing we can read. 400/403/409/422 without any of the
  // copy above is an ordinary failure and must NOT be booked as a quota event.
  return status === 429 ? "weekly" : null;
}

/** The code each account-level cause carries, so a caller can branch without parsing prose. */
export const INVITE_REFUSAL_CODE: Record<InviteRefusal, string> = {
  weekly: "linkedin_invite_quota",
  pending: "linkedin_invite_pending_cap",
  restricted: "linkedin_invite_restricted",
  duplicate: "linkedin_invite_duplicate",
};

/** One sentence per cause, and each one names the remedy that actually works for THAT cause. */
const REFUSAL_MESSAGE: Record<InviteRefusal, string> = {
  weekly:
    "LinkedIn refused this connection request: the account has no invitations left in its current " +
    "rolling weekly window (~100). NOTHING BUT TIME restores this — the window rolls forward as the " +
    "oldest invitations in it age out, so allowance returns a few at a time over the next seven days. " +
    "Withdrawing pending invitations does NOT give the weekly allowance back. If LinkedIn is refusing " +
    "before our own pacing does, the configured budget is too high for this account.",
  pending:
    "LinkedIn refused this connection request: this account's PENDING invitation pile is at LinkedIn's " +
    "cap (~1,500 unanswered sent invitations). This is not the weekly limit and waiting makes it worse, " +
    "not better — the remedy is to WITHDRAW invitations older than about three weeks, which frees room " +
    "immediately. (Withdrawing blocks re-inviting the same person for roughly three weeks.)",
  restricted:
    "LinkedIn has RESTRICTED this account from sending invitations. This is not a counter and it is not " +
    "a calendar: neither waiting for the week to roll nor withdrawing pending invitations will lift it. " +
    "A human has to open the account in a browser and clear whatever LinkedIn is asking for (usually " +
    "identity verification). Nothing automated should touch this account until that is done.",
  duplicate:
    "LinkedIn refused this connection request because this PERSON already has a recent invitation from " +
    "this account — it blocks re-inviting for about three weeks after one is sent or withdrawn. This " +
    "says nothing about the account's allowance; every other prospect is unaffected.",
};

/**
 * Thrown when LinkedIn refuses at the ACCOUNT level — weekly window, pending cap, or restriction.
 *
 * Same reasoning as the Commercial Search Limit: "invitation failed" is a shrug, and each of these
 * three is a decision. `duplicate` is deliberately NOT thrown: it is one prospect's problem, and
 * throwing it here is what made a stale prospect list look like a failing account.
 */
export class InviteQuotaError extends Error {
  readonly code: string;
  readonly reason: InviteRefusal;
  constructor(reason: InviteRefusal = "weekly", detail?: string) {
    super(REFUSAL_MESSAGE[reason] + (detail ? ` (${detail})` : ""));
    this.reason = reason;
    this.code = INVITE_REFUSAL_CODE[reason];
    this.name = "InviteQuotaError";
  }
}

/**
 * The narrow permission to read a 403 on an INVITE as an answer rather than as a checkpoint.
 *
 * voyager.ts turns 401/403/999 into `LinkedInChallengeError` and stops the account — right for
 * nearly every op, and wrong for this one: LinkedIn answers a full pending pile and an invitation
 * restriction with a 403 that carries its own reason, and "reconnect the session" is the one remedy
 * that cannot help with either. So this demotes ONLY a 403, ONLY when the body says one of the
 * causes, and NEVER when the body carries an actual checkpoint, captcha or challenge id — those are
 * a challenge whatever else they say.
 */
export function INVITE_NOT_CHALLENGE(status: number, json: unknown, text = ""): boolean {
  if (status !== 403) return false;
  const blob = `${text}\n${typeof json === "string" ? json : JSON.stringify(json ?? "")}`.toLowerCase();
  if (blob.includes("/checkpoint/") || /\bcaptcha\b/.test(blob) || blob.includes("challenge_id")) return false;
  return classifyInviteRefusal(status, json) !== null;
}

/**
 * The old boolean, kept for `engage.ts` — a follow/react refusal has no pending pile and no
 * per-prospect duplicate case, so one bit really is the whole answer there.
 */
export function isQuotaRefusal(status: number, payload: unknown): boolean {
  const r = classifyInviteRefusal(status, payload);
  return r !== null && r !== "duplicate";
}

/** Trim a note to something sendable, or explain why it is not. Pure — the whole rule in one place. */
export function checkNote(note?: string): { note?: string; error?: string } {
  const t = (note ?? "").trim();
  if (!t) return {};
  if (t.length > MAX_NOTE) {
    return {
      error:
        `this invitation note is ${t.length} characters and LinkedIn's limit is ${MAX_NOTE}. ` +
        "It is not being truncated — a note that stops mid-sentence performs worse than no note at all.",
    };
  }
  return { note: t };
}

/**
 * The request body, as a pure function of (urn, note). Exported so it is unit-testable: this is the
 * one payload in the system that reaches a stranger, and "did we put the note in the right field"
 * should not be a question answered only in production.
 */
/**
 * ═══ WE DO NOT KNOW THE BODY SHAPE, SO STOP PRETENDING AND FIND OUT ═══
 *
 * The record, all-time: 0 invitations sent, 46 failed. The legacy endpoint answered 422 for 39 of
 * them (a retired Rest.li route that still resolves but will not take the body). Flipping to the
 * dash endpoint — the one LinkedIn's own web client uses — was the right move and did not fix it:
 * it now answers a flat 400 with no reason code, which means the route is live and the BODY is
 * being rejected. That is a different, better failure, and it is as far as guessing gets us.
 *
 * A third guess would be the third one-shape-per-deploy cycle, each costing a day and a batch of
 * prospects to learn one bit. So the shape becomes a list, tried in order of confidence, and the
 * one that works is recorded on the result. A refused invitation costs no quota — that is what
 * makes this affordable — and the first real attempt after this ships answers the question
 * permanently instead of producing another 400 nobody can act on.
 *
 * Ordered most-likely first. `inviteeUnion.memberProfile` is the union wrapper the dash
 * MemberRelationships model uses for its invitee field; the flat `inviteeProfileUrn` is the shape
 * that has been failing. If a later one wins, move it up and delete the losers — this list is a
 * question being asked, not a permanent fallback chain.
 */
export const DASH_INVITE_BODIES: readonly {
  name: string;
  build: (urn: string, note?: string) => Record<string, unknown>;
}[] = [
  {
    name: "dash-union",
    build: (urn, note) => ({
      invitee: { inviteeUnion: { memberProfile: urn } },
      ...(note ? { customMessage: note } : {}),
    }),
  },
  {
    name: "dash-flat",
    build: (urn, note) => ({ inviteeProfileUrn: urn, ...(note ? { customMessage: note } : {}) }),
  },
];

/**
 * A body rejection is worth trying another shape for. An account-level refusal is not — the
 * quota, the restriction and the duplicate are all facts about us or about this person, and
 * re-posting a different JSON cannot change any of them.
 */
const BODY_REJECTED = new Set([400, 422]);

export function inviteBody(profileUrn: string, note?: string): Record<string, unknown> {
  if (DASH_INVITE) {
    return DASH_INVITE_BODIES[0]!.build(profileUrn, note);
  }
  const id = profileUrn.split(":").pop() ?? profileUrn;
  return {
    invitee: {
      "com.linkedin.voyager.growth.invitation.InviteeProfile": { profileId: id },
    },
    ...(note ? { message: note } : {}),
    // No trackingId. LinkedIn's own client sends a random one and we could too, but a fabricated
    // tracking id is a fingerprint that says "not the web app" more loudly than its absence does.
  };
}

/** Whatever LinkedIn called the invitation it just created, across the shapes it answers in. */
export function invitationIdFrom(payload: unknown): { id?: string; secret?: string } {
  const p = (payload ?? {}) as Record<string, any>;
  const v = (p.value ?? p.data ?? p) as Record<string, any>;
  const id = v?.entityUrn ?? v?.invitationUrn ?? v?.id ?? v?.invitation?.entityUrn;
  const secret = v?.sharedSecret ?? v?.invitationSharedSecret ?? v?.invitation?.sharedSecret;
  return {
    id: typeof id === "string" ? (id.includes(":") ? id.split(":").pop() : id) : undefined,
    secret: typeof secret === "string" ? secret : undefined,
  };
}

/**
 * LinkedIn's machine-readable reason for a refusal, as ` (CODE)`, or "" when there is not one.
 *
 * ONLY a code-shaped token: uppercase, underscores, digits. Never the human `message` field, which
 * is prose LinkedIn composes and can quote the invitee — a failure detail is stored on the event,
 * printed in logs and read by the founder, and none of those are places to put a third party's name
 * on our guess about what a payload contains. A code is a fact about the API; prose is not.
 */
export function codeSuffix(payload: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(payload ?? "");
  } catch {
    return "";
  }
  if (!text) return "";
  // Any string-valued field whose value looks like a constant. LinkedIn has moved this between
  // `code`, `errorCode` and `data.code` across API versions, so match the SHAPE, not the key.
  const m = text.match(/"([A-Z][A-Z0-9_]{2,60})"/);
  return m ? ` (${m[1]})` : "";
}

/**
 * Send a connection request.
 *
 * `profileUrn` must be a member urn. The caller resolves it (see `resolveProfileUrn`) rather than
 * this function doing a hidden extra round-trip inside what is supposed to be a thin fetch.
 */
export async function sendInvite(
  session: LinkedInSession,
  ctx: VoyagerCtx,
  profileUrn: string,
  note?: string,
): Promise<InviteResult> {
  const checked = checkNote(note);
  if (checked.error) return { ok: false, detail: checked.error };

  const url = DASH_INVITE
    ? `${VOYAGER}/voyagerRelationshipsDashMemberRelationships?action=verifyQuotaAndCreateV2`
    : `${VOYAGER}/growth/normInvitations`;

  // One shape on the legacy route; the candidate list on dash. See DASH_INVITE_BODIES.
  const candidates = DASH_INVITE
    ? DASH_INVITE_BODIES
    : [{ name: "legacy", build: inviteBody }];

  let r!: Awaited<ReturnType<typeof voyagerCall>>;
  let shape = candidates[0]!.name;
  for (const candidate of candidates) {
    shape = candidate.name;
    r = await voyagerCall(url, session, ctx, "invite", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(candidate.build(profileUrn, checked.note)),
      notChallenge: INVITE_NOT_CHALLENGE,
    });
    // Stop on anything that is an answer: success, or a refusal about us or about them. Only a
    // body rejection with no readable reason is worth asking again in different words.
    if (r.ok) break;
    if (classifyInviteRefusal(r.status, r.json)) break;
    if (!BODY_REJECTED.has(r.status)) break;
  }

  const refusal = classifyInviteRefusal(r.status, r.json);
  // A duplicate is about this person and is RETURNED, not thrown: it must not reach the account-level
  // handler that flags the connection and stops the tick, because the next prospect will work fine.
  if (refusal === "duplicate") {
    return { ok: false, code: INVITE_REFUSAL_CODE.duplicate, detail: REFUSAL_MESSAGE.duplicate };
  }
  if (refusal) throw new InviteQuotaError(refusal, `HTTP ${r.status}`);
  if (!r.ok) {
    // The note is NOT echoed into the failure detail. Same rule as the send path: a failure is a
    // status code, and the words are the founder's, not a log line's.
    //
    // LinkedIn's own reason IS echoed, because dropping it cost three prospects on 2 September and
    // left no way to learn why. `classifyInviteRefusal` above recognises the four account-level
    // causes; everything else arrived here as the bare string "voyager invite 422", which the
    // engine's failure classifier can only match against its catch-all `\b(400|404|409|422)\b`
    // rule — permanent, terminal, enrollment halted, no diagnosis possible from the event or the
    // logs. A status code alone cannot distinguish "this person does not accept invitations" from
    // something a retry would fix, so it halted people for reasons nobody could read.
    // Every candidate shape was rejected. Name the last one tried so the failure says which
    // question was asked, not only that the answer was no.
    return { ok: false, detail: `voyager invite ${r.status}${codeSuffix(r.json)} [${shape}]` };
  }
  const { id, secret } = invitationIdFrom(r.json);
  /**
   * SAY WHICH SHAPE WORKED, OUT LOUD.
   *
   * The port returns void for `connect`, so `bodyShape` on this result reaches nobody. One log line
   * is the whole difference between learning the answer on the first successful invitation and
   * losing it inside a 200 — after three deploys spent guessing, that is worth a console call.
   * Delete DASH_INVITE_BODIES down to the winner once this has printed.
   */
  console.log(`[linkedin] invite accepted with body shape "${shape}" — collapse DASH_INVITE_BODIES to it`);
  return { ok: true, invitation_id: id, shared_secret: secret, bodyShape: shape };
}

/**
 * Withdraw a pending invitation.
 *
 * Worth doing on a schedule rather than on a whim: a pending invitation counts against the weekly
 * limit until it is withdrawn, so withdrawing three-week-old ones is the cheapest way to get budget
 * back. The cost is that LinkedIn blocks re-inviting the same person for about three weeks after.
 */
export async function withdrawInvite(
  session: LinkedInSession,
  ctx: VoyagerCtx,
  invitationId: string,
  sharedSecret?: string,
): Promise<InviteResult> {
  const id = String(invitationId ?? "").trim();
  // Path segment: same reasoning as safeProfileId — this is concatenated into a URL.
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id.includes(":") ? (id.split(":").pop() ?? "") : id)) {
    return { ok: false, detail: `"${invitationId}" is not an invitation id` };
  }
  const shortId = id.includes(":") ? (id.split(":").pop() as string) : id;
  const r = await voyagerCall(
    `${VOYAGER}/relationships/invitations/${encodeURIComponent(shortId)}?action=withdraw`,
    session,
    ctx,
    "withdraw",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        invitationId: shortId,
        // INFERRED: LinkedIn returns this secret when it mints the invitation and the withdraw
        // endpoint has been observed to require it. Sent when we kept it; omitted otherwise, because
        // a fabricated secret would fail more confusingly than a missing one.
        ...(sharedSecret ? { invitationSharedSecret: sharedSecret } : {}),
        isGenericInvitation: false,
      }),
    },
  );
  return r.ok ? { ok: true, invitation_id: shortId } : { ok: false, detail: `voyager withdraw ${r.status}` };
}

/** Already a member urn? Then no lookup is needed and none is done. */
export function asProfileUrn(raw: unknown): string | undefined {
  const s = String(raw ?? "").trim();
  if (/^urn:li:(fsd_profile|fs_miniProfile|member):[A-Za-z0-9_-]+$/.test(s)) {
    return `urn:li:fsd_profile:${s.split(":").pop()}`;
  }
  return undefined;
}

/**
 * A public identifier → the member urn the invitation endpoints want.
 *
 * A slug and a member urn are unrelated identifiers — one cannot be computed from the other — so this
 * costs a profile read. That read is not overhead: it is the "look at them before you contact them"
 * step, and its result is handed back so the caller can write it to the graph instead of throwing it
 * away.
 */
export async function resolveProfileUrn(
  session: LinkedInSession,
  ctx: VoyagerCtx,
  profileId: string,
  fetchProfile: (id: string) => Promise<{ urn?: string } | null>,
): Promise<{ urn?: string; profile: { urn?: string } | null }> {
  const direct = asProfileUrn(profileId);
  if (direct) return { urn: direct, profile: null };
  if (!safeProfileId(profileId)) return { urn: undefined, profile: null };
  const profile = await fetchProfile(profileId);
  return { urn: profile?.urn, profile };
}
