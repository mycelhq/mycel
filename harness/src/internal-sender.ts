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

/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * WHOSE PLATFORM — READ FROM THE ENVIRONMENT, WITH OURS AS THE DEFAULT
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * These were two hardcoded literals naming Mycel's own mailboxes, in a kernel that is Apache-2.0 and
 * meant to be self-hosted. For anybody who clones it the values are worse than useless: their kernel
 * carefully ignores mail from OUR addresses, and their own ops mailbox — the one that sends them
 * QA probes and bounce notices — has no way to be named, so it becomes a client in their CRM.
 *
 * Which is the exact bug this file was written to fix, reproduced for every user but us. A default
 * that is right for the vendor and silently wrong for everybody else is the shape of hardcoding
 * worth hunting: it never fails here, so nothing ever reports it.
 *
 * Set as comma-separated lists. Hosted behaviour is unchanged when they are unset.
 */
const fromEnv = (name: string, fallback: string[]): string[] => {
  /*
    UNSET falls back. SET-BUT-EMPTY does not, and the distinction is the whole point.

    `raw?.trim()` then `if (!raw)` conflated them: `VAR="  "` restored our defaults while
    `VAR=" , ,"` returned none, so the same intent expressed two ways gave opposite answers. Only
    the absence of the variable is "you did not say"; anything present is an instruction, and
    "I named none" is the honest reading of an empty one.

    Returning nothing is also the safe direction. With no platform addresses, `isPlatformAddress`
    says no, and a real sender is filed as a client — recoverable. The other way round a real client
    is discarded as machinery, which is not.
  */
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
};

/**
 * Read per call, not once at import.
 *
 * A module-level `const` is decided by whichever module happened to load first, which makes this
 * untestable without a fresh process and unsettable by anything that configures the kernel after
 * boot. It runs once per inbound message, so there is no cost worth optimising for here.
 */

/** `MYCEL_PLATFORM_DOMAINS` — everything at these is machinery, never a client. */
const platformDomains = (): string[] => fromEnv("MYCEL_PLATFORM_DOMAINS", ["mycelai.dev"]);

/** `MYCEL_PLATFORM_ADDRESSES` — named one at a time, see the note above about `agentmail.to`. */
const platformAddresses = (): string[] =>
  fromEnv("MYCEL_PLATFORM_ADDRESSES", ["gotomarket@agentmail.to", "mycel@agentmail.to"]);

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
  if (platformDomains().includes(domain)) return true;
  return [...platformAddresses(), ...extra.map(clean)].some((p) => withoutTag(clean(p)) === a);
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
