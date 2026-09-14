import { randomBytes } from "node:crypto";

/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * REFERRAL CODES — THE PART THAT IS PURE
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A founder who has just watched this thing close a month's books for them is the single most
 * credible salesperson it will ever have, and until now the product had nothing to hand them.
 * `milestones.ts` already ASKS at the right moment — three days after the first invoice is paid —
 * and what it asks for is goodwill, because there was nothing else to offer.
 *
 * ── WHY A MINTED CODE AND NOT A DERIVED ONE ──
 *
 * The obvious implementation is `hash(org_id)`: no column, no collisions, no migration. It is wrong
 * for one reason that matters — a derived code cannot be rotated. A referral link goes in a tweet,
 * an email footer, a Slack, and the day a founder wants it to stop working there has to be
 * something to change. A stored code can be reissued; a hash of a primary key is forever.
 *
 * ── THE ALPHABET ──
 *
 * No `0`/`O`, no `1`/`I`/`L`. These get read aloud on calls and typed from screenshots, and the
 * cost of an ambiguous character is a referral silently attributed to nobody — which is the one
 * failure this system cannot detect, because a wrong code and no code look identical afterwards.
 *
 * Eight characters from a 30-letter alphabet is about 10^11 — far past guessing, and short enough
 * to say out loud.
 */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const LENGTH = 8;

export function mintReferralCode(): string {
  /*
    Rejection-free by construction: 31 does not divide 256, so `% 31` would bias the first few
    letters. The bias is tiny and the fix is free — take 5 bits at a time from a wider draw and
    discard anything past the alphabet.
  */
  const out: string[] = [];
  while (out.length < LENGTH) {
    for (const b of randomBytes(LENGTH)) {
      const i = b & 0x1f; // 0–31
      if (i < ALPHABET.length) out.push(ALPHABET[i]);
      if (out.length === LENGTH) break;
    }
  }
  return out.join("");
}

/**
 * Read a code the way a human actually supplies it: pasted as a whole URL, typed in lower case, or
 * with a stray space from a copy.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ──
 *
 * Guess. An earlier draft folded `0`→`O` and `1`→`I` "in case they misread a screenshot", which is
 * nonsense in this alphabet: those characters are EXCLUDED from it, so a code containing one was
 * never issued, and mapping it onto a neighbour would attribute a referral to an org the reader
 * never chose. A wrong code and no code look identical afterwards, which is exactly why the wrong
 * one must not be repaired into a plausible one.
 *
 * Returns undefined rather than throwing: a caller that gets it should treat the signup as
 * unreferred. A mistyped code must never cost somebody their account.
 */
export function normaliseReferralCode(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  // A whole URL, a `?ref=CODE`, or the code alone — take the last meaningful segment either way.
  const last = raw.trim().split(/[/?=&#]/).filter(Boolean).pop() ?? "";
  const code = last.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (code.length !== LENGTH) return undefined;
  return [...code].every((c) => ALPHABET.includes(c)) ? code : undefined;
}

/*
  THE LINK ITSELF IS NOT BUILT HERE, and the reason is that the kernel does not know where it
  points. A referral link goes to the MARKETING site — the place a stranger can sign up — and this
  process only knows its own address (`MYCEL_PUBLIC_URL`, which is the API). Composing it here would
  mean inventing a second source of truth for the product's public origin and getting it wrong on
  every self-hosted install.

  So the kernel hands back a CODE and the console builds the link from the origin it is already
  served on. See `cloud/lib/referral.ts`, which owns the `?ref=` convention.
*/

/**
 * WHAT A REFERRAL IS WORTH, AND WHEN.
 *
 * Both sides, and only on a PAID conversion — a signup that never subscribes has cost us a sandbox
 * and earned nobody anything, and a scheme that pays on signups is a scheme that gets farmed within
 * a week.
 *
 * Stated in months rather than money because the plans differ: "a month free" is the same promise to
 * a Starter and a Scale customer, and it does not have to be re-priced when the plans move.
 */
export const REFERRAL_REWARD_MONTHS = 1;
