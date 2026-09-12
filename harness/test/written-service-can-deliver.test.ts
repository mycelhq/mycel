/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * THE FIRM'S OWN CRAFT HAS TO BE ABLE TO DELIVER A SIGNED ENGAGEMENT
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * MEASURED IN PRODUCTION on 8 September: three services written from real firms, one promoted and
 * live, and 143 engagements. Every one of those engagements ran on `gtm-operator`, `books-keeper`,
 * `geo-monitor` or `recruiting-desk`. Not one on a craft we learned.
 *
 * The reason was in `deliveryWedge`, and it is a nasty shape. `shape.wedge` is only set when the
 * shaping run judged the business a `direct` or `adjacent` fit to one of the ten trades we ship
 * (business-shape.ts). A firm the catalogue does NOT cover therefore arrives with nothing declared
 * — and a firm the catalogue does not cover is precisely the firm we write a bespoke service for.
 *
 * So the single case authored services exist to serve was the one case that function could not
 * answer. It then consulted `project.wedges`, which is a RESTRICTION list (empty means all trades
 * allowed, not none) and is empty on every real project, found no candidate, and returned
 * undefined. `promotedSlugs` existed, was exported, was covered by its own tests, and had no
 * production caller anywhere.
 *
 * Learning a firm's craft worked. Promoting it worked. Repairing its manifest worked. Igniting
 * production would have worked. Nothing could hand it an engagement.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { deliveryWedge } from "../src/engagement-open";
import { getAuthoredStore, _resetAuthored } from "../src/authored";
import { authoredSlug } from "../src/wedge";
import { freshProjectId, makeFreshApp } from "./helpers";
import type { Store } from "../src/store";

/** A written service shaped like the rows actually in production: no `fulfillment`, jobs only. */
async function writeService(projectId: string, name: string, jobs: string[], promote = true) {
  const slug = authoredSlug(name);
  const task_types = Object.fromEntries(
    jobs.map((j) => [
      j,
      { description: `does ${j}`, output_schema: { type: "object", properties: { a: { type: "string" } } } },
    ]),
  );
  await getAuthoredStore().createDraft({
    project_id: projectId,
    slug,
    title: name,
    manifest: { wedge: slug, title: name, tier: "standard", task_types },
    skills: [],
    knowledge: [],
    described_as: `we do ${name}`,
  } as never);
  if (promote) await getAuthoredStore().decide(projectId, slug, "promoted", "founder");
  return slug;
}

/** The shaping run never ran, so nothing is declared — the real state for an off-catalogue firm. */
const noShape = { async listTasks() { return []; } } as unknown as Store;

test("a promoted written service can deliver, when the catalogue fits nothing", async () => {
  await makeFreshApp();
  _resetAuthored();
  const p = freshProjectId("written");
  const slug = await writeService(p, "brand and website projects", [
    "shape_brand_strategy",
    "build_marketing_website",
  ]);

  const chosen = await deliveryWedge(p, "payments", noShape);
  assert.equal(chosen, slug, "the firm's own live service still cannot take a signed engagement");
});

test("a service the founder has NOT promoted stays ineligible", async () => {
  // Promotion is a human reading it and pressing Go live. Widening the candidate pool must not
  // quietly turn a draft into something a client's signature lands on.
  await makeFreshApp();
  _resetAuthored();
  const p = freshProjectId("draftonly");
  await writeService(p, "design feedback and scope changes", ["draft_scope_change"], false);

  assert.equal(await deliveryWedge(p, "payments", noShape), undefined, "a draft delivered an engagement");
});

test("two live services refuse rather than guess", async () => {
  /**
   * The exactly-one rule this function already had, and the reason it is safe to widen the pool.
   * A firm with two live services gets a human decision, not a coin toss about whose letterhead
   * the work goes out under.
   */
  await makeFreshApp();
  _resetAuthored();
  const p = freshProjectId("two");
  await writeService(p, "brand and website projects", ["build_marketing_website"]);
  await writeService(p, "geo audit and action plan", ["write_visibility_report"]);

  assert.equal(await deliveryWedge(p, "payments", noShape), undefined, "it picked one of two arbitrarily");
});

test("the excluded trade is still excluded", async () => {
  // `exclude` is the wedge the engagement was signed ON. Delivering back into it would loop.
  await makeFreshApp();
  _resetAuthored();
  const p = freshProjectId("excl");
  const slug = await writeService(p, "brand and website projects", ["build_marketing_website"]);

  assert.equal(await deliveryWedge(p, slug, noShape), undefined, "it delivered into the trade it came from");
});

test("a written service that cannot produce a deliverable is not eligible", async () => {
  /**
   * Widening WHICH services are considered must not widen the bar they clear. `productionTaskType`
   * still gates every candidate, so a service whose jobs are all machinery is exactly as
   * ineligible as it was before.
   */
  await makeFreshApp();
  _resetAuthored();
  const p = freshProjectId("nowork");
  await writeService(p, "admin only", ["nudge_client_request", "check_in_case"]);

  assert.equal(await deliveryWedge(p, "payments", noShape), undefined, "a service with no real work delivered");
});
