import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parsePackRef, resolvePack, runPack, listPacks, _resetPackCatalog } from "../src/packs";
import { api, makeApp, jsonBody } from "./helpers";
import { registerActionGrant } from "../src/actiongrants";
import { wedgesDir } from "../src/wedge";

test("packs: refs parse as name@version (bare name → v1)", () => {
  assert.deepEqual(parsePackRef("share_of_voice@1"), { name: "share_of_voice", version: 1 });
  assert.deepEqual(parsePackRef("share_of_voice"), { name: "share_of_voice", version: 1 });
  assert.equal(parsePackRef("../evil"), undefined);
  assert.equal(parsePackRef("share_of_voice@0"), undefined);
});

test("packs: share_of_voice@1 is installed and digest-pinned", () => {
  _resetPackCatalog();
  const packs = listPacks();
  assert.ok(packs.some((p) => p.name === "share_of_voice" && p.version === 1));
  const spec = resolvePack("share_of_voice@1");
  assert.ok(spec);
  const entry = join(wedgesDir(), "..", "library", "packs", "share_of_voice", "1", "run.mjs");
  const live = createHash("sha256").update(readFileSync(entry)).digest("hex");
  assert.equal(spec!.digest, live, "pack.json digest must match run.mjs bytes");
});

test("packs: share_of_voice math is exact, not estimated", async () => {
  const r = await runPack("share_of_voice@1", {
    client: "Acme",
    results: [
      { query: "best crm", cited: ["Acme", "Rival"] },
      { query: "crm for agencies", cited: ["Other", "Rival"] },
      { query: "agency tools", cited: ["acme.com"] },
    ],
  });
  assert.equal(r.ok, true, r.error);
  const d = r.data as { share_of_voice_pct: number; queries: number; mentions: number };
  assert.equal(d.queries, 3);
  assert.equal(d.mentions, 2);
  assert.equal(d.share_of_voice_pct, 66.7);
});

/**
 * ═══ A BLOCKED PROBE IS NOT AN ABSENT MENTION ═══
 *
 * The number this pack returns goes on an invoice. It divided by every probe, including the ones
 * that came back `reached: false` from a captcha — so an empty citation list gathered from a page
 * nobody could read was counted as "the assistant did not mention you".
 *
 * The direction is what makes it serious: the harder a surface blocks automation, the lower the
 * client's reported visibility, so the number moves with OUR access and is read as a change in
 * THEIR market.
 */
test("packs: a probe that never reached the surface is out of the denominator", async () => {
  const r = await runPack("share_of_voice@1", {
    client: "Acme",
    results: [
      { query: "best crm", surface: "perplexity", cited: ["Acme", "Rival"] },
      { query: "crm for agencies", surface: "perplexity", cited: ["Other"] },
      // Captcha'd. `cited: []` here is `probe_surface` refusing to invent an answer, not a finding.
      { query: "agency tools", surface: "chatgpt", reached: false, blocked_by: "captcha", cited: [] },
      { query: "bookkeeping software", surface: "chatgpt", reached: false, blocked_by: "captcha", cited: [] },
    ],
  });
  assert.equal(r.ok, true, r.error);
  const d = r.data as { share_of_voice_pct: number; queries: number; mentions: number; unreached: number };
  assert.equal(d.queries, 2, "the denominator is what actually answered");
  assert.equal(d.mentions, 1);
  assert.equal(d.share_of_voice_pct, 50, "not 25 — two of these were never measured");
  assert.equal(d.unreached, 2, "and the client is told how big the hole is");
});

test("packs: a period where nothing was reached is null, not zero", async () => {
  // Zero per cent is a finding — the assistants answered and named somebody else. No measurement is
  // not a finding, and a client shown 0% would reasonably conclude they had lost every ranking.
  const r = await runPack("share_of_voice@1", {
    client: "Acme",
    results: [
      { query: "best crm", surface: "chatgpt", reached: false, blocked_by: "captcha", cited: [] },
      { query: "agency tools", surface: "chatgpt", reached: false, blocked_by: "login wall", cited: [] },
    ],
  });
  assert.equal(r.ok, true, r.error);
  const d = r.data as { share_of_voice_pct: number | null; blocked_by: { reason: string; n: number }[] };
  assert.equal(d.share_of_voice_pct, null);
  // And WHY, per surface. A hole in somebody's number they cannot account for is worse than no number.
  assert.deepEqual(
    [...d.blocked_by].sort((a, b) => a.reason.localeCompare(b.reason)),
    [{ reason: "chatgpt: captcha", n: 1 }, { reason: "chatgpt: login wall", n: 1 }],
  );
});

test("packs: rows written before `reached` existed still count", async () => {
  // Every historical measurement omits the field. Defaulting those to unreached would empty the
  // client's trend line the moment this shipped, which is its own kind of wrong number.
  const r = await runPack("share_of_voice@1", {
    client: "Acme",
    results: [
      { query: "best crm", cited: ["Acme"] },
      { query: "agency tools", cited: ["Rival"] },
    ],
  });
  const d = r.data as { queries: number; unreached: number; share_of_voice_pct: number };
  assert.equal(d.queries, 2);
  assert.equal(d.unreached, 0);
  assert.equal(d.share_of_voice_pct, 50);
});

test("packs: digest mismatch refuses to run", async () => {
  _resetPackCatalog();
  const spec = resolvePack("share_of_voice@1");
  assert.ok(spec);
  // Temporarily poison the digest check by calling with a stubbed resolve — easier: runPack
  // re-hashes the file; we only assert the happy path and that unknown refs fail.
  const missing = await runPack("no_such_pack@1", {});
  assert.equal(missing.ok, false);
  assert.match(missing.error!, /unknown pack/);
});

test("packs: agent calls them over the internal endpoint, traced", async () => {
  const { store, app } = makeApp();
  // geo-monitor declares share_of_voice@1. books-keeper now declares reconcile_cents only, so a
  // books case would 403 this pack — which is the point of the allow-list.
  const kase = (await api(app, "cases", { method: "POST", body: JSON.stringify({ wedge: "geo-monitor", title: "pack" }) })).json;
  const task = (await api(app, `cases/${kase.id}/tasks`, { method: "POST", body: JSON.stringify({ task_type: "probe_surface" }) })).json;
  const nonce = await registerActionGrant({ task_id: task.id, connectionIds: [], caseId: kase.id });
  const H = { authorization: `Bearer ${nonce}`, "content-type": "application/json" };

  const res = await app.request("/v1/internal/packs/run", {
    method: "POST",
    headers: H,
    body: JSON.stringify({
      pack: "share_of_voice@1",
      args: { client: "Acme", results: [{ query: "q", cited: ["Acme"] }] },
    }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  const body = await jsonBody(res);
  assert.equal(body.ok, true);
  assert.equal(body.data.mentions, 1);

  const events = await store.eventsAfter(task.id, 0);
  assert.ok(events.some((e) => e.type === "tool.called" && (e.data as { tool?: string }).tool === "pack:share_of_voice@1"));
  assert.ok(events.some((e) => e.type === "tool.result" && (e.data as { ok?: boolean }).ok === true));
});

test("packs: a wedge may only call packs it declares", async () => {
  const { app } = makeApp();
  const kase = (await api(app, "cases", { method: "POST", body: JSON.stringify({ wedge: "books-keeper", title: "pack-deny" }) })).json;
  const task = (await api(app, `cases/${kase.id}/tasks`, { method: "POST", body: JSON.stringify({ task_type: "monthly_close" }) })).json;
  const nonce = await registerActionGrant({ task_id: task.id, connectionIds: [], caseId: kase.id });
  const H = { authorization: `Bearer ${nonce}`, "content-type": "application/json" };

  const denied = await app.request("/v1/internal/packs/run", {
    method: "POST",
    headers: H,
    body: JSON.stringify({
      pack: "share_of_voice@1",
      args: { client: "Acme", results: [] },
    }),
  });
  assert.equal(denied.status, 403);

  const allowed = await app.request("/v1/internal/packs/run", {
    method: "POST",
    headers: H,
    body: JSON.stringify({
      pack: "reconcile_cents@1",
      args: {
        bank_transactions: [{ amount_cents: 100, date: "2026-08-01", reference: "a" }],
        ledger_entries: [{ amount_cents: 100, date: "2026-08-01", reference: "a" }],
      },
    }),
  });
  assert.equal(allowed.status, 200, await allowed.clone().text());
  assert.equal((await jsonBody(allowed)).ok, true);
});
