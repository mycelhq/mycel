// What a bounce, a complaint or a rejection actually costs — decided once, for every transport.
//
// ═══ WHY THIS FILE IS NEW RATHER THAN MOVED ═══
//
// The rules existed in `growth/lib/email/feedback.ts`, correct and well argued, and they were
// interleaved with the four database writes that apply them. So they could not be reused, could not
// be tested without a Postgres, and — the part that matters — could not be shared with the kernel,
// which sends mail through an entirely different transport and had NO bounce handling at all.
//
// The consequence of that gap was not theoretical. On the agency side a hard bounce did nothing: the
// address stayed on the list, the next sequence step mailed it again, and the bounce rate that
// eventually gets a sending domain blocked was being fed deliberately, one retry at a time.
//
// ═══ ONE VERDICT, THREE PROVIDERS ═══
//
// SES says it hours later over SNS. SMTP says it during the transaction as a 4xx/5xx. An IMAP DSN
// says it as a message in the sending mailbox. Those are three shapes of the same fact, and the
// CONSEQUENCES have to be identical or the two products enforce different rules and the one that is
// wrong burns a domain.
//
// So each transport's parser produces a `Signal` — the small, boring shape they all agree on — and
// this file turns a Signal into a `Verdict`. The verdict says three things and nothing else:
// suppress or not, penalise the mailbox or not, and what to tell a person.
//
// ═══ THE ONE JUDGEMENT: PERMANENT VERSUS TRANSIENT ═══
//
// A 5xx and an SES `Permanent` mean the address is dead: suppress forever. A 4xx and `Transient`
// mean the receiving server was busy, greylisting, or the mailbox was full — the address is real and
// a person is behind it. Suppressing on one of those throws away a real prospect because their
// server had a bad minute, so a transient bounce is recorded and costs nothing.
//
// Getting this backwards in either direction is expensive, which is why it is one function with one
// set of tests rather than a branch in three files.

import { normalizeEmail } from "./address";
import { PENALTY_COMPLAINT, PENALTY_HARD_BOUNCE } from "./ramp";

/** What any transport reduces to. The parsers live in the apps; this shape is the contract. */
export interface Signal {
  kind: "bounce" | "complaint" | "delivery" | "reject" | "delay" | "other";
  /**
   * Whether the failure is final. Absent means "the transport did not say", which is treated as
   * TRANSIENT — the safe direction, because the cost of guessing permanent is deleting a real
   * person and the cost of guessing transient is one wasted retry.
   */
  permanent?: boolean;
  /** The address the failure is about, when the transport named one. */
  address?: string;
  /** The mailbox that sent it, so the ramp can be stepped back. */
  inbox?: string;
  /** The provider's own words: an SMTP response line, an SES bounceSubType, a diagnostic code. */
  diagnostic?: string;
  /** The provider's message id, for joining back to the send row. */
  messageId?: string;
}

export type SuppressReason = "hard_bounce" | "complaint" | "unsubscribe" | "reply_optout" | "manual" | "region";

export interface Verdict {
  /** Absent means do not suppress. Present is the reason to store, and it is final. */
  suppress?: SuppressReason;
  /** Weeks of ramp the sending mailbox loses. Zero for anything that is not the mailbox's fault. */
  penaltyWeeks: number;
  /** `complaint` and `hard_bounce` feed the health clamps; the rest are recorded and no more. */
  counts: "bounce" | "complaint" | "delivery" | "none";
  /** One line, for a person reading a log or a health board. Never a code. */
  detail: string;
  /** The normalised address this verdict is about, when there is one. */
  address?: string;
}

/**
 * The penalties come from `ramp.ts` and are NOT redefined here.
 *
 * They were, for about ten minutes, and the compiler refused the package — which is precisely the
 * drift this package exists to stop, caught at the only moment it is cheap. A complaint costing two
 * weeks in one file and three in another is two sending systems disagreeing about how bad a
 * complaint is, and the disagreement would have been invisible until a domain was already burned.
 *
 * The asymmetry itself is argued where it lives, in ramp.ts: a bounce means the address was wrong,
 * which is a data problem upstream in sourcing. A complaint means the address was RIGHT and a real
 * person read what we sent and pressed the spam button — a verdict on the message, and the signal a
 * provider suspends accounts over.
 */

export function judge(signal: Signal): Verdict {
  const address = signal.address ? normalizeEmail(signal.address) : undefined;
  const said = signal.diagnostic?.trim();
  const because = said ? ` (${said})` : "";

  if (signal.kind === "complaint") {
    return {
      suppress: "complaint",
      penaltyWeeks: PENALTY_COMPLAINT,
      counts: "complaint",
      address,
      detail: `someone marked this as spam${because} — suppressed for good, and ${signal.inbox ?? "the sending mailbox"} steps back ${PENALTY_COMPLAINT} weeks`,
    };
  }

  if (signal.kind === "bounce") {
    if (signal.permanent === true) {
      return {
        suppress: "hard_bounce",
        penaltyWeeks: PENALTY_HARD_BOUNCE,
        counts: "bounce",
        address,
        detail: `the address does not exist${because} — suppressed for good, and ${signal.inbox ?? "the sending mailbox"} steps back ${PENALTY_HARD_BOUNCE} week`,
      };
    }
    return {
      penaltyWeeks: 0,
      counts: "bounce",
      address,
      detail: `the receiving server would not take it right now${because} — recorded, not suppressed: the address is still real`,
    };
  }

  if (signal.kind === "delivery") {
    return { penaltyWeeks: 0, counts: "delivery", address, detail: "delivered" };
  }

  /**
   * A REJECT IS OURS, NOT THEIRS. The provider refused to send at all — bad credentials, a content
   * filter, an unverified identity. Suppressing the recipient for our own misconfiguration would
   * delete a real prospect for something they had no part in, and the mailbox has done nothing to
   * deserve a ramp penalty either. It is an alert, and it belongs in front of a person.
   */
  if (signal.kind === "reject") {
    return {
      penaltyWeeks: 0,
      counts: "none",
      address,
      detail: `the provider refused to send this${because} — that is a configuration problem on our side, not a bad address`,
    };
  }

  return { penaltyWeeks: 0, counts: "none", address, detail: said ?? signal.kind };
}

// ── The transport parsers' shared arithmetic ─────────────────────────────────────────────────────

/**
 * An SMTP response code to a verdict, via `judge`.
 *
 * 5xx is final and 4xx is not. That is the whole of it, and it is the same line SES draws with
 * `Permanent`/`Transient` — which is why both go through one function.
 *
 * An auth or connection failure must never reach here. `EAUTH` is not a bounce, it is us being
 * unable to log in, and treating it as one would suppress every recipient of a run that failed
 * before it sent anything. The caller classifies transport errors first; this only ever sees a
 * verdict the receiving server actually gave about a recipient.
 */
export function fromSmtpCode(args: { code: number; to: string; inbox?: string; response?: string }): Verdict {
  return judge({
    kind: args.code >= 500 ? "bounce" : args.code >= 400 ? "bounce" : "other",
    permanent: args.code >= 500,
    address: args.to,
    inbox: args.inbox,
    diagnostic: args.response ?? `SMTP ${args.code}`,
  });
}

/** SES `Permanent` / `Transient` / `Undetermined`. Undetermined is transient — see `Signal.permanent`. */
export function fromSesBounceType(bounceType: string | undefined): boolean {
  return String(bounceType ?? "").trim().toLowerCase() === "permanent";
}
