// A WRITE THAT REPLAYS A STALE CONFIG UNDOES EVERY CLEAR SINCE THE HOST WAS WIRED.
//
// `updateConnection` replaces `config` wholesale (`config = COALESCE($3::jsonb, config)`), and the
// worker holds ONE memoised Connection from `wireLinkedInHost` for the life of the process. So
// `{...conn.config, sync_token}` writes a boot-time snapshot back over the row.
//
// Cost: two days of LinkedIn. The health probe cleared `linkedin_unhealthy` and logged `healed`;
// the inbox sync then wrote a sync_token carrying the boot-time config and the stamp was back. The
// tell was that its `at` never moved off 2026-09-03T14:21:04.103Z while clears kept succeeding —
// a real re-stamp writes a fresh timestamp, so an old one reappearing is a replay.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/connect.ts", import.meta.url), "utf8");

/** The body of one exported function, up to the next top-level `export`. */
function bodyOf(name: string): string {
  const at = src.indexOf(`export async function ${name}`);
  assert.ok(at > 0, `${name} not found — this guard is not running`);
  const next = src.indexOf("\nexport ", at + 10);
  return src.slice(at, next === -1 ? src.length : next);
}

test("syncLinkedInInbox re-reads the connection before writing its sync token", () => {
  const body = bodyOf("syncLinkedInInbox");
  assert.match(
    body,
    /getConnection\(conn\.id\)/,
    "the sync token write spreads a config the caller has been holding since boot; " +
      "without a re-read it replays that snapshot over every key changed since, including the breaker",
  );
  assert.doesNotMatch(
    body,
    /config:\s*\{\s*\.\.\.conn\.config/,
    "spreading `conn.config` is the replay — spread the freshly read row instead",
  );
});

test("every writer that merges onto an existing config re-reads it first", () => {
  // The two stamp writers already did this. The one that ran on every tick did not, which is the
  // worst possible distribution of the bug.
  for (const fn of ["persistLinkedInUnhealthy", "persistLinkedInChallenge"]) {
    const at = src.indexOf(`async function ${fn}`);
    assert.ok(at > 0, `${fn} not found`);
    const body = src.slice(at, at + 700);
    assert.match(body, /getConnection\(/, `${fn} merges onto a config it never read back`);
  }
});
