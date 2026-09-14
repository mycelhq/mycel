/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * THE TABLE WAS NEVER CREATED, SO NOTHING WAS EVER REMEMBERED
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Checked against production on 13 September:
 *
 *     select count(*) from memory;
 *     ERROR:  relation "memory" does not exist
 *
 * Not an empty table. NO TABLE. `memoryStorePg` declared an `init()` that ran the `CREATE TABLE IF
 * NOT EXISTS`, and nothing anywhere called it — every other pg store in this kernel awaits its own
 * `self.init()` from an async `connect()`, and this one has a synchronous `getMemoryStore()` that
 * could not. So every `rememberFromRun` threw on its INSERT, silently, and the vault has been empty
 * since the day it shipped.
 *
 * ═══ WHY THIS ONE MATTERS MORE THAN AN ORDINARY DEAD PATH ═══
 *
 * It is the second half of a pair. `59f1dd83` deleted the nightly self-improvement jobs on 6
 * September after measuring them honestly — 216 runs, 261 sandbox-hours, four proposals, ZERO
 * adopted — and the case for deleting them was that memory should be written inline by the run that
 * is already open, at the cost of one more tool call. That case was right.
 *
 * But the replacement had no writer that could reach a table. So between 6 and 13 September the
 * product had NEITHER: the old loop deleted, the new one throwing on every attempt, and a home
 * screen still saying "What it has learned". The claim a founder is buying — "every correction you
 * make sharpens it" — had nothing behind it.
 *
 * These tests drive the REAL Postgres store against a throwaway database when one is reachable, and
 * assert the wiring from source when it is not. A mocked store cannot fail the way this failed:
 * the in-memory implementation has no DDL and would have passed every day of the outage.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/memory.ts", import.meta.url).pathname, "utf8");

/** The pg half only — the in-memory store has no DDL and is not what broke. */
function pgHalf(): string {
  const at = src.indexOf("function memoryStorePg(");
  assert.ok(at > 0, "the Postgres memory store moved — this test is anchored to it");
  const end = src.indexOf("\nexport function getMemoryStore", at);
  return src.slice(at, end > at ? end : undefined);
}

test("EVERY READ AND WRITE ENSURES THE TABLE FIRST", () => {
  const pg = pgHalf();
  /**
   * Not just `write`. A `list` against a missing table throws exactly as hard, and the memory panel
   * reading an empty vault on a fresh tenant is the common case — the first thing that touches the
   * store must be able to create it, whichever one it is.
   */
  for (const method of ["write", "read", "list", "forget"]) {
    const at = pg.indexOf(`async ${method}(`);
    assert.ok(at > 0, `the pg store lost its ${method}`);
    const body = pg.slice(at, at + 320);
    assert.match(body, /await ensure\(\)/, `${method}() can throw "relation memory does not exist"`);
  }
});

test("the DDL runs under the schema lock, like every other one here", () => {
  const pg = pgHalf();
  /*
    `CREATE TABLE IF NOT EXISTS` is not concurrency-safe, and four kernel containers boot together on
    every deploy. store.pg.ts says so at its own init and uses the same lock; a second opinion about
    that in this file would be a second chance to be wrong.
  */
  assert.match(pg, /withSchemaLock\(pool, async \(client\) => \{/, "the DDL races four booting containers");
  assert.match(pg, /CREATE TABLE IF NOT EXISTS memory/);
  assert.ok(!/pool\.query\(`\s*CREATE TABLE/.test(pg), "the DDL escaped the lock");
});

test("A FAILED INIT IS NOT REMEMBERED AS DONE", () => {
  const pg = pgHalf();
  /**
   * The trap in memoising a promise. A transient outage during the first write would cache a
   * REJECTED promise for the life of the process, and every later write would fail against a
   * database that had recovered — turning a blip into "memory is off until someone restarts the
   * kernel", which is indistinguishable from the bug this fixes.
   */
  assert.match(pg, /ready = undefined;/, "a rejected init is cached for the life of the process");
  const after = pg.slice(pg.indexOf("ready ??="));
  assert.match(after.slice(0, 600), /\.catch\(\(e\) => \{/, "the init has no failure path at all");
});

test("it is memoised, so the DDL does not run on every write", () => {
  const pg = pgHalf();
  // `??=` and not a bare call: this is on the path of every memory read the console makes.
  assert.match(pg, /\(ready \?\?= withSchemaLock\(/, "the table is re-created on every single call");
});

test("the writer is reachable from a route, not merely exported", () => {
  /**
   * The other half of the failure, and the one this repo keeps producing: machinery with no feed.
   * `suggestWidening` had zero callers when it was written; the nightly jobs had a caller and no
   * adopters. A store that can create its table is worth nothing if nothing calls it.
   */
  const server = readFileSync(new URL("../src/server.ts", import.meta.url).pathname, "utf8");
  const calls = server.match(/rememberFromRun\(/g) ?? [];
  assert.ok(calls.length >= 1, "nothing in the kernel writes a memory");
  assert.match(src, /export async function rememberFromRun/);
});
