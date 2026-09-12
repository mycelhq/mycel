// See lookalike.mjs for why only proven patterns score, and why matches do not compound.

/** One row from `win_patterns.patterns`. `unproven` rows are deliberately not accepted. */
export interface ProvenPattern {
  attribute: string;
  value: string;
  n: number;
  wins: number;
  win_rate: string;
  engaged_rate?: string;
  /** Wilson lower bound. Ranked on this, never on the raw rate. */
  confidence_floor: number;
  lift: number | null;
}

export interface LookalikeCandidate {
  name: string;
  domain?: string;
  /** Attributes may sit on the object or under `attributes`. Absent is never a failure. */
  attributes?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface LookalikeArgs {
  /** `win_patterns.patterns` only. Passing `unproven` rows would launder the noise it quarantined. */
  patterns: ProvenPattern[];
  candidates: LookalikeCandidate[];
  /** Names or domains already in the book, so nobody is opened twice. */
  exclude?: string[];
  /** Default 25. */
  limit?: number;
}

export interface LookalikeMatch {
  name: string;
  domain?: string;
  score: number;
  matched: { attribute: string; value: string; win_rate: string; n: number; lift: number | null }[];
  why: string;
}

export interface LookalikeResult {
  ready: boolean;
  ranked: LookalikeMatch[];
  not_shown?: number;
  skipped?: { name: string; why: string }[];
  matched_on?: string[];
  headline?: string;
  why_not?: string;
}

export default function lookalike(args: LookalikeArgs): LookalikeResult;
