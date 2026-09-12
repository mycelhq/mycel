/**
 * Is this message from US?
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * THE BUG
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A founder opened their Clients room and found one client: "Mycel Go-to-Market",
 * `gotomarket@agentmail.to`, 1 open. It is not a client. It is our own outreach mailbox, and the
 * message it had sent read "This is the reply half. If a task appears, the loop closes." — a QA
 * probe. `acceptIntake` creates a client for whoever sent the mail, and had no notion that some
 * senders are the platform itself.
 *
 * Two families, and they fail differently:
 *
 *   OURSELVES     the platform's own addresses. Their mail is machinery, not a customer, and it
 *                 should never appear in anybody's CRM.
 *   THE TENANT    the project's OWN mailbox. A message from your own desk address is a loop: the
 *                 agent answers, the answer arrives as new intake, the agent answers that. Filing
 *                 it as a client makes the business a customer of itself.
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THERE IS NO `@agentmail.to` RULE, AND MUST NEVER BE ONE
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `agentmail.to` is where our CUSTOMERS' mailboxes live — `qa-walkthrough-desk@agentmail.to` is a
 * tenant's own desk. Two of our inboxes happen to sit on that domain too. Excluding the domain
 * would silently stop every tenant on it from ever gaining a client, which is the same shape of
 * failure as the bug being fixed and much harder to see. Ours are named one at a time, on purpose.
 */

/** Mycel's own domains. Everything at these is machinery. */
const PLATFORM_DOMAINS = ["mycelai.dev"];

/** Named one at a time — see the note above about `agentmail.to`. */
const PLATFORM_ADDRESSES = ["gotomarket@agentmail.to", "mycel@agentmail.to"];

const clean = (h: string) => h.trim().toLowerCase().replace(/^mailto:/, "");

/** Extract the bare address from `Name <a@b.com>` or a plain handle. */
export function bareAddress(handle: string): string {
  const angled = /<([^>]+)>/.exec(handle);
  return clean(angled ? angled[1]! : handle);
}

/**
 * `a+anything@b.com` is `a@b.com`. Plus-addressing is how a self-loop disguises itself: the desk
 * replies from `desk+case123@agentmail.to` and the naive comparison against `desk@agentmail.to`
 * misses.
 */
function withoutTag(address: string): string {
  const at = address.lastIndexOf("@");
  if (at <= 0) return address;
  const [local, domain] = [address.slice(0, at), address.slice(at + 1)];
  const plus = local.indexOf("+");
  return `${plus > 0 ? local.slice(0, plus) : local}@${domain}`;
}

export function isPlatformAddress(handle: string, extra: string[] = []): boolean {
  const a = withoutTag(bareAddress(handle));
  if (!a.includes("@")) return false;
  const domain = a.slice(a.lastIndexOf("@") + 1);
  if (PLATFORM_DOMAINS.includes(domain)) return true;
  return [...PLATFORM_ADDRESSES, ...extra.map(clean)].some((p) => withoutTag(clean(p)) === a);
}

/**
 * True when this sender is the platform or the tenant's own desk.
 *
 * `ownAddresses` are the project's channel addresses. Pass only THIS project's — another tenant's
 * desk address is a perfectly ordinary correspondent.
 */
export function isOurOwnAddress(handle: string, ownAddresses: string[]): boolean {
  if (isPlatformAddress(handle)) return true;
  const a = withoutTag(bareAddress(handle));
  return ownAddresses.some((own) => own && withoutTag(bareAddress(own)) === a);
}

/** Marks the client row a filed-not-worked message had to be hung on. */
export const INTERNAL_CLIENT_METADATA = { internal: true } as const;

/**
 * Is this client row one of those? Hidden from every client-facing list and count.
 *
 * `synthetic` and `self` are LEGACY marks. Nothing in `src/` writes them — they were put on rows by
 * hand during QA, and production had two carrying them ("Northwind Dental", a synthetic test
 * customer, and "Mycel (self)") while every list rendered them as real customers anyway. Somebody
 * had already recorded the intent; there was just no reader. Honouring them here is cheaper than a
 * migration and it means the next hand-marked row works without anyone remembering this file.
 */
const INTERNAL_MARKS = ["internal", "synthetic", "self"] as const;

export function isInternalClient(c: { metadata?: Record<string, unknown> | null }): boolean {
  return INTERNAL_MARKS.some((m) => c.metadata?.[m] === true);
}
