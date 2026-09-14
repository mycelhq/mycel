// See content-calendar.mjs for why the model does not pick the dates, and why nothing here publishes.

export interface PlannedPiece {
  /** The piece, in one line. Specific enough to write from. */
  what: string;
  /** Where it goes, in the founder's words: "LinkedIn", "r/bookkeeping", "your blog". */
  where: string;
  why: string;
  /** The thread it answers, when there is one. */
  answers_url?: string;
  effort?: "small" | "medium" | "large";
}

export interface ContentCalendarArgs {
  /** Ordered. The order is the model's judgement; the dates are not. */
  plan: PlannedPiece[];
  /** YYYY-MM-DD. Required — a pure workflow never reads a clock. */
  start: string;
  /** Pieces per week the founder can actually keep to. Default 2. */
  per_week?: number;
}

export interface ScheduledPiece extends PlannedPiece {
  /** YYYY-MM-DD, always a weekday. */
  when: string;
}

export interface ContentCalendar {
  scheduled: ScheduledPiece[];
  next: ScheduledPiece | null;
  through: string | null;
  channels: string[];
  headline: string;
}

export default function contentCalendar(args: ContentCalendarArgs): ContentCalendar;
