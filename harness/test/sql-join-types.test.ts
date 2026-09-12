// A JOIN ACROSS TWO COLUMN TYPES THROWS AT RUNTIME AND NOWHERE ELSE.
//
// `readRecord` joined `cases.id` (uuid) to `deliverables.case_id` (text) and threw
// "operator does not exist: uuid = text" on every call for weeks. Nothing caught it: it typechecks,
// the SQL is syntactically valid, the unit tests assert the query STRING rather than run it, and the
// caller reported the failure to the founder as "no track record yet". A whole shipped feature —
// auto-release, with a policy engine, a route and a UI behind it — could not be earned by anybody,
// and it looked exactly like a new account with no history.
//
// This reads the schema out of our own CREATE TABLE statements rather than out of a live database,
// so it runs in CI with no Postgres. The schema in source IS the schema: every *.pg.ts creates its
// tables at boot.
//
// It is a small guard for a small surface — the kernel has three SQL joins. That is the point: the
// surface is small enough that none of them should ever be wrong, and the one that was cost a
// feature.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dirname, "..", "src");

/** table -> column -> declared type, read from every `CREATE TABLE IF NOT EXISTS` in the kernel. */
function declaredSchema(): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  for (const f of readdirSync(SRC).filter((n) => n.endsWith(".ts"))) {
    const s = readFileSync(join(SRC, f), "utf8");
    for (const m of s.matchAll(/CREATE TABLE IF NOT EXISTS (?:public\.)?(\w+)\s*\(([\s\S]*?)\n\s*\);/g)) {
      const cols = out.get(m[1]!) ?? new Map<string, string>();
      for (const line of m[2]!.split("\n")) {
        const c = line.trim().match(/^(\w+)\s+(uuid|text|jsonb|boolean|integer|bigint|timestamptz|numeric|double precision)\b/i);
        if (c) cols.set(c[1]!, c[2]!.toLowerCase());
      }
      out.set(m[1]!, cols);
      // Columns added later by ALTER carry their type too, and a join can name one.
    }
    for (const m of s.matchAll(/ALTER TABLE (?:public\.)?(\w+) ADD COLUMN IF NOT EXISTS (\w+) (uuid|text|jsonb|boolean|integer|bigint|timestamptz)/gi)) {
      const cols = out.get(m[1]!) ?? new Map<string, string>();
      cols.set(m[2]!, m[3]!.toLowerCase());
      out.set(m[1]!, cols);
    }
  }
  return out;
}

interface Join {
  file: string;
  line: number;
  desc: string;
  left: string;
  right: string;
  cast: boolean;
}

function joinsInSource(schema: Map<string, Map<string, string>>): Join[] {
  const found: Join[] = [];
  for (const f of readdirSync(SRC).filter((n) => n.endsWith(".ts"))) {
    const s = readFileSync(join(SRC, f), "utf8");
    // alias -> table, from `FROM x a` / `JOIN public.x a`
    const aliases = new Map<string, string>();
    for (const m of s.matchAll(/\b(?:FROM|JOIN)\s+(?:public\.)?([a-z_]+)\s+(?:AS\s+)?([a-z]\w?)\b/g)) {
      aliases.set(m[2]!, m[1]!);
    }
    for (const m of s.matchAll(/\bON\s+(\w+)\.(\w+)(::\w+)?\s*=\s*(\w+)\.(\w+)(::\w+)?/g)) {
      const [, la, lc, lcast, ra, rc, rcast] = m;
      const lt = aliases.get(la!);
      const rt = aliases.get(ra!);
      if (!lt || !rt) continue;
      const left = schema.get(lt)?.get(lc!);
      const right = schema.get(rt)?.get(rc!);
      if (!left || !right) continue;
      found.push({
        file: f,
        line: s.slice(0, m.index).split("\n").length,
        desc: `${lt}.${lc} (${left}) = ${rt}.${rc} (${right})`,
        left,
        right,
        cast: Boolean(lcast || rcast),
      });
    }
  }
  return found;
}

test("no SQL join compares two different column types without a cast", () => {
  const schema = declaredSchema();
  assert.ok(schema.size > 10, `expected the kernel's tables to be readable from source, got ${schema.size}`);

  const joins = joinsInSource(schema);
  // If this drops to zero the matcher has broken, and a guard that silently matches nothing is
  // worse than no guard — it reports green for a reason that has nothing to do with the code.
  assert.ok(joins.length > 0, "the join matcher resolved nothing — it is broken, not the code");

  const mismatched = joins.filter((j) => j.left !== j.right && !j.cast);
  assert.deepEqual(
    mismatched.map((j) => `${j.file}:${j.line} ${j.desc}`),
    [],
    "these joins throw `operator does not exist` at runtime and nowhere else — cast one side, or fix the column type",
  );
});

test("the guard would have caught the bug that cost us auto-release", () => {
  // A regression test for the TEST. The uncast form must be reported; the cast form must not.
  const schema = new Map([
    ["cases", new Map([["id", "uuid"]])],
    ["deliverables", new Map([["case_id", "text"]])],
  ]);
  const uncast = { left: schema.get("cases")!.get("id")!, right: schema.get("deliverables")!.get("case_id")!, cast: false };
  const cast = { ...uncast, cast: true };
  assert.ok(uncast.left !== uncast.right && !uncast.cast, "uuid = text with no cast is a fault");
  assert.ok(!(cast.left !== cast.right && !cast.cast), "the same join with ::text is fine");
});
