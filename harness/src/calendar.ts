// WHAT IS NEXT, across every engagement — the read the product could not do.
//
// ═══ WHY THIS DID NOT EXIST ═══
//
// The pipeline has had a `booked` stage since it was written, the meeting bot has joined calls and
// filed transcripts for months, and `syncCalendar` has pulled events from a connected calendar. What
// there was never was a place that answered "when is this meeting?" — the most ordinary question a
// founder asks about a booked lead. The answer lived in whichever inbox the invite landed in.
//
// A calendar is a SORT, not a record. The value is entirely in the ordering — what is next, what is
// today, what was missed — and nothing in the system could produce that ordering because nothing
// carried the time. `Case.meeting_at` is the column that makes this possible; this is the read.
//
// ═══ WHAT IT DELIBERATELY SHOWS THAT A CALENDAR APP WOULD NOT ═══
//
// The two failures. A `booked` case whose meeting time has PASSED and which never moved to `met` is
// the most recoverable state in the pipeline and the one most likely to be silently abandoned —
// `booked` looks like progress for ever. And a `booked` case with no time at all is a meeting nobody
// can name the hour of, which is the one that gets missed.
//
// Google Calendar shows you what you put in it. This shows you what fell out.
import type { Case } from "./contract";

export interface CalendarEntry {
  case_id: string;
  title: string;
  client_id?: string;
  stage: string;
  /** ISO-8601. Absent only on `missing_time`, where its absence is the finding. */
  meeting_at?: string;
  meeting_url?: string;
  /**
   * `upcoming` — booked, in the future, nothing to do but prepare.
   * `today` — booked, within the day. Separated because "today" is a different feeling from "soon".
   * `overdue` — the time has passed and the case never moved to `met`. Somebody has to say what
   *   happened, and until they do the pipeline is reporting a meeting that may not have occurred.
   * `missing_time` — booked with no time. A defect, surfaced rather than hidden.
   */
  state: "today" | "upcoming" | "overdue" | "missing_time";
  /** Who the meeting is with — from the prospect case, so the calendar can show a face. */
  person?: {
    name: string;
    profile_id?: string;
    title?: string;
    company?: string;
    photo_url?: string;
    email?: string;
  };
}

/** How long after a meeting's time before an unmoved `booked` case is treated as unanswered. */
const GRACE_MS = 2 * 60 * 60 * 1000;

/**
 * The calendar, soonest first, with the two failure states at the top.
 *
 * ORDERING IS THE PRODUCT. `overdue` and `missing_time` come first because they are the only two
 * rows anybody has to act on — an upcoming meeting needs nothing until it arrives. A calendar that
 * sorts purely by time buries the missed meeting under next week's, which is exactly how it stays
 * missed.
 */
export function buildCalendar(cases: readonly Case[], now = new Date()): CalendarEntry[] {
  const t = now.getTime();
  const endOfDay = new Date(now);
  endOfDay.setHours(23, 59, 59, 999);

  const entries: CalendarEntry[] = [];
  for (const k of cases) {
    // Only a booked meeting is a calendar entry. A `met` case is history and a `won` one is a
    // client — neither is something to be at.
    if (k.stage !== "booked" || k.status !== "open") continue;
    const person = personFromCase(k);
    const meeting_url = person.meeting_url;
    const who = person.who;
    const base = {
      case_id: k.id,
      title: k.title,
      client_id: k.client_id,
      stage: k.stage,
      ...(meeting_url ? { meeting_url } : {}),
      ...(who ? { person: who } : {}),
    };
    if (!k.meeting_at) {
      entries.push({ ...base, state: "missing_time" });
      continue;
    }
    const at = Date.parse(k.meeting_at);
    if (!Number.isFinite(at)) {
      // An unparseable timestamp is the same problem as no timestamp, and pretending otherwise puts
      // a row on the calendar at the epoch.
      entries.push({ ...base, state: "missing_time" });
      continue;
    }
    const state =
      at + GRACE_MS < t ? "overdue" : at <= endOfDay.getTime() ? "today" : "upcoming";
    entries.push({ ...base, meeting_at: k.meeting_at, state });
  }

  const rank: Record<CalendarEntry["state"], number> = {
    overdue: 0,
    missing_time: 1,
    today: 2,
    upcoming: 3,
  };
  return entries.sort((a, b) => {
    if (rank[a.state] !== rank[b.state]) return rank[a.state] - rank[b.state];
    // Within a band, soonest first. A missing time sorts last of its own band rather than throwing.
    return (a.meeting_at ?? "9999").localeCompare(b.meeting_at ?? "9999");
  });
}

/** One line a founder reads without opening anything. Empty when there is genuinely nothing. */
export function calendarSummary(entries: readonly CalendarEntry[]): string {
  const n = (s: CalendarEntry["state"]) => entries.filter((e) => e.state === s).length;
  const bits: string[] = [];
  // Problems first, in the same order the list is sorted, so the sentence and the list agree.
  if (n("overdue")) bits.push(`${n("overdue")} meeting${n("overdue") === 1 ? "" : "s"} passed with no outcome recorded`);
  if (n("missing_time")) bits.push(`${n("missing_time")} booked with no time`);
  if (n("today")) bits.push(`${n("today")} today`);
  if (n("upcoming")) bits.push(`${n("upcoming")} coming up`);
  return bits.join(" · ");
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function personFromCase(k: Case): {
  meeting_url?: string;
  who?: CalendarEntry["person"];
} {
  const d = (k.data ?? {}) as Record<string, unknown>;
  const name = str(d.name) ?? k.title;
  const profile_id = str(d.profile_id);
  const title = str(d.title) ?? str(d.headline);
  const company = str(d.company) ?? str(d.company_name);
  const photo_url = str(d.photo_url);
  const email = str(d.contact_email) ?? str(d.email);
  const meeting_url = str(d.meeting_url);
  const who =
    name || profile_id || title || company || photo_url || email
      ? { name: name || "Meeting", ...(profile_id ? { profile_id } : {}), ...(title ? { title } : {}), ...(company ? { company } : {}), ...(photo_url ? { photo_url } : {}), ...(email ? { email } : {}) }
      : undefined;
  return { meeting_url, who };
}

/**
 * Which open case a booking belongs to — email first, then LinkedIn slug if the payload carried one.
 *
 * Does not create people. A stranger booking a public page is a calendar fact, not a new lead.
 */
export function matchBookingCase(
  cases: readonly Case[],
  emails: readonly string[],
): Case | undefined {
  const want = new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean));
  if (!want.size) return undefined;
  const open = cases.filter((k) => k.status === "open");
  for (const k of open) {
    const d = (k.data ?? {}) as Record<string, unknown>;
    const email = (str(d.contact_email) ?? str(d.email) ?? "").toLowerCase();
    if (email && want.has(email)) return k;
  }
  return undefined;
}
