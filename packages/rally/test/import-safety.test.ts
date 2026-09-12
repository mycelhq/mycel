import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importFromPostgres } from "../src/import";
import { addSeat, assignUnassigned, funnel, open, setTargetState, upsertTarget } from "../src/store";

const db = () => open(join(mkdtempSync(join(tmpdir(), "rally-")), "t.db"));

/** A stand-in for the product's Postgres. */
const fakePg = (rows: Record<string, unknown>[]) => ({ query: async () => ({ rows }) });
const person = (k: string, over: Record<string, unknown> = {}) => ({
  key: k, name: k, title: "Maker", li: `https://www.linkedin.com/in/${k}`,
  role: "maker", via: "ph:daily:2026-09-07", product: "Thing", avatar_url: null,
  ph_url: null, x_handle: null, ...over,
});

// ═══ THE FOUNDER'S WORK IS NOT THE IMPORT'S TO EDIT ═══
//
// "Don't crush my updates when adding leads." Adding people and recording what happened to people
// are different jobs, and the second one is the only record that a real invitation was sent from a
// real account. An import that resets it destroys the only copy.
test("importing new leads never touches a worked lead's status", async () => {
  const d = db();
  addSeat(d, "me");
  addSeat(d, "sibling1");

  for (const k of ["a", "b", "c"]) upsertTarget(d, { personKey: k, name: k, headline: null, linkedinUrl: "https://x/" + k });
  assignUnassigned(d, ["me", "sibling1"]);

  // The founder works three of them.
  setTargetState(d, "a", "invited", "invited_at");
  setTargetState(d, "b", "accepted", "accepted_at");
  setTargetState(d, "c", "replied", "replied_at");
  const seatOf = (k: string) => String(d.prepare(`SELECT seat FROM targets WHERE person_key=?`).get(k)?.seat);
  const seats0 = { a: seatOf("a"), b: seatOf("b"), c: seatOf("c") };

  // A later scrape brings the same three back, plus new people.
  await importFromPostgres(d, fakePg([person("a"), person("b"), person("c"), person("d"), person("e")]) as never);

  const state = (k: string) => String(d.prepare(`SELECT state FROM targets WHERE person_key=?`).get(k)?.state);
  assert.equal(state("a"), "invited");
  assert.equal(state("b"), "accepted");
  assert.equal(state("c"), "replied");
  assert.deepEqual({ a: seatOf("a"), b: seatOf("b"), c: seatOf("c") }, seats0, "and they stay on the same account");
  assert.equal(state("d"), "queued", "the new ones arrive unworked");

  const stamps = d.prepare(`SELECT invited_at, accepted_at, replied_at FROM targets WHERE person_key='a'`).get();
  assert.ok(stamps?.invited_at, "the timestamp survives too — it is what the daily count reads");
});

// The retire pass exists to drop people closed upstream. It must only ever take untouched rows.
test("retiring people who left the upstream list spares anyone already worked", async () => {
  const d = db();
  addSeat(d, "me");
  for (const k of ["kept", "worked", "gone"]) upsertTarget(d, { personKey: k, name: k, headline: null, linkedinUrl: "https://x/" + k });
  assignUnassigned(d, ["me"]);
  setTargetState(d, "worked", "invited", "invited_at");

  // Upstream now returns only `kept` — both `worked` and `gone` have left the live list.
  const r = await importFromPostgres(d, fakePg([person("kept")]) as never);

  const rows = d.prepare(`SELECT person_key FROM targets ORDER BY person_key`).all().map((x) => String(x.person_key));
  assert.deepEqual(rows, ["kept", "worked"], "`gone` was queued and is dropped; `worked` is kept");
  assert.equal(r.retired, 1);
});

// Re-assignment is how a new account gets a share. It must not move somebody mid-conversation.
test("assigning new leads to a new account leaves worked rows where they are", () => {
  const d = db();
  addSeat(d, "me");
  for (const k of ["x", "y"]) upsertTarget(d, { personKey: k, name: k, headline: null, linkedinUrl: "https://x/" + k });
  assignUnassigned(d, ["me"]);
  setTargetState(d, "x", "messaged", "messaged_at");

  addSeat(d, "newseat");
  upsertTarget(d, { personKey: "z", name: "z", headline: null, linkedinUrl: "https://x/z" });
  const moved = assignUnassigned(d, ["me", "newseat"]);

  assert.equal(moved, 1, "only the unassigned newcomer is placed");
  assert.equal(String(d.prepare(`SELECT seat FROM targets WHERE person_key='x'`).get()?.seat), "me");
  assert.equal(funnel(d).messaged, 1, "and the funnel still counts the work");
});
