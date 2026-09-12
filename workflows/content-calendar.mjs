// What to post, where, and WHEN — the when computed rather than chosen.
//
// ═══ WHY THE MODEL DOES NOT PICK THE DATES ═══
//
// `plan_content` returns an ordered list of pieces with a channel and a reason. Asking the same run
// to also assign dates is asking a language model to do calendar arithmetic, which is the thing this
// codebase has decided it does not do: the same plan run twice would produce two different
// calendars, "next Tuesday" would be wrong half the time, and nothing could be checked.
//
// So the model chooses WHAT and WHERE. This chooses WHEN, from four rules a person would agree with
// before seeing the output.
//
// ═══ NOTHING HERE PUBLISHES ANYTHING ═══
//
// Deliberately, and it is not a limitation. Posting under a founder's own name is public and
// permanent, and `packages/linkedin` bans it from automation for that reason. What a founder
// actually needs is not a robot with their password — it is to stop opening a blank box on a Sunday
// night wondering what to write. A dated list of specific pieces, each tied to a real question
// somebody asked, is the whole of that.
//
// ═══ THE FOUR RULES ═══
//
//   1. WEEKDAYS ONLY. A post timestamped Sunday reads as a scheduling tool, which is the one thing
//      it must not read as.
//   2. NEVER TWICE TO ONE PLACE IN A DAY. Two posts to the same channel on the same day is the
//      pattern every community reads as flooding, and on Reddit it is how an account gets filtered.
//   3. SPACED BY THE CADENCE THE FOUNDER CAN ACTUALLY KEEP. Two a week is two a week. A calendar
//      that assumes five is a calendar abandoned in week two, and an abandoned calendar is worse
//      than none because it also carries the evidence that they abandoned it.
//   4. BIG PIECES GET ROOM. A `large` item is original work, not an afternoon. It takes the next
//      slot and the one after it, so the week it lands in does not also carry two other pieces.

/** Monday…Friday. `getUTCDay` is 0 = Sunday. */
const isWeekday = (d) => d.getUTCDay() >= 1 && d.getUTCDay() <= 5;

const DAY = 86_400_000;
const iso = (d) => d.toISOString().slice(0, 10);

/** How many slots a piece occupies. See rule 4. */
const weight = (effort) => (String(effort ?? "").toLowerCase() === "large" ? 2 : 1);

export default function contentCalendar(args) {
  const plan = Array.isArray(args?.plan) ? args.plan : [];
  if (!plan.length) throw new Error("plan must not be empty — there is nothing to schedule");

  /**
   * `start` is REQUIRED and is never read from a clock.
   *
   * The workflow is pure, like every other one here: the same plan and the same start date always
   * produce the same calendar, which is what lets a founder re-read Monday's list on Wednesday and
   * see the same thing. A workflow that read `new Date()` would quietly reschedule itself.
   */
  const start = new Date(`${String(args?.start ?? "").slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(start.getTime())) throw new Error("start is required (YYYY-MM-DD) — dates are never guessed");

  const perWeek = Math.max(1, Math.min(7, Math.floor(Number(args?.per_week ?? 2))));
  // Working days between posts, so two a week lands roughly Tuesday and Thursday rather than both on
  // Monday. Five slots in a working week divided by the cadence.
  const gap = Math.max(1, Math.floor(5 / perWeek));

  const scheduled = [];
  const lastOn = new Map(); // channel → the last date we put something there
  let cursor = new Date(start.getTime());
  let carry = 0; // slots owed by a `large` piece that took two

  const advance = (days) => {
    for (let i = 0; i < Math.max(1, days); i++) {
      cursor = new Date(cursor.getTime() + DAY);
      while (!isWeekday(cursor)) cursor = new Date(cursor.getTime() + DAY);
    }
  };

  while (!isWeekday(cursor)) cursor = new Date(cursor.getTime() + DAY);

  for (const item of plan) {
    const where = String(item?.where ?? "").trim() || "your blog";
    // Rule 2: if this channel already has something today, move on a day before placing it.
    if (lastOn.get(where.toLowerCase()) === iso(cursor)) advance(1);

    scheduled.push({
      when: iso(cursor),
      where,
      what: String(item?.what ?? "").trim(),
      why: String(item?.why ?? "").trim(),
      ...(item?.answers_url ? { answers_url: String(item.answers_url) } : {}),
      ...(item?.effort ? { effort: String(item.effort) } : {}),
    });
    lastOn.set(where.toLowerCase(), iso(cursor));
    carry = weight(item?.effort) - 1;
    advance(gap + carry * gap);
  }

  const channels = [...new Set(scheduled.map((s) => s.where))];
  return {
    scheduled,
    /** What a founder reads first: the next thing to do, and when. */
    next: scheduled[0] ?? null,
    through: scheduled.length ? scheduled[scheduled.length - 1].when : null,
    channels,
    /**
     * The sentence, so nothing downstream has to assemble one and get the count wrong. Written the
     * way a person would say it — never "N items across M channels".
     */
    headline:
      scheduled.length === 1
        ? `One piece to post, on ${scheduled[0].when}.`
        : `${scheduled.length} pieces between ${scheduled[0].when} and ${scheduled[scheduled.length - 1].when}, ${perWeek} a week — ${channels.join(", ")}.`,
  };
}
