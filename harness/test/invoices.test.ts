// The invoice surface — `/v1/invoices*` and `/v1/portal/invoices*`.
//
// billing.ts was complete and tested and UNREACHABLE: no routes, and `initBillingStore()` called by
// no non-test file. These tests are about the boundary, not the arithmetic (billing.test.ts owns
// that): tenancy, what crosses to the client, and that money stays an integer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { api, connectMailbox, makeApp } from "./helpers";
import { getDomainStore } from "../src/domain";
import { _resetBilling } from "../src/billing";
import { _resetPortal } from "../src/portal";
import { daysBetween, toPortalInvoice } from "../src/invoices.routes";
import type { Invoice } from "../src/contract";
import { setCheckoutDeps } from "../src/payments.stripe";

const OWNER_EMAIL = process.env.MYCEL_OWNER_EMAIL || "owner@test.co";
const OWNER_PW = process.env.MYCEL_OWNER_PASSWORD || "secret";
const LINE = { description: "Bookkeeping, March", kind: "fixed", unit_amount: 45_000, tax_bps: 2000 };

async function world() {
  _resetBilling();
  _resetPortal();
  const { app } = makeApp();
  const projectId = (await api(app, "me")).json.projects[0].id as string;
  const domain = getDomainStore();
  const mk = async (name: string) => {
    const client = await domain.createClient({ project_id: projectId, display_name: name, handles: [`${name}@inv.test`], metadata: {} });
    const link = await api(app, `clients/${client.id}/portal-link`, { method: "POST" });
    const token = (await api(app, "portal/session", { method: "POST", body: JSON.stringify({ token: link.json.token }) })).json.token as string;
    return { client, h: { authorization: `Bearer ${token}` } };
  };
  const login = await app.request("/v1/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PW }),
  });
  return { app, projectId, domain, memberToken: (await login.json()).token as string, a: await mk("acme"), b: await mk("beta") };
}

const draft = (app: any, clientId: string, extra: Record<string, unknown> = {}) =>
  api(app, "invoices", { method: "POST", body: JSON.stringify({ client_id: clientId, currency: "USD", lines: [LINE], ...extra }) });

test("invoices: created as a draft, totalled in integer minor units", async () => {
  const { app, a } = await world();
  const r = await draft(app, a.client.id, { due_date: "2020-01-01" });
  assert.equal(r.status, 201);
  assert.equal(r.json.status, "draft", "never born `sent` — nothing could then say when the clock started");
  assert.ok(r.json.number, "a reference is allocated on creation");
  assert.deepEqual(r.json.totals, { subtotal: 45_000, tax_total: 9_000, total: 54_000, amount_paid: 0, amount_due: 54_000 });
  assert.equal(r.json.minor_unit_exponent, 2, "the browser is told how to format without a currency table");
  assert.equal(Number.isSafeInteger(r.json.totals.total), true);
});

test("invoices: a client id in another tenant is refused, and so is another tenant's invoice", async () => {
  // THE BUG: an invoice pointed at a client in another tenant appears in that tenant's portal as a
  // demand for money from a business their customer has never heard of.
  const { app, a, memberToken } = await world();
  const keyB = (await api(app, "projects", { method: "POST", body: JSON.stringify({ name: "other-co" }) }, memberToken)).json.api_key as string;
  assert.equal((await draft(app, a.client.id, {})).status, 201);

  const steal = await api(app, "invoices", { method: "POST", body: JSON.stringify({ client_id: a.client.id, lines: [LINE] }) }, keyB);
  assert.equal(steal.status, 400);

  const mine = (await draft(app, a.client.id)).json as Invoice;
  assert.equal((await api(app, `invoices/${mine.id}`, {}, keyB)).status, 404);
  assert.equal((await api(app, `invoices/${mine.id}`, { method: "DELETE" }, keyB)).status, 404);
  assert.equal((await api(app, `invoices/${mine.id}/payments`, { method: "POST", body: JSON.stringify({ amount_minor: 1 }) }, keyB)).status, 404);
  assert.deepEqual((await api(app, "invoices", {}, keyB)).json, []);
});

test("invoices: the status machine is enforced, and terminal means terminal", async () => {
  const { app, a } = await world();
  const inv = (await draft(app, a.client.id, { due_date: "2030-01-01" })).json as Invoice;

  assert.equal((await api(app, `invoices/${inv.id}/status`, { method: "POST", body: JSON.stringify({ to: "paid" }) })).status, 409, "draft → paid is not a legal move");
  const sent = await api(app, `invoices/${inv.id}/status`, { method: "POST", body: JSON.stringify({ to: "sent" }) });
  assert.equal(sent.status, 200);
  assert.equal(sent.json.issue_date, new Date().toISOString().slice(0, 10));
  assert.ok(sent.json.sent_at);

  assert.equal((await api(app, `invoices/${inv.id}`, { method: "DELETE" })).status, 409, "an issued invoice is voided, not deleted");
  const voided = await api(app, `invoices/${inv.id}/status`, { method: "POST", body: JSON.stringify({ to: "void" }) });
  assert.equal(voided.status, 200);
  assert.equal((await api(app, `invoices/${inv.id}`, { method: "PUT", body: JSON.stringify({ note: "actually…" }) })).status, 409);
});

test("invoices: marking one SENT no longer sends nothing while reporting success", async () => {
  // ═══ THE BUG ═══
  //
  // `POST /v1/invoices/:id/status {to:"sent"}` stamped `sent_at`, started the overdue clock and
  // armed the dunning ladder — and emailed nothing. Every surface downstream then believed the
  // client had the invoice: it turned overdue on the due date and the sweep chased somebody who had
  // never been asked for the money. A silent success standing directly on the cash.
  //
  // The transition is still allowed with no mailbox (a founder who posted a paper copy clicks the
  // same button), so what this pins is that the ANSWER TELLS THE TRUTH either way. The one outcome
  // that must be impossible is the old one: nothing sent and nothing said.
  const { app, projectId, a } = await world();

  const noMailbox = (await draft(app, a.client.id, { due_date: "2030-01-01" })).json as Invoice;
  const first = await api(app, `invoices/${noMailbox.id}/status`, { method: "POST", body: JSON.stringify({ to: "sent" }) });
  assert.equal(first.status, 200, "the founder is never blocked from recording that they issued it");
  assert.equal(first.json.delivery?.sent, false);
  assert.ok(
    /mailbox|connect/i.test(first.json.delivery?.detail ?? ""),
    `the answer names what is missing, got: ${first.json.delivery?.detail}`,
  );

  // A client with no email address on file is the other honest failure, and it is a different fix.
  const domain = getDomainStore();
  await connectMailbox(projectId);
  const anonymous = await domain.createClient({ project_id: projectId, display_name: "no-address", handles: [], metadata: {} });
  const unreachable = (await draft(app, anonymous.id, { due_date: "2030-01-01" })).json as Invoice;
  const second = await api(app, `invoices/${unreachable.id}/status`, { method: "POST", body: JSON.stringify({ to: "sent" }) });
  assert.equal(second.json.delivery?.sent, false);
  assert.match(second.json.delivery?.detail ?? "", /no email address/i);

  // And with both a mailbox and an address, the send is ATTEMPTED — it reaches the executor and
  // comes back with the provider's own answer rather than being skipped.
  const reachable = (await draft(app, a.client.id, { due_date: "2030-01-01" })).json as Invoice;
  const third = await api(app, `invoices/${reachable.id}/status`, { method: "POST", body: JSON.stringify({ to: "sent" }) });
  assert.equal(third.json.delivery?.to, "acme@inv.test", "addressed to the client's own handle");
  assert.ok(
    !/no mailbox|no email address/i.test(third.json.delivery?.detail ?? ""),
    `a resolved mailbox and address must reach the send path, got: ${third.json.delivery?.detail}`,
  );
});

test("invoices: a payment is a whole number of minor units, and settles the invoice exactly once", async () => {
  // THE BUG the type guard prevents: accepting 12.50 and truncating it to 12 minor units — silently
  // writing off $12.38. Refusing is the only honest option.
  const { app, a } = await world();
  const inv = (await draft(app, a.client.id, { due_date: "2030-01-01" })).json as Invoice;
  await api(app, `invoices/${inv.id}/status`, { method: "POST", body: JSON.stringify({ to: "sent" }) });

  for (const amount of [12.5, "5400", null, 0]) {
    const bad = await api(app, `invoices/${inv.id}/payments`, { method: "POST", body: JSON.stringify({ amount_minor: amount }) });
    assert.equal(bad.status, 400, `amount_minor ${JSON.stringify(amount)} must be refused, never truncated`);
  }

  const part = await api(app, `invoices/${inv.id}/payments`, { method: "POST", body: JSON.stringify({ amount_minor: 4_000 }) });
  assert.equal(part.json.totals.amount_due, 50_000);
  assert.equal(part.json.status, "sent", "a partial payment does not settle anything");

  const rest = await api(app, `invoices/${inv.id}/payments`, { method: "POST", body: JSON.stringify({ amount_minor: 50_000 }) });
  assert.equal(rest.json.totals.amount_due, 0);
  assert.equal(rest.json.status, "paid");
  assert.ok(rest.json.paid_at);
});

test("invoices: the portal shows this client's issued invoices and nothing else", async () => {
  // Two bugs at once. A draft crossing the plane is a demand for money nobody has decided to make;
  // an invoice reachable by changing the id in the URL is another customer's finances.
  const { app, a, b } = await world();
  const mine = (await draft(app, a.client.id, { due_date: "2030-01-01", internal_note: "chase hard" })).json as Invoice;
  const theirs = (await draft(app, b.client.id, { due_date: "2030-01-01" })).json as Invoice;
  const stillDraft = (await draft(app, a.client.id)).json as Invoice;
  for (const id of [mine.id, theirs.id]) {
    await api(app, `invoices/${id}/status`, { method: "POST", body: JSON.stringify({ to: "sent" }) });
  }

  const list = await api(app, "portal/invoices", { headers: a.h });
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.map((i: Invoice) => i.id), [mine.id], "theirs, issued, and only that");

  assert.equal((await api(app, `portal/invoices/${theirs.id}`, { headers: a.h })).status, 404, "another client's, by id");
  assert.equal((await api(app, `portal/invoices/${stillDraft.id}`, { headers: a.h })).status, 404, "their own draft, by id");
  assert.equal((await api(app, `portal/invoices/${mine.id}`)).status, 401, "and nothing without a session");
});

test("invoices: the portal projection drops the operator's half", async () => {
  // `internal_note` is where "they always pay late" gets written, and `task_ids` is a run id a
  // client has no use for and every use for not seeing. Tested on the pure function so a future
  // field cannot be added to the row and quietly ride across.
  const out = toPortalInvoice({
    id: "i1", project_id: "p", client_id: "c", number: "INV-0001", currency: "USD", status: "sent",
    lines: [{ id: "l1", description: "work", kind: "fixed", quantity_milli: 1000, unit_amount: 1000, task_ids: ["task_secret"] }],
    amount_paid: 0, internal_note: "chase hard", note: "thanks", created_at: "x", updated_at: "x",
  } as Invoice) as any;
  assert.equal("internal_note" in out, false);
  assert.equal("task_ids" in out.lines[0], false);
  assert.equal(out.note, "thanks", "the note the client is meant to read stays");
});

test("invoices: chasing reads the real row, and refuses what must not be chased", async () => {
  // THE BUG: `chase_invoice` was handed the facts of a debt as FREE TEXT. The agent could not verify
  // an amount, could not format a currency it was never told, could not tell a partial payment from
  // none — and `days_overdue`, the one input the wedge's `next_step` workflow branches on, was a
  // number a human had worked out in their head.
  const { app, a, projectId } = await world();
  // A business with no mailbox no longer chases at all — see `connectMailbox` and promises.ts.
  await connectMailbox(projectId);
  const inv = (await draft(app, a.client.id, { due_date: "2020-03-01" })).json as Invoice;

  const asDraft = await api(app, `invoices/${inv.id}/chase`, { method: "POST" });
  assert.equal(asDraft.status, 409, "chasing a draft is chasing something the client has never seen");

  await api(app, `invoices/${inv.id}/status`, { method: "POST", body: JSON.stringify({ to: "sent" }) });
  const chase = await api(app, `invoices/${inv.id}/chase`, { method: "POST" });
  assert.equal(chase.status, 201, chase.text);
  const task = (await api(app, `tasks/${chase.json.task_id}`)).json;
  assert.equal(task.wedge, "invoice-chaser");
  assert.equal(task.task_type, "chase_invoice");
  assert.equal(task.client_id, a.client.id);
  assert.equal(task.input.invoice_id, inv.id);
  assert.equal(task.input.amount_due, 54_000, "minor units, never divided");
  assert.equal(task.input.currency, "USD");
  assert.equal(task.input.partially_paid, false);
  assert.ok(task.input.days_overdue > 1000, "derived from the stored due date, not from a human's arithmetic");

  // Settled: chasing it now is a dunning email about money that is not owed.
  await api(app, `invoices/${inv.id}/payments`, { method: "POST", body: JSON.stringify({ amount_minor: 54_000 }) });
  const paid = await api(app, `invoices/${inv.id}/chase`, { method: "POST" });
  assert.equal(paid.status, 409);
  assert.equal(paid.json.code, "invoice.not_chaseable");
});

test("daysBetween is integer arithmetic on UTC midnights", async () => {
  // A Date-typed column parsed at LOCAL midnight is one timezone away from reporting an invoice
  // overdue a day early — which is a dunning email a customer did not deserve.
  assert.equal(daysBetween("2024-03-01", "2024-03-31"), 30);
  assert.equal(daysBetween("2024-03-31", "2024-03-01"), -30, "and signed, so the caller clamps deliberately");
  assert.equal(daysBetween("2024-10-25", "2024-10-30"), 5, "across a DST boundary");
  assert.equal(daysBetween("nonsense", "2024-01-01"), 0);
});

test("invoices: rails are project-scoped and travel on the by-id read", async () => {
  const { app, a } = await world();
  const put = await api(app, "payments/rails", {
    method: "PUT",
    body: JSON.stringify({
      rails: [{ kind: "bank_transfer", enabled: true, lines: ["Sort code 04-00-04", "Account 12345678"] }],
      currency: "GBP",
      seller: { address: ["14 Harbour Lane"], company_number: "12345678" },
    }),
  });
  assert.equal(put.status, 200);
  assert.equal(put.json.currency, "GBP");
  assert.equal(put.json.seller.company_number, "12345678");

  const got = await api(app, "payments/rails");
  assert.equal(got.status, 200);
  assert.equal(got.json.rails.find((r: { kind: string }) => r.kind === "bank_transfer").enabled, true);

  const inv = (await draft(app, a.client.id, { currency: "GBP" })).json as Invoice;
  const one = await api(app, `invoices/${inv.id}`);
  assert.equal(one.status, 200);
  assert.equal(one.json.seller.company_number, "12345678");
  assert.match(one.json.how_to_pay.missing ?? one.json.how_to_pay.blocks[0]?.heading ?? "", /bank transfer|cannot show a way to pay/i);
  // A draft with bank details should still print them — the card link is the one that waits for issue.
  assert.ok(one.json.how_to_pay.blocks.some((b: { kind: string }) => b.kind === "bank_transfer"));
});

test("invoices: issuing generates a checkout from integer minor units when Stripe is on", async () => {
  const { app, projectId, a } = await world();
  await api(app, "payments/rails", {
    method: "PUT",
    body: JSON.stringify({ rails: [{ kind: "stripe", enabled: true, lines: [] }], currency: "GBP" }),
  });
  const payloads: Record<string, unknown>[] = [];
  setCheckoutDeps({
    listConnections: async () => [
      {
        id: "conn-stripe",
        project_id: projectId,
        kind: "composio",
        name: "Stripe",
        owner: { kind: "founder", id: "founder" },
        config: { toolkit: "stripe", verified_at: "2026-03-01T00:00:00Z" },
        created_at: "2026-03-01T00:00:00Z",
      },
    ],
    execute: async (_c, _t, p) => {
      payloads.push(p);
      return { ok: true, data: { url: "https://checkout.stripe.com/c/pay/cs_test_issue" } };
    },
    publicUrl: () => "https://app.example",
  });
  try {
    const inv = (await draft(app, a.client.id, { currency: "GBP" })).json as Invoice;
    const sent = await api(app, `invoices/${inv.id}/status`, { method: "POST", body: JSON.stringify({ to: "sent" }) });
    assert.equal(sent.status, 200);
    assert.equal(sent.json.payment_link_url, "https://checkout.stripe.com/c/pay/cs_test_issue");
    const items = payloads[0]?.line_items as { price_data: { unit_amount: number } }[];
    assert.equal(items[0]?.price_data.unit_amount, 54_000);
    assert.equal(Number.isSafeInteger(items[0]?.price_data.unit_amount), true);
  } finally {
    setCheckoutDeps({
      listConnections: async () => [],
      execute: async () => ({ ok: false, detail: "no stripe in this test" }),
      publicUrl: () => "https://app.example",
    });
  }
});

test("portal: how_to_pay is on the detail, never the list, and never on a draft", async () => {
  const { app, a } = await world();
  await api(app, "payments/rails", {
    method: "PUT",
    body: JSON.stringify({
      rails: [{ kind: "bank_transfer", enabled: true, lines: ["Sort code 04-00-04"] }],
    }),
  });
  const inv = (await draft(app, a.client.id, { due_date: "2030-01-01" })).json as Invoice;
  assert.equal((await api(app, `portal/invoices/${inv.id}`, { headers: a.h })).status, 404);

  await api(app, `invoices/${inv.id}/status`, { method: "POST", body: JSON.stringify({ to: "sent" }) });
  const list = await api(app, "portal/invoices", { headers: a.h });
  assert.equal(list.status, 200);
  assert.equal(list.json[0]?.how_to_pay, undefined, "bank details do not belong on every row of a table");

  const detail = await api(app, `portal/invoices/${inv.id}`, { headers: a.h });
  assert.equal(detail.status, 200);
  assert.ok(detail.json.how_to_pay.blocks.some((b: { kind: string }) => b.kind === "bank_transfer"));
  assert.ok(detail.json.payment_instructions.some((l: string) => /04-00-04/.test(l)));
});
