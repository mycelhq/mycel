// The arithmetic a language model kept getting wrong, done once and deterministically.
//
// Thirty runs of the monthly close were read by a paying client. After the delivery machinery was
// fixed, EVERY remaining complaint was a number the model had retyped: a reconciliation table £173
// out, a profit stated as £3,730.61 in the attached P&L and £4,070.61 in the covering note,
// £34,000.00 written for 34000 minor units, a held total of £1,032.90 against five lines adding to
// £972.90. Each got a `ship_checks` gate; each gate reads the model's JSON; the errors moved into
// the markdown tables and the prose where nothing looks.
//
// This is the other answer: the model supplies judgement, `close_figures` supplies arithmetic, and
// the files are RENDERED rather than written. A number that is never retyped cannot be retyped
// wrong.
import test from "node:test";
import assert from "node:assert/strict";
import closeFigures from "../../library/workflows/close-figures.mjs";

/** The July ledger the loop has been running on, in the shape the workflow takes. */
const TX = [
  { date: "2026-07-03", amount_minor: 480000, description: "Invoice INV-2026-071 — brand system", counterparty: "Kestrel Coffee Ltd", category: "sales" },
  { date: "2026-07-04", amount_minor: -128000, description: "Studio rent, July", counterparty: "Marlowe Property", category: "rent" },
  { date: "2026-07-05", amount_minor: -4799, description: "Adobe Creative Cloud", counterparty: "Adobe", category: "software" },
  { date: "2026-07-06", amount_minor: -21600, description: "Contractor — illustration", counterparty: "P. Adeyemi", category: "subcontractors", held: true },
  { date: "2026-07-07", amount_minor: -8940, description: "Train, client workshop", counterparty: "GWR", category: "travel" },
  { date: "2026-07-11", amount_minor: 264000, description: "Invoice INV-2026-072", counterparty: "Thorne & Sons", category: "sales" },
  { date: "2026-07-12", amount_minor: -3200, description: "Figma, 4 seats", counterparty: "Figma", category: "software" },
  { date: "2026-07-13", amount_minor: -14750, description: "Client lunch", counterparty: "The Ox", category: "entertaining", held: true },
  { date: "2026-07-14", amount_minor: -195000, description: "Payroll — July, 2 staff", counterparty: "HMRC/Payroll", category: "payroll" },
  { date: "2026-07-18", amount_minor: -6650, description: "Stripe fees", counterparty: "Stripe", category: "bank_fees" },
  { date: "2026-07-19", amount_minor: 96000, description: "Retainer", counterparty: "Vale Dental", category: "sales" },
  { date: "2026-07-20", amount_minor: -34000, description: "Unknown — card ending 4417", category: "suspense", held: true, excluded: true },
  { date: "2026-07-21", amount_minor: -2400, description: "Domain renewals x3", counterparty: "Hover", category: "software" },
  { date: "2026-07-25", amount_minor: -18000, description: "Contractor — copywriting", counterparty: "J. Rahman", category: "subcontractors", held: true },
  { date: "2026-07-26", amount_minor: 144000, description: "Invoice INV-2026-073", counterparty: "Kestrel Coffee Ltd", category: "sales" },
  { date: "2026-07-28", amount_minor: -9600, description: "Insurance, PI", counterparty: "Hiscox", category: "insurance" },
];

const BASE = {
  transactions: TX,
  opening_balance_minor: 812400,
  closing_balance_minor: 1349461,
  sales_tax_rate_pct: 20,
  currency: "GBP",
  period: "July 2026",
  client: "Harlow & Finch",
};

test("every figure the close reports, and they agree with each other by construction", () => {
  const r = closeFigures(BASE);

  assert.equal(r.receipts_minor, 984000);
  assert.equal(r.payments_minor, -446939);
  assert.equal(r.net_movement_minor, 537061);
  assert.equal(r.computed_closing_minor, 1349461);
  assert.equal(r.difference_minor, 0);
  assert.equal(r.reconciled, true);

  // Tax-inclusive: 984000 ÷ 6. The `× 0.2` mistake would give 196800 and a client noticed the
  // one-penny version of it — see uk-vat.md on why it is ÷ 6 and rounded once.
  assert.equal(r.output_tax_minor, 164000);
  assert.equal(r.net_sales_minor, 820000);

  // The £340 card payment is excluded, so expenses are 446939 − 34000.
  assert.equal(r.expenses_minor, 412939);
  assert.equal(r.net_minor, 820000 - 412939);
  assert.equal(r.net_minor, 407061);

  // The identity `ship_checks.nets_to` exists to police holds by construction here.
  assert.equal(r.revenue_minor - r.expenses_minor, r.net_minor);

  // Four open questions; the excluded one is among them and is counted once.
  assert.equal(r.held.item_count, 4);
  assert.equal(r.held.amount_minor, -21600 - 14750 - 34000 - 18000);
  assert.equal(r.excluded.item_count, 1);
});

test("minor units are converted in exactly one place", () => {
  // "Total payments of £4,469.39 include £34,000.00 in suspense" reached a client. The item is 34000
  // minor units — £340.00 — and the conversion was being done by hand, per figure, in a sentence.
  const r = closeFigures(BASE);
  assert.equal(r.formatted.net, "£4,070.61");
  assert.equal(r.formatted.payments, "-£4,469.39");
  assert.equal(r.formatted.closing_per_ledger, "£13,494.61");
  assert.equal(r.formatted.output_tax, "£1,640.00");
  assert.equal(r.formatted.difference, "£0.00");
  // Thousands separators and pence, every time, without the model choosing.
  assert.equal(closeFigures({ ...BASE, transactions: [{ date: "x", amount_minor: -34000 }] }).formatted.payments, "-£340.00");
  assert.equal(closeFigures({ ...BASE, currency: "USD", transactions: [{ date: "x", amount_minor: 100000000 }] }).formatted.receipts, "$1,000,000.00");
});

test("the rendered ledger is valid CSV, with no totals row and nothing else in it", () => {
  const r = closeFigures(BASE);
  const csv = r.files["ledger.csv"];
  const lines = csv.trim().split("\n");
  assert.equal(lines.length, TX.length + 1, "header plus one row per transaction, and nothing else");

  // The failure this ends: `Studio rent, July` unquoted shifted every column right for the rest of
  // the file, and the client opened a ledger with counterparties under `description`.
  assert.match(csv, /"Studio rent, July"/);
  const fields = (line: string): number => {
    let n = 1;
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (quoted && line[i + 1] === '"') i++;
        else quoted = !quoted;
      } else if (ch === "," && !quoted) n++;
    }
    return n;
  };
  const want = fields(lines[0]!);
  for (const l of lines) assert.equal(fields(l), want, `every row has ${want} fields: ${l}`);

  // A quote inside a value survives too.
  const q = closeFigures({ ...BASE, transactions: [{ date: "d", amount_minor: -1, description: 'He said "no", twice' }] });
  assert.match(q.files["ledger.csv"], /"He said ""no"", twice"/);
});

test("the reconciliation statement says what was checked against what", () => {
  // The most repeated complaint of the whole loop: "they have only demonstrated that £8,124.00 +
  // £5,370.61 = £13,494.61. That is a calculation, not evidence of a bank reconciliation."
  const r = closeFigures(BASE);
  const md = r.files["bank-reconciliation.md"];
  assert.match(md, /Opening balance/);
  assert.match(md, /Closing balance per statement/);
  assert.match(md, /£13,494\.61/);
  // The qualification LEADS. The first version put the table first with `Difference £0.00` in it and
  // the caveat underneath, and the client read it exactly as written: "the headline says there is no
  // difference, then the document admits that statement reconciliation cannot be done without the
  // statement. That qualification should be the headline." A zero read before the limit that produced
  // it is a zero the reader trusts more than it deserves.
  assert.match(md, /supplied as a figure, not as a statement/);
  assert.ok(
    md.indexOf("not as a statement") < md.indexOf("Difference"),
    "the caveat comes before the number it qualifies",
  );

  // No statement figure at all: "we could not check" must never read as "it agrees".
  const noStatement = closeFigures({ ...BASE, closing_balance_minor: undefined });
  assert.equal(noStatement.reconciled, false);
  assert.equal(noStatement.difference_minor, undefined);
  assert.match(noStatement.files["bank-reconciliation.md"], /statement was not supplied/);

  // A real difference is named and the month is not closed.
  const off = closeFigures({ ...BASE, closing_balance_minor: 1349461 + 17300 });
  assert.equal(off.reconciled, false);
  assert.equal(off.difference_minor, 17300);
  assert.match(off.files["bank-reconciliation.md"], /out by £173\.00/);
  assert.match(off.files["bank-reconciliation.md"], /not closed until it is found/);
});

test("categories cover costs only, and exclude what is held out of the result", () => {
  const r = closeFigures(BASE);
  const cats = Object.fromEntries(r.by_category.map((c: { category: string; amount_minor: number }) => [c.category, c.amount_minor]));
  // Sales are receipts and do not belong in a cost breakdown — folding them in nets rent against
  // revenue and produces a figure that means nothing.
  assert.equal("sales" in cats, false);
  assert.equal(cats.software, -4799 - 3200 - 2400);
  assert.equal(cats.subcontractors, -21600 - 18000);
  // The excluded card payment is out of the breakdown as well as out of the total, so the two agree.
  assert.equal("suspense" in cats, false);
  assert.equal(
    r.by_category.reduce((s: number, c: { amount_minor: number }) => s + c.amount_minor, 0),
    -r.expenses_minor,
  );
  // Largest cost first, so a client reads payroll before domain renewals.
  assert.equal(r.by_category[0]!.category, "payroll");
});

test("it refuses inputs it cannot be exact about, rather than guessing", () => {
  // Integer minor units throughout — a float here is a rounding argument later, in someone's books.
  assert.throws(() => closeFigures({ ...BASE, transactions: [{ date: "d", amount_minor: 12.5 }] }), /integer minor units/);
  assert.throws(() => closeFigures({ ...BASE, transactions: [{ date: "d", amount_minor: "abc" }] }), /must be a number/);
  assert.throws(() => closeFigures({ ...BASE, transactions: [] }), /must not be empty/);
  assert.throws(() => closeFigures({ ...BASE, sales_tax_rate_pct: -1 }), /must be a number/);
  // Not registered is a legitimate answer, and means no output tax rather than a guessed rate.
  assert.equal(closeFigures({ ...BASE, sales_tax_rate_pct: 0 }).output_tax_minor, 0);
  assert.equal(closeFigures({ ...BASE, sales_tax_rate_pct: 0 }).net_sales_minor, 984000);
});

test("there is no default currency, and the one that used to be here was sterling", () => {
  // `money(minor)` fell back to GBP, so every figure in this system carried a £ unless somebody
  // remembered otherwise. A bookkeeper in Ohio would have opened their first monthly close and read
  // "£13,494.61" — not a stale label, the wrong country, on the first line of the first thing we ever
  // produce for them. It is also the kind of default that survives forever, because everyone who
  // builds it and everyone who reviews it happens to be looking at the right symbol.
  assert.throws(() => closeFigures({ ...BASE, currency: undefined }), /currency is required/);
  assert.throws(() => closeFigures({ ...BASE, currency: "  " }), /currency is required/);

  // And it formats whatever it is told, including codes we have no glyph for — "SEK 1,240.00" is
  // what a Swedish reader expects, where a guessed symbol is simply wrong.
  assert.equal(closeFigures({ ...BASE, currency: "USD" }).formatted.net, "$4,070.61");
  assert.equal(closeFigures({ ...BASE, currency: "SEK" }).formatted.net, "SEK 4,070.61");
  assert.equal(closeFigures({ ...BASE, currency: "eur" }).currency, "EUR", "and normalises the code");
});
