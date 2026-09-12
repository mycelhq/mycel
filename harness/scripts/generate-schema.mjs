#!/usr/bin/env node
/**
 * THE DRIZZLE SCHEMA IS GENERATED FROM THE DDL THAT ACTUALLY RUNS.
 *
 * ═══ Why generated and not written ═══
 *
 * This kernel creates its own schema at boot: every `*.pg.ts` store opens with a `CREATE TABLE IF
 * NOT EXISTS` block and a run of `ALTER TABLE … ADD COLUMN IF NOT EXISTS`, executed under a schema
 * lock. There is no migrations directory and no external source of truth — those statements ARE the
 * schema, and they are what a fresh database gets.
 *
 * So a hand-written Drizzle schema would be a second description of the same thing, maintained by
 * hand, drifting the first time somebody adds a column to a store and not to the declaration. A
 * declaration that is wrong is worse than none: it typechecks a query against a table that does not
 * look like that.
 *
 * Reading the DDL instead makes the generated file a VIEW of the real schema. `npm run schema` to
 * regenerate; `test/schema-is-current.test.ts` fails if the checked-in file and the DDL disagree,
 * so the drift cannot survive a test run.
 *
 * ═══ What this does not do ═══
 *
 * It does not migrate, does not diff against a live database, and is never run at boot. It reads
 * text and writes text. Nothing here can touch data.
 *
 * It also does not attempt to be a SQL parser. It handles the four statement shapes this codebase
 * actually uses, and **throws on anything it does not recognise** rather than skipping it — a
 * generator that silently drops a table it could not read would produce a schema that is quietly
 * missing things, which is the exact failure mode the whole exercise exists to prevent.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const OUT = join(SRC, "db", "schema.ts");

/**
 * Postgres type → Drizzle column builder.
 *
 * Deliberately a closed list. An unrecognised type throws (see `column`), because the alternative —
 * defaulting to `text()` — produces a schema that compiles, looks complete, and lies about a column
 * a query will then be typechecked against.
 */
const TYPES = {
  text: (n) => `text("${n}")`,
  "text[]": (n) => `text("${n}").array()`,
  uuid: (n) => `uuid("${n}")`,
  jsonb: (n) => `jsonb("${n}")`,
  boolean: (n) => `boolean("${n}")`,
  int: (n) => `integer("${n}")`,
  integer: (n) => `integer("${n}")`,
  // `bigint` needs a mode. `number` rather than `bigint`, because every one of these holds
  // `Date.now()` milliseconds — comfortably inside Number.MAX_SAFE_INTEGER, and the code that
  // reads them does arithmetic on numbers. `mode: "bigint"` would hand those call sites a BigInt
  // and break every comparison silently.
  bigint: (n) => `bigint("${n}", { mode: "number" })`,
  numeric: (n) => `numeric("${n}")`,
  "double precision": (n) => `doublePrecision("${n}")`,
  timestamptz: (n) => `timestamp("${n}", { withTimezone: true })`,
};

/** Statement-level noise: SQL block and line comments, which this codebase uses heavily inside DDL. */
const stripSqlComments = (sql) => sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");

/** Every backtick template literal in a file that contains DDL. */
function ddlFrom(file) {
  const src = readFileSync(file, "utf8");
  let out = "";
  for (const m of src.matchAll(/`([^`\\]*(?:\\.[^`\\]*)*)`/g)) {
    if (/CREATE\s+TABLE|ALTER\s+TABLE/i.test(m[1])) out += "\n" + m[1];
  }
  return stripSqlComments(out);
}

/** The body of a parenthesised block starting at `open`, respecting nesting. */
function balanced(sql, open) {
  let depth = 0;
  for (let i = open; i < sql.length; i++) {
    if (sql[i] === "(") depth++;
    else if (sql[i] === ")" && --depth === 0) return sql.slice(open + 1, i);
  }
  throw new Error(`unbalanced parentheses at ${open}`);
}

/** Split a table body on top-level commas — a `numeric(10, 2)` comma is not a column boundary. */
function splitColumns(body) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "(") depth++;
    else if (body[i] === ")") depth--;
    else if (body[i] === "," && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** Table-level constraints, which are not columns. */
const CONSTRAINT = /^(primary|unique|foreign|constraint|check|exclude)\b/i;

/**
 * One column definition → `{ name, type, notNull, primaryKey }`.
 *
 * Returns null for a table constraint. Throws for a line it cannot read at all, for the reason in
 * the header: silently skipping is how a column goes missing from a schema everything else trusts.
 */
function parseColumn(def, where) {
  if (CONSTRAINT.test(def)) return null;
  const m = def.match(/^"?(\w+)"?\s+(text\s*\[\s*\]|double\s+precision|[a-z]+)\s*(.*)$/is);
  if (!m) throw new Error(`unreadable column in ${where}: ${JSON.stringify(def.slice(0, 80))}`);
  const type = m[2].toLowerCase().replace(/\s+/g, m[2].toLowerCase().includes("[") ? "" : " ");
  const rest = m[3] ?? "";
  return {
    name: m[1],
    type,
    notNull: /\bNOT\s+NULL\b/i.test(rest) || /\bPRIMARY\s+KEY\b/i.test(rest),
    primaryKey: /\bPRIMARY\s+KEY\b/i.test(rest),
    where,
  };
}

/** Collect every table and column across all the stores. */
export function readSchema() {
  const tables = new Map();
  const files = readdirSync(SRC)
    .filter((f) => f.endsWith(".pg.ts"))
    .sort();

  const add = (table, col) => {
    const key = table.replace(/^public\./, "");
    if (!tables.has(key)) tables.set(key, { name: key, columns: new Map() });
    // First declaration wins. A column can legitimately appear twice — declared in `CREATE TABLE`
    // for a fresh database AND as an `ADD COLUMN IF NOT EXISTS` for an existing one — and the two
    // agree by construction, because the second exists to bring an old database up to the first.
    if (!tables.get(key).columns.has(col.name)) tables.get(key).columns.set(col.name, col);
  };

  for (const f of files) {
    const sql = ddlFrom(join(SRC, f));

    // CREATE TABLE [IF NOT EXISTS] <name> ( … )
    for (const m of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w.]+)\s*\(/gi)) {
      const body = balanced(sql, m.index + m[0].length - 1);
      for (const def of splitColumns(body)) {
        const col = parseColumn(def, `${f}:${m[1]}`);
        if (col) add(m[1], col);
      }
    }

    // ALTER TABLE <name> ADD COLUMN [IF NOT EXISTS] <col> <type> …
    for (const m of sql.matchAll(
      /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?([\w.]+)\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?([\s\S]*?);/gi,
    )) {
      add(m[1], parseColumn(m[2].trim(), `${f}:${m[1]}`));
    }
  }
  return tables;
}

/** `invoice_external_payments` → `invoiceExternalPayments`. */
const camel = (s) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

function column(col, table) {
  const build = TYPES[col.type];
  if (!build) {
    throw new Error(
      `${table}.${col.name}: no Drizzle mapping for Postgres type "${col.type}" (${col.where}). ` +
        `Add it to TYPES in scripts/generate-schema.mjs — do not guess.`,
    );
  }
  let out = build(col.name);
  if (col.primaryKey) out += ".primaryKey()";
  else if (col.notNull) out += ".notNull()";
  return out;
}

export function render(tables) {
  const used = new Set(["pgTable"]);
  const body = [...tables.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((t) => {
      const cols = [...t.columns.values()]
        .map((c) => {
          const expr = column(c, t.name);
          used.add(expr.match(/^(\w+)\(/)[1]);
          if (expr.includes(".array()")) used.add("text");
          return `  ${camel(c.name)}: ${expr},`;
        })
        .join("\n");
      return `export const ${camel(t.name)} = pgTable("${t.name}", {\n${cols}\n});`;
    })
    .join("\n\n");

  const imports = [...used].sort().join(", ");

  return `// GENERATED BY scripts/generate-schema.mjs — DO NOT EDIT.
//
// This file is a VIEW of the DDL in src/*.pg.ts, which is the real schema: this kernel creates its
// own tables at boot and has no migrations directory. Editing here changes nothing about the
// database and will be overwritten; change the CREATE TABLE or ADD COLUMN statement instead and run
// \`npm run schema\`.
//
// test/schema-is-current.test.ts fails if this file and the DDL disagree.
//
// What it is FOR: a column name that does not exist stops being a runtime error on a query nobody
// ran in staging, and becomes a compile error. Four queries written against this schema in one
// afternoon referenced tasks.output, events.created_at, standing_grants and rules.source — none of
// which exist — and all four typechecked, deployed, and failed against production.
import {
  ${imports.split(", ").join(",\n  ")},
} from "drizzle-orm/pg-core";

${body}
`;
}

const tables = readSchema();
const rendered = render(tables);

if (process.argv.includes("--check")) {
  const current = readFileSync(OUT, "utf8");
  if (current !== rendered) {
    console.error("src/db/schema.ts is stale. Run `npm run schema`.");
    process.exit(1);
  }
  console.log(`schema is current: ${tables.size} tables`);
} else {
  writeFileSync(OUT, rendered);
  const columns = [...tables.values()].reduce((n, t) => n + t.columns.size, 0);
  console.log(`wrote ${OUT}: ${tables.size} tables, ${columns} columns`);
}
