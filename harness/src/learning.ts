// WHETHER THIS BUSINESS IS TEACHING THE MACHINE ANYTHING.
//
// ═══ THE ONE NUMBER THIS PRODUCT IS FOR ═══
//
// `DeliverableVersion.author` already says it: the difference between an agent version and the
// founder version that replaced it is "a labelled correction, on real work, by the person whose
// judgement the system is trying to learn… the most valuable signal this product generates".
//
// It has been accumulating in Postgres since founders could edit, and nothing has ever read it.
// This reads it.
//
// The claim the whole company rests on is that month three needs less editing than month one. That
// is not a slogan; it is a measurable series, and if it is flat then the product is a services
// business with better tooling and we should find out from our own data rather than from a churned
// customer. A falling curve is also the only retention evidence anyone in this category has been
// able to show — median NRR across AI-native products is roughly half that of ordinary software,
// and nobody publishes a reason to believe their own is different.
//
// ═══ WHAT IS DELIBERATELY NOT HERE ═══
//
// No database, no artifact fetching, no clock. The caller supplies the versions and a function that
// turns one into the text a client would read, because the payload lives in artifacts and the store
// that can fetch them is the caller's problem. That keeps every rule below a unit test.
//
// It also does not judge QUALITY. A large edit is not a bad draft — a founder may be rewriting for a
// client who changed their mind. It measures how much work the machine left for the human, which is
// the thing that has to fall for any of this to be worth more than the labour it replaces.
import type { DeliverableVersion } from "./contract";

/** One agent draft and the founder version that replaced it. The unit of learning. */
export interface CorrectionPair {
  deliverable_id: string;
  /** When the CORRECTION was made — the founder version's timestamp, not the draft's. */
  at: string;
  from_version: number;
  to_version: number;
  before: string;
  after: string;
  /** 0 = shipped untouched, 1 = nothing of the draft survived. */
  distance: number;
}

/**
 * Word-level Levenshtein, normalised by the longer side.
 *
 * WORDS, NOT CHARACTERS. Fixing a typo and rewriting a sentence are different events and character
 * distance rates them by length rather than by meaning. A word edit is roughly "one decision the
 * founder had to make", which is the quantity being counted.
 *
 * Capped, because this runs over documents and the matrix is quadratic. Beyond the cap the score is
 * computed on the first `CAP` words of each side: a founder who has rewritten the first two thousand
 * words has already told us what we needed to know.
 */
const CAP = 2000;

export function editDistance(before: string, after: string): number {
  const a = before.trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, CAP);
  const b = after.trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, CAP);
  // Two empty versions are identical, not "fully rewritten". Dividing by zero below would say 0/0.
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0 || b.length === 0) return 1;

  // One row at a time: the full matrix is 2000×2000 and only the previous row is ever read.
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        prev[j]! + 1,
        row[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return Math.min(1, prev[b.length]! / Math.max(a.length, b.length));
}


/**
 * Agent drafts that went out and nobody sent back.
 *
 * The other half of the measurement, and the half that carries the good news.
 *
 * Deliberately counts only versions that were actually SETTLED, because a draft still sitting in
 * the queue has not been approved of — it has merely not been edited yet, and scoring "nobody has
 * looked at this" as "perfect first time" would make an abandoned queue read as a triumph.
 *
 * ═══ A DRAFT THE CLIENT SENT BACK IS NOT AN UNTOUCHED DRAFT ═══
 *
 * This used to say: "an agent version is untouched when no founder version follows it — either it
 * was the last word on that deliverable, OR THE NEXT VERSION IS ANOTHER AGENT DRAFT. Both mean the
 * founder did not have to rewrite it."
 *
 * The second half of that is false, and it is false in the most expensive direction. The commonest
 * reason a second agent draft exists is that the CLIENT asked for changes. So the sequence
 *
 *     v1 agent → released → client asks for changes → v2 agent → founder approves untouched
 *
 * scored v1 as a clean draft (it had `released_at`, and the next author was not `founder`) and v2
 * as another clean draft. A deliverable the client REJECTED contributed two zeroes and pulled the
 * curve down — the direction that means "improving". The one number the whole product rests on got
 * better when a client was unhappy.
 *
 * `change_requested_at` has been on the row the whole time — "what the client asked to be changed
 * about THIS version" — and nothing here read it. It does now.
 */
export function untouchedDrafts(versions: readonly DeliverableVersion[]): { at: string }[] {
  const byDeliverable = new Map<string, DeliverableVersion[]>();
  for (const v of versions) {
    const list = byDeliverable.get(v.deliverable_id) ?? [];
    list.push(v);
    byDeliverable.set(v.deliverable_id, list);
  }
  const out: { at: string }[] = [];
  for (const list of byDeliverable.values()) {
    const ordered = [...list].sort((x, y) => x.version - y.version);
    for (let i = 0; i < ordered.length; i++) {
      const v = ordered[i]!;
      if ((v.author ?? "agent") !== "agent") continue;
      if (ordered[i + 1]?.author === "founder") continue; // that is a correction, not an untouched draft
      // The client asked for this one to change. Whatever else it was, it was not shipped clean.
      if ((v as { change_requested_at?: string }).change_requested_at) continue;
      const settled = (v as { accepted_at?: string; released_at?: string }).accepted_at ??
        (v as { released_at?: string }).released_at;
      if (!settled) continue;
      out.push({ at: settled });
    }
  }
  return out;
}

/**
 * Every place a founder corrected the agent, in version order.
 *
 * A pair is an agent version IMMEDIATELY followed by a founder version of the same deliverable.
 * Immediacy matters: agent → agent → founder means the founder corrected the SECOND draft, and
 * pairing them with the first would score the machine's own revision as human effort.
 *
 * `author` absent means the agent — every version written before founders could edit, per the
 * field's own contract. Treating absent as founder would invent corrections that never happened.
 */
export function correctionPairs(
  versions: readonly DeliverableVersion[],
  text: (v: DeliverableVersion) => string,
): CorrectionPair[] {
  const byDeliverable = new Map<string, DeliverableVersion[]>();
  for (const v of versions) {
    const list = byDeliverable.get(v.deliverable_id) ?? [];
    list.push(v);
    byDeliverable.set(v.deliverable_id, list);
  }

  const out: CorrectionPair[] = [];
  for (const [deliverable_id, list] of byDeliverable) {
    const ordered = [...list].sort((x, y) => x.version - y.version);
    for (let i = 0; i < ordered.length - 1; i++) {
      const draft = ordered[i]!;
      const edit = ordered[i + 1]!;
      if ((draft.author ?? "agent") !== "agent") continue;
      if (edit.author !== "founder") continue;
      const before = text(draft);
      const after = text(edit);
      out.push({
        deliverable_id,
        at: edit.created_at,
        from_version: draft.version,
        to_version: edit.version,
        before,
        after,
        distance: editDistance(before, after),
      });
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * Drafts the CLIENT sent back, as corrections.
 *
 * Excluding them from `untouchedDrafts` stops the curve flattering itself, but silence is how this
 * whole class of bug happens: a rejection that is merely uncounted is a rejection nobody sees. The
 * metric's own definition is "how much work the machine left for the human", and a client asking
 * for changes is exactly that — by the human who is paying for it.
 *
 * The distance is the agent's OWN redraft: how much had to change to satisfy the ask. That is
 * measured rather than assumed, and it is the same quantity `correctionPairs` reports for a founder
 * edit, so the two are comparable and can share a curve.
 *
 * A send-back with no following version is skipped rather than scored 1. It means the redraft has
 * not happened yet — an open request, not a total rewrite — and guessing a number for work that has
 * not been done is the failure this file exists to avoid.
 */
export function clientSendBacks(
  versions: readonly DeliverableVersion[],
  text: (v: DeliverableVersion) => string,
): CorrectionPair[] {
  const byDeliverable = new Map<string, DeliverableVersion[]>();
  for (const v of versions) {
    const list = byDeliverable.get(v.deliverable_id) ?? [];
    list.push(v);
    byDeliverable.set(v.deliverable_id, list);
  }

  const out: CorrectionPair[] = [];
  for (const [deliverable_id, list] of byDeliverable) {
    const ordered = [...list].sort((x, y) => x.version - y.version);
    for (let i = 0; i < ordered.length - 1; i++) {
      const sent = ordered[i]!;
      const at = (sent as { change_requested_at?: string }).change_requested_at;
      if (!at) continue;
      if ((sent.author ?? "agent") !== "agent") continue;
      const redraft = ordered[i + 1]!;
      // A founder edit on the same version is already counted by `correctionPairs`; counting it
      // here too would charge one correction twice.
      if (redraft.author === "founder") continue;
      const before = text(sent);
      const after = text(redraft);
      out.push({
        deliverable_id,
        at,
        from_version: sent.version,
        to_version: redraft.version,
        before,
        after,
        distance: editDistance(before, after),
      });
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

export interface CurvePoint {
  /** ISO date of the first day of the bucket. */
  at: string;
  corrections: number;
  /** Mean distance in this bucket, ACROSS EVERY DRAFT — an untouched one contributes a zero. */
  mean: number;
  /** Drafts the founder shipped without changing a word. */
  untouched: number;
}

/**
 * The series, bucketed by whole weeks.
 *
 * ═══ THE ZEROES ARE THE POINT, AND LEAVING THEM OUT WAS A BUG ═══
 *
 * A founder version only exists if the founder EDITED. Approving a draft untouched writes no new
 * version, so it produces no pair — which means a curve built only from pairs measures "how hard
 * were the drafts I had to fix", and is blind to the drafts that needed no fixing at all.
 *
 * That gets the direction wrong in the exact case the product is claiming. As it improves, the
 * number of edits FALLS while the ones that remain are the genuinely hard documents — so mean
 * distance among edits can rise, or sit flat, on a month that was dramatically better. The founder
 * would be shown a flat line for the best month they had.
 *
 * So the caller passes the drafts that were never edited and each contributes a zero. The series is
 * then "how much of an average draft did I have to rewrite", which is the sentence the homepage
 * makes and the one a client would check.
 */
export function learningCurve(pairs: readonly CorrectionPair[], untouched: readonly { at: string }[] = []): CurvePoint[] {
  if (pairs.length === 0 && untouched.length === 0) return [];
  const week = 7 * 24 * 60 * 60 * 1000;
  const events = [
    ...pairs.map((p) => ({ at: p.at, distance: p.distance, edited: true })),
    ...untouched.map((u) => ({ at: u.at, distance: 0, edited: false })),
  ]
    .filter((e) => !Number.isNaN(Date.parse(e.at)))
    .sort((a, b) => a.at.localeCompare(b.at));
  if (events.length === 0) return [];

  const start = Date.parse(events[0]!.at);
  const buckets = new Map<number, { distance: number; edited: boolean }[]>();
  for (const e of events) {
    const idx = Math.floor((Date.parse(e.at) - start) / week);
    const list = buckets.get(idx) ?? [];
    list.push(e);
    buckets.set(idx, list);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([idx, rows]) => ({
      at: new Date(start + idx * week).toISOString().slice(0, 10),
      corrections: rows.filter((r) => r.edited).length,
      untouched: rows.filter((r) => !r.edited).length,
      mean: rows.reduce((s, r) => s + r.distance, 0) / rows.length,
    }));
}

export interface LearningVerdict {
  /** Absent when there is not enough evidence to say. NEVER defaulted to `true`. */
  improving?: boolean;
  first?: number;
  last?: number;
  corrections: number;
  /**
   * ═══ HOW FAR OFF A VERDICT IS, WHEN THERE ISN'T ONE ═══
   *
   * "Not yet" and "not yet, and here is how close" are different sentences, and only the second one
   * gives a founder a reason to come back. Home rendered every thin state as "Nothing measured yet",
   * which is what a business with three corrections and one with none both saw — so the one that was
   * actually making progress was told it had made none.
   *
   * Returned from HERE rather than derived in the console, because the bar is two conditions
   * (`MIN_CORRECTIONS`, and at least two weeks with data) and a UI re-deriving them would be a
   * second copy of the rule that decides the company's central claim.
   *
   * Both absent once there is a verdict.
   */
  needed?: number;
  /** Weeks with data so far. The other half of the bar — one week can never produce a direction. */
  weeks?: number;
  /** Plain sentence, safe to show a founder. Never names a file or a symbol. */
  note: string;
}

/**
 * Is it getting better?
 *
 * FAILS TO "WE CANNOT SAY YET" RATHER THAN TO "YES". This number is the company's central claim, so
 * the one unacceptable outcome is a screen that reports progress on four data points. `improving`
 * is left ABSENT rather than false when the evidence is thin, because "no" and "not yet known" are
 * different sentences to put in front of a founder and only one of them is honest here.
 *
 * The bar: at least two weeks with corrections, at least MIN_CORRECTIONS in total.
 */
export const MIN_CORRECTIONS = 8;

export function learningVerdict(curve: readonly CurvePoint[]): LearningVerdict {
  // Every draft counts toward the evidence bar, edited or not — a month of untouched drafts is the
  // strongest possible evidence and it would be perverse to call it "not enough data".
  // `?? 0` because a hand-built point from a caller that predates `untouched` would otherwise
  // make this NaN, and NaN fails every comparison below — which would silently skip the evidence
  // bar and report a direction on no data at all. That is the one outcome this function forbids.
  const corrections = curve.reduce((s, p) => s + p.corrections + (p.untouched ?? 0), 0);
  if (curve.length < 2 || corrections < MIN_CORRECTIONS) {
    return {
      corrections,
      needed: Math.max(0, MIN_CORRECTIONS - corrections),
      weeks: curve.length,
      note:
        `Not enough approved work yet to say whether the drafts are improving — ` +
        `${corrections} correction${corrections === 1 ? "" : "s"} so far.`,
    };
  }
  const first = curve[0]!.mean;
  const last = curve[curve.length - 1]!.mean;
  const pct = Math.round(Math.abs(last - first) * 100);

  /**
   * ═══ ZERO IS THE BEST OUTCOME, AND THIS CALLED IT A FAILURE ═══
   *
   * `improving = last < first` is right for every case except the one the product is aiming at.
   * With nothing ever rewritten, `first` and `last` are both 0, `last < first` is false, and the
   * demo embedded in the landing page told a visitor:
   *
   *   "3 weeks where nothing needed changing."
   *   "Drafts are not needing less editing yet — 0% more than when you started."
   *
   * Two sentences, adjacent, contradicting each other, over the number that IS the pitch. And "0%
   * more" is not a quantity — it is a subtraction that came out zero being read aloud.
   *
   * So the three degenerate cases get their own sentences. `improving` stays a boolean for callers
   * that colour a bar with it, and "nothing to improve" is reported as improving, because a founder
   * asking "is this getting better" and being shown a warning colour over a perfect record would
   * reasonably conclude the product cannot read its own numbers.
   */
  if (last === 0) {
    return {
      improving: true,
      first,
      last,
      corrections,
      note:
        first === 0
          ? "Nothing has needed editing yet — every draft went out as written."
          : `Drafts need no editing at all now, down from ${Math.round(first * 100)}% when you started.`,
    };
  }
  if (pct === 0) {
    return {
      improving: false,
      first,
      last,
      corrections,
      // Flat is flat. Saying "0% more" invites the reader to work out that it means "the same".
      note: `Drafts need about as much editing as when you started — ${Math.round(last * 100)}% of each one.`,
    };
  }
  const improving = last < first;
  return {
    improving,
    first,
    last,
    corrections,
    note: improving
      ? `Drafts need ${pct}% less editing than when you started.`
      : `Drafts are not needing less editing yet — ${pct}% more than when you started.`,
  };
}
