import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * TWO ID COLUMNS ON ONE TABLE, TWO DIFFERENT TYPES
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `tasks.project_id` is `text`. `tasks.id` is `uuid`. `case_id` is `uuid`, `client_id` is `text`.
 *
 * `getTasksByIds` was written directly under the project filter and copied its `::text[]` cast.
 * Postgres answered `operator does not exist: uuid = text`, the throw landed inside a Server
 * Component, and Home rendered "Couldn't load this" in production — reported by the founder with a
 * screenshot, because nothing else surfaces a digest.
 *
 * Read as source rather than executed: this suite runs against the in-memory store, which is
 * exactly why the bug reached production. A type error in a SQL string is invisible to every test
 * that never speaks to Postgres, so what is checkable is the cast itself.
 */
const PG = readFileSync(join(import.meta.dirname, "..", "src", "store.pg.ts"), "utf8");

test("an id array is cast to uuid, not text", () => {
  const fn = PG.slice(PG.indexOf("async getTasksByIds"), PG.indexOf("async listTaskFacts"));
  assert.match(fn, /ANY\(\$1::uuid\[\]\)/, "tasks.id is a uuid column — ::text[] throws at the operator");
  assert.match(fn, /UUID_RE\.test/, "one malformed id makes the whole array cast fail, so they are dropped first");
});

test("a project array is cast to text, because THAT column is text", () => {
  // The other half of the trap: copying the uuid cast the other way would break the filter that
  // currently works. Both casts are correct and they are correct for different reasons.
  assert.ok(
    PG.includes("project_id = ANY($${vals.length}::text[])"),
    "the project filter is no longer cast to text[] — tasks.project_id is a text column",
  );
  assert.ok(!PG.includes("project_id = ANY($${vals.length}::uuid[])"), "project_id cast to uuid[]");
});
