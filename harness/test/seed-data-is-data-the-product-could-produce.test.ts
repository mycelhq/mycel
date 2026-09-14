/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * THE SHOP WINDOW WAS SHOWING A STATE THE PRODUCT DOES NOT HAVE
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `seed-history.ts` writes the demo tenant's past with raw SQL, and it wrote
 * `i < 7 ? "accepted" : "delivered"`. `delivered` is not a `DeliverableStatus` — the union is
 * drafting | in_review | with_client | changes_requested | accepted | withdrawn.
 *
 * Three rows on the live demo carried it. `DELIVERABLE_STATES` has no entry for `delivered`, so
 * those rows had no `founder_sees` sentence, no `client_sees` line in the portal, and fell through
 * every switch on status in the product.
 *
 * The same INSERT left `deliverables.accepted_at` null on all seven accepted rows, stamping only the
 * VERSION. The parent row is what readers join on: `founder-alerts.ts` skips on `!d.accepted_at`, so
 * the demo never once fired the alert saying a client had accepted something — the best moment this
 * product has. `hours_to_accept` was null. The per-service impact panel read zero on a tenant with
 * seven accepted deliverables in it.
 *
 * ═══ WHY THIS KEEPS HAPPENING, AND WHAT THE TEST IS ═══
 *
 * A route refuses a bad value; an INSERT takes whatever string it is handed. Every seeder that
 * reaches behind the routes is re-implementing invariants from memory, and forgetting one is silent
 * — the demo looked fine, and three of its rows were unrenderable.
 *
 * So this asserts what the SQL is allowed to say, against the union itself rather than a copy of it.
 * A status added to the product needs no change here; a status invented by a seeder fails.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ALL_DELIVERABLE_STATUSES, isDeliverableStatus } from "../src/deliverables";

const src = readFileSync(new URL("../scripts/seed-history.ts", import.meta.url), "utf8");
/** Comments in this file discuss `delivered` at length; they are argument, not data. */
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
  .replace(/^\s*\/\/.*$/gm, "");

test("the seeder only writes deliverable states the product defines", () => {
  /**
   * Every string literal on the same line as a `status` insert, checked against the real union.
   * Scoped to the deliverables INSERT so a status-shaped word elsewhere (a case stage, a task state)
   * does not produce a false failure — the lesson from the sweep that reported twelve screens
   * "rendering machinery vocabulary" when they render fetch calls.
   */
  const start = code.indexOf("INSERT INTO public.deliverables");
  assert.ok(start > 0, "the deliverables insert moved — this test is now measuring nothing");
  const block = code.slice(start, code.indexOf("INSERT INTO public.deliverable_versions", start));

  const ternary = block.match(/i < 7 \? "([a-z_]+)" : "([a-z_]+)"/);
  assert.ok(ternary, "the status expression changed shape; check it by hand and update this");
  for (const status of [ternary[1]!, ternary[2]!]) {
    assert.ok(
      isDeliverableStatus(status),
      `seed writes "${status}", which is not a deliverable state. Legal: ${ALL_DELIVERABLE_STATUSES.join(", ")}`,
    );
  }
});

test("ACCEPTED ON THE ROW MEANS STAMPED ON THE ROW", () => {
  /**
   * The route sets both together — `transitionDeliverable` stamps the deliverable, `settleVersion`
   * stamps the version. A seeder that writes the status by hand has to remember both, and this one
   * remembered the version.
   */
  const start = code.indexOf("INSERT INTO public.deliverables");
  const block = code.slice(start, code.indexOf("INSERT INTO public.deliverable_versions", start));
  assert.match(block, /accepted_at/, "the deliverables insert does not write accepted_at at all");
  assert.match(
    block,
    /i < 7 \? at\(1 \+ i\) : null/,
    "the stamp is not tied to the same condition as the status, so the two can disagree",
  );
});

test("the two halves cannot drift apart", () => {
  /**
   * A row that says `accepted` with no `accepted_at`, or a stamp on a row that is not accepted, are
   * both states the product cannot reach through its own routes. Both conditions are `i < 7`, so
   * they are one decision written twice — this pins that they stay the same decision.
   */
  const start = code.indexOf("INSERT INTO public.deliverables");
  const block = code.slice(start, code.indexOf("INSERT INTO public.deliverable_versions", start));
  const statusCond = block.match(/(i < \d+) \? "accepted"/)?.[1];
  const stampCond = block.match(/(i < \d+) \? at\(1 \+ i\)/)?.[1];
  assert.ok(statusCond && stampCond, "one of the two conditions is missing");
  assert.equal(stampCond, statusCond, "the status and the stamp are gated on different conditions");
});
