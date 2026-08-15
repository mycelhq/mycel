// The shared two-pass matcher, and the guarantee that it has not drifted from the wedge workflow it
// was extracted from.
//
// Every assertion here names the money bug it prevents. Matching is where money bugs live: an
// over-eager match settles an invoice nobody paid (and stops the chase that should have continued),
// and a double match settles two invoices with one payment (and writes off the second).
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchTwoPass } from "../src/match";
// The ancestor implementation, loaded as the wedge's own module. If this import ever breaks, the
// anti-drift test below is the thing that must be fixed rather than deleted.
// @ts-expect-error — a .mjs wedge workflow with no type declarations, deliberately.
// reconcile is now a kernel-owned SHARED primitive that books-keeper references by lib, not a file
// in the wedge directory — so this drift check imports it from the shared library.
import reconcile from "../../workflows/reconcile.mjs";

const p = (key: string, amount: number, date?: string, reference?: string) => ({ key, amount, date, reference });

test("match: a reference beats arithmetic, because the client told us what they were paying for", () => {
  const r = matchTwoPass(
    [p("pay1", 5000, "2024-03-04", "INV-0007")],
    [p("inv-a", 9999, "2024-03-01", "INV-0007"), p("inv-b", 5000, "2024-03-04")],
  );
  assert.equal(r.matched.length, 1);
  assert.equal(r.matched[0].right.key, "inv-a", "the quoted reference wins over an exact amount+date coincidence");
  assert.equal(r.matched[0].basis, "reference");
});

test("match: one payment can never settle two invoices", () => {
  // THE BUG: without a used-set, a £500 payment matching two identical £500 invoices marks BOTH
  // paid — silently writing off the second one, which is money the business never collects and
  // never notices is missing.
  const r = matchTwoPass(
    [p("pay1", 50_000, "2024-03-01")],
    [p("inv-a", 50_000, "2024-03-01"), p("inv-b", 50_000, "2024-03-01")],
  );
  assert.equal(r.matched.length, 1, "exactly one invoice is settled");
  assert.equal(r.unmatched_right.length, 1, "the other is still owed and still chaseable");
});

test("match: amount alone never matches — the monthly-retainer bug", () => {
  // THE BUG: a business billing the same retainer every month has twelve identical invoices. Match
  // on amount with any date tolerance and March's payment settles February's invoice: February's
  // client keeps getting chased for money they paid, and March quietly looks settled. Neither half
  // is visible in any log. So: no date, no match.
  const r = matchTwoPass([p("pay1", 50_000, undefined)], [p("inv-a", 50_000, "2024-03-01")]);
  assert.equal(r.matched.length, 0);
  assert.equal(r.unmatched_left.length, 1, "it goes to a human instead of being guessed");

  const nearMiss = matchTwoPass([p("pay1", 50_000, "2024-03-02")], [p("inv-a", 50_000, "2024-03-01")]);
  assert.equal(nearMiss.matched.length, 0, "one day off is not a match; there is no tolerance window");
});

test("match: a reference claimed by two invoices matches nothing, and says so", () => {
  // THE BUG: reconcile.mjs builds its lookup with `new Map(entries.map(...))`, which is last-write-
  // wins — so with two rows quoting "INV-0007" one becomes unreachable and which one depends on
  // array order. Picking at random here means marking an invoice paid with somebody else's money.
  const r = matchTwoPass(
    [p("pay1", 5000, "2024-03-04", "INV-0007")],
    [p("inv-a", 5000, "2024-03-01", "INV-0007"), p("inv-b", 7000, "2024-03-02", "inv-0007")],
  );
  assert.deepEqual(r.ambiguous_references, ["INV-0007"], "normalised, and named so a human can resolve it");
  assert.equal(r.matched.length, 0, "an ambiguous reference matches NOTHING rather than one at random");
});

test("match: a float amount is refused rather than rounded", () => {
  // THE BUG: money is integer minor units everywhere in this kernel. A float arriving from a
  // provider's JSON turns an exact-match algorithm into a probabilistic one, and 12.50 silently
  // becoming 12 minor units is a hundredfold error in the business's favour or the client's.
  assert.throws(
    () => matchTwoPass([{ key: "a", amount: 12.5, date: "2024-01-01" }], []),
    /whole number of minor units/,
  );
});

test("match: agrees with the books-keeper reconcile workflow it was extracted from", () => {
  // THE BUG THIS PREVENTS IS DRIFT. `wedges/books-keeper/workflows/reconcile.mjs` runs in the
  // sandbox and cannot import from the harness, so the CODE is necessarily duplicated. This test is
  // what makes the BEHAVIOUR shared: if either side is changed without the other, it fails here and
  // names the input they disagreed on, rather than the two quietly diverging on money for a year.
  //
  // Only unambiguous fixtures are compared. The two are deliberately DIFFERENT on a duplicated
  // reference (see the test above), and that difference is a documented improvement, not drift.
  const cases = [
    {
      bank: [{ reference: "INV-1", amount_cents: 5000, date: "2024-01-02" }],
      ledger: [{ reference: "INV-1", amount_cents: 5000, date: "2024-01-02" }],
    },
    {
      bank: [{ amount_cents: 5000, date: "2024-01-02" }],
      ledger: [{ reference: "INV-9", amount_cents: 5000, date: "2024-01-02" }],
    },
    {
      bank: [{ reference: "NOPE", amount_cents: 1234, date: "2024-01-05" }],
      ledger: [{ reference: "INV-2", amount_cents: 9999, date: "2024-01-05" }],
    },
    {
      bank: [
        { reference: "INV-3", amount_cents: 100, date: "2024-02-01" },
        { amount_cents: 100, date: "2024-02-01" },
      ],
      ledger: [
        { reference: "INV-3", amount_cents: 100, date: "2024-02-01" },
        { reference: "INV-4", amount_cents: 100, date: "2024-02-01" },
      ],
    },
  ];

  for (const [i, c] of cases.entries()) {
    const legacy = reconcile({ bank_transactions: c.bank, ledger_entries: c.ledger });
    const shared = matchTwoPass(
      c.bank.map((t, n) => ({ key: `b${n}`, reference: t.reference, amount: t.amount_cents, date: t.date })),
      c.ledger.map((e, n) => ({ key: `l${n}`, reference: e.reference, amount: e.amount_cents, date: e.date })),
    );
    assert.equal(
      shared.unmatched_left.length,
      legacy.unmatched_bank.length,
      `case ${i}: the shared matcher and reconcile.mjs disagree on how many bank rows are unplaced`,
    );
    assert.equal(
      shared.unmatched_right.length,
      legacy.unmatched_ledger.length,
      `case ${i}: they disagree on how many ledger rows are unconsumed`,
    );
  }
});
