// Upkeep — that the sweeps this kernel ships actually have a clock.
//
// THE BUG THIS FILE EXISTS FOR. Three complete, tested, documented sweeps had zero callers repo-wide:
// `ensureNudgeSchedule`, `ensureDunningSchedule` and `ensurePaymentSyncSchedule`. Each creates the
// Schedule row that `claimDueSchedules` fires. With no caller there is no row, so the sweep never
// runs — while every unit test over the sweep's own logic passed. Something failing while reporting
// success, which is this repo's most expensive bug shape, applied to the machinery of the product's
// central claim.
//
// Two of the three existed for SOME businesses by accident: `blueprints/invoice-chaser.json`
// declares schedules with those task types, so whether the kernel watched your money depended on
// which tile you clicked during onboarding. A bookkeeper and a contract desk both raise invoices,
// both get paid late, and both got nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { api, freshProjectId, makeFreshApp } from "./helpers";
import { getDomainStore } from "../src/domain";
import { _resetBilling } from "../src/billing";
import { _resetPortal } from "../src/portal";
import { _resetRequests } from "../src/requests";
import { ensureUpkeep, projectFacts } from "../src/upkeep";
import { _resetWedgeRoleIndex } from "../src/roles";
import { _resetWedgeDeclarations } from "../src/wedge";
import { CHASE_SWEEP_TASK_TYPE } from "../src/dunning";
import { PAYMENT_SYNC_TASK_TYPE } from "../src/payments";
import { NUDGE_SWEEP_TASK_TYPE } from "../src/nudges";

const SRC = join(process.cwd(), "harness/src");

/** Every `.ts` under `harness/src`, including the subtrees (`gtm/`, `linkedin/`, …). */
function sources(dir: string = SRC): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...sources(join(dir, e.name)));
    else if (e.name.endsWith(".ts")) out.push(join(dir, e.name));
  }
  return out;
}

/**
 * ═══ THE HEADLINE GUARD ═══
 *
 * A sweep is two halves: the logic, and the thing that turns it on. This repo tests the first half
 * exhaustively and had tested the second half nowhere, which is how three of them shipped inert.
 *
 * So: find every `ensure…Schedule` the kernel exports, and demand that PRODUCTION code somewhere
 * calls it. A test-only caller does not count — `ensurePaymentSyncSchedule` had exactly one, in
 * payments.test.ts, asserting that it throws on an empty project id. That test passed for months
 * over a function nothing in the running product ever invoked, and it is the single clearest reason
 * this check reads `src/` and ignores `test/`.
 *
 * Comments do not count either, and that is not pedantry: waits.ts, dunning.ts and nudges.ts each
 * say "Modelled on `ensureXSchedule`" in prose, so a naive grep finds "callers" for every one of
 * them and the guard passes while the product is broken.
 */
test("every ensure…Schedule sweep has a caller in production code (a sweep with no clock never runs)", () => {
  const files = sources();
  const decl = /export async function (ensure\w*Schedule)\b/g;

  /** Strip block and line comments, so prose that names a function is not mistaken for a call. */
  const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  const declared: { fn: string; file: string }[] = [];
  for (const f of files) {
    for (const m of readFileSync(f, "utf8").matchAll(decl)) declared.push({ fn: m[1], file: f });
  }
  assert.ok(
    declared.length >= 5,
    `expected the kernel's sweep-schedulers to be found; got ${declared.length}. If this dropped, the ` +
      `regex stopped matching and this guard has quietly stopped guarding.`,
  );

  const bodies = new Map(files.map((f) => [f, code(readFileSync(f, "utf8"))]));
  const orphans: string[] = [];
  for (const { fn, file } of declared) {
    // A CALL, not a mention: the name followed by `(`. Counted across every source file including
    // its own — `ensureImprovementSchedules` in server.ts legitimately calls its neighbours.
    const call = new RegExp(`\\b${fn}\\s*\\(`);
    const called = [...bodies].some(([f, body]) => {
      const stripped = f === file ? body.replace(new RegExp(`export async function ${fn}\\s*\\(`), "") : body;
      return call.test(stripped);
    });
    if (!called) orphans.push(`${fn} (declared in ${file.slice(SRC.length + 1)})`);
  }

  assert.deepEqual(
    orphans,
    [],
    `these sweeps are declared, tested and never turned on — a Schedule row is never written, so ` +
      `claimDueSchedules finds nothing and the sweep never fires:\n  · ${orphans.join("\n  · ")}`,
  );
});

// ── scheduled work follows from what the project DOES ────────────────────────────────────────────

const LINE = { description: "Bookkeeping, March", kind: "fixed", unit_amount: 45_000, tax_bps: 2000 };

/**
 * A project with NO schedules yet.
 *
 * `makeFreshApp` and not `makeApp`, and the difference is the whole reason three tests in this file
 * were failing. The domain store is a process-wide singleton, so Schedule rows written by one test
 * survive into the next, and the org's default project id is stable across `makeApp()` calls — so
 * the second test in the file opened on a project that the FIRST test had already put a dunning
 * clock on. Every assertion of the form "this fact, and only this fact, turned that clock on"
 * silently became order-dependent. Re-initialising the domain is the only way to assert an absence.
 */
async function world() {
  _resetBilling();
  _resetPortal();
  _resetRequests();
  const { app } = await makeFreshApp();
  const projectId = (await api(app, "me")).json.projects[0].id as string;
  const domain = getDomainStore();
  const client = await domain.createClient({
    project_id: projectId, display_name: "acme", handles: ["acme@up.test"], metadata: {},
  });
  return { app, projectId, domain, client };
}

const schedulesFor = async (projectId: string) =>
  (await getDomainStore().listSchedules()).filter((s) => s.project_id === projectId).map((s) => s.task_type);

test("raising an invoice is what turns the money clocks on — no blueprint anywhere in it", async () => {
  const { app, projectId, client } = await world();

  assert.deepEqual(await schedulesFor(projectId), [], "a project that has done nothing carries no clocks");
  assert.deepEqual(
    await projectFacts(projectId),
    { raises_invoices: false, asks_clients: false, bills_retainers: false, does_fulfillment: false },
    "and the facts say why",
  );

  const inv = await api(app, "invoices", {
    method: "POST",
    body: JSON.stringify({ client_id: client.id, currency: "USD", lines: [LINE], due_date: "2020-01-01" }),
  });
  assert.equal(inv.status, 201);

  const after = await schedulesFor(projectId);
  assert.ok(
    after.includes(CHASE_SWEEP_TASK_TYPE),
    "THE BUG: dunning existed only where blueprints/invoice-chaser.json had been provisioned, so a " +
      `bookkeeper who raises invoices got no chasing at all. Got: ${after}`,
  );
  // Payment sync is WANTED by the same fact and is not RUNNING here, because this fixture has no
  // connection providing `read_payments`. That is the honest outcome, not a gap: a 15-minute clock
  // that can only ever observe nothing is the "configured feature that does not exist" upkeep.ts
  // refuses. What must be true is that the invoice made it wanted and produced a sentence — the
  // blueprint gate is gone either way. The running case is covered by payments.test.ts, and the
  // blocked case in full by "no read_payments provider" below.
  const report = await ensureUpkeep(getDomainStore(), projectId);
  const sync = report.sweeps.find((s) => s.task_type === PAYMENT_SYNC_TASK_TYPE)!;
  assert.equal(sync.wanted, true, `payment sync was gated behind the same blueprint. Got: ${after}`);
  assert.ok(sync.blocked, "and a wanted sweep that is not running always says why");
  assert.ok(
    !after.includes(NUDGE_SWEEP_TASK_TYPE),
    "and NOT the nudge sweep — this business has asked nobody for anything, and a clock over no work " +
      "is the same kind of lie as no clock over work",
  );
});

test("asking a client for something is what turns the nudge clock on", async () => {
  const { app, projectId, client } = await world();
  const r = await api(app, "requests", {
    method: "POST",
    body: JSON.stringify({ client_id: client.id, ask: "your March bank statement", kind: "document" }),
  });
  assert.equal(r.status, 201);

  const after = await schedulesFor(projectId);
  assert.ok(
    after.includes(NUDGE_SWEEP_TASK_TYPE),
    `ensureNudgeSchedule had ZERO callers repo-wide, so no client was ever reminded of anything. Got: ${after}`,
  );
  assert.ok(!after.includes(CHASE_SWEEP_TASK_TYPE), "this business has raised no invoice, so nothing chases one");
});

test("upkeep is idempotent and project-scoped — the second invoice does not add a second clock", async () => {
  const { app, projectId, domain, client } = await world();
  const body = JSON.stringify({ client_id: client.id, currency: "USD", lines: [LINE] });
  await api(app, "invoices", { method: "POST", body });
  const first = (await domain.listSchedules()).filter((s) => s.project_id === projectId);
  await api(app, "invoices", { method: "POST", body });
  const second = (await domain.listSchedules()).filter((s) => s.project_id === projectId);

  assert.deepEqual(
    second.map((s) => s.id).sort(),
    first.map((s) => s.id).sort(),
    "a Schedule per invoice would mean N sweeps each chasing the same debts — N emails to one client",
  );

  // Scope is REQUIRED, never defaulted. Both of this repo's cross-tenant leaks were a defaulted one.
  await assert.rejects(() => ensureUpkeep(domain, ""), /scoped to a project/);
  await assert.rejects(() => projectFacts(""), /scoped to a project/);

  // A second tenant, addressed the way `ensureUpkeep` is addressed everywhere: by id. Nothing about
  // this project exists in any store, which is the point — upkeep must derive its answer from THAT
  // project's rows, and a leak here would show up as it inheriting the first tenant's clocks.
  const report = await ensureUpkeep(domain, freshProjectId("other-co"));
  assert.deepEqual(
    report.sweeps.filter((s) => s.running).map((s) => s.task_type),
    [],
    "a second tenant that has raised nothing inherits no clock from the first",
  );
});

test("no read_payments provider: the sync is not scheduled, and the founder is told what stops", async () => {
  const { app, projectId, domain, client } = await world();
  await api(app, "invoices", { method: "POST", body: JSON.stringify({ client_id: client.id, lines: [LINE] }) });

  const report = await ensureUpkeep(domain, projectId);
  const sync = report.sweeps.find((s) => s.task_type === PAYMENT_SYNC_TASK_TYPE)!;
  assert.equal(sync.wanted, true, "the business raises invoices, so it wants to know when they are paid");
  assert.equal(sync.running, false, "a 15-minute clock that can only ever observe nothing is not a feature");
  assert.match(
    sync.blocked!,
    /record by hand/,
    "and the refusal is a sentence about what to connect, not a boolean — a manual-payments business " +
      "is a legitimate install, not a misconfiguration",
  );
});

/**
 * ═══ DEGRADING WITH NO CLAIMANT ═══
 *
 * A bookkeeping-only install has no dunning wedge. roles.ts is explicit that this is a legitimate
 * install and not an error: the caller must do nothing and SAY WHY. The failure being guarded
 * against is the other two options — crashing the invoice write, or writing a Schedule whose `wedge`
 * names nothing installed, which is a row on `/clock` that fires for ever and can never chase
 * anything. A configured feature that does not exist is worse than an absent one, because it looks
 * wired up.
 */
test("no wedge claims the dunning role: the invoice still saves, nothing is scheduled, the reason is a sentence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "upkeep-wedges-"));
  const prev = process.env.MYCEL_WEDGES_DIR;
  process.env.MYCEL_WEDGES_DIR = dir;
  // One wedge, no roles at all: a trade that delivers and invoices and chases nobody.
  mkdirSync(join(dir, "quiet-shop"));
  writeFileSync(
    join(dir, "quiet-shop", "wedge.json"),
    JSON.stringify({ wedge: "quiet-shop", title: "Quiet Shop", task_types: { do_work: { description: "work" } } }),
  );
  _resetWedgeRoleIndex();
  _resetWedgeDeclarations();

  try {
    const { app, projectId, domain, client } = await world();
    const inv = await api(app, "invoices", { method: "POST", body: JSON.stringify({ client_id: client.id, lines: [LINE] }) });
    assert.equal(inv.status, 201, "the invoice write must not fail because a wedge is missing");

    assert.ok(
      !(await schedulesFor(projectId)).includes(CHASE_SWEEP_TASK_TYPE),
      "a chase sweep whose wedge names nothing installed would spawn runs with no output schema, no " +
        "policy envelope and no knowledge — an agent handed a verb nobody taught it",
    );

    const report = await ensureUpkeep(domain, projectId);
    const chase = report.sweeps.find((s) => s.task_type === CHASE_SWEEP_TASK_TYPE)!;
    assert.equal(chase.wanted, true);
    assert.equal(chase.running, false);
    assert.match(chase.blocked!, /dunning/, "names the role that is unclaimed");
    assert.match(chase.blocked!, /next-move list/, "and says what happens instead, so it is a product and not a gap");

    const nudge = report.sweeps.find((s) => s.task_type === NUDGE_SWEEP_TASK_TYPE)!;
    assert.match(
      nudge.blocked!,
      /nudge_client_request/,
      "no installed wedge can carry a nudge either, and a clock over work that can only ever be " +
        "refused is the same lie as no clock at all",
    );
  } finally {
    if (prev === undefined) delete process.env.MYCEL_WEDGES_DIR;
    else process.env.MYCEL_WEDGES_DIR = prev;
    _resetWedgeRoleIndex();
    _resetWedgeDeclarations();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GET /v1/upkeep names a project and reports what is not running", async () => {
  const { app, client } = await world();
  await api(app, "invoices", { method: "POST", body: JSON.stringify({ client_id: client.id, lines: [LINE] }) });

  const r = await api(app, "upkeep");
  assert.equal(r.status, 200);
  const sync = r.json.sweeps.find((s: any) => s.task_type === PAYMENT_SYNC_TASK_TYPE);
  assert.equal(sync.wanted, true);
  assert.equal(sync.running, false, "no payment provider is connected in this fixture");
  assert.ok(sync.blocked, "the gap is served, not merely logged — /v1/schedules cannot show an absence");
  assert.equal(r.json.roles.dunning, "invoice-chaser", "and the role map says who would carry a chase");
});
