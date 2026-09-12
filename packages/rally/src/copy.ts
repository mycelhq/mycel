// What to say, and when — because the same sentence is wrong on two different days.
//
// The founder put it exactly: "the days before launch, we'll just be telling people we're gonna
// launch that day... but on the day, we're gonna say we launched today."
//
// That is two different asks, and the difference matters more than the wording. Before the launch
// you are asking somebody to REMEMBER something, which is a favour they will probably forget. On
// the day you are asking them to CLICK something, which takes eight seconds. So the pre-launch
// message exists to earn the right to send the second one, and the second one is the point.
//
// ═══ AND A THIRD PHASE, WHICH IS THE ONE THAT GETS FORGOTTEN ═══
//
// After launch day there is nothing left to ask for. growth/lib/launch/window.ts already carries
// this rule for the product's own email — it refuses the ask as `too_late` — and the reason is
// worth repeating here: a message about a day that has passed tells the reader you are not paying
// attention, and it is worse than silence. The Product Hunt campaign in the product sat paused for
// a week past its date precisely because nothing said so.

export type Phase = "early" | "eve" | "launch" | "over";

export interface Launch {
  /** Midnight UTC on launch day. */
  at: Date;
  /** The post, once it exists. Until then the launch-day message links to the profile. */
  url?: string;
}

const DAY = 86_400_000;

/** Whole days from `now` to launch day. 0 is launch day itself; negative is after. */
export function daysUntil(launch: Date, now: Date): number {
  const a = Date.UTC(launch.getUTCFullYear(), launch.getUTCMonth(), launch.getUTCDate());
  const b = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((a - b) / DAY);
}

export function phaseOf(launch: Date, now: Date): Phase {
  const d = daysUntil(launch, now);
  if (d < 0) return "over";
  if (d === 0) return "launch";
  if (d === 1) return "eve";
  return "early";
}

/**
 * The first name, as they would write it themselves.
 *
 * Three cases that all appear in the real list:
 *
 *   "Tham (Sylvia) Nguyen"  → Tham        brackets are an alias, not part of the name
 *   "J.D. Salbego"          → J.D.        initials keep their periods; "JD" is a different name
 *   "GUSTAVO ARRETURETA"    → Gustavo     Product Hunt display names are often shouted
 *
 * Apostrophes and hyphens survive untouched, because O'Brien and Anne-Marie are spelled that way.
 */
const first = (name: string): string => {
  const head = (name.trim().split(/\s+/)[0] ?? name).replace(/[()\[\]{}"«»,;:!?]/g, "");
  // A period anywhere but the end means initials — keep it whole. Otherwise drop a trailing dot.
  const initials = /\.[^.]/.test(head);
  const kept = initials ? head : head.replace(/\.$/, "");
  if (!kept) return name.trim();
  // Re-case only a name that is entirely upper. Initials are exempt: "J.D." IS all upper and
  // lowering it gives "J.d.", which is not anybody's name.
  const shouted = !initials && kept.length > 1 && kept === kept.toUpperCase() && kept !== kept.toLowerCase();
  return shouted ? kept.charAt(0) + kept.slice(1).toLowerCase() : kept;
};

export interface Voice {
  /** Sent once they accept the connection. */
  firstMessage(name: string): string;
  /** The single nudge for a thread that went quiet. */
  followUp(name: string): string;
}

/**
 * `product` and `who` are arguments rather than constants so this file has no opinion about what
 * is being launched — the sentences are the reusable part, the pitch is not.
 */
export function voiceFor(
  phase: Phase,
  launch: Launch,
  product = "Mycel",
  who = "service businesses",
): Voice {
  const when = launch.at.toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" });
  const link = launch.url ? ` ${launch.url}` : "";

  switch (phase) {
    // Two or more days out. Say what it is and name the date. No ask yet — asking for a click on a
    // page that does not exist is how you spend the connection and get nothing.
    case "early":
      return {
        firstMessage: (n) =>
          `Thanks for connecting, ${first(n)}. I'm building ${product} — we run outbound delivery for ` +
          `${who}, so they can take on work without hiring. We're launching on Product Hunt on ${when}. ` +
          `I'll send you the link on the day if that's useful.`,
        followUp: (n) =>
          `${first(n)} — we go live on ${when}. No pressure either way, but if you've launched before ` +
          `you'll know what the first hour is worth, so I'd rather ask now than surprise you.`,
      };

    // The day before. Now the ask is concrete and near, which is the only time "tomorrow" works.
    case "eve":
      return {
        firstMessage: (n) =>
          `Thanks for connecting, ${first(n)}. We're launching ${product} on Product Hunt tomorrow — ` +
          `outbound delivery for ${who}. Would you take a look when it's live? I'll send the link.`,
        followUp: (n) => `${first(n)} — we're live tomorrow morning. I'll send the link then.`,
      };

    // Launch day. Short, and the link is the message.
    case "launch":
      return {
        firstMessage: (n) =>
          `${first(n)} — we're live on Product Hunt today.${link} ${product} runs outbound delivery ` +
          `for ${who}. If it's useful, a look would mean a lot today.`,
        followUp: (n) => `${first(n)} — we're live today, if you get a minute.${link}`,
      };

    // After. There is nothing to ask for; whatever is said here is about a day that has passed.
    case "over":
      return {
        firstMessage: (n) =>
          `Thanks for connecting, ${first(n)}. I'm building ${product} — outbound delivery for ` +
          `${who}. We launched on Product Hunt on ${when}; happy to share what we learned if it's useful.`,
        followUp: () => "",
      };
  }
}

/**
 * Should the rally still be sending at all?
 *
 * A launch rally is finite by construction. Left running it becomes ordinary cold outreach with a
 * stale reason attached, sent by four accounts that were borrowed for one week.
 */
export function stillWorth(phase: Phase): boolean {
  return phase !== "over";
}
