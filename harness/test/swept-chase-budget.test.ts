// The two doors onto a dunning chase must produce the same run.
//
// ─── THE DRIFT THIS PINS ───
//
// `startChase` was extracted precisely so that a chase started by hand and a chase spawned by the
// hourly sweep could not diverge — same input, same claim, same document, same refusals. One field
// still did: `constraints`.
//
// `POST /v1/tasks` clamps against the wedge and the task type, so a hand-started `chase_invoice`
// resolves the `decide` profile's 240 seconds and $0.50. `spawnKernelTask` — the closure BEHIND the
// sweep, the nudge carrier and every wait resume — called `clampConstraints({}, ceiling, ceiling)`
// with neither, which falls through to `profileConstraintDefaults(null, "")`: the permissive
// `general` shape, 600 seconds and $2. Cost is re-clamped inside the runtime; RUNTIME IS NOT.
//
// It is asserted here rather than left as a comment because it is on the same path as the
// `invoice-chaser` runs found `failed` at `$0.00` in production. The sweep spawns up to 25 chases in
// one tick against a worker concurrency of 4; giving each of them two and a half times the deadline
// keeps the tail of the batch sitting in `queued` for longer, and anything still non-terminal after
// ten minutes is reclaimed as `failed` by the next deploy — having never run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { api, connectMailbox, makeFreshApp } from "./helpers";
import { getBillingStore } from "../src/billing";
import { setChaseDeps, startChase } from "../src/dunning";
import { loadWedge } from "../src/wedge";
import { profileConstraintDefaults } from "../src/harness";

test("a swept chase gets the same budget as one started by hand", async () => {
  const { store, app } = await makeFreshApp();

  // The project the API key can write to, from the kernel's own answer rather than a guess.
  const me = await api(app, "me");
  const project = me.json.projects[0].id as string;

  const client = await api(app, "clients", {
    method: "POST",
    body: JSON.stringify({ display_name: "Rowan & Fell", handles: ["ap@rowanfell.example"] }),
    headers: { "x-mycel-project": project },
  });
  assert.equal(client.status, 201, client.text);

  // A chase is refused before it claims anything when the business has no mailbox — see
  // `connectMailbox` and promises.ts. This scene is about the run's BUDGET, so it needs a run.
  await connectMailbox(project);

  const invoice = await getBillingStore().createInvoice({
    project_id: project,
    client_id: client.json.id,
    currency: "GBP",
    status: "sent",
    // Integer minor units, and nothing here divides by 100.
    lines: [{ id: "l1", description: "March close", kind: "fixed", quantity_milli: 1000, unit_amount: 48_000 }],
    due_date: "2020-01-01",
    issue_date: "2019-12-01",
    number: `INV-${randomUUID().slice(0, 6)}`,
  } as never);

  // The real `ChaseDeps` the server registered on mount, so this spawns through the real
  // `spawnKernelTask` rather than through a stub that would prove only that the stub works.
  const started = await startChase(invoice, { pacing: "override" });
  assert.equal(started.ok, true, started.ok ? "" : started.message);

  const task = await store.getTask(started.ok ? started.task_id : "");
  assert.ok(task, "the chase must exist as a task row");

  // What `POST /v1/tasks` would have resolved for exactly this work.
  const expected = profileConstraintDefaults(loadWedge("invoice-chaser"), "chase_invoice", {
    maxRuntimeS: 10_000,
    maxCostUsd: 100,
  });
  assert.equal(task!.constraints.max_runtime_s, expected.max_runtime_s);
  assert.equal(task!.constraints.max_cost_usd, expected.max_cost_usd);

  // And specifically NOT the `general` fallback the missing arguments used to select.
  const general = profileConstraintDefaults(null, "", { maxRuntimeS: 10_000, maxCostUsd: 100 });
  assert.notEqual(
    task!.constraints.max_runtime_s,
    general.max_runtime_s,
    "the sweep is back on the permissive general profile",
  );
});

test("a chase whose invoice could not be attached does not report a clean success", async () => {
  /**
   * THE BUG: `startChase` attached the invoice PDF with `.catch(() => undefined)` and returned
   * `{ok: true, document: null}` regardless. A chase that went out with nothing enclosed was
   * byte-identical to a complete one, and `document: null` told two different stories in the same
   * three characters — "this deployment renders no PDFs" and "the brand kit belongs to another
   * tenant and rendering was REFUSED". The only signal anybody ever got was the client asking where
   * the invoice was.
   *
   * The run still STARTS — the chase is the point, the PDF is an enclosure — but the reason travels
   * with it now, and the sweep counts it.
   */
  const { store: _store, app } = await makeFreshApp();
  const me = await api(app, "me");
  const project = me.json.projects[0].id as string;
  const client = await api(app, "clients", {
    method: "POST",
    body: JSON.stringify({ display_name: "Brand Kit Refuser", handles: ["ap@refuser.example"] }),
    headers: { "x-mycel-project": project },
  });
  await connectMailbox(project);
  const invoice = await getBillingStore().createInvoice({
    project_id: project,
    client_id: client.json.id,
    currency: "GBP",
    status: "sent",
    lines: [{ id: "l1", description: "April close", kind: "fixed", quantity_milli: 1000, unit_amount: 48_000 }],
    due_date: "2020-01-01",
    issue_date: "2019-12-01",
    number: `INV-${randomUUID().slice(0, 6)}`,
  } as never);

  // Exactly the production shape: the render is refused, everything else is healthy.
  const real = { spawned: [] as string[] };
  setChaseDeps({
    wedgeEnabled: () => true,
    spawnTask: async () => {
      const id = randomUUID();
      real.spawned.push(id);
      return id;
    },
    attachInvoiceDocument: async () => {
      throw new Error("brand kit belongs to another project");
    },
  });
  try {
    const started = await startChase(invoice, { pacing: "override" });
    assert.equal(started.ok, true, "the chase still starts — the enclosure is not the chase");
    assert.ok(started.ok && started.document_error, "…but WHY there is no invoice is carried out with it");
    assert.match(
      (started.ok && started.document_error) || "",
      /brand kit/,
      "and it is the real reason, not a shrug — 'no brand kit' must not read like 'refused'",
    );
  } finally {
    setChaseDeps(null);
  }
});
