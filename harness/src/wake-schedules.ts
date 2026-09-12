// The work that was waiting for an account, woken the moment the account arrives.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// THE WEEK A FOUNDER SPENDS WAITING FOR NOTHING
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// Onboarding tells a founder to connect LinkedIn before anything can go out. They connect it, and
// the connect route writes a row and returns — it starts nothing, which is right: a route that
// kicked off outreach would be doing the scheduler's job with none of its pacing.
//
// The autonomous GTM loop is supposed to pick it up. It resolves the account at tick time and,
// finding none, returns `idle("no LinkedIn account to run outreach on")` WITHOUT consuming the
// cadence window — `autonomous.ts` is careful about that, and its comment says why: the marker is
// written after the proposal it protects, never before.
//
// But the SCHEDULE is consumed even though the window is not. The tick claims due schedules by
// advancing `next_run_at` inside the same transaction, which is what stops N replicas firing one
// schedule N times. So an idle run still moves the schedule on by a full cadence — and
// `DEFAULT_AUDIENCE_CADENCE` is SEVEN DAYS.
//
// The sequence, entirely by design and entirely wrong:
//
//   Monday 09:00  the loop ticks, finds no LinkedIn, goes idle. next_run_at → next Monday.
//   Monday 10:00  the founder connects LinkedIn.
//   ...           nothing. For a week.
//
// Nothing is broken. Nothing logs an error. The founder did exactly what they were asked and watched
// a product do nothing for seven days, which is the point at which they stop opening it.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// WHY THIS MOVES A CLOCK RATHER THAN STARTING A RUN
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// The tempting fix is for the connect route to kick off the loop directly. That would put a second
// execution path next to the scheduler's — one without the claim, the idempotency bucket, the
// pacing, or the "one proposal per window" guarantee. Two ways to start outreach is how a founder
// gets two campaigns for one audience.
//
// So this only says GO AND LOOK NOW. `next_run_at` moves to the present; the ordinary sweep claims
// it on its next pass, exactly as if it had come due, and every ceiling downstream is unchanged.
import type { Schedule } from "./contract";
import type { DomainStore } from "./domain";
import { AUTONOMOUS_GTM_TASK_TYPE } from "./gtm/autonomous";
import { ADVANCE_TASK_TYPE } from "./gtm/sequence";

/**
 * The jobs that stand idle without an account to run on.
 *
 * A closed list rather than "every schedule in the project". Waking a monthly close because somebody
 * connected LinkedIn would run a bookkeeping job a fortnight early against a ledger that has not
 * been updated — the founder asked for one thing to start and got an unrelated deliverable.
 */
export const WOKEN_BY_CONNECTION: Record<string, readonly string[]> = {
  /**
   * Discovery and proposal, and the five-minute sequence tick that carries the steps.
   *
   * IMPORTED, NOT TYPED OUT. The first draft wrote `"autonomous_gtm"`; the constant is
   * `gtm_autonomous`. That string would have matched no schedule, woken nothing, returned an empty
   * array and looked exactly like a working fix — a silent no-op is the failure mode this codebase
   * keeps producing, and a literal in a lookup table is one of the easiest ways to write one.
   */
  linkedin: [AUTONOMOUS_GTM_TASK_TYPE, ADVANCE_TASK_TYPE],
};

export interface Woken {
  schedule_id: string;
  task_type: string;
  /** What it was going to be, so a log can say how long the founder would have waited. */
  was_due_at: string;
}

/**
 * Bring forward everything in this project that was waiting on a connection of this kind.
 *
 * Returns what moved rather than a count, because the interesting fact in a log is WHICH job was
 * asleep and for how long it would have stayed that way.
 */
export async function wakeForConnection(
  domain: Pick<DomainStore, "listSchedules" | "updateSchedule">,
  args: { project_id: string; kind: string; now?: Date },
): Promise<Woken[]> {
  const types = WOKEN_BY_CONNECTION[args.kind];
  if (!types?.length || !args.project_id) return [];
  const now = args.now ?? new Date();
  const iso = now.toISOString();

  const all = await domain.listSchedules().catch(() => [] as Schedule[]);
  const woken: Woken[] = [];
  for (const s of all) {
    if (s.project_id !== args.project_id) continue;
    // A DISABLED SCHEDULE STAYS DISABLED. It is off because a founder or a go-live gate turned it
    // off, and connecting an account is not consent to start sending — that is what go-live is for.
    if (!s.enabled) continue;
    if (!types.includes(s.task_type)) continue;
    // Already due or overdue: the sweep will take it on the next pass anyway, and rewriting the
    // timestamp would only lose the information about how late it already is.
    if (s.next_run_at <= iso) continue;

    await domain.updateSchedule(s.id, { next_run_at: iso });
    woken.push({ schedule_id: s.id, task_type: s.task_type, was_due_at: s.next_run_at });
  }
  return woken;
}
