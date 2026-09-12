/**
 * ═══ A TRADE INHERITS THE SPINE INSTEAD OF COPYING IT ═══
 *
 * A wedge was doing two jobs and only one varies by trade. Reconciling a month is bookkeeping.
 * Chasing a client for a document, hearing their verdict on a deliverable, and checking in on a
 * quiet engagement are not — every service business does all three the same way.
 *
 * They were copy-pasted into six manifests each: eighteen declarations of three jobs, 37-50% of
 * every trade wedge. And they had already drifted into two or three variants — books-keeper carried
 * its own version of all three, geo-monitor its own nudge, and nothing said which was canonical.
 *
 * One definition now, merged in `loadWedge`. The measure of success is that a NEW trade gets the
 * spine by writing nothing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadWedge } from "../src/wedge";
import { SPINE_TASK_TYPES } from "../src/spine";

const WEDGES = join(import.meta.dirname, "..", "..", "wedges");
const slugs = readdirSync(WEDGES).filter((d) => !d.startsWith("."));
const raw = (slug: string) => JSON.parse(readFileSync(join(WEDGES, slug, "wedge.json"), "utf8"));

test("every trade that ships to a client carries the whole spine", () => {
  const missing: string[] = [];
  for (const slug of slugs) {
    const w = loadWedge(slug);
    if (!w) continue;
    if (!(w.manifest.fulfillment?.deliverable_shapes?.length ?? 0)) continue;
    for (const name of Object.keys(SPINE_TASK_TYPES)) {
      if (!w.manifest.task_types?.[name]) missing.push(`${slug}/${name}`);
    }
  }
  assert.deepEqual(missing, [], `a client-facing trade cannot chase, hear a verdict, or check in: ${missing.join(", ")}`);
});

test("and almost none of them declare it — that is the point", () => {
  // The eighteen copies are gone. What may remain is a per-trade NARROWING (books-keeper's nudge
  // needs `send_email` and nothing else), which is a fact about that trade rather than drift.
  const declaring: string[] = [];
  for (const slug of slugs) {
    const tt = raw(slug).task_types ?? {};
    for (const name of Object.keys(SPINE_TASK_TYPES)) {
      const own = tt[name];
      if (!own) continue;
      const keys = Object.keys(own).filter((k) => !k.startsWith("_"));
      // A whole job re-declared is the copy-paste coming back.
      if (keys.some((k) => k !== "capabilities")) declaring.push(`${slug}/${name} (${keys.join(",")})`);
    }
  }
  assert.deepEqual(declaring, [], `these re-declare the spine instead of inheriting it: ${declaring.join(", ")}`);
});

test("a wedge may narrow its own access, and the narrowing survives", () => {
  // books-keeper's nudge sends email and touches nothing else. That must survive the merge, or the
  // spine has flattened a real difference between trades.
  const bk = loadWedge("books-keeper");
  assert.ok(bk, "books-keeper is gone");
  const nudge = bk!.manifest.task_types!.nudge_client_request as { capabilities?: string[]; description?: string };
  assert.deepEqual(nudge.capabilities, ["send_email"], "the trade's own capability narrowing was lost");
  // …while everything it did NOT narrow comes from the one definition.
  assert.equal(nudge.description, (SPINE_TASK_TYPES.nudge_client_request as { description?: string }).description);
});

test("the merge puts the wedge's own keys last", () => {
  /**
   * Asserted on the SOURCE, because no fixture can exercise it today and I would rather say that
   * than pretend otherwise: the only narrowing any trade declares is `capabilities`, which the
   * spine does not have, so spreading the spine last would produce an identical result and the
   * test above stays green either way. I checked — flipping the order breaks nothing right now.
   *
   * It will bite the first time a trade needs a different `ship_requires` or a longer runtime on a
   * chase, and by then the wrong order looks like the spine silently ignoring a manifest.
   */
  const src = readFileSync(new URL("../src/wedge.ts", import.meta.url), "utf8");
  assert.match(
    src,
    /\{ \.\.\.spine, \.\.\.\(declared\[name\] \?\? \{\}\) \}/,
    "the spine is spread after the wedge's own keys — a trade can no longer override it",
  );
});

test("machinery does not inherit a client-facing job", () => {
  // `gtm-operator` finds prospects and `business-shaper` drafts a service during onboarding. Neither
  // has a client to chase or a deliverable to hear a verdict on, and handing them those jobs puts a
  // button on the next-move list that cannot mean anything.
  for (const slug of ["gtm-operator", "business-shaper"]) {
    const w = loadWedge(slug);
    if (!w) continue;
    assert.ok(
      !(w.manifest.fulfillment?.deliverable_shapes?.length ?? 0),
      `${slug} now declares deliverable_shapes — re-check whether it should carry the spine`,
    );
    for (const name of Object.keys(SPINE_TASK_TYPES)) {
      assert.ok(!w.manifest.task_types?.[name], `${slug} inherited ${name} and has no client to use it on`);
    }
  }
});
