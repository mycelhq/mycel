// What state the week is in, decided by dates rather than by a model reading dates.
//
// ─── WHY THIS IS NOT THE MODEL'S JOB ───
//
// Three of the four judgements below look like reasoning and are not:
//
//   1. WHO IS HOLDING THE TIMESHEET UP. A contractor who submitted on Sunday and is waiting on the
//      client's manager to approve must never be chased as though they had not submitted. That is
//      not a tone problem, it is the fastest way to lose a good contractor to the agency down the
//      road, and it is decided entirely by two booleans.
//   2. WHETHER A CLIENT-WEEK IS BILLABLE. Every assignment for that client, that week, approved —
//      not most of them. A partially billed week is the disputed-invoice failure that
//      `bill_lines.mjs` exists to prevent, reached from the other end.
//   3. WHETHER AN ASSIGNMENT HAS ENTERED ITS NOTICE WINDOW. Date arithmetic. A model asked to
//      compare two ISO dates under a long prompt gets it right nearly always, and nearly always is
//      how a desk loses a renewal it had three weeks to ask for.
//
// The fourth — what to actually say — is the model's, and lives in skills/chase-a-contractor.md.
//
// Founder code, run in the harness process at full trust. Pure: `today` is passed in, never read
// from a clock, so a week can be replayed and a test can pin a Monday.

/** Whole days from `a` to `b`, both ISO `YYYY-MM-DD`. Negative when `b` is before `a`. */
function daysBetween(a, b) {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  if (!Number.isFinite(ms)) throw new Error(`could not read the dates ${JSON.stringify(a)} and ${JSON.stringify(b)}`);
  // Exact: both operands are UTC midnight, so the difference is always a whole number of days. No
  // timezone can make this off-by-one, which is the entire reason the dates are handled as strings
  // and pinned to UTC rather than as local `Date`s.
  return Math.round(ms / 86400000);
}

function isoDate(v, where) {
  const s = String(v ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new Error(`${where} must be an ISO date like 2026-08-08, got ${JSON.stringify(v)}`);
  }
  if (Number.isNaN(Date.parse(`${s}T00:00:00Z`))) throw new Error(`${where} is not a real date: ${s}`);
  return s;
}

/** Default notice window. Three weeks is the trade's own convention, and intake overrides it. */
const DEFAULT_NOTICE_DAYS = 21;

export default function weekStatus(args) {
  const today = isoDate(args?.today, "today");
  const weekEnding = isoDate(args?.week_ending, "week_ending");
  const noticeDays =
    args?.notice_days === undefined || args?.notice_days === null
      ? DEFAULT_NOTICE_DAYS
      : Number(args.notice_days);
  if (!Number.isSafeInteger(noticeDays) || noticeDays < 0) {
    throw new Error(`notice_days must be a non-negative whole number of days, got ${JSON.stringify(args?.notice_days)}`);
  }

  const assignments = Array.isArray(args?.assignments) ? args.assignments : null;
  if (!assignments) throw new Error("assignments must be an array");

  const missing = [];
  const endingSoon = [];
  /** client → { complete: assignment ids, blocked: true } — a week is billable only if none blocked. */
  const byClient = new Map();

  for (const [i, a] of assignments.entries()) {
    const where = `assignments[${i}]`;
    const id = String(a?.id ?? "").trim();
    if (!id) throw new Error(`${where}: id is required`);
    const contractor = String(a?.contractor ?? "").trim();
    const client = String(a?.client ?? "").trim();
    if (!client) throw new Error(`${where} (${id}): client is required — a week cannot be grouped into an invoice without one`);

    const submitted = a?.submitted === true;
    const approved = a?.approved === true;
    // The due date defaults to the week end rather than to `today`. Defaulting to today would make
    // every unsubmitted timesheet exactly zero days late forever, which is a number that always
    // looks fine.
    const due = a?.timesheet_due ? isoDate(a.timesheet_due, `${where}.timesheet_due`) : weekEnding;

    const bucket = byClient.get(client) ?? { complete: [], blocked: false };
    byClient.set(client, bucket);

    if (approved) {
      bucket.complete.push(id);
    } else {
      bucket.blocked = true;
      const daysLate = Math.max(0, daysBetween(due, today));
      missing.push({
        assignment_id: id,
        contractor,
        client,
        days_late: daysLate,
        // The distinction the whole chase depends on. `submitted_not_approved` is the client's
        // problem and the contractor must not hear about it.
        state: submitted ? "submitted_not_approved" : "not_submitted",
        chases_sent: Number.isSafeInteger(a?.chases_sent) ? a.chases_sent : 0,
      });
    }

    if (a?.end_date) {
      const endDate = isoDate(a.end_date, `${where}.end_date`);
      const daysLeft = daysBetween(today, endDate);
      // Already ended is NOT "ending soon" — it is a case that should have moved to `ended` or
      // `lapsed`, and listing it here would put a renewal conversation in front of a desk head for
      // an assignment that finished last month.
      if (daysLeft >= 0 && daysLeft <= noticeDays) {
        endingSoon.push({ assignment_id: id, contractor, client, end_date: endDate, days_left: daysLeft });
      }
    }
  }

  const readyToBill = [];
  for (const [client, bucket] of byClient) {
    if (bucket.blocked || bucket.complete.length === 0) continue;
    readyToBill.push({ client, assignment_ids: bucket.complete });
  }

  // Deterministic ordering on every list. Two runs over the same week must produce byte-identical
  // output, or a diff of last week against this one is unreadable and an artifact hash means nothing.
  missing.sort((x, y) => y.days_late - x.days_late || x.assignment_id.localeCompare(y.assignment_id));
  endingSoon.sort((x, y) => x.days_left - y.days_left || x.assignment_id.localeCompare(y.assignment_id));
  readyToBill.sort((x, y) => x.client.localeCompare(y.client));

  return {
    week_ending: weekEnding,
    missing,
    ready_to_bill: readyToBill,
    ending_soon: endingSoon,
    counts: {
      assignments: assignments.length,
      missing: missing.length,
      waiting_on_client: missing.filter((m) => m.state === "submitted_not_approved").length,
      ready_to_bill: readyToBill.length,
      // Clients with SOMETHING approved and something not. The number a desk head actually wants on
      // a Monday: these are the invoices that will not go out today, named as such rather than
      // quietly absent from `ready_to_bill`.
      part_complete_clients: [...byClient.values()].filter((b) => b.blocked && b.complete.length > 0).length,
      ending_soon: endingSoon.length,
    },
  };
}
