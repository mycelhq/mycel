// Money plan + kickoff + party link — fulfillment glue that must not silently $0-invoice or drop parties.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyMoneyPlanEdit,
  draftInvoiceFromPlanLine,
  lineForAcceptedDeliverable,
  moneyPlanFromTemplate,
  readMoneyPlan,
  stampRetainerRecurrence,
  writeMoneyPlan,
} from "../src/money-plan";
import { fulfillmentOf, declaredWaitTaskType } from "../src/kickoff";
import { _resetParty, exchangePartyLink, mintPartyLink, resolvePartySession } from "../src/party";
import type { Case, Deliverable, Invoice } from "../src/contract";

// FROM THIS FILE, NOT FROM cwd. This read `join(process.cwd(), "..", "wedges")` on the stated
// assumption that cwd is `kernel/harness` — but `npm test` runs from `kernel/`, so it resolved to
// `<repo>/wedges`, which does not exist. It then OVERRODE the default in `wedgesDir()`
// (`cwd/wedges`), which had been correct all along: the line written to make the lookup work was
// the only reason it failed, and only when the suite ran the way CI runs it.
process.env.MYCEL_WEDGES_DIR ??= join(dirname(fileURLToPath(import.meta.url)), "..", "..", "wedges");

test("moneyPlanFromTemplate stamps planned lines", () => {
  const plan = moneyPlanFromTemplate("usd", [
    { label: "Setup", amount_minor: 50_000, kind: "deposit" },
    { label: "Monthly", amount_minor: 0, kind: "retainer" },
  ]);
  assert.equal(plan.currency, "USD");
  assert.equal(plan.lines.length, 2);
  assert.equal(plan.lines[0].status, "planned");
  assert.equal(plan.lines[1].amount_minor, 0);
  assert.equal(plan.lines[1].recurrence, undefined, "the builder does not invent a cadence");
});

test("stampRetainerRecurrence fills a monthly cadence so kickoff retainers actually recur", () => {
  const stamped = stampRetainerRecurrence(undefined, "2026-08-13");
  assert.equal(stamped.every, "month");
  assert.equal(stamped.interval, 1);
  assert.equal(stamped.anchor, "2026-08-13");
  assert.equal(stamped.state, "active");
  const fromWedge = stampRetainerRecurrence(
    { every: "month", interval: 1, state: "active" },
    "2026-08-13",
  );
  assert.equal(fromWedge.anchor, "2026-08-13");
  const copied = moneyPlanFromTemplate("USD", [
    {
      label: "Monthly close",
      amount_minor: 150_000,
      kind: "retainer",
      recurrence: stamped,
    },
  ]);
  assert.equal(copied.lines[0]!.recurrence?.anchor, "2026-08-13");
});

test("applyMoneyPlanEdit locks invoiced lines and allows new planned ones", () => {
  const base = moneyPlanFromTemplate("USD", [
    { label: "Deposit", amount_minor: 10_000, kind: "deposit" },
    { label: "Delivery", amount_minor: 90_000, kind: "milestone" },
  ]);
  base.lines[0] = { ...base.lines[0], status: "invoiced", invoice_id: "inv_1" };
  const next = applyMoneyPlanEdit(base, {
    currency: "USD",
    lines: [
      { id: base.lines[0].id, label: "Deposit (renamed)", amount_minor: 10_000, kind: "deposit" },
      { id: base.lines[1].id, label: "Delivery", amount_minor: 120_000, kind: "milestone" },
      { label: "Retainer", amount_minor: 5_000, kind: "retainer" },
    ],
  });
  assert.equal(next.lines.length, 3);
  assert.equal(next.lines[0].status, "invoiced");
  assert.equal(next.lines[0].label, "Deposit (renamed)");
  assert.equal(next.lines[1].amount_minor, 120_000);
  assert.equal(next.lines[2].status, "planned");
  assert.throws(
    () =>
      applyMoneyPlanEdit(base, {
        lines: [{ id: base.lines[0].id, label: "Deposit", amount_minor: 1, kind: "deposit" }],
      }),
    /cannot change amount/,
  );
  assert.throws(
    () =>
      applyMoneyPlanEdit(base, {
        lines: [{ id: base.lines[1].id, label: "Delivery", amount_minor: 90_000, kind: "milestone" }],
      }),
    /cannot remove invoiced/,
  );
});

test("lineForAcceptedDeliverable prefers the linked line, and infers only when there is exactly one", () => {
  const plan = moneyPlanFromTemplate("USD", [
    { label: "Deposit", amount_minor: 10_000, kind: "deposit" },
    { label: "Delivery", amount_minor: 90_000, kind: "milestone" },
  ]);
  plan.lines[1] = { ...plan.lines[1], deliverable_id: "d1" };
  const linked = lineForAcceptedDeliverable(plan, "d1");
  assert.equal(linked.ok && linked.line.id, plan.lines[1].id);
  // One unlinked positive milestone is not a guess — it is the only reading of the plan.
  const open = moneyPlanFromTemplate("USD", [
    { label: "Deposit", amount_minor: 10_000, kind: "deposit" },
    { label: "Delivery", amount_minor: 90_000, kind: "milestone" },
  ]);
  const inferred = lineForAcceptedDeliverable(open, "other");
  assert.equal(inferred.ok && inferred.line.label, "Delivery");
});

test("draftInvoiceFromPlanLine uses quantity_milli and unit_amount (not silent $0)", async () => {
  const invoices: Invoice[] = [];
  const { getBillingStore } = await import("../src/billing");
  const store = getBillingStore();
  const orig = store.createInvoice.bind(store);
  store.createInvoice = async (draft) => {
    const inv = await orig(draft);
    invoices.push(inv);
    return inv;
  };

  const kase: Case = {
    id: "c1",
    project_id: "p1",
    client_id: "cl1",
    wedge: "books-keeper",
    title: "Acme close",
    status: "open",
    stage: "active",
    data: writeMoneyPlan(
      {},
      moneyPlanFromTemplate("USD", [{ label: "Monthly close", amount_minor: 45_000, kind: "retainer" }]),
    ),
    history: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const domain = {
    async updateCase(id: string, patch: { data?: Record<string, unknown> }) {
      if (patch.data) kase.data = patch.data;
      kase.updated_at = new Date().toISOString();
      return kase;
    },
  };

  const plan = readMoneyPlan(kase.data)!;
  const out = await draftInvoiceFromPlanLine({
    domain: domain as never,
    kase,
    line: plan.lines[0],
  });
  assert.equal(out.invoice.lines[0].quantity_milli, 1000);
  assert.equal(out.invoice.lines[0].unit_amount, 45_000);
  assert.ok((out.invoice.total ?? out.invoice.lines[0].unit_amount) >= 45_000 || out.invoice.amount_due === undefined);
  // Line marked invoiced on the case plan
  const next = readMoneyPlan(out.case.data)!;
  assert.equal(next.lines[0].status, "invoiced");
  assert.equal(next.lines[0].invoice_id, out.invoice.id);

  store.createInvoice = orig;
});

test("fulfillmentOf reads books-keeper connect + intake + money plan", () => {
  const spec = fulfillmentOf("books-keeper");
  assert.ok(spec);
  assert.ok((spec!.client_connections?.length ?? 0) >= 1);
  assert.ok((spec!.intake_asks?.length ?? 0) >= 1);
  assert.ok(spec!.money_plan);
  const retainer = spec!.money_plan!.lines.find((l) => l.kind === "retainer");
  assert.ok(retainer?.recurrence, "a retainer line from kickoff must recur, not bill once");
  assert.equal(retainer!.recurrence!.every, "month");
  assert.equal(retainer!.recurrence!.state, "active");
  assert.match(retainer!.recurrence!.anchor, /^\d{4}-\d{2}-\d{2}$/);
});

test("declaredWaitTaskType: books-keeper parks on chase_receipts; invoice-chaser has none", () => {
  assert.equal(declaredWaitTaskType("books-keeper"), "chase_receipts");
  assert.equal(declaredWaitTaskType("invoice-chaser"), undefined);
});

test("invoice-chaser does not declare deliverable_shapes — a chase is not a pack to accept", () => {
  const spec = fulfillmentOf("invoice-chaser");
  assert.ok(spec);
  assert.equal(spec!.deliverable_shapes?.length ?? 0, 0);
});

test("fulfillmentOf: an authored service with no block still yields a document the client can accept", () => {
  // THE BUG: loadWedge refuses drafted: slugs, so wrap saw undefined and a green authored job
  // never appeared on Deliverables.
  const slug = "drafted:proposals-and-signoff";
  const spec = fulfillmentOf(slug);
  assert.deepEqual(spec?.deliverable_shapes, ["document"]);
  const withIntake = fulfillmentOf(slug, {
    fulfillment: { intake_asks: [{ kind: "answer", ask: "What's the day rate?" }] },
  });
  assert.equal(withIntake?.intake_asks?.length, 1);
  assert.deepEqual(withIntake?.deliverable_shapes, ["document"]);
});

test("party link exchanges once and scopes to one request", async () => {
  _resetParty();
  const { token } = mintPartyLink({
    project_id: "p",
    client_id: "c",
    request_id: "r1",
    party_role: "candidate",
    party_label: "Alex",
  });
  const first = await exchangePartyLink(token);
  assert.ok(first);
  assert.equal(first!.scope.request_id, "r1");
  assert.equal(first!.scope.party_role, "candidate");
  // Within grace: same session (email scanners). Outside grace would be undefined.
  const replay = await exchangePartyLink(token);
  assert.ok(replay);
  assert.equal(replay!.token, first!.token);
  const scope = await resolvePartySession(first!.token);
  assert.equal(scope?.request_id, "r1");
});

test("deliverable stub type still accepts accepted for money plan linking", () => {
  const d: Deliverable = {
    id: "d1",
    project_id: "p",
    case_id: "c",
    client_id: "cl",
    title: "March close",
    kind: "document",
    status: "accepted",
    current_version: 1,
    accepted_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  assert.equal(d.status, "accepted");
});
