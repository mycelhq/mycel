// Binding by capability instead of by vendor, and the normalisation that makes it true.
//
// THE FAILURE ALL OF THIS EXISTS FOR: `books-keeper.json` declared `{"name": "xero"}` and
// `invoice-chaser.json` declared `{"name": "stripe"}`, so a bookkeeper on QuickBooks was asked to
// connect Xero and a business paid by bank transfer was asked to connect Stripe. Every test here
// names the specific thing it stops.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ALL_CAPABILITIES,
  CAPABILITIES,
  assertCapabilityTableValid,
  capabilityFault,
  capabilityProviders,
  isCapability,
  projectWedgeSlugs,
  readToolsFor,
  resolveCapability,
  whyNoProvider,
} from "../src/capabilities";
import {
  INVOICE_SHAPES,
  PAYMENT_SHAPES,
  hasShape,
  normaliseQuickBooksInvoices,
  normaliseQuickBooksPayments,
  normaliseStripeInvoices,
  normaliseXeroInvoices,
  normaliseXeroPayments,
  toMinorUnits,
} from "../src/capabilities.normalise";
import { readCapability, whyNothingRead } from "../src/capabilities.read";
import { capabilityConnections } from "../src/runtime";
import { manifestFaults } from "../src/roles";
import type { Connection } from "../src/contract";

const PROJECT = "proj-ours";

function conn(o: Partial<Connection> & { toolkit?: string; reads?: string[] } = {}): Connection {
  const { toolkit = "stripe", reads = [], ...rest } = o;
  return {
    id: `conn-${toolkit}`,
    project_id: PROJECT,
    kind: "composio",
    name: toolkit,
    owner: { kind: "founder", id: "founder" },
    config: { toolkit, connected_account_id: "ca_1", verified_at: "2026-01-01T00:00:00.000Z", read_tools: reads },
    created_at: new Date().toISOString(),
    ...rest,
  } as Connection;
}

// ─────────────────────────── the vocabulary ───────────────────────────

test("capabilities: the vocabulary is closed, and a mistyped one is refused rather than ignored", () => {
  // A silently-ignored capability is strictly worse than the vendor hardcode it replaced: the
  // hardcode was visible in a grep and it worked. A dropped one produces a run with no hands that
  // still reports a clean finish.
  assert.ok(isCapability("read_payments"));
  assert.equal(isCapability("read_payment"), false);
  assert.equal(capabilityFault("read_payments"), undefined);
  assert.match(capabilityFault("read_payment")!, /did you mean "read_payments"/);
  assert.match(capabilityFault("READ_PAYMENTS")!, /did you mean "read_payments"/);
  assert.match(capabilityFault("send_mail")!, /did you mean "send_email"/, "an anagram is still a typo");
  // Nothing anyone could have meant gets the whole vocabulary rather than a confident wrong guess.
  assert.match(capabilityFault("book_a_courier")!, /known capabilities: /);

  // Every capability carries the sentence for a founder when nothing provides it, and it says what
  // STOPS — not "not configured". Same contract as `whyNoWedge` in roles.ts.
  for (const c of ALL_CAPABILITIES) {
    assert.ok(whyNoProvider(c).length > 40, `${c} needs a real sentence`);
    assert.ok(!/not configured|unavailable/i.test(whyNoProvider(c)), `${c} must say what stops, not that a setting is unset`);
  }
});

test("capabilities: a wedge that mistypes a capability refuses at load, naming the typo", () => {
  // The same refusal one level up. A wedge declaring `read_payment` resolves to no connections at
  // grant time, and an empty grant is indistinguishable from a business that connected nothing — so
  // the run goes ahead with no hands and reports success.
  const faults = manifestFaults("chaser", {
    wedge: "chaser",
    title: "t",
    capabilities: ["read_payment"],
  });
  assert.equal(faults.length, 1);
  assert.match(faults[0].message, /did you mean "read_payments"/);
  assert.equal(manifestFaults("chaser", { wedge: "c", title: "t", capabilities: ["read_payments"] }).length, 0);
  assert.match(
    manifestFaults("chaser", { wedge: "c", title: "t", capabilities: "read_payments" })[0].message,
    /must be an array/,
  );
});

test("capabilities: the provider table only names normalisers that exist", () => {
  // The boot gate. A table entry pointing at a shape with no parser would produce a provider that
  // connects, shows a green tick, and reads nothing forever.
  assertCapabilityTableValid(hasShape);

  assert.throws(
    () => assertCapabilityTableValid((cap, shape) => (cap === "read_payments" ? shape === "stripe_invoices" : hasShape(cap, shape))),
    /no normaliser provides/,
  );

  // And the two halves agree about which shapes exist at all.
  for (const [name, shapes] of [["read_payments", PAYMENT_SHAPES], ["read_invoices", INVOICE_SHAPES]] as const) {
    for (const s of Object.keys(shapes)) assert.ok(hasShape(name, s));
  }
  assert.equal(hasShape("send_email", "stripe_invoices"), false, "a capability the kernel does not parse has no shapes");
});

// ─────────────────────────── resolution ───────────────────────────

test("capabilities: two providers for a read capability are BOTH used, deterministically", () => {
  /**
   * THE BUG: a business takes card payments through Stripe and bank transfers through QuickBooks.
   * Picking one provider — however deterministically — means every invoice settled in the other one
   * keeps getting chased. Reads are therefore `cardinality: "all"` and the results are unioned.
   */
  assert.equal(CAPABILITIES.read_payments.cardinality, "all");
  const conns = [conn({ toolkit: "quickbooks" }), conn({ toolkit: "stripe" })];
  const b = resolveCapability("read_payments", conns, PROJECT);
  assert.equal(b.ok, true);
  assert.equal(b.ambiguous, false);
  // Table order, not connection order — so the answer does not depend on which was connected first.
  assert.deepEqual(b.bound.map((x) => x.provider.toolkit), ["stripe", "quickbooks"]);
  assert.deepEqual(
    resolveCapability("read_payments", [...conns].reverse(), PROJECT).bound.map((x) => x.provider.toolkit),
    ["stripe", "quickbooks"],
    "and it is stable under the order the rows come back in",
  );
});

test("capabilities: two providers for a SEND capability refuse, and name both", () => {
  /**
   * THE BUG, and the argument for refusing rather than picking: sending the same chase from Gmail
   * and Outlook is not a merge, it is sending it twice, and picking one by array order silently
   * decides which address a client sees the business as. roles.ts refuses two dunning wedges for the
   * same reason.
   */
  assert.equal(CAPABILITIES.send_email.cardinality, "one");
  const b = resolveCapability("send_email", [conn({ toolkit: "gmail" }), conn({ toolkit: "outlook" })], PROJECT);
  assert.equal(b.ok, false);
  assert.equal(b.ambiguous, true);
  assert.match(b.detail, /Gmail/);
  assert.match(b.detail, /Outlook/);
  assert.match(b.detail, /Disconnect one/, "and it says what to do, rather than only that it is confused");
});

test("capabilities: a connected provider the kernel cannot read is LOUD, not silently empty", async () => {
  /**
   * THE RECURRING EXPENSIVE BUG IN THIS REPO: something fails while reporting success. Here it would
   * be a founder connecting FreshBooks, the checklist going green, and the chaser reading zero
   * invoices from it forever while every summary says the run was clean.
   */
  const b = resolveCapability("read_payments", [conn({ toolkit: "freshbooks" })], PROJECT);
  assert.equal(b.bound.length, 1, "it IS connected — that part is true");
  assert.equal(b.bound[0].unreadable, true);
  assert.equal(b.ok, false, "but the capability does not work, and says so");
  assert.match(b.detail, /no reader for it yet/);
  assert.match(b.detail, /not working/);

  const read = await readCapability({
    capability: "read_payments",
    project_id: PROJECT,
    connections: [conn({ toolkit: "freshbooks" })],
    execute: async () => assert.fail("nothing should be called on a provider with no reads"),
    shapes: PAYMENT_SHAPES,
  });
  assert.equal(read.reached, false);
  assert.equal(read.items.length, 0);
  assert.equal(read.failures.length, 1, "and the emptiness arrives with a reason attached");
  assert.match(whyNothingRead(read)!, /no reader/);
});

test("capabilities: resolution is project-scoped and founder-owned, with no default", () => {
  // Two cross-tenant leaks have shipped in this repo and both were a scope that defaulted.
  assert.throws(() => resolveCapability("read_payments", [], ""), /scoped to a project/);
  const foreign = conn({ project_id: "proj-theirs" });
  const unscoped = conn({ project_id: undefined, id: "conn-unscoped" });
  const clientOwned = conn({ owner: { kind: "client", id: "cli-1" }, id: "conn-client" });
  const b = resolveCapability("read_payments", [foreign, unscoped, clientOwned], PROJECT);
  assert.deepEqual(b.bound, [], "another tenant's, an unscoped one, and a client's own are all invisible");
  assert.equal(b.detail, whyNoProvider("read_payments"));
});

test("capabilities: an unfinished OAuth is not a connection", () => {
  // A row exists from the moment Connect is clicked. Counting it turns an abandoned authorise screen
  // into a green tick on a business that cannot do the thing.
  const started = conn();
  (started.config as Record<string, unknown>).verified_at = undefined;
  assert.deepEqual(resolveCapability("read_payments", [started], PROJECT).bound, []);
});

test("capabilities: a wedge's grant resolves to whatever the founder actually connected", () => {
  /**
   * THE BUG: `invoice-chaser/wedge.json` declared `connections: ["stripe"]`, matched by NAME. A
   * business on QuickBooks had no connection called "stripe", so the grant was empty and the agent
   * ran with no hands — silently.
   */
  const qb = conn({ toolkit: "quickbooks" });
  const { ids, missing } = capabilityConnections(["read_payments", "send_email"], [qb], PROJECT);
  assert.deepEqual(ids, [qb.id], "the QuickBooks connection is granted for read_payments");
  assert.equal(missing.length, 1, "and the mailbox it does not have is reported, not ignored");
  assert.match(missing[0], /no mailbox is connected/);

  // No project means no tenant to resolve against, and resolving against every project is the leak.
  assert.deepEqual(capabilityConnections(["read_payments"], [qb], undefined).ids, []);
  // An ambiguous send grants NOTHING rather than both — two mailboxes and no rule is two chases.
  const both = capabilityConnections(["send_email"], [conn({ toolkit: "gmail" }), conn({ toolkit: "outlook" })], PROJECT);
  assert.deepEqual(both.ids, []);
  assert.match(both.missing[0], /Disconnect one/);
});

test("capabilities: only the reads the founder granted are ever called", async () => {
  // The provider table is a wish list; the connection is permission. The difference between a
  // declared read and an undeclared one is the difference between listing charges and issuing refunds.
  const calls: string[] = [];
  const read = await readCapability({
    capability: "read_payments",
    project_id: PROJECT,
    connections: [conn({ toolkit: "stripe", reads: ["STRIPE_LIST_CHARGES"] })],
    execute: async (_c, slug) => {
      calls.push(slug);
      return { ok: true, detail: "ok", data: { data: [] } };
    },
    shapes: PAYMENT_SHAPES,
  });
  assert.deepEqual(calls, ["STRIPE_LIST_CHARGES"], "the invoice read was wanted but never granted, so never called");
  assert.deepEqual(read.ungranted, ["stripe/STRIPE_LIST_INVOICES"]);
  assert.equal(read.reached, true);
});

// ─────────────────────────── normalisation ───────────────────────────

test("normalise: a QuickBooks business gets a working invoice read", async () => {
  /**
   * The whole point, end to end and with no Xero anywhere: a QuickBooks payload becomes the same
   * shape the kernel already uses, so `match.ts` and the invoice model do not care which ledger it
   * came from.
   */
  const payload = {
    QueryResponse: {
      Invoice: [
        {
          Id: "130",
          DocNumber: "1037",
          TxnDate: "2026-07-24",
          DueDate: "2026-08-23",
          CurrencyRef: { value: "GBP" },
          CustomerRef: { name: "Northwind Joinery" },
          TotalAmt: 1500.5,
          Balance: 500.25,
        },
      ],
    },
  };
  const { items, skipped } = normaliseQuickBooksInvoices(payload);
  assert.deepEqual(skipped, []);
  assert.deepEqual(items, [
    {
      external_id: "130",
      number: "1037",
      client_name: "Northwind Joinery",
      total_minor: 150_050,
      amount_paid_minor: 100_025,
      amount_due_minor: 50_025,
      currency: "GBP",
      issue_date: "2026-07-24",
      due_date: "2026-08-23",
      status_hint: undefined,
    },
  ]);

  // And through the real read path, so the toolkit slug, the grant and the shape all line up.
  const read = await readCapability({
    capability: "read_invoices",
    project_id: PROJECT,
    connections: [conn({ toolkit: "quickbooks", reads: readToolsFor("read_invoices", "quickbooks") })],
    execute: async () => ({ ok: true, detail: "ok", data: payload }),
    shapes: INVOICE_SHAPES,
  });
  assert.equal(read.reached, true);
  assert.equal(read.items.length, 1);
  assert.equal(read.items[0].external_id, "conn-quickbooks:130", "namespaced, so two ledgers cannot collide on id 130");
  assert.deepEqual(read.failures, []);
});

test("normalise: money converts exactly, or refuses — it never rounds a provider's number", () => {
  /**
   * THE BUG: `Math.round(1.005 * 100)` is 100, not 101, because 1.005 is not representable. A penny
   * lost on a ledger read hourly is an invoice that never reaches `amount_due === 0` and is chased
   * forever, and nobody finds it because the arithmetic looks clean at every step.
   */
  assert.deepEqual(toMinorUnits(1.005, "GBP"), { error: expectedError(toMinorUnits(1.005, "GBP")) });
  assert.match((toMinorUnits(1.005, "GBP") as { error: string }).error, /more decimal places/);
  assert.deepEqual(toMinorUnits(100.5, "GBP"), { minor: 10_050 });
  assert.deepEqual(toMinorUnits("100.50", "GBP"), { minor: 10_050 });
  assert.deepEqual(toMinorUnits(-40, "USD"), { minor: -4000 });
  assert.deepEqual(toMinorUnits(0, "USD"), { minor: 0 });

  // ¥1,000 is 1000 minor units, not 100000. A two-decimal default inflates a Japanese invoice
  // hundredfold in the direction of "settled".
  assert.deepEqual(toMinorUnits(1000, "JPY"), { minor: 1000 });
  assert.deepEqual(toMinorUnits(1.5, "KWD"), { minor: 1500 });

  // A currency we cannot size REFUSES. There is no default, because the default is the bug.
  assert.match((toMinorUnits(10, "") as { error: string }).error, /not one this kernel can size/);
  assert.match((toMinorUnits(10, "BITCOIN") as { error: string }).error, /not one this kernel can size/);
  assert.match((toMinorUnits("1e2", "GBP") as { error: string }).error, /not a plain decimal/);
  assert.match((toMinorUnits(undefined, "GBP") as { error: string }).error, /missing or not a number/);
});

const expectedError = (r: unknown) => (r as { error: string }).error;

test("normalise: never invents a value the provider did not return", () => {
  /**
   * THE BUG, concretely: `paid_at` is documented as "when the money moved, NOT when we were told
   * about it". A payment stamped with today's date on a provider that did not say makes our own
   * audit trail agree with a chase we should never have sent — an invoice settled on the 3rd and
   * read on the 6th was never overdue.
   */
  const undated = normaliseXeroPayments({ Payments: [{ PaymentID: "p1", Amount: 100, CurrencyCode: "GBP" }] });
  assert.deepEqual(undated.items, [], "no date, no payment");
  assert.equal(undated.skipped.length, 1);
  assert.match(undated.skipped[0], /no date on it/);

  const noDate = normaliseQuickBooksPayments({ QueryResponse: { Payment: [{ Id: "1", TotalAmt: 10, CurrencyRef: { value: "GBP" } }] } });
  assert.deepEqual(noDate.items, []);
  assert.match(noDate.skipped[0], /no transaction date/);

  // Stripe's old parser fell back to `new Date(0)` — a 1970 payment, which is a fabricated fact
  // rather than a missing one, and one that can never match a real invoice by date.
  const noTime = normaliseStripeInvoices({ data: [{ id: "in_1", amount_paid: 100, currency: "gbp" }] });
  assert.deepEqual(noTime.items, []);
  assert.match(noTime.skipped[0], /no date it was paid/);

  // Fields the provider omitted come back absent, never guessed.
  const minimal = normaliseQuickBooksInvoices({ QueryResponse: { Invoice: [{ Id: "9", TotalAmt: 10, Balance: 0, CurrencyRef: { value: "GBP" } }] } });
  assert.equal(minimal.items[0].number, undefined);
  assert.equal(minimal.items[0].client_name, undefined);
  assert.equal(minimal.items[0].due_date, undefined);
  assert.equal(minimal.items[0].status_hint, "paid", "the balance IS the status; that is a fact it did return");
});

test("normalise: Xero bills are not invoices, and a Xero refund is negative", () => {
  /**
   * THE BUG: `ACCPAY` is a bill the business OWES a supplier. Reading it as an invoice puts the
   * business's own outgoings into its accounts receivable, and every number after that — what is
   * owed, what is overdue, who gets chased — is wrong in the direction of chasing a supplier for
   * money we owe them.
   */
  const { items } = normaliseXeroInvoices({
    Invoices: [
      { InvoiceID: "a", Type: "ACCPAY", Total: 100, AmountDue: 100, CurrencyCode: "GBP" },
      { InvoiceID: "b", Type: "ACCREC", InvoiceNumber: "INV-9", Total: 100, AmountPaid: 25, AmountDue: 75, CurrencyCode: "GBP", DueDate: "2026-04-01" },
    ],
  });
  assert.deepEqual(items.map((i) => i.external_id), ["b"]);
  assert.equal(items[0].amount_paid_minor, 2500);
  assert.equal(items[0].due_date, "2026-04-01");

  // Xero models a refund as a positive amount with a credit payment type. Reading the amount alone
  // applies a refund as a payment and marks a reopened invoice settled.
  const refund = normaliseXeroPayments({
    Payments: [{ PaymentID: "p1", Amount: 40, CurrencyCode: "GBP", Date: "2026-04-02", PaymentType: "ARCREDITPAYMENT" }],
  });
  assert.equal(refund.items[0].amount_minor, -4000);
  const normal = normaliseXeroPayments({
    Payments: [{ PaymentID: "p2", Amount: 40, CurrencyCode: "GBP", Date: "/Date(1775001600000+0000)/", PaymentType: "ACCRECPAYMENT", Invoice: { InvoiceNumber: "INV-9" } }],
  });
  assert.equal(normal.items[0].amount_minor, 4000);
  assert.equal(normal.items[0].reference, "INV-9");
  assert.match(normal.items[0].paid_at, /^2026-/, "and Xero's /Date(ms)/ form is read, not dropped");
});

test("capabilities: every provider that claims a read declares one this kernel can run", () => {
  // Guards the honest half of the table: an entry with `reads: []` is a deliberate statement that
  // the kernel cannot read it, and it must never carry read tools that go nowhere.
  for (const capability of ALL_CAPABILITIES) {
    for (const p of capabilityProviders(capability)) {
      const slugs = readToolsFor(capability, p.toolkit);
      assert.deepEqual(slugs, (p.reads ?? []).map((r) => r.slug), `${capability}/${p.toolkit}`);
      if (!CAPABILITIES[capability].kernel_parses) {
        assert.deepEqual(slugs, [], `${capability} is not parsed by the kernel, so ${p.toolkit} must claim no reads`);
      }
    }
  }
});

// ─────────── whose business is this, anyway ───────────

test("capabilities: a trade-specific app is never proposed to a business that did not set that trade up", () => {
  /**
   * THE BUG THIS NAMES, observed in production. A design studio finished onboarding and screen six
   * asked it *"Read the invoices you've raised — For Monthly Close for E-commerce"*, with Xero,
   * QuickBooks and FreshBooks underneath. The founder's words, for the second time:
   *
   *   "I'm not a bookkeeping company, for fuck's sake."
   *
   * `GET /v1/capabilities` listed every wedge directory on disk and narrowed it by
   * `projectAllowsWedge`, which is `allowlist.length === 0 || allowlist.includes(w)`. Nothing in
   * the kernel ever writes that allowlist, so the narrowing was a no-op on every real tenant,
   * `books-keeper` ships with every install, and `needed_by` for the bookkeeping capabilities was
   * therefore non-empty for everybody. The cloud had already diagnosed this and routed around it in
   * ONE consumer; every other consumer inherited it.
   */
  const schedules = [
    { project_id: "proj-studio", wedge: "brand-sprint" },
    // The bookkeeper's own schedule, on the bookkeeper's own project. Present precisely so the
    // assertion below is about SCOPE and not about the fixture having nothing to leak.
    { project_id: "proj-books", wedge: "books-keeper" },
  ];
  const never = () => false;
  const always = () => true;

  // `always` is `projectAllowsWedge` behaving exactly as it does in production: an empty allowlist
  // permits everything. It must not, on its own, make a wedge a member of this project.
  assert.deepEqual(
    projectWedgeSlugs({ schedules, projectId: "proj-studio", allows: always, authored: never }),
    ["brand-sprint"],
    "a permissive allowlist is a permission, not a membership — books-keeper is another project's",
  );

  // And the bookkeeper still gets their own.
  assert.deepEqual(
    projectWedgeSlugs({ schedules, projectId: "proj-books", allows: always, authored: never }),
    ["books-keeper"],
  );

  /**
   * THE SAME BUG POINTING THE OTHER WAY. Authored wedges are per-project and are not on disk, so a
   * studio's own service — the only thing it genuinely runs — could never appear in `needed_by`.
   * The route reported every capability EXCEPT the ones this business had actually declared.
   * Authored slugs are never on any allowlist, so subjecting them to one deletes them.
   */
  assert.deepEqual(
    projectWedgeSlugs({
      schedules: [{ project_id: "proj-studio", wedge: "authored-x" }],
      projectId: "proj-studio",
      allows: never,
      authored: (w) => w === "authored-x",
    }),
    ["authored-x"],
  );

  // A restrictive allowlist still narrows on-disk slugs — it is kept as a filter, just never as the
  // membership test.
  assert.deepEqual(
    projectWedgeSlugs({ schedules, projectId: "proj-studio", allows: never, authored: never }),
    [],
  );

  /**
   * FAIL CLOSED ON A MISSING PROJECT. Without this, a falsy project id matches every schedule whose
   * own `project_id` is unset and this function becomes a cross-tenant read. Two such leaks have
   * shipped in this repo already.
   */
  assert.deepEqual(
    projectWedgeSlugs({
      schedules: [{ project_id: undefined, wedge: "books-keeper" }],
      projectId: "",
      allows: always,
      authored: never,
    }),
    [],
  );
});
