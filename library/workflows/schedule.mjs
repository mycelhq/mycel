// The arithmetic for a service nobody wrote by hand.
//
// ═══ WHY A SECOND FIGURES WORKFLOW ═══
//
// `close-figures` proved the point and cannot be reused: it knows about opening balances, output
// tax and held items, because a monthly close does. A service invented at onboarding — a studio
// billing tracked hours, a surveyor scheduling site visits, a translator pricing per thousand words
// — has none of those and cannot author its own, because `wedgeauthor` refuses `workflows` for the
// provenance reason. So every generated service does arithmetic in prose, which is precisely the
// error class thirty-two client-judged runs were spent eliminating.
//
// What those trades share is smaller than a close and the same every time: a list of lines, each
// with a quantity and a rate or a straight amount; a total; a breakdown by some key; a file the
// client opens. That is a SCHEDULE — an invoice, a timesheet summary, a fee note, a payout run, a
// rent roll, a billable-hours report. One shape, most of the service economy.
//
// ═══ WHY IT IS NOT A CONFIG LANGUAGE ═══
//
// `_figures.mjs` deliberately stayed a library rather than an engine, on the grounds that a spec
// language ends as a worse programming language embedded in JSON. This is not that. It has one
// shape and eight arguments, none of which is a rule: what the rows are, what to group by, what
// they are worth, what somebody claimed the total was. A caller cannot express a computation with
// it, only describe a schedule.
//
// The line is: if a trade needs arithmetic this cannot express, it needs a pack — reviewed once,
// digest-pinned — not another argument here.
//
// Founder code. Pure: no I/O, no clock, no randomness.

import { asMinor, csv, decimal, groupSum, money, pct, sumBy, table, taxOf } from "./_figures.mjs";

export default function schedule(args) {
  const rows = Array.isArray(args.rows) ? args.rows : [];
  if (!rows.length) throw new Error("rows is required and must not be empty");

  /**
   * REQUIRED. There is no default, and the one that used to be here was sterling — see the note in
   * `_figures.mjs`. A currency is a fact about the engagement, not something a workflow may assume,
   * and the failure of assuming it is a founder in Ohio reading a pound sign on their first close.
   */
  const currency = String(args.currency ?? "").trim().toUpperCase();
  if (!currency) throw new Error("currency is required (ISO-4217, e.g. USD) — there is no default");
  const m = (v) => money(v, currency);
  const label = String(args.label_field ?? "what");
  const groupBy = args.group_by ? String(args.group_by) : undefined;
  const taxRate = Number(args.tax_rate_pct ?? 0);
  if (!Number.isFinite(taxRate) || taxRate < 0) throw new Error("tax_rate_pct must be a number");

  /**
   * Each line's value, in minor units.
   *
   * Either stated outright, or quantity × rate. Computed here rather than accepted because "two days
   * at £450" is the most common line in a service invoice and the multiplication is exactly the kind
   * a model gets right four times and wrong the fifth. `Math.round` once, at the line, so a fractional
   * quantity cannot leave a third of a penny to accumulate across a page.
   */
  const lines = rows.map((r, i) => {
    const stated = r.amount_minor ?? r.charge_minor ?? r.value_minor;
    const qty = r.quantity ?? r.qty ?? r.hours ?? r.units;
    const rate = r.rate_minor ?? r.unit_price_minor ?? r.price_minor;
    let amount;
    if (stated !== undefined && stated !== null) {
      amount = asMinor(stated, `rows[${i}].amount_minor`);
    } else if (qty !== undefined && rate !== undefined) {
      const q = Number(qty);
      if (!Number.isFinite(q)) throw new Error(`rows[${i}].quantity must be a number`);
      amount = Math.round(q * asMinor(rate, `rows[${i}].rate_minor`));
    } else {
      throw new Error(`rows[${i}] needs amount_minor, or quantity and rate_minor`);
    }
    return {
      ...r,
      label: String(r[label] ?? r.what ?? r.description ?? r.name ?? `Line ${i + 1}`),
      group: groupBy ? String(r[groupBy] ?? "").trim() || "uncategorised" : undefined,
      quantity: qty === undefined ? undefined : Number(qty),
      rate_minor: rate === undefined ? undefined : asMinor(rate, `rows[${i}].rate_minor`),
      amount_minor: amount,
    };
  });

  const subtotal = sumBy(lines, "amount_minor");
  /**
   * Tax ADDED to an exclusive subtotal, not extracted from it — the opposite of a close.
   *
   * A close reads bank lines, which are gross. A schedule is priced, and a price is quoted net: a
   * studio charging £450 a day charges £450 plus VAT. Extracting instead of adding would understate
   * every invoice by a sixth, which is the same error `taxOf` exists to prevent, pointing the other
   * way. `tax_inclusive: true` says the rates already carry it.
   */
  const inclusive = args.tax_inclusive === true;
  const tax = inclusive ? taxOf(subtotal, taxRate) : Math.round((subtotal * taxRate) / 100);
  const total = inclusive ? subtotal : subtotal + tax;
  const net = inclusive ? subtotal - tax : subtotal;

  /**
   * The claim is checked against the TOTAL, tax included.
   *
   * It was checked against the sum of the lines, which is a different number the moment tax applies —
   * and "the total we quoted you" means what the client will pay. Comparing a tax-inclusive quote to
   * a tax-exclusive subtotal reports a discrepancy of exactly the tax on every correct invoice, which
   * is the worst kind of false alarm: it is confidently specific and always wrong by the same amount.
   *
   * Same rule as `delivering-work.md` §4 — name the figure for exactly what it is.
   */
  const claimed = args.claimed_total_minor;
  const hasClaim = claimed !== undefined && claimed !== null;

  const difference = hasClaim ? Number(claimed) - total : undefined;

  const groups = groupBy
    ? groupSum(lines, "group", "amount_minor").map((g) => ({
        key: g.key,
        amount_minor: g.total,
        count: g.count,
        share: pct(Math.abs(g.total), Math.abs(subtotal)),
      }))
    : [];

  /**
   * ═══ THE HEADER ROW IS THE CLIENT'S FIRST LINE OF THIS FILE ═══
   *
   * It read `Description,group,quantity,rate,amount_minor,amount`, and three things were wrong with
   * that. `amount_minor` is this platform's internal representation of money and belongs nowhere a
   * client can see it. `rate` and `amount` were `£1,950.00` — strings in a numeric column, so the
   * client selects the column, looks for a total, and there isn't one. And `groupBy` was dropped in
   * raw, so a schedule grouped by `role_family` published a field name as a heading.
   *
   * One amount, as a decimal an importer and a person can both read, the currency in its own column,
   * and every heading in title case. `render/taste.ts` enforces the same rules on the workbook.
   */
  const heading = (s) => {
    const t = String(s).replace(/_/g, " ").trim();
    return t ? t[0].toUpperCase() + t.slice(1) : t;
  };
  const COLUMNS = [
    { key: "label", header: heading(args.label_header ?? "Description") },
    ...(groupBy ? [{ key: "group", header: heading(groupBy) }] : []),
    { header: "Quantity", value: (r) => (r.quantity === undefined ? "" : r.quantity) },
    { header: "Rate", value: (r) => (r.rate_minor === undefined ? "" : decimal(r.rate_minor)) },
    { header: "Amount", value: (r) => decimal(r.amount_minor) },
    { header: "Currency", value: () => currency },
  ];

  /**
   * The schedule as a document. The totals go HERE and never in the CSV — a data file holds data,
   * and a totals row in it double-counts the moment anyone sums the column.
   */
  const title = String(args.title ?? "Schedule");
  const scheduleMd = [
    `# ${title}`,
    "",
    "```",
    table(
      [
        { key: "label", header: heading(args.label_header ?? "Description"), align: "left" },
        ...(groupBy ? [{ key: "group", header: heading(groupBy), align: "left" }] : []),
        { header: "Amount", value: (r) => m(r.amount_minor), align: "right" },
      ],
      lines,
    ),
    "",
    ...(taxRate > 0
      ? [
          `${"Subtotal".padEnd(40)}${m(net).padStart(14)}`,
          `${`Tax at ${taxRate}%`.padEnd(40)}${m(tax).padStart(14)}`,
        ]
      : []),
    `${"Total".padEnd(40)}${m(total).padStart(14)}`,
    "```",
    ...(hasClaim
      ? [
          "",
          difference === 0
            ? `This agrees with the ${m(Number(claimed))} previously quoted.`
            : `**This does not agree with the ${m(Number(claimed))} previously quoted — it is out by ` +
              `${m(difference)}.** That difference is unexplained and the schedule is not final until it is found.`,
        ]
      : []),
  ].join("\n");

  return {
    currency,
    count: lines.length,
    subtotal_minor: subtotal,
    net_minor: net,
    tax_minor: tax,
    tax_rate_pct: taxRate,
    total_minor: total,
    claimed_total_minor: hasClaim ? Number(claimed) : undefined,
    difference_minor: difference,
    // False when nothing was claimed. "We could not check" must never read as "it agrees".
    reconciled: difference === 0,
    by_group: groups,
    lines: lines.map((l) => ({
      label: l.label,
      group: l.group,
      quantity: l.quantity,
      rate_minor: l.rate_minor,
      amount_minor: l.amount_minor,
    })),
    /** Already written the way a client reads it. Quote these; convert nothing by hand. */
    formatted: {
      subtotal: m(net),
      tax: m(tax),
      total: m(total),
      difference: difference === undefined ? "not checked" : m(difference),
      by_group: groups.map((g) => `${g.key}: ${m(g.amount_minor)} (${g.share})`),
    },
    files: { "schedule.md": scheduleMd, "lines.csv": csv(COLUMNS, lines) },
    /** Rendered into a real .xlsx by the workflow route and attached — see `render/xlsx.ts`. */
    workbook: {
      filename: `${title.replace(/[^\w-]+/g, "-").toLowerCase().replace(/^-|-$/g, "") || "schedule"}.xlsx`,
      currency,
      sheets: [
        {
          name: "Lines",
          header: [
            heading(args.label_header ?? "Description"),
            ...(groupBy ? [heading(groupBy)] : []),
            "Quantity",
            "Rate",
            "Amount",
          ],
          rows: lines.map((l) => [
            { kind: "s", v: l.label },
            ...(groupBy ? [{ kind: "s", v: String(l.group ?? "") }] : []),
            l.quantity === undefined ? { kind: "s", v: "" } : { kind: "n", v: l.quantity },
            l.rate_minor === undefined ? { kind: "s", v: "" } : { kind: "n", v: l.rate_minor / 100, format: "money" },
            { kind: "n", v: l.amount_minor / 100, format: "money" },
          ]),
        },
        ...(groups.length
          ? [
              {
                name: "By " + heading(groupBy),
                header: [heading(groupBy), "Amount", "Share", "Lines"],
                rows: groups.map((g) => [
                  { kind: "s", v: g.key },
                  { kind: "n", v: g.amount_minor / 100, format: "money" },
                  { kind: "n", v: subtotal ? Math.abs(g.amount_minor) / Math.abs(subtotal) : 0, format: "pct" },
                  { kind: "n", v: g.count, format: "int" },
                ]),
              },
            ]
          : []),
        {
          name: "Totals",
          header: ["Line", "Amount"],
          rows: [
            ["Subtotal", net],
            ...(taxRate > 0 ? [[`Tax at ${taxRate}%`, tax]] : []),
            ["Total", total],
          ].map(([k, v]) => [
            { kind: "s", v: k },
            { kind: "n", v: v / 100, format: "money" },
          ]),
        },
      ],
    },
  };
}
