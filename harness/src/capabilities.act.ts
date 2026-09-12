// Perform a capability through whatever the founder actually connected. The write-side twin of
// capabilities.read.ts, and the half that did not exist.
//
// ═══ THE FAILURE THIS EXISTS FOR ═══
//
// `send_email` was a word. Five blueprints declared it — invoice-chaser, books-keeper,
// recruiting-desk, contract-desk, security-questionnaire — `capabilities.ts` gave it a title, a
// question and a list of toolkits, and `resolveCapability` returned `ok: true` the moment a Gmail
// connection existed. Nothing anywhere composed a send. What actually happened at run time was that
// the agent was handed a Composio connection and left to guess the tool slug and its argument names
// out of its own weights, per run, per provider. When it guessed `GMAIL_SEND_MESSAGE` instead of
// `GMAIL_SEND_EMAIL`, or put the body in `text` where the toolkit wanted `body`, the proxy returned a
// tool error into the sandbox, the agent wrote its summary, and the chase did not go out — with no
// bounce, no queue, and nothing on any screen a founder reads. `unreadable: true` had been protecting
// the READ side from precisely this shape of silence for months.
//
// ═══ WHY PLANNING AND SENDING ARE SEPARATE FUNCTIONS ═══
//
// Nothing in this file sends anything. `planSendEmail` and `planBookCalendar` are pure: they resolve
// the binding, choose the provider, build the vendor's arguments and hand back a `CapabilityCall`
// that somebody else executes. That is not fastidiousness, it is the security model —
//
//   · The only executor for a `CapabilityCall` is the action proxy in server.ts, which is the far
//     side of the HUMAN APPROVAL GATE. A `send()` in this module would be a second outbound path,
//     and a second outbound path is a path that will one day be reached without the gate. There is
//     deliberately no way to spell "send" here.
//   · A planner that cannot perform I/O can be tested exhaustively with no Composio key, which is
//     the situation this adapter was written in and — for any self-hosted operator — the situation
//     it will be maintained in.
//
// ═══ TENANCY ═══
//
// `project_id` is a required field of a required argument, never defaulted, and the binding is
// resolved through `resolveCapability`, which filters on exact `project_id` equality and founder
// ownership. Two cross-tenant leaks have shipped in this repo. The one this file could produce is
// the worst of the three: resolving another tenant's mailbox would send a chase from one business's
// address to another business's client, and every reply would land in the wrong company.
import type { Connection } from "./contract";
import {
  CAPABILITIES,
  brokeredCaveat,
  capabilityAdapter,
  resolveCapability,
  type BoundProvider,
  type CapabilityBinding,
  type CapabilityName,
} from "./capabilities";

/**
 * A call the caller may execute, once a human has said yes.
 *
 * `connection_id` rather than the connection, because the executor re-reads the row: a plan is data
 * that can sit in an approval queue for five minutes, and the connection it names may have been
 * revoked in the meantime.
 */
export interface CapabilityCall {
  capability: CapabilityName;
  connection_id: string;
  /** What a founder calls the provider. For the approval card. */
  provider_label: string;
  /** Composio tool slug, or the kernel's own verb for a non-brokered transport. */
  tool: string;
  /** The vendor's own argument names, built by the adapter. Passed through `redactPreview` upstream. */
  arguments: Record<string, unknown>;
  /** One line for a human: what is about to happen, to whom. Never the credential, never the body. */
  preview: string;
}

/** A plan, or a refusal in a sentence. Never a half-answer, and never silence. */
export type CapabilityPlan =
  | { ok: true; call: CapabilityCall; binding: CapabilityBinding }
  | { ok: false; refusal: string; binding?: CapabilityBinding };

const refuse = (refusal: string, binding?: CapabilityBinding): CapabilityPlan => ({ ok: false, refusal, binding });

// ═══════════════════════════ EMAIL ═══════════════════════════

/**
 * A send, in the kernel's own words. One shape, whatever is behind it.
 *
 * What is NOT here is as deliberate as what is. There is no `from` and no `reply_to`: both are read
 * off the CONNECTION by the adapters below, never off this request. An agent that could choose its
 * own From could send as another identity; an agent that could choose its own Reply-To could route a
 * client's answer — *"I paid this on the 3rd, here is the reference"* — away from the business, which
 * is the failure `sendEmail` in actions.ts already argues at length and which no new send path is
 * allowed to reintroduce.
 */
export interface EmailSend {
  /** One or more recipients. Empty is a refusal, not an empty send. */
  to: readonly string[];
  subject: string;
  /** Plain text. Always sent — an HTML-only email is unreadable to a client whose reader blocks it. */
  text: string;
  html?: string;
  cc?: readonly string[];
}

/** Where a reply must go, taken from the connection and from nowhere else. */
function replyToOf(conn: Connection): string | undefined {
  const cfg = (conn.config ?? {}) as Record<string, unknown>;
  const explicit = typeof cfg.reply_to === "string" ? cfg.reply_to.trim() : "";
  if (explicit) return explicit;
  // AgentMail's inbox address IS a mailbox that receives, and its webhook lands the reply on the
  // thread the chase opened. Defaulting Reply-To to it is not a guess: it is the address the send
  // goes out from anyway, and naming it explicitly survives a provider that rewrites From.
  const address = typeof cfg.address === "string" ? cfg.address.trim() : "";
  if (address) return address;
  const from = typeof cfg.from === "string" ? cfg.from.trim() : "";
  return from || undefined;
}

/**
 * A recipient list that is actually addressable.
 *
 * A bare `@`-and-a-dot check, because the alternative is worse in both directions: a real RFC 5322
 * parser rejects addresses that deliver fine, and no check at all lets `"the client"` — which a model
 * will write when it does not know the address — reach a provider that answers 400 three approval
 * screens later. What this catches is the one that costs money: a header injection through a newline.
 */
function addressFaults(list: readonly string[], field: string): string | undefined {
  if (!list.length) return `${field} is empty — a send with no recipient is not a send`;
  for (const a of list) {
    if (/[\r\n]/.test(a)) return `"${a}" contains a line break, which is header injection, not an address`;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a.trim())) return `"${a}" is not an email address`;
  }
  return undefined;
}

/**
 * Turn the kernel's send into one vendor's arguments.
 *
 * `build` returns `{ error }` rather than throwing so a provider that cannot express something the
 * request asked for (an attachment, a cc the toolkit has no field for) refuses with a sentence
 * instead of silently dropping it — dropping a cc is how a client's accountant stops being copied on
 * their own invoice and nobody notices for a quarter.
 */
export interface EmailAdapter {
  build(send: EmailSend, conn: Connection): { arguments: Record<string, unknown> } | { error: string };
  /** The provider's answer → what the kernel keeps. Both fields optional: not every provider says. */
  parse(data: unknown): { message_id?: string; thread_id?: string };
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** Dig a field out of whatever envelope the broker wrapped the provider's answer in. */
function field(data: unknown, ...keys: string[]): string | undefined {
  const d = (data ?? {}) as Record<string, unknown>;
  const inner = (d.data ?? {}) as Record<string, unknown>;
  const resp = (d.response_data ?? {}) as Record<string, unknown>;
  for (const src of [d, inner, resp]) {
    for (const k of keys) {
      const v = str((src as Record<string, unknown>)[k]);
      if (v) return v;
    }
  }
  return undefined;
}

export const SEND_EMAIL_ADAPTERS: Record<string, EmailAdapter> = {
  /**
   * Gmail through Composio.
   *
   * UNVERIFIED against the live catalogue: `GMAIL_SEND_EMAIL` is the slug this repo's own approval
   * fixtures and trace tests already use, and `recipient_email`/`subject`/`body` are the argument
   * names Composio's Gmail tool documents, but neither could be checked without a key. If they are
   * wrong the tool answers an argument error that lands on the run's trace — loudly, and attached to
   * the approval the founder granted — which is why being wrong here is survivable and guessing
   * silently at run time was not.
   *
   * `is_html` rather than two body fields: Gmail's tool takes one body and a flag. The plain text is
   * still what is sent when there is no HTML, so a client on a text-only reader gets the words.
   */
  gmail_send: {
    build(send, conn) {
      const replyTo = replyToOf(conn);
      return {
        arguments: {
          recipient_email: send.to[0],
          ...(send.to.length > 1 ? { extra_recipients: [...send.to.slice(1)] } : {}),
          ...(send.cc?.length ? { cc: [...send.cc] } : {}),
          subject: send.subject,
          body: send.html ?? send.text,
          is_html: !!send.html,
          // Omitted entirely when unset. An empty Reply-To is rejected by some transports, which
          // would turn a missing line of connection config into a failed dunning send.
          ...(replyTo ? { reply_to: replyTo } : {}),
        },
      };
    },
    parse: (data) => ({
      ...(field(data, "id", "message_id") ? { message_id: field(data, "id", "message_id")! } : {}),
      ...(field(data, "threadId", "thread_id") ? { thread_id: field(data, "threadId", "thread_id")! } : {}),
    }),
  },

  /**
   * Outlook through Composio. Verified 2026-08-11 against the live catalogue: the tool is
   * `OUTLOOK_OUTLOOK_SEND_EMAIL` with flattened args (`to_email`, `body`, `is_html`) — not Graph's
   * nested `message.toRecipients`. Building Graph-native nesting here would 400 at execute time.
   *
   * Composio exposes a single primary `to_email`. Extra recipients ride as `cc_emails` so a chase
   * that names two people still reaches both, rather than refusing the whole send.
   */
  outlook_send: {
    build(send) {
      return {
        arguments: {
          to_email: send.to[0],
          ...(send.to.length > 1
            ? { cc_emails: [...send.to.slice(1), ...(send.cc ?? [])] }
            : send.cc?.length
              ? { cc_emails: [...send.cc] }
              : {}),
          subject: send.subject,
          body: send.html ?? send.text,
          is_html: !!send.html,
          save_to_sent_items: true,
          // Composio's Outlook tool has no Reply-To field. Prefer AgentMail / a transport when a
          // chase must land replies on a Mycel-owned inbox.
        },
      };
    },
    parse: (data) => ({
      ...(field(data, "id", "message_id") ? { message_id: field(data, "id", "message_id")! } : {}),
      ...(field(data, "conversationId", "thread_id") ? { thread_id: field(data, "conversationId", "thread_id")! } : {}),
    }),
  },

  /**
   * The kernel's own AgentMail inbox. VERIFIED, unlike the two above: `sendAgentMail` in actions.ts is
   * real code against a real API in this repo, and these are the payload keys it reads.
   *
   * The inbox is NOT an argument. It comes off the connection inside the executor, because the inbox
   * is both the sending identity and the routing key the inbound webhook resolves a project from — an
   * agent that could name its own inbox could send as another business and capture its replies.
   */
  agentmail_send: {
    build(send) {
      return { arguments: { to: [...send.to], subject: send.subject, body: send.text, ...(send.html ? { html: send.html } : {}) } };
    },
    parse: (data) => ({
      ...(field(data, "message_id", "id") ? { message_id: field(data, "message_id", "id")! } : {}),
      // The one field that makes a reply attachable to the conversation it answers. See the note on
      // `sendAgentMail`: without it the reply lands on the client's general thread and stands nothing
      // down, which looks like success from every angle except the one that matters.
      ...(field(data, "thread_id") ? { thread_id: field(data, "thread_id")! } : {}),
    }),
  },

  /**
   * The founder's own transactional sender, through `sendEmail` in actions.ts. VERIFIED — same file,
   * same keys. `from` and `reply_to` are set there off the connection and are deliberately absent
   * here, so there is exactly one place in the kernel that decides what address a client sees.
   */
  transport_send: {
    build(send, conn) {
      if (!str((conn.config ?? {}).api_url)) {
        return { error: `connection "${conn.name}" has no config.api_url, so there is nothing to POST the send to` };
      }
      return { arguments: { to: send.to.length === 1 ? send.to[0] : [...send.to], subject: send.subject, body: send.text, ...(send.html ? { html: send.html } : {}) } };
    },
    parse: (data) => ({ ...(field(data, "MessageID", "message_id", "id") ? { message_id: field(data, "MessageID", "message_id", "id")! } : {}) }),
  },
};

// ═══════════════════════════ CALENDAR ═══════════════════════════

/**
 * A booking, in the kernel's own words.
 *
 * ═══ WHAT IS STORED AND WHAT IS DISPLAYED ═══
 *
 * `starts_at`/`ends_at` are UTC INSTANTS and must carry an offset. There is no field on this request
 * for a wall-clock time, because a wall clock is not a time: "Tuesday 3pm" is two different instants
 * across a DST boundary and the kernel would resolve it in whatever zone the harness process happens
 * to run in. Every caller that has a wall clock must convert it before it gets here, where the zone
 * it means is still known.
 *
 * `time_zone` is an IANA name and does two things, neither of them arithmetic. It is what the founder
 * and the client SEE ("3:00pm, Europe/London" rather than an instant nobody reads), and it is what
 * the provider is told to display the event in — Google and Graph both want it, and a booking created
 * without it renders in the calendar owner's default zone, which for a client in another country is
 * an event that says the wrong hour on their screen while being the right instant underneath.
 */
export interface BookingRequest {
  title: string;
  /** UTC instant, offset required. */
  starts_at: string;
  /** UTC instant, offset required, strictly after `starts_at`. */
  ends_at: string;
  /** IANA zone for display. Required: an event with no stated zone is one somebody reads wrong. */
  time_zone: string;
  /** Who is invited. May be empty — a held slot with no attendee is a legitimate booking. */
  attendees?: readonly string[];
  description?: string;
  location?: string;
}

export interface BookingAdapter {
  build(req: BookingRequest, conn: Connection): { arguments: Record<string, unknown> } | { error: string };
  parse(data: unknown): { event_id?: string; join_url?: string };
}

export const BOOK_CALENDAR_ADAPTERS: Record<string, BookingAdapter> = {
  /**
   * Google Calendar through Composio. Verified 2026-08-11 against the live catalogue
   * (`GOOGLECALENDAR_CREATE_EVENT`).
   *
   * Both instants are sent as RFC-3339 with the `Z` offset ALREADY on them, and `timeZone` is sent
   * beside them. Google resolves the instant from the offset and uses `timeZone` only for display and
   * recurrence, so the two cannot disagree about when the meeting is — which is the specific way this
   * goes wrong when a caller sends a naive string and a zone and lets the provider combine them.
   */
  google_calendar_book: {
    build(req) {
      return {
        arguments: {
          summary: req.title,
          ...(req.description ? { description: req.description } : {}),
          ...(req.location ? { location: req.location } : {}),
          start: { dateTime: req.starts_at, timeZone: req.time_zone },
          end: { dateTime: req.ends_at, timeZone: req.time_zone },
          ...(req.attendees?.length ? { attendees: req.attendees.map((email) => ({ email })) } : {}),
          // The invitation is the point. A booking the client is never told about is a slot the
          // founder has lost and a meeting nobody attends.
          send_updates: "all",
        },
      };
    },
    parse: (data) => ({
      ...(field(data, "id", "event_id") ? { event_id: field(data, "id", "event_id")! } : {}),
      ...(field(data, "hangoutLink", "join_url") ? { join_url: field(data, "hangoutLink", "join_url")! } : {}),
    }),
  },

  /**
   * Outlook through Composio. Verified 2026-08-11: tool is `OUTLOOK_OUTLOOK_CALENDAR_CREATE_EVENT`
   * with flattened args (`start_datetime`, `end_datetime`, `time_zone`, `body` required). Graph-native
   * nesting would 400. Instants are sent as naive UTC with `time_zone: "UTC"` so the wall clock
   * cannot be misread; the founder's zone is noted in the body line for display.
   */
  outlook_book: {
    build(req) {
      const naive = (iso: string) => iso.replace(/(\.\d+)?Z$/, "");
      const body =
        req.description?.trim() ||
        (req.time_zone !== "UTC" ? `${req.title} (${req.time_zone})` : req.title) ||
        "(no description)";
      return {
        arguments: {
          subject: req.title,
          body,
          is_html: false,
          start_datetime: naive(req.starts_at),
          end_datetime: naive(req.ends_at),
          time_zone: "UTC",
          show_as: "busy",
          ...(req.location ? { location: req.location } : {}),
          ...(req.attendees?.length
            ? { attendees_info: req.attendees.map((email) => ({ email, type: "required" })) }
            : {}),
        },
      };
    },
    parse: (data) => ({
      ...(field(data, "id", "event_id") ? { event_id: field(data, "id", "event_id")! } : {}),
      ...(field(data, "joinUrl", "join_url", "webLink") ? { join_url: field(data, "joinUrl", "join_url", "webLink")! } : {}),
    }),
  },
};

/**
 * Does an adapter exist for this shape on this capability? The boot gate's only question, and the
 * exact counterpart of `hasShape` for reads. A capability the kernel does not act through has no
 * adapters and must not declare any — returning false is what makes `assertCapabilityTableValid`
 * catch an `actions` block added to `read_payments` by accident.
 */
export function hasActionShape(capability: CapabilityName, shape: string): boolean {
  if (capability === "send_email") return Object.hasOwn(SEND_EMAIL_ADAPTERS, shape);
  if (capability === "book_calendar") return Object.hasOwn(BOOK_CALENDAR_ADAPTERS, shape);
  return false;
}

// ═══════════════════════════ PLANNING ═══════════════════════════

/**
 * Resolve a capability down to the ONE provider that will perform it, or a sentence saying why not.
 *
 * Shared by both planners because the refusals are the same six and they must read the same on both.
 * Every branch returns prose a founder could act on: nothing connected, two things connected, a
 * provider with no adapter, a capability with no adapter at all.
 */
function soleProvider(
  capability: CapabilityName,
  connections: readonly Connection[],
  projectId: string,
): { provider: BoundProvider; binding: CapabilityBinding } | { refusal: string; binding: CapabilityBinding } {
  const binding = resolveCapability(capability, connections, projectId);
  if (!binding.bound.length) return { refusal: binding.detail, binding };
  // Cardinality is enforced by `resolveCapability` and re-read here rather than re-decided: two
  // mailboxes and no rule for which to use is how a client gets the same chase twice, from two
  // addresses, and picking by array order would decide what the client sees with nobody having said so.
  if (binding.ambiguous) return { refusal: binding.detail, binding };
  const usable = binding.bound.find((b) => !b.unactionable && !b.unreadable);
  if (!usable) return { refusal: binding.detail, binding };
  return { provider: usable, binding };
}

/**
 * Plan a send. Nothing here sends; see the header.
 *
 * The `agentmail` provider is preferred over Gmail/Outlook by nothing in this function — the table's
 * order is the offer order and `resolveCapability` refuses two rather than ranking them, so whichever
 * single mailbox this founder connected is the one used. That is the point of the capability: the
 * same one-line declaration in a manifest works for a business on Gmail and a business on its own
 * Postmark account, and neither wedge learns which.
 */
export function planSendEmail(args: {
  project_id: string;
  connections: readonly Connection[];
  send: EmailSend;
}): CapabilityPlan {
  if (!args.project_id) throw new Error("planning a send must be scoped to a project");
  const { send } = args;

  const to = send.to.map((s) => s.trim()).filter(Boolean);
  const fault = addressFaults(to, "the recipient list") ?? (send.cc?.length ? addressFaults(send.cc.map((s) => s.trim()), "cc") : undefined);
  if (fault) return refuse(`this send cannot be built: ${fault}`);
  if (!send.subject.trim()) return refuse("this send has no subject — a subjectless chase reads as spam and is filed as one");
  if (!send.text.trim()) return refuse("this send has no plain-text body, and an HTML-only email is unreadable to a client whose reader blocks it");

  const picked = soleProvider("send_email", args.connections, args.project_id);
  if ("refusal" in picked) return refuse(picked.refusal, picked.binding);
  const { provider, connection } = picked.provider;

  const action = (provider.actions ?? [])[0];
  const adapter = action ? SEND_EMAIL_ADAPTERS[action.shape] : undefined;
  if (!action || !adapter) {
    // Unreachable once `assertCapabilityTableValid` has run at boot, and loud rather than skipped
    // because the only way here is an override file validated against a different registry.
    return refuse(
      `${provider.label} is connected but the shape "${action?.shape ?? "?"}" it names has no adapter in this kernel, so nothing was sent`,
      picked.binding,
    );
  }
  const built = adapter.build({ ...send, to }, connection);
  if ("error" in built) return refuse(`${provider.label} cannot send this: ${built.error}`, picked.binding);

  return {
    ok: true,
    binding: picked.binding,
    call: {
      capability: "send_email",
      connection_id: connection.id,
      provider_label: provider.label,
      tool: action.slug,
      arguments: built.arguments,
      // Recipient and subject only. The body is deliberately not in the one-line preview — the
      // approval card renders the arguments underneath, through `redactPreview`, and a preview that
      // is itself a document is a preview nobody reads.
      preview: `Email ${to.join(", ")} — "${send.subject.trim()}" (via ${provider.label})`,
    },
  };
}

/**
 * Plan a booking. Nothing here books.
 *
 * ═══ THE TIMEZONE CHECKS ARE THE FUNCTION ═══
 *
 * Both instants must carry an offset and the end must be strictly after the start. A naive string is
 * REFUSED rather than assumed to be UTC, because the assumption is invisible when it is right and
 * invisible when it is wrong: a slot confirmed as "3pm" that lands at 2pm in April and 3pm in January
 * produces one client who was stood up and no error anywhere. The zone is required for the same
 * reason from the other end — an event created with no stated zone renders in the calendar owner's
 * default, so a London founder booking a New York client puts the wrong hour on the client's screen
 * while the underlying instant is right, which is worse than being wrong twice.
 */
export function planBookCalendar(args: {
  project_id: string;
  connections: readonly Connection[];
  booking: BookingRequest;
}): CapabilityPlan {
  if (!args.project_id) throw new Error("planning a booking must be scoped to a project");
  const b = args.booking;

  if (!b.title.trim()) return refuse("this booking has no title — an untitled event on a client's calendar is one they decline");
  const offsetted = /(Z|[+-]\d{2}:?\d{2})$/;
  for (const [name, value] of [["starts_at", b.starts_at], ["ends_at", b.ends_at]] as const) {
    if (!offsetted.test(value) || Number.isNaN(Date.parse(value))) {
      return refuse(
        `${name} is "${value}", which carries no UTC offset — this kernel will not guess which hour that means, ` +
          `because guessing is right half the year and silently wrong the other half`,
      );
    }
  }
  if (Date.parse(b.ends_at) <= Date.parse(b.starts_at)) {
    return refuse(`this booking ends at or before it starts (${b.starts_at} → ${b.ends_at})`);
  }
  if (!b.time_zone.trim()) {
    return refuse("this booking states no timezone, so nobody can be told what time it is in their own day");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: b.time_zone });
  } catch {
    return refuse(`"${b.time_zone}" is not an IANA timezone this runtime knows (expected something like "Europe/London")`);
  }
  const badAttendee = b.attendees?.length ? addressFaults(b.attendees, "the attendee list") : undefined;
  if (badAttendee) return refuse(`this booking cannot be built: ${badAttendee}`);

  const picked = soleProvider("book_calendar", args.connections, args.project_id);
  if ("refusal" in picked) return refuse(picked.refusal, picked.binding);
  const { provider, connection } = picked.provider;

  const action = (provider.actions ?? [])[0];
  const adapter = action ? BOOK_CALENDAR_ADAPTERS[action.shape] : undefined;
  if (!action || !adapter) {
    return refuse(
      `${provider.label} is connected but the shape "${action?.shape ?? "?"}" it names has no adapter in this kernel, so nothing was booked`,
      picked.binding,
    );
  }
  // Normalised to a true UTC instant before the adapter sees it, so both adapters receive the same
  // string for the same moment no matter which of the several legal offset spellings the caller used.
  const normalised: BookingRequest = {
    ...b,
    starts_at: new Date(b.starts_at).toISOString(),
    ends_at: new Date(b.ends_at).toISOString(),
  };
  const built = adapter.build(normalised, connection);
  if ("error" in built) return refuse(`${provider.label} cannot book this: ${built.error}`, picked.binding);

  return {
    ok: true,
    binding: picked.binding,
    call: {
      capability: "book_calendar",
      connection_id: connection.id,
      provider_label: provider.label,
      tool: action.slug,
      arguments: built.arguments,
      // The instant AND the zone, because a founder approving a booking has to be able to tell that
      // 15:00 Europe/London is what they meant, and the instant alone does not let them.
      preview:
        `Book "${normalised.title}" ${normalised.starts_at} → ${normalised.ends_at} (${normalised.time_zone})` +
        `${normalised.attendees?.length ? ` with ${normalised.attendees.join(", ")}` : ""} on ${provider.label}`,
    },
  };
}

/**
 * What this kernel can and cannot actually do, as data. The audit surface.
 *
 * Exported so the capability route, the tests and any future founder-facing screen all read the same
 * answer rather than each deciding for itself which verbs are real — which is how the read side ended
 * up honest on one screen and green on another.
 */
export function capabilityImplementation(capability: CapabilityName): {
  capability: CapabilityName;
  adapter: "kernel" | "brokered";
  reads: boolean;
  acts: boolean;
  /** A sentence for a founder. Empty string is never returned. */
  note: string;
} {
  const spec = CAPABILITIES[capability];
  const adapter = capabilityAdapter(capability);
  return {
    capability,
    adapter,
    reads: spec.kernel_parses,
    acts: spec.kernel_acts,
    note:
      adapter === "brokered"
        ? brokeredCaveat(capability)
        : `this kernel ${[spec.kernel_parses ? "reads and normalises" : "", spec.kernel_acts ? "composes and sends" : ""]
            .filter(Boolean)
            .join(" and ")} ${capability} itself, so the verb means the same thing whichever provider is behind it`,
  };
}
