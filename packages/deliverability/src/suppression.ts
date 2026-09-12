// May we mail this person? The rules, separated from wherever the list happens to be stored.
//
// ═══ THE INVARIANT ═══
//
// There is exactly one function in each app that sends, and its FIRST operation is this check. No
// `force`, no `skipSuppression`, no admin override, no second send path. If you are reading this
// because you want to add one: the reason there isn't one is that "just this once, for a warm intro"
// is how a company mails somebody who filed a complaint, and the person who does it will not be the
// person who reads the suspension notice.
//
// ═══ FIVE THINGS LAND ON ONE LIST, AND IT MATTERS THAT IT IS ONE ═══
//
//   unsubscribe    the one-click endpoint, or a reply asking to stop
//   reply_optout   a human read the reply and said this person wants out
//   hard_bounce    the address does not exist. Mailing it again is how a bounce rate climbs.
//   complaint      somebody pressed the spam button
//   manual         an operator, a legal request, a do-not-contact list
//   region         we are not permitted to mail there
//
// One list means one question with one answer, and no possibility of a code path that checks four
// of the five. A provider's own suppression list is NOT a substitute: it only knows about addresses
// that failed through it, and knows nothing about someone who replied "take me off". Under CAN-SPAM
// and GDPR, "the provider would have caught it eventually" is not a defence.
//
// ═══ WHY THE STORAGE IS NOT IN HERE ═══
//
// One side keeps this in Postgres with a hashed key and a real table; the other keeps it in the
// kernel's project-scoped record store, because a per-tenant list must be per-tenant and the kernel
// already has a store that is. Both need the SAME answers to: what is the key, does a second reason
// overwrite the first, may we keep the plaintext, and is this reason final. Those are here.

import type { SuppressReason } from "./verdict";
export type { SuppressReason } from "./verdict";

/** A row on the list, in whatever the app stores it in. */
export interface Suppression {
  /** `addressKey(email, sha256)`. The plaintext is optional; this never is. */
  key: string;
  reason: SuppressReason;
  /** ISO. When we learned. */
  at: string;
  /** Present only when `keepsPlaintext(reason)` allowed it. */
  email?: string;
  detail?: Record<string, unknown>;
}

/**
 * ═══ FIRST WRITE WINS, AND THAT IS NOT AN IMPLEMENTATION DETAIL ═══
 *
 * If somebody unsubscribed in March and their mailbox hard-bounced in June, the reason that matters
 * — the one an operator or a regulator would ask about — is the unsubscribe. Overwriting it with
 * "hard_bounce" erases the record of a request we were legally obliged to honour, and leaves us
 * unable to show that we honoured it.
 *
 * The answer is the same either way (do not mail them), so nothing is lost operationally by keeping
 * the earlier reason, and something real is lost by not.
 */
export function merge(existing: Suppression | undefined, incoming: Suppression): Suppression {
  return existing ?? incoming;
}

/**
 * Whether the address may be stored in plaintext beside the hash.
 *
 * FALSE for a request to stop. Honouring "stop processing my data" by writing that person's address
 * into a new permanent table is the wrong shape, and the hash honours it forever without keeping the
 * thing they asked us to stop keeping.
 *
 * TRUE for bounces and complaints, where an operator genuinely has to be able to answer "which list
 * did this address come from" — the address is the only way to trace it, and the incident is ours to
 * investigate rather than the person's to be forgotten from.
 */
export function keepsPlaintext(reason: SuppressReason): boolean {
  return reason === "hard_bounce" || reason === "complaint";
}

/** How a founder or an operator reads the reason. Never the enum. */
export const REASON_SAID: Record<SuppressReason, string> = {
  unsubscribe: "they unsubscribed",
  reply_optout: "they replied asking not to be contacted",
  hard_bounce: "the address does not exist",
  complaint: "they marked a message as spam",
  manual: "someone here added them to the do-not-contact list",
  region: "we are not set up to email that country",
};

/**
 * The sentence a send path reports when it refuses. Plain English, no codes, no field names — this
 * reaches a founder's screen and the rule about never exposing the platform's guts applies to a
 * refusal more than to anything else, because a refusal is when somebody is already frustrated.
 */
export function refusalSaid(s: Pick<Suppression, "reason" | "at">): string {
  const when = s.at ? ` on ${s.at.slice(0, 10)}` : "";
  return `Not sent: ${REASON_SAID[s.reason]}${when}.`;
}

/**
 * An in-memory list, for a caller that has no table yet and for every test.
 *
 * Deliberately has no `remove`. Coming off a suppression list is a hand-written delete by a person
 * with a reason, in whatever the app's store is — never a method something can call in a loop.
 */
export class SuppressionLedger {
  private readonly rows = new Map<string, Suppression>();

  add(row: Suppression): { created: boolean; row: Suppression } {
    const kept = merge(this.rows.get(row.key), row);
    const created = !this.rows.has(row.key);
    this.rows.set(row.key, kept);
    return { created, row: kept };
  }

  get(key: string): Suppression | undefined {
    return this.rows.get(key);
  }

  get size(): number {
    return this.rows.size;
  }

  /** Newest first. For a health board, and for a founder asking "who did we stop mailing". */
  recent(limit = 20): Suppression[] {
    return [...this.rows.values()].sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
  }
}
