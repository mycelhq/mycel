// Work that waits — an engagement blocked on a named condition, that resumes when it is met.
//
// ═══ WHAT WAS ALREADY HERE, AND WHY NONE OF IT WAS THIS ═══
//
// The kernel had four waits before this file, and each is a specific one:
//
//   · `awaitApproval` (approvals.ts) suspends a RUN on a HUMAN. Right for a decision that resolves
//     in minutes, wrong for one that resolves in a fortnight — it is an in-process promise holding a
//     live sandbox, with a TTL measured in minutes, and a deploy ends it. The engagement it belonged
//     to keeps no record that it ever happened.
//   · `ClientRequest` (requests.ts) is "what we need from the client", with a `due_at`. It is the
//     best of the four and it is still one condition out of many: it cannot wait on a payment, on a
//     date, or on a conversation that has no ask attached.
//   · `gtm/sequence.ts` parks a campaign case between steps, per-step, inside one wedge.
//   · `Schedule` is a CADENCE. "Every Tuesday" is not "when they reply".
//
// What none of them expresses is the general one: *this engagement is blocked on X, and when X
// happens, do Y.* That is vision.md §"What is left → 1" — "the difference between a task runner and
// an operating system".
//
// ═══ THE ONE RULE ═══
//
// RESUME AT MOST ONCE. The sentence in the vision is "paused for a client reply, resumed next
// Tuesday, and NEVER DOUBLE-INVOICED", and every design decision below is downstream of that:
//
//   1. The claim is ONE conditional statement (`domain.claimWait`), `waiting` → `resuming`. Two
//      replicas sweeping the same project in the same second produce one winner and one `undefined`.
//      A client who replies twice produces one winner for the same reason — the second evaluation
//      finds a row that is no longer `waiting`.
//   2. The claim does NOT release. A resume that crashes between the claim and the spawn leaves the
//      wait in `resuming`, visible on `GET /v1/waits`, requiring a human. A lease that expired and
//      made it eligible again would trade a stuck engagement for a duplicate invoice, and that is
//      the wrong trade in a system whose promise is the cash drawer has a lock on it.
//   3. At most one live wait per case, enforced by a partial unique index. Two resumes racing to
//      advance the same stage is the same bug arriving from inside the house.
//
// ═══ NOTHING RESUMES PAST A GATE ═══
//
// A resume creates an ordinary queued `Task` through the same `spawnTask` the invoice chase and the
// case-episode route use: same `clampConstraints`, same wedge manifest, same `runTask`, same
// OpenCode plugin gate, same `awaitApproval`. There is deliberately no send, no invoice write and no
// outbound anything in this file. If resuming were a way to skip an approval, the wait would be a
// hole in the trust story rather than a part of it — and "the client replied, so we auto-sent" is
// exactly the shape of the mistake.
//
// ═══ MORE THAN ONE WAY OUT (`mode: "any"`) ═══
//
// A wait holds a SET of conditions, and the first one satisfied wins. That is not a generalisation
// for its own sake: every real wait in a service business has several exits, and before this a
// caller had to pick one and be wrong about the rest. "Chase the unpaid invoice" ends when they pay,
// or when they reply disputing line 3, or when the deadline arrives — a wait watching only the
// payment slept through the dispute and kept nudging a client who had already answered.
//
// EXACTLY-ONCE IS UNTOUCHED BY THIS, and the reason is that nothing about the claim changed. The
// claim is per-WAIT, not per-condition: `evaluateWait` returns AT MOST ONE verdict however many
// conditions came good, and `resumeWait` still runs the single conditional `waiting` → `resuming`
// statement. Two conditions satisfied in the same sweep are one verdict and therefore one claim; two
// replicas seeing different winning conditions in the same second are two claims of which one
// returns `undefined`. The only thing the extra conditions add is WHICH one is recorded —
// `satisfied_index`, written in the same statement as the claim, because "they replied" and "they
// paid" lead to different next moves and a resume that has to guess drafts a chase at a client who
// is mid-dispute.
//
// ═══ THE JOIN (`mode: "all"`), AND WHY IT IS CONDITIONS AND NOT WAITS ═══ [WAIT_JOIN]
//
// "Close the month once every receipt is in" is the canonical service-business join, and it is
// exactly what `books-keeper` could not say: it parks on ONE client request, and a month-end close
// waits on several. The design question was whether a wait depends on other WAITS or on a SET OF
// CONDITIONS. It is the second, for four reasons, in order of how much they cost:
//
//   1. AT MOST ONE LIVE WAIT PER CASE is the constraint that stops two resumes racing to advance one
//      engagement, and it is enforced by a partial unique index rather than by code. A join over
//      seven receipts modelled as waits needs eight live waits — seven children and a parent — on
//      one engagement, so the very first thing a DAG costs is the index that makes the double-resume
//      impossible. Trading a hard database guarantee for a graph traversal in application code, in
//      the module whose entire purpose is exactly-once, is the wrong trade at any price.
//   2. A DAG needs cycle detection, cascading cancellation, orphan collection and an answer to "what
//      happens to the children when the parent expires" — four new failure modes, each of which
//      strands an engagement silently, which is the failure this whole file exists to end.
//   3. A CHILD WAIT'S ONLY JOB WOULD BE TO SATISFY ITS PARENT. It would carry a `resume.task_type`
//      it must never spawn, a nudge ladder that duplicates the parent's, and an expiry that means
//      something different from the parent's. Three fields that must be inert is a sign the noun is
//      wrong.
//   4. Conditions ARE already the unit of satisfaction. They are evaluated by one sweep, in one
//      pass, against stores that are already open — so the join costs one row and no new mechanism.
//
// What a DAG would genuinely buy is a join across CASES ("close the books once all four clients'
// months are closed"), and that is honestly out of scope here: it is a different noun (a programme
// of engagements) and it should not be smuggled in as a field on a wait.
//
// ═══ A JOIN THAT CANNOT COMPLETE MUST NOT HANG ═══
//
// The dead end one level up: six receipts in, the seventh client never answers, and the close waits
// for ever. Two mechanisms, and neither is "hope":
//
//   · A DEPENDENCY THAT CAN NEVER BE SATISFIED kills the join IMMEDIATELY and LOUDLY. A withdrawn
//     request or a voided invoice is not "still pending" — the answer is never coming — so an `all`
//     wait with one unresolvable part fails at the next sweep with a reason that names the part and
//     the progress ("4 of 7 receipts are in; the request for March was withdrawn"). Waiting out the
//     remaining eighty-nine days for a condition that is provably dead is time a founder spends
//     believing the month is going to close.
//   · A DEPENDENCY THAT IS MERELY SILENT is bounded by `expires_at`, which every wait has whether
//     the caller set one or not (`MAX_WAIT_DAYS`). Expiry now leads somewhere — see below.
//
// And in both cases the engagement lands in front of a founder as a ranked `unblock_wait` move,
// carrying the partial progress. Which is the third mechanism, and the important one: the join does
// not need to be right about what to do next, it needs to stop being invisible.
//
// ═══ EXPIRY IS NOT A DEAD END ANY MORE ═══
//
// An expired wait used to write a timeline note and stop. The engagement then sat in no queue,
// appeared in no list and was proposed by nothing — the exact opposite of "the business keeps
// moving", and worse than never having parked it. It still spawns nothing (deciding what happens to
// a client who went silent for ninety days is judgement, not arithmetic), but `moves.ts` now
// proposes `unblock_wait` for it, ranked with the chases and the check-ins and carrying its own
// sentence. See `expiredWaitMove` there.
//
// ═══ NO SECOND SCHEDULER ═══
//
// The sweep hangs off `claimDueSchedules` (via `fireSchedule` in scheduler.ts), exactly like the
// dunning sweep and the outreach tick. gtm/sequence.ts:14-22 gives the reason and it holds here: a
// second timer would need its own claim, its own catch-up policy and its own answer to "what happens
// when four containers boot at once", and it would get one of them wrong.
import type { Case, CaseWait, WaitCondition, WaitMode, WaitPart, WaitResume, TaskSource } from "./contract";
import type { DomainStore } from "./domain";
import { getBillingStore } from "./billing";
import { getRequestStore } from "./requests";
import { getDeliverableStore } from "./deliverables";

/** Reserved wedge slug for the sweep's own schedule, the way `MOVES_WEDGE` is reserved in moves.ts. */
export const WAITS_WEDGE = "waits";

/** The sweep's task type. Intercepted in `fireSchedule` — it is harness arithmetic, not agent work. */
export const WAIT_SWEEP_TASK_TYPE = "resume_waiting_work";

/**
 * Five minutes.
 *
 * Faster than the hourly dunning sweep because the signals here are conversational: a client who
 * answers a question and hears nothing for an hour has learned that the thing is not really live.
 * Slower than a second, because every tick is one indexed read per project and the `date` condition
 * is the only one that needs punctuality at all.
 */
export const SWEEP_SECONDS = 300;

/** Waits examined per sweep, per project. Matches `dunning.BATCH` — bounded work per tick. */
export const BATCH = 50;

/** Default nudge ladder when a caller arms a wait without one: chase after 3 days, three times. */
export const DEFAULT_NUDGE_DAYS = 3;
export const DEFAULT_MAX_NUDGES = 3;

/**
 * The hard stop. A wait with no `expires_at` gets this one anyway.
 *
 * A wait that never expires is an engagement that silently stops existing: it stays `waiting`
 * forever, it is not on anyone's list of work, and the client is never told the ball is in their
 * court. Ninety days is long enough for any real service engagement and short enough that a
 * forgotten one surfaces within a quarter rather than never.
 */
export const MAX_WAIT_DAYS = 90;

/**
 * How long a wait must have sat untouched in `resuming` before a human may re-arm it.
 *
 * Fifteen minutes. The window this is guarding is the one thing we genuinely cannot observe: a
 * resume that CRASHED and a resume that is merely SLOW look identical from the outside, and the only
 * difference is that the slow one is still going to spawn its run. Everything between `claimWait` and
 * `spawnTask` is one case read, one wedge check and one queue write — hundreds of milliseconds, and
 * a deploy that killed the replica mid-way is already over. Fifteen minutes is three orders of
 * magnitude of headroom, so a wait older than this is stuck rather than busy; and it is short enough
 * that a founder who notices a stalled engagement in the morning can act on it that morning.
 */
export const REARM_STUCK_AFTER_MINUTES = 15;

/**
 * How many times one wait may be re-armed.
 *
 * Three. Not because three is magic, but because the fourth click is a founder generating load
 * instead of a diagnosis: a resume that dies three times is failing for a reason that another attempt
 * will not change (a wedge whose manifest lost the task type, a queue that is down), and the honest
 * next step is to look at it. Enforced inside `rearmWait`'s WHERE clause, not by a caller.
 */
export const MAX_REARMS = 3;

const DAY_MS = 86_400_000;

// ── deps ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * What resuming needs from the rest of the kernel.
 *
 * Injected rather than imported, for the reason `ChaseDeps` is: spawning a run means clamping
 * constraints against the deployment's ceilings and resolving the wedge manifest's output schema,
 * all of which lives in `server.ts`. A sweep that reached for it directly would drag the whole
 * server graph into the scheduler.
 */
export interface WaitDeps {
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
 * Null until `createServer` registers it, and a null here means the sweep does NOTHING.
 *
 * Same fail-closed wiring rule as `setChaseDeps`: it does not fall back to a simpler spawn. A kernel
 * booted without the routes mounted has no business resuming anybody's engagements.
 */
let deps: WaitDeps | null = null;
export function setWaitDeps(d: WaitDeps | null): void {
  deps = d;
}

// ── arming ───────────────────────────────────────────────────────────────────────────────────────

/**
 * The most conditions one wait may hold.
 *
 * Twelve. Generous for the shape this exists for — a month-end close over a quarter's receipts, a
 * chase with a payment / reply / deadline exit — and small enough that a malformed caller cannot
 * turn one sweep tick into a thousand store reads per wait. A join that genuinely needs more than
 * twelve parts is a programme of work, not a wait, and it should say so out loud rather than
 * discovering it at the eightieth receipt.
 */
export const MAX_CONDITIONS = 12;

export interface ArmWaitArgs {
  project_id: string;
  case_id: string;
  reason: string;
  /** The single-condition form. Exactly equivalent to `conditions: [c]`; both may not be given. */
  condition?: WaitCondition;
  conditions?: WaitCondition[];
  /** Defaults to `any`. See `WaitMode` — an unrecognised value is refused, never coerced. */
  mode?: WaitMode;
  resume: WaitResume;
  nudge_at?: string;
  max_nudges?: number;
  expires_at?: string;
}

export type ArmResult = { ok: true; wait: CaseWait } | { ok: false; error: string };

/**
 * Validate a condition's SHAPE. Whether the thing it names exists is checked on every evaluation,
 * not here — a thread can be deleted after the wait is armed, and a wait that was valid at birth and
 * unresolvable later must fail loudly rather than hang.
 *
 * Returns null when the shape is good. Exported because the route needs the same answer before it
 * writes a row, and a second copy of this list would drift the day a fifth condition is added.
 */
export function validateCondition(c: unknown): string | null {
  const k = (c as { kind?: unknown })?.kind;
  const has = (f: string) => typeof (c as Record<string, unknown>)?.[f] === "string" && !!(c as Record<string, string>)[f];
  switch (k) {
    case "client_reply":
      return has("thread_id") ? null : "client_reply requires a thread_id";
    case "request_resolved":
      return has("request_id") ? null : "request_resolved requires a request_id";
    case "invoice_paid":
      return has("invoice_id") ? null : "invoice_paid requires an invoice_id";
    case "deliverable_settled":
      return has("deliverable_id") ? null : "deliverable_settled requires a deliverable_id";
    case "date":
      if (!has("at")) return "date requires an `at` timestamp";
      return Number.isFinite(Date.parse((c as { at: string }).at)) ? null : "date `at` is not a timestamp";
    default:
      return `unknown wait condition: ${JSON.stringify(k)}`;
  }
}

/**
 * Validate a whole SET of conditions, and normalise the two accepted spellings into one array.
 *
 * Exported for the same reason `validateCondition` is: two routes and one internal caller need the
 * identical answer before a row is written, and a second copy of these rules would drift.
 *
 * THE EMPTY SET IS REFUSED, and it is the important one. A wait with no conditions cannot be
 * satisfied by anything — it can only expire — so it is an engagement parked for ninety days with a
 * reason a founder can read and no mechanism that could ever release it. Failing at arm time puts
 * that in front of the caller who can fix it; failing closed at sweep time would put it in front of
 * nobody for three months.
 *
 * DUPLICATES ARE REFUSED TOO. Two identical conditions in an `all` wait make the join permanently
 * "6 of 7" — both copies satisfy at once, but `recordWaitPart` is idempotent by INDEX, so both
 * indexes do get parts and the count is right… and the founder still reads "waiting on the March
 * receipt" twice in the outstanding list. In an `any` wait they are simply noise. Neither is worth
 * carrying, and a caller that built its list in a loop is exactly how one arrives.
 */
export function normalizeConditions(
  a: Pick<ArmWaitArgs, "condition" | "conditions" | "mode">,
): { ok: true; conditions: WaitCondition[]; mode: WaitMode } | { ok: false; error: string } {
  if (a.condition && a.conditions?.length) {
    return { ok: false, error: "give either `condition` or `conditions`, not both — two lists is two answers to what this is blocked on" };
  }
  const list = a.conditions?.length ? a.conditions : a.condition ? [a.condition] : [];
  if (!Array.isArray(list) || list.length === 0) {
    return { ok: false, error: "a wait needs at least one condition — a wait with no way out can only expire" };
  }
  if (list.length > MAX_CONDITIONS) {
    return { ok: false, error: `a wait may hold at most ${MAX_CONDITIONS} conditions; this one has ${list.length}. More than that is a programme of work, not a wait.` };
  }
  for (const c of list) {
    const bad = validateCondition(c);
    if (bad) return { ok: false, error: bad };
  }
  const seen = new Set<string>();
  for (const c of list) {
    // Keyed on the DISCRIMINANT AND ITS SUBJECT, not on the whole object: two `request_resolved`
    // conditions on one request are the same condition even when one of them carries a `label`.
    const key = JSON.stringify([c.kind, conditionSubject(c)]);
    if (seen.has(key)) return { ok: false, error: `the same condition is listed twice: ${describeCondition(c)}` };
    seen.add(key);
  }
  const mode = a.mode ?? "any";
  if (mode !== "any" && mode !== "all") return { ok: false, error: `unknown wait mode: ${JSON.stringify(a.mode)}` };
  return { ok: true, conditions: list, mode };
}

/** The id (or date) a condition is about. Used for de-duplication and for derived labels. */
function conditionSubject(c: WaitCondition): string {
  switch (c.kind) {
    case "client_reply": return c.thread_id;
    case "request_resolved": return c.request_id;
    case "invoice_paid": return c.invoice_id;
    case "deliverable_settled": return c.deliverable_id;
    case "date": return c.at;
    default: return "";
  }
}

/**
 * One condition, in a founder's words.
 *
 * The caller's `label` wins whenever there is one — "Acme's March receipt" is a sentence and
 * `request:9f3c-…` is not, and the caller that armed the wait is the only party that ever knew which
 * is which. The fallback is deliberately vague about ids rather than printing a UUID at a founder:
 * an outstanding list reading "a document we asked for" is honest, and one reading
 * "request_resolved(9f3c8b21-…)" teaches them to stop reading it.
 */
export function describeCondition(c: WaitCondition): string {
  if (c.label) return c.label;
  switch (c.kind) {
    case "client_reply": return "a reply from them";
    case "request_resolved": return "something we asked them for";
    case "invoice_paid": return "the invoice to be paid";
    // Deliberately says what we are waiting FOR rather than naming the deliverable: this string is
    // read in an outstanding list next to a case title that already names the work, and "waiting on
    // them to come back on the statement of work — the statement of work" reads like a bug.
    case "deliverable_settled": return "them to come back on the work we sent";
    case "date": return `${c.at.slice(0, 10)}`;
    default: return "a condition this build does not recognise";
  }
}

/**
 * Park an engagement on a condition.
 *
 * The case is re-read and tenant-checked HERE rather than trusted from the caller, because
 * `project_id` on the wait row decides which founder's connections the resumed run will be able to
 * reach. A wait armed under the wrong project is a cross-tenant send with a delay fuse on it.
 *
 * The nudge and expiry defaults are applied rather than left absent on purpose — see `MAX_WAIT_DAYS`.
 */
export async function armWait(domain: DomainStore, a: ArmWaitArgs, now = new Date()): Promise<ArmResult> {
  if (!a.project_id) return { ok: false, error: "a wait must be scoped to a project" };
  const kase = await domain.getCase(a.case_id);
  if (!kase || kase.project_id !== a.project_id) return { ok: false, error: "not found" };
  if (kase.status === "closed") return { ok: false, error: "a closed case cannot wait on anything" };

  const norm = normalizeConditions(a);
  if (!norm.ok) return { ok: false, error: norm.error };
  const taskType = String(a.resume?.task_type ?? "").trim();
  if (!taskType) return { ok: false, error: "resume.task_type is required — a wait with no resume is a dead end" };

  const reason = String(a.reason ?? "").trim();
  if (!reason) return { ok: false, error: "reason is required — a founder has to be able to read why this is blocked" };

  const maxNudges = Number.isFinite(a.max_nudges) ? Math.max(0, Math.min(10, Number(a.max_nudges))) : DEFAULT_MAX_NUDGES;
  const capExpiry = new Date(now.getTime() + MAX_WAIT_DAYS * DAY_MS).toISOString();
  const expires = a.expires_at && a.expires_at < capExpiry ? a.expires_at : capExpiry;
  const nudgeAt = maxNudges > 0 ? (a.nudge_at ?? new Date(now.getTime() + DEFAULT_NUDGE_DAYS * DAY_MS).toISOString()) : undefined;

  let wait: CaseWait;
  try {
    wait = await domain.createWait({
      project_id: a.project_id,
      case_id: kase.id,
      wedge: kase.wedge,
      reason,
      conditions: norm.conditions,
      mode: norm.mode,
      resume: { task_type: taskType, input: a.resume.input ?? {} },
      nudge_at: nudgeAt,
      max_nudges: maxNudges,
      expires_at: expires,
    });
  } catch (e) {
    // The partial unique index (or its in-memory twin) refusing a second live wait on one case. A
    // 409, not a 500: the caller asked for something the model forbids, and the message says so.
    return { ok: false, error: `that case is already waiting on something (${(e as Error).message})` };
  }

  // ON THE CASE'S OWN TIMELINE, not only in a table nobody opens. Law 6 — "what happened, why". A
  // founder reading the engagement should see the pause where it happened, in sequence with the
  // stage changes around it.
  await domain
    .updateCase(kase.id, {}, {
      at: wait.created_at,
      kind: "note",
      // The join says its shape on the FIRST line of the timeline, not only once it is half done. A
      // founder reading "waiting: close the month" has no idea it is a seven-part join until
      // something starts landing, and by then they have already asked.
      note: `waiting: ${reason}${wait.mode === "all" && wait.conditions.length > 1 ? ` (all ${wait.conditions.length} of: ${wait.conditions.map(describeCondition).join(", ")})` : ""}`,
      actor: "system",
    })
    .catch(() => {});
  return { ok: true, wait };
}

// ── wedges that park themselves ──────────────────────────────────────────────────────────────────

/**
 * Arm the wait a wedge DECLARED for this task type, if it declared one.
 *
 * ═══ WHY THIS IS THE ONE AUTOMATIC ARM ═══
 *
 * Called from the `ask_client` branch of `POST /v1/internal/knowledge/gap` — the single place in the
 * kernel where a run says, in so many words, "I cannot finish this without the customer". That is
 * where a real service business stops: books-keeper's `chase_receipts` asks for four missing receipts
 * and the month simply cannot close until they land. Before this, the `ClientRequest` was raised, the
 * run ended, and the engagement's only forward motion was a founder noticing. `nudges.ts` would chase
 * the ask — but nothing anywhere resumed the WORK when the ask was answered.
 *
 * ═══ NO SECOND LADDER, AND THIS IS WHERE THAT IS ENFORCED ═══
 *
 * `nudges.ts` already owns chasing this exact request row: `sweepOpenRequests` claims it atomically,
 * escalates on `nudgeIntervalDays`, and stops at `MAX_NUDGES`. So this wait is armed with
 * `max_nudges: 0`. That is not a detail — a wait that nudged as well would put a second "still
 * waiting" line on the timeline for every real chase, and would tell a founder reading `/next` that
 * two mechanisms are chasing one customer. The wait's job here is strictly the OTHER half: nudging is
 * the request's, resuming is the wait's, and neither does the other's.
 *
 * The two also cannot double-SEND, for a stronger reason than division of labour: the wait resumes on
 * `request_resolved`, which is a state the nudge ladder stops at (`sweepOpenRequests` queries
 * `status: "open"` only). They are triggered by mutually exclusive states of one row.
 *
 * ═══ WHY IT IS THE `resume` TASK TYPE AND NOT THIS ONE ═══
 *
 * Resuming `chase_receipts` when the receipts arrive would ask for them again. The manifest names the
 * next step (`monthly_close`), which is what "picks up rather than restarts" means concretely.
 *
 * ═══ THE SECOND ASK GROWS THE JOIN, IT DOES NOT GET DROPPED ═══
 *
 * This is where "books-keeper parks on ONE client request, and a month-end close waits on several"
 * was actually costing something. `chase_receipts` asks for four missing receipts by calling the gap
 * route four times. The first ask armed the wait; the next three hit the one-live-wait-per-case
 * index, were refused, and — because this function fails soft — were silently dropped. The close
 * then resumed on receipt one and filed a quarter of a month, on time, looking correct.
 *
 * So the declared wait is armed as a JOIN (`mode: "all"`) even when it holds one condition, and a
 * subsequent ask on an already-parked case GROWS it through `domain.growWait` rather than failing.
 * A one-condition `all` wait behaves exactly as a one-condition `any` wait does, so nothing changes
 * for the wedge that really does ask for one thing.
 *
 * Growth is refused when the existing wait is not this kind of wait — a case parked on a client
 * REPLY is not a month-end close, and appending a receipt to it would resume the wrong work. In that
 * case we are back to the old behaviour, which is the honest fallback: the ask stands, and the
 * engagement is parked on something else.
 *
 * FAIL SOFT. Every caller wraps this and ignores the result: a wait that could not be armed must never
 * cost the client the request that was about to be raised. The engagement is then exactly as
 * un-parked as it was before this function existed, which is a survivable outcome; losing the ask is
 * not.
 */
export async function armDeclaredWait(
  domain: DomainStore,
  args: {
    project_id: string;
    case_id: string | undefined;
    wedge: string;
    task_type: string;
    request_id: string;
    /** What was asked for, in a founder's words. Becomes the condition's label — see `WaitCondition`. */
    ask_label?: string;
    /** The manifest lookup, injected so this module keeps no dependency on the wedge loader. */
    declaredBy(wedge: string, taskType: string): { on: string; resume: string; reason: string } | undefined;
    /** Does the resume task type exist in that wedge's manifest? Same question the routes ask. */
    declaresTaskType(wedge: string, taskType: string): boolean;
  },
  now = new Date(),
): Promise<CaseWait | undefined> {
  // No case means no engagement to park. A `ClientRequest` raised by a run with no case is a real
  // shape (an ad-hoc ask), and there is nothing for a resume to pick up — inventing a case here would
  // be the kernel manufacturing an engagement out of a question.
  if (!args.case_id || !args.project_id) return undefined;
  const spec = args.declaredBy(args.wedge, args.task_type);
  if (!spec || spec.on !== "client_request") return undefined;
  // The resume is validated against the manifest HERE, at arm time, for the same reason
  // `POST /v1/cases/:id/wait` does it: a resume naming a task type no wedge declares produces a run
  // with no output schema, no policy and no knowledge — and it does it a fortnight later, when
  // nobody is watching and the error lands nowhere a person will read it.
  if (!args.declaresTaskType(args.wedge, spec.resume)) {
    console.error(
      `[mycel] wedge ${args.wedge} declares waits_for.resume="${spec.resume}" on ${args.task_type}, but no such task type exists`,
    );
    return undefined;
  }
  const condition: WaitCondition = {
    kind: "request_resolved",
    request_id: args.request_id,
    // The founder-readable name of this part. Without it a seven-part join's outstanding list reads
    // as seven UUIDs, which is a progress bar rendered as a stack trace.
    label: args.ask_label?.trim() || undefined,
  };

  const armed = await armWait(
    domain,
    {
      // From the CASE's project, resolved by the caller from the grant — never from anything the
      // model wrote. `armWait` re-checks it against the case anyway; this is belt and braces on the
      // one row whose bad tenant is a delayed cross-tenant run rather than an immediate error.
      project_id: args.project_id,
      case_id: args.case_id,
      reason: spec.reason,
      conditions: [condition],
      // A JOIN from the first ask. See the header — the second, third and fourth receipts of one
      // month-end close arrive as separate calls, and an `any` wait would resume on whichever landed
      // first with the other three still outstanding.
      mode: "all",
      resume: { task_type: spec.resume, input: { because_of_request: args.request_id } },
      // Zero — nudges.ts owns chasing this request. See the header.
      max_nudges: 0,
    },
    now,
  );
  if (armed.ok) return armed.wait;

  // Already parked. Not an error — and, when the existing wait is this same declared join, not the
  // end either: the ask becomes another part of it. `growWait` refuses anything that is not a live
  // `all` wait, so a case parked on a client reply is left exactly as it was.
  const live = (await domain.listWaits({ project_id: args.project_id, case_id: args.case_id, status: "waiting" }))[0];
  if (!live) return undefined;
  const grown = await domain.growWait(args.project_id, live.id, condition, MAX_CONDITIONS);
  if (!grown) return undefined;
  await domain
    .updateCase(args.case_id, {}, {
      at: now.toISOString(),
      kind: "note",
      note: `also waiting on ${describeCondition(condition)} (${grown.parts.length} of ${grown.conditions.length} in): ${grown.reason}`,
      actor: "system",
    })
    .catch(() => {});
  return grown;
}

// ── evaluation ───────────────────────────────────────────────────────────────────────────────────

/**
 * How far along a wait is. Present on every non-satisfied verdict, because "still waiting" is only
 * a useful answer next to "on what, and how much of it is already in".
 */
export interface WaitProgress {
  mode: WaitMode;
  /** Conditions already met. For `any` this is 0 by construction — one met condition resumes. */
  satisfied: number;
  total: number;
  /** What is still outstanding, in a founder's words. The nudge and the `/next` list both read it. */
  outstanding: string[];
  /**
   * Conditions that can NEVER be satisfied now — a withdrawn request, a voided invoice.
   *
   * Reported even when the wait is still `pending`, which only happens under `any`: an OR wait whose
   * payment exit died is still live via its reply exit, and a founder who cannot see that one door
   * closed will not understand why the wait behaves as it does. Under `all` a dead part is terminal,
   * so this list is what the failure message is built from.
   */
  dead: string[];
}

/**
 * The verdict on one wait.
 *
 * `unresolvable` is separate from `pending` and that distinction is the fail-closed rule made
 * concrete: a wait whose thread was deleted is NOT "still waiting", it is broken, and treating it as
 * pending is how an engagement disappears quietly for ninety days.
 */
export type WaitVerdict =
  | {
      state: "satisfied";
      by: string;
      /** WHICH condition won, for an `any` wait. Absent under `all` — all of them did. */
      index?: number;
      /** Parts observed in THIS evaluation that are not yet persisted. The sweep records them. */
      newly_satisfied: WaitPart[];
    }
  | { state: "pending"; progress: WaitProgress; newly_satisfied: WaitPart[] }
  | { state: "expired"; progress: WaitProgress }
  | { state: "unresolvable"; reason: string; progress: WaitProgress };

/** The verdict on ONE condition. `undefined` evidence means "not yet", never "cannot". */
type ConditionVerdict = { by: string } | { pending: true } | { dead: string };

/**
 * Is this wait met? Reads ONLY signals that already exist.
 *
 * There is no wait-specific event bus, and adding one was the first design considered and rejected:
 * a second record of "the client replied" begins disagreeing with the messages table on the first
 * day someone writes a migration that touches one of them. client-context.ts:1-23 makes the same
 * argument for the same reason.
 *
 * EVERY read here re-checks the tenant against `wait.project_id`, including the ones whose store
 * method looks scoped already. `getInvoice` takes no project; `getThread` takes no project. A resume
 * driven by another tenant's paid invoice is exactly the leak this codebase has shipped twice.
 *
 * ═══ AT MOST ONE VERDICT, HOWEVER MANY CONDITIONS ═══
 *
 * This is the line that keeps OR from touching exactly-once. Conditions are evaluated in ARRAY
 * ORDER and the first satisfied one wins; `resumeWait` then makes exactly one claim. Two conditions
 * that come good in the same sweep produce one verdict — deterministically the earlier one, rather
 * than whichever store happened to answer first, so two replicas evaluating the same instant agree
 * on the winner even though only one of them will get the claim.
 *
 * PURE. It writes nothing, including the parts it discovers: they come back as `newly_satisfied` and
 * the sweep persists them. A read that wrote would mean `GET /v1/waits` advancing a join.
 */
export async function evaluateWait(domain: DomainStore, wait: CaseWait, now = new Date()): Promise<WaitVerdict> {
  const nowIso = now.toISOString();

  // Expiry is checked FIRST, but a satisfied-and-expired wait should still resume, so it is checked
  // again at the end. A client who answered an hour before the deadline and a sweep that ran an hour
  // after it must not lose the answer to arithmetic.
  const expired = !!wait.expires_at && wait.expires_at <= nowIso;

  const conditions = wait.conditions ?? [];
  if (conditions.length === 0) {
    // Defence against a row this build did not write (a hand-edit, a restore from a backup taken
    // mid-migration). It can never be satisfied, so it must be visible rather than parked.
    return {
      state: "unresolvable",
      reason: "this wait has no conditions, so nothing could ever release it",
      progress: { mode: wait.mode ?? "any", satisfied: 0, total: 0, outstanding: [], dead: [] },
    };
  }

  const verdicts: ConditionVerdict[] = [];
  for (const c of conditions) verdicts.push(await evaluateOne(domain, wait, c, now));

  // Parts already banked from earlier sweeps. UNIONED with what we just observed, never replaced:
  // the receipt that arrived on the 4th stays in even if the request row is later archived, and a
  // join that recomputed from scratch every tick would lose a part the moment a store hiccuped.
  const banked = new Map<number, WaitPart>((wait.parts ?? []).map((p) => [p.index, p]));
  const newly: WaitPart[] = [];
  for (let i = 0; i < verdicts.length; i++) {
    const v = verdicts[i]!;
    if ("by" in v && !banked.has(i)) newly.push({ index: i, by: v.by, at: nowIso });
  }
  const isSatisfied = (i: number) => banked.has(i) || "by" in verdicts[i]!;
  const deadIdx = verdicts.map((v, i) => ("dead" in v ? i : -1)).filter((i) => i >= 0 && !banked.has(i));

  const progress = (): WaitProgress => ({
    mode: wait.mode ?? "any",
    satisfied: wait.mode === "all" ? conditions.filter((_, i) => isSatisfied(i)).length : 0,
    total: conditions.length,
    outstanding: conditions.filter((_, i) => !isSatisfied(i) && !deadIdx.includes(i)).map(describeCondition),
    dead: deadIdx.map((i) => `${describeCondition(conditions[i]!)} (${(verdicts[i] as { dead: string }).dead})`),
  });

  if (wait.mode === "all") {
    // ═══ THE JOIN DOES NOT HANG ═══ One dependency that can never be satisfied means the join can
    // never complete, so it fails NOW and says which part killed it and how far it got — rather than
    // sitting on "6 of 7" until the ninety-day cap while a founder believes the month is closing.
    if (deadIdx.length) {
      const p = progress();
      return {
        state: "unresolvable",
        reason: `${p.satisfied} of ${p.total} are in, but this can never complete: ${p.dead.join("; ")}`,
        progress: p,
      };
    }
    if (conditions.every((_, i) => isSatisfied(i))) {
      // No `index`: every condition fired. The evidence is the parts, and `resumeInput` hands the
      // whole set to the run — "which one fired" for a join is "all of them, on these dates".
      const all = conditions.map((_, i) => banked.get(i) ?? newly.find((n) => n.index === i)!);
      return { state: "satisfied", by: `all:${all.map((p) => p.by).join(",")}`, newly_satisfied: newly };
    }
    const p = progress();
    return expired ? { state: "expired", progress: p } : { state: "pending", progress: p, newly_satisfied: newly };
  }

  // ═══ `any`: FIRST-SATISFIED-WINS, IN ARRAY ORDER ═══
  for (let i = 0; i < verdicts.length; i++) {
    const v = verdicts[i]!;
    // `newly_satisfied` is empty on an OR win, deliberately: a satisfied `any` wait resumes, it does
    // not bank progress, and writing a part on a row that is about to leave `waiting` would be a
    // write that `recordWaitPart` refuses anyway.
    if ("by" in v) return { state: "satisfied", by: v.by, index: i, newly_satisfied: [] };
  }
  const p = progress();
  // EVERY door closed. Distinct from "some door closed": an OR wait whose payment exit died is still
  // perfectly live via its reply exit, and failing it there would throw away a working engagement
  // because one of its three exits went away. Only when there is no exit left is it broken.
  if (deadIdx.length === conditions.length) {
    return { state: "unresolvable", reason: `every way out of this wait is closed: ${p.dead.join("; ")}`, progress: p };
  }
  return expired ? { state: "expired", progress: p } : { state: "pending", progress: p, newly_satisfied: [] };
}

/**
 * One condition against the world. Every store read re-checks the tenant — see `evaluateWait`.
 */
async function evaluateOne(
  domain: DomainStore,
  wait: CaseWait,
  c: WaitCondition,
  now: Date,
): Promise<ConditionVerdict> {
  const nowIso = now.toISOString();
  switch (c.kind) {
    case "date":
      return c.at <= nowIso ? { by: `date:${c.at}` } : { pending: true };

    case "client_reply": {
      const thread = await domain.getThread(c.thread_id);
      if (!thread) return { dead: `thread ${c.thread_id} no longer exists` };
      if (thread.project_id !== wait.project_id) return { dead: "that thread belongs to a different project" };
      const messages = await domain.listMessages(thread.id);
      // STRICTLY AFTER the wait was armed. Without the `>` this is satisfied by the client's own
      // last message — the one we were replying to when we decided to wait — so every
      // client_reply wait would resume on the very first sweep and nothing would ever wait at all.
      const hit = messages.find((m) => m.direction === "inbound" && m.created_at > wait.created_at);
      return hit ? { by: `message:${hit.id}` } : { pending: true };
    }

    case "request_resolved": {
      const req = await getRequestStore().getRequest(wait.project_id, c.request_id);
      if (!req) return { dead: `request ${c.request_id} is not in this project` };
      if (req.status === "resolved") return { by: `request:${req.id}` };
      // CANCELLED IS NOT SATISFACTION, and it is not pending either. The founder withdrew the ask,
      // so the answer is never coming; leaving it `waiting` parks the engagement until the ninety
      // day cap. Surfaced as dead so somebody decides what the engagement does instead — and under
      // `all`, so a month-end close stops pretending it is going to finish.
      if (req.status === "cancelled") return { dead: "the request was withdrawn, so this can never be satisfied" };
      return { pending: true };
    }

    case "invoice_paid": {
      const inv = await getBillingStore().getInvoice(c.invoice_id);
      if (!inv || inv.project_id !== wait.project_id) return { dead: `invoice ${c.invoice_id} is not in this project` };
      // `void` is terminal and unpayable — same argument as a cancelled request.
      if (inv.status === "void") return { dead: "that invoice was voided, so it can never be paid" };
      return inv.status === "paid" ? { by: `invoice:${inv.id}` } : { pending: true };
    }

    case "deliverable_settled": {
      const d = await getDeliverableStore().getDeliverable(wait.project_id, c.deliverable_id);
      // The tenant is in the READ, not checked after it — `getDeliverable` takes the project as a
      // positional argument for exactly this reason, so this branch cannot be written unsafely.
      if (!d) return { dead: `deliverable ${c.deliverable_id} is not in this project` };
      // Withdrawn is terminal and no verdict is coming. The same argument as a cancelled request and
      // a voided invoice: leaving it pending parks the engagement until the ninety-day cap over work
      // that no longer exists.
      if (d.status === "withdrawn") return { dead: "that work was withdrawn, so no answer is coming" };
      // BOTH verdicts satisfy. See the `deliverable_settled` comment in contract.ts: acceptance and
      // a change request are equally "the client answered", and the resumed run is told which by
      // reading the row. A condition that only accepted acceptance would leave a revision request
      // parked behind a nudge ladder chasing a client who had already replied.
      if (d.status === "accepted") return { by: `deliverable:${d.id}:accepted` };
      if (d.status === "changes_requested") return { by: `deliverable:${d.id}:changes_requested` };
      return { pending: true };
    }

    default: {
      // A condition kind this build does not know: a row written by a newer kernel, or a hand-edited
      // one. It must never resume — we cannot know what would satisfy it — and it must never be
      // silently ignored either. `never` here means adding a variant to the union without handling
      // it is a compile error, so this branch only fires on data, never on code.
      const unknown: never = c;
      return { dead: `unknown condition kind: ${JSON.stringify((unknown as { kind?: unknown })?.kind)}` };
    }
  }
}

/**
 * How far along, in one sentence a founder can read.
 *
 * ONE implementation, used by the nudge note, the expiry note, the `/next` waiting list and the
 * `unblock_wait` move. "Waiting on 3 of 7 receipts" written four times in four modules is four
 * sentences that disagree the first time somebody changes what counts as outstanding — and this
 * particular sentence is the whole visible value of the join.
 */
export function describeProgress(p: WaitProgress): string {
  const outstanding = p.outstanding.length ? ` — still waiting on ${p.outstanding.join(", ")}` : "";
  const dead = p.dead.length ? `; dead ends: ${p.dead.join("; ")}` : "";
  if (p.mode !== "all" || p.total <= 1) {
    // An OR wait has no meaningful count: nothing is banked, because the first thing that lands
    // resumes it. What it has is a list of the doors that are still open, which is the useful half.
    return `${outstanding.replace(/^ — /, "") || "waiting"}${dead}`;
  }
  return `${p.satisfied} of ${p.total} in${outstanding}${dead}`;
}

// ── coherence: what crosses the wait ─────────────────────────────────────────────────────────────

/**
 * The input the resumed run receives.
 *
 * ═══ INTENT FROZEN, FACTS LIVE ═══
 *
 * `wait.resume.input` is spread FIRST and everything below overwrites it. That ordering is the whole
 * policy:
 *
 *   · The INTENT is frozen at the moment we stopped — "you were drafting the statement of work for
 *     the scope they asked about". Without it a resumed run has no idea what it was doing and starts
 *     the engagement over, which is the "task runner" failure the vision names.
 *   · The FACTS are read live from the Case at resume time. A fortnight is long enough for the stage
 *     to have moved, the data to have grown and another episode to have run; handing the run a
 *     snapshot of the engagement as it was when we paused means it acts on a picture that is two
 *     weeks stale, and the most expensive version of that is re-billing work that was billed while
 *     it waited.
 *
 * What is deliberately NOT carried: the model's conversation. Nothing durable holds a half-finished
 * OpenCode session — the sandbox is destroyed in `runTask`'s `finally` — so a resume is a NEW run
 * with the engagement's state, not a revived one. Claiming otherwise would be a lie the second time
 * a container restarts, and a lie about continuity is worse than an honest restart from state.
 *
 * `case` and `client_id` use the same keys `POST /v1/cases/:id/tasks` uses, so a wedge cannot tell a
 * resumed episode from a fresh one by shape — only by `resumed_from_wait`, which is there so it can.
 */
export function resumeInput(wait: CaseWait, kase: Case): Record<string, unknown> {
  return {
    ...(wait.resume.input ?? {}),
    case: { id: kase.id, title: kase.title, stage: kase.stage, data: kase.data },
    client_id: kase.client_id,
    resumed_from_wait: {
      wait_id: wait.id,
      reason: wait.reason,
      mode: wait.mode,
      conditions: wait.conditions,
      /**
       * WHICH ONE FIRED. The whole reason OR is worth having.
       *
       * A chase parked on "they pay OR they reply OR the deadline arrives" resumes for three quite
       * different reasons and the correct next move differs for each: draft a thank-you, read the
       * dispute, escalate. Handing the run only `satisfied_by: "message:9f3c"` makes it re-derive
       * the answer from an id, and the cheapest wrong derivation — re-read the invoice, see it
       * unpaid, draft a chase — sends a dunning email to the client who just wrote to dispute it.
       *
       * Undefined on a join: `satisfied_parts` below is the answer there, and it is a richer one.
       */
      satisfied_condition:
        wait.satisfied_index === undefined ? undefined : wait.conditions?.[wait.satisfied_index],
      satisfied_index: wait.satisfied_index,
      satisfied_by: wait.satisfied_by,
      /** For a join: every part, with the date each landed. "All seven receipts, 4th to the 19th." */
      satisfied_parts: wait.mode === "all" ? (wait.parts ?? []) : undefined,
      waited_since: wait.created_at,
      satisfied_at: wait.satisfied_at,
      nudges_sent: wait.nudge_count,
    },
  };
}

// ── resuming ─────────────────────────────────────────────────────────────────────────────────────

export type ResumeResult =
  | { ok: true; wait: CaseWait; task_id: string }
  | { ok: false; reason: "lost_claim" | "not_configured" | "wedge_disabled" | "case_gone" | "spawn_failed"; message: string };

/**
 * Resume ONE wait. The single implementation — the sweep and the route both call this.
 *
 * The order is not negotiable: CLAIM, then spawn, then settle. Claiming last would mean the spawn
 * happens before anything has established the right to do it, and two replicas would both spawn and
 * then argue about who gets to record it. That is the double-invoice bug with a tidier audit trail.
 */
export async function resumeWait(
  domain: DomainStore,
  wait: CaseWait,
  satisfiedBy: string,
  now = new Date(),
  /**
   * WHICH condition won, for an `any` wait. Written by the claim itself, in one statement — see
   * `CaseWait.satisfied_index`. Undefined for a join, where the answer is "all of them".
   */
  satisfiedIndex?: number,
): Promise<ResumeResult> {
  if (!deps) return { ok: false, reason: "not_configured", message: "resumption is not wired up in this deployment" };

  // ═══ THE EXACTLY-ONCE GATE ═══ One statement, `waiting` → `resuming`. Everything after it runs on
  // a row this caller provably owns. A second replica, and a second satisfaction of the same
  // condition, both land here and both get `undefined`.
  //
  // STILL ONE STATEMENT AFTER OR AND THE JOIN, which is the property every added condition threatens.
  // The claim is per-WAIT: a wait with six conditions of which four are satisfied is claimed exactly
  // as a wait with one is, because `evaluateWait` collapses however many satisfied conditions into
  // one verdict before we get here. Two replicas that picked the same winner, two replicas that
  // picked different winners, and one client who both pays and replies inside five minutes all
  // produce one winning UPDATE and one resumed run.
  const claimed = await domain.claimWait(wait.project_id, wait.id, satisfiedBy, now.toISOString(), satisfiedIndex);
  if (!claimed) {
    return { ok: false, reason: "lost_claim", message: "another replica is already resuming this wait" };
  }

  const fail = async (
    reason: "case_gone" | "wedge_disabled" | "spawn_failed",
    message: string,
  ): Promise<ResumeResult> => {
    // Terminal and visible. NOT back to `waiting`: a wait that returns to the pool after a failed
    // resume is a retry loop against whatever just refused it, and if the refusal came after a
    // partial side effect it is also a second one.
    await domain.settleWait(wait.project_id, wait.id, "failed", { error: message }, ["resuming"]).catch(() => {});
    await domain
      .updateCase(wait.case_id, {}, { at: now.toISOString(), kind: "note", note: `resume failed: ${message}`, actor: "system" })
      .catch(() => {});
    return { ok: false, reason, message };
  };

  // Re-read AFTER the claim, not before. This is the live-facts half of `resumeInput`, and reading it
  // earlier would race the very window the claim exists to close.
  const kase = await domain.getCase(wait.case_id);
  if (!kase || kase.project_id !== wait.project_id) return fail("case_gone", "the engagement this wait belonged to is gone");
  if (!deps.wedgeEnabled(wait.project_id, kase.wedge)) {
    // A founder turned the wedge off while the engagement was parked. Resuming into a disabled wedge
    // would run work the business has said it no longer does.
    return fail("wedge_disabled", `the ${kase.wedge} wedge is no longer enabled for this business`);
  }

  let taskId: string;
  try {
    taskId = await deps.spawnTask({
      project_id: wait.project_id,
      wedge: kase.wedge,
      task_type: wait.resume.task_type,
      client_id: kase.client_id,
      case_id: kase.id,
      // `schedule`, because the sweep decided. An operator reading the task list needs to tell "the
      // wait came good on its own" from "somebody clicked resume".
      source: "schedule",
      // The SAME constraints, wedge manifest and queue every other task gets. This is the line that
      // keeps a resume from being a way around an approval — see the header.
      input: resumeInput(claimed, kase),
    });
  } catch (e) {
    return fail("spawn_failed", `could not start the resumed run: ${(e as Error).message}`);
  }

  const settled = await domain.settleWait(wait.project_id, wait.id, "resumed", { resumed_task_id: taskId }, ["resuming"]);
  await domain
    .updateCase(kase.id, {}, { at: now.toISOString(), kind: "task_spawned", task_id: taskId, note: `resumed: ${wait.reason}`, actor: "system" })
    .catch(() => {});
  return { ok: true, wait: settled ?? { ...claimed, status: "resumed", resumed_task_id: taskId }, task_id: taskId };
}

// ── the way back from a stalled resume ───────────────────────────────────────────────────────────

export type RearmResult =
  | { ok: true; wait: CaseWait }
  | { ok: false; reason: "not_found" | "not_stuck" | "too_soon" | "already_ran" | "exhausted"; message: string };

/**
 * Put a wait that stalled mid-resume back on the sweep's list.
 *
 * ═══ WHY THIS EXISTS AT ALL ═══
 *
 * The claim deliberately never releases (see rule 2 in the header): a lease would trade a stuck
 * engagement for a duplicate invoice, and that is the wrong trade. But "requires a human" was, until
 * now, only half true — `GET /v1/waits` showed the stuck row and offered `cancel`, which spawns
 * nothing, so the founder's actual recovery was to re-create the wait by hand with the same
 * condition, the same resume input and the same reason. Retyping a durable row is not a recovery
 * path; it is the founder doing the database's job, badly, at the worst possible moment.
 *
 * ═══ WHY THIS IS NOT A SECOND WAY TO RESUME ═══
 *
 * A re-arm is a NEW claim on a wait whose previous claim never completed, and the reason the claim
 * never releases is that we cannot tell a crashed resume from a slow one. That is resolved in three
 * mechanical parts and one honest one:
 *
 *   1. IT DOES NOT RESUME. This function moves `resuming` → `waiting` and spawns NOTHING. The next
 *      sweep re-evaluates the condition from scratch and, if it is still met, resumes through
 *      `resumeWait` — same `claimWait`, same `spawnTask`, same clamped constraints, same manifest,
 *      same approval gate. There is no path from this function to an outbound anything.
 *   2. A RESUME THAT GOT ANYWHERE IS NOT RE-ARMABLE. `resumed_task_id IS NULL` is in the WHERE
 *      clause. A resume that recorded its run did run, and re-arming that one is how you get two.
 *   3. A LIVE RESUME IS NOT RE-ARMABLE. `updated_at <= now - REARM_STUCK_AFTER_MINUTES` — the claim
 *      stamps `updated_at`, so a resume still in flight fails the guard. This is what stops "the
 *      founder was impatient" from becoming "the client got two chases".
 *
 * And the honest part: inside that fifteen-minute window a resume could in principle still be alive
 * and about to spawn, and no query can prove otherwise. So the founder is ASSERTING that nothing came
 * of it. `by` records who asserted it, the case timeline records that they did, and the UI says so in
 * those words rather than implying the system checked. A guarantee we cannot make must not be
 * described as one.
 */
export async function rearmWait(
  domain: DomainStore,
  args: { project_id: string; wait_id: string; by: string },
  now = new Date(),
): Promise<RearmResult> {
  if (!args.project_id) return { ok: false, reason: "not_found", message: "not found" };
  const nowIso = now.toISOString();
  const rearmed = await domain.rearmWait({
    projectId: args.project_id,
    id: args.wait_id,
    stuckBefore: new Date(now.getTime() - REARM_STUCK_AFTER_MINUTES * 60_000).toISOString(),
    maxRearms: MAX_REARMS,
    by: args.by,
    nowIso,
  });
  if (rearmed) {
    // ON THE ENGAGEMENT'S OWN TIMELINE, with the name of the person who asserted it. Law 6: a wait
    // that silently changed state twice, once by a crash and once by a human, is unreadable
    // afterwards — and this is the one state change in the module that a machine did not decide.
    await domain
      .updateCase(rearmed.case_id, {}, {
        at: nowIso,
        kind: "note",
        note: `re-armed a stalled resume (attempt ${rearmed.rearm_count} of ${MAX_REARMS}): ${rearmed.reason}`,
        actor: args.by,
      })
      .catch(() => {});
    return { ok: true, wait: rearmed };
  }

  // The claim was lost, and the five reasons are five different sentences to a founder. Re-read
  // SCOPED BY PROJECT — a lost re-arm must never be the thing that reveals another tenant's row, and
  // `getWait` takes the tenant as an argument precisely so this cannot be a fetch-then-compare.
  const fresh = await domain.getWait(args.project_id, args.wait_id);
  if (!fresh) return { ok: false, reason: "not_found", message: "not found" };
  if (fresh.status !== "resuming") {
    return {
      ok: false,
      reason: fresh.status === "resumed" ? "already_ran" : "not_stuck",
      message: `That wait is ${fresh.status}, not stuck part-way through resuming — there is nothing to re-arm.`,
    };
  }
  if (fresh.resumed_task_id) {
    return {
      ok: false,
      reason: "already_ran",
      message: "That resume already started its run — re-arming it would run the work a second time.",
    };
  }
  if (fresh.rearm_count >= MAX_REARMS) {
    return {
      ok: false,
      reason: "exhausted",
      message: `This resume has stalled ${MAX_REARMS} times. Something about it is broken, and a fourth attempt will not find out what.`,
    };
  }
  return {
    ok: false,
    reason: "too_soon",
    message: `That resume was still running ${REARM_STUCK_AFTER_MINUTES} minutes ago, so it may not have stalled at all. Give it a few minutes.`,
  };
}

// ── the sweep ────────────────────────────────────────────────────────────────────────────────────

export interface WaitSweepSummary {
  project_id: string;
  considered: number;
  resumed: number;
  nudged: number;
  expired: number;
  /** Waits we could not evaluate. Non-zero means somebody has to look — see `failed_ids`. */
  broken: number;
  still_waiting: number;
  /**
   * Conditions of a JOIN that came good this tick without completing it. "Two more receipts landed."
   *
   * Counted separately from `still_waiting` because they are the opposite signal: a join that banked
   * three parts this morning is moving, and one that has banked none in a fortnight is the one worth
   * looking at. Without this the sweep summary reports a healthy month-end close and a dead one with
   * exactly the same numbers.
   */
  progressed: number;
  failed_ids: string[];
}

/**
 * One pass over a project's live waits.
 *
 * `project_id` is a required field of a required argument, and it THROWS on empty. There is no
 * overload that sweeps every tenant. The alternative — an optional project with a `?? ""` at the
 * call site — is exactly how the two cross-tenant leaks this codebase has shipped got in, and here
 * it would resume one founder's engagements against another founder's connections.
 */
export async function sweepWaits(args: { domain: DomainStore; project_id: string; now?: Date }): Promise<WaitSweepSummary> {
  const now = args.now ?? new Date();
  const nowIso = now.toISOString();
  const summary: WaitSweepSummary = {
    project_id: args.project_id,
    considered: 0, resumed: 0, nudged: 0, expired: 0, broken: 0, still_waiting: 0, progressed: 0, failed_ids: [],
  };
  if (!args.project_id) throw new Error("a wait sweep must be scoped to a project");
  const domain = args.domain;

  const open = await domain.listWaits({ project_id: args.project_id, status: "waiting", limit: BATCH });
  for (const wait of open) {
    summary.considered++;
    try {
      const verdict = await evaluateWait(domain, wait, now);

      // ═══ BANK WHAT LANDED, BEFORE ANYTHING ELSE IS DECIDED ═══
      //
      // Before the resume, because `claimWait` returns the row the resumed run is built from and a
      // join that banked its last part AFTER the claim hands the run "6 of 7 in" for a month that is
      // complete. Before the nudge, because the nudge quotes the progress and a founder reading
      // "still waiting (3 of 7)" the morning after the fourth receipt arrived stops trusting the
      // number. Before the expiry note, so "gave up at 6 of 7" is the truth rather than "gave up at
      // 5 of 7" plus a receipt that landed in the same tick.
      //
      // Idempotent by index in one statement, so two replicas sweeping the same join write each part
      // once — and, crucially, a lost or duplicated part CANNOT cause a second resume, because
      // completeness is recomputed from the world and the resume is still won by the single
      // `claimWait`. See `WaitPart`.
      if ("newly_satisfied" in verdict) {
        for (const part of verdict.newly_satisfied) {
          const banked = await domain.recordWaitPart(wait.project_id, wait.id, part);
          if (!banked) continue;
          summary.progressed++;
          await domain
            .updateCase(wait.case_id, {}, {
              at: nowIso,
              kind: "note",
              note: `${describeCondition(wait.conditions[part.index]!)} is in (${banked.parts.length} of ${wait.conditions.length}): ${wait.reason}`,
              actor: "system",
            })
            .catch(() => {});
        }
      }

      if (verdict.state === "satisfied") {
        // ONE resume, whichever condition (or all of them) got us here — `verdict.index` is written
        // by the same statement that wins the claim, so a founder and the resumed run read the same
        // answer to "why did this wake up".
        const r = await resumeWait(domain, wait, verdict.by, now, verdict.index);
        if (r.ok) summary.resumed++;
        else if (r.reason === "lost_claim") summary.still_waiting++;
        else { summary.broken++; summary.failed_ids.push(wait.id); }
        continue;
      }

      if (verdict.state === "unresolvable") {
        // Fail CLOSED and LOUD. It does not resume, and it does not stay on the pending list where it
        // would look healthy — vision Law 6, and the difference between a system that stopped and a
        // system that is quietly broken.
        await domain.settleWait(wait.project_id, wait.id, "failed", { error: verdict.reason }, ["waiting"]);
        await domain
          .updateCase(wait.case_id, {}, { at: nowIso, kind: "note", note: `wait broken: ${verdict.reason}`, actor: "system" })
          .catch(() => {});
        summary.broken++;
        summary.failed_ids.push(wait.id);
        continue;
      }

      if (verdict.state === "expired") {
        // Expiry ends the WAIT, not the engagement, and it spawns nothing. "The condition never
        // arrived" is a judgement call about a client relationship — drop them, call them, re-scope —
        // and a system that picked one automatically would be autonomy where no evidence earned it.
        // The case stays open with the expiry on its timeline, so it lands in front of a founder.
        await domain.settleWait(wait.project_id, wait.id, "expired", undefined, ["waiting"]);
        await domain
          .updateCase(
            wait.case_id, {},
            {
              at: nowIso,
              kind: "note",
              // The progress is in the sentence because it changes what a founder does about it. A
              // month-end close that expired at 6 of 7 needs one phone call; one that expired at 0
              // of 7 means the client never engaged at all, and those are different conversations.
              note:
                `gave up waiting: ${wait.reason} (${wait.nudge_count} nudge(s), no answer` +
                `${verdict.progress.total > 1 ? `; ${describeProgress(verdict.progress)}` : ""})`,
              actor: "system",
            },
          )
          .catch(() => {});
        summary.expired++;
        continue;
      }

      // Still pending — is a nudge due? The claim is atomic for the same reason the resume claim is:
      // two replicas that both read "2 of 3 nudges sent" chase the client twice on the same morning.
      const next = new Date(now.getTime() + DEFAULT_NUDGE_DAYS * DAY_MS).toISOString();
      const nudged = await domain.claimWaitNudge(wait.project_id, wait.id, nowIso, next);
      if (nudged) {
        // A NOTE, NOT A SEND. Nudging is a founder-facing signal (and, through the case timeline, a
        // move the /next surface can rank), never an outbound message from here: an email sent by a
        // sweep is an email that never met an approval gate. See the header.
        await domain
          .updateCase(
            wait.case_id, {},
            {
              at: nowIso,
              kind: "note",
              // "Waiting on 3 of 7 receipts" is what makes the nudge MEANINGFUL rather than nagging:
              // it names what is actually missing, which is the thing the client has to act on.
              note:
                `still waiting (nudge ${nudged.nudge_count}/${nudged.max_nudges}): ${wait.reason}` +
                ` — ${describeProgress(verdict.progress)}`,
              actor: "system",
            },
          )
          .catch(() => {});
        summary.nudged++;
      }
      summary.still_waiting++;
    } catch (e) {
      // One broken wait must not stop the other forty-nine — the same rule `advanceSequences` states.
      // Counted as broken rather than swallowed, so a systematic failure is visible in the summary.
      console.error(`[mycel] wait ${wait.id} could not be swept:`, (e as Error)?.message ?? e);
      summary.broken++;
      summary.failed_ids.push(wait.id);
    }
  }
  return summary;
}

/**
 * Create (or find) the sweeping Schedule for a project.
 *
 * One per project, always scoped. `claimDueSchedules` does the rest, including the guarantee that
 * with four replicas exactly one of them fires each tick. Modelled on `ensureDunningSchedule`, and it
 * throws on an empty project id for the same reason that one does.
 */
export async function ensureWaitSchedule(domain: DomainStore, projectId: string, now: Date = new Date()) {
  if (!projectId) throw new Error("a wait schedule must be scoped to a project");
  const existing = (await domain.listSchedules()).find(
    (s) => s.project_id === projectId && s.task_type === WAIT_SWEEP_TASK_TYPE,
  );
  if (existing) return existing;
  return domain.createSchedule({
    project_id: projectId,
    name: "resume work that was waiting",
    wedge: WAITS_WEDGE,
    task_type: WAIT_SWEEP_TASK_TYPE,
    input: {},
    cadence: { kind: "every", seconds: SWEEP_SECONDS },
    enabled: true,
    next_run_at: new Date(now.getTime() + SWEEP_SECONDS * 1000).toISOString(),
  });
}
