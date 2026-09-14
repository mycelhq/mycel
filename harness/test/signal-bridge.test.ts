// The detector and the scorer had no word in common.
//
// `gtm/signals.ts` emits hiring_mention | job_change | open_to_work. `signal-score.mjs` scores
// twelve types and none of them are those three. So every signal the product has ever detected was
// unscoreable by construction — it would land in the scorer's `unknown` bucket, which exists to
// report a feed nobody configured, not a feed that works.
//
// The test that matters is the end-to-end one: a real detector output must come out of the scorer
// in `act`, with a window to act inside.

import test from "node:test";
import assert from "node:assert/strict";

import { bridgeSignal, bridgeText, observedSignalFor } from "../src/gtm/signal-bridge";
import signalScore from "../../library/workflows/signal-score.mjs";

const NOW = "2026-09-14";

test("bridge: a job change is the champion-moved signal, the strongest one there is", () => {
  const b = bridgeSignal("job_change", "Excited to announce I joined Northwind as Head of Ops");
  assert.equal(b.type, "champion_moved");
  assert.match(b.because, /no incumbent/);
});

test("bridge: a senior req is a leadership hire, an ordinary one is a role surge", () => {
  // Weight 85 with a 10-day half-life against 60 with 14. Scoring a junior req as leadership puts
  // it above a genuine funding round and spends the founder's best hour on it.
  assert.equal(bridgeSignal("hiring_mention", "We're hiring a Head of Marketing").type, "leadership_hire");
  assert.equal(bridgeSignal("hiring_mention", "We're hiring two more installers").type, "role_surge");
});

test("bridge: open to work is never scoreable, and says why", () => {
  // signals.ts already ranks this above job_change when both match: "excited to announce I'm open
  // to work" is a job LOSS. They also cannot buy — they no longer hold the budget.
  const b = bridgeSignal("open_to_work", "Open to work after five years at Acme");
  assert.equal(b.type, null);
  assert.match(b.because, /never act on it/);
});

test("bridge: an unknown kind fails closed rather than guessing a catalogue entry", () => {
  assert.equal(bridgeSignal("moon_phase", "anything").type, null);
});

test("bridge: raw text goes detector -> catalogue in one hop", () => {
  assert.equal(bridgeText("We're hiring a VP of Sales")?.type, "leadership_hire");
  assert.equal(bridgeText("had a nice lunch"), null);
});

// ── The join that did not exist ─────────────────────────────────────────────

test("bridge: a detected signal reaches the scorer's ACT list, not its unknown bucket", () => {
  const person = {
    signal: "job_change",
    signal_evidence: "Excited to share I joined Harts Bakery as Operations Director",
    signal_at: "2026-09-12",
    company: "Hart's Bakery",
    company_domain: "hartsbakery.co.uk",
  };
  const observed = observedSignalFor(person)!;
  assert.ok(observed, "a job change must be scoreable");

  const r = signalScore({ now: NOW, signals: [observed] });
  assert.equal(r.counts.unknown, 0, `the scorer did not recognise it: ${JSON.stringify(r.unknown)}`);
  assert.equal(r.counts.act, 1, `expected one actionable account, got ${JSON.stringify(r.counts)}`);
  assert.ok(r.act[0]!.act_by_days > 0, "an actionable signal has a window left");
  assert.match(r.act[0]!.lead_with, /.+/, "and something the opener must name");
});

test("bridge: an open-to-work row never reaches the scorer at all", () => {
  // Not "reaches it and scores zero". The unknown bucket means a misconfigured feed; a deliberate
  // refusal must not look like one.
  assert.equal(observedSignalFor({ signal: "open_to_work", signal_evidence: "open to work" }), null);
  assert.equal(observedSignalFor({ signal: "", signal_evidence: "" }), null);
});

test("bridge: a stale detection is refused by the scorer, which is the half that matters", () => {
  // champion_moved dies at 120 days. "We noticed you moved" eight months later is not a weak
  // message, it is evidence nobody was paying attention.
  const observed = observedSignalFor({
    signal: "job_change",
    signal_evidence: "joined as Head of Ops",
    signal_at: "2025-11-01",
    company: "Hart's Bakery",
  })!;
  const r = signalScore({ now: NOW, signals: [observed] });
  assert.equal(r.counts.act, 0, "a year-old move must not be actionable");
  assert.equal(r.counts.stale, 1);
});

test("bridge: a signal with no timestamp is not passed off as fresh", () => {
  // Freshness is the entire point of the scorer. Inventing `observed_at` here would make every
  // undated row outrank a real one from yesterday.
  const observed = observedSignalFor({ signal: "job_change", signal_evidence: "joined", company: "X" })!;
  assert.equal("observed_at" in observed, false);
});
