// What a chase run is TOLD, pinned against the two bugs that made the invoice-chaser mute.
//
// ─── THE PRODUCTION EVIDENCE (holy-grail run 1, evals/product/HOLY-GRAIL-RUN-1.md) ───
//
// Four simulated weeks of a collections business against a real memory-store kernel delivered
// ZERO dunning emails to $3,650 of overdue debt, and the whole month is explained by two facts
// about the chase run's INPUT, both asserted here:
//
//   1. SELF-POISONING. `InMemoryBillingStore.claimInvoiceForChase` mutates the very object the
//      caller holds, and `chaseTaskInput` was called after the claim — so every input said
//      `last_chased_days_ago: 0` (chased zero days ago, by this very run) and the wedge's own 48h
//      `next_step` rule answered `hold` on a 5-day and a 47-day overdue invoice alike. Verbatim:
//      "it was last chased 0 days ago, so it must not be chased again within 48 hours".
//
//   2. NO RECIPIENT. The input carried the debt — amounts, dates, `how_to_pay` — and nothing about
//      who to write to, while the client row's `handles` held the address the whole time. Verbatim:
//      "Draft not sent: client email address and payment instructions are unavailable."
//
// These run against the memory store on purpose: the Postgres claim returns a fresh row and would
// hide bug 1, and the memory store is exactly what demo, e2e and the eval harness boot.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { api, connectMailbox, makeFreshApp } from "./helpers";
import { getBillingStore } from "../src/billing";
import { chaseTaskInput, clientEmailHandle, startChase } from "../src/dunning";

async function seed(app: any, project: string, handles: string[]) {
  const client = await api(app, "clients", {
    method: "POST",
    body: JSON.stringify({ display_name: "Quill & Stone", handles }),
    headers: { "x-mycel-project": project },
  });
  assert.equal(client.status, 201, client.text);
  const invoice = await getBillingStore().createInvoice({
    project_id: project,
    client_id: client.json.id,
    currency: "USD",
    status: "sent",
    lines: [{ id: "l1", description: "Monthly close", kind: "fixed", quantity_milli: 1000, unit_amount: 95_000 }],
    issue_date: "2026-07-01",
    due_date: "2026-08-01", // days overdue at test time, never zero
    number: `INV-${randomUUID().slice(0, 6)}`,
  } as never);
  return { clientId: client.json.id as string, invoice };
}

test("a never-chased invoice's chase input survives its own claim: last_chased_days_ago stays absent, not 0", async () => {
  const { store, app } = await makeFreshApp();
  const me = await api(app, "me");
  const project = me.json.projects[0].id as string;
  await connectMailbox(project);
  const { invoice } = await seed(app, project, ["ap@quillandstone.example"]);

  const started = await startChase(invoice, { pacing: "override" });
  assert.equal(started.ok, true, started.ok ? "" : started.message);

  // The claim DID stamp the row — that is the memory-store mutation this test exists around. If
  // this assertion ever fails, the store changed shape and the pin below is no longer proving much.
  const stamped = await getBillingStore().getInvoice(invoice.id);
  assert.ok(stamped?.last_chased_at, "the claim must stamp last_chased_at");

  // …and the RUN'S INPUT must not have seen the stamp. This is holy-grail run 1's breakage 1: an
  // input built from the mutated row says "chased 0 days ago" and the agent's 48h rule holds
  // every chase forever.
  const task = await store.getTask(started.ok ? started.task_id : "");
  assert.ok(task, "the chase must exist as a task row");
  assert.equal(
    task!.input.last_chased_days_ago,
    undefined,
    `a never-chased invoice must not report last_chased_days_ago (got ${JSON.stringify(task!.input.last_chased_days_ago)}) — the claim stamp leaked into the input`,
  );
  const claim = task!.input.chase_claim as { previously_chased_at?: unknown };
  assert.equal(claim.previously_chased_at, null, "the claim receipt must record that nothing preceded it");
});

test("a previously chased invoice reports the REAL gap, not zero", async () => {
  const { store, app } = await makeFreshApp();
  const me = await api(app, "me");
  const project = me.json.projects[0].id as string;
  await connectMailbox(project);
  const { invoice } = await seed(app, project, ["ap@quillandstone.example"]);

  // Chased ten days ago — well outside every rung's interval, so the ladder itself would allow it.
  const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();
  await getBillingStore().updateInvoice(invoice.id, { last_chased_at: tenDaysAgo } as never);
  const fresh = await getBillingStore().getInvoice(invoice.id);

  // `override`, because on a business with no payment provider the LADDER first asks the founder
  // whether an escalation's invoice was already paid (`awaiting_payment_answer`) — correct, and not
  // this test's subject. The override door builds its input through the identical snapshot path.
  const started = await startChase(fresh!, { pacing: "override" });
  assert.equal(started.ok, true, started.ok ? "" : started.message);
  const task = await store.getTask(started.ok ? started.task_id : "");
  const days = task!.input.last_chased_days_ago as number;
  assert.ok(days >= 9 && days <= 11, `expected ~10 days since the last chase, got ${days}`);
});

test("the chase input names the recipient the client row already knows", async () => {
  const { store, app } = await makeFreshApp();
  const me = await api(app, "me");
  const project = me.json.projects[0].id as string;
  await connectMailbox(project);
  const { invoice } = await seed(app, project, ["ap@quillandstone.example", "+15550100"]);

  const started = await startChase(invoice, { pacing: "override" });
  assert.equal(started.ok, true, started.ok ? "" : started.message);
  const task = await store.getTask(started.ok ? started.task_id : "");
  const client = task!.input.client as { name?: string; email?: string; email_missing?: string };
  assert.ok(client, "the chase input must carry the recipient — holy-grail run 1, breakage 2");
  assert.equal(client.email, "ap@quillandstone.example");
  assert.equal(client.name, "Quill & Stone");
  assert.equal(client.email_missing, undefined);
});

test("a client with no email handle is reported as ACTIONABLY missing, never invented", async () => {
  const { store, app } = await makeFreshApp();
  const me = await api(app, "me");
  const project = me.json.projects[0].id as string;
  await connectMailbox(project);
  // A phone handle only — a real shape (a client onboarded from a call), not an empty row.
  const { invoice } = await seed(app, project, ["+15550100"]);

  const started = await startChase(invoice, { pacing: "override" });
  assert.equal(started.ok, true, started.ok ? "" : started.message);
  const task = await store.getTask(started.ok ? started.task_id : "");
  const client = task!.input.client as { name?: string; email?: string; email_missing?: string };
  assert.ok(client, "the client block must still be present so the absence is visible");
  assert.equal(client.email, undefined, "an absent email must stay absent — never guessed");
  assert.match(
    client.email_missing ?? "",
    /add the client's email/,
    "the absence must point the agent at the founder's one-click fix",
  );
});

test("chaseTaskInput and clientEmailHandle are honest about handles that are not emails", () => {
  assert.equal(clientEmailHandle({ handles: ["+15550100", "slack:U123"] }), undefined);
  assert.equal(clientEmailHandle({ handles: ["+1555", "ap@x.example"] }), "ap@x.example");
  // No client argument at all (the moves preview path): the field is simply absent, not a husk.
  const input = chaseTaskInput(
    { id: "i", project_id: "p", currency: "USD", lines: [], due_date: "2026-08-01" } as never,
    "2026-08-16",
  );
  assert.equal(input.client, undefined);
});
