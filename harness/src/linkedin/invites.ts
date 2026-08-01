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

/** Set to use the newer dash invitation endpoint. Unset uses the confident legacy one. */
const DASH_INVITE = process.env.MYCEL_LINKEDIN_DASH_INVITE === "1";

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
}

/**
 * Thrown when LinkedIn refuses because the account is out of invitations.
 *
 * Same reasoning as the Commercial Search Limit: "invitation failed" is a shrug, "you are out of
 * invitations until the weekly window rolls" is a decision. Pacing should normally stop us long
 * before LinkedIn does — if this ever fires, the local budget is set too high for this account and
 * that is worth knowing loudly.
 */
export class InviteQuotaError extends Error {
  readonly code = "linkedin_invite_quota";
  constructor(detail?: string) {
    super(
      "LinkedIn refused this connection request: the account has no invitations left in its current " +
        "weekly window. Pacing should have stopped this first, so the configured budget is too high " +
        "for this account. Withdrawing invitations that have been pending for three weeks recovers " +
        "allowance immediately." + (detail ? ` (${detail})` : ""),
    );
    this.name = "InviteQuotaError";
  }
}

/** LinkedIn's copy for a spent invitation quota, in the several forms it has been seen in. */
const QUOTA_SIGNAL = /CANT_RESEND_YET|quota|weekly invitation limit|reached the (weekly )?limit|INVITATION_LIMIT|exceeded/i;

export function isQuotaRefusal(status: number, payload: unknown): boolean {
  // 429 is unambiguous. A 403 with quota copy is the shape LinkedIn actually returns most often.
  if (status === 429) return true;
  if (status !== 403 && status !== 400 && status !== 409) return false;
  try {
    return QUOTA_SIGNAL.test(JSON.stringify(payload ?? "").slice(0, 20_000));
  } catch {
    return false;
  }
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
export function inviteBody(profileUrn: string, note?: string): Record<string, unknown> {
  if (DASH_INVITE) {
    // INFERRED shape.
    return { inviteeProfileUrn: profileUrn, ...(note ? { customMessage: note } : {}) };
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
  const body = JSON.stringify(inviteBody(profileUrn, checked.note));
  const r = await voyagerCall(url, session, ctx, "invite", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  if (isQuotaRefusal(r.status, r.json)) throw new InviteQuotaError(`HTTP ${r.status}`);
  if (!r.ok) {
    // The note is NOT echoed into the failure detail. Same rule as the send path: a failure is a
    // status code, and the words are the founder's, not a log line's.
    return { ok: false, detail: `voyager invite ${r.status}` };
  }
  const { id, secret } = invitationIdFrom(r.json);
  return { ok: true, invitation_id: id, shared_secret: secret };
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
