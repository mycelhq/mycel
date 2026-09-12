// Invoice chase closed loop: after approve, park pay-OR-date; sweep skips parked invoices.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { api, makeFreshApp } from "./helpers";
import { getDomainStore } from "../src/domain";
import { getBillingStore } from "../src/billing";
import {
  CHASE_TASK_TYPE,
  isInvoiceChaseParked,
  parkAfterChaseSend,
  setChaseDeps,
} from "../src/dunning";
import { setWaitDeps } from "../src/waits";

const WEDGE = "invoice-chaser";

async function arEngagement() {
  const { app } = await makeFreshApp();
  const me = (await api(app, "me")).json;
  const projectId = me.projects[0].id as string;
  // Enable the dunning wedge so a resumed chase is a known task type.
  await api(app, `projects/${projectId}`, {
    method: "PUT",
    body: JSON.stringify({ wedges: [WEDGE] }),
  }).catch(() => null);
  const client = (
    await api(app, "clients", {
      method: "POST",
      body: JSON.stringify({
        display_name: "Acme",
        handles: [`acme-${randomUUID()}@x.test`],
      }),
    })
  ).json;
  const kase = (
    await api(app, "cases", {
      method: "POST",
      body: JSON.stringify({ wedge: WEDGE, title: "AR Acme", client_id: client.id }),
    })
  ).json;
  return { app, projectId, client, kase, domain: getDomainStore() };
}

test("parkAfterChaseSend arms pay-or-date wait; isInvoiceChaseParked sees it", async () => {
  const { projectId, client, kase, domain } = await arEngagement();
  const billing = getBillingStore();
  const inv = await billing.createInvoice({
    project_id: projectId,
    client_id: client.id,
    case_id: kase.id,
    currency: "USD",
    lines: [{ description: "Work", kind: "fixed", amount: 4800_00 }],
    status: "sent",
    issue_date: "2026-07-01",
    due_date: "2026-07-15",
  } as never);

  setWaitDeps({
    spawnTask: async () => "task-resume",
    wedgeEnabled: () => true,
  });
  setChaseDeps({
    wedgeEnabled: () => true,
    spawnTask: async () => "task-chase",
    attachInvoiceDocument: async () => null,
  });

  assert.equal(await isInvoiceChaseParked(projectId, inv.id), false);

  await parkAfterChaseSend({
    id: "t1",
    project_id: projectId,
    case_id: kase.id,
    task_type: CHASE_TASK_TYPE,
    input: { invoice_id: inv.id },
  });

  assert.equal(await isInvoiceChaseParked(projectId, inv.id), true);

  const waits = await domain.listWaits({ project_id: projectId, status: "waiting" });
  assert.equal(waits.length, 1);
  assert.equal(waits[0].mode, "any");
  assert.ok(waits[0].conditions.some((c) => c.kind === "invoice_paid" && c.invoice_id === inv.id));
  assert.ok(waits[0].conditions.some((c) => c.kind === "date"));
  assert.equal(waits[0].resume.task_type, CHASE_TASK_TYPE);

  // Second park is a no-op (idempotent).
  await parkAfterChaseSend({
    project_id: projectId,
    case_id: kase.id,
    task_type: CHASE_TASK_TYPE,
    input: { invoice_id: inv.id },
  });
  assert.equal((await domain.listWaits({ project_id: projectId, status: "waiting" })).length, 1);
});
