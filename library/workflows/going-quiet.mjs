// A founder who reached value and then stopped — measured against their OWN rhythm, not a threshold.
//
// ═══ WHY A FIXED NUMBER OF DAYS IS THE WRONG SIGNAL ═══
//
// "No activity in 14 days" is the obvious rule and it would cry wolf at the healthiest customer on
// the platform. A bookkeeper runs a monthly close: twenty-eight quiet days is their normal, and a
// product that nags them on day fifteen has told them it does not understand what they do. Meanwhile
// a GTM operator who ran something every second day and has not in nine is genuinely drifting, and
// the same rule says nothing.
//
// So the question is not "how long has it been" but "how long has it been COMPARED TO THEM". That is
// arithmetic over their own history, it needs no threshold anybody has to defend, and it gets more
// accurate the longer somebody has been here rather than less.
//
// ═══ WHAT THIS IS NOT ═══
//
// It is not activation. `lib/time-to-value.ts` in the console owns the founder who signed up and
// never got to a first accepted deliverable, and that is a different problem with a different fix —
// they need help starting, not reminding. Reporting both about the same person is how a dashboard
// becomes noise, so this REFUSES to speak until there is a rhythm to compare against, which by
// construction means somebody who was using the product.
//
// ═══ AND IT IS NOT A NAG ═══
//
// The output names the specific thing that stalled, or it says nothing. "We miss you" is the message
// that teaches a founder to filter the sender. "Four deliverables have been waiting for your
// sign-off since the 14th" is a message they act on, and it is also the honest one: most of the time
// a founder goes quiet because the product is holding something and did not say so loudly enough.
//
// Founder code. Pure: no I/O, no clock, no randomness.

const DAY = 86_400_000;

/** Median, because a mean is dragged by one holiday and this is a rhythm rather than an average. */
function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return null;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * The fewest events that can establish a rhythm.
 *
 * Four events give three gaps, which is the least that can have a median worth the name. Three
 * events give two gaps and a "median" that is just their mean — and a founder told they have gone
 * quiet on the strength of two intervals will be told it wrongly, once, and never read the next one.
 */
const MIN_EVENTS = 4;

export default function goingQuiet(args) {
  const now = Date.parse(`${String(args?.now ?? "").slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(now)) throw new Error("now is required (YYYY-MM-DD) — a rhythm is measured against a date, never a guess");

  const at = (Array.isArray(args?.events) ? args.events : [])
    .map((e) => Date.parse(typeof e === "string" ? e : String(e?.at ?? "")))
    .filter((t) => Number.isFinite(t) && t <= now)
    .sort((a, b) => a - b);

  if (at.length < MIN_EVENTS) {
    return {
      quiet: false,
      ready: false,
      why_not:
        at.length === 0
          ? "This business has not done anything yet, which is a question about getting started rather than about going quiet."
          : `Only ${at.length} things have happened here, so there is no rhythm to compare against yet.`,
    };
  }

  const gaps = [];
  for (let i = 1; i < at.length; i++) gaps.push((at[i] - at[i - 1]) / DAY);
  const usual = median(gaps);
  const since = (now - at[at.length - 1]) / DAY;

  /**
   * THREE TIMES THEIR OWN GAP, and a floor of a week.
   *
   * The multiple rather than a number, so a monthly business is judged monthly. The floor because at
   * a daily rhythm three times is three days, and three days is a long weekend — telling somebody
   * they have gone quiet on the Tuesday after a bank holiday is how this feature gets muted.
   */
  const floor = Math.max(7, usual * 3);
  const quiet = since > floor;

  /**
   * WHAT IS ACTUALLY WAITING, because that is the difference between a nag and a reason.
   *
   * Most of the time a founder goes quiet because the product is holding something — an approval
   * nobody cleared, a deliverable nobody released — and did not say so loudly enough. Naming it
   * turns "you have not been here" into "this is what stopped", which is a sentence with an action
   * in it and also usually the truth.
   */
  const waiting = (Array.isArray(args?.waiting) ? args.waiting : [])
    .map((w) => ({ what: String(w?.what ?? "").trim(), since: String(w?.since ?? "").slice(0, 10), count: Number(w?.count) || 1 }))
    .filter((w) => w.what)
    .sort((a, b) => a.since.localeCompare(b.since));

  const days = Math.floor(since);
  const rhythm = usual < 1.5 ? "most days" : usual < 9 ? `about every ${Math.round(usual)} days` : `about every ${Math.round(usual / 7)} weeks`;

  return {
    ready: true,
    quiet,
    days_since: days,
    usual_gap_days: Number(usual.toFixed(1)),
    waiting,
    /**
     * One sentence, and it leads with what is stuck rather than with the silence. A founder reading
     * about their own inactivity has been told off; a founder reading about four unsigned
     * deliverables has been told something useful that happens to explain the inactivity.
     */
    headline: !quiet
      ? `Nothing unusual — this business runs ${rhythm}, and it has been ${days} day${days === 1 ? "" : "s"}.`
      : waiting.length
        ? `${waiting[0].count} ${waiting[0].what} ${waiting[0].count === 1 ? "has" : "have"} been waiting since ${waiting[0].since}. This business normally does something ${rhythm}, and it has been ${days} days.`
        : `Nothing has happened here for ${days} days. This business normally does something ${rhythm}, so that is a change rather than a quiet week.`,
  };
}
