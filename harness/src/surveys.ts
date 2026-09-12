/**
 * In-product questionnaires.
 *
 * Super-admins need to know how the product actually feels, and a founder will not open a form
 * buried in Settings to tell us. These prompts appear after named moments — going live, the first
 * client, the first chase, using the clock, cancelling — one at a time, with a cooldown so the
 * product does not become a survey. Answers live on the member (see `IdentityStore.recordSurvey`);
 * this file is the catalogue and the eligibility rules, so every caller asks the same question
 * the same way.
 *
 * Feature names are what the founder reads. They are the names of rooms they already know
 * (Pipeline, Deliverables, Invoices), never internals.
 *
 * Day-one / week-one calendar drips are forbidden. A ghost-town Home that has not yet gone live,
 * added a client, or chased anyone must not be interrupted by "How was your first day?"
 */

export const SURVEY_COOLDOWN_MS = 36 * 60 * 60 * 1000;

export type SurveyNeed = "went_live" | "first_client" | "first_chase" | "clock_used" | "cancelled";

export interface SurveyPrompt {
  id: string;
  /** Short name of the thing we are asking about. Rendered as the card heading. */
  feature: string;
  question: string;
  hint: string;
  /** Hours after the member was created before this may appear — a debounce, never the trigger. */
  after_hours: number;
  /** The event that must have fired. Absent only for churn, which jumps the queue. */
  need?: SurveyNeed;
  /** Higher jumps the queue. Churn is the only one that should. */
  priority: number;
}

/**
 * The set we actually ask. `nextSurvey` re-sorts by priority so cancelling never waits behind
 * "how is getting paid going".
 *
 * Every timed prompt is gated on an event. Adding a calendar-only prompt is how we asked people
 * who had not yet done anything how the product felt — and they told us, by staring at it.
 */
export const SURVEY_PROMPTS: readonly SurveyPrompt[] = [
  {
    id: "clock",
    feature: "The clock",
    question: "How does putting work on the clock feel?",
    hint: "Once the business is live, jobs run without you starting each one.",
    after_hours: 1,
    need: "went_live",
    priority: 20,
  },
  {
    id: "first_client",
    feature: "Clients",
    question: "How was adding the first client?",
    hint: "Finding the room, naming them, inviting them in. The part that should have been obvious.",
    after_hours: 1,
    need: "first_client",
    priority: 30,
  },
  {
    id: "pipeline",
    feature: "Pipeline",
    question: "How is finding clients going?",
    hint: "People in the pipeline, replies, anything that should have happened and did not.",
    after_hours: 1,
    need: "first_chase",
    priority: 40,
  },
  {
    id: "paid",
    feature: "Getting paid",
    question: "How is getting paid going?",
    hint: "Invoices, reminders, money landing. The part that has to close.",
    after_hours: 1,
    need: "first_chase",
    priority: 35,
  },
  {
    id: "churn",
    feature: "Leaving",
    question: "What made you cancel?",
    hint: "The honest reason. We read every one of these.",
    after_hours: 0,
    need: "cancelled",
    priority: 100,
  },
];

export const SURVEY_IDS = new Set(SURVEY_PROMPTS.map((p) => p.id));

export interface SurveyAnswer {
  at: string;
  score?: number;
  skip?: boolean;
  comment?: string;
}

export interface SurveyLog {
  answers: Record<string, SurveyAnswer>;
  last_at?: string;
}

export interface SurveySignals {
  went_live?: boolean;
  first_client?: boolean;
  first_chase?: boolean;
  clock_used?: boolean;
  cancelled?: boolean;
}

export function promptById(id: string): SurveyPrompt | undefined {
  return SURVEY_PROMPTS.find((p) => p.id === id);
}

export function emptySurveyLog(): SurveyLog {
  return { answers: {} };
}

export function asSurveyLog(raw: unknown): SurveyLog {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return emptySurveyLog();
  const o = raw as { answers?: unknown; last_at?: unknown };
  const answers: Record<string, SurveyAnswer> = {};
  if (o.answers && typeof o.answers === "object" && !Array.isArray(o.answers)) {
    for (const [id, v] of Object.entries(o.answers as Record<string, unknown>)) {
      if (!SURVEY_IDS.has(id) || !v || typeof v !== "object") continue;
      const a = v as SurveyAnswer;
      if (typeof a.at !== "string") continue;
      answers[id] = {
        at: a.at,
        score: typeof a.score === "number" ? a.score : undefined,
        skip: a.skip === true,
        comment: typeof a.comment === "string" ? a.comment : undefined,
      };
    }
  }
  return {
    answers,
    last_at: typeof o.last_at === "string" ? o.last_at : undefined,
  };
}

function needMet(need: SurveyNeed | undefined, signals: SurveySignals): boolean {
  if (!need) return false;
  if (need === "went_live") return !!signals.went_live;
  if (need === "first_client") return !!signals.first_client;
  if (need === "first_chase") return !!signals.first_chase;
  if (need === "clock_used") return !!signals.clock_used;
  if (need === "cancelled") return !!signals.cancelled;
  return false;
}

/**
 * The one outstanding prompt, or none.
 *
 * One at a time. Cooldown applies to everything except churn: cancelling is the moment we
 * will not get another chance, so it jumps the queue even if we asked something yesterday.
 *
 * Nothing is eligible on time alone. A prompt without a fired event does not appear.
 */
export function nextSurvey(
  createdAt: string,
  log: SurveyLog,
  signals: SurveySignals,
  now = Date.now(),
): SurveyPrompt | undefined {
  const ageHours = Math.max(0, (now - Date.parse(createdAt)) / 3_600_000);
  const sinceLast = log.last_at ? now - Date.parse(log.last_at) : Number.POSITIVE_INFINITY;
  const cooling = Number.isFinite(sinceLast) && sinceLast < SURVEY_COOLDOWN_MS;

  const eligible = SURVEY_PROMPTS.filter((p) => {
    if (log.answers[p.id]) return false;
    if (ageHours < p.after_hours) return false;
    if (p.need === "cancelled") return !!signals.cancelled;
    if (!needMet(p.need, signals)) return false;
    if (cooling) return false;
    return true;
  });

  eligible.sort((a, b) => b.priority - a.priority);
  return eligible[0];
}

export function publicPrompt(p: SurveyPrompt) {
  return {
    id: p.id,
    feature: p.feature,
    question: p.question,
    hint: p.hint,
    kind: p.need === "cancelled" ? ("churn" as const) : ("score" as const),
  };
}
