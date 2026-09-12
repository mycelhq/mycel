// Every number a monthly close reports, computed once, in integer minor units.
//
// ═══ WHY THIS EXISTS: THE MODEL KEPT RETYPING NUMBERS ═══
//
// Thirty-two runs of the close, and after the plumbing was fixed every remaining defect was the same
// one: a language model doing arithmetic in prose. A reconciliation table with £4,302.39 where
// £4,469.39 belonged, £173 out in the central schedule. A profit of £3,730.61 in the attached P&L
// and £4,070.61 in the covering note. £34,000.00 written for 34000 minor units. A held total of
// £1,032.90 against five lines adding to £972.90.
//
// Each one got a gate — `nets_to`, `sums_to`, `counts`, `minor_units` — and each gate reads the
// model's JSON, so the errors moved into the markdown tables and the prose, where nothing looks.
// That is not a race anybody wins: there are unbounded places to retype a number wrong and a finite
// number of checks. Run 32 was the first with none: the model called this, quoted it, and every
// figure agreed with every other.
//
// So the model stops doing arithmetic. It supplies judgement — which category, which items are still
// open, what to advise — and this computes every figure and RENDERS the files. A number that is
// never retyped cannot be retyped wrong, which is a stronger guarantee than any check downstream.
//
// The primitives live in `_figures.mjs` and are shared with every other trade: an invoice's lines
// against its total is the same computation as a month's transactions against its statement. What
// stays here is the bookkeeping assembly.
//
// Founder code. Pure: no I/O, no clock, no randomness.

import { asMinor, csv, decimal, groupSum, money, reconcile, statement, sumBy, table, taxOf } from "./_figures.mjs";

export default function closeFigures(args) {
  const tx = Array.isArray(args.transactions) ? args.transactions : [];
  if (!tx.length) throw new Error("transactions is required and must not be empty");

  /**
   * REQUIRED. There is no default, and the one that used to be here was sterling — see the note in
   * `_figures.mjs`. A currency is a fact about the engagement, not something a workflow may assume,
   * and the failure of assuming it is a founder in Ohio reading a pound sign on their first close.
   */
  const currency = String(args.currency ?? "").trim().toUpperCase();
  if (!currency) throw new Error("currency is required (ISO-4217, e.g. USD) — there is no default");
  const m = (v) => money(v, currency);

  const opening = asMinor(args.opening_balance_minor ?? 0, "opening_balance_minor");
  const statementClosing =
    args.closing_balance_minor === undefined || args.closing_balance_minor === null
      ? undefined
      : asMinor(args.closing_balance_minor, "closing_balance_minor");
  const taxRate = Number(args.sales_tax_rate_pct ?? 0);
  if (!Number.isFinite(taxRate) || taxRate < 0) throw new Error("sales_tax_rate_pct must be a number");

  const rows = tx.map((t, i) => ({
    date: String(t.date ?? ""),
    amount_minor: asMinor(t.amount_minor, `transactions[${i}].amount_minor`),
    description: t.description ?? "",
    counterparty: t.counterparty ?? "",
    // The model's judgement, carried through untouched. This function never guesses a category.
    category: t.category ?? "",
    // Two independent flags, because they answer different questions. `held` = still an open
    // question for the client. `excluded` = kept OUT of the operating result meanwhile, which is
    // what a probable-personal payment gets. A close reported "held outside expenses" and then
    // counted the money inside the total; separating the flags makes that unrepresentable.
    held: t.held === true,
    excluded: t.excluded === true,
    note: t.note ?? "",
  }));

  const receipts = rows.filter((r) => r.amount_minor > 0);
  const payments = rows.filter((r) => r.amount_minor < 0);
  const sum = (list) => list.reduce((s, r) => s + r.amount_minor, 0);

  const receiptsMinor = sum(receipts);
  const paymentsMinor = sum(payments); // negative
  const rec = reconcile({ opening, rows, field: "amount_minor", claimed: statementClosing });
  const netMovement = rec.movement;
  const computedClosing = rec.computed;
  const difference = rec.difference;

  // Sales tax on receipts, tax-inclusive: tax = gross × rate / (100 + rate). Rounded half up ONCE,
  // at the end — see uk-vat.md on why rounding each line and summing the rounded lines drifts.
  const grossSales = receiptsMinor;
  const outputTax = taxOf(grossSales, taxRate);
  const netSales = grossSales - outputTax;

  // Categories, over payments only — a category breakdown of costs is what a P&L shows, and folding
  // receipts in would net sales against rent and produce a figure meaning nothing.
  // Costs only. A category breakdown that folded receipts in would net sales against rent and
  // produce a figure meaning nothing. Excluded items are out of the result, so out of its breakdown.
  const byCategory = groupSum(
    payments.filter((r) => !r.excluded),
    "category",
    "amount_minor",
  ).map((g) => ({ category: g.key, amount_minor: g.total, count: g.count }));

  const heldRows = rows.filter((r) => r.held);
  const excludedRows = rows.filter((r) => r.excluded);
  const expenses = -sum(payments.filter((r) => !r.excluded));
  const net = netSales - expenses;

  /**
   * The ledger, rendered. Data only: no totals row, no prose, no blank separator — it goes into a
   * spreadsheet or an accountant's import, and every non-data row breaks there. Quoting is
   * mechanical, which ends the class of failure where `Studio rent, July` shifted every column right
   * for the rest of the file.
   */
  const status = (r) =>
    r.excluded ? "excluded pending your answer" : r.held ? "your answer needed" : "reviewed";
  /**
   * ═══ THE HEADER ROW IS THE CLIENT'S FIRST LINE OF THIS FILE ═══
   *
   * It read `date,amount_minor,amount,currency,...`. Two of those are ours, not theirs:
   * `amount_minor` is this platform's internal representation of money, and a client's accountant
   * opening the ledger we sent them should never learn that we hold pence as integers. The rule
   * about never exposing the guts of the platform does not stop at the screen — it is hardest to
   * honour, and matters most, in a file somebody else opens.
   *
   * And two amount columns was the other half of the problem: one of them (`£1,950.00`) is a STRING
   * in a numeric column, which is the single most common way a delivered spreadsheet fails the
   * person who opened it. They select the column, look for a total, and there isn't one.
   *
   * So: one amount, as a plain decimal an importer can read and a person can too, with the currency
   * in its own column where every import template already looks for it. `render/taste.ts` enforces
   * the same two rules on the workbook.
   */
  const LEDGER_COLUMNS = [
    { key: "date", header: "Date" },
    { header: "Amount", value: (r) => decimal(r.amount_minor) },
    { header: "Currency", value: () => currency },
    { key: "description", header: "Description" },
    { key: "counterparty", header: "Counterparty" },
    { key: "category", header: "Category" },
    { header: "Status", value: status },
  ];
  const ledgerCsv = csv(LEDGER_COLUMNS, rows);

  /**
   * The reconciliation statement, rendered in the form a bookkeeper writes it.
   *
   * The client's most repeated complaint was that a close showing `opening + movement = closing` had
   * shown a calculation rather than a reconciliation. This states what was checked against what, and
   * says plainly when the statement itself was never supplied — which is evidence of what was done,
   * where silence is not.
   */
  const pad = (label, value) => `${label.padEnd(46)}${value.padStart(14)}`;
  /**
   * THE QUALIFICATION LEADS WHEN THERE IS ONE.
   *
   * The first version put the table first, with `Difference £0.00` in it, and the caveat underneath.
   * The client read it exactly as written: "the headline says there is no difference, then the
   * document admits that statement reconciliation cannot be done without the statement. That
   * qualification should be the headline, not buried underneath a zero difference."
   *
   * They are right, and it is a rendering decision rather than a wording one, which is why it belongs
   * here. A zero read before the limit that produced it is a zero the reader trusts more than it
   * deserves — and by the time they reach the caveat they have already formed the view.
   */
  const caveat =
    statementClosing === undefined
      ? "**The bank statement was not supplied, so this is not a completed reconciliation.** The " +
        "figures below are the ledger provided, totalled. Send the statement for the period and the " +
        "ledger can be agreed to it line by line."
      : difference === 0
        ? "**The closing balance was supplied as a figure, not as a statement, so no individual " +
          "transaction has been matched to the bank.** Every line below is from the ledger provided " +
          "and they reach that figure exactly, which is a total agreeing to a total. Agreeing each " +
          "line to the bank needs the statement itself."
        : `**The ledger does not reach the supplied closing balance — it is out by ${m(difference)}.** ` +
          `That difference is unexplained and the month is not closed until it is found.`;
  const reconciliationMd = [
    `# Bank reconciliation — ${args.client ?? "the business"}, ${args.period ?? "the period"}`,
    "",
    caveat,
    "",
    "```",
    pad(`Opening balance`, m(opening)),
    pad(`Receipts (${receipts.length})`, m(receiptsMinor)),
    pad(`Payments (${payments.length})`, m(paymentsMinor)),
    pad(`Closing balance per ledger`, m(computedClosing)),
    "",
    statementClosing === undefined
      ? pad(`Closing balance per statement`, "not supplied")
      : pad(`Closing balance per statement`, m(statementClosing)),
    statementClosing === undefined ? pad(`Difference`, "cannot be checked") : pad(`Difference`, m(difference)),
    "```",
  ].join("\n");

  return {
    currency,
    counts: { transactions: rows.length, receipts: receipts.length, payments: payments.length },
    opening_balance_minor: opening,
    receipts_minor: receiptsMinor,
    payments_minor: paymentsMinor,
    net_movement_minor: netMovement,
    computed_closing_minor: computedClosing,
    statement_closing_minor: statementClosing,
    difference_minor: difference,
    // `undefined` difference is NOT reconciled. "We could not check" must never report as "it agrees"
    // — that is the failing-while-reporting-success this whole system is built against.
    reconciled: difference === 0,
    by_category: byCategory,
    gross_sales_minor: grossSales,
    output_tax_minor: outputTax,
    net_sales_minor: netSales,
    sales_tax_rate_pct: taxRate,
    held: { amount_minor: sum(heldRows), item_count: heldRows.length },
    excluded: { amount_minor: sum(excludedRows), item_count: excludedRows.length },
    revenue_minor: netSales,
    expenses_minor: expenses,
    net_minor: net,
    // Every figure above, already written the way a client reads it. Quote these strings into the
    // summary rather than converting anything by hand.
    formatted: {
      opening: m(opening),
      receipts: m(receiptsMinor),
      payments: m(paymentsMinor),
      net_movement: m(netMovement),
      closing_per_ledger: m(computedClosing),
      closing_per_statement: statementClosing === undefined ? "not supplied" : m(statementClosing),
      difference: difference === undefined ? "cannot be checked" : m(difference),
      gross_sales: m(grossSales),
      output_tax: m(outputTax),
      net_sales: m(netSales),
      expenses: m(expenses),
      net: m(net),
      held: m(sum(heldRows)),
      by_category: byCategory.map((c) => `${c.category}: ${m(c.amount_minor)} (${c.count})`),
    },
    files: {
      "ledger.csv": ledgerCsv,
      "bank-reconciliation.md": reconciliationMd,
    },
    /**
     * ═══ THE SAME NUMBERS, AS A WORKBOOK A CLIENT ACTUALLY OPENS ═══
     *
     * A client paying a monthly retainer received their close as a PDF and a CSV. Both correct. A CSV
     * is a text file with commas in it — their accountant imports it and nobody opens it twice — so
     * the work arrived looking like an export because it was shipped like one.
     *
     * This is a SPEC, not a file: sheets, headers, typed cells, all plain data. The kernel renders it
     * (see `render/xlsx.ts`), stores it and attaches it to the delivery. That split is what keeps
     * this file founder code — pure, no build step, no imports from the kernel — while the client
     * still gets a real workbook with a frozen header, currency columns that sum, and a tab per
     * schedule.
     *
     * Amounts go in as MAJOR units with a money format, because a spreadsheet column that reads
     * 480000 is not a number anyone can use. The conversion happens here, once, in the same place as
     * every other conversion.
     */
    workbook: {
      filename: `${(args.period ?? "close").replace(/[^\w-]+/g, "-").toLowerCase()}-close.xlsx`,
      currency,
      sheets: [
        {
          name: "Ledger",
          note: caveat.replace(/\*\*/g, ""),
          header: ["Date", "Amount", "Description", "Counterparty", "Category", "Status"],
          rows: rows.map((r) => [
            { kind: "d", v: r.date },
            { kind: "n", v: r.amount_minor / 100, format: "money" },
            { kind: "s", v: String(r.description ?? "") },
            { kind: "s", v: String(r.counterparty ?? "") },
            { kind: "s", v: String(r.category ?? "") },
            { kind: "s", v: status(r) },
          ]),
        },
        {
          name: "Reconciliation",
          header: ["Line", "Amount"],
          rows: [
            ["Opening balance", opening],
            [`Receipts (${receipts.length})`, receiptsMinor],
            [`Payments (${payments.length})`, paymentsMinor],
            ["Closing balance per ledger", computedClosing],
            ...(statementClosing === undefined
              ? [["Closing balance per statement", null]]
              : [["Closing balance per statement", statementClosing], ["Difference", difference]]),
          ].map(([label, v]) => [
            { kind: "s", v: label },
            v === null ? { kind: "s", v: "not supplied" } : { kind: "n", v: v / 100, format: "money" },
          ]),
        },
        {
          name: "Costs by category",
          header: ["Category", "Amount", "Share of costs", "Transactions"],
          rows: byCategory.map((c) => [
            { kind: "s", v: c.category },
            { kind: "n", v: c.amount_minor / 100, format: "money" },
            // A fraction with a percent format, so Excel shows 47.2% and charts it as a proportion.
            { kind: "n", v: expenses ? Math.abs(c.amount_minor) / expenses : 0, format: "pct" },
            { kind: "n", v: c.count, format: "int" },
          ]),
        },
        {
          name: "Your answers needed",
          header: ["Date", "Amount", "Description", "Counterparty", "In the result?"],
          rows: heldRows.map((r) => [
            { kind: "d", v: r.date },
            { kind: "n", v: r.amount_minor / 100, format: "money" },
            { kind: "s", v: String(r.description ?? "") },
            { kind: "s", v: String(r.counterparty ?? "") },
            { kind: "s", v: r.excluded ? "no — held out until you confirm" : "yes — included provisionally" },
          ]),
        },
      ].filter((sh) => sh.rows.length > 0),
    },
  };
}
