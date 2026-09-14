/**
 * graphile-worker job lock release under process termination.
 *
 * Requirement: kill the kernel mid-invoice-chase; on restart the job must unlock/retry WITHOUT
 * sending a duplicate email. Two independent guarantees:
 *
 *   1. `maxAttempts: 1` on enqueue — graphile-worker will NOT auto-retry a crashed job, so a
 *      half-finished chase cannot fire a second email on its own.
 *   2. `recoverTasks` marks the run `failed`, emits `task.finished`, and releases the chase claim
 *      (`last_chased_at`) — so the founder can re-chase without waiting out the ladder, and without
 *      the stamp pretending a client was already contacted.
 *
 * waits.ts exactly-once covers the resume path; this covers the process-kill path that never
 * reaches `runTask`'s catch.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryStore } from "../src/store";
import { recoverTasks } from "../src/recovery";
import { getBillingStore, initBillingStore, _resetBilling } from "../src/billing";
import { releaseChaseClaim } from "../src/dunning";
import type { Task } from "../src/contract";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

test("queue: maxAttempts is 1 — a crashed chase is never auto-retried by the worker", () => {
  // THE DUPLICATE-EMAIL GUARD. Retries belong to the founder; silently re-running a chase that may
  // already have reached awaitApproval would send twice.
  const queue = readFileSync(join(SRC, "queue.ts"), "utf8");
  assert.match(queue, /maxAttempts:\s*1/);
  assert.match(queue, /jobKey:\s*taskId/);
});

test("boot imports dunning before recoverTasks so chase claims can be released", () => {
  const index = readFileSync(join(SRC, "index.ts"), "utf8");
  const dunningAt = index.indexOf('import "./dunning"');
  /**
   * `recoverTasks(` — the call, not its arguments, and TWICE now for the same reason.
   *
   * This first matched the full old call text and broke when recovery gained a second parameter.
   * The replacement, `recoverTasks(store`, broke again the moment the call went multi-line to take
   * a third — `indexOf` returned -1 and this failed while the invariant it guards was perfectly
   * true, which is the most expensive kind of red.
   *
   * The invariant is about ORDER, not formatting: the dunning side-effect import registers claim
   * release, and that has to happen before crash recovery runs. Matching the shortest thing that
   * identifies the call site is the version of that which survives an argument list changing again.
   */
  const recoverAt = index.indexOf("recoverTasks(");
  assert.ok(dunningAt >= 0, "dunning must be side-effect imported at boot");
  assert.ok(recoverAt > dunningAt, "claim release registration must precede crash recovery");
});

test("kill mid-chase: recoverTasks fails the run, unlocks the claim, does not re-send", async () => {
  // Simulate: startChase stamped the claim, worker was mid-run, process died. On boot, recovery.
  await initBillingStore();
  _resetBilling();
  const billing = getBillingStore();
  const inv = await billing.createInvoice({
    project_id: "proj-kill",
    client_id: "c1",
    currency: "USD",
    status: "sent",
    due_date: "2020-01-01",
    issue_date: "2019-12-01",
    number: "INV-KILL",
    lines: [{ id: "l1", description: "w", kind: "fixed", quantity_milli: 1000, unit_amount: 480_000 }],
  } as never);

  const claimedAt = "2026-08-11T00:00:00.000Z";
  await billing.claimInvoiceForChase(inv.id, "1999-01-01T00:00:00.000Z", claimedAt);
  assert.equal((await billing.getInvoice(inv.id))!.last_chased_at, claimedAt);

  const store = new InMemoryStore();
  /*
    Backdated: this is a run KILLED mid-chase, so by the time anything reclaims it the row has been
    sitting. `listUnfinished()` only returns rows untouched for `STALE_TASK_MS`, and a fixture
    stamped `now()` describes a healthy run rather than the one this test is named for. It passed
    only because the memory store had no default for `staleAfterMs` while Postgres defaulted to ten
    minutes — the divergence that had the reaper cancelling live runs.
  */
  const at = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const task: Task = {
    id: "t-killed-chase",
    project_id: "proj-kill",
    wedge: "invoice-chaser",
    task_type: "chase_invoice",
    actor: { kind: "system", id: "kernel" },
    input: {
      invoice_id: inv.id,
      chase_claim: { claimed_at: claimedAt, previously_chased_at: null },
    },
    constraints: { max_cost_usd: 0.5, max_runtime_s: 240, approval_required: true },
    tools: [],
    source: "schedule",
    status: "running",
    cost_usd: 0.002,
    created_at: at,
    updated_at: at,
  } as Task;
  await store.createTask(task);

  const n = await recoverTasks(store);
  assert.equal(n.total, 1);
  assert.equal(n.failed, 1, "a run that was mid-flight is a loss, not a requeue");

  const row = await store.getTask(task.id);
  assert.equal(row?.status, "failed");
  assert.match(row!.error!, /Interrupted by a kernel restart/i);

  const events = await store.eventsAfter(task.id, 0);
  const finished = events.find((e) => e.type === "task.finished");
  assert.equal(finished?.data?.status, "failed");
  assert.ok(
    events.some((e) => e.type === "progress" && /back on your list/.test(String(e.data?.note ?? ""))),
    "founder feed must say the invoice was put back — otherwise the unlock is invisible",
  );

  // THE NO-DUPLICATE HALF: claim released, so a human retry can take it. Auto-retry cannot, because
  // maxAttempts is 1 and the job is already terminal in the task store.
  assert.equal(
    (await billing.getInvoice(inv.id))!.last_chased_at,
    undefined,
    "killed mid-chase left the invoice stamped as chased — a client would never be re-proposed",
  );

  // A second recovery must not invent a second release / second email path.
  assert.deepEqual(await recoverTasks(store), { requeued: 0, rejoined: 0, failed: 0, total: 0 });
  assert.equal(await releaseChaseClaim(task), undefined, "already released; a second unlock is a no-op");
});
