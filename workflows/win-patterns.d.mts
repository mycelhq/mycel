// Types for the win-pattern read. See `close-figures.d.mts` on why workflows stay plain `.mjs` and
// get a declaration file instead: they are founder code, and a build step between a founder and
// their own rule ends with the rule not being edited.

export interface WinPatternsArgs {
  leads: Array<{
    /** A stage from gtm/stages.ts. `won` is the only outcome that counts as a win. */
    stage?: string;
    /** Anything the lead carries. Split on whatever is here — a fixed key list only ever fits one trade. */
    attributes?: Record<string, unknown>;
    replied_at_step?: number | string;
  }>;
  /** Pipeline size below which nothing is reported at all. Default 30. */
  min_total?: number;
  /** Segment size below which a split is listed as unproven rather than as a pattern. Default 8. */
  min_sample?: number;
}

export interface WinPattern {
  attribute: string;
  value: string;
  n: number;
  wins: number;
  win_rate: string;
  engaged_rate: string;
  /** Wilson lower bound. What everything is RANKED on — a plain rate puts 4-of-4 above 90-of-100. */
  confidence_floor: number;
  /** Against the base rate, never against the worst segment tried. */
  lift: number | null;
  /** Present only on `unproven`: why this one cannot be read yet. */
  why?: string;
}

export interface WinPatternsResult {
  /** False means not enough evidence. `why_not` says what would change that. */
  ready: boolean;
  total: number;
  wins: number;
  engaged: number;
  why_not?: string;
  base: { win_rate: string; engaged_rate: string };
  patterns: WinPattern[];
  /** Segments that exist and cannot yet be judged. Open questions, not absences. */
  unproven: WinPattern[];
  headline?: string;
}

export default function winPatterns(args: WinPatternsArgs): WinPatternsResult;
