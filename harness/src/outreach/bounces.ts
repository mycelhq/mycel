// Recognising that a message did not arrive, in the two shapes that actually reach this kernel.
//
// ═══ SHAPE ONE: THE PROVIDER SAYS SO ═══
//
// A delivery event on the webhook — `message.bounced`, `message.complained`, or the SES-flavoured
// spelling of the same. Structured, unambiguous, and until now silently dropped: the AgentMail route
// acknowledged every non-`message.received` event with `{ ok: true, ignored }` and did nothing else.
// So the kernel SAW every bounce and every complaint and learned nothing from either.
//
// ═══ SHAPE TWO: A BOUNCE ARRIVES AS AN ORDINARY EMAIL, AND THIS ONE WAS WORSE THAN SILENT ═══
//
// When a receiving server rejects a message after accepting it, the failure comes back as a delivery
// status notification — a normal email, from MAILER-DAEMON or postmaster, to the mailbox that sent
// it. It arrives as `message.received`, with a `from`, a `subject` and a body, and it parsed cleanly.
//
// So a dunning chase to an address that no longer exists produced a "reply" on the client's thread.
// A ladder that stands down on an inbound reply stood down. The client never wrote, never read
// anything, and their invoice stopped being chased — because their mail server told us their address
// was dead and we filed it as them answering.
//
// ═══ HOW IT IS RECOGNISED, AND WHY NOT ON THE SENDER ALONE ═══
//
// The sender is the strongest single signal and it is not sufficient: plenty of real automated mail
// comes from `no-reply@`, and a determined forgery can put anything in a From. So a DSN is claimed
// only when the sender looks like a mail system AND the body carries the RFC 3464 fields a real DSN
// has — `Final-Recipient:` or `Original-Recipient:` with a `Status:` or `Diagnostic-Code:`. Those
// fields are what makes it machine-readable in the first place, and they are what carries the
// address that actually failed, which is the whole reason to parse it rather than just drop it.
//
// FAILING TO RECOGNISE ONE IS THE SAFE DIRECTION. An unrecognised DSN is filed as a message, which
// is where they went before this file existed. A false positive suppresses a real person on the
// strength of a subject line, which is not.
import { fromSesBounceType, judge, type Signal, type Verdict } from "@mycel/deliverability";

/** The bit of an inbound message this needs. Deliberately narrower than `AgentMailInbound`. */
export interface InboundLike {
  from_handle: string;
  subject?: string;
  text: string;
  inbox_id?: string;
}

/** Mail-system senders. Matched on the local part so any domain's daemon is caught. */
const DAEMON = /^(mailer-daemon|postmaster|mail|no-?reply|bounce[sd]?|delivery|returns?)(\b|[+._-])/i;

/** RFC 3464. The fields that make a DSN a DSN rather than an email about a delivery. */
const FINAL_RECIPIENT = /^\s*(?:final|original)-recipient:\s*(?:rfc822;)?\s*(\S+?)\s*$/im;
const STATUS = /^\s*status:\s*([245])\.(\d+)\.(\d+)\s*$/im;
const DIAGNOSTIC = /^\s*diagnostic-code:\s*(.+)$/im;
/** The response line a server gave, when the DSN quotes it inline rather than in a Diagnostic-Code. */
const SMTP_LINE = /\b([245]\d\d)[ -]\d\.\d\.\d\b/;

/**
 * A delivery status notification that came in as a message, or `undefined`.
 *
 * The address returned is the one that FAILED, read out of `Final-Recipient` — never the `from` of
 * the DSN, which is the mail daemon, and never the recipient of the DSN, which is our own mailbox.
 * Suppressing either of those would be worse than doing nothing.
 */
export function readDsn(msg: InboundLike): Verdict | undefined {
  const local = String(msg.from_handle ?? "").split("@")[0] ?? "";
  if (!DAEMON.test(local)) return undefined;

  const body = String(msg.text ?? "");
  const recipient = FINAL_RECIPIENT.exec(body)?.[1];
  if (!recipient || !recipient.includes("@")) return undefined;

  const status = STATUS.exec(body);
  const diagnostic = DIAGNOSTIC.exec(body)?.[1]?.trim();
  const inline = SMTP_LINE.exec(diagnostic ?? body)?.[1];
  // A DSN with neither a Status nor a quoted response is a report we cannot classify, and guessing
  // `permanent` on one would delete a real person over a mailbox that was full for an hour.
  if (!status && !inline) return undefined;

  const permanent = status ? status[1] === "5" : inline!.startsWith("5");
  return judge({
    kind: "bounce",
    permanent,
    address: recipient.replace(/^<|>$/g, ""),
    ...(msg.inbox_id ? { inbox: msg.inbox_id } : {}),
    ...(diagnostic || status ? { diagnostic: diagnostic ?? `status ${status![1]}.${status![2]}.${status![3]}` } : {}),
  });
}

/**
 * A provider delivery event, or `undefined` when the payload is something else entirely.
 *
 * Two vocabularies, because two providers. AgentMail-style `message.bounced` / `message.complained`,
 * and SES-style `notificationType: "Bounce"` with a `bounce.bounceType`. Both reduce to one `Signal`
 * and go through the same `judge`, so the two can never enforce different consequences — which is the
 * argument the package's verdict.ts makes at length.
 */
export function readDeliveryEvent(raw: unknown): Verdict | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const e = raw as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

  // ── SES / SNS ──
  const sesType = str(e.notificationType) ?? str(e.eventType);
  if (sesType) {
    const kind = sesType.toLowerCase();
    const mail = (e.mail ?? {}) as { destination?: unknown; messageId?: unknown; source?: unknown };
    const to = Array.isArray(mail.destination) ? str(mail.destination[0]) : undefined;
    if (kind === "bounce") {
      const b = (e.bounce ?? {}) as { bounceType?: unknown; bounceSubType?: unknown; bouncedRecipients?: unknown };
      const first = Array.isArray(b.bouncedRecipients) ? (b.bouncedRecipients[0] as Record<string, unknown> | undefined) : undefined;
      return judge({
        kind: "bounce",
        permanent: fromSesBounceType(str(b.bounceType)),
        address: str(first?.emailAddress) ?? to,
        inbox: str(mail.source),
        diagnostic: str(first?.diagnosticCode) ?? str(b.bounceSubType),
        messageId: str(mail.messageId),
      });
    }
    if (kind === "complaint") {
      const c = (e.complaint ?? {}) as { complainedRecipients?: unknown; complaintFeedbackType?: unknown };
      const first = Array.isArray(c.complainedRecipients) ? (c.complainedRecipients[0] as Record<string, unknown> | undefined) : undefined;
      return judge({
        kind: "complaint",
        address: str(first?.emailAddress) ?? to,
        inbox: str(mail.source),
        diagnostic: str(c.complaintFeedbackType),
        messageId: str(mail.messageId),
      });
    }
    return undefined;
  }

  // ── AgentMail-style `event_type` ──
  const type = str(e.event_type)?.toLowerCase();
  if (!type) return undefined;
  const m = (e.message ?? {}) as Record<string, unknown>;
  const address = str(m.to) ?? (Array.isArray(m.to) ? str(m.to[0]) : undefined) ?? str(m.recipient) ?? str(e.recipient);
  const inbox = str(m.inbox_id) ?? str(e.inbox_id);
  const diagnostic = str(m.reason) ?? str(e.reason) ?? str(m.diagnostic_code) ?? str(m.description);

  if (/\bcomplain(ed|t)\b/.test(type) || type.endsWith(".spam_report")) {
    return judge({ kind: "complaint", address, inbox, diagnostic, messageId: str(m.message_id) });
  }
  if (/\bbounce[d]?\b/.test(type) || type.endsWith(".failed") || type.endsWith(".rejected")) {
    /**
     * PERMANENCE COMES FROM THE PROVIDER'S OWN WORD, NEVER FROM THE EVENT NAME.
     *
     * `message.bounced` says a message bounced and says nothing about whether the address is dead.
     * A provider that reports a full mailbox and a nonexistent user under one event name is normal,
     * and treating both as permanent would suppress real people whose server was busy. Absent means
     * transient — see `Signal.permanent`.
     */
    const said = str(m.bounce_type) ?? str(e.bounce_type) ?? str(m.type);
    const code = SMTP_LINE.exec(diagnostic ?? "")?.[1];
    const permanent =
      said ? /^(perm|hard|permanent)/i.test(said) : code ? code.startsWith("5") : undefined;
    return judge({ kind: "bounce", ...(permanent === undefined ? {} : { permanent }), address, inbox, diagnostic, messageId: str(m.message_id) });
  }
  return undefined;
}

export type { Verdict, Signal };
