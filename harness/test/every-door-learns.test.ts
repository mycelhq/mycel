import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = new URL("../src/", import.meta.url).pathname;
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[^\n]*?\/\/[^\n]*$/gm, "");

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) tsFiles(p, out);
    else if (p.endsWith(".ts") && !p.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * EVERY DOOR A HUMAN DECIDES THROUGH MUST FILE THE LESSON
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `recordApprovalOutcome` is the only thing in this product that turns a decision into knowledge —
 * the observation saying whether the agent got it right, and the scoped rule the next run retrieves.
 * It is the mechanism behind the one claim the landing page makes about compounding: "you correct it
 * once, and it stops needing you."
 *
 * MEASURED IN PRODUCTION, 2026-09-10: `observations` held ZERO rows and all 22 rules were stamped
 * `"source": "onboarding"`. Across the product's entire history, nothing has ever been learned from
 * a correction.
 *
 * It has failed twice, the same way, for different reasons:
 *
 *   1. It lived inside `awaitApproval`, in the waiting run. A founder deciding two hours later
 *      decides after a deploy killed that run, so it never fired. Moved 6 September.
 *   2. It moved to `POST /v1/approvals/:id/approve` — and there is a SECOND approve route. Campaigns
 *      decide their own row, correctly, because nobody is blocked. Both human approvals since the
 *      September fix came through it, and it captured nothing.
 *
 * Twice is a pattern, not an accident: the capture keeps following the mechanism instead of following
 * the decision. So this test does not check the two call sites — it looks for any route that settles
 * an approval and does not file.
 */

/** A handler that moves an approval off `pending`. Whatever else it does, a person decided here. */
const SETTLES = /setApproval\(/;

test("no route settles an approval without filing the lesson", () => {
  const offenders: string[] = [];
  for (const f of tsFiles(SRC)) {
    const src = strip(readFileSync(f, "utf8"));
    // Routes only. `awaitApproval` and the reconciler settle rows too, and neither is a person
    // deciding — the reconciler closes orphans and the gate records what a policy already answered.
    if (!/app\.(post|put|patch)\(/.test(src)) continue;
    if (!SETTLES.test(src)) continue;
    if (/recordApprovalOutcome\(/.test(src)) continue;
    offenders.push(f.slice(SRC.length));
  }
  assert.deepEqual(
    offenders,
    [],
    `these routes settle an approval and file no lesson:\n${offenders.map((o) => `  ${o}`).join("\n")}\n` +
      `Every door a human decides through has to call recordApprovalOutcome, or the door is a hole ` +
      `in the only compounding asset this product has.`,
  );
});

test("both known doors are still wired", () => {
  // Named explicitly as well as scanned, so deleting a call site fails loudly rather than shrinking
  // the scan's population to zero and passing.
  for (const f of ["server.ts", "gtm/routes.ts"]) {
    assert.match(
      strip(readFileSync(join(SRC, f), "utf8")),
      /recordApprovalOutcome\(/,
      `${f} stopped filing the lesson when a human decides`,
    );
  }
});

test("a lesson is never filed without a scope", () => {
  /*
    `wedge` and `task_type` are how a lesson is ranked against other lessons. Filing against an empty
    wedge does not preserve it — it pollutes retrieval for every service in the project with a rule
    that matches nothing and ranks against everything. The campaign route reads the task for exactly
    this and SKIPS when it cannot, which is the behaviour worth pinning.
  */
  const gtm = strip(readFileSync(join(SRC, "gtm/routes.ts"), "utf8"));
  assert.doesNotMatch(gtm, /wedge:\s*task\?\.wedge/, "an unscoped lesson can be filed again");
  assert.match(gtm, /if \(!task\)/, "the campaign route no longer refuses to file without a scope");
});
