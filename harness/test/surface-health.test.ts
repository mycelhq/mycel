// A measurement service has to know when it cannot measure.
//
// `probe_surface` reports `reached: false` honestly, one probe at a time, and nothing was keeping
// those. So the same wall was rediscovered every run, and the founder was never told why their
// report had a hole in it — which they then find out about in the client meeting.
import { test } from "node:test";
import assert from "node:assert/strict";
import { foldProbe, noteProbe, surfaceWarnings, PERSISTENT_BLOCK, SURFACE_HEALTH_COLLECTION } from "../src/surface-health";
import type { SurfaceHealth } from "../src/surface-health";

const AT = "2026-08-30T20:00:00Z";

test("a block increments the streak and records why", () => {
  const a = foldProbe(undefined, { surface: "chatgpt", reached: false, blocked_by: "captcha", at: AT });
  assert.equal(a.blocked_streak, 1);
  assert.equal(a.last_blocked_by, "captcha");
  assert.equal(a.reached, false);
  // Never reached is not the same as stopped reaching, and the field must not invent a date.
  assert.equal(a.last_reached_at, undefined);

  const b = foldProbe(a, { surface: "chatgpt", reached: false, blocked_by: "captcha", at: "2026-08-31T20:00:00Z" });
  assert.equal(b.blocked_streak, 2);
});

test("one success clears the streak outright", () => {
  /**
   * NOT DECAYED, CLEARED.
   *
   * These blocks are probabilistic — a surface that let one probe through is reachable. Carrying a
   * decayed count would keep warning a founder about a wall that is not there any more, and a
   * warning that is usually wrong is a warning nobody reads when it is right.
   */
  const blocked = { surface: "perplexity", blocked_streak: 6, last_blocked_by: "Cloudflare Turnstile challenge" };
  const ok = foldProbe(blocked, { surface: "perplexity", reached: true, at: AT });
  assert.equal(ok.blocked_streak, 0);
  assert.equal(ok.last_reached_at, AT);
  assert.equal(ok.last_blocked_by, undefined, "a stale reason on a reachable surface is a lie");
});

test("the last successful probe survives a later block", () => {
  // "It stopped working on the 12th" is the sentence a founder needs. Dropping the date on the next
  // failure would leave only "it is not working", which is the same fact with the useful half gone.
  const ok = foldProbe(undefined, { surface: "claude", reached: true, at: "2026-08-12T09:00:00Z" });
  const bad = foldProbe(ok, { surface: "claude", reached: false, blocked_by: "sign-in wall", at: AT });
  assert.equal(bad.last_reached_at, "2026-08-12T09:00:00Z");
  assert.equal(bad.blocked_streak, 1);
});

test("one refusal is not a warning", () => {
  // Surfaces refuse single probes for all sorts of reasons. Warning on the first would train the
  // founder to ignore this, which costs the warning that matters.
  const rows: Partial<SurfaceHealth>[] = [{ surface: "chatgpt", blocked_streak: PERSISTENT_BLOCK - 1 }];
  assert.deepEqual(surfaceWarnings(rows), []);
});

test("a persistent block says what it is, since when, and what the report will do", () => {
  const rows: Partial<SurfaceHealth>[] = [
    { surface: "chatgpt", blocked_streak: 9, last_blocked_by: "captcha", last_reached_at: "2026-08-12T09:00:00Z" },
    { surface: "claude", blocked_streak: 4, last_blocked_by: "Cloudflare Turnstile challenge" },
  ];
  const w = surfaceWarnings(rows);
  assert.equal(w.length, 2);
  assert.equal(w[0]!.surface, "chatgpt", "worst first");
  assert.match(w[0]!.says, /ChatGPT has blocked the last 9 probes \(captcha\)/);
  assert.match(w[0]!.says, /Last answer was 2026-08-12/);
  // A surface with no history reads differently, and the difference is what the founder tells a
  // client: one is a regression, the other is a surface this client was never covered on.
  assert.match(w[1]!.says, /never returned an answer for this client/);
  assert.ok(!w[1]!.says.includes("Last answer"));
});

test("a probe with no surface names nothing and is dropped", async () => {
  // An output that failed validation can arrive here. Writing a row keyed on "" would collect every
  // malformed probe into one meaningless record that then warns about a surface called nothing.
  const calls: unknown[] = [];
  const store = {
    upsertRecord: async (r: unknown) => { calls.push(r); return r; },
    queryRecords: async () => [],
  };
  await noteProbe(store, { project_id: "p", output: { reached: false } });
  await noteProbe(store, { project_id: "p", output: { surface: "  ", reached: false } });
  await noteProbe(store, { project_id: "", output: { surface: "chatgpt", reached: false } });
  assert.deepEqual(calls, []);
});

test("a probe is keyed by surface, so a project keeps one row per engine", async () => {
  const written: Record<string, unknown>[] = [];
  const store = {
    upsertRecord: async (r: Record<string, unknown>) => { written.push(r); return r; },
    queryRecords: async () => written.map((w) => ({ data: w.data })),
  };
  await noteProbe(store, { project_id: "p", output: { surface: "chatgpt", reached: false, blocked_by: "captcha" }, at: AT });
  await noteProbe(store, { project_id: "p", output: { surface: "chatgpt", reached: false, blocked_by: "captcha" }, at: AT });
  await noteProbe(store, { project_id: "p", output: { surface: "perplexity", reached: true }, at: AT });

  assert.equal(written.length, 3);
  assert.deepEqual(written.map((w) => w.key), ["chatgpt", "chatgpt", "perplexity"]);
  assert.equal(written[0]!.collection, SURFACE_HEALTH_COLLECTION);
  // The second chatgpt probe read the first one's row, so the streak accumulates across runs rather
  // than resetting to 1 every time — which is the entire point of storing it.
  assert.equal((written[1]!.data as SurfaceHealth).blocked_streak, 2);
  assert.equal((written[2]!.data as SurfaceHealth).blocked_streak, 0);
});

test("an output with no `reached` field is treated as unreached", async () => {
  // `reached` is required by the schema, so its absence means a shape nobody validated. The safe
  // reading is "we did not get an answer": being wrong the other way produces a report that claims
  // a measurement it does not have, which is the failure this whole area exists to prevent.
  const written: Record<string, unknown>[] = [];
  const store = {
    upsertRecord: async (r: Record<string, unknown>) => { written.push(r); return r; },
    queryRecords: async () => [],
  };
  await noteProbe(store, { project_id: "p", output: { surface: "chatgpt" }, at: AT });
  assert.equal((written[0]!.data as SurfaceHealth).reached, false);
  assert.equal((written[0]!.data as SurfaceHealth).blocked_streak, 1);
});
