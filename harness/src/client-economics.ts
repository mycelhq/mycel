// Which clients are actually making this business money — and which are being subsidised.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// THE QUESTION EVERY SERVICE-BUSINESS OWNER CANNOT ANSWER
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// Every agency has a client who is quietly unprofitable. The founder knows it in their gut and
// cannot prove it, so they keep serving them — for years — because the alternative is firing
// revenue, and firing revenue on a hunch is how you lose a business.
//
// The reason they cannot prove it is that the evidence is split across systems that do not talk. The
// invoicing tool knows what was billed. The project tool knows what was done. Neither knows what it
// COST, and nobody at all is counting the founder's own interruptions.
//
// This product is the only place those meet, and that is not a small advantage — it is the whole
// one. GoHighLevel bills and does not do the work. An agent platform does the work and has no
// client, no invoice and no notion of margin. Here the same row that ran the job carries what the
// job cost, and the same client that owns the job owns the invoice.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// WHAT IS COUNTED, AND WHY EACH IS THE HONEST VERSION
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// REVENUE IS MONEY THAT ARRIVED, not money that was invoiced. `amount_paid`, never `total`. A client
// who is billed £3,000 a month and pays four months late at 70% is not a £3,000 client, and every
// tool that reports the invoice rather than the settlement flatters exactly the relationship a
// founder most needs to see clearly.
//
// DIRECT COST IS REAL MODEL SPEND. `Task.cost_usd`, summed over the tasks attributed to that client.
// It is the one cost this system can measure exactly, and it is measured rather than estimated.
//
// THE FOUNDER'S TIME IS COUNTED AS APPROVALS. This is the number nobody else has, and on most books
// it is the finding. A client whose work throws forty approvals a month is not costing model spend,
// they are costing forty interruptions — and interruptions are the entire reason the founder cannot
// take on a fifth client. `approvals_per_1k` is the headline for that: how many times you were
// pulled in per thousand of revenue.
//
// FRICTION IS THE REST OF IT. Revisions asked for, days to get paid, chases sent, and rounds of
// proposal negotiation before signing. None of these is money on its own; together they are the
// difference between a client who is a pleasure and a client the founder dreads opening.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// WHAT THIS DELIBERATELY DOES NOT DO
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// IT DOES NOT INVENT AN HOURLY RATE. Every "profitability" tool in this market asks the founder to
// estimate hours and then reports arithmetic on their guess back to them as a finding. The number
// that comes out is exactly as good as the guess and looks like a measurement, which is worse than
// having no number.
//
// IT DOES NOT SAY "FIRE THEM". It reports what a relationship costs and what it returns, ranked,
// with the sample size. Whether a thin client is worth keeping is a judgement about a business the
// founder can see and this cannot — the logo, the referrals, the fact that they are about to triple.
// Presenting a ranking as a verdict would be a machine firing somebody's customer on a ratio.
//
// AND IT REFUSES TO REPORT ON A CLIENT IT HAS BARELY SEEN. See `MIN_TASKS` and `MIN_DAYS`.
import { invoiceTotals } from "./billing";
import type { Approval, Invoice, Task } from "./contract";
import { moneyText } from "./moves";

/**
 * Below this, there is no finding — only noise wearing a number.
 *
 * A client with two jobs and one invoice can look wildly profitable or wildly not depending on
 * whether the second job happened to retry. Reporting that as economics would teach a founder to
 * distrust the whole screen, which costs more than the one client it might have flagged.
 */
export const MIN_TASKS = 3;
/** And a relationship younger than this has not had time to show its shape. */
export const MIN_DAYS = 14;

const DAY = 24 * 60 * 60 * 1000;

export interface ClientEconomics {
  client_id: string;
  /** Money that ARRIVED, in minor units. Never what was invoiced. */
  collected_minor: number;
  /** Raised and not yet settled. Not revenue — the gap between billing and being paid. */
  outstanding_minor: number;
  currency: string;
  /** Real model spend, in minor units of the business's currency. See `DEFAULT_USD_TO_MINOR`. */
  direct_cost_minor: number;
  /** The same spend, unconverted. The measured number, kept so nothing has to trust the rate. */
  direct_cost_usd: number;
  /** What is left after what it measurably cost to produce. */
  gross_minor: number;
  /** Jobs run for this client that finished. The denominator for "how much work is this". */
  jobs: number;
  /** Times the founder was pulled in. The cost nobody else counts. */
  approvals: number;
  /**
   * Approvals per £1,000 collected. THE HEADLINE.
   *
   * A client at 2 is a client you barely notice. A client at 40 is the reason you cannot take
   * another one, whatever they pay. Null when nothing has been collected — a ratio with a zero
   * denominator is not a large number, it is an absent one.
   */
  approvals_per_1k: number | null;
  /** Deliverable revisions this client asked for. Rework, which is unbilled by definition. */
  revisions: number;
  /** Median days from issuing an invoice to it being settled. Null until two have settled. */
  days_to_pay: number | null;
  /** Chase messages sent. Every one is a founder deciding whether to be the person who chases. */
  chases: number;
  /** Rounds of proposal negotiation before they signed. See signing.ts. */
  proposal_rounds: number;
  /** Days since the first job. Context for every number above. */
  age_days: number;
  /**
   * Why this client is not being reported on, when it is not.
   *
   * Present INSTEAD of a verdict rather than alongside one. A thin client with a caveat still gets
   * read as a finding — the caveat is the first thing skipped.
   */
  too_early?: string;
}

/**
 * ═══ MODEL SPEND IS IN USD AND EVERYTHING ELSE IS NOT ═══
 *
 * Providers bill in dollars. The business bills in whatever it bills in. A margin needs one
 * currency, so one of them has to be converted, and how that is done is a decision worth writing
 * down rather than burying in a multiplication.
 *
 * NOT A LIVE RATE. A margin that moves because the dollar moved is a margin nobody can act on, and
 * making this screen depend on a network call to report yesterday's costs would be trading
 * correctness it does not gain for a failure mode it does not need.
 *
 * A STATED CONSTANT, PASSED IN. The default is 100 — one dollar to one hundred minor units, which is
 * parity. For a USD business that is exact. For a GBP one it is roughly 20% out, which matters
 * enormously for a number like "what is 3% of revenue" and not at all for the only question this
 * module asks: is the cost of serving this client a rounding error, or is it a multiple of what they
 * pay. Every finding here fires on multiples.
 *
 * It is a parameter so a founder who cares can set it, and so the number is never secretly wrong —
 * a conversion nobody can see is the one that gets quoted in a board meeting.
 */
export const DEFAULT_USD_TO_MINOR = 100;

/** The median, which is the right average for a distribution with one 90-day outlier in it. */
function median(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

export function clientEconomics(args: {
  client_id: string;
  tasks: readonly Task[];
  invoices: readonly Invoice[];
  approvals: readonly Approval[];
  /** Deliverable verdicts, so rework is counted from what the client actually said. */
  revisions?: number;
  /** Rounds of proposal negotiation, from the envelope chain. */
  proposal_rounds?: number;
  currency: string;
  /** See `DEFAULT_USD_TO_MINOR`. Passed rather than assumed, so the conversion is never invisible. */
  usd_to_minor?: number;
  now?: Date;
}): ClientEconomics {
  const now = args.now ?? new Date();
  const rate = args.usd_to_minor ?? DEFAULT_USD_TO_MINOR;
  const mine = args.tasks.filter((t) => t.client_id === args.client_id);
  const done = mine.filter((t) => t.status === "succeeded");
  const invoices = args.invoices.filter((i) => i.client_id === args.client_id);

  const collected = invoices.reduce((n, i) => n + (Number(i.amount_paid) || 0), 0);
  // THROUGH `invoiceTotals`, not by adding fields up here. An invoice's total is lines plus tax
  // minus what has been paid, and that arithmetic lives in billing.ts because it is the arithmetic a
  // client pays from. A second copy in a metrics module is how two screens come to disagree about
  // what somebody owes.
  const outstanding = invoices
    .filter((i) => i.status !== "paid" && i.status !== "void")
    .reduce((n, i) => n + Math.max(0, invoiceTotals(i).amount_due), 0);

  // EVERY task, not only the ones that finished. A run that failed still spent the money, and a
  // client whose jobs fail twice before working is exactly the client this screen exists to find.
  const costUsd = mine.reduce((n, t) => n + (Number(t.cost_usd) || 0), 0);
  const cost = Math.round(costUsd * rate);

  const taskIds = new Set(mine.map((t) => t.id));
  const approvals = args.approvals.filter((a) => taskIds.has(a.task_id)).length;

  const paid = invoices.filter((i) => i.status === "paid" && i.paid_at && i.issue_date);
  const payDays = paid
    .map((i) => (Date.parse(i.paid_at!) - Date.parse(`${i.issue_date}T00:00:00Z`)) / DAY)
    .filter((n) => Number.isFinite(n) && n >= 0)
    .map((n) => Math.round(n));

  // Counted as invoices that have BEEN chased, not as a chase tally — `last_chased_at` is a stamp,
  // and inventing a count from it would be inventing a number.
  const chases = invoices.filter((i) => !!i.last_chased_at).length;

  const first = mine.map((t) => Date.parse(t.created_at)).filter(Number.isFinite).sort((a, b) => a - b)[0];
  const ageDays = first ? Math.floor((now.getTime() - first) / DAY) : 0;

  const base: ClientEconomics = {
    client_id: args.client_id,
    collected_minor: collected,
    outstanding_minor: outstanding,
    currency: args.currency,
    direct_cost_minor: cost,
    direct_cost_usd: Math.round(costUsd * 100) / 100,
    gross_minor: collected - cost,
    jobs: done.length,
    approvals,
    // A ratio with a zero denominator is not a large number, it is an absent one. Reporting
    // Infinity here would put the worst-looking client at the top of the list for having paid
    // nothing yet, which is the opposite of the finding.
    approvals_per_1k: collected > 0 ? Math.round((approvals / (collected / 100_000)) * 10) / 10 : null,
    revisions: args.revisions ?? 0,
    days_to_pay: median(payDays),
    chases,
    proposal_rounds: args.proposal_rounds ?? 0,
    age_days: ageDays,
  };

  if (mine.length < MIN_TASKS) {
    return { ...base, too_early: `only ${mine.length} job${mine.length === 1 ? "" : "s"} so far` };
  }
  if (ageDays < MIN_DAYS) {
    return { ...base, too_early: `${ageDays} days old` };
  }
  return base;
}

export interface BookFinding {
  client_id: string;
  /** What is true, in one sentence a founder can act on or dismiss. */
  says: string;
  /** The numbers behind it, so nothing here has to be taken on trust. */
  because: string;
  kind: "subsidised" | "attention" | "slow_payer" | "rework";
}

/**
 * The findings across a whole book, ranked by how much they are costing.
 *
 * ═══ FINDINGS, NOT A LEADERBOARD ═══
 *
 * A sorted table of margins invites a founder to read the bottom row as a decision. That is not what
 * this knows: a thin client may be a logo, a referral engine, or three months from tripling, and
 * none of that is in the data. So this returns statements about specific costs — "this one pulls you
 * in every other day" — which a founder can weigh against what they know and this cannot.
 *
 * Every finding names its evidence. A number a founder cannot trace is a number they are right to
 * ignore, and on this screen more than any other, because the action it implies is firing somebody.
 */
export function bookFindings(rows: readonly ClientEconomics[], names: ReadonlyMap<string, string>): BookFinding[] {
  const solid = rows.filter((r) => !r.too_early);
  if (solid.length < 2) return [];

  const out: BookFinding[] = [];
  const name = (id: string) => names.get(id) ?? "This client";
  /**
   * Whole units, through the one formatter.
   *
   * This was a three-currency symbol table and `minor / 100`. The table meant a fourth currency got
   * "SEK 1,200" while the first three got a symbol, and the divisor is simply wrong for any
   * currency whose minor unit is not a hundredth — a ¥12,000 invoice read as ¥120.
   *
   * `maximumFractionDigits: 0` is kept and is deliberate: these are book findings about whether a
   * client is worth serving, and cents in that sentence are noise. `moveText` keeps the cents where
   * the reader is looking at one invoice.
   */
  const money = (minor: number, cur: string) =>
    moneyText(minor, cur).replace(/\.\d+$/, "");

  // SUBSIDISED: it costs more to serve than it brought in. The only unambiguous one here, because
  // both halves are measured rather than inferred.
  for (const r of solid) {
    if (r.gross_minor < 0) {
      out.push({
        client_id: r.client_id,
        kind: "subsidised",
        says: `${name(r.client_id)} has cost more to serve than they have paid.`,
        because: `${money(r.collected_minor, r.currency)} collected against ${money(r.direct_cost_minor, r.currency)} of model spend across ${r.jobs} jobs.`,
      });
    }
  }

  // ATTENTION: the founder's time, which is the cost nobody else counts and usually the real one.
  // Compared against the book's own median rather than a fixed threshold — "a lot of approvals" only
  // means anything relative to how this particular business runs.
  const ratios = solid.map((r) => r.approvals_per_1k).filter((n): n is number => n !== null);
  const typical = median(ratios);
  if (typical !== null && typical > 0) {
    for (const r of solid) {
      if (r.approvals_per_1k !== null && r.approvals_per_1k >= typical * 3 && r.approvals >= 10) {
        out.push({
          client_id: r.client_id,
          kind: "attention",
          // "per pound" and "per £1,000" were hardcoded next to an amount formatted in the
          // account's ACTUAL currency, so a US firm read "$4,200 collected … per £1,000" in one
          // sentence. The rate is currency-relative; say it in theirs.
          says: `${name(r.client_id)} pulls you in about ${Math.round(r.approvals_per_1k / typical)}× more often than the rest of your book, for what they pay.`,
          because: `${r.approvals} approvals against ${money(r.collected_minor, r.currency)} collected. Your median is ${typical} per ${money(100_000, r.currency)}; this one is ${r.approvals_per_1k}.`,
        });
      }
    }
  }

  // SLOW PAYER: stated in days rather than as a score, because the action is a conversation about
  // terms and the number IS the conversation.
  for (const r of solid) {
    if (r.days_to_pay !== null && r.days_to_pay >= 45) {
      out.push({
        client_id: r.client_id,
        kind: "slow_payer",
        says: `${name(r.client_id)} takes about ${r.days_to_pay} days to pay.`,
        because:
          `Median across their settled invoices` +
          (r.chases > 0 ? `, after ${r.chases} chase${r.chases === 1 ? "" : "s"}.` : `, unchased.`) +
          (r.outstanding_minor > 0 ? ` ${money(r.outstanding_minor, r.currency)} is outstanding now.` : ""),
      });
    }
  }

  // REWORK: unbilled by definition, and the one a founder most often has not noticed the size of.
  for (const r of solid) {
    if (r.revisions >= 3 && r.jobs > 0 && r.revisions / r.jobs >= 0.4) {
      out.push({
        client_id: r.client_id,
        kind: "rework",
        says: `${name(r.client_id)} sends work back about ${Math.round((r.revisions / r.jobs) * 100)}% of the time.`,
        because: `${r.revisions} revisions across ${r.jobs} jobs. Rework is not billed, so this is time you have already given away.`,
      });
    }
  }

  // Ranked by what it costs, which is not the same as ranked by size. A subsidised client is a hole;
  // an attention sink is a ceiling on how many clients you can have at all.
  const weight: Record<BookFinding["kind"], number> = { subsidised: 0, attention: 1, rework: 2, slow_payer: 3 };
  return out.sort((a, b) => weight[a.kind] - weight[b.kind]);
}
