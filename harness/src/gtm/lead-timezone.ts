// Lead-timezone-aware send scheduling.
//
// The seat window (pacing.ts `withinSendingWindow`, seat-local 08:00–19:00 weekdays) is the HARD
// gate and stays exactly as it is: sending at 3am seat-time to catch an Asia morning is itself a ban
// signal, so it is never on the table. What this file adds is a SOFT preference layered inside that
// gate — when the sequencer picks WHEN a lead's next touch fires, nudge it to a slot that is in both
// the seat window AND the lead's own business hours (~09:00–17:00 local), if such an overlap exists
// in the next day or two. When there is no overlap (a far-flung lead against this seat's window),
// ban-safety wins and we fall back to the seat window — we never defer a touch indefinitely just to
// catch someone's morning.
//
// Everything here is pure and takes `now`/`from` explicitly, so it is unit-testable without a clock.
import { localClock, withinSendingWindow } from "../pacing";

/** A lead's local business day, in local hours. Kept narrower than the seat's 08:00–19:00 on purpose. */
const LEAD_START_HOUR = 9;
const LEAD_END_HOUR = 17; // exclusive: 17:00 local is already end-of-day

/** How far ahead we will look for a both-windows overlap before falling back to the seat window. */
const DEFAULT_HORIZON_H = 48;

/** Granularity of the search. Fifteen minutes is finer than any spacing jitter and cheap to scan. */
const STEP_MS = 15 * 60_000;

/**
 * Infer a UTC offset (in MINUTES) from a free-text location string.
 *
 * This is a heuristic, not a timezone database: LinkedIn location strings are things like
 * "Paris, Paris, France" or "San Francisco Bay Area", and all we need is a good-enough offset to
 * know roughly what hour it is where the lead sits. DST is deliberately ignored — an hour of slop
 * does not change whether 14:00 seat-time is inside a lead's working day. Returns `undefined` when
 * the string tells us nothing recognisable, in which case the seat window alone governs.
 *
 * Ordered most-specific first (city/region before country) so "Perth, Australia" reads as +8, not
 * the +10 an unqualified "Australia" would give.
 */
export function timezoneForLocation(location?: string): number | undefined {
  if (!location) return undefined;
  const s = location.toLowerCase();
  const has = (...needles: string[]) => needles.some((n) => s.includes(n));
  const H = 60; // one hour in minutes, for readability below

  // ── US regions & cities, west to east ──────────────────────────────────────────────────────────
  if (has("hawaii", "honolulu")) return -10 * H;
  if (has("alaska", "anchorage")) return -9 * H;
  if (
    has(
      "california", "san francisco", "bay area", "silicon valley", "los angeles",
      "san diego", "san jose", "sacramento", "seattle", "washington state",
      "portland, oregon", "oregon", "nevada", "las vegas", "pacific time",
    )
  ) return -8 * H;
  if (has("denver", "colorado", "utah", "salt lake", "arizona", "phoenix", "mountain time", "new mexico", "albuquerque")) return -7 * H;
  if (
    has(
      "chicago", "illinois", "texas", "austin", "dallas", "houston", "minnesota",
      "minneapolis", "wisconsin", "missouri", "kansas city", "oklahoma", "central time",
    )
  ) return -6 * H;
  if (
    has(
      "new york", "nyc", "boston", "massachusetts", "washington, d", "washington dc",
      "district of columbia", "atlanta", "georgia", "florida", "miami", "philadelphia",
      "pennsylvania", "north carolina", "charlotte", "toronto", "ontario", "montreal",
      "quebec", "eastern time", "connecticut", "new jersey", "virginia", "ohio", "michigan", "detroit",
    )
  ) return -5 * H;

  // ── Americas (non-US) ───────────────────────────────────────────────────────────────────────────
  if (has("são paulo", "sao paulo", "rio de janeiro", "brazil", "brasil", "argentina", "buenos aires")) return -3 * H;
  if (has("mexico city", "ciudad de méxico", "mexico")) return -6 * H;

  // ── Australia / NZ (before UK, so "New South Wales" is not misread as "Wales") ───────────────────
  if (has("adelaide")) return 9 * H + 30;
  if (has("sydney", "melbourne", "brisbane", "canberra", "new south wales", "australia")) return 10 * H;
  if (has("auckland", "wellington", "new zealand")) return 12 * H;

  // ── UK / Ireland / Portugal ─────────────────────────────────────────────────────────────────────
  if (has("london", "united kingdom", "england", "scotland", "wales", "manchester", "ireland", "dublin", "lisbon", "portugal")) return 0;

  // ── Western & Central Europe ────────────────────────────────────────────────────────────────────
  if (
    has(
      "paris", "france", "berlin", "germany", "munich", "frankfurt", "madrid", "spain",
      "barcelona", "amsterdam", "netherlands", "brussels", "belgium", "milan", "rome",
      "italy", "zurich", "switzerland", "geneva", "stockholm", "sweden", "oslo", "norway",
      "copenhagen", "denmark", "vienna", "austria", "warsaw", "poland", "prague",
    )
  ) return 1 * H;

  // ── Eastern Europe / Middle East / Africa ───────────────────────────────────────────────────────
  if (has("athens", "greece", "helsinki", "finland", "bucharest", "romania", "cairo", "egypt", "johannesburg", "south africa")) return 2 * H;
  if (has("moscow", "russia", "istanbul", "turkey", "nairobi", "kenya")) return 3 * H;
  if (has("dubai", "united arab emirates", "abu dhabi", "uae")) return 4 * H;

  // ── South & South-East Asia ─────────────────────────────────────────────────────────────────────
  if (has("india", "bangalore", "bengaluru", "mumbai", "delhi", "hyderabad", "chennai", "pune", "gurgaon", "noida")) return 5 * H + 30;
  if (has("pakistan", "karachi", "lahore")) return 5 * H;
  if (has("bangladesh", "dhaka")) return 6 * H;
  if (has("bangkok", "thailand", "jakarta", "indonesia", "vietnam", "hanoi", "ho chi minh")) return 7 * H;
  if (has("singapore", "kuala lumpur", "malaysia", "manila", "philippines", "hong kong", "beijing", "shanghai", "china", "perth")) return 8 * H;
  if (has("tokyo", "japan", "seoul", "south korea", "korea")) return 9 * H;

  return undefined;
}

/** The lead's local wall-clock hour (0–23) at a given UTC instant, given their offset in minutes. */
export function leadLocalHour(offsetMinutes: number, nowUtc: Date): number {
  const local = new Date(nowUtc.getTime() + offsetMinutes * 60_000);
  return local.getUTCHours();
}

/** True when the instant sits inside the lead's own ~09:00–17:00 local business hours, any day. */
function withinLeadWindow(offsetMinutes: number, at: Date): boolean {
  const local = new Date(at.getTime() + offsetMinutes * 60_000);
  const hour = local.getUTCHours();
  return hour >= LEAD_START_HOUR && hour < LEAD_END_HOUR;
}

export interface PreferredSendOpts {
  /** The SEAT's connection config — carries `utc_offset` (hours), read exactly as pacing.ts reads it. */
  seatConfig: Record<string, unknown> | undefined;
  /** The lead's UTC offset in minutes, from `timezoneForLocation`. Omitted → seat window alone. */
  leadOffsetMinutes?: number;
  /** The earliest instant a touch may fire — usually `now + max(spacing, cadence)`. */
  from: Date;
  /** How far to look for a both-windows overlap before conceding to the seat window. */
  horizonH?: number;
}

/**
 * The next instant at or after `from` that is inside the seat window and — if the lead's offset is
 * known — also inside the lead's 09:00–17:00 local. If no such overlap exists within the horizon,
 * fall back to the first seat-window instant (ban-safety wins; a touch is never deferred forever).
 *
 * With no lead offset this is simply "the next seat-window instant", which is the pre-existing
 * behaviour the seat gate already enforced at send time.
 */
export function preferredSendAt(opts: PreferredSendOpts): Date {
  const { seatConfig, leadOffsetMinutes, from } = opts;
  const horizonMs = (opts.horizonH ?? DEFAULT_HORIZON_H) * 60 * 60_000;
  const end = from.getTime() + horizonMs;

  const seatOk = (at: Date) => {
    const { hour, day } = localClock(seatConfig, at);
    return withinSendingWindow(hour, day);
  };

  let firstSeatSlot: Date | undefined;
  for (let t = from.getTime(); t <= end; t += STEP_MS) {
    const at = new Date(t);
    if (!seatOk(at)) continue;
    if (firstSeatSlot === undefined) firstSeatSlot = at;
    // No lead offset: the first seat slot IS the answer.
    if (leadOffsetMinutes === undefined) return at;
    // Both windows must hold. If they do, this is the ideal slot.
    if (withinLeadWindow(leadOffsetMinutes, at)) return at;
  }

  // No overlap inside the horizon: take the first seat-window slot we found (ban-safety wins).
  // If even the seat window never opened in the horizon (pathological config), return `from`
  // unchanged so the caller's own pacing gate decides — never defer indefinitely.
  return firstSeatSlot ?? from;
}
