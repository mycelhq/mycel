// Did a signal source predict your wins, or is it reading your pipeline back to you?
//
// Every intent vendor demos the same way: here are accounts showing intent, look how many became
// customers. That chart is survivorship with a price tag — the accounts that became customers were
// doing things that LOOK like intent, so a source firing once a deal is already moving correlates
// beautifully with won deals and has predicted nothing.
//
// The central test in this file is the one that catches a source with 100% precision and 5x lift and
// still tells the founder not to pay for it.
import test from "node:test";
import assert from "node:assert/strict";
import signalBacktest from "../../library/workflows/signal-backtest.mjs";

const acct = (name: string, won: boolean, signals: { source: string; observed_at: string }[], engaged_at?: string) => ({
  name,
  won,
  engaged_at,
  won_at: "2026-06-01",
  signals,
});

/** 46 accounts, 14 wins. `hiring` fires early; `category_intent` fires only once deals are moving. */
const BOOK = [
  ...Array.from({ length: 8 }, (_, i) => acct(`W${i}`, true, [{ source: "hiring", observed_at: "2026-02-01" }], "2026-03-12")),
  ...Array.from({ length: 12 }, (_, i) => acct(`L${i}`, false, [{ source: "hiring", observed_at: "2026-02-01" }])),
  ...Array.from({ length: 6 }, (_, i) => acct(`V${i}`, true, [{ source: "category_intent", observed_at: "2026-04-01" }], "2026-03-12")),
  ...Array.from({ length: 20 }, (_, i) => acct(`F${i}`, false, [])),
];

test("it catches a source with perfect precision and calls it worthless", () => {
  // THE TEST THIS FILE EXISTS FOR. `category_intent` flagged six accounts and all six won: 100%
  // precision, 5x lift, the exact chart a vendor puts on the pricing page. And every one of those
  // signals landed twenty days AFTER the conversation had already started.
  const r = signalBacktest({ accounts: BOOK });
  const vanity = r.sources.find((s: { source: string }) => s.source === "category_intent")!;

  assert.equal(vanity.precision, "100.0%", "it looks perfect");
  assert.equal(vanity.lift, 5, "and the lift looks perfect too");
  assert.equal(vanity.verdict, "reads your pipeline back to you");
  assert.ok(vanity.median_lead_days! < 0);
  assert.match(vanity.why, /describing deals in motion rather than finding them/);
});

test("and it recommends the one that actually predicted", () => {
  const r = signalBacktest({ accounts: BOOK });
  // Lower precision, real lead time. That is the trade, and lead time wins.
  assert.equal(r.sources[0]!.source, "hiring");
  assert.equal(r.sources[0]!.verdict, "worth paying for");
  assert.ok(r.sources[0]!.median_lead_days! > 30);
  assert.match(r.headline!, /hiring is the one worth paying for/);
  assert.match(r.headline!, /before the conversation started/);
});

test("lead time is measured from the first REPLY, not the close", () => {
  // Using the close alone flatters every source: a signal that fired a week after the first meeting
  // still looks like it predicted a deal that closed three months later.
  const late = [
    ...Array.from({ length: 6 }, (_, i) =>
      acct(`A${i}`, true, [{ source: "x", observed_at: "2026-04-01" }], "2026-03-01"),
    ),
    ...Array.from({ length: 10 }, (_, i) => acct(`B${i}`, false, [{ source: "x", observed_at: "2026-04-01" }])),
    // Unflagged accounts, so there IS a comparison group — otherwise this hits the
    // "it flagged everything" branch first and never reaches the lead-time question.
    ...Array.from({ length: 20 }, (_, i) => acct(`C${i}`, false, [])),
  ];
  const r = signalBacktest({ accounts: late });
  // Against the close (2026-06-01) this fired 61 days early and would read as predictive. Against
  // the first reply it fired 31 days LATE, which is the truth.
  assert.ok(r.sources[0]!.median_lead_days! < 0);
  assert.equal(r.sources[0]!.verdict, "reads your pipeline back to you");
});

test("a source no better than not having it is named as such", () => {
  // Flags everybody, so it separates nothing — the other way a vendor chart lies.
  const flat = [
    ...Array.from({ length: 10 }, (_, i) => acct(`W${i}`, true, [{ source: "everything", observed_at: "2026-01-01" }], "2026-03-01")),
    ...Array.from({ length: 30 }, (_, i) => acct(`L${i}`, false, [{ source: "everything", observed_at: "2026-01-01" }])),
  ];
  const r = signalBacktest({ accounts: flat });
  // Every account flagged means the flagged rate IS the base rate, and there is nothing to compare.
  assert.equal(r.sources[0]!.verdict, "no better than not having it");
});

test("real but barely-in-time is its own verdict, not a pass", () => {
  // Three days' warning is real and is not something you can build a motion on.
  const barely = [
    ...Array.from({ length: 8 }, (_, i) => acct(`W${i}`, true, [{ source: "y", observed_at: "2026-02-28" }], "2026-03-01")),
    ...Array.from({ length: 4 }, (_, i) => acct(`Y${i}`, false, [{ source: "y", observed_at: "2026-02-28" }])),
    ...Array.from({ length: 30 }, (_, i) => acct(`L${i}`, false, [])),
  ];
  const r = signalBacktest({ accounts: barely });
  assert.equal(r.sources[0]!.verdict, "late but real");
  assert.match(r.sources[0]!.why, /tiebreaker, not a trigger/);
});

test("too few wins is a refusal that says what would change it", () => {
  // A backtest on four wins is a coin flip with a chart on it.
  const thin = Array.from({ length: 40 }, (_, i) => acct(`A${i}`, i < 3, [{ source: "x", observed_at: "2026-01-01" }], "2026-03-01"));
  const r = signalBacktest({ accounts: thin });
  assert.equal(r.ready, false);
  assert.deepEqual(r.sources, []);
  assert.match(r.why_not!, /coin flip with a chart on it/);

  const few = Array.from({ length: 10 }, (_, i) => acct(`A${i}`, true, [], "2026-03-01"));
  assert.match(signalBacktest({ accounts: few }).why_not!, /at least 30/);
});

test("a source that barely fired is 'not enough', not a verdict", () => {
  const rare = [
    ...Array.from({ length: 2 }, (_, i) => acct(`W${i}`, true, [{ source: "rare", observed_at: "2026-01-01" }], "2026-03-01")),
    ...Array.from({ length: 8 }, (_, i) => acct(`W2${i}`, true, [{ source: "common", observed_at: "2026-01-01" }], "2026-03-01")),
    ...Array.from({ length: 30 }, (_, i) => acct(`L${i}`, false, [{ source: "common", observed_at: "2026-01-01" }])),
  ];
  const r = signalBacktest({ accounts: rare });
  const rareSrc = r.sources.find((s: { source: string }) => s.source === "rare")!;
  assert.equal(rareSrc.verdict, "not enough");
  assert.match(rareSrc.why, /too few to judge either way/);
});

test("it grades whatever sources the book contains, not a fixed list", () => {
  const odd = [
    ...Array.from({ length: 8 }, (_, i) => acct(`W${i}`, true, [{ source: "planning_application", observed_at: "2026-01-01" }], "2026-03-01")),
    ...Array.from({ length: 4 }, (_, i) => acct(`P${i}`, false, [{ source: "planning_application", observed_at: "2026-01-01" }])),
    ...Array.from({ length: 30 }, (_, i) => acct(`L${i}`, false, [])),
  ];
  assert.equal(signalBacktest({ accounts: odd }).sources[0]!.source, "planning_application");
});

test("the headline is a decision, never a table", () => {
  // A backtest ending in numbers and no recommendation gets read once.
  const noneGood = [
    ...Array.from({ length: 6 }, (_, i) => acct(`V${i}`, true, [{ source: "late", observed_at: "2026-04-01" }], "2026-03-01")),
    ...Array.from({ length: 4 }, (_, i) => acct(`X${i}`, false, [{ source: "late", observed_at: "2026-04-01" }])),
    ...Array.from({ length: 30 }, (_, i) => acct(`F${i}`, false, [])),
  ];
  assert.match(signalBacktest({ accounts: noneGood }).headline!, /your own pipeline being sold back to you/);
  assert.match(signalBacktest({ accounts: BOOK }).headline!, /worth paying for/);
});

test("an empty book is refused rather than graded", () => {
  assert.throws(() => signalBacktest({ accounts: [] }), /must not be empty/);
});
