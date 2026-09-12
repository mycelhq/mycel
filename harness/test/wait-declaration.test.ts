/**
 * WHY FIFTY-ONE CLIENT ASKS PRODUCED NOTHING.
 *
 * Three task types raised every ask that has ever existed in production:
 *
 *     books-keeper:monthly_close        26 asks, 19 still open
 *     geo-monitor:weekly_report          4 asks,  4 still open
 *     books-keeper:deliverable_verdict   2 asks,  2 still open
 *
 * None declares a `waits_for`. `chase_receipts` — the one job in the repo that does — has raised
 * zero. The wait machinery is complete, correct, and wired to a job nobody runs, while the jobs
 * that do run raise asks nothing can resume. Three asks were ever answered and answering them did
 * nothing either.
 *
 * The `no-self-resume` authoring rule is right and stays: asking is a stage, and a job that resumes
 * itself re-asks the question the client just answered. What the manifest did not anticipate is that
 * `monthly_close` is the SCHEDULED job — it runs first, discovers the bank statement is missing
 * halfway through, and raises the ask itself.
 *
 * So the resume falls back to the one the author declared INTO this job. `chase_receipts` says
 * "when a client answers a chase, resume monthly_close". A `monthly_close` run raising that same ask
 * wants that same resume. This reads stated intent; it does not invent a rule.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { declaredWaitFor, deadAskWarning } from "../src/wait-declaration.ts";
import { loadWedge } from "../src/wedge.ts";

const w = (m: unknown) => m as Parameters<typeof declaredWaitFor>[0];

test("a job's own declaration wins", () => {
  const m = w({
    task_types: {
      chase_receipts: { waits_for: { on: "client_request", resume: "monthly_close", reason: "r" } },
      monthly_close: {},
    },
  });
  const d = declaredWaitFor(m, "chase_receipts");
  assert.equal(d?.spec.resume, "monthly_close");
  assert.equal(d?.inheritedFrom, undefined, "its own declaration must not be reported as inherited");
});

test("a job with none inherits the resume declared INTO it", () => {
  const m = w({
    task_types: {
      chase_receipts: { waits_for: { on: "client_request", resume: "monthly_close", reason: "blocked on paperwork" } },
      monthly_close: {},
    },
  });
  const d = declaredWaitFor(m, "monthly_close");
  assert.equal(d?.spec.resume, "monthly_close");
  assert.equal(d?.inheritedFrom, "chase_receipts");
  assert.equal(d?.spec.reason, "blocked on paperwork");
});

test("real books-keeper: monthly_close can now park", () => {
  // The actual manifest, not a fixture. This is the case that costs nineteen open asks.
  const bk = loadWedge("books-keeper");
  assert.ok(bk, "books-keeper did not load");
  assert.equal(bk!.manifest.task_types?.monthly_close?.waits_for, undefined, "the premise changed");
  const d = declaredWaitFor(bk!.manifest, "monthly_close");
  assert.equal(d?.spec.resume, "monthly_close");
  assert.equal(d?.inheritedFrom, "chase_receipts");
});

test("a job nobody declared a resume into still gets nothing", () => {
  // The fallback is narrow ON PURPOSE. It can only ever resume a job the author already named as a
  // resume target, so it cannot conjure a flow out of a manifest that describes none.
  const m = w({ task_types: { weekly_report: {}, ship_page: {} } });
  assert.equal(declaredWaitFor(m, "weekly_report"), undefined);
  assert.equal(declaredWaitFor(undefined, "weekly_report"), undefined);
});

test("only a sibling naming THIS job is borrowed", () => {
  // The narrowness is the safety. Borrowing any sibling's `waits_for` would give `file_sales_tax` a
  // resume into `monthly_close` because some unrelated job declared one — a run spawned on the
  // strength of a sentence written about different work.
  const m = w({
    task_types: {
      chase_receipts: { waits_for: { on: "client_request", resume: "monthly_close", reason: "r" } },
      monthly_close: {},
      file_sales_tax: {},
    },
  });
  assert.equal(declaredWaitFor(m, "monthly_close")?.inheritedFrom, "chase_receipts");
  assert.equal(
    declaredWaitFor(m, "file_sales_tax"),
    undefined,
    "an unrelated job inherited a resume written for another one",
  );
});

test("a non-client_request declaration is not borrowed", () => {
  const m = w({
    task_types: {
      a: { waits_for: { on: "something_else", resume: "b", reason: "r" } },
      b: {},
    },
  });
  assert.equal(declaredWaitFor(m, "b"), undefined);
});

test("several candidates resolve the same way on every kernel", () => {
  const m = w({
    task_types: {
      zeta: { waits_for: { on: "client_request", resume: "work", reason: "z" } },
      alpha: { waits_for: { on: "client_request", resume: "work", reason: "a" } },
      work: {},
    },
  });
  assert.equal(declaredWaitFor(m, "work")?.inheritedFrom, "alpha", "the pick must be deterministic");
});

test("the dead-ask warning names the job and the remedy", () => {
  const msg = deadAskWarning("geo-monitor", "weekly_report", "Your most recent bank statement");
  assert.match(msg, /geo-monitor:weekly_report/);
  assert.match(msg, /answering it will start nothing/);
  assert.match(msg, /waits_for/, "a warning that does not say what to do is a warning nobody acts on");
});

test("both arm sites consult the declaration, and the dead ask is said out loud", () => {
  for (const f of ["../src/server.ts", "../src/kickoff.ts"]) {
    const src = readFileSync(new URL(f, import.meta.url), "utf8");
    assert.match(src, /declaredBy: \(w, t\) => declaredWaitFor\(loadWedge\(w\)\?\.manifest, t\)\?\.spec,/,
      `${f} reads the raw manifest entry again — the fallback is bypassed`);
  }
  const server = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  assert.match(server, /console\.warn\(deadAskWarning\(/, "a dead ask is silent again");
});
