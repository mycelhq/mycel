// Which clients are actually making this business money.
//
// Every agency has a client who is quietly unprofitable. The founder knows it in their gut and
// cannot prove it, so they keep serving them for years — because firing revenue on a hunch is how
// you lose a business.
//
// The evidence is normally split across systems that do not talk: the invoicing tool knows what was
// billed, the project tool knows what was done, neither knows what it COST, and nobody is counting
// the founder's own interruptions. This product is the only place those meet.
//
// So these tests are mostly about RESTRAINT. A screen whose implied action is "fire somebody" has to
// be harder to fool than one whose implied action is "look at this chart".
import { test } from "node:test";
import assert from "node:assert/strict";
import { bookFindings, clientEconomics, MIN_DAYS, MIN_TASKS } from "../src/client-economics";
import type { Approval, Invoice, Task } from "../src/contract";

const NOW = new Date("2026-09-01T12:00:00Z");
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

const task = (client_id: string, cost_usd: number, over: Partial<Task> = {}): Task =>
  ({ id: `t-${Math.random()}`, client_id, cost_usd, status: "succeeded", created_at: ago(30), ...over }) as Task;

const invoice = (client_id: string, over: Partial<Invoice> = {}): Invoice =>
  ({
    id: `i-${Math.random()}`,
    client_id,
    status: "paid",
    amount_paid: 100_000,
    currency: "GBP",
    lines: [{ description: "Retainer", quantity_milli: 1000, unit_amount: 100_000 }],
    issue_date: ago(40).slice(0, 10),
    paid_at: ago(30),
    ...over,
  }) as Invoice;

const approval = (task_id: string): Approval => ({ task_id, action: "email:send", status: "approved" }) as Approval;

test("revenue is money that ARRIVED, not money that was invoiced", () => {
  /**
   * A client billed £3,000 a month who pays four months late at 70% is not a £3,000 client. Every
   * tool that reports the invoice rather than the settlement flatters exactly the relationship a
   * founder most needs to see clearly.
   */
  const e = clientEconomics({
    client_id: "c1",
    tasks: [task("c1", 1), task("c1", 1), task("c1", 1)],
    invoices: [
      invoice("c1", { amount_paid: 70_000, lines: [{ description: "R", quantity_milli: 1000, unit_amount: 100_000 }] as never, status: "sent", paid_at: undefined }),
      invoice("c1", { amount_paid: 100_000 }),
    ],
    approvals: [],
    currency: "GBP",
    now: NOW,
  });
  assert.equal(e.collected_minor, 170_000, "what arrived, across both");
  assert.equal(e.outstanding_minor, 30_000, "and the gap is reported as a gap, not as revenue");
});

test("the founder's time is counted, because it is the cost nobody else has", () => {
  /**
   * On most books this is THE finding. A client whose work throws forty approvals is not costing
   * model spend, they are costing forty interruptions — and interruptions are the entire reason the
   * founder cannot take on a fifth client.
   */
  const noisy = [task("c1", 0.5), task("c1", 0.5), task("c1", 0.5)];
  const e = clientEconomics({
    client_id: "c1",
    tasks: noisy,
    invoices: [invoice("c1", { amount_paid: 50_000 })],
    approvals: noisy.flatMap((t) => [approval(t.id), approval(t.id), approval(t.id), approval(t.id)]),
    currency: "GBP",
    now: NOW,
  });
  assert.equal(e.approvals, 12);
  // 12 approvals against £500 collected → 24 per £1,000.
  assert.equal(e.approvals_per_1k, 24);

  // A ratio with a zero denominator is ABSENT, not enormous. Reporting Infinity would put the
  // client who has paid nothing yet at the top of the list, which is the opposite of the finding.
  const unpaid = clientEconomics({
    client_id: "c1",
    tasks: noisy,
    invoices: [],
    approvals: [approval(noisy[0]!.id)],
    currency: "GBP",
    now: NOW,
  });
  assert.equal(unpaid.approvals_per_1k, null);
});

test("cost counts jobs that FAILED, because they still spent the money", () => {
  // A client whose jobs fail twice before working is exactly the client this screen exists to find,
  // and counting only successes would hide them completely.
  const e = clientEconomics({
    client_id: "c1",
    tasks: [task("c1", 2, { status: "failed" }), task("c1", 2, { status: "failed" }), task("c1", 2)],
    invoices: [invoice("c1", { amount_paid: 500 })],
    approvals: [],
    currency: "GBP",
    now: NOW,
  });
  assert.equal(e.direct_cost_minor, 600, "$6 of spend across all three");
  assert.equal(e.jobs, 1, "but only one of them produced anything");
  assert.equal(e.gross_minor, -100, "and it is underwater");
});

test("a client it has barely seen gets no verdict at all", () => {
  /**
   * `too_early` is present INSTEAD of a finding rather than alongside one. A thin client with a
   * caveat still reads as a finding, because the caveat is the first thing skipped — and the action
   * this screen implies is firing somebody.
   */
  const thin = clientEconomics({
    client_id: "c1",
    tasks: [task("c1", 1), task("c1", 1)],
    invoices: [invoice("c1")],
    approvals: [],
    currency: "GBP",
    now: NOW,
  });
  assert.match(thin.too_early!, /only 2 jobs/);
  assert.equal(MIN_TASKS, 3);

  const young = clientEconomics({
    client_id: "c1",
    tasks: [task("c1", 1, { created_at: ago(3) }), task("c1", 1, { created_at: ago(2) }), task("c1", 1, { created_at: ago(1) })],
    invoices: [invoice("c1")],
    approvals: [],
    currency: "GBP",
    now: NOW,
  });
  assert.match(young.too_early!, /3 days old/);
  assert.equal(MIN_DAYS, 14);

  // And a client with no verdict produces no finding, however bad the ratios look.
  assert.deepEqual(bookFindings([thin, young], new Map()), []);
});

test("the findings say what is true and never say what to do", () => {
  /**
   * Whether a thin client is worth keeping is a judgement about a business the founder can see and
   * this cannot — the logo, the referrals, the fact that they are about to triple. Presenting a
   * ranking as a verdict would be a machine firing somebody's customer on a ratio.
   */
  const names = new Map([["c1", "Ridgeline"], ["c2", "Hart's Bakery"], ["c3", "Kestrel"]]);
  const base = { invoices: [], approvals: [], currency: "GBP", now: NOW } as const;

  // $1,200 of model spend against £1,000 collected. Underwater on the measured numbers alone.
  const under = clientEconomics({
    ...base,
    client_id: "c1",
    tasks: [task("c1", 400), task("c1", 400), task("c1", 400)],
    invoices: [invoice("c1", { amount_paid: 100_000 })],
  });
  const fine = clientEconomics({
    ...base,
    client_id: "c2",
    tasks: [task("c2", 0.4), task("c2", 0.4), task("c2", 0.4)],
    invoices: [invoice("c2", { amount_paid: 95_000 })],
    approvals: [],
  });
  const findings = bookFindings([under, fine], names);

  const sub = findings.find((f) => f.kind === "subsidised")!;
  assert.ok(sub, "£1,000 collected against $1,200 of model spend");
  assert.match(sub.says, /Ridgeline has cost more to serve than they have paid/);
  // Every finding carries its evidence. A number a founder cannot trace is a number they are right
  // to ignore, and on this screen more than any other.
  assert.match(sub.because, /collected against/);
  assert.match(sub.because, /3 jobs/);

  // No imperatives anywhere. This reports; the founder decides.
  for (const f of findings) {
    for (const verb of ["fire ", "drop ", "you should", "we recommend", "consider "]) {
      assert.equal(f.says.toLowerCase().includes(verb), false, `${verb} in "${f.says}"`);
    }
  }
});

test("attention is measured against the book's own median, not a fixed threshold", () => {
  // "A lot of approvals" only means anything relative to how this particular business runs. A
  // founder who approves everything would otherwise see every client flagged, and one who approves
  // nothing would never see the client who is eating their week.
  const t = (c: string, n: number) => Array.from({ length: n }, () => task(c, 0.2));
  const rows = ["c1", "c2", "c3"].map((c, i) => {
    const tasks = t(c, 4);
    // c3 gets 10× the approvals of the others for the same money.
    const per = i === 2 ? 40 : 4;
    return clientEconomics({
      client_id: c,
      tasks,
      invoices: [invoice(c, { amount_paid: 200_000 })],
      approvals: Array.from({ length: per }, () => approval(tasks[0]!.id)),
      currency: "GBP",
      now: NOW,
    });
  });
  const findings = bookFindings(rows, new Map([["c3", "Kestrel"]]));
  const attn = findings.filter((f) => f.kind === "attention");
  assert.equal(attn.length, 1);
  assert.equal(attn[0]!.client_id, "c3");
  assert.match(attn[0]!.says, /more often than the rest of your book/);
  assert.match(attn[0]!.because, /Your median is/);
});

test("one client is not a book, so nothing is compared against itself", () => {
  // Every relative finding needs something to be relative to. With one client the median IS that
  // client, and the screen would report that they are exactly average — which is true and useless.
  const one = clientEconomics({
    client_id: "c1",
    tasks: [task("c1", 1), task("c1", 1), task("c1", 1)],
    invoices: [invoice("c1")],
    approvals: [],
    currency: "GBP",
    now: NOW,
  });
  assert.deepEqual(bookFindings([one], new Map()), []);
});

test("the conversion is visible, and the findings only fire on multiples", async () => {
  /**
   * Providers bill in dollars and the business bills in whatever it bills in, so a margin needs one
   * currency and one of them has to be converted.
   *
   * The rate is a PARAMETER, not a hidden multiplication. A conversion nobody can see is the one
   * that gets quoted in a board meeting. And the default is parity, which is exact for a USD
   * business and roughly 20% out for a GBP one — which would matter enormously for "what is 3% of
   * revenue" and not at all here, because every finding in this module fires on multiples.
   */
  const { DEFAULT_USD_TO_MINOR } = await import("../src/client-economics");
  assert.equal(DEFAULT_USD_TO_MINOR, 100);

  const tasks = [task("c1", 10), task("c1", 10), task("c1", 10)];
  const at = (usd_to_minor: number) =>
    clientEconomics({
      client_id: "c1",
      tasks,
      invoices: [invoice("c1", { amount_paid: 100_000 })],
      approvals: [],
      currency: "GBP",
      usd_to_minor,
      now: NOW,
    });

  // The measured number never moves, whatever the rate is. That is the point of keeping it.
  assert.equal(at(100).direct_cost_usd, 30);
  assert.equal(at(80).direct_cost_usd, 30);
  // The converted one does, and by exactly the rate.
  assert.equal(at(100).direct_cost_minor, 3_000);
  assert.equal(at(80).direct_cost_minor, 2_400);

  // And a 20% error in the rate cannot flip the verdict, because £1,000 against $30 is not a close
  // call in any currency. That is the argument for a stated constant over a live rate.
  assert.equal(at(100).gross_minor > 0, true);
  assert.equal(at(80).gross_minor > 0, true);
  assert.equal(at(140).gross_minor > 0, true);
});
