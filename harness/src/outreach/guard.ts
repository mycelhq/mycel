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
 * Is this action a message send that the platform rules apply to?
 *
 * The guard must not fire on `linkedin:fetch_profile` or a Composio `XERO_CREATE_INVOICE` — those
 * have no recipient, so every one of them would be refused with `no_target`. A connection whose
 * profile is the permissive default has no rules to enforce in the first place; a session-automation
 * connection (LinkedIn) only ever sends; otherwise go by the capability name, which for Composio IS
 * the tool slug (`WHATSAPP_SEND_MESSAGE`, `INSTAGRAM_SEND_DM`).
 */
export function isMessagingSend(cap: ChannelCapabilities, capability: string): boolean {
  if (cap.platform === "generic") return false;
  if (cap.access === "session_automation") return true;
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
