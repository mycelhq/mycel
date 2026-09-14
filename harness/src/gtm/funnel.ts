// WHAT THE REPLY RATE IS TELLING YOU, WHICH NOTHING HERE HAS EVER CALCULATED.
//
// ═══ THE NUMBER THAT WAS NEVER COMPUTED ═══
//
// Every ingredient has been on the case row the whole time: `touch_count` rises on each
// `send_message`, `has_reply` is set when somebody answers, and the stage moves to `replied` /
// `booked` / `met`. Nothing anywhere in the kernel or the cloud divides one by the other. A founder
// could see faces, stages and a pipeline board, and could not see whether outbound was working.
//
// Christina Gilbert's talk (YC, 12 September) makes that the hinge of the whole method. Her tip 5
// is a debugging ORDER — contacting the right person, then the right companies, then subject lines,
// then messaging, then materials, then deliverability — and every rung on it is read off the reply
// rate. Without the number, none of the ladder can be climbed, and the founder is left rewriting
// copy, which is fourth.
//
// ═══ WHY IT REFUSES TO DIAGNOSE ON A SMALL SAMPLE ═══
//
// She is specific that a baseline is what makes iteration possible — "even just two to three
// replies on 100 emails is a great place to start iterating" — and the corollary is that eleven
// sends with no reply says nothing at all. A zero over a small denominator is not a verdict, it is
// an absence of evidence, and a dashboard that renders it as 0.0% invites a founder to rebuild
// something that was never measured.
//
// So below `MIN_SAMPLE` this reports how many more sends are needed and names no fault.
//
// ═══ AND WHY THE DIAGNOSIS ONLY NAMES WHAT IT CAN SEE ═══
//
// Four of her six rungs are not decidable from case rows: whether the companies are right, whether
// the subject lines are good, whether the messaging lands, and whether the founder's own website
// and profile hold up. Printing all six with a guess against each is how a checklist becomes
// noise. This names the rungs it has evidence for, and says plainly that the rest need a human.

/** One case, as much of it as this needs. Everything optional: a thinner row scores nothing. */
export interface FunnelCase {
  stage?: string | null;
  touch_count?: number | null;
  has_reply?: boolean | null;
  opt_out?: boolean | null;
  /** The prospect's title, for the one rung of her ladder a case row can answer. */
  title?: string | null;
  headline?: string | null;
}

export interface Funnel {
  /** Enrolled, whatever has happened since. */
  enrolled: number;
  /** Actually written to at least once. The denominator that matters — never `enrolled`. */
  worked: number;
  replied: number;
  booked: number;
  met: number;
  optedOut: number;
  /** replied / worked, 0-1. Null when nobody has been worked yet. */
  replyRate: number | null;
  /** True when the sample is too small for the rate to mean anything. */
  tooEarly: boolean;
  /** How many more people must be worked before the rate is worth reading. */
  needMore: number;
  /** One line a founder can act on, or that says honestly that there is nothing to say yet. */
  reading: string;
  /** Her debugging order, restricted to the rungs this data can actually speak to. */
  checks: FunnelCheck[];
}

export interface FunnelCheck {
  /** Position in her order: 1 = right person, 2 = right companies, and so on. */
  rung: number;
  name: string;
  /** `ok` | `suspect` | `unknown` — unknown means this data cannot answer it, not that it passed. */
  verdict: "ok" | "suspect" | "unknown";
  detail: string;
}

/**
 * A hundred worked prospects before the rate is a rate.
 *
 * Her own framing — "two to three replies on 100 emails" — is both the floor for iterating and the
 * shape of the arithmetic: at a 2% true rate, twenty sends produce zero replies about two thirds of
 * the time. Reporting that as a 0% reply rate would be the single most misleading number this
 * product could show.
 */
export const MIN_SAMPLE = 100;

/** Below this, something upstream of the copy is wrong. Her floor for a healthy cold campaign. */
export const WEAK_RATE = 0.02;

const REPLIED_STAGES = new Set(["replied", "booked", "met", "no_show", "won", "lost"]);
const BOOKED_STAGES = new Set(["booked", "met", "no_show", "won"]);

/**
 * Can this person say yes on their own?
 *
 * The one rung of her ladder a case row can genuinely answer, and the one she puts FIRST. Her
 * example is an infrastructure company mailing DevRel and customer-success managers: "those wrong
 * job titles were never going to buy, no matter how good your email was."
 *
 * Ordered, because "Founder & Product Manager" is a founder. An unordered word list scores him as
 * a manager and the whole check inverts.
 */
const DECIDES =
  /\b(owner|founder|co-?founder|principal|proprietor|ceo|president|managing director|managing partner|partner|chief|c[teofmr]o)\b/i;

export function decides(c: FunnelCase): boolean {
  return DECIDES.test(`${c.title ?? ""} ${c.headline ?? ""}`);
}

/** The share of worked prospects who could say yes without asking somebody. */
function decisionMakerShare(worked: readonly FunnelCase[]): { share: number; known: number } {
  const known = worked.filter((c) => `${c.title ?? ""}${c.headline ?? ""}`.trim().length > 0);
  if (known.length === 0) return { share: 0, known: 0 };
  return { share: known.filter(decides).length / known.length, known: known.length };
}

/**
 * Read the funnel.
 *
 * Pure, and the denominator is WORKED rather than enrolled. A campaign holding four hundred queued
 * people and twelve written to has a reply rate out of twelve; dividing by four hundred reports a
 * rate of essentially zero for a campaign that has barely started, which is the exact mistake that
 * makes a founder rewrite working copy.
 */
export function funnelOf(cases: readonly FunnelCase[]): Funnel {
  const enrolled = cases.length;
  const worked = cases.filter((c) => Number(c.touch_count ?? 0) > 0);
  const repliedList = worked.filter((c) => c.has_reply === true || REPLIED_STAGES.has(String(c.stage ?? "")));
  const replied = repliedList.length;
  const booked = worked.filter((c) => BOOKED_STAGES.has(String(c.stage ?? ""))).length;
  const met = worked.filter((c) => String(c.stage ?? "") === "met").length;
  const optedOut = cases.filter((c) => c.opt_out === true).length;

  const n = worked.length;
  const replyRate = n === 0 ? null : replied / n;
  const tooEarly = n < MIN_SAMPLE;
  const needMore = Math.max(0, MIN_SAMPLE - n);

  const checks: FunnelCheck[] = [];
  let reading: string;

  if (n === 0) {
    reading = "Nobody has been written to yet, so there is nothing to read.";
  } else if (tooEarly) {
    // Named as insufficient rather than rendered as a percentage. See MIN_SAMPLE.
    reading =
      `${replied} replies from ${n} worked. Too few to judge — a 2% campaign shows zero about ` +
      `two thirds of the time at this size. Work ${needMore} more before changing anything.`;
  } else if (replyRate! >= WEAK_RATE) {
    reading =
      `${replied} replies from ${n} worked (${(replyRate! * 100).toFixed(1)}%). That is a working ` +
      `baseline: change one thing at a time and watch this number.`;
  } else {
    reading =
      `${replied} replies from ${n} worked (${(replyRate! * 100).toFixed(1)}%), below the 2% a cold ` +
      `campaign should clear. Check these in order — the first one that is wrong makes the rest moot.`;
  }

  // The rungs. Only added once the sample can support a conclusion, because a check that fires on
  // eleven sends is the same false confidence MIN_SAMPLE exists to prevent.
  if (!tooEarly && replyRate! < WEAK_RATE) {
    const dm = decisionMakerShare(worked);
    checks.push(
      dm.known === 0
        ? {
            rung: 1,
            name: "Contacting the right person",
            verdict: "unknown",
            detail: "No titles on file, so we cannot tell whether these people can say yes.",
          }
        : dm.share < 0.5
          ? {
              rung: 1,
              name: "Contacting the right person",
              verdict: "suspect",
              detail:
                `Only ${Math.round(dm.share * 100)}% of the people written to can approve a purchase ` +
                `on their own. The rest have to go and ask somebody, which is a different message.`,
            }
          : {
              rung: 1,
              name: "Contacting the right person",
              verdict: "ok",
              detail: `${Math.round(dm.share * 100)}% can decide without asking anybody.`,
            },
    );
    // Rungs 2 to 5 are real and this data cannot answer them. Said out loud rather than guessed at:
    // a checklist that scores what it cannot see is how a diagnosis becomes decoration.
    for (const [rung, name] of [
      [2, "Contacting the right companies"],
      [3, "Subject lines"],
      [4, "The message itself"],
      [5, "Your own site and profile"],
    ] as const) {
      checks.push({ rung, name, verdict: "unknown", detail: "Needs a human read — not decidable from the pipeline." });
    }
  }

  return { enrolled, worked: n, replied, booked, met, optedOut, replyRate, tooEarly, needMore, reading, checks };
}
