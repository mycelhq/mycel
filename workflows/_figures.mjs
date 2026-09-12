// The arithmetic every service business does, once.
//
// ═══ WHY A MODULE AND NOT A CONFIG ENGINE ═══
//
// `close-figures` proved the point for bookkeeping: thirty-two runs, and the client's arithmetic
// complaints went to zero the moment the numbers stopped passing through a language model. The
// obvious next move is "generalise it", and the obvious wrong way to do that is a spec language —
// `{group_by, value, reconcile: {...}}` — which ends as a worse programming language that only we
// can debug, embedded in JSON, with no types and no stack traces.
//
// What the wedges actually share is smaller and duller than that. Look at what every client-facing
// task type ships:
//
//   books-keeper/monthly_close        transactions  → reconciliation, profit_and_loss
//   contract-desk/prepare_invoice     timesheets    → lines, total_minor
//   contract-desk/weekly_run          entries       → ready_to_bill, missing_timesheets
//   geo-monitor/weekly_report         queries       → scorecard, top_competitors
//   recruiting-desk/screen_longlist   candidates    → ranked
//
// A list of records, grouped and summed, reconciled against a claimed total, rendered as a data file
// and a table, with a covering note quoting the figures. Five primitives, not a framework: format
// money, sum a group, reconcile against a claim, render CSV, render a table.
//
// So this is a LIBRARY that trade workflows import, not an engine they configure. `close-figures`
// assembles a month-end close from it; `invoice-figures` assembles an invoice. The trade-specific
// part stays real JavaScript in a file a person can read, and the part that must be identical
// everywhere — the pence, the quoting, the alignment — is identical because it is one function.
//
// Not in SHARED_WORKFLOWS: nothing calls this directly. It is imported by the workflows that are.
//
// Founder code. Pure: no I/O, no clock, no randomness.

/**
 * ═══ THERE IS NO DEFAULT CURRENCY, AND THE ONE THAT WAS HERE WAS STERLING ═══
 *
 * `money(minor)` fell back to GBP, so every figure in this system carried a £ unless somebody
 * remembered to say otherwise. A bookkeeper in Ohio would have opened their first monthly close and
 * read "£13,494.61". Not a rounding error or a stale label — the wrong country, on the first line of
 * the first thing they ever see us produce, and unrecoverable as a first impression.
 *
 * It is also the kind of default that survives forever, because everyone who builds it and everyone
 * who reviews it happens to be looking at the right symbol.
 *
 * So a currency is REQUIRED. There is no sensible guess: it is a fact about the engagement, and a
 * function that formats money without being told which money is not doing arithmetic, it is
 * asserting a jurisdiction.
 *
 * WHOSE currency, when the two differ: the CLIENT'S, because the number is in a document they will
 * pay from. A London studio invoicing a New York client bills in dollars and keeps its books in
 * pounds — those are two different figures for the same work and the only way to get both right is
 * to carry the currency with the thing being priced rather than with the business doing the pricing.
 * See `client_currency` in the wedge inputs.
 *
 * A code with no glyph prints as the code — "SEK 1,240.00" — which is what a Swedish reader expects
 * and is never wrong, where a guessed symbol is.
 */
const SYMBOLS = { GBP: "£", USD: "$", EUR: "€", JPY: "¥", CNY: "¥", INR: "₹", KRW: "₩", NGN: "₦", ZAR: "R", BRL: "R$", PHP: "₱", THB: "฿", VND: "₫", ILS: "₪", TRY: "₺", RUB: "₽", UAH: "₴", PLN: "zł" };

/** The currency symbol for a code, or the code itself when we have no glyph for it. */
export const symbolFor = (currency) => {
  const c = String(currency ?? "").trim().toUpperCase();
  if (!c) throw new Error("a currency is required — see the note in _figures.mjs on why there is no default");
  const s = SYMBOLS[c];
  return s === undefined ? `${c} ` : s;
};

/**
 * Minor units to what a client reads. ONE definition, everywhere.
 *
 * "£34,000.00 in suspense" reached a client for a value of 34000 — £340.00 — because the conversion
 * was being done by hand, per figure, in a sentence. Done here it cannot vary between the table, the
 * spreadsheet, the chart axis and the covering note.
 */
export const money = (minor, currency) => {
  const n = Math.round(Number(minor) || 0);
  const neg = n < 0;
  const abs = Math.abs(n);
  const whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}${symbolFor(currency)}${whole}.${String(abs % 100).padStart(2, "0")}`;
};

/** A percentage to one decimal. `share(3, 16)` → "18.8%". Zero denominator is not 0%, it is "—". */
export const pct = (part, whole, dp = 1) =>
  !whole ? "—" : `${((Number(part) / Number(whole)) * 100).toFixed(dp)}%`;

/** Integer minor units, or a loud refusal. A float here is a rounding argument later, in someone's books. */
export const asMinor = (v, label) => {
  const n = typeof v === "string" ? Number(v) : v;
  if (!Number.isFinite(n)) throw new Error(`${label} must be a number (minor units)`);
  if (!Number.isInteger(n)) throw new Error(`${label} must be integer minor units, got ${n}`);
  return n;
};

/**
 * Minor units as a plain decimal string: `-195000` → `-1950.00`. No symbol, no thousands separator.
 *
 * ═══ WHY THIS IS NOT `money()` ═══
 *
 * The two have different readers. `money()` is for a person: £1,950.00, grouped, with the symbol.
 * This is for a MACHINE — an accountant's import, a pivot table, a spreadsheet column somebody is
 * going to sum — and every one of those chokes on a currency symbol or a comma. A file that carries
 * `£1,950.00` in a numeric column has given the client a picture of a number.
 *
 * The currency travels in its own column, which is where an importer looks for it anyway.
 */
export const decimal = (minor) => {
  const n = asMinor(minor, "amount");
  const abs = Math.abs(n);
  return `${n < 0 ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
};

/**
 * Tax out of a TAX-INCLUSIVE figure. `taxOf(9840_00, 20)` → 1640_00.
 *
 * `× rate` is the error underneath most of these — it computes tax on the wrong base and overstates
 * it by a sixth at 20%. Rounded half up, once, at the end: rounding each line and summing the
 * rounded lines drifts, and the drift is exactly what a client notices when their own total differs.
 */
export const taxOf = (grossMinor, ratePct) => {
  const r = Number(ratePct) || 0;
  return r <= 0 ? 0 : Math.round((Number(grossMinor) * r) / (100 + r));
};

/** Sum a numeric field over rows. */
export const sumBy = (rows, field) => rows.reduce((s, r) => s + (Number(r[field]) || 0), 0);

/**
 * Group rows and sum them, largest magnitude first.
 *
 * Sorted so a client reads payroll before domain renewals — the order is part of the answer, and
 * leaving it to insertion order means the biggest number in the document turns up seventh.
 */
export function groupSum(rows, key, field, { blank = "uncategorised" } = {}) {
  const out = [];
  for (const r of rows) {
    const k = String(r[key] ?? "").trim() || blank;
    const hit = out.find((g) => g.key === k);
    if (hit) {
      hit.total += Number(r[field]) || 0;
      hit.count += 1;
    } else {
      out.push({ key: k, total: Number(r[field]) || 0, count: 1 });
    }
  }
  return out.sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
}

/**
 * Does a list reach the total somebody claimed?
 *
 * The highest-stakes arithmetic in this product, and the same shape in every trade: a close against
 * a bank statement, an invoice against its lines, a payout against a schedule.
 *
 * `reconciled` is FALSE when no claim was supplied — never a zero difference. "We could not check"
 * reporting as "it agrees" is the failure this whole system is built against.
 */
export function reconcile({ opening = 0, rows, field = "amount_minor", claimed }) {
  const movement = sumBy(rows, field);
  const computed = opening + movement;
  const has = claimed !== undefined && claimed !== null;
  return {
    opening,
    movement,
    computed,
    claimed: has ? Number(claimed) : undefined,
    difference: has ? Number(claimed) - computed : undefined,
    reconciled: has ? Number(claimed) - computed === 0 : false,
  };
}

/**
 * RFC4180 quoting. A value containing a comma, a quote or a newline must be quoted.
 *
 * `Studio rent, July` unquoted shifted every column right for the rest of a client's ledger. Doing
 * it mechanically ends that class — there is no version of this a model needs to think about.
 */
export const csvCell = (v) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * Rows to a CSV file. DATA ONLY — no totals row, no prose, no blank separator.
 *
 * It goes into a spreadsheet, a pivot table or an accountant's import, and every non-data row breaks
 * there. A close that appended its reconciliation as two sentences made the file unreadable; the one
 * that added a totals row made its own row count double-count. The arithmetic belongs in the
 * covering note and the rendered table, where a person is reading rather than a machine.
 */
export function csv(columns, rows) {
  const head = columns.map((c) => c.header ?? c.key);
  const body = rows.map((r) => columns.map((c) => (c.value ? c.value(r) : r[c.key])));
  return [head, ...body].map((line) => line.map(csvCell).join(",")).join("\n") + "\n";
}

/**
 * A fixed-width table for a markdown document, aligned on the decimal point.
 *
 * Numbers right, everything else left, so a column of money reads as a column of money. Inside a
 * fenced block, because a markdown pipe table reflows and a reconciliation that reflows is a
 * reconciliation nobody can check at a glance.
 */
export function table(columns, rows) {
  const head = columns.map((c) => c.header ?? c.key);
  const body = rows.map((r) => columns.map((c) => String((c.value ? c.value(r) : r[c.key]) ?? "")));
  const widths = head.map((h, i) => Math.max(String(h).length, ...body.map((b) => b[i].length)));
  const line = (cells) =>
    cells
      .map((cell, i) => (columns[i].align === "right" ? String(cell).padStart(widths[i]) : String(cell).padEnd(widths[i])))
      .join("  ")
      .trimEnd();
  return [line(head), widths.map((w) => "-".repeat(w)).join("  "), ...body.map(line)].join("\n");
}

/**
 * A statement of the form `label ......... value`, which is how every reconciliation, fee note and
 * payout schedule in the trades has been written since before any of this.
 */
export const statement = (pairs, width = 60) =>
  pairs
    .map(([label, value]) =>
      label === "" ? "" : `${String(label).padEnd(width - String(value).length)}${value}`,
    )
    .join("\n");
