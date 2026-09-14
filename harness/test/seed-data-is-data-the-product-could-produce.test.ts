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

/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * A SEEDED GATE MUST BE AS LIVE AS A REAL ONE, OR THE DEMO EMPTIES ITSELF AGAIN
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Same class as everything above: an INSERT takes whatever it is handed, and the invariants it has
 * to satisfy live in code it never calls.
 *
 * MEASURED ON THE DEMO TENANT, 14 September: fifteen approvals seeded `pending`, every one now
 * `expired`, every owning task `failed` with "This run went silent while awaiting_approval", all
 * fifteen closed in the same second — the dead-run sweep reclaims anything non-terminal untouched
 * for ten minutes, and a seeded row is stale the moment it is written. The tenant the landing page
 * embeds read "Nothing to approve" under the heading for the one promise this product is sold on.
 *
 * The sweep is fixed. `--only gates` is the other half, and it has exactly three ways to fail
 * silently: an approval that is born expired, a task that is born terminal, and a top-up that does
 * not count first and so fills the shop window with thirty waiting drafts.
 */
const gates = () => {
  const at = code.indexOf("async function ensureGates(");
  assert.ok(at > 0, "the gates mode is gone — the demo has no queue to show");
  return code.slice(at, code.indexOf("async function main(", at));
};

test("SEEDED APPROVALS CARRY THE WINDOW THE PRODUCT HONOURS", () => {
  /*
    Not a retyped 24 hours. `store.ts` documents at this constant that the row and the timer said
    three different numbers, and the dead-run sweep now READS `expires_at` to decide whether a gate
    is worth protecting — so a literal here re-creates the bug in a new place.
  */
  assert.match(code, /import \{ APPROVAL_TTL_MS \} from "\.\.\/src\/store"/, "the seeder invents its own window");
  assert.match(
    gates(),
    /new Date\(created\.getTime\(\) \+ APPROVAL_TTL_MS\)/,
    "a seeded gate's expiry is not the product's",
  );
  // And it is born INSIDE that window. The first version spread these over thirty hours, which is
  // an approval that has already expired on arrival.
  const spread = /\(0\.5 \+ i \* 3 \+ rnd\(`h:\$\{seed\}`\) \* 2\) \* 3_600_000/.exec(gates());
  assert.ok(spread, "the ages moved; check they stay well inside APPROVAL_TTL_MS and update this");
});

test("the task under a seeded gate is not born terminal", () => {
  // `GET /v1/approvals` refuses to show a pending approval on a terminal task, correctly. A gate on
  // a `succeeded` row is invisible to the product and visible only in the database.
  assert.match(gates(), /'awaiting_approval'/, "the seeded gate's task is in some other state");
  for (const terminal of ["succeeded", "failed", "cancelled", "expired", "rejected"]) {
    assert.ok(!gates().includes(`'${terminal}'`) || !gates().includes(`VALUES ($1,$2,$3,$4,$5,'${terminal}'`),
      `a seeded gate hangs off a ${terminal} task`);
  }
  assert.match(gates(), /'pending'/, "the approval row is not pending");
});

test("RUNNING IT TWICE DOES NOT FILL THE SHOP WINDOW", () => {
  /*
    The history build is fabricated once and then true. A queue is the one part meant to be re-run,
    because anyone clicking through the demo can empty it — and "thirty drafts waiting" reads as
    neglect rather than as a business mid-flight.
  */
  const g = gates();
  assert.match(g, /SELECT count\(\*\)::int AS n/, "the top-up does not count what is already there");
  assert.match(g, /a\.status = 'pending'/, "it counts approvals of any status");
  assert.match(
    g,
    /t\.status NOT IN \('succeeded','failed','rejected','expired','cancelled'\)/,
    "it counts gates the product itself refuses to show, so a re-run tops up to nothing",
  );
  assert.match(g, /if \(have >= WANT_GATES\)[\s\S]{0,200}?return;/, "there is no early return, so every run writes more");
  assert.match(g, /for \(let i = have; i < WANT_GATES; i\+\+\)/, "the loop does not start from what already exists");
});
