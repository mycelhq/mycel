// One address, one identity. Everything downstream keys on what this file returns.
//
// ═══ WHY NORMALISATION IS A CORRECTNESS PROBLEM AND NOT A TIDINESS ONE ═══
//
// A suppression list is only as good as its key. `Sam@Example.com ` and `sam@example.com` are one
// person, and if the list stores one and the send path looks up the other then somebody who asked us
// to stop gets mailed again — which is the single failure this whole area exists to prevent. So the
// normalisation is not "cleanup before storage", it is the definition of who the record is about,
// and it must be identical on both sides of every lookup.
//
// SUBADDRESSING IS NOT STRIPPED, deliberately. `sam+news@example.com` and `sam@example.com` deliver
// to the same mailbox at Gmail and to different ones at plenty of other hosts, and there is no way
// to know which from the address alone. Collapsing them would suppress an address the person never
// asked us to suppress at one class of provider, and treating them as different is the error that
// costs a duplicate rather than a violated request.
//
// DOTS ARE NOT STRIPPED either, for the same reason with a sharper edge: Gmail ignores them and
// nearly nobody else does. `s.am@example.com` at a corporate host is a different person.

/** Trimmed and lower-cased. The identity of an address, and the only form that is ever stored. */
export function normalizeEmail(email: string): string {
  return String(email ?? "").trim().toLowerCase();
}

/**
 * Good enough to refuse obvious rubbish before it reaches a transport, and no more.
 *
 * Not RFC 5322. A full parser accepts addresses no mail server will route and rejects ones that
 * work, and every hour spent on it is an hour not spent on the list that produced the bad address.
 */
export function looksLikeEmail(email: string): boolean {
  const e = normalizeEmail(email);
  if (e.length < 6 || e.length > 254) return false;
  if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(e)) return false;
  return !e.includes("..");
}

/**
 * A shared mailbox rather than a person: `info@`, `sales@`, `noreply@`.
 *
 * ═══ WHY THIS IS A DELIVERABILITY RULE AND NOT A SOURCING PREFERENCE ═══
 *
 * Role addresses are the ones most likely to be spam-trap seeded, most likely to be read by whoever
 * is on the rota rather than by somebody who cares, and most likely to produce a complaint rather
 * than a reply. Mailing `abuse@` or `postmaster@` is worse than useless — those are the addresses a
 * receiver watches specifically to catch senders like us, and hitting one is how a domain gets
 * blocklisted rather than merely ignored.
 *
 * Two tiers, because they are not the same decision. `never` is the trap list and there is no
 * legitimate cold send to any of them. `role` is a judgement — a small business genuinely reads
 * `info@`, and a founder may reasonably choose to write to it — so it is reported, not refused.
 */
const NEVER = new Set(["abuse", "postmaster", "noreply", "no-reply", "donotreply", "do-not-reply", "mailer-daemon", "bounce", "bounces", "spam", "unsubscribe"]);
const ROLE = new Set(["info", "sales", "hello", "contact", "support", "admin", "office", "enquiries", "inquiries", "help", "team", "accounts", "billing", "careers", "jobs", "hr", "marketing", "press", "media", "webmaster", "security", "privacy", "legal"]);

export type AddressGrade = "person" | "role" | "never";

export function gradeAddress(email: string): AddressGrade {
  const local = normalizeEmail(email).split("@")[0] ?? "";
  // `noreply.orders@` and `no-reply+x@` are the same address wearing a suffix.
  const head = local.split(/[+._-]/)[0] ?? local;
  if (NEVER.has(local) || NEVER.has(head)) return "never";
  if (ROLE.has(local) || ROLE.has(head)) return "role";
  return "person";
}

/**
 * The key a suppression list is stored under: sha256 of the normalised address, hex.
 *
 * ═══ WHY A HASH AND NOT THE ADDRESS ═══
 *
 * Honouring "stop processing my data" by writing that person's address into a new permanent table is
 * the wrong shape, and a hash honours the request forever without keeping the thing they asked us to
 * stop holding. The one-click unsubscribe endpoint never sees an address either — the token carries
 * the hash — so the plaintext genuinely is not needed for the common case.
 *
 * Bounces and complaints are the exception and the app decides: an operator investigating "which
 * list produced this" needs to read the address. See `keepsPlaintext` in suppression.ts.
 *
 * ═══ WHY THE HASH FUNCTION IS INJECTED ═══
 *
 * This package is pure and has no dependencies, and both callers already have a sha256 to hand —
 * node's `crypto` in one and the same in the other. Importing `node:crypto` here would make the
 * package node-only for one line, and reimplementing sha256 to avoid that would be worse. So the
 * caller passes the primitive and this file owns the INPUT to it, which is the part that must not
 * differ between the two sides.
 */
export type Sha256Hex = (input: string) => string;

export function addressKey(email: string, sha256: Sha256Hex): string {
  return sha256(normalizeEmail(email));
}
