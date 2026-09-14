// What the deals you WON had in common, and — much harder — whether that is a pattern or noise.
//
// ═══ WHY THIS IS ARITHMETIC AND NOT A MODEL ═══
//
// "Look at our won deals and tell me what worked" is the single most inviting question to hand a
// language model and the single worst. A model given twelve leads and two wins will find a pattern,
// because finding patterns is what it does, and it will state it in confident prose. The founder then
// aims a quarter of outbound at a coincidence.
//
// Conversion rates, sample sizes and lift are counting. Counting belongs here, where the same inputs
// give the same answer and the answer can be checked. What is genuinely a judgement — what to DO
// about a pattern — stays with the model, and it gets handed numbers rather than being asked to
// derive them.
//
// ═══ THE HALF THAT MATTERS: REFUSING TO ANSWER ═══
//
// Every rule below exists to stop this reporting noise as insight:
//
//   · A segment under `min_sample` is not reported at all. With four bakeries and one win, "bakeries
//     convert at 25%" is a sentence about one bakery.
//   · A segment with no wins is not "0% — avoid", it is unproven. Ten touches and no reply is weak
//     evidence; nine hundred is strong; the two must not read the same.
//   · Lift is against the BASE rate, not against the best other segment. "Twice as good as the worst
//     thing we tried" is not a finding.
//   · Nothing is reported at all until the whole pipeline clears `min_total`. A founder six weeks in
//     has no patterns, and telling them otherwise is worse than telling them nothing.
//
// A tool that says "not yet" is trusted the first time it says something.
//
// Founder code. Pure: no I/O, no clock, no randomness.

import { pct } from "./_figures.mjs";

/** Stages that mean the lead answered. Everything after `replied` on the ladder in gtm/stages.ts. */
const ENGAGED = new Set(["replied", "booked", "met", "won"]);
/** The outcome that pays. `met` is not a win — most deals die between the meeting and the money. */
const WON = new Set(["won"]);

const norm = (v) => String(v ?? "").trim().toLowerCase();

/**
 * Wilson score lower bound at ~95%.
 *
 * A plain rate ranks four-out-of-four above ninety-out-of-a-hundred, which is exactly backwards for
 * deciding where to spend next month. The lower bound asks "what is the worst this could plausibly
 * be", so a small sample is penalised by its own smallness rather than by a threshold somebody
 * argued about. It is the standard tool for ranking things by rate with unequal evidence.
 */
function wilsonLow(wins, n) {
  if (!n) return 0;
  const z = 1.96;
  const p = wins / n;
  const d = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return Math.max(0, (centre - margin) / d);
}

export default function winPatterns(args) {
  const leads = Array.isArray(args.leads) ? args.leads : [];
  if (!leads.length) throw new Error("leads is required and must not be empty");

  /**
   * The floors. Deliberately arguable numbers with the argument written down.
   *
   * `min_total` 30: below that a pipeline has not run long enough for any split to mean anything.
   * `min_sample` 8: a segment smaller than this cannot separate a real rate from a coin.
   *
   * Both are overridable because a founder doing £40k projects may only ever have twenty leads and
   * still want the read — but the default is the cautious one, since the failure of a low floor is
   * confident nonsense and the failure of a high one is an honest "not yet".
   */
  const minTotal = Number(args.min_total ?? 30);
  const minSample = Number(args.min_sample ?? 8);

  const rows = leads.map((l) => ({
    stage: norm(l.stage),
    attrs: l.attributes && typeof l.attributes === "object" ? l.attributes : {},
    /** Which sequence step they answered at, when known — the one non-attribute worth splitting on. */
    replied_at_step: l.replied_at_step ?? undefined,
  }));

  const total = rows.length;
  const wins = rows.filter((r) => WON.has(r.stage)).length;
  const engaged = rows.filter((r) => ENGAGED.has(r.stage)).length;
  const baseWin = total ? wins / total : 0;
  const baseEngage = total ? engaged / total : 0;

  if (total < minTotal || wins === 0) {
    /**
     * NOT AN ERROR, AND NOT AN EMPTY ANSWER. The reason is the answer: a founder who is told "you
     * need eleven more leads before this means anything" knows what to do. One who is handed an
     * empty list assumes the tool is broken and stops opening it.
     */
    return {
      ready: false,
      total,
      wins,
      engaged,
      why_not:
        wins === 0
          ? `Nothing has been won yet, so there is nothing to find a pattern in. ${total} ${total === 1 ? "lead is" : "leads are"} on file.`
          : `${total} leads on file and this needs at least ${minTotal} before any split is worth reading. Keep going.`,
      base: { win_rate: pct(wins, total), engaged_rate: pct(engaged, total) },
      patterns: [],
      unproven: [],
    };
  }

  // Every attribute key any lead carries. Discovered rather than declared: a trade nobody anticipated
  // splits on something nobody listed, and a fixed key list is how this only ever works for GTM.
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r.attrs)))].slice(0, 24);

  const patterns = [];
  const unproven = [];
  for (const key of keys) {
    const values = new Map();
    for (const r of rows) {
      const v = norm(r.attrs[key]);
      if (!v) continue;
      const cur = values.get(v) ?? { n: 0, wins: 0, engaged: 0 };
      cur.n += 1;
      if (WON.has(r.stage)) cur.wins += 1;
      if (ENGAGED.has(r.stage)) cur.engaged += 1;
      values.set(v, cur);
    }
    for (const [value, c] of values) {
      const row = {
        attribute: key,
        value,
        n: c.n,
        wins: c.wins,
        win_rate: pct(c.wins, c.n),
        engaged_rate: pct(c.engaged, c.n),
        /** Ranked on this, never on the raw rate — see `wilsonLow`. */
        confidence_floor: Number(wilsonLow(c.wins, c.n).toFixed(4)),
        /** Against the BASE rate. "Better than the worst thing we tried" is not a finding. */
        lift: baseWin ? Number((c.wins / c.n / baseWin).toFixed(2)) : null,
      };
      if (c.n < minSample) {
        /**
         * Named rather than dropped. A founder who cannot see that "bakeries" exists as a segment
         * assumes it was never tried; one who sees "bakeries — 4 leads, too few to read" knows the
         * question is open and how to close it.
         */
        unproven.push({ ...row, why: `${c.n} ${c.n === 1 ? "lead" : "leads"} is too few to read` });
        continue;
      }
      if (c.wins === 0) {
        // Not "0% — avoid". Ten touches and no reply is weak evidence and nine hundred is strong,
        // and a table that renders both as 0% invites a founder to abandon a market on ten touches.
        unproven.push({ ...row, why: `no wins yet from ${c.n} leads — weak evidence, not a verdict` });
        continue;
      }
      patterns.push(row);
    }
  }

  patterns.sort((a, b) => b.confidence_floor - a.confidence_floor);
  unproven.sort((a, b) => b.n - a.n);

  return {
    ready: true,
    total,
    wins,
    engaged,
    base: { win_rate: pct(wins, total), engaged_rate: pct(engaged, total) },
    /** Strongest first, by the floor rather than the rate. */
    patterns: patterns.slice(0, 12),
    /** Segments that exist and cannot yet be judged. Open questions, not absences. */
    unproven: unproven.slice(0, 12),
    /**
     * The one sentence a founder should act on, or an explicit refusal to give one.
     *
     * Only when the top pattern clears the base rate by a margin that is not a rounding artefact.
     * A "do more of X" produced from a 1.05× lift is how a tool loses its credibility permanently.
     */
    headline:
      patterns.length && patterns[0].lift !== null && patterns[0].lift >= 1.5
        ? `${patterns[0].value} (${patterns[0].attribute}) wins ${patterns[0].win_rate} against ${pct(wins, total)} overall, across ${patterns[0].n} leads.`
        : "No segment is clearly ahead of the overall rate yet. Nothing here is worth changing the plan for.",
  };
}
