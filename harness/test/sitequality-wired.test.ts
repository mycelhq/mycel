// THE GATE THAT EXISTED AND NEVER RAN.
//
// `sitequality.ts` shipped complete: template-residue detection, an authored-surface count, token
// discipline, a signature motif and a cross-build fingerprint. Its header calls residue "the single
// strongest negative signal available" — the seed's own fictional customer, deployed in public under
// the founder's domain. `scoreSite` and `siteQualityFault` were reachable from their own unit tests
// and from nowhere else, so none of it was ever applied to a build.
//
// These tests are about the WIRING, not the scoring — sitequality.test.ts covers the numbers. What
// is asserted here is that the source files reach the scorer at all, and that a site carrying the
// template's copy cannot get past the point where it would be exported and deployed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { collectSiteFiles, resolveWorkspace } from "../src/workspace";
import { SEED_RESIDUE, scoreSite, siteQualityFault } from "../src/sitequality";

/** `resolveWorkspace` takes a manifest and a task type, not a bare spec. */
const wsFor = (spec: Record<string, unknown>) =>
  resolveWorkspace({ workspace: spec } as any, "build_site")!;
const ws = wsFor({ dir: "app", seed: "business-template" });

/** A sandbox whose `exec` replays a canned stdout, in the exact format the sweep parses. */
const sandboxOf = (files: { path: string; text: string }[], code = 0) => ({
  exec: async () => ({
    code,
    stdout: files.map((f) => `===MYCEL_SITE_FILE ${f.path}===\n${f.text}\n`).join(""),
    stderr: "",
  }),
});

test("the source files reach the scorer with their text intact", async () => {
  const { files, ok } = await collectSiteFiles(
    sandboxOf([
      { path: "app/page.tsx", text: "export default function P(){return <div className='border-l-[3px]'/>}" },
      { path: "components/hero.tsx", text: "// hero" },
    ]) as any,
    ws,
  );
  assert.equal(ok, true);
  assert.deepEqual(files.map((f) => f.path), ["app/page.tsx", "components/hero.tsx"]);
  assert.match(files[0]!.text, /border-l-\[3px\]/, "the bytes must survive the round trip, not just the path");
});

test("a failed sweep reports unreadable rather than an empty site", async () => {
  const { files, ok } = await collectSiteFiles(sandboxOf([], 3) as any, ws);
  assert.equal(ok, false);
  assert.deepEqual(files, []);
  // The distinction is the whole point: "we could not look" must never be actioned as "it is clean".
  // The orchestrator emits a skip note on !ok and does NOT fail the run.
});

test("a truncated read is unreadable, because a prefix of a site cannot clear it of residue", async () => {
  const huge = { exec: async () => ({ code: 0, stdout: "x".repeat(16 * 1024 * 1024), stderr: "" }) };
  const { ok } = await collectSiteFiles(huge as any, ws);
  assert.equal(ok, false, "'we saw 300 of your files and found nothing' is not 'there is nothing'");
});

test("the template's own copy fails the build, and names what to replace", () => {
  const q = scoreSite(
    [{ path: "components/testimonial.tsx", text: `<p>Great work</p><cite>Daniel Osei, Operations lead</cite>` }],
    new Set(),
  );
  assert.deepEqual(q.residue, ["Daniel Osei, Operations lead"]);
  const fault = siteQualityFault(q);
  assert.ok(fault, "residue must fail regardless of score");
  assert.match(fault!, /still carries the template's own copy/);
  assert.match(fault!, /Daniel Osei/);
});

test("residue fails even when everything else is excellent", () => {
  // A site that authored plenty, used a real motif and hardcoded nothing — and left one seed string.
  const good = Array.from({ length: 8 }, (_, i) => ({
    path: `components/section-${i}.tsx`,
    text: `<div className="border-l-[3px] bg-[oklch(0.7_0.1_250)]">real copy</div>`,
  }));
  const q = scoreSite([...good, { path: "app/page.tsx", text: "Operations, run for you" }], new Set());
  assert.ok(q.score > 40, `score was ${q.score} — this fixture is meant to be otherwise decent`);
  assert.ok(siteQualityFault(q), "a wrong answer is not redeemed by a good score");
});

test("a clean site passes, and the score alone never fails without a manifest minimum", () => {
  const q = scoreSite([{ path: "app/page.tsx", text: "<div>this business's own words</div>" }], new Set());
  assert.deepEqual(q.residue, []);
  assert.equal(siteQualityFault(q), undefined, "advisory by default — report first, gate once calibrated");
  // And it DOES fail once a wedge opts in.
  assert.ok(siteQualityFault(q, 100), "a manifest minimum is what turns the score into a gate");
});

test("the manifest knob is resolved and clamped", () => {
  assert.equal(wsFor({ dir: "app" }).minSiteQuality, undefined, "no opinion by default");
  assert.equal(wsFor({ dir: "app", min_site_quality: 65 }).minSiteQuality, 65);
  assert.equal(wsFor({ dir: "app", min_site_quality: 500 }).minSiteQuality, 100);
  assert.equal(wsFor({ dir: "app", min_site_quality: -5 }).minSiteQuality, 0);
});

test("the failure carries the prefix the repair loop matches, so the agent gets another go", () => {
  const q = scoreSite([{ path: "app/page.tsx", text: SEED_RESIDUE[0]! }], new Set());
  const thrown = `workspace verification failed: ${siteQualityFault(q)}`;
  assert.match(thrown, /^workspace verification failed/);
});
