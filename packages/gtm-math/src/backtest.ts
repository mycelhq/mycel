// Did this signal source predict your wins, or is it reading your pipeline back to you?
//
// ═══ THE QUESTION NOBODY ASKS BEFORE PAYING ═══
//
// Every intent vendor demos the same way: here are accounts showing intent, look how many became
// customers. That chart is not evidence. It is survivorship with a price tag, because the accounts
// that became customers were doing things that LOOK like intent — visiting the site, reading the
// comparison page — and a source that fires once a deal is already moving has measured your pipeline
// rather than predicted it.
//
// The test that settles it is one an operator can run before signing anything: take the accounts you
// actually won last quarter, and check whether the source flagged them BEFORE they bought or only
// after. That is a backtest, it is arithmetic, and it costs nothing.
//
// ═══ WHAT IT MEASURES, AND WHY EACH ONE ALONE MISLEADS ═══
//
//   PRECISION  of the accounts it flagged, how many won.        Alone: a source that flags one
//                                                               account a year and gets it right is
//                                                               100% precise and useless.
//   COVERAGE   of the accounts that won, how many it flagged.   Alone: a source that flags everybody
//                                                               covers everything and says nothing.
//   LEAD TIME  how far ahead of the win it fired.               THE ONE THAT DECIDES IT. Negative
//                                                               lead time is a source describing
//                                                               your own pipeline back to you.
//   LIFT       win rate flagged vs unflagged.                   Alone: meaningless without the base.
//
// A source can look excellent on the first two and be worthless on the third, and that is the exact
// failure this is built to expose — because it is the one the vendor's chart is designed to hide.
//
// Pure: no I/O, no clock, no randomness. Lives in @mycel/gtm-math because BOTH sides of this repo
// need it — the kernel runs go-to-market for a customer's agency, `growth/` runs it for us selling
// Mycel, and `growth/lib/db.ts` says plainly that it is "deliberately independent of the kernel".
// One implementation, two callers, no drift.

/** One decimal, or an em dash when there is nothing to divide by. Mirrors `_figures.mjs`. */
const pct = (part: number, whole: number, dp = 1): string =>
  !whole ? "\u2014" : `${((part / whole) * 100).toFixed(dp)}%`;

export interface BacktestAccount {
  name?: string;
  company?: string;
  won?: boolean;
  stage?: string;
  won_at?: string;
  closed_at?: string;
  /** When the buying conversation started. A better anchor than the close — see `anchor` below. */
  engaged_at?: string;
  first_reply_at?: string;
  signals?: Array<{ source?: string; type?: string; observed_at?: string }>;
}

export interface BacktestArgs {
  accounts: BacktestAccount[];
  min_accounts?: number;
  min_wins?: number;
}

export type BacktestVerdict =
  | "worth paying for"
  | "late but real"
  | "no better than not having it"
  | "reads your pipeline back to you"
  | "not enough";

export interface BacktestSource {
  source: string;
  flagged: number;
  flagged_wins: number;
  precision: string;
  coverage: string;
  /** Against accounts it did NOT flag — the only comparison that means anything. */
  lift: number | null;
  /** THE figure that decides the verdict. Negative means it watched rather than predicted. */
  median_lead_days: number | undefined;
  after_the_fact: number;
  verdict: BacktestVerdict;
  why: string;
}

export interface BacktestResult {
  ready: boolean;
  total: number;
  wins: number;
  why_not?: string;
  base_win_rate?: string;
  sources: BacktestSource[];
  /** A decision, never a table. */
  headline?: string;
}

const norm = (v: unknown): string => String(v ?? "").trim().toLowerCase();

const days = (a?: string, b?: string): number | undefined => {
  const x = Date.parse(a ?? "");
  const y = Date.parse(b ?? "");
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  return Math.round((y - x) / 86_400_000);
};

/** The middle value. Used rather than a mean because one ancient signal drags an average off. */
function median(xs: number[]): number | undefined {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

export function signalBacktest(args: BacktestArgs): BacktestResult {
  const accounts = Array.isArray(args.accounts) ? args.accounts : [];
  if (!accounts.length) throw new Error("accounts is required and must not be empty");

  /**
   * Thirty accounts and five wins. Deliberately arguable, with the argument written down: below
   * this, precision is a coin and a founder acting on it is buying a data source on noise. Both are
   * overridable, and the default is the cautious one because the cost of a low floor is a confident
   * recommendation to spend money.
   */
  const minAccounts = Number(args.min_accounts ?? 30);
  const minWins = Number(args.min_wins ?? 5);

  const rows = accounts.map((a) => ({
    name: a.name ?? a.company ?? "(unnamed)",
    won: a.won === true || norm(a.stage) === "won",
    /** When the deal actually closed — the thing a signal has to have preceded to be predictive. */
    won_at: a.won_at ?? a.closed_at,
    /** When the buying conversation started, if known. A better anchor than the close when present:
     *  a source firing after the first meeting has predicted nothing, even if the close is months later. */
    engaged_at: a.engaged_at ?? a.first_reply_at,
    signals: Array.isArray(a.signals) ? a.signals : [],
  }));

  const total = rows.length;
  const wins = rows.filter((r) => r.won).length;
  const baseWinRate = total ? wins / total : 0;

  if (total < minAccounts || wins < minWins) {
    return {
      ready: false,
      total,
      wins,
      why_not:
        wins < minWins
          ? `${wins} closed ${wins === 1 ? "win" : "wins"} on file and this needs at least ${minWins}. A backtest on fewer is a coin flip with a chart on it.`
          : `${total} accounts and this needs at least ${minAccounts}. Run the sources a while longer before deciding what to pay for.`,
      sources: [],
    };
  }

  // Every source that appears anywhere. Discovered, so a feed nobody anticipated is still graded.
  const names = [...new Set(rows.flatMap((r) => r.signals.map((s) => norm(s.source || s.type))))].filter(Boolean);

  const sources: BacktestSource[] = [];
  for (const source of names) {
    let flagged = 0;
    let flaggedWins = 0;
    const leadTimes: number[] = [];
    let afterTheFact = 0;

    for (const r of rows) {
      const hits = r.signals.filter((s) => norm(s.source || s.type) === source);
      if (!hits.length) continue;
      flagged += 1;
      if (!r.won) continue;
      flaggedWins += 1;

      /**
       * Measured against the EARLIEST anchor available — the first reply if we have it, otherwise
       * the close. Using the close alone flatters every source: a signal that fired the week after
       * the first meeting still looks like it predicted a deal that closed three months later.
       */
      const anchor = r.engaged_at ?? r.won_at;
      const earliest = hits
        .map((s) => days(s.observed_at, anchor))
        .filter((d) => d !== undefined)
        .sort((a, b) => b - a)[0];
      if (earliest === undefined) continue;
      leadTimes.push(earliest);
      if (earliest < 0) afterTheFact += 1;
    }

    const unflagged = total - flagged;
    const unflaggedWins = wins - flaggedWins;
    const flaggedRate = flagged ? flaggedWins / flagged : 0;
    const unflaggedRate = unflagged ? unflaggedWins / unflagged : 0;
    const med = median(leadTimes);

    /**
     * The verdict, and it leads on lead time rather than on precision.
     *
     * A source whose median signal arrives AFTER the buying conversation started has not predicted
     * anything. It has watched. The vendor chart will still show a high correlation with won deals,
     * because the accounts that were already buying are the ones generating the behaviour — and that
     * is precisely the confusion this line exists to break.
     */
    let verdict: BacktestVerdict;
    let why: string;
    if (flagged < 5) {
      verdict = "not enough";
      why = `only flagged ${flagged} of your ${total} accounts — too few to judge either way`;
    } else if (unflagged === 0) {
      /**
       * IT FLAGGED EVERYTHING, so there is no comparison group and no claim to test.
       *
       * The header called this out — "a source that flags everybody covers everything and says
       * nothing" — and the first version still passed it, because `flaggedRate <= unflaggedRate`
       * compares against an unflagged rate of zero and every source beats that. A test caught it,
       * which is the whole reason this file has one for each failure shape rather than one happy
       * path.
       */
      verdict = "no better than not having it";
      why = `it flagged all ${total} of your accounts, so there is nothing to compare it against — a source that fires on everybody separates nothing`;
    } else if (med !== undefined && med <= 0) {
      verdict = "reads your pipeline back to you";
      why = `its signals arrive a median of ${Math.abs(med)} days AFTER the conversation had already started, so it is describing deals in motion rather than finding them`;
    } else if (flaggedRate <= unflaggedRate) {
      verdict = "no better than not having it";
      why = `accounts it flagged won ${pct(flaggedWins, flagged)} against ${pct(unflaggedWins, unflagged)} for everyone else`;
    } else if (med !== undefined && med < 7) {
      verdict = "late but real";
      why = `it works, and a median of ${med} days' warning is barely enough to act on — treat it as a tiebreaker, not a trigger`;
    } else {
      verdict = "worth paying for";
      why = `flagged accounts won ${pct(flaggedWins, flagged)} against ${pct(unflaggedWins, unflagged)}, a median of ${med} days before the conversation started`;
    }

    sources.push({
      source,
      flagged,
      flagged_wins: flaggedWins,
      /** Of what it flagged, how many won. */
      precision: pct(flaggedWins, flagged),
      /** Of everything that won, how many it caught. */
      coverage: pct(flaggedWins, wins),
      /** Against accounts it did NOT flag — the only comparison that means anything. */
      lift: unflaggedRate ? Number((flaggedRate / unflaggedRate).toFixed(2)) : null,
      median_lead_days: med,
      /** Wins where every signal from this source landed after the conversation had started. */
      after_the_fact: afterTheFact,
      verdict,
      why,
    });
  }

  /** Ordered by usefulness, which is lead time first and rate second. */
  const rank: Record<BacktestVerdict, number> = { "worth paying for": 0, "late but real": 1, "no better than not having it": 2, "reads your pipeline back to you": 3, "not enough": 4 };
  sources.sort((a, b) => rank[a.verdict] - rank[b.verdict] || (b.median_lead_days ?? -999) - (a.median_lead_days ?? -999));

  const best = sources.find((s) => s.verdict === "worth paying for");
  const worst = sources.filter((s) => s.verdict === "reads your pipeline back to you");

  return {
    ready: true,
    total,
    wins,
    base_win_rate: pct(wins, total),
    sources,
    /**
     * One sentence that either names something to keep or names something to cancel. A backtest that
     * ends in a table and no recommendation gets read once.
     */
    headline: best
      ? `${best.source} is the one worth paying for: ${best.precision} of what it flagged won, a median of ${best.median_lead_days} days before the conversation started.`
      : worst.length
        ? `Nothing here predicted a win. ${worst.map((s) => s.source).join(" and ")} fired only after deals were already moving — that is your own pipeline being sold back to you.`
        : "No source cleared the bar. Keep the cheapest one and spend the difference on the message.",
  };
}
