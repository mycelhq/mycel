// The outreach capability guard — what the PLATFORM forbids, decided before the network call.
//
// Three different questions get confused with each other, and each has its own module:
//
//   capabilities.ts  "what is this agent allowed to do at all?"      (our policy)
//   pacing.ts        "may THIS account send right now?"              (velocity, per account)
//   guard.ts         "is this message legal on this platform?"       (the platform's own rules)
//
// This file is only the third. Instagram cannot be cold-DMed by anyone at any speed; WhatsApp will
// not deliver a free-form message 25 hours after the last inbound; a 5,000-character Instagram DM
// is rejected on arrival. None of those are advisory and none of them are about how fast you send —
// breaking them costs a delivery failure at best and an account at worst.
//
// Velocity deliberately does NOT live here. pacing.ts already answers it properly: account-tier
// ceilings, a new-account age ramp, an engagement-derived multiplier, a working-hours window and
// jitter. A flat per-hour integer in this table would look like a second opinion and be a much
// worse one — 15/hour is 165 sends in a working day, which pacing.ts would never permit.
//
// It is transport-agnostic on purpose: `capabilitiesForConnection` maps a kernel `Connection`
// (kind + config) to its platform profile, and `guardSend` decides. Pure — no I/O, no clock except
// the one you pass in — so it is cheap to call on every send and trivial to test.
import type { Connection } from "../contract";

/** How a connection reaches the platform — decides whose terms are in play and who carries risk. */
export type Access = "official_api" | "session_automation" | "manual";

export interface ChannelCapabilities {
  platform: string;
  access: Access;
  /** May we open a conversation with someone who has not messaged this account first? */
  can_initiate: boolean;
  /** Hours after their last inbound during which free-form replies are allowed. null = no window. */
  reply_window_h: number | null;
  /** Initiating requires a pre-approved template (WhatsApp Cloud API). */
  requires_template_to_initiate: boolean;
  /** Platform message length cap, if any. */
  max_chars: number | null;
  /** Force a human approval on a cold initiate even when a wedge policy would auto-approve it. */
  cold_initiate_requires_approval: boolean;
  /** Surfaced at connect/approval time so the risk is seen before an account is burned. */
  risk_note?: string;
}

export interface OutboundLike {
  /** Reply into an existing conversation… */
  thread?: string;
  /** …or open a new one with this recipient. Requires can_initiate. */
  to?: string;
  text: string;
  /** WhatsApp Cloud API: the pre-approved template required to initiate. */
  template?: { name: string; language: string };
}

export interface SendContext {
  last_inbound_at?: string;
  /** Injectable clock so the reply-window arithmetic is testable without freezing time. */
  now?: number;
  /**
   * The thread this send belongs to when the payload does not name one — the action grant's thread,
   * say. Without it a guarded reply looks like a cold open and is refused with `no_target`.
   */
  thread?: string;
  /**
   * WHY A HUMAN HAS ALREADY SAID YES — the string is a reason, not a boolean, because it is what an
   * auditor reads. Set by callers that route through an approval: the action proxy after its gate,
   * the approved-reply path, and the sequencer (whose campaign envelope is the founder's own
   * standing consent and which writes an `auto_approved` row with this exact reason).
   *
   * Absent means nobody has. `cold_initiate_requires_approval` then REFUSES rather than sending —
   * which is the point: the requirement used to live only in the proxy, so the sequencer and the
   * approved-reply path skipped it entirely. A caller added tomorrow that forgets this field is
   * refused, not quietly exempted.
   */
  approved?: string;
}

export interface GuardVerdict {
  allow: boolean;
  code?:
    | "cannot_initiate"
    | "template_required"
    | "reply_window_closed"
    | "too_long"
    | "manual_only"
    | "no_target";
  reason?: string;
  /** Allowed, but a human MUST sign off — an auto-approve policy has to be ignored for this send. */
  force_approval?: boolean;
}

// ── Platform profiles. These rules move; verify against current platform docs when they bite. ──

const PROFILES: Record<string, ChannelCapabilities> = {
  linkedin: {
    platform: "linkedin",
    access: "session_automation",
    can_initiate: true,
    cold_initiate_requires_approval: true,
    reply_window_h: null,
    requires_template_to_initiate: false,
    max_chars: 8000,
    risk_note:
      "LinkedIn has no messaging API; sending drives the member's own session (ToS-grey, ban risk). " +
      "Cold outreach is force-approved here; how FAST this account may send is pacing.ts's answer.",
  },
  whatsapp: {
    platform: "whatsapp",
    access: "official_api",
    can_initiate: true,
    cold_initiate_requires_approval: false,
    reply_window_h: 24,
    requires_template_to_initiate: true, // Cloud API: cold/initiate needs a pre-approved template
    max_chars: 4096,
  },
  instagram: {
    platform: "instagram",
    access: "official_api",
    can_initiate: false, // structurally impossible to cold-DM — they must message first
    cold_initiate_requires_approval: false,
    reply_window_h: 24,
    requires_template_to_initiate: false,
    max_chars: 1000,
  },
  email: {
    platform: "email",
    access: "official_api",
    can_initiate: true,
    cold_initiate_requires_approval: false,
    reply_window_h: null,
    requires_template_to_initiate: false,
    max_chars: null,
  },
  // Email's rules, because it IS email. Listed explicitly rather than left to fall through to
  // PERMISSIVE: the fall-through is also correct today, and would silently stop being correct the
  // moment `email` grew a rule — a per-domain send cap, say — that `agentmail` did not inherit.
  agentmail: {
    platform: "email",
    access: "official_api",
    can_initiate: true,
    cold_initiate_requires_approval: false,
    reply_window_h: null,
    requires_template_to_initiate: false,
    max_chars: null,
  },
};

/** A permissive default for connection kinds with no special messaging rules (webhook/custom/etc.). */
const PERMISSIVE: ChannelCapabilities = {
  platform: "generic",
  access: "official_api",
  can_initiate: true,
  cold_initiate_requires_approval: false,
  reply_window_h: null,
  requires_template_to_initiate: false,
  max_chars: null,
};

export function capabilitiesForPlatform(platform: string): ChannelCapabilities {
  return PROFILES[platform] ?? PERMISSIVE;
}

/**
 * Map a kernel Connection to its messaging profile. A `linkedin` connection → LinkedIn rules; a
 * Composio connection → the profile named by its toolkit (whatsapp/instagram/…); email → email.
 * Uses string comparison for `kind` so it is forward-compatible with kinds not yet in the union.
 */
export function capabilitiesForConnection(conn: Pick<Connection, "kind" | "config">): ChannelCapabilities {
  const kind = String(conn.kind);
  if (kind === "composio") {
    const toolkit = String((conn.config as Record<string, unknown>)?.toolkit ?? "").toLowerCase();
    if (PROFILES[toolkit]) return PROFILES[toolkit];
    return PERMISSIVE; // a non-messaging composio toolkit (xero, hubspot…) — no messaging rules
  }
  return PROFILES[kind] ?? PERMISSIVE;
}

/**
 * Refuse what the platform forbids, before the network call. Returns allow=false for a hard refusal
 * (with a machine code the agent can branch on), or allow=true — possibly with force_approval when
 * the platform requires a human to sign off on this particular send.
 */
export function guardSend(
  cap: ChannelCapabilities,
  msg: OutboundLike,
  ctx: SendContext = {},
): GuardVerdict {
  if (cap.access === "manual") {
    return { allow: false, code: "manual_only", reason: `${cap.platform} has no programmatic send — a human sends the draft.` };
  }
  if (!msg.thread && !msg.to) {
    return { allow: false, code: "no_target", reason: "message has neither a thread nor a recipient" };
  }

  const initiating = !msg.thread;
  if (initiating) {
    if (!cap.can_initiate) {
      return { allow: false, code: "cannot_initiate", reason: `${cap.platform} does not permit opening a conversation with someone who has not messaged first.` };
    }
    if (cap.requires_template_to_initiate && !msg.template) {
      return { allow: false, code: "template_required", reason: `${cap.platform} requires a pre-approved template to initiate; none supplied.` };
    }
  } else if (cap.reply_window_h !== null) {
    if (!ctx.last_inbound_at) {
      return { allow: false, code: "reply_window_closed", reason: `${cap.platform} allows free-form replies only within ${cap.reply_window_h}h of an inbound, and none is recorded.` };
    }
    const elapsedH = ((ctx.now ?? Date.now()) - Date.parse(ctx.last_inbound_at)) / 3_600_000;
    // An unparseable timestamp yields NaN. Treat that as closed, not as open — a broken clock must
    // not be a way to send outside the window.
    if (!Number.isFinite(elapsedH) || elapsedH > cap.reply_window_h) {
      return { allow: false, code: "reply_window_closed", reason: `the ${cap.reply_window_h}h ${cap.platform} reply window has closed.` };
    }
  }

  if (cap.max_chars !== null && msg.text.length > cap.max_chars) {
    return { allow: false, code: "too_long", reason: `message is ${msg.text.length} chars; ${cap.platform} accepts at most ${cap.max_chars}.` };
  }

  if (initiating && cap.cold_initiate_requires_approval) {
    return { allow: true, force_approval: true };
  }
  return { allow: true };
}

/**
 * Reads on a session-automation connection: real actions, but nobody is contacted.
 *
 * Enumerated rather than pattern-matched, so this FAILS CLOSED. A capability nobody listed here is
 * treated as a send and must satisfy the platform rules — which is the safe direction to be wrong
 * in. The opposite spelling (a regex for "looks like a read") would silently exempt the next
 * executor somebody adds with an unexpected name, and that executor might contact a stranger.
 */
const SESSION_READS = new Set([
  "view_profile",
  "get_profile",
  "get_company",
  "search_people",
  "company_people",
  "withdraw_invite",
]);

/**
 * Is this action a message send that the platform rules apply to?
 *
 * The guard must not fire on `linkedin:get_profile` or a Composio `XERO_CREATE_INVOICE` — those have
 * no recipient, so every one of them would be refused with `no_target`. A connection whose profile is
 * the permissive default has no rules to enforce in the first place; otherwise go by the capability
 * name, which for Composio IS the tool slug (`WHATSAPP_SEND_MESSAGE`, `INSTAGRAM_SEND_DM`).
 *
 * SESSION AUTOMATION IS NOT ALL SENDS, though it used to be and this said so. When LinkedIn's only
 * executor was a DM, "a session-automation connection only ever sends" was true. It stopped being
 * true the day that one executor became seven — search, profile, company, invites, graph — and the
 * stale belief then refused `search_people` with `no_target`, because a search has no recipient and
 * the guard insisted it must. That is the PROSPECTING half of the go-to-market loop, blocked by our
 * own policy layer describing a version of LinkedIn we no longer have.
 *
 * `withdraw_invite` counts as a read here for the same reason: retracting an invitation contacts
 * nobody. It reduces contact.
 */
export function isMessagingSend(cap: ChannelCapabilities, capability: string): boolean {
  if (cap.platform === "generic") return false;
  if (cap.access === "session_automation") return !SESSION_READS.has(capability.toLowerCase());
  return /(^|[_:.-])(send|dm|reply|message|mail)/i.test(capability);
}

/** Convenience: guard a send for a specific connection in one call. */
export function guardOutreach(
  conn: Pick<Connection, "kind" | "config">,
  msg: OutboundLike,
  ctx?: SendContext,
): GuardVerdict {
  return guardSend(capabilitiesForConnection(conn), msg, ctx);
}

/**
 * An executor payload, read as a message the platform rules can be applied to.
 *
 * ONE mapper, because there used to be two readings of the same payload and only one of them ran on
 * the paths that produce the volume. The action proxy in server.ts spelled this inline; the
 * sequencer and the approved-reply path called `executeAction` directly and were never guarded at
 * all — so `cold_initiate_requires_approval` was skipped on exactly the automated paths it was
 * written for. The guard now lives inside `executeAction`, and this is what it reads with.
 *
 * The recipient aliases are not a guess: they are the same keys the LinkedIn executors themselves
 * accept (`profile_id ?? to ?? public_id`). Reading fewer of them would make a legitimate
 * `send_message` look like it had no target and refuse it with `no_target` — which is how a guard
 * that is technically correct becomes an outage.
 */
export function outboundFromPayload(
  payload: Record<string, unknown>,
  fallbackThread?: string,
): OutboundLike {
  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v.trim() ? v.trim() : undefined;
  return {
    thread: str(payload.thread) ?? str(payload.thread_id) ?? fallbackThread,
    to: str(payload.to) ?? str(payload.profile_id) ?? str(payload.public_id) ?? str(payload.recipient_email),
    text: String(payload.body ?? payload.text ?? payload.message ?? ""),
    template: payload.template as { name: string; language: string } | undefined,
  };
}
