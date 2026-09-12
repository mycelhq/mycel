import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DELIVERABLE_STATES } from "../src/deliverables";

const routes = readFileSync(new URL("../src/deliverables.routes.ts", import.meta.url), "utf8");

/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * ONE ROW WITH AN OLD WORD IN A COLUMN TOOK DOWN EVERY DELIVERABLE IN THE PROJECT
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `GET /v1/deliverables` mapped every row through `DELIVERABLE_STATES[d.status].founder_sees`.
 * That map has exactly the six members of the status union. Production holds rows with
 * `status: "released"` and `"delivered"` — an older vocabulary, never migrated, and nothing in this
 * build writes either — so the lookup is `undefined` and the property access throws.
 *
 * The blast radius is the whole endpoint, not the row: every deliverable in that project becomes
 * unreadable on every surface. And the console swallows it — `.catch(() => [])` on both call sites —
 * so the founder sees an empty list rather than an error, which is the worst of the three outcomes.
 */

test("an unrecognised status degrades to itself instead of throwing", () => {
  assert.match(
    routes,
    /DELIVERABLE_STATES\[d\.status\]\?\.founder_sees \?\?/,
    "the list route dereferences the state map without a guard again",
  );
});

test("the state map really does NOT cover what production holds", () => {
  // The premise, asserted rather than assumed. If these ever become real statuses the guard above is
  // still correct, but this test should be updated to name whatever the new gap is.
  for (const legacy of ["released", "delivered"]) {
    assert.equal(
      (DELIVERABLE_STATES as Record<string, unknown>)[legacy],
      undefined,
      `"${legacy}" is in DELIVERABLE_STATES now — production rows carry it, so check the route again`,
    );
  }
  // And it does cover the six the union declares, or the fallback would be masking a real omission.
  for (const known of ["drafting", "in_review", "with_client", "changes_requested", "accepted", "withdrawn"]) {
    assert.ok((DELIVERABLE_STATES as Record<string, unknown>)[known], `${known} lost its founder sentence`);
  }
});

test("the list route answers an ENVELOPE, which is what the console must read", () => {
  /*
    The other half of the same production bug, on the console side: Home fetched this as
    `kernel<DeliverableRow[]>` and coerced with `Array.isArray(x) ? x : []`, so it received an empty
    list for its entire existence — the card, the desk digest and the setup card all reading zero
    while `/deliverables` in the same session listed five.

    Pinned here, in the kernel, because this is where the contract lives. If the shape ever becomes a
    bare array, the console's envelope read is what breaks, and it should break loudly here first.
  */
  assert.match(routes, /deliverables: rows\.map\(/, "the list route no longer answers { deliverables: [...] }");
});
