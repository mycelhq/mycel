// HARD EVAL — the generative claim, proven. "Is a service really 'primitives, composed' — and do the
// composed primitives run the SAME verified mechanics as a hand-written vertical?"
//
// Mycel's whole thesis is that it is not a catalogue of hardcoded businesses; it is a generator. A
// hand-written wedge and a service the kernel writes for one founder must be the same KIND of thing:
// both reference kernel-owned, verified primitives by `lib`, and both run identical, tested arithmetic.
// If the "generated" path secretly ran different code, the demo would be a lie and every generated
// business would be an untested one.
//
// This evals the seam directly. It asserts (1) the three shipped verticals reference the shared library
// rather than shipping their own copy of the mechanics; (2) the primitive a wedge calls by name produces
// EXACTLY what a direct call to the same kernel-owned function produces — no per-wedge drift; (3) a
// GENERATED manifest may reference the very same primitive and validate; and (4) the library is a closed
// vocabulary, so an unknown reference is refused rather than pointed at code nobody wrote. Grading is on
// the real `runWorkflow` output versus the real function output — behaviour, not claim.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
// Pin both kernel-owned directories relative to THIS file, so the eval runs under `npm test` (cwd=kernel)
// and standalone from kernel/harness. loadWedge / runWorkflow read these before falling back to cwd.
const HERE = dirname(fileURLToPath(import.meta.url));
process.env.MYCEL_WEDGES_DIR ??= join(HERE, "..", "..", "wedges");
process.env.MYCEL_WORKFLOW_LIB_DIR ??= join(HERE, "..", "..", "workflows");
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadWedge } from "../src/wedge";
import { runWorkflow, SHARED_WORKFLOWS, isSharedWorkflow } from "../src/workflows";
import { authoredFaults } from "../src/wedgeauthor";
import { authoredSlug } from "../src/wedge";
import dunningLadder from "../../workflows/dunning-ladder.mjs";
import reconcile from "../../workflows/reconcile.mjs";
import nextTouch from "../../workflows/next-touch.mjs";

// ─────────────────────────── 1. THE SHIPPED VERTICALS ARE COMPOSED, NOT HARDCODED ───────────────────────────
//
// Each of the three flagship wedges declares its mechanics as a `lib` reference into the shared library.
// That reference — not a per-wedge .mjs — is the proof the catalogue has dissolved into the generator.

interface WedgeRef {
  slug: string;
  workflow: string; // the name the manifest declares
  lib: string; // the kernel-owned primitive it references
}

const COMPOSED: WedgeRef[] = [
  { slug: "invoice-chaser", workflow: "next_step", lib: "dunning-ladder" },
  { slug: "books-keeper", workflow: "reconcile", lib: "reconcile" },
  { slug: "gtm-operator", workflow: "next_touch", lib: "next-touch" },
];

test("EVAL: each shipped vertical references a VERIFIED shared primitive by lib, not its own copy of the mechanics", () => {
  const failures: string[] = [];
  for (const c of COMPOSED) {
    const wedge = loadWedge(c.slug);
    if (!wedge) {
      failures.push(`✗ ${c.slug} did not load — cannot prove it is composed`);
      continue;
    }
    const spec = (wedge.manifest.workflows ?? []).find((w) => w.name === c.workflow);
    if (!spec) {
      failures.push(`✗ ${c.slug} declares no workflow named "${c.workflow}"`);
      continue;
    }
    if (spec.lib !== c.lib) {
      failures.push(`✗ ${c.slug}.${c.workflow} should reference lib "${c.lib}", got ${JSON.stringify(spec.lib)}`);
    }
    if (!isSharedWorkflow(spec.lib)) {
      failures.push(`✗ ${c.slug}.${c.workflow} references "${String(spec.lib)}", which is not in the closed shared vocabulary`);
    }
  }
  console.log(`\n  composability (verticals reference shared libs): ${COMPOSED.length - failures.length}/${COMPOSED.length} passed`);
  assert.equal(
    failures.length,
    0,
    `\n${failures.join("\n")}\n\n  A vertical that ships its own copy of dunning/reconcile is a catalogue entry, not a composition. This is the seam the generative claim rests on.`,
  );
});

// ─────────────────────────── 2. THE COMPOSED PRIMITIVE RUNS IDENTICALLY TO THE KERNEL FUNCTION ───────────────────────────
//
// The claim is not just "it references a lib" — it is "calling the lib through the wedge runs the same
// verified mechanics." So the output of `runWorkflow(slug, name, args)` must equal, field for field, the
// output of a DIRECT call to the kernel-owned function. Any drift here would mean a generated business
// silently runs different arithmetic than the tested one.

const LIB_FN: Record<string, (a: any) => any> = {
  "dunning-ladder": dunningLadder,
  reconcile,
  "next-touch": nextTouch,
};

// Adversarial-but-realistic inputs — the exact cases the standalone primitive evals grade — routed
// through the wedge instead of called directly, to prove the two paths cannot diverge.
const EQUIV: Array<{ slug: string; workflow: string; lib: string; args: Record<string, unknown> }> = [
  { slug: "invoice-chaser", workflow: "next_step", lib: "dunning-ladder", args: { days_overdue: 45, disputed: true } },
  { slug: "invoice-chaser", workflow: "next_step", lib: "dunning-ladder", args: { days_overdue: 40 } },
  { slug: "invoice-chaser", workflow: "next_step", lib: "dunning-ladder", args: { days_overdue: 5 } },
  {
    slug: "books-keeper",
    workflow: "reconcile",
    lib: "reconcile",
    args: {
      // The 0.1 + 0.2 case: integer cents must reconcile to exactly 30c, tax extracted tax-inclusive.
      bank_transactions: [{ amount_cents: 12000, date: "2026-10-02", reference: "A1" }],
      ledger_entries: [{ amount_cents: 12000, date: "2026-10-02", reference: "A1" }],
      sales_tax_rate_pct: 20,
    },
  },
  {
    slug: "books-keeper",
    workflow: "reconcile",
    lib: "reconcile",
    args: {
      // An unmatched bank row must refuse a false "reconciled" — through the wedge, same as direct.
      bank_transactions: [
        { amount_cents: 5000, date: "2026-10-02", reference: "A1" },
        { amount_cents: 4500, date: "2026-10-09", reference: "C3" },
      ],
      ledger_entries: [{ amount_cents: 5000, date: "2026-10-02", reference: "A1" }],
    },
  },
  { slug: "gtm-operator", workflow: "next_touch", lib: "next-touch", args: { stage: "prospect" } },
  { slug: "gtm-operator", workflow: "next_touch", lib: "next-touch", args: { stage: "touch_1", opt_out: true } },
  { slug: "gtm-operator", workflow: "next_touch", lib: "next-touch", args: { stage: "dm1", has_reply: true } },
];

test("EVAL: a primitive called through the wedge produces EXACTLY what the kernel function produces — no per-wedge drift", async () => {
  const failures: string[] = [];
  for (const c of EQUIV) {
    const viaWedge = await runWorkflow(c.slug, c.workflow, c.args);
    if (!viaWedge.ok) {
      failures.push(`✗ ${c.slug}.${c.workflow}(${JSON.stringify(c.args)}) failed through the wedge: ${viaWedge.error}`);
      continue;
    }
    const direct = LIB_FN[c.lib](c.args);
    // The wedge path validates output against the declared schema and may carry only the declared
    // fields; assert the declared fields agree with the direct call rather than deep-equality on extras.
    for (const key of Object.keys(viaWedge.data as Record<string, unknown>)) {
      const a = (viaWedge.data as Record<string, unknown>)[key];
      const b = (direct as Record<string, unknown>)[key];
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        failures.push(
          `✗ ${c.slug}.${c.workflow}(${JSON.stringify(c.args)}) drifted on "${key}": wedge=${JSON.stringify(a)} vs kernel=${JSON.stringify(b)}`,
        );
      }
    }
  }
  console.log(`\n  composability (wedge output == kernel output): ${EQUIV.length - failures.length}/${EQUIV.length} cases matched`);
  assert.equal(
    failures.length,
    0,
    `\n${failures.join("\n")}\n\n  If the composed path drifts from the kernel function, a generated business runs UNTESTED arithmetic while a hand-written one runs the verified kind.`,
  );
});

// ─────────────────────────── 3. A GENERATED SERVICE MAY COMPOSE THE SAME PRIMITIVE ───────────────────────────

test("EVAL: a GENERATED manifest may reference the same verified primitive and validate — the generator gets real mechanics", () => {
  const slug = authoredSlug("boutique-collections");
  const faults = authoredFaults(slug, {
    wedge: slug,
    title: "Boutique agency collections",
    task_types: {
      chase_invoice: {
        description: "Given an overdue invoice, choose the dunning step and draft it for approval.",
        output_schema: { type: "object", properties: { step: { type: "string" } }, required: ["step"] },
      },
    },
    // The exact seam the generative claim needs: a written service authors no code, but references the
    // kernel-owned dunning ladder by lib — the same primitive invoice-chaser uses.
    workflows: [{ name: "next_step", lib: "dunning-ladder", description: "which dunning step the policy dictates" }],
  });
  assert.deepEqual(faults, [], `a written service referencing a verified lib must validate; got: ${faults.map((f) => f.message).join("; ")}`);
});

test("EVAL: the shared library is a CLOSED vocabulary — an unknown primitive is refused, never pointed at absent code", () => {
  const slug = authoredSlug("scammy");
  const faults = authoredFaults(slug, {
    wedge: slug,
    title: "Thing",
    task_types: { do_it: { description: "x", output_schema: { type: "object", properties: { ok: { type: "boolean" } } } } },
    workflows: [{ name: "x", lib: "make-money-fast" }],
  });
  assert.ok(
    faults.some((f) => /verified shared primitive/.test(f.message)),
    "an unknown lib must be refused with the list of the ones that exist",
  );
  // And the closed set is exactly what SHARED_WORKFLOWS advertises — the vocabulary is code, not disk.
  assert.deepEqual([...SHARED_WORKFLOWS].sort(), ["dunning-ladder", "next-touch", "reconcile"]);
});
