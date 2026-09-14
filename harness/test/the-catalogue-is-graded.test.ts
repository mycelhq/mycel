/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * EVERY SERVICE WE SHIP, GRADED — AND THE GRADE IS A RATCHET
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `deliverable-grade.ts` has been able to answer "will this service produce work a client would
 * actually pay for?" for a while, and nothing ever ran it over the catalogue we ship. Run on
 * 12 September it found **2 blocking and 14 weak** across ten services:
 *
 *   · `contract-desk` — claims to hand a client a document, and every one of its task types carries
 *     `client_facing: false`. Neither a trade nor machinery.
 *   · `product-builder/build_feature` — what a client receives, with no `ship_requires` and no
 *     `output_schema`. Nothing stopped a run reporting success on an empty result.
 *   · `no-refusal-path` on SIX task types — the systemic one. A job with no way to say "I could not
 *     do this" produces something anyway, which is the definition of slop.
 *
 * The refusal rule is the one worth stating plainly, because it is the difference between a harness
 * and a text generator: a content plan written without knowing the audience reads like a plan, is
 * on-topic, and would fit any business in the trade. The only defence is the job being able to stop.
 *
 * ═══ WHY A CEILING RATHER THAN ZERO ═══
 *
 * One blocking finding is left standing on purpose. `contract-desk`'s labels were written by the
 * founder on 12 September with a reason beside each, and resolving the contradiction means deciding
 * whether a contractor desk sends its client a weekly status — a product question. Asserting zero
 * would force the next person to answer it by relabelling the founder's own sweep as client work,
 * which is the wrong fix arriving through the wrong door.
 *
 * So this pins a CEILING that only moves down. A new service that ships with a hole fails here; the
 * open question stays visible instead of being papered over.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gradeDeliverables } from "../src/deliverable-grade";

const WEDGES = join(import.meta.dirname, "..", "..", "wedges");
const manifests = readdirSync(WEDGES)
  .filter((d) => !d.startsWith("."))
  .flatMap((slug) => {
    try {
      return [[slug, JSON.parse(readFileSync(join(WEDGES, slug, "wedge.json"), "utf8"))] as const];
    } catch {
      return [];
    }
  });

test("the catalogue is graded, and the grade only improves", () => {
  let blocking = 0;
  let weak = 0;
  const detail: string[] = [];
  for (const [slug, m] of manifests) {
    const g = gradeDeliverables(m);
    blocking += g.blocking;
    weak += g.weak;
    if (g.blocking || g.weak) detail.push(`${slug}: ${g.blocking} blocking, ${g.weak} weak`);
  }
  /*
    12 September: 2 blocking, 14 weak. 13 September: 1 and 1.

    The two left are both design questions rather than omissions, and each is recorded where it
    lives. `contract-desk` claims to hand a client a document while every task type is the founder's
    own machinery. `security-questionnaire/fill_questionnaire` returns three counts — answered,
    needs_human, not_applicable — with no total and no item list to check them against, so
    `numbers-unchecked` is correct and satisfying it means deciding what that packet's output shape
    should be, not adding a check to the schema we have.
  */
  assert.ok(blocking <= 1, `blocking findings rose to ${blocking}\n  ${detail.join("\n  ")}`);
  assert.ok(weak <= 1, `weak findings rose to ${weak}\n  ${detail.join("\n  ")}`);
});

test("EVERY CLIENT-FACING JOB CAN REFUSE", () => {
  /**
   * The systemic rule, asserted directly rather than through the total — because this is the one a
   * new service is most likely to ship without, and a count can hide it behind another improvement.
   */
  const missing: string[] = [];
  for (const [slug, m] of manifests) {
    for (const f of gradeDeliverables(m).findings) {
      if (f.rule === "no-refusal-path") missing.push(`${slug}/${(f as { task?: string }).task ?? "?"}`);
    }
  }
  assert.deepEqual(missing, [], `these will invent output rather than stop: ${missing.join(", ")}`);
});

test("NO JOB SHIPS WITH NOTHING REQUIRED OF IT", () => {
  // `no-output-contract` is blocking for a reason: it is the only finding that lets a run report
  // success on an empty document, which the founder then forwards.
  const holes: string[] = [];
  for (const [slug, m] of manifests) {
    for (const f of gradeDeliverables(m).findings) {
      if (f.rule === "no-output-contract") holes.push(`${slug}/${(f as { task?: string }).task ?? "?"}`);
    }
  }
  assert.deepEqual(holes, [], `nothing says what these must contain: ${holes.join(", ")}`);
});

test("a refusal flag is a BOOLEAN the ship check can actually read", () => {
  /**
   * `shipFaults` evaluates `not_when` as `at(parsed, unknown_when) === true`. Pointing it at a status
   * ENUM value looks right, reads right, and can never fire — a gate that runs and does nothing,
   * which is the failure mode this repo has now recorded four times. I made exactly that mistake on
   * `build_feature` an hour before writing this.
   */
  for (const [slug, m] of manifests) {
    for (const [tt, spec] of Object.entries((m.task_types ?? {}) as Record<string, Record<string, unknown>>)) {
      const checks = (spec?.ship_checks ?? []) as Array<Record<string, string>>;
      if (!Array.isArray(checks)) continue;
      for (const c of checks) {
        if (c?.kind !== "not_when") continue;
        /*
          DOTTED PATHS, because `at()` splits on "." and walks — `books-keeper/monthly_close` reads
          `sales_tax.input_tax_unquantified`, a flag nested one level down. My first version of this
          assertion looked only at top-level properties and failed against correct code, which is the
          third time today a test of mine has been wrong about the thing it was checking.
        */
        const flag = c.unknown_when!.split(".").reduce<Record<string, unknown> | undefined>((node, part) => {
          const props = (node?.properties ?? {}) as Record<string, Record<string, unknown>>;
          return props[part];
        }, spec?.output_schema as Record<string, unknown> | undefined);
        assert.ok(flag, `${slug}/${tt}: not_when reads \`${c.unknown_when}\`, which the schema does not declare`);
        assert.equal(
          flag.type,
          "boolean",
          `${slug}/${tt}: not_when reads \`${c.unknown_when}\`, declared as ${String(flag.type)} — it must be a boolean or the check never fires`,
        );
      }
    }
  }
});
