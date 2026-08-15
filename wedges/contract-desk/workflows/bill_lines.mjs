// Every number that reaches a client, computed here and nowhere else.
//
// ─── WHY THIS IS NOT THE MODEL'S JOB ───
//
// A contract invoice is minutes times a rate, and it is checked. Not by the hiring manager — by a
// payables clerk with a spreadsheet, and by the contractor, who knows to the minute what they
// worked. An invoice that is a penny out is not a rounding difference, it is a disputed week: the
// client holds the whole invoice, the desk still pays the contractor on Friday, and somebody spends
// an afternoon on it. `invoice-chaser` makes the same argument for its dunning ladder and
// `books-keeper` for its reconciliation; this is the third instance of the same rule, which is why
// it is a workflow and not a paragraph in a skill file.
//
// ─── INTEGER MINOR UNITS, AND NO DIVISION BY 100 ANYWHERE ───
//
// Rates arrive as minor units per hour (£62.50/h is 6250) and time arrives as whole minutes. So a
// line is `minutes * rate / 60`, and 60 is the only divisor in this file. That division is exact
// integer arithmetic with half-up rounding — no `Number.prototype.toFixed`, no floats, no cents
// reconstructed from a decimal. The reason for minutes rather than decimal hours is the same one:
// 7.5 and 7.50 disagree about what half an hour is worth once a 1.5x overtime multiplier has been
// applied to both of them, and the disagreement shows up in the third decimal place where nobody
// looks until a client does.
//
// Founder code, run in the harness process at full trust. Pure: no I/O, no clock, no randomness.

/**
 * Half-up division of a non-negative integer, staying in integers the whole way.
 *
 * `Math.round(n / d)` is wrong here twice over: it goes through a float, and it rounds .5 to even
 * on some inputs, which means two identical weeks can bill a penny apart. Negative numerators are
 * refused rather than handled, because a negative line on a timesheet invoice is a credit note and
 * a credit note is not this workflow's job — silently absorbing one would produce a plausible
 * invoice for work that was taken off the bill.
 */
function divRoundHalfUp(numerator, denominator) {
  if (!Number.isSafeInteger(numerator) || numerator < 0) {
    throw new Error(`expected a non-negative safe integer, got ${numerator}`);
  }
  return Math.floor((numerator + Math.floor(denominator / 2)) / denominator);
}

function requireCount(value, field, where) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${where}: ${field} must be a non-negative whole number, got ${JSON.stringify(value)}`);
  }
  return value;
}

export default function billLines(args) {
  const currency = String(args?.currency ?? "").trim().toUpperCase();
  // A total with no currency on it is the shape of bug that gets an invoice sent in the wrong one to
  // a client who happens to pay in both. Refused rather than defaulted to the desk's home currency.
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new Error(`currency must be an ISO 4217 code such as GBP, got ${JSON.stringify(args?.currency)}`);
  }

  const input = Array.isArray(args?.lines) ? args.lines : null;
  if (!input || input.length === 0) {
    // An invoice with no lines is not a zero invoice, it is a mistake upstream — the week's
    // timesheets were not actually approved. Returning a valid £0.00 invoice would let that mistake
    // reach a client as a real document.
    throw new Error("lines must be a non-empty array — an invoice with no lines is an upstream error, not a zero bill");
  }

  const taxRateBp = args?.tax_rate_bp === undefined ? 0 : requireCount(args.tax_rate_bp, "tax_rate_bp", "input");

  let subtotalMinor = 0;
  let payTotalMinor = 0;
  const lines = input.map((raw, i) => {
    const where = `lines[${i}]`;
    const assignmentId = String(raw?.assignment_id ?? "").trim();
    if (!assignmentId) throw new Error(`${where}: assignment_id is required — a line nobody can trace back to an assignment cannot be defended`);

    const minutes = requireCount(raw?.minutes, "minutes", where);
    const chargeRate = requireCount(raw?.charge_rate_minor_per_hour, "charge_rate_minor_per_hour", where);
    // Pay rate is OPTIONAL and its absence is meaningful, not zero. A desk that has not told us what
    // it pays this contractor gets an invoice and no margin figure; treating "unknown" as zero would
    // report 100% margin on the week, which is the most flattering wrong number available.
    const payRate =
      raw?.pay_rate_minor_per_hour === undefined || raw?.pay_rate_minor_per_hour === null
        ? null
        : requireCount(raw.pay_rate_minor_per_hour, "pay_rate_minor_per_hour", where);

    const chargeMinor = divRoundHalfUp(minutes * chargeRate, 60);
    const payMinor = payRate === null ? null : divRoundHalfUp(minutes * payRate, 60);

    subtotalMinor += chargeMinor;
    if (payMinor !== null) payTotalMinor += payMinor;

    return {
      assignment_id: assignmentId,
      contractor: raw?.contractor === undefined ? undefined : String(raw.contractor),
      description: raw?.description === undefined ? undefined : String(raw.description),
      minutes,
      charge_rate_minor_per_hour: chargeRate,
      charge_minor: chargeMinor,
      pay_minor: payMinor === null ? undefined : payMinor,
      margin_minor: payMinor === null ? undefined : chargeMinor - payMinor,
    };
  });

  const taxMinor = divRoundHalfUp(subtotalMinor * taxRateBp, 10000);

  // Margin is reported only when EVERY line had a pay rate. A margin computed over the subset that
  // happened to carry one reads as the week's margin and is not — it is the margin on the part we
  // knew about, which on a week where one contractor's rate is missing is wildly optimistic.
  const marginKnown = lines.every((l) => l.pay_minor !== undefined);
  const marginMinor = marginKnown ? subtotalMinor - payTotalMinor : undefined;

  return {
    currency,
    lines,
    subtotal_minor: subtotalMinor,
    tax_minor: taxMinor,
    total_minor: subtotalMinor + taxMinor,
    pay_total_minor: marginKnown ? payTotalMinor : undefined,
    margin_minor: marginMinor,
    // Basis points, so the margin a desk head reads is an integer and two runs over the same week
    // cannot disagree in the second decimal place. Guarded on a zero subtotal, which is reachable
    // through a week of legitimately zero-minute lines (a contractor on unpaid leave).
    margin_bp:
      marginKnown && subtotalMinor > 0 ? divRoundHalfUp(marginMinor * 10000, subtotalMinor) : undefined,
    // Why the margin fields are missing, in a sentence, rather than as silence. The recurring
    // expensive bug in this repo is something failing while reporting success, and "no margin key"
    // renders in a UI exactly like "margin is zero".
    margin_unavailable: marginKnown
      ? undefined
      : "at least one line has no pay rate, so this week's margin cannot be computed — the invoice total is unaffected",
  };
}
