/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * THE DEMO'S OWN ANSWER TO THE ONE QUESTION THE PRODUCT IS SOLD ON
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Home's lead figure is the share of each draft still the founder's, and whether it is falling.
 * `masthead.tsx`: *"the other three are status, `stillYours` is the PRODUCT"*. On the live demo
 * tenant, on 12 September, the kernel's own `learningCurve` over the seeded history said:
 *
 *     "Drafts are not needing less editing yet — 2% more than when you started."
 *
 * The fixture was arguing against the product, on the product's central claim, to every prospect who
 * opened the demo. Not because the curve was wrong — the curve was right about the rows it was given.
 * `seed-history.ts` put its only two sent-back deliverables on the NEWEST two files, and three clean
 * weeks followed by a week with corrections in it is, arithmetically, a business getting worse.
 *
 * ═══ WHY THIS IS A MODULE AND NOT TWELVE LINES INSIDE THE SEEDER ═══
 *
 * Because the seeder's output is a CLAIM, and until now nothing checked it. The direction of the
 * demo's learning curve was an emergent property of two ternaries and a date offset, observable only
 * by seeding a database and reading a percentage off a screen — which is how it was wrong for as
 * long as it was, and how it would silently invert again the next time somebody reordered `FILES`.
 *
 * Everything that decides the curve is here: which drafts were sent back, what each draft said, and
 * when each version happened relative to the deliverable's own date. `seed-history.ts` imports it
 * and writes the SQL; `test/the-demo-argues-for-the-product.test.ts` imports it and runs the real
 * `correctionPairs` → `learningCurve` → `learningVerdict` over the result, asserting the demo says
 * the thing the landing page says. Neither owns a second copy of the rule.
 *
 * ═══ WHY THE DRAFTS ARE WRITTEN OUT RATHER THAN DERIVED ═══
 *
 * The superseded versions used to be the final summary with "(superseded — see version 2.)" appended.
 * That is a LABEL, not a draft, and it has a measurable consequence: `editDistance` is word-level
 * Levenshtein over the two summaries, so five words bolted onto a thirty-word paragraph scores a 2%
 * correction however badly the first attempt missed the point. Every send-back in the fixture was
 * worth 2%, the curve was flat, and its direction was decided by rounding.
 *
 * These are the genuinely worse version — the one that reports that the work RAN instead of what it
 * found — and each client ask names what is missing. Read in order, the three versions of the
 * competitor sweep are a client teaching a service what a useful answer is. That is the product, and
 * it is also the only honest way to make the number move.
 */

/** A draft that was sent back, and the sentence the client sent it back with. */
export interface SeedRevision {
  /** What this version said. Deliberately worse than the next one, in a way a reader can see. */
  summary: string;
  /** The client's ask. Names what is missing, never "please revise". */
  ask: string;
  /**
   * How many days before the CURRENT version this draft was written. The ask lands the day after.
   *
   * Not a constant, and the reason is arithmetic rather than realism. `learningCurve` buckets by
   * whole weeks from the first event, so a correction's week is decided by this number — and the one
   * recent correction exists specifically to keep the LATEST week from reading 0%. At a flat four
   * days it landed in the week before last instead, the latest bucket was pure untouched drafts, and
   * the masthead showed "Still yours: 0%" on a demo: true, improving, and unbelievable.
   *
   * It also happens to be how this works. A client who sends back a report with two substantial asks
   * takes a week over it; one who wants a sentence added replies the same afternoon.
   */
  draftedDaysEarlier: number;
}

/**
 * Which seeded deliverables were sent back, keyed by INDEX INTO `FILES`.
 *
 * The index is the date: `seed-history.ts` dates deliverable `i` at `at(2 + i)`, so a HIGHER index is
 * FURTHER IN THE PAST. The corrections therefore sit at 9 and 8 (the first week) and the single small
 * one at 0 (this week) — heavy correction at the start, a clause at the end, which is both the
 * direction the product claims and the only version of this that anybody's experience of delegating
 * work actually resembles.
 *
 * Keyed rather than a flat array because most deliverables have no revision history and an array of
 * nine empty slots invites an off-by-one in the one place it would be invisible.
 */
export const REVISIONS: Record<number, readonly SeedRevision[]> = {
  // 19 and 15 days ago — the first week, when nothing landed right.
  9: [
    {
      summary: "Ran the sweep across all nine buyer questions. Full results in the attached sheet.",
      ask: "This tells me you ran it, not what it found. Which questions are we losing, and who to?",
      /*
        THE FIRST DRAFT THIS TENANT EVER PRODUCED, AND IT HAS TO BE THE OLDEST THING IN THE RECORD.

        `first` on the verdict is the FIRST WEEKLY BUCKET's mean, and `seed-tenant.ts` parks four
        untouched deliverables on one day 25 days ago. While those shared the opening bucket with this
        correction, the bucket averaged 24% and the headline read "drafts need 18% less editing than
        when you started" on a tenant whose first draft was rewritten almost entirely.

        At 22 and 15 days before its final version, the two rejected drafts of the competitor sweep sit
        a clear week ahead of anything else in the tenant, so the record OPENS on the correction that
        earned the claim: 94% → 83% → 85% → nothing → 6%.

        A report that took three weeks and two rejections to land is also the truest thing in this
        fixture. That is what the first one costs.
      */
      draftedDaysEarlier: 22,
    },
    {
      summary: "You win three of the nine outright and lose six. DSV and Kuehne take most of the six.",
      ask: "Closer. Why do we lose them? Give me something I can act on rather than a scoreline.",
      draftedDaysEarlier: 15,
    },
  ],
  /*
    15 days ago, and it is here for a reason that is not realism.

    `seed-tenant.ts` — a different script, which owns the tenant's CLIENTS — leaves four deliverables
    of its own dated on one day at the very start of the record, all untouched. So the demo's first
    week opens with four drafts that needed no correction, which drags the first bucket's mean down and
    therefore shrinks the whole claim: with three corrections the live tenant read "drafts need 18%
    less editing than when you started" where the fixture alone reads 81%.

    The honest fix is more corrected work in the first fortnight, not fewer clean drafts: a service
    three weeks old that got four things right first time and four things wrong is a believable
    beginning, and it is the only version of this that does not require reaching into another script's
    rows. `the-demo-argues-for-the-product.test.ts` models the fixture in isolation, so it cannot see
    the dilution — which is why this comment carries the measurement.
  */
  7: [
    {
      summary: "Positions are in the attached sheet. Harpenden improved, Redbourn did not.",
      ask: "Which ones moved, and why not Redbourn? I need to know what to do about it, not that it happened.",
      draftedDaysEarlier: 6,
    },
  ],
  // 14 days ago — better, and still one step short.
  8: [
    {
      summary: "4.6 across 41 Google reviews. Sentiment is broadly positive with a few operational complaints.",
      ask: "“A few operational complaints” is the entire point of this. Name them, and say which is new.",
      draftedDaysEarlier: 4,
    },
  ],
  // 6 days ago — a clause, not a rewrite. This is the figure the masthead shows today.
  0: [
    {
      summary:
        "Named in 6 of 9 buyer questions, up from 4 in March. The one still missing you is " +
        "“best 3PL for ecommerce” — DSV wins it by listing the platforms they integrate with.",
      ask: "Good. Add the line about what we would change, so Tom has something to do with it.",
      // Two days, so this correction lands in the CURRENT week. See `draftedDaysEarlier`.
      draftedDaysEarlier: 2,
    },
  ],
};

export const revisionsFor = (i: number): readonly SeedRevision[] => REVISIONS[i] ?? [];

/** One `deliverable_versions` row, before it is given an id and a project. */
export interface SeedVersion {
  version: number;
  summary: string;
  /**
   * Always `agent`, and that is the whole reason this history has to be fabricated rather than
   * clicked: `author` is stamped by the ROUTE, and the only route that stamps `agent` is the one a
   * sandbox calls with a run's grant. A founder-plane seed can write `founder` versions all day and
   * `untouchedDrafts` will count none of them, because a correction is a human editing a MACHINE's
   * draft and a seed with no runs has no machine drafts. See `seed-demo.ts`, which cannot do this.
   */
  author: "agent";
  /** Days ago. Every version of a deliverable is older than the next one. */
  daysAgo: number;
  /** Days ago, or null for the version that is still current. */
  changeRequestedDaysAgo: number | null;
  changeRequest: string | null;
  /** Only the current version carries the file: an earlier draft is a record of the ask. */
  carriesFile: boolean;
}

/**
 * Every version of seeded deliverable `i`, oldest first.
 *
 * `baseDaysAgo` is the deliverable's own date (`2 + i` in the seeder). Each earlier draft sits
 * `draftedDaysEarlier` before it, and the client's ask lands the day after the draft it is about — so
 * a reader scrolling the version list sees draft, ask, redraft, ask, redraft, in that order.
 */
export function seedVersions(args: {
  index: number;
  baseDaysAgo: number;
  finalSummary: string;
}): SeedVersion[] {
  const revisions = revisionsFor(args.index);
  const finalVersion = revisions.length + 1;
  const out: SeedVersion[] = [];
  for (let v = 1; v <= finalVersion; v++) {
    const last = v === finalVersion;
    const daysAgo = last ? args.baseDaysAgo : args.baseDaysAgo + revisions[v - 1]!.draftedDaysEarlier;
    out.push({
      version: v,
      summary: last ? args.finalSummary : revisions[v - 1]!.summary,
      author: "agent",
      daysAgo,
      changeRequestedDaysAgo: last ? null : daysAgo - 1,
      changeRequest: last ? null : revisions[v - 1]!.ask,
      carriesFile: last,
    });
  }
  return out;
}

/**
 * The ten files the demo tenant has delivered, newest first.
 *
 * THE ORDER IS THE DATE. `seed-history.ts` dates deliverable `i` at `at(2 + i)`, so index 0 is two
 * days ago and index 9 is eleven. Reordering this array therefore moves the demo's whole history —
 * including which week the corrections landed in, which is the thing `REVISIONS` above is keyed on
 * and the thing that decides what Home tells a prospect about whether the product works.
 *
 * Every entry is `<client>-<what>.<ext>`: `seed-history.ts` matches the prefix against a client's
 * display name and THROWS if it matches nobody, because a fixture quietly attributing work to
 * whoever was next in the array is how five of ten deliverables ended up on a stranger's engagement.
 */
export const FILES = [
  { name: "ridgeline-visibility-april.csv", type: "text/csv", kind: "report", title: "Ridgeline — April AI visibility" },
  { name: "ridgeline-visibility-march.csv", type: "text/csv", kind: "report", title: "Ridgeline — March AI visibility" },
  { name: "fairmont-listings-audit.csv", type: "text/csv", kind: "report", title: "Fairmont Dental — listings audit" },
  { name: "willow-pricing-copy.md", type: "text/markdown", kind: "document", title: "Willow & Pine — pricing page copy" },
  { name: "marlow-q2-content-plan.md", type: "text/markdown", kind: "document", title: "Marlow — Q2 content plan" },
  { name: "delgado-launch-review.md", type: "text/markdown", kind: "document", title: "Delgado — post-launch review" },
  { name: "sunset-lifecycle-emails.md", type: "text/markdown", kind: "document", title: "Sunset — lifecycle email sequence" },
  { name: "cedar-local-seo.csv", type: "text/csv", kind: "report", title: "Cedar Home Care — local SEO positions" },
  { name: "pike-reviews-summary.csv", type: "text/csv", kind: "report", title: "Pike Street — reviews summary" },
  { name: "ridgeline-competitor-sweep.csv", type: "text/csv", kind: "report", title: "Ridgeline — competitor sweep" },
];

/**
 * What each delivered file SAYS, which is the only part of a deliverable anybody reads first.
 *
 * Also the text `editDistance` measures. A correction's size is the word-level distance between one
 * version's summary and the next, so these sentences and the drafts in `REVISIONS` together are the
 * demo's learning curve. They are not captions.
 */
export const SUMMARY: Record<string, string> = {
  "ridgeline-visibility-april.csv":
    "Named in 6 of 9 buyer questions, up from 4 in March. The one still missing you is \"best 3PL for ecommerce\" — DSV wins it by listing the platforms they integrate with, which your solutions page does not.",
  "ridgeline-visibility-march.csv":
    "Named in 4 of 9. Two of the misses are the same page problem: the answer is below the case studies, so nothing reads it as the answer.",
  "ridgeline-competitor-sweep.csv":
    "You take the answer outright on three questions and lose six. Five of the six go to a page that answers in its first paragraph; yours answer in the third.",
  "fairmont-listings-audit.csv":
    "Fairview Road shows the wrong Saturday hours where most people look, and Marsh Lane is missing from Bing entirely. Nine of sixteen listings are clean.",
  "cedar-local-seo.csv":
    "Harpenden moved from 7 to 3 and into the map pack after the hours fix. Redbourn has no page of its own — everything there ranks off the St Albans page, which is why it sits at 9.",
  "pike-reviews-summary.csv":
    "4.6 across 41 Google reviews. Lunch service speed is the one theme moving the wrong way, and \"card machine declined\" is new this month — four mentions in thirty days.",
  "willow-pricing-copy.md":
    "Rewritten pricing page, plus the query behind the tiers table. Ready for the build.",
  "marlow-q2-content-plan.md":
    "Twelve pieces for Q2, sequenced so the two that need a partner interview are booked first.",
  "delgado-launch-review.md":
    "Eleven enquiries against two before the rebuild. One form field is costing submissions.",
  "sunset-lifecycle-emails.md":
    "Six emails, the second half of the lifecycle build. Copy and the segment each one sends to.",
};
