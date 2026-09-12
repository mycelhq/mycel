// Mail that came from a machine, not from the client.
//
// ═══════════════════════════════════════════════════════════════════════════════════════════════
// WHY THIS IS NOT COSMETIC
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
// An inbound message does three things: it is filed on the conversation, it STARTS A RUN, and if the
// thread is one we chased an invoice on it STANDS THE CHASE DOWN. All three are correct for a client
// writing back. All three are wrong for an out-of-office.
//
// `readDsn` already catches the bounce case, and its note says exactly what that cost: "a dunning
// chase to an address that no longer exists produced a 'reply', and a ladder that stands down on an
// inbound reply stood down — so the client never wrote, never read anything, and their invoice
// stopped being chased." An autoresponder is the same failure with a live mailbox behind it: the
// client is on holiday, the machine answers, the chase stops, and nobody finds out until the money
// is a month older.
//
// It is also a metered run against a message no human wrote.
//
// ═══ WHAT IS NOT AVAILABLE, AND WHAT IS USED INSTEAD ═══
//
// The correct signal is RFC 3834's `Auto-Submitted:` header, or `Precedence: bulk`. WE DO NOT HAVE
// THEM: `AgentMailInbound` carries `from_handle`, `from_name`, `subject` and `text`, and nothing
// else. Writing a header check against a payload with no headers would be a guard that can never
// fire, which is this codebase's most common defect and not worth adding a second time.
//
// So this uses the two signals that ARE present, and is deliberately conservative about each.
//
// SENDER. A no-reply address is unambiguous: nobody at a client types a reply from `no-reply@`. The
// local part is matched, never the domain, because `noreply.acme.com` is somebody's mail host and
// `jane@noreply-solutions.example` is a person.
//
// SUBJECT PREFIX. Every mail client formats an automatic reply the same way — "Automatic reply:",
// "Out of Office:", "Réponse automatique :". Matched only at the START of the subject, so a client
// writing "Re: out of office cover for August" is a person asking about cover and is treated as one.
// A bare "Out of office" with nothing after it also counts, because that is the whole subject an
// autoresponder sends.
//
// The body is NOT read. "I am out of the office" appears inside plenty of real replies written by
// real people who are telling you something.

/** Local parts that no human replies from. Matched exactly, after stripping any `+tag`. */
const ROBOT_LOCAL =
  /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|auto[-_.]?reply|autoreply|autoresponder|mailer[-_.]?daemon|postmaster|bounces?|notifications?|alerts?|noreply)$/i;

/**
 * ═══ TWO PATTERNS, BECAUSE TWO KINDS OF PHRASE ═══
 *
 * The first version was one regex with an optional `Re:` prefix, and it read
 * "Re: out of office cover for August" — a client asking who is covering — as a machine. That is the
 * false positive that matters: a real client writes in and the business never notices.
 *
 * EXPLICIT markers ("Automatic reply", "Abwesenheitsnotiz") are things only software writes. They
 * may carry a `Re:` prefix, because a forwarded autoresponder still is one.
 *
 * "OUT OF OFFICE" IS ORDINARY ENGLISH. People say it about themselves and about each other, so it
 * only counts at the absolute start of the subject — no `Re:` — and only when what follows is a
 * colon, the end of the subject, or a word an autoresponder uses next. Anything else is prose in a
 * sentence a person wrote.
 */
const AUTO_SUBJECT_EXPLICIT =
  /^\s*(re\s*:\s*)?(automatic(al)? reply|auto[-\s]?reply|autoreply|abwesenheit(snotiz)?|réponse automatique|respuesta automática|automatisch antwoord|risposta automatica|automatiskt svar)\b/i;

const AUTO_SUBJECT_OOO =
  /^\s*(out of (the )?office|away from (the )?office|on annual leave|on holiday)\s*(:|-|–|$|\b(until|till|til|back|returning|return|from)\b)/i;

export interface AutoReplyVerdict {
  /** Which signal fired. Recorded so a false positive can be diagnosed from a log line. */
  because: "sender" | "subject";
  detail: string;
}

/**
 * Is this machine-generated? Returns why, or undefined.
 *
 * `undefined` means "treat as a person", which is the safe direction: the cost of missing an
 * autoresponder is one wasted run and a chase that pauses a few days early, and the cost of a false
 * positive is a real client writing in and the business never noticing.
 */
export function readAutoReply(msg: {
  from_handle?: string;
  subject?: string;
}): AutoReplyVerdict | undefined {
  const handle = String(msg.from_handle ?? "").trim().toLowerCase();
  const local = (handle.split("@")[0] ?? "").split("+")[0] ?? "";
  if (local && ROBOT_LOCAL.test(local)) {
    return { because: "sender", detail: handle };
  }

  const subject = String(msg.subject ?? "");
  if (AUTO_SUBJECT_EXPLICIT.test(subject) || AUTO_SUBJECT_OOO.test(subject)) {
    return { because: "subject", detail: subject.slice(0, 120) };
  }

  return undefined;
}
