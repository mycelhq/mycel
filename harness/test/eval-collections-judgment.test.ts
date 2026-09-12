// HARD EVAL — collections judgment. "Is the system actually good at running an AR-chasing business?"
//
// This is not a unit test of a function; it is an EVAL of the system's judgment on the adversarial,
// money-and-relationship situations a real collections business hits every week — the ones where a
// wrong call loses a client or looks like a scam. Every case has a knowable right answer, and the
// score is the system's actual decision, not a model's self-report. The dunning ladder is the
// deterministic primitive the whole vertical rests on (invoice-chaser references it by `lib`), so
// grading it here grades the product's collections conscience.
//
// The bar: a mistake here would embarrass a founder in front of a paying client. Softballs are
// worthless; each case is chosen because getting it wrong is expensive.
import { test } from "node:test";
import assert from "node:assert/strict";
import dunningLadder from "../../workflows/dunning-ladder.mjs";

interface Case {
  name: string;
  facts: Record<string, unknown>;
  expect: { step: string; escalate?: boolean };
  why: string; // the money-or-relationship reason the wrong call is expensive
}

// The hard cases. Ordered from "most catastrophic if wrong" down.
const CASES: Case[] = [
  {
    name: "a DISPUTED invoice is never chased — it is escalated to a human",
    facts: { days_overdue: 45, disputed: true },
    expect: { step: "hold", escalate: true },
    why: "chasing a client who is disputing the bill is how you turn a disagreement into a lost account and a bad review",
  },
  {
    name: "a client who PROMISED to pay by a future date is waited on, not chased",
    facts: { days_overdue: 20, promised_payment_date: "2026-09-01", today: "2026-08-20" },
    expect: { step: "hold", escalate: false },
    why: "chasing someone who already committed to a date, before that date, reads as harassment and breaks trust you were about to collect on",
  },
  {
    name: "the same invoice is NOT chased twice inside 48h",
    facts: { days_overdue: 30, last_chased_days_ago: 1 },
    expect: { step: "hold", escalate: false },
    why: "double-chasing in a day is the single fastest way to look like a broken bot and get marked as spam",
  },
  {
    name: "an invoice not yet overdue is left alone",
    facts: { days_overdue: 0 },
    expect: { step: "hold", escalate: false },
    why: "chasing money that is not yet owed destroys the relationship for a debt that does not exist",
  },
  {
    name: "a client in good standing gets a FRIENDLY reminder even well past due",
    facts: { days_overdue: 15, good_standing: true },
    expect: { step: "reminder", escalate: false },
    why: "firing a firm/final notice at your best-paying client over a slow month is how you lose a retainer worth more than the invoice",
  },
  {
    name: "a mildly overdue invoice gets a gentle reminder, not a threat",
    facts: { days_overdue: 5 },
    expect: { step: "reminder", escalate: false },
    why: "a heavy notice at 5 days overdue reads as aggressive and trains clients to resent the sender",
  },
  {
    name: "a two-week overdue invoice escalates tone to a firm reminder",
    facts: { days_overdue: 14 },
    expect: { step: "firm_reminder", escalate: false },
    why: "staying friendly forever teaches clients the deadline is optional; the ladder must actually climb",
  },
  {
    name: "a month overdue reaches a final notice that references contract terms only",
    facts: { days_overdue: 30 },
    expect: { step: "final_notice", escalate: false },
    why: "a final notice must be firm and factual — not improvised threats a founder would be embarrassed by",
  },
  {
    name: "long overdue hands off to a HUMAN rather than escalating on its own",
    facts: { days_overdue: 60 },
    expect: { step: "final_notice", escalate: true },
    why: "past a point, collections is a legal/relationship decision a machine must not make alone — it escalates",
  },
];

test("EVAL: collections judgment on the hard, adversarial cases a real AR business hits", () => {
  const failures: string[] = [];
  for (const c of CASES) {
    const got = dunningLadder(c.facts) as { step: string; escalate: boolean };
    const stepOk = got.step === c.expect.step;
    const escOk = c.expect.escalate === undefined || got.escalate === c.expect.escalate;
    if (!stepOk || !escOk) {
      failures.push(
        `✗ ${c.name}\n    expected step=${c.expect.step}${c.expect.escalate !== undefined ? ` escalate=${c.expect.escalate}` : ""}` +
          `, got step=${got.step} escalate=${got.escalate}\n    cost of this miss: ${c.why}`,
      );
    }
  }
  const passed = CASES.length - failures.length;
  // The eval reports its own scoreboard, so a regression is a number a founder understands.
  console.log(`\n  collections-judgment eval: ${passed}/${CASES.length} passed`);
  assert.equal(
    failures.length,
    0,
    `\n${failures.join("\n")}\n\n  Collections judgment is the conscience of the AR-chasing vertical. A failing case is a real client relationship the system would damage.`,
  );
});
