// Real LLM-drafted ad creative — the state-of-the-art path — and its fall-back guarantee.
//
// Every assertion names the failure it prevents. The founder-facing "Draft the ad" feature must
// never ship a broken mad-lib as if a model wrote it: `generateCreative` returns undefined on ANY
// doubt (no org, proxy down, malformed output, half-empty angle) and the caller falls back to the
// deterministic `draftCreative`. The composer is driven through the injectable `complete` seam so no
// test touches the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { getDomainStore } from "../src/domain";
import { createDraft, draftCreative, generateCreative } from "../src/paid-ads";
import type { chatComplete } from "../src/litellm";

const BRIEF = {
  name: "Northwind close",
  sells: "month-end close",
  sells_to: "founders who still do the books on Sunday",
};

const stub = (out: string | undefined): { fn: typeof chatComplete; calls: () => number } => {
  let calls = 0;
  const fn = (async () => {
    calls += 1;
    return out;
  }) as unknown as typeof chatComplete;
  return { fn, calls: () => calls };
};

const goodJson = JSON.stringify([
  { id: "problem", label: "Problem", headline: "Still closing the books on Sunday?", primary: "Northwind runs your month-end close so your weekends come back — no spreadsheets, no chase.", cta: "Learn more" },
  { id: "outcome", label: "Outcome", headline: "A clean close, every month", primary: "Founders get books that reconcile themselves. Northwind does the close; you stay on the business.", cta: "Book a call" },
  { id: "direct", label: "Direct", headline: "Hand off your month-end close", primary: "We close your books each month for a flat fee. Start today and skip the next Sunday of tie-outs.", cta: "Get started" },
]);

test("generateCreative: valid model JSON becomes three ids, clipped to 40/125", async () => {
  const s = stub(goodJson);
  const angles = await generateCreative({ brief: BRIEF, orgId: "org_1", complete: s.fn });
  assert.ok(angles);
  assert.deepEqual(angles!.map((a) => a.id), ["problem", "outcome", "direct"]);
  assert.ok(angles!.every((a) => a.headline.length <= 40 && a.primary.length <= 125));
  assert.ok(angles!.every((a) => a.headline && a.primary && a.cta));
  assert.equal(s.calls(), 1);
});

test("generateCreative: headline over 40 chars is clipped, not shipped raw", async () => {
  const long = JSON.stringify([
    { id: "problem", label: "P", headline: "This headline is far, far too long to ever run inside a paid social slot", primary: "Short and fine.", cta: "Learn more" },
    { id: "outcome", label: "O", headline: "Fine", primary: "Fine.", cta: "Book a call" },
    { id: "direct", label: "D", headline: "Fine", primary: "Fine.", cta: "Get started" },
  ]);
  const angles = await generateCreative({ brief: BRIEF, orgId: "org_1", complete: stub(long).fn });
  assert.ok(angles);
  assert.ok(angles![0]!.headline.length <= 40);
});

test("generateCreative: proxy down (undefined) falls back", async () => {
  const angles = await generateCreative({ brief: BRIEF, orgId: "org_1", complete: stub(undefined).fn });
  assert.equal(angles, undefined);
});

test("generateCreative: non-JSON prose falls back", async () => {
  const angles = await generateCreative({ brief: BRIEF, orgId: "org_1", complete: stub("Sure! Here are three great ad angles for you.").fn });
  assert.equal(angles, undefined);
});

test("generateCreative: missing the 'direct' angle falls back", async () => {
  const two = JSON.stringify([
    { id: "problem", label: "P", headline: "A", primary: "a", cta: "Learn more" },
    { id: "outcome", label: "O", headline: "B", primary: "b", cta: "Book a call" },
  ]);
  const angles = await generateCreative({ brief: BRIEF, orgId: "org_1", complete: stub(two).fn });
  assert.equal(angles, undefined);
});

test("generateCreative: json wrapped in ```json fences is still parsed", async () => {
  const fenced = "```json\n" + goodJson + "\n```";
  const angles = await generateCreative({ brief: BRIEF, orgId: "org_1", complete: stub(fenced).fn });
  assert.ok(angles);
  assert.equal(angles!.length, 3);
});

test("generateCreative: an empty headline falls back rather than ship half-empty", async () => {
  const empty = JSON.stringify([
    { id: "problem", label: "P", headline: "", primary: "has body", cta: "Learn more" },
    { id: "outcome", label: "O", headline: "B", primary: "b", cta: "Book a call" },
    { id: "direct", label: "D", headline: "C", primary: "c", cta: "Get started" },
  ]);
  const angles = await generateCreative({ brief: BRIEF, orgId: "org_1", complete: stub(empty).fn });
  assert.equal(angles, undefined);
});

test("generateCreative: no orgId returns undefined WITHOUT metering", async () => {
  const s = stub(goodJson);
  const angles = await generateCreative({ brief: BRIEF, complete: s.fn });
  assert.equal(angles, undefined);
  assert.equal(s.calls(), 0);
});

test("createDraft: with no orgId, the deterministic fallback is intact", async () => {
  // No app/scope needed: with no orgId, createDraft can't reach the metered composer, so it must
  // fall straight through to the deterministic template. A bare domain store and any project id is
  // all `savePaidAd` needs.
  const domain = getDomainStore();
  const ad = await createDraft({ domain, projectId: "p_creative_test", brief: BRIEF });
  assert.deepEqual(ad.angles, draftCreative(BRIEF));
  assert.equal(ad.headline, draftCreative(BRIEF)[0]!.headline);
});
