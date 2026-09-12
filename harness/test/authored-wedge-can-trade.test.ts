/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * THE SERVICE WE WRITE FOR A FOUNDER MUST BE ABLE TO DO WHAT A SHIPPED ONE CAN
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * MEASURED IN PRODUCTION: three services written by `draft_service`, one promoted and live. None had
 * a `fulfillment` block, so none could trade. And none had `nudge_client_request`, `check_in_case`
 * or `deliverable_verdict` — because the spine is merged in `loadWedge`, and an authored service is
 * loaded by `loadProjectWedge` → `toLoaded`, which returned the stored manifest verbatim.
 *
 * So the BESPOKE service — the one that exists precisely because the catalogue did not cover what
 * this founder sells, the one most likely to need the help — was the only kind in the product that
 * could not chase a client for a missing document or take a verdict on its own work.
 *
 * Two separate holes, and each hides the other: fixing the spine merge alone changes nothing while
 * `fulfillment` is missing, because the merge keys off `fulfillment.deliverable_shapes`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { toLoaded } from "../src/authored";
import { withSpine, loadWedge } from "../src/wedge";
import { SPINE_TASK_TYPES } from "../src/spine";

const SPINE = Object.keys(SPINE_TASK_TYPES);

/** Shaped like the rows actually in production: no `fulfillment`, only the jobs the model wrote. */
const row = (task_types: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({
    id: "a1", project_id: "p1", slug: "drafted:brand-and-website-projects", status: "promoted",
    manifest: { wedge: "drafted:x", title: "Brand and website projects", tier: "standard", task_types, ...extra },
    skills: [], knowledge: [], created_at: "", updated_at: "",
  }) as any;

test("a written service gains the spine, so it can chase, check in and take a verdict", () => {
  const loaded = toLoaded(row({
    shape_brand_strategy: { description: "d", output_schema: { type: "object", properties: { a: { type: "string" } } } },
    build_marketing_website: { description: "d", output_schema: { type: "object", properties: { a: { type: "string" } } } },
  }));
  const jobs = Object.keys(loaded.manifest.task_types ?? {});
  for (const s of SPINE) assert.ok(jobs.includes(s), `a written service still cannot ${s}`);
});

test("...and gains a fulfillment block, so it can trade at all", () => {
  const loaded = toLoaded(row({
    write_report: { description: "d", output_schema: { type: "object", properties: { a: { type: "string" } } } },
  }));
  const f = (loaded.manifest as any).fulfillment;
  assert.ok(f, "no fulfillment block was derived");
  assert.ok(f.deliverable_shapes?.length, "it still ships nothing");
  assert.equal(f.production_task_type, "write_report");
  // Never invented: what to ask a client for is trade knowledge and what to charge is the founder's
  // business. A plausible guess on either is worse than a blank, because nobody would check it.
  assert.deepEqual(f.intake_asks, []);
  assert.equal(f.money_plan, undefined);
});

test("the repair does not mutate the stored row — the database and memory must agree", () => {
  const r = row({ write_report: { description: "d", output_schema: { type: "object", properties: { a: { type: "string" } } } } });
  toLoaded(r);
  assert.equal((r.manifest as any).fulfillment, undefined, "toLoaded rewrote what was authored");
});

test("a service that already declares its own fulfillment keeps it exactly", () => {
  const mine = { deliverable_shapes: ["report"], production_task_type: "write_report", intake_asks: ["last month's bank statement"], client_connections: [] };
  const loaded = toLoaded(row(
    { write_report: { description: "d", output_schema: { type: "object", properties: { a: { type: "string" } } } } },
    { fulfillment: mine },
  ));
  assert.deepEqual((loaded.manifest as any).fulfillment, mine);
});

test("ORDER: repairing before merging is what makes the merge do anything", () => {
  // The bug this pins. `withSpine` keys off `fulfillment.deliverable_shapes`, so running it on the
  // raw manifest — which is what a naive fix would do — finds nothing and silently no-ops.
  const raw = { wedge: "drafted:x", title: "t", tier: "standard", task_types: { write_report: { description: "d" } } } as any;
  const spineOnly = withSpine(raw);
  assert.deepEqual(Object.keys(spineOnly.task_types ?? {}), ["write_report"], "premise wrong: withSpine merged without fulfillment");

  const loaded = toLoaded(row({ write_report: { description: "d", output_schema: { type: "object", properties: { a: { type: "string" } } } } }));
  for (const s of SPINE) assert.ok(Object.keys(loaded.manifest.task_types ?? {}).includes(s));
});

test("machinery still does NOT get the spine — the boundary is shipping to a client", async () => {
  // `gtm-operator` finds prospects and `business-shaper` drafts a service during onboarding. Neither
  // has a client to chase. Giving them these jobs puts buttons on the next-move list that cannot
  // mean anything, which is what six tests correctly refused the first time.
  for (const slug of ["gtm-operator", "business-shaper"]) {
    const w = await loadWedge(slug);
    assert.ok(w, `${slug} did not load`);
    const jobs = Object.keys(w!.manifest.task_types ?? {});
    for (const s of SPINE) assert.ok(!jobs.includes(s), `${slug} was given ${s} and has no client`);
  }
});

test("both loaders go through one function, so a third cannot forget", async () => {
  const { readFileSync } = await import("node:fs");
  const authored = readFileSync(new URL("../src/authored.ts", import.meta.url), "utf8");
  assert.match(authored, /withSpine\(/, "the authored loader does not merge the spine");
  assert.match(authored, /repairAuthoredManifest\(manifest\)/, "the authored loader does not repair the manifest");
  const wedge = readFileSync(new URL("../src/wedge.ts", import.meta.url), "utf8");
  assert.match(wedge, /manifest = withSpine\(manifest\)/, "loadWedge no longer uses the shared function");
  // The merge body must exist in exactly one place.
  assert.equal((wedge.match(/SPINE_TASK_TYPES\)\) \{/g) ?? []).length, 1, "the spine merge was duplicated");
});
