// THE DETECTOR AND THE SCORER HAVE NEVER SPOKEN THE SAME LANGUAGE.
//
// ═══ TWO HALVES OF ONE CAPABILITY, WITH NOTHING BETWEEN THEM ═══
//
// `gtm/signals.ts` reads a person's own words and tags them. It emits exactly three names:
//
//     hiring_mention | job_change | open_to_work
//
// `library/workflows/signal-score.mjs` decides which signals are worth acting on today. It is the
// better half of this system by a distance — twelve signal types, a weight and a HALF-LIFE and a
// death window per type, stale signals REFUSED rather than ranked low, and per-signal guidance on
// what the opener must name. It knows these names:
//
//     pricing_visit repeat_visit demo_or_contact_view champion_moved reply_then_silence funding
//     leadership_hire role_surge tech_change expansion award_or_press category_intent
//
// The overlap is EMPTY. Not one name in common. So the detector's output was unscoreable by
// construction, and every signal it has ever written would land in the scorer's `unknown` bucket —
// which is the bucket that exists to report a feed nobody configured.
//
// Nothing called the scorer from the GTM surface anyway. The lead list has no notion of a score,
// so a founder working fifteen touches a day against hundreds of faces was choosing by whatever
// order the query returned. Christina Gilbert (YC, 12 September) puts that ahead of copy:
// "targeting beats perfect messaging... those wrong job titles were never going to buy, no matter
// how good your email was."
//
// ═══ WHY A TRANSLATION AND NOT A RENAME ═══
//
// Renaming the detector's outputs to match the catalogue would be the smaller diff and the wrong
// one. They are genuinely different observations: the detector reads ONE PERSON'S words, and the
// catalogue scores AN ACCOUNT. "We're hiring" on a profile is evidence about a company, and which
// catalogue entry it becomes depends on what is being hired — a senior functional leader is a
// different signal, with a different half-life, from three more people in an existing team.
//
// So this maps, and it says how sure it is.

import { detectSignals } from "./signals";

/** The catalogue names this bridge can produce. A subset — the rest are first-party web events. */
export type ScorableSignal = "leadership_hire" | "role_surge" | "champion_moved";

export interface Bridged {
  /** The catalogue type, or null when the observation is not a buying signal at all. */
  type: ScorableSignal | null;
  /** Passed through to the scorer as `detail`, so the founder reads the words, not a label. */
  detail: string;
  /** Why it mapped this way, for the row that explains the ranking. */
  because: string;
}

/**
 * ═══ SENIOR ENOUGH TO BE A `leadership_hire` ═══
 *
 * The catalogue separates these deliberately and the numbers are far apart: `leadership_hire` is
 * weight 85 with a 10-day half-life, `role_surge` is 60 with 14. The reasoning is in the catalogue
 * itself — a leadership hire means "a function just got funded and a new person is deciding how to
 * run it", which is a decision window measured in weeks. A team adding headcount is a slower,
 * softer fact.
 *
 * Getting this wrong in the generous direction is the expensive one: scoring a junior req at 85
 * puts it above a genuine funding round, and the founder spends their best hour on it.
 */
const SENIOR_ROLE =
  /\b(head of|director|vp\b|vice president|chief|c[teofmr]o\b|lead\b|principal|manager|partner)\b/i;

/**
 * One detected signal, in the scorer's vocabulary.
 *
 * `open_to_work` maps to NULL on purpose, and it is the most important line here. `signals.ts`
 * already ranks it above `job_change` when both match, for the reason its own comment gives:
 * "excited to announce I'm open to work" is a job LOSS, and congratulating someone on it is the
 * worst message in outbound. They also cannot buy anything — they have left the company whose
 * budget they held. It is a fact worth storing and never a reason to act.
 */
export function bridgeSignal(kind: string, evidence: string): Bridged {
  const detail = (evidence ?? "").trim().slice(0, 200);
  switch (kind) {
    case "job_change":
      // The catalogue's own note: "a warm first touch dressed as a cold one" — someone arriving
      // somewhere new with budget and something to prove, and no incumbent supplier.
      return {
        type: "champion_moved",
        detail,
        because: "they have just moved, so there is no incumbent and a new person is deciding",
      };
    case "hiring_mention":
      return SENIOR_ROLE.test(detail)
        ? {
            type: "leadership_hire",
            detail,
            because: "the role they are hiring is a senior one, so a function is being funded now",
          }
        : {
            type: "role_surge",
            detail,
            because: "they are adding headcount, which outgrows whatever they run today",
          };
    case "open_to_work":
      return {
        type: null,
        detail,
        because: "open to work is a job loss, not a buying signal — never act on it",
      };
    default:
      return { type: null, detail, because: `no catalogue entry for "${kind}"` };
  }
}

/** Convenience: read raw text and bridge in one hop, for callers holding a headline or a post. */
export function bridgeText(text: string): Bridged | null {
  const hit = detectSignals(text);
  return hit ? bridgeSignal(hit.signal, hit.evidence) : null;
}

/**
 * A person row as `signals.ts` leaves it, turned into the shape `signalScore` consumes.
 *
 * Returns null for anything unscoreable so the caller can concat without filtering — an
 * `open_to_work` row must not reach the scorer at all, because the scorer's job is ranking things
 * worth doing and its `unknown` bucket is for a misconfigured feed, not for a deliberate refusal.
 */
export function observedSignalFor(person: {
  signal?: string | null;
  signal_evidence?: string | null;
  signal_at?: string | null;
  company?: string | null;
  company_domain?: string | null;
}): { type: string; observed_at?: string; company: { name?: string; domain?: string }; detail: string } | null {
  const kind = (person.signal ?? "").trim();
  if (!kind) return null;
  const bridged = bridgeSignal(kind, person.signal_evidence ?? "");
  if (!bridged.type) return null;
  return {
    type: bridged.type,
    // Freshness is the whole point of the scorer and it cannot be guessed. A signal with no
    // timestamp is passed through without one, and the scorer decides what to do about that
    // rather than this file inventing a date that makes it look fresh.
    ...(person.signal_at ? { observed_at: person.signal_at } : {}),
    company: {
      ...(person.company ? { name: person.company } : {}),
      ...(person.company_domain ? { domain: person.company_domain } : {}),
    },
    detail: bridged.detail,
  };
}
