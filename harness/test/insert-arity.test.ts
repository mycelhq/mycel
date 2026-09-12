import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * EVERY `INSERT` NAMES AS MANY COLUMNS AS IT SUPPLIES EXPRESSIONS.
 *
 * ─── The bug, which shipped and ran in production ─────────────────────────────────────────────
 *
 * `authored.pg.ts` wrote:
 *
 *   INSERT INTO authored_wedges
 *     (id, project_id, slug, title, manifest, skills, knowledge, status, described_as, notices, source_task_id)
 *   VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,'drafted',$8,$9)
 *
 * Eleven columns, ten expressions. `notices` had been added to the column list and to the `SET` on
 * the conflict branch, and never to `VALUES`. Postgres refuses that outright — "INSERT has more
 * target columns than expressions" — so saving a drafted service failed every time.
 *
 * ─── Why the existing tests could not see it ──────────────────────────────────────────────────
 *
 * `authored-pg.test.ts` is a good test file. It uses a fake `Queryable` that records statements, and
 * asserts things like "the tenant is named in the WHERE clause" and "the status guard is on the
 * UPDATE". Those are the properties worth checking and they are checked well.
 *
 * They are also all assertions about a STRING. Nothing in that file — or in any of the `*-pg` test
 * files, which share the seam — ever parses the SQL, so a statement that is not valid SQL passes
 * every one of them. The seam exists precisely because there is no Postgres in this environment,
 * which is the same reason nothing notices when the SQL is wrong.
 *
 * This test is the cheapest thing that closes that gap: it does not need a database, it does not
 * need a parser, and it catches the one mistake that the fake `Queryable` structurally cannot.
 *
 * ─── What it deliberately does not do ─────────────────────────────────────────────────────────
 *
 * It is not a SQL validator and should not become one. It checks one arithmetic property of one
 * statement shape. A statement it cannot confidently split is SKIPPED rather than guessed at — a
 * guard that reports a false positive on a correct query is a guard somebody disables.
 */

const SRC = new URL("../src/", import.meta.url).pathname;

/** Top-level commas only: `numeric(10, 2)` and `COALESCE(a, b)` are not column boundaries. */
function splitTopLevel(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    const ch = list[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(list.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(list.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** The body of a parenthesised group starting at `open`, respecting nesting. */
function balanced(sql: string, open: number): { body: string; end: number } | null {
  let depth = 0;
  for (let i = open; i < sql.length; i++) {
    if (sql[i] === "(") depth++;
    else if (sql[i] === ")" && --depth === 0) return { body: sql.slice(open + 1, i), end: i };
  }
  return null;
}

test("no INSERT has more target columns than expressions", () => {
  const offenders: string[] = [];

  for (const file of readdirSync(SRC).filter((f) => f.endsWith(".pg.ts"))) {
    const src = readFileSync(join(SRC, file), "utf8")
      // SQL lives in template literals and this codebase comments heavily inside them.
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/^\s*\/\/.*$/gm, " ")
      .replace(/--[^\n]*/g, " ");

    for (const m of src.matchAll(/INSERT\s+INTO\s+([\w.]+)\s*\(/gi)) {
      const columns = balanced(src, m.index + m[0].length - 1);
      if (!columns) continue;

      // `VALUES` has to be the next thing. An `INSERT … SELECT` has no expression list to count and
      // is skipped rather than guessed at.
      const after = src.slice(columns.end + 1, columns.end + 40);
      if (!/^\s*VALUES\s*\(/i.test(after)) continue;

      const valuesOpen = src.indexOf("(", columns.end + 1);
      const values = balanced(src, valuesOpen);
      if (!values) continue;

      const names = splitTopLevel(columns.body);
      const exprs = splitTopLevel(values.body);

      // A multi-row insert repeats the expression group; only single-row statements are compared,
      // because splitting `VALUES (a,b),(c,d)` correctly is the start of writing a parser.
      if (/\)\s*,\s*\(/.test(values.body) || /^\s*,\s*\(/.test(src.slice(values.end + 1, values.end + 4))) {
        continue;
      }

      if (names.length !== exprs.length) {
        offenders.push(
          `${file}: INSERT INTO ${m[1]} names ${names.length} columns and supplies ${exprs.length} ` +
            `expressions (${names.length > exprs.length ? "missing" : "extra"}: ` +
            `${Math.abs(names.length - exprs.length)})`,
        );
      }
    }
  }

  assert.deepEqual(offenders, [], `Postgres refuses these outright:\n${offenders.join("\n")}`);
});

test("the check can actually count, on a statement shaped like the one that broke", () => {
  /**
   * A guard that runs and finds nothing is indistinguishable from a guard that cannot find anything,
   * and this repo has shipped both. So the splitter is exercised directly on the real statement's
   * shape, including the two things that would make a naive version wrong: a cast inside an
   * expression and a literal where a placeholder would be.
   */
  const columns = "id, project_id, slug, title, manifest, skills, knowledge, status, described_as, notices, source_task_id";
  const broken = "$1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,'drafted',$8,$9";
  const fixed = "$1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,'drafted',$8,$9::jsonb,$10";

  assert.equal(splitTopLevel(columns).length, 11);
  assert.equal(splitTopLevel(broken).length, 10, "this is what shipped");
  assert.equal(splitTopLevel(fixed).length, 11, "this is what it should have been");

  // And a comma inside a call is not a boundary, which is the thing that would produce false alarms.
  assert.equal(splitTopLevel("a, COALESCE(b, c), d").length, 3);
});
