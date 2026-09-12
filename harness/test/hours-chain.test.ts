// THE MEASUREMENT THAT COULD NOT RUN, AND THE FOUR LINKS THAT NOW FEED IT.
//
// `value-measure.ts` held the method from the day it was written and was reachable only from its own
// tests — not because it was forgotten, but because it needs `humanHours` and NOTHING IN THE SYSTEM
// PRODUCED THAT NUMBER. The measurement was built before its input existed, which is the same defect
// as an unwired feature wearing a more flattering shape.
//
// The chain: research finds what the trade actually takes → `draft_service` copies it onto the job →
// the submit route stamps it on the version → `GET /v1/value` reports hours saved.
//
// Each link refuses to invent. A missing figure is counted as unestimated; a guessed one gets
// multiplied by the founder's rate and shown to them as what this saved, which is the number they
// repeat to a buyer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { measureValue } from "../src/value-measure";

const WEDGE = new URL("../../wedges/business-shaper/", import.meta.url).pathname;
const manifest = JSON.parse(readFileSync(`${WEDGE}wedge.json`, "utf8"));

test("link 1 — the research is asked how long the trade takes", () => {
  const item = manifest.task_types.research_service.output_schema.properties.deliverables.items;
  assert.ok(item.properties.typical_hours, "deliverables carry no hours figure");
  assert.equal(item.properties.typical_hours.type, "number");
  // Not required: a trade that does not publish its hours must still be researchable.
  assert.ok(!item.required.includes("typical_hours"), "an unfindable figure must not fail the research");
  assert.match(item.properties.typical_hours.description, /not how long an agent takes/i);
  assert.match(item.properties.typical_hours.description, /Omit it rather than guess/);
});

test("link 2 — the authored job carries it across", () => {
  const tt = manifest.task_types.draft_service.output_schema.properties
    .manifest.properties.task_types.additionalProperties.properties;
  assert.ok(tt.typical_hours, "an authored job has nowhere to record the hours");
  assert.match(tt.typical_hours.description, /Copy it from the matching/);
  assert.match(tt.typical_hours.description, /Never invent one/);
});

test("link 3 — the kernel stamps it, and a run cannot report its own timings as the trade's", () => {
  const src = readFileSync(new URL("../src/deliverables.routes.ts", import.meta.url).pathname, "utf8");
  // After the `...body` spread, exactly like `review`: a run that put `human_hours` in its JSON
  // would be reporting how long IT took, multiplied by the founder's rate.
  assert.match(src, /version: \{ \.\.\.body, task_id: task\.id, review, human_hours: humanHours \}/);
  assert.match(src, /typical_hours/, "the figure comes off the authored job");
  assert.match(src, /\.catch\(\(\) => undefined\)/, "a manifest we cannot load is a gap, not a refusal");
});

test("link 4 — one item per deliverable, so a revision cannot multiply the savings", () => {
  const src = readFileSync(new URL("../src/server.ts", import.meta.url).pathname, "utf8");
  const at = src.indexOf('app.get("/v1/value"');
  assert.ok(at > 0, "the value route is missing");
  const route = src.slice(at, at + 3200);
  assert.match(route, /listDeliverables/, "it measures deliverables");
  assert.match(route, /v\.version === d\.current_version/, "and only the current version of each");
  // A client asking for changes is work that came back. Counting it would make the unhappiest
  // engagement look like the most valuable one on the page.
  assert.match(route, /change_requested_at/);
  assert.match(route, /d\.status === "withdrawn"/);
});

test("the whole chain, over the shapes the route actually builds", () => {
  // 20 deliverables at 3.5h, all released and none returned: the floor is cleared and the figure is
  // the trade's hours, not ours.
  const items = Array.from({ length: 20 }, (_, i) => ({
    id: `d${i}`,
    kind: "document",
    releasedAt: "2026-09-01T00:00:00Z",
    humanHours: 3.5,
  }));
  const r = measureValue(items, { hourlyRate: 90 });
  assert.equal(r.reportable, true);
  assert.equal(r.hours, 70);
  assert.equal(r.money?.amount, 6300);
  assert.match(r.summary, /70 hours of work reached a client across 20 pieces/);
});

test("a job authored without hours is counted, never valued, and says so", () => {
  const items = Array.from({ length: 20 }, (_, i) => ({
    id: `d${i}`,
    kind: "document",
    releasedAt: "2026-09-01T00:00:00Z",
    // Half the trade published its hours; half did not. The honest answer names the gap rather
    // than quietly averaging over it.
    humanHours: i < 10 ? 4 : undefined,
  }));
  const r = measureValue(items, { hourlyRate: 90 });
  assert.equal(r.productive, 20);
  assert.equal(r.unestimated, 10);
  assert.equal(r.hours, 40, "only the ten with a figure are valued");
  assert.match(r.summary, /10 had no time estimate on file and are NOT counted/);
});

test("work the client sent back is a spent hour, not a saved one", () => {
  const items = [
    ...Array.from({ length: 20 }, (_, i) => ({
      id: `ok${i}`, kind: "document", releasedAt: "2026-09-01T00:00:00Z", humanHours: 2,
    })),
    { id: "back", kind: "document", releasedAt: "2026-09-01T00:00:00Z", rejectedAt: "2026-09-02T00:00:00Z", humanHours: 40 },
  ];
  const r = measureValue(items);
  assert.equal(r.productive, 20);
  assert.equal(r.unproductive, 1);
  assert.equal(r.hours, 40, "the returned piece contributes nothing, however large");
});
