// What we keep off somebody's calendar, and what we refuse to.
//
// ═══ THE PROBLEM, PUT PLAINLY ═══
//
// `syncCalendar` read a connected calendar and wrote EVERY event into the record store with
// `data: { ...event }` — title included. A founder who connects Google Calendar so we can see when
// their client call is has also handed us "Oncology follow-up, 09:30" and "Dad's funeral". We were
// storing it, and nothing in the product ever read it.
//
// That is not a hypothetical about a future feature. It is what the code did, and the fix is not a
// setting: a checkbox that says "do not store my personal events" is a promise the storage layer
// has to keep anyway, so the storage layer should keep it without being asked.
//
// ═══ THE LINE: THE SHAPE OF YOUR WEEK IS OURS, THE CONTENT OF IT IS NOT ═══
//
// Two different facts live in a calendar event and they have completely different sensitivity:
//
//   · WHEN you are busy. A booking desk needs it, it is what a shared free/busy has meant since
//     Exchange, and it discloses nothing — "busy 09:30 to 10:15" is true of a client call and a
//     hospital appointment alike.
//   · WHAT you are doing. This is the private half, and the product needs it for exactly one class
//     of event: the meetings that are OURS — a call with somebody in the book.
//
// So: every event keeps its times. Only an attributable event keeps its title and its join link.
// Everything else is stored as a busy block with no words in it at all.
//
// ═══ WHY ATTRIBUTION IS BY NAME AND URL RATHER THAN BY ATTENDEE ═══
//
// Attendee lists would be the right signal and `ObservedEvent` does not carry one — the normaliser
// never took it, from Google or from Microsoft. Adding it means asking for a wider scope on the
// connection, which is the opposite direction from this file.
//
// What is available is the title and the join link, and between them they are enough:
//
//   · A NAME WE ALREADY KNOW in the title. If "Hart's Bakery" is a client of yours, "Hart's Bakery
//     — quarterly" is a work meeting. We knew the name before we read the calendar; learning it is
//     on the calendar tells us nothing new about the founder.
//   · A JOIN LINK we would be asked to join. Mycel notes joins Meet, Zoom and Teams; an event with
//     one of those is a call, and a call is the thing this product is for.
//
// Both are conservative in the direction that matters: an unattributable work meeting loses its
// title (annoying, recoverable — the founder can name it) rather than a private one keeping its
// title (not recoverable, and not ours to lose).
import type { ObservedEvent } from "./capabilities.normalise";

/** What survives redaction. Times always; words only when the event is attributable. */
export interface RedactedEvent {
  external_id: string;
  starts_at?: string;
  ends_at?: string;
  day?: string;
  all_day: boolean;
  busy: boolean;
  time_zone?: string;
  status_hint?: string;
  /** Present ONLY when attributable. Absent means "we deliberately did not keep it". */
  title?: string;
  /** Present ONLY when attributable, and only for a host we would actually join. */
  meeting_url?: string;
  /**
   * Why the words were kept, so the reason survives into the record rather than living only here.
   *
   * `undefined` on a redacted event, which is the common case and reads correctly in a dump: no
   * reason to keep it, so nothing kept.
   */
  matched?: "known_name" | "join_link";
}

/**
 * Fold to something two spellings of the same business agree on.
 *
 * APOSTROPHES ARE DELETED, not turned into spaces. Folding "Hart's Bakery" through a generic
 * non-alphanumeric replace gives `hart s bakery`, whose distinguishing token is `hart` — and `hart`
 * does not appear as a whole word in "Harts Bakery — kickoff", so the client's own meeting failed to
 * match their own name. Caught by the test; it is the single most likely spelling difference between
 * a name typed into our client list and the same name typed into a calendar invite.
 */
const fold = (s: string): string =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * Words too common to attribute anything by.
 *
 * A client called "The Studio" would otherwise make every event with the word "studio" in it a work
 * meeting, and a client called "Design" would take the whole calendar. This is not a general
 * stopword list — it is the set of words that are, on their own, no evidence at all.
 */
const WEAK = new Set([
  "the", "and", "ltd", "limited", "llc", "inc", "co", "company", "group", "studio", "design",
  "agency", "media", "digital", "consulting", "partners", "services", "solutions", "team",
]);

/** The distinguishing part of a name — everything a stranger would recognise it by. */
export function nameTokens(name: string): string[] {
  return fold(name)
    .split(" ")
    .filter((w) => w.length >= 3 && !WEAK.has(w));
}

/**
 * Is this title about somebody we already know?
 *
 * Requires EVERY distinguishing token of some known name to appear. "Hart's Bakery" matches "Harts
 * Bakery — quarterly" and does not match "bakery run", which is the difference between a client
 * meeting and buying bread.
 *
 * A name with no distinguishing tokens at all — "The Studio", "Co" — matches nothing, deliberately.
 * It is better to redact a real client's meeting than to let one weak word unlock a whole calendar.
 */
export function titleNamesSomeone(title: string, known: readonly string[]): boolean {
  const hay = ` ${fold(title)} `;
  return known.some((n) => {
    const toks = nameTokens(n);
    return toks.length > 0 && toks.every((t) => hay.includes(` ${t} `) || hay.includes(`${t} `) || hay.includes(` ${t}`));
  });
}

/**
 * Redact one event.
 *
 * Exported separately from the sweep because the decision is the whole file and a caller should be
 * able to test one event without building a calendar.
 */
export function redactEvent(event: ObservedEvent, known: readonly string[]): RedactedEvent {
  const base: RedactedEvent = {
    external_id: event.external_id,
    all_day: event.all_day,
    busy: event.busy,
    ...(event.starts_at ? { starts_at: event.starts_at } : {}),
    ...(event.ends_at ? { ends_at: event.ends_at } : {}),
    ...(event.day ? { day: event.day } : {}),
    ...(event.time_zone ? { time_zone: event.time_zone } : {}),
    ...(event.status_hint ? { status_hint: event.status_hint } : {}),
  };

  // A NAME WE ALREADY KNEW comes first, because it is the stronger signal: it says this event is
  // about a specific relationship, not merely that it is a call.
  if (event.title && titleNamesSomeone(event.title, known)) {
    return { ...base, title: event.title, ...(event.meeting_url ? { meeting_url: event.meeting_url } : {}), matched: "known_name" };
  }
  // A JOIN LINK we would be asked to join. The title comes with it: an event we are about to sit in
  // is one we already know the content of, and a nameless block in the founder's own week is worse
  // than useless when they are trying to work out which call Mycel notes is joining.
  if (event.meeting_url) {
    return { ...base, ...(event.title ? { title: event.title } : {}), meeting_url: event.meeting_url, matched: "join_link" };
  }
  return base;
}

export interface RedactionSummary {
  events: RedactedEvent[];
  kept: number;
  redacted: number;
}

/**
 * The sweep, and the number the founder is shown.
 *
 * `redacted` is reported rather than hidden. A founder who connects a calendar and is told "we read
 * 48 events this week and kept the words of 6" learns exactly what the trade is, in one sentence,
 * from a number we had to compute anyway. Saying nothing would be the same behaviour with the
 * promise left implicit, and an implicit promise about somebody's medical appointments is not
 * enough.
 */
export function redactCalendar(events: readonly ObservedEvent[], known: readonly string[]): RedactionSummary {
  const out = events.map((e) => redactEvent(e, known));
  const kept = out.filter((e) => e.matched).length;
  return { events: out, kept, redacted: out.length - kept };
}
