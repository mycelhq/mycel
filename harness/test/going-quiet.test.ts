// A founder who reached value and then stopped — and the customer who must never be nagged.
//
// `time-to-value.ts` in the console owns activation: signed up, never got to a first accepted
// deliverable. Once they reach it, nothing watched them again — and month three is where churn
// actually happens, when the habit dies rather than when the setup fails.
//
// The test that matters most is the bookkeeper.
import test from "node:test";
import assert from "node:assert/strict";
import goingQuiet from "../../library/workflows/going-quiet.mjs";

/** Every `every` days, `n` times, ending `endedDaysAgo` before `now`. */
const rhythm = (every: number, n: number, endedDaysAgo: number, now = "2026-09-30"): string[] => {
  const end = Date.parse(`${now}T00:00:00Z`) - endedDaysAgo * 86_400_000;
  return Array.from({ length: n }, (_, i) => new Date(end - (n - 1 - i) * every * 86_400_000).toISOString().slice(0, 10));
};

test("the monthly bookkeeper is never nagged, and that is the whole design", () => {
  // THE CUSTOMER A FIXED THRESHOLD GETS WRONG. A close runs once a month, so twenty-eight quiet days
  // is their normal. "No activity in 14 days" would tell the healthiest business on the platform
  // that something is wrong, which is how a product announces it does not understand what you do.
  const monthly = goingQuiet({ now: "2026-09-30", events: rhythm(30, 6, 26) });
  assert.equal(monthly.ready, true);
  assert.equal(monthly.quiet, false, "26 days into a 30-day rhythm is not quiet");
  assert.match(monthly.headline!, /Nothing unusual/);
  assert.match(monthly.headline!, /about every 4 weeks/);

  // And the same business genuinely gone is caught — three of their own cycles, not three of ours.
  const gone = goingQuiet({ now: "2026-09-30", events: rhythm(30, 6, 95) });
  assert.equal(gone.quiet, true);
});

test("the daily operator is caught in days, not in months", () => {
  // The other half of the same rule. Somebody who ran something every second day and has not in
  // twelve is drifting, and a monthly threshold would say nothing at all about them.
  const drifting = goingQuiet({ now: "2026-09-30", events: rhythm(2, 10, 12) });
  assert.equal(drifting.quiet, true);
  assert.equal(drifting.usual_gap_days, 2);
  assert.match(drifting.headline!, /12 days/);

  // A long weekend is not a churn signal. At a daily rhythm three times the gap is three days, so
  // there is a floor of a week — telling somebody they have gone quiet on the Tuesday after a bank
  // holiday is how this feature gets muted.
  assert.equal(goingQuiet({ now: "2026-09-30", events: rhythm(1, 10, 4) }).quiet, false);
  assert.equal(goingQuiet({ now: "2026-09-30", events: rhythm(1, 10, 9) }).quiet, true);
});

test("it refuses until there is a rhythm, so it never doubles up with activation", () => {
  // Two systems reporting the same founder is how a dashboard becomes noise. A brand-new signup is
  // `time-to-value`'s problem and needs help STARTING, which is a different message with a different
  // fix — so this stays silent by construction rather than by a flag somebody has to remember.
  const fresh = goingQuiet({ now: "2026-09-30", events: [] });
  assert.equal(fresh.ready, false);
  assert.equal(fresh.quiet, false);
  assert.match(fresh.why_not!, /getting started rather than about going quiet/);

  // Three events give two gaps and a "median" that is just their mean. A founder told they have gone
  // quiet on the strength of two intervals will be told it wrongly, once, and never read the next.
  const thin = goingQuiet({ now: "2026-09-30", events: rhythm(3, 3, 40) });
  assert.equal(thin.ready, false);
  assert.match(thin.why_not!, /no rhythm to compare against yet/);
  assert.equal(goingQuiet({ now: "2026-09-30", events: rhythm(3, 4, 40) }).ready, true, "four events is three gaps");
});

test("it leads with what is stuck, not with the silence", () => {
  // "We miss you" teaches a founder to filter the sender. Most of the time somebody goes quiet
  // because the product is holding something and did not say so loudly enough — naming it turns
  // being told off into being told something useful, and it is usually the actual cause.
  const r = goingQuiet({
    now: "2026-09-30",
    events: rhythm(3, 8, 21),
    waiting: [
      { what: "deliverables waiting for your sign-off", since: "2026-09-14", count: 4 },
      { what: "approval", since: "2026-09-22", count: 1 },
    ],
  });
  assert.equal(r.quiet, true);
  assert.match(r.headline!, /^4 deliverables waiting for your sign-off have been waiting since 2026-09-14/);
  // Oldest first: the thing that has been stuck longest is the thing that stopped them.
  assert.equal(r.waiting![0]!.since, "2026-09-14");

  // With nothing held, it says so plainly rather than inventing a reason.
  const bare = goingQuiet({ now: "2026-09-30", events: rhythm(3, 8, 21) });
  assert.match(bare.headline!, /that is a change rather than a quiet week/);
});

test("a median rather than a mean, so one holiday does not move the baseline", () => {
  // Weekly rhythm with a single three-week gap in it. A mean would read the usual gap as ~9 days and
  // stop noticing a real two-week silence; the median holds at 7.
  const withHoliday = ["2026-08-03", "2026-08-10", "2026-08-17", "2026-09-07", "2026-09-14", "2026-09-21"];
  const r = goingQuiet({ now: "2026-09-30", events: withHoliday });
  assert.equal(r.usual_gap_days, 7);
});

test("it is the same answer every time, and refuses to guess the date", () => {
  const events = rhythm(3, 8, 21);
  assert.deepEqual(goingQuiet({ now: "2026-09-30", events }), goingQuiet({ now: "2026-09-30", events }));
  assert.throws(() => goingQuiet({ events } as unknown as Parameters<typeof goingQuiet>[0]), /now is required/);
  // An event in the future is dropped rather than treated as "just active" — a clock skew on one row
  // must not silence the signal for a business that has genuinely stopped.
  const skewed = goingQuiet({ now: "2026-09-30", events: [...rhythm(3, 8, 21), "2026-12-01"] });
  assert.equal(skewed.quiet, true);
});
