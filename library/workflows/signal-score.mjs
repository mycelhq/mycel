// Which buying signals are worth acting on today, and which have already gone cold.
//
// ═══ THE PREMISE: TIMING BEATS COPY ═══
//
// A static sequence assumes the prospect's situation is constant — same job, same priorities, same
// urgency on day 1 as day 30 — and the only variable is which message lands. That assumption is
// wrong in a specific, exploitable way: buyers do most of their work before they want to talk, so
// volume cannot manufacture attention earlier. What it can do is spend sender reputation faster.
//
// A signal detects the moment a fresh priority opens inside a company. The job is to arrive while
// it is still fresh.
//
// ═══ WHY THIS IS ARITHMETIC ═══
//
// Freshness is a decay curve, qualification is a set membership test, and stacking is addition.
// Handing that to a model gets you a confident ranking nobody can reproduce, and the one thing a
// founder must be able to trust here is WHY this account is at the top today and not last week.
//
// What stays with the model is the message. The signal does the targeting; the message does the
// conversation, and no amount of scoring rescues "helping companies like yours grow".
//
// ═══ THE HALF THAT MATTERS: REFUSING A STALE SIGNAL ═══
//
// Every signal type here carries its own decay, because routing a hiring event on the same timeline
// as a pricing-page visit throws away the timing advantage of at least one of them. A pricing visit
// is worth acting on today and worthless on Friday. A funding round is good for a month.
//
// A signal past its window is REFUSED, not ranked low. "We noticed you raised a round" eight months
// later is not a weak version of a good message — it is evidence nobody was paying attention, and it
// is worse than silence. A ranked list that quietly includes dead signals will have them acted on.
//
// Founder code. Pure: no I/O, no clock, no randomness. `now` is passed in.

/**
 * ═══ THE CATALOGUE ═══
 *
 * `half_life_days` is how fast the signal loses value; `dead_after_days` is when acting on it starts
 * costing you rather than earning. Both are per type, and the gap between a pricing visit (hours)
 * and a funding round (weeks) is the whole reason this file exists.
 *
 * `first_party` marks a signal observed on the founder's OWN property — their site, their inbox,
 * their pipeline. Those are close to the buyer and close to now, and they are the ones worth
 * trusting. A bought category score is far from both, which is why it fires after the shortlist has
 * already formed. First-party signals are weighted accordingly, and third-party ones are useful for
 * deciding WHO to work next rather than for deciding to reach out at all.
 *
 * `implies` is what the signal means for the buyer, and `qualify_on` is what to ask once they reply.
 * A prospect answering after a funding round has budget and should be qualified on fit and timeline;
 * one answering after a pricing visit is comparing vendors and should be qualified on switching cost.
 * Skipping that context throws away most of the advantage.
 */
export const SIGNALS = {
  pricing_visit: {
    label: "visited your pricing page",
    first_party: true,
    weight: 100,
    /**
     * Two days, not one, and the difference is load-bearing.
     *
     * At a one-day half-life a pricing visit from YESTERDAY scored below a senior hire from LAST
     * WEEK, which inverts the thing everyone who runs this agrees on: somebody on your pricing page
     * is the highest-intent signal you will ever see, and yesterday is not stale. The published
     * window is 24 to 72 hours; two days is the middle of it and it puts a fresh visit at the top of
     * the list where it belongs.
     *
     * `dead_after_days` stays short. A pricing visit a week old is not a lead, it is a fact about
     * last week.
     */
    half_life_days: 2,
    dead_after_days: 5,
    implies: "they are comparing options right now and have not filled in a form",
    qualify_on: "what they are comparing you against, and what switching would cost them",
    say: "reference what they were looking at only if you can do it without being creepy — that they are looking is the timing, not the opener",
  },
  repeat_visit: {
    label: "came back to your site more than once this week",
    first_party: true,
    weight: 80,
    half_life_days: 2,
    dead_after_days: 7,
    implies: "sustained interest rather than a stray click",
    qualify_on: "which problem brought them back",
  },
  demo_or_contact_view: {
    label: "opened your contact or booking page without booking",
    first_party: true,
    weight: 95,
    half_life_days: 1,
    dead_after_days: 5,
    implies: "they got as far as the door and something stopped them",
    qualify_on: "what stopped them — price, timing, or a missing answer",
  },
  champion_moved: {
    /**
     * The most under-used signal there is. Someone who already bought from you, or already liked
     * you, has arrived somewhere new with budget and something to prove — and no incumbent
     * relationship at the new company. It is a warm first touch dressed as a cold one.
     */
    label: "someone who knows you moved to a new company",
    first_party: true,
    weight: 90,
    half_life_days: 21,
    dead_after_days: 120,
    implies: "a warm relationship at a company with no incumbent supplier and a new person proving themselves",
    qualify_on: "what they were brought in to fix",
    say: "congratulate them as a person, not as an account. They will know which one this is.",
  },
  reply_then_silence: {
    label: "answered you once and then went quiet",
    first_party: true,
    weight: 70,
    half_life_days: 30,
    dead_after_days: 240,
    implies: "the hardest part already happened and something interrupted it",
    qualify_on: "whether the reason it stalled has changed",
  },
  funding: {
    label: "raised a round",
    first_party: false,
    weight: 75,
    half_life_days: 14,
    dead_after_days: 45,
    implies: "a budget refresh and an explicit growth mandate",
    qualify_on: "fit and timeline — the budget question is already answered",
    say: "match the STAGE to the offer. A seed round wants volume, a Series B wants infrastructure, a Series C wants to expand. A message about the wrong one lands as confetti — every other vendor sent theirs the same morning.",
  },
  leadership_hire: {
    label: "hired someone senior into a function you sell to",
    first_party: false,
    weight: 85,
    half_life_days: 10,
    dead_after_days: 45,
    implies: "a function just got funded and a new person is deciding how to run it",
    qualify_on: "whether what they were hired to do maps to what you sell",
    say: "name the role and what the posting actually asked for. \"You hired a head of growth and the post lists outbound\" reads as attention; \"congratulations on your growth\" reads as a script.",
  },
  role_surge: {
    label: "posted several roles in one function",
    first_party: false,
    weight: 60,
    half_life_days: 14,
    dead_after_days: 60,
    implies: "a team scaling faster than its current tooling or process",
    qualify_on: "what breaks first at the size they are heading for",
  },
  tech_change: {
    label: "added or dropped a tool next to yours",
    first_party: false,
    weight: 65,
    half_life_days: 7,
    dead_after_days: 30,
    implies: "an active decision was just made in your category's neighbourhood",
    qualify_on: "what the change left unsolved",
  },
  expansion: {
    label: "opened a location or entered a market",
    first_party: false,
    weight: 55,
    half_life_days: 21,
    dead_after_days: 90,
    implies: "new operations that need setting up rather than optimising",
    qualify_on: "what they are standing up first",
  },
  award_or_press: {
    label: "was written about or won something",
    first_party: false,
    weight: 30,
    half_life_days: 5,
    dead_after_days: 21,
    implies: "very little on its own — an opener, not a reason",
    qualify_on: "anything else, because this is not a buying signal",
    say: "this is a way to start a sentence, not a reason to send one. If it is the only signal, it is not enough.",
  },
  category_intent: {
    /**
     * A bought score. Kept, and deliberately weighted low: by the time a broker aggregates category
     * browsing and marks an account hot, the buying committee has usually already shortlisted. It
     * points you at a race you are late to. Useful for choosing among accounts you were going to
     * work anyway; not a reason to start.
     */
    label: "showed up on a third-party intent list",
    first_party: false,
    weight: 25,
    half_life_days: 7,
    dead_after_days: 21,
    implies: "somebody at the company read something in your category, probably a while ago",
    qualify_on: "everything — this tells you almost nothing about the person",
    say: "never open with this. It is a tiebreaker for who to work next, not a trigger.",
  },
};

const norm = (v) => String(v ?? "").trim().toLowerCase();

/** Whole days between two ISO dates. `undefined` when either is missing or unparseable. */
function daysBetween(then, now) {
  const a = Date.parse(then ?? "");
  const b = Date.parse(now ?? "");
  if (!Number.isFinite(a) || !Number.isFinite(b)) return undefined;
  return Math.floor((b - a) / 86_400_000);
}

/**
 * Does this company match who the founder actually sells to?
 *
 * The gate that stops a signal feed becoming a firehose. Every filter supplied must match; an empty
 * ICP matches everything, which is the honest reading of "they did not tell us who they sell to"
 * rather than a silent refusal of the whole list.
 */
function icpFault(company, icp) {
  if (!icp) return undefined;
  const inList = (v, list) =>
    !list?.length || list.some((x) => norm(v).includes(norm(x)) || norm(x).includes(norm(v)));
  if (!inList(company.industry, icp.industries)) return `industry "${company.industry ?? "unknown"}" is not who you sell to`;
  if (!inList(company.country ?? company.location, icp.locations)) {
    return `location "${company.location ?? company.country ?? "unknown"}" is outside where you work`;
  }
  const size = Number(company.headcount);
  if (icp.min_headcount && Number.isFinite(size) && size < Number(icp.min_headcount)) {
    return `${size} staff is below the size you sell to`;
  }
  if (icp.max_headcount && Number.isFinite(size) && size > Number(icp.max_headcount)) {
    return `${size} staff is above the size you sell to`;
  }
  return undefined;
}

export default function signalScore(args) {
  const observed = Array.isArray(args.signals) ? args.signals : [];
  if (!observed.length) throw new Error("signals is required and must not be empty");
  const now = String(args.now ?? "").trim();
  if (!now) throw new Error("now is required (ISO date) — freshness is the whole point and it cannot be guessed");
  const icp = args.icp && typeof args.icp === "object" ? args.icp : undefined;

  const act = [];
  const stale = [];
  const unqualified = [];
  const unknown = [];

  /** Grouped by company: two signals on one account is ONE prospect at peak readiness, not two. */
  const byCompany = new Map();

  for (const s of observed) {
    const type = norm(s.type);
    const spec = SIGNALS[type];
    if (!spec) {
      unknown.push({ type: s.type, why: `"${s.type}" is not a signal type this knows about` });
      continue;
    }
    const age = daysBetween(s.observed_at, now);
    if (age === undefined) {
      unknown.push({ type, company: s.company?.name, why: "no usable date, so its freshness cannot be judged" });
      continue;
    }

    const company = s.company ?? {};
    const key = norm(company.domain || company.name) || `row-${act.length + stale.length}`;

    if (age > spec.dead_after_days) {
      /**
       * REFUSED, not ranked low. "We noticed you raised a round" eight months later is not a weak
       * version of a good message: it is evidence nobody was paying attention, and it is worse than
       * silence. Reported so a founder can see the feed is working and the window was missed.
       */
      stale.push({
        type,
        company: company.name,
        age_days: age,
        window_days: spec.dead_after_days,
        why: `${age} days old; a ${spec.label} signal stops being worth acting on after ${spec.dead_after_days}`,
      });
      continue;
    }

    const fault = icp ? icpFault(company, icp) : undefined;
    if (fault) {
      unqualified.push({ type, company: company.name, why: fault });
      continue;
    }

    // Exponential decay on the type's own half-life. A pricing visit is worth a fifth of itself
    // after two days; a funding round is still worth most of itself after a week.
    const freshness = Math.pow(0.5, age / spec.half_life_days);
    const score = spec.weight * freshness;

    const entry = byCompany.get(key) ?? { company, signals: [], score: 0 };
    entry.signals.push({
      type,
      label: spec.label,
      age_days: age,
      first_party: spec.first_party,
      implies: spec.implies,
      qualify_on: spec.qualify_on,
      ...(spec.say ? { say: spec.say } : {}),
      detail: s.detail ?? undefined,
      score: Math.round(score),
    });
    entry.score += score;
    byCompany.set(key, entry);
  }

  for (const entry of byCompany.values()) {
    entry.signals.sort((a, b) => b.score - a.score);
    const top = entry.signals[0];
    const others = entry.signals.length - 1;
    act.push({
      company: entry.company,
      score: Math.round(entry.score),
      signals: entry.signals,
      /**
       * Stacking is the finding, not a bonus. A company that raised last month, hired last week and
       * read your pricing page yesterday is not three signals — it is one prospect at peak
       * readiness, and the operator who notices first owns the conversation.
       */
      stacked: entry.signals.length > 1,
      /** What the opener must actually name. The signal targets; the message converts. */
      lead_with: top
        ? `${entry.company.name ?? "They"} ${top.label}${top.age_days === 0 ? " today" : ` ${top.age_days} ${top.age_days === 1 ? "day" : "days"} ago`}${others ? `, and ${others} other ${others === 1 ? "signal" : "signals"} fired too` : ""}`
        : "",
      qualify_on: top?.qualify_on,
      /** Deadline, not a suggestion: the day this becomes a message nobody should send. */
      act_by_days: top ? Math.max(0, SIGNALS[top.type].dead_after_days - top.age_days) : 0,
    });
  }

  act.sort((a, b) => b.score - a.score);

  return {
    /** Worth a message today, hottest first. */
    act,
    /** The window closed. Shown so a founder can see the feed works and the timing did not. */
    stale,
    /** Real signals at companies this business does not sell to. Not a failure — a filter working. */
    unqualified,
    /** Rows this could not read. Never silently dropped. */
    unknown,
    counts: { act: act.length, stale: stale.length, unqualified: unqualified.length, unknown: unknown.length },
    /**
     * The one sentence a founder acts on, or an honest nothing.
     *
     * A feed that reports "12 signals" and no instruction is the dashboard problem this whole
     * approach exists to fix: events pile up, nobody routes them, nothing sends.
     */
    headline: act.length
      ? `${act[0].lead_with}. ${act[0].act_by_days === 0 ? "Today is the last day this is worth sending." : `You have about ${act[0].act_by_days} days.`}`
      : stale.length
        ? `Nothing is live. ${stale.length} ${stale.length === 1 ? "signal" : "signals"} fired and the window closed before anyone acted — that is a routing problem, not a sourcing one.`
        : "No signals worth acting on.",
  };
}
