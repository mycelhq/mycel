// See going-quiet.mjs for why this compares against the business's own rhythm rather than a
// threshold, and why it refuses until there is a rhythm to compare against.

export interface QuietArgs {
  /** ISO timestamps, or `{ at }`. Things the FOUNDER did — runs finished, approvals resolved. */
  events: (string | { at: string })[];
  /** YYYY-MM-DD. Required; a rhythm is measured against a date and never against a clock. */
  now: string;
  /** What the product is currently holding, so the message can name it instead of nagging. */
  waiting?: { what: string; since: string; count?: number }[];
}

export interface QuietResult {
  ready: boolean;
  quiet: boolean;
  /** Absent when `ready` is false. */
  days_since?: number;
  usual_gap_days?: number;
  waiting?: { what: string; since: string; count: number }[];
  headline?: string;
  /** Why no answer is possible yet — pass it on rather than inventing one. */
  why_not?: string;
}

export default function goingQuiet(args: QuietArgs): QuietResult;
