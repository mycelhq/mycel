// Types for the signal backtest. See the header in `signal-backtest.mjs` on why lead time decides
// the verdict and precision does not.

export interface BacktestAccount {
  name?: string;
  company?: string;
  won?: boolean;
  stage?: string;
  won_at?: string;
  closed_at?: string;
  /** When the buying conversation started. A better anchor than the close — using the close alone
   *  flatters every source. */
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

export default function signalBacktest(args: BacktestArgs): BacktestResult;
