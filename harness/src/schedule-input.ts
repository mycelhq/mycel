// THE FIELDS A SCHEDULE CANNOT KNOW WHEN IT IS WRITTEN, AND THE CLOCK CAN WHEN IT FIRES.
//
// ═══ THE ONE THAT COST 3,077 RUNS ═══
//
// `books-keeper/monthly_close` declares `period` REQUIRED, and its own description says why, in
// words written before this module existed:
//
//   "REQUIRED — a close with no period is a close of nothing, and production runs have failed
//    asking for exactly this after spending a sandbox to discover it."
//
// The blueprint schedules it with `input: {}`. So every scheduled close was a close of nothing:
// 3,077 runs across two engagements in a fortnight, one every 31 minutes, each asking for a period
// and a statement it was never given. The contract was declared, documented, and read by nothing on
// the path that fires almost every run — `inputFaults` was wired to `POST /v1/tasks` and
// `fireSchedule` calls `store.createTask` directly.
//
// ═══ WHY A TOKEN AND NOT A SPECIAL CASE IN THE SCHEDULER ═══
//
// The scheduler could compute a period for a close. It must not: "a monthly close covers the month
// that just ended" is knowledge belonging to bookkeeping, and putting it in `scheduler.ts` puts one
// trade's rule in the file that fires every trade's work. The next wedge needing a week ending, or
// a quarter, would each add a branch until the scheduler knew every trade.
//
// So the manifest asks and this answers. A blueprint writes `"period": "{{month_ended}}"` and the
// clock fills it — which is the same shape as `scheduled_at`, already injected into every scheduled
// task's input by the same function.
//
// ═══ A CLOSED VOCABULARY, DELIBERATELY ═══
//
// Five tokens, listed in code. Not an expression language, not a date format string, and not
// anything a manifest can extend. An unknown token is left ALONE rather than blanked, so a typo
// surfaces as a schema violation naming the field — `$.period: required` beats a close of the
// literal string `{{munth_ended}}`, and it beats a silent empty string more.
//
// Everything here is pure and takes `now`. The tests are a table.

/** UTC throughout, like every other date in the scheduler. A firm's month does not end on its own clock. */
function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * The tokens a schedule template may use, and what each resolves to at fire time.
 *
 * ── WHY `month_ended` AND NOT `this_month` FOR A CLOSE ──
 *
 * A close fires on the 1st (or the 3rd, or whenever the founder set it) and covers the month BEFORE
 * it. Resolving to the current month would close a month still in progress, produce figures that
 * change the next day, and hand a client a document that contradicts itself a week later. Both are
 * offered because a content calendar genuinely wants the month it is in; naming them differently is
 * what stops the wrong one being picked by accident.
 */
export const SCHEDULE_TOKENS = {
  /** "2026-08" when fired any time in September. The period a monthly close covers. */
  month_ended: (now: Date) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
  },
  /** "2026-09" — the month the run is IN. For work about the period underway, never for a close. */
  this_month: (now: Date) => `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}`,
  /**
   * The Sunday on or before yesterday, as YYYY-MM-DD — the last COMPLETE week.
   *
   * A weekly job that fires on Monday reports the week that finished; one that fires on Wednesday
   * still reports that same finished week, because a half-week is not a reporting period and a
   * client comparing two reports must be comparing two weeks.
   */
  week_ended: (now: Date) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    // 0 = Sunday. Step back at least one day so a Sunday run reports the week before, not itself.
    d.setUTCDate(d.getUTCDate() - 1);
    d.setUTCDate(d.getUTCDate() - d.getUTCDay());
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  },
  /** "2026-09-09". The day the run fires. */
  today: (now: Date) => `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`,
  /** "2026-Q2" when fired in Q3. For anything filed quarterly. */
  quarter_ended: (now: Date) => {
    const q = Math.floor(now.getUTCMonth() / 3);
    return q === 0 ? `${now.getUTCFullYear() - 1}-Q4` : `${now.getUTCFullYear()}-Q${q}`;
  },
} as const;

export type ScheduleToken = keyof typeof SCHEDULE_TOKENS;

/** `{{month_ended}}` → `month_ended`. Whitespace tolerated; nothing else is. */
const TOKEN = /^\{\{\s*([a-z_]+)\s*\}\}$/;

/**
 * Fill a schedule's input template from the clock.
 *
 * WHOLE-VALUE ONLY, and that is the interesting constraint. `"{{month_ended}}"` resolves;
 * `"the {{month_ended}} close"` does not, and is returned untouched. Interpolating into a sentence
 * is how a token expander becomes a template language, and a template language in a manifest is a
 * thing somebody eventually puts a conditional in. Every field this exists for is a bare value.
 *
 * Recurses one level into nested objects, because a manifest may group fields, and leaves arrays
 * alone — an array of tokens has no use case and inventing one now would be the second step of the
 * same mistake.
 */
export function fillScheduleInput(
  input: Record<string, unknown> | undefined,
  now: Date,
  depth = 0,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input ?? {})) {
    if (typeof v === "string") {
      const m = TOKEN.exec(v.trim());
      const fn = m ? SCHEDULE_TOKENS[m[1] as ScheduleToken] : undefined;
      // An unknown token is left ALONE. See the note at the top: a violation naming the field is a
      // better failure than a close of the literal string, and much better than a silent blank.
      out[k] = fn ? fn(now) : v;
      continue;
    }
    if (v && typeof v === "object" && !Array.isArray(v) && depth < 1) {
      out[k] = fillScheduleInput(v as Record<string, unknown>, now, depth + 1);
      continue;
    }
    out[k] = v;
  }
  return out;
}
