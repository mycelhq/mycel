// The arithmetic the founder has to see every morning: what is left, how many days, how many a day.
//
// ═══ WHY THIS IS ITS OWN MODULE ═══
//
// "It should help me work out the numbers and percentages and the daily limits I have to achieve."
// That is the whole job of the CRM's header, and it must never be computed in the view — a number
// on a screen that is derived twice is a number that eventually disagrees with itself.
//
// Every figure here is a READING of what happened plus a division. None of them is a setting.

export interface PlanInput {
  /** People never contacted. */
  queued: number;
  /** Everyone ever invited, cumulative. */
  invited: number;
  accepted: number;
  messaged: number;
  replied: number;
  /** Working seats, and what each may still send today. */
  seats: { name: string; remainingToday: number; sentToday: number; weekCap: number | null; sentThisWeek: number }[];
  daysToLaunch: number;
}

export interface Plan {
  /** Everyone we could still ask, over the days remaining. */
  perDayToClearQueue: number;
  /** What the accounts can actually do in a day, added up. */
  capacityPerDay: number;
  /** How many of the queue we can realistically reach before launch. */
  reachableByLaunch: number;
  /** Queue we will NOT get to at current capacity. Zero is the good answer. */
  unreachable: number;
  acceptRate: number | null;
  replyRate: number | null;
  /** Connections expected by launch day, from what has actually happened so far. */
  projectedConnections: number;
  /** The sentence for the header. */
  verdict: string;
}

const pct = (a: number, b: number): number | null => (b > 0 ? Math.round((a / b) * 100) : null);

export function plan(input: PlanInput): Plan {
  const days = Math.max(1, input.daysToLaunch);
  const capacityPerDay = input.seats.reduce((n, s) => n + s.remainingToday, 0);

  // What the fleet can send between now and launch. Today's remaining is a real reading; the days
  // after are today's budget repeated, which is conservative — the ramp climbs.
  const reachableByLaunch = Math.min(input.queued, capacityPerDay * days);
  const unreachable = Math.max(0, input.queued - reachableByLaunch);
  const perDayToClearQueue = Math.ceil(input.queued / days);

  const acceptRate = pct(input.accepted, input.invited);
  const replyRate = pct(input.replied, input.messaged);

  // Project with the rate we have actually observed; fall back to a stated assumption, never to a
  // flattering one. 28% is the ordinary cold-invite acceptance and it is marked as an assumption
  // in the verdict when it is used.
  const observed = input.invited >= 20 && acceptRate !== null ? acceptRate / 100 : null;
  const rate = observed ?? 0.28;
  const projectedConnections = Math.round((input.accepted + reachableByLaunch * rate));

  const verdict =
    unreachable > 0
      ? `${unreachable} of the queue will not be reached by launch at ${capacityPerDay}/day. ` +
        `Clearing it needs ${perDayToClearQueue}/day — add accounts or accept the shortfall.`
      : `The whole queue is reachable: ${perDayToClearQueue}/day across ${input.seats.length} accounts for ${days} day${days === 1 ? "" : "s"}.`;

  return {
    perDayToClearQueue,
    capacityPerDay,
    reachableByLaunch,
    unreachable,
    acceptRate,
    replyRate,
    projectedConnections,
    verdict: observed === null && input.invited > 0 ? `${verdict} (projection assumes 28% accept until ~20 invites land)` : verdict,
  };
}
