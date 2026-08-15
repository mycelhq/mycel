// The check-in: telling a client where their work stands, before they have to ask.
//
// ═══ WHAT WAS WRONG ═══
//
// `check_in_case` was the second-highest-ranked kind on a typical founder's list and the button was
// grey. The engine could see a silent engagement perfectly well — `updated_at` is right there — and
// the only thing it could offer was a sentence explaining that nothing in the business could carry
// the move. A ranked list where the top rows cannot be acted on is a reading list, and a founder
// reads it twice and then stops.
//
// ═══ WHY THIS ONE IS A REAL TASK TYPE AND `advance_case` IS NOT ═══
//
// This is the distinction the whole change turns on, so it is written next to the code.
//
// "Advance this engagement" means DO THE WORK IN IT — close the month, bill the week, produce the
// deliverable. That work is different for every wedge, it already has task types of its own
// (`monthly_close`, `weekly_run`), and a generic `advance_case` declared on each wedge to light up a
// button would be a verb nobody taught the agent: no rubric, no knowledge that fits, and an output
// schema that could only be a free-text blob. That is the hollow declaration this change refuses to
// make. `takeability` says so out loud and points the founder at the engagement.
//
// "Check in on this engagement" is ONE bounded, universal piece of client communication: read where
// the work actually is, and tell the client, in this firm's voice, without promising anything new.
// Every service business does it, the output is a short message and a stage-truthful summary, and it
// is exactly the thing that never gets done when a human is running the business — which is the
// definition of work worth automating. So it is declared, with a real schema, on the wedges that run
// long engagements.
//
// ═══ THE SHAPE, AND WHY IT IS THIS SHAPE ═══
//
// Deliberately nudges.ts's twin, down to the argument order. A third differently-shaped
// "reach out to a client" mechanism is a third thing to get wrong, and the way it goes wrong is a
// client receiving two messages.
//
//   · ONE IMPLEMENTATION. `startCheckIn` is called by `takeMove` and by the autonomy sweep through
//     the same door. There is no second path.
//
//   · PACING IS A COMPARE-AND-SET, NOT A CHECK. `claimCaseMarker` stamps
//     `data.last_checked_in_at` inside ONE statement whose WHERE clause holds the cooldown. Move ids
//     are deterministic, so a founder double-clicking Take is the expected case, not the exotic one.
//
//   · IT ENQUEUES, IT DOES NOT DISPATCH. Nothing here sends. The run's send goes through
//     `awaitApproval` exactly as a dunning chase does, so a check-in the autonomy sweep started at
//     03:00 still stops at a human before it reaches a client — unless a standing approval covers
//     it, and `standing.ts` refuses to cover a high-risk verdict.
//
//   · FAIL CLOSED ON THE WEDGE. An engagement whose wedge does not declare `check_in_case` is
//     refused rather than carried by whichever wedge was handy. The failure that rule exists for is
//     in `nudgeWedgeFor`: a client chased for a bank statement in the dunning voice, with the dunning
//     policy mounted as knowledge. That is not an approximation, it is the wrong firm speaking.
import type { Case, TaskSource } from "./contract";
import type { DomainStore } from "./domain";
import { wedgeDeclares, anyWedgeDeclares, _resetWedgeDeclarations } from "./wedge";

/** The task type of ONE check-in — what a wedge must declare to be able to carry this. */
export const CHECK_IN_TASK_TYPE = "check_in_case";

/**
 * Days of silence on an engagement before a check-in is worth proposing at all. Seven.
 *
 * THE SINGLE DEFINITION. It was a literal `7` in moves.ts and this module would have been the second
 * one — the `chaseIntervalDays` mistake in miniature, whose signature is a list that proposes a move
 * the carrier then refuses as `paced`, i.e. a button that does nothing. moves.ts re-exports this as
 * `CASE_STALE_DAYS` for the surfaces that already read that name.
 *
 * A week, because that is the rhythm a client's expectation actually runs on: silence from Monday to
 * Friday on live work is normal, and silence into a second week is when a client starts wondering
 * whether they are still a priority. Shorter would make the kernel chattier than a good account
 * manager; longer and the message arrives after the doubt.
 */
export const CASE_STALE_DAYS = 7;

/**
 * The floor between two check-ins on ONE engagement. The same seven days.
 *
 * Equal to the staleness threshold rather than a separate number, and that equality is the design:
 * a successful check-in writes to the case, `updated_at` moves, and `checkInMove` therefore stops
 * proposing it for a week all by itself. The claim's cooldown is the SAME week, so the two mechanisms
 * cannot disagree — the claim is what makes it atomic, the staleness gate is what makes it invisible,
 * and neither is load-bearing on its own.
 */
export const CHECK_IN_COOLDOWN_DAYS = CASE_STALE_DAYS;

const DAY_MS = 86_400_000;

/**
 * Does this wedge declare the check-in task type on disk?
 *
 * The gate both `takeability` and `startCheckIn` consult, and neither keeps its own list. The lookup
 * and its memo live in `wedge.ts` — see the note there for why three private `Map`s over the same
 * files was a bug waiting for a test that writes a manifest.
 */
export function wedgeCarriesCheckIn(wedge: string | undefined): boolean {
  return wedgeDeclares(wedge, CHECK_IN_TASK_TYPE);
}

/** Does ANY installed wedge declare it? The install-wide question — see `anyWedgeCarriesNudge`. */
export function anyWedgeCarriesCheckIn(): boolean {
  return anyWedgeDeclares(CHECK_IN_TASK_TYPE);
}

/** Test seam — a test that writes a manifest must be able to invalidate the memo. */
export function _resetWedgeCache(): void {
  _resetWedgeDeclarations();
}

// ── deps ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * What starting a check-in needs from the rest of the kernel.
 *
 * Injected rather than imported, for the reason `NudgeDeps` and `ChaseDeps` are: spawning a run means
 * clamping constraints against the deployment's ceilings, and all of that lives in `server.ts`.
 */
export interface CheckInDeps {
  wedgeEnabled(projectId: string, wedge: string): boolean;
  spawnTask(args: {
    project_id: string;
    wedge: string;
    task_type: string;
    client_id?: string;
    case_id?: string;
    source: TaskSource;
    input: Record<string, unknown>;
  }): Promise<string>;
}

/**
 * Null until `server.ts` registers it, and a null here means NOTHING starts.
 *
 * The same fail-closed wiring rule as `setNudgeDeps`: it does not fall back to a simpler spawn. A
 * kernel booted without the task routes mounted has no business emailing anybody's clients.
 */
let deps: CheckInDeps | null = null;
export function setCheckInDeps(d: CheckInDeps | null): void {
  deps = d;
}

// ── starting one ─────────────────────────────────────────────────────────────────────────────────

/**
 * Why a check-in did not start. Machine codes, so a UI can say something true rather than "error".
 *
 * `paced` is NOT a failure. It is the cooldown holding, and the founder-facing sentence has to say
 * so — a button reporting "something went wrong" when the honest answer is "we wrote to them on
 * Tuesday" teaches a founder to distrust the policy rather than to trust the pacing.
 */
export type CheckInRefusal =
  | "not_configured"
  | "no_carrier"
  | "wedge_disabled"
  | "not_open"
  | "paced"
  | "spawn_failed";

export type CheckInStart =
  | { ok: true; task_id: string; case_id: string; wedge: string }
  | { ok: false; reason: CheckInRefusal; message: string };

/**
 * The facts of a quiet engagement, as the `check_in_case` task type expects them.
 *
 * Lives here rather than in a route so that a check-in taken off `/next` and one the autonomy sweep
 * started are provably the same input — the mistake `chaseTaskInput` was extracted to fix.
 *
 * `days_silent` is the field that most changes the right tone (five days is "quick update", thirty
 * is an apology), and it is the one a second builder would have got wrong first.
 *
 * `recent_history` is the LAST few timeline entries and not the whole case. The agent needs to say
 * what has actually happened, and handing it two years of stage changes costs tokens to make the
 * answer worse — the useful facts are all at the end.
 *
 * ═══ WHY `lastActivityAt` IS AN ARGUMENT AND NOT `k.updated_at` ═══
 *
 * Because by the time the run is built, `k.updated_at` is a lie. `claimCaseMarker` writes to the row
 * — that is what makes the claim atomic — so it moves `updated_at` to now, and reading silence off
 * the claimed row gives every check-in `days_silent: 0`. The agent would then open a message to a
 * client who has heard nothing for six weeks with "just a quick update", which is precisely the tone
 * this field exists to get right. The caller captures the value BEFORE it claims and passes it here.
 */
export function checkInTaskInput(k: Case, nowIso: string, lastActivityAt: string): Record<string, unknown> {
  const history = (k.history ?? []).slice(-5).map((h) => ({
    at: h.at,
    kind: h.kind,
    ...(h.from ? { from: h.from } : {}),
    ...(h.to ? { to: h.to } : {}),
    ...(h.note ? { note: h.note } : {}),
  }));
  return {
    case_id: k.id,
    client_id: k.client_id,
    title: k.title,
    stage: k.stage,
    due_at: k.due_at,
    days_silent: Math.max(0, Math.floor(daysApart(lastActivityAt, nowIso))),
    last_activity_at: lastActivityAt,
    recent_history: history,
    today: nowIso.slice(0, 10),
  };
}

const daysApart = (from: string, to: string): number => (Date.parse(to) - Date.parse(from)) / DAY_MS;

/**
 * Start ONE check-in. The single implementation, called by every door.
 *
 * ═══ `pacing` IS THE ONE THING CALLERS DISAGREE ABOUT, AND THEY SHOULD ═══
 *
 *   · `"ladder"` — claim only if `CHECK_IN_COOLDOWN_DAYS` has elapsed since the last one. What
 *     taking a move from `/next` does, and what the autonomy sweep does. It is also what makes
 *     taking a move IDEMPOTENT: move ids are deterministic, so the same silent engagement is the
 *     same move on Tuesday as on Monday, and without an atomic claim a double click is two messages.
 *
 *   · `"override"` — a founder on the engagement itself deciding something the cooldown cannot know
 *     ("they emailed me, send them the summary now"). It still STAMPS `last_checked_in_at`, so the
 *     ladder sees it and does not add a second message a day later.
 *
 * NOTHING SENDS HERE. This spawns a run. The words, and the decision to put them in front of a real
 * client, go through `awaitApproval` like every other consequence.
 */
export async function startCheckIn(
  domain: DomainStore,
  k: Case,
  opts: { pacing: "ladder" | "override"; now?: Date },
): Promise<CheckInStart> {
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();

  if (!deps) return { ok: false, reason: "not_configured", message: "Check-ins are not wired up in this deployment." };
  // A tenant-less case cannot be scoped, and the claim below would refuse it anyway. Refusing here
  // gives the founder a sentence instead of a silent `paced`.
  if (!k.project_id) {
    return { ok: false, reason: "not_open", message: "That engagement is not attached to a business." };
  }
  if (k.status !== "open") {
    return { ok: false, reason: "not_open", message: `A ${k.status} engagement does not need checking in on.` };
  }
  if (!wedgeCarriesCheckIn(k.wedge)) {
    return {
      ok: false,
      reason: "no_carrier",
      message: `The ${k.wedge} service does not declare a way to check in on an engagement yet — so this is still yours to do by hand.`,
    };
  }
  if (!deps.wedgeEnabled(k.project_id, k.wedge)) {
    return { ok: false, reason: "wedge_disabled", message: `The ${k.wedge} service is not switched on for this business.` };
  }

  // Captured BEFORE the claim, which is about to overwrite it. See `checkInTaskInput`.
  const lastActivityAt = k.updated_at;

  const notCheckedInSince =
    opts.pacing === "override"
      ? // `now` as the floor makes the cooldown guard unconditional: record, don't gate. A founder
        // who has decided has decided — but the stamp still happens, so nothing else adds a second.
        nowIso
      : new Date(now.getTime() - CHECK_IN_COOLDOWN_DAYS * DAY_MS).toISOString();

  const claimed = await domain.claimCaseMarker({
    project_id: k.project_id,
    id: k.id,
    marker: "last_checked_in_at",
    notSince: notCheckedInSince,
    at: nowIso,
  });
  if (!claimed) {
    return {
      ok: false,
      reason: "paced",
      message: `We have already been in touch about "${k.title}" recently — the next check-in is due after ${CHECK_IN_COOLDOWN_DAYS} days.`,
    };
  }

  try {
    const taskId = await deps.spawnTask({
      project_id: claimed.project_id!,
      wedge: claimed.wedge,
      task_type: CHECK_IN_TASK_TYPE,
      client_id: claimed.client_id,
      case_id: claimed.id,
      // `api` when a person clicked, `schedule` when the sweep decided. An operator reading the task
      // list needs to tell "someone asked for this" from "the business did it on its own".
      source: opts.pacing === "override" ? "api" : "schedule",
      // Built from the CLAIMED row, so the input describes what was actually written rather than the
      // copy the caller read a moment ago.
      input: checkInTaskInput(claimed, nowIso, lastActivityAt),
    });
    return { ok: true, task_id: taskId, case_id: claimed.id, wedge: claimed.wedge };
  } catch (e) {
    console.error(`[mycel] failed to start a check-in for case ${k.id}:`, e);
    // A won claim that then fails to spawn is NOT rolled back — the engagement waits out one
    // cooldown. The failure mode of a claim that releases on error is two replicas racing the
    // release, and a missed check-in is cheaper than a duplicate one. Same trade as `startNudge`.
    return { ok: false, reason: "spawn_failed", message: "The check-in could not be started. Try again shortly." };
  }
}
