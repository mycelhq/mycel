// Types for the signal read. See the header in `signal-score.mjs` on why the decay windows are per
// type and why a stale signal is refused rather than ranked low.

export interface SignalSpec {
  label: string;
  /** Observed on the founder's own property. Close to the buyer and close to now. */
  first_party: boolean;
  weight: number;
  half_life_days: number;
  /** Past this, acting on it costs more than it earns. */
  dead_after_days: number;
  implies: string;
  /** What to ask once they reply — the signal tells you what qualification they already did. */
  qualify_on: string;
  say?: string;
}

export declare const SIGNALS: Record<string, SignalSpec>;

export interface ObservedSignal {
  type: string;
  /** ISO date. Freshness is the whole point and cannot be guessed. */
  observed_at?: string;
  company?: { name?: string; domain?: string; industry?: string; location?: string; country?: string; headcount?: number };
  detail?: string;
}

export interface SignalScoreArgs {
  signals: ObservedSignal[];
  /** ISO date, passed in rather than read from a clock — the workflow is pure. Required. */
  now: string;
  icp?: { industries?: string[]; locations?: string[]; min_headcount?: number; max_headcount?: number };
}

export interface ScoredAccount {
  company: NonNullable<ObservedSignal["company"]>;
  score: number;
  signals: Array<SignalSpec & { type: string; age_days: number; score: number; detail?: string }>;
  /** More than one signal on one account: one prospect at peak readiness, not two rows. */
  stacked: boolean;
  /** What the opener must name. The signal targets; the message converts. */
  lead_with: string;
  qualify_on?: string;
  /** Days until this becomes a message nobody should send. */
  act_by_days: number;
}

export interface SignalScoreResult {
  act: ScoredAccount[];
  /** The window closed. Shown so a founder can see the feed works and the timing did not. */
  stale: Array<{ type: string; company?: string; age_days: number; window_days: number; why: string }>;
  /** Real signals at companies this business does not sell to — the filter working. */
  unqualified: Array<{ type: string; company?: string; why: string }>;
  unknown: Array<{ type: string; company?: string; why: string }>;
  counts: { act: number; stale: number; unqualified: number; unknown: number };
  headline: string;
}

export default function signalScore(args: SignalScoreArgs): SignalScoreResult;
