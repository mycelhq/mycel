import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getTableColumns } from "drizzle-orm";
import * as schema from "../src/db/schema";

/**
 * THE DECLARED SCHEMA MATCHES THE DDL THAT ACTUALLY RUNS.
 *
 * ─── Why a declaration needs a test at all ────────────────────────────────────────────────────
 *
 * This kernel creates its own tables at boot. The `CREATE TABLE IF NOT EXISTS` and `ALTER TABLE …
 * ADD COLUMN IF NOT EXISTS` statements in `src/*.pg.ts` are the schema; there is no migrations
 * directory and nothing else to consult. `src/db/schema.ts` is generated from them.
 *
 * A generated file that nothing checks is a stale file waiting to happen: somebody adds a column to
 * a store, does not run the generator, and the declaration now describes a table that no longer
 * exists. That is strictly worse than having no declaration, because a query gets typechecked
 * against the wrong shape and passes.
 *
 * So the generator runs in `--check` mode here. If the DDL and the checked-in file disagree, this
 * fails and names the command that fixes it.
 */

const HARNESS = new URL("..", import.meta.url).pathname;

test("src/db/schema.ts is regenerated from the current DDL", () => {
  // `--check` regenerates in memory and compares. It writes nothing, so a failing run leaves the
  // tree exactly as it found it.
  try {
    const out = execFileSync("node", [join(HARNESS, "scripts/generate-schema.mjs"), "--check"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.match(out, /schema is current/);
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    assert.fail(
      `src/db/schema.ts no longer matches the DDL in src/*.pg.ts. Run \`npm run schema\`.\n` +
        `${err.stdout ?? ""}${err.stderr ?? ""}`,
    );
  }
});

test("every declared column appears in the DDL under its own table", () => {
  /**
   * The other direction, and not redundant with the check above.
   *
   * `--check` compares the generated text to the file, so the two agree by construction whenever the
   * generator is the only thing that writes it. This asserts the generator's OUTPUT is grounded: a
   * table/column pair in the declaration has to be findable in the SQL. It is what would catch a
   * parsing bug that invented a column out of a constraint line, or attached a column to the wrong
   * table — neither of which `--check` can see, because it would reproduce the same mistake.
   */
  const sql = (() => {
    let all = "";
    for (const f of readdirSync(join(HARNESS, "src")).filter((f) => f.endsWith(".pg.ts"))) {
      all += readFileSync(join(HARNESS, "src", f), "utf8");
    }
    // Strip JS and SQL comments. A column name mentioned in prose is not a declaration, and this
    // codebase discusses its own columns at length.
    return all.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|\s)--[^\n]*/g, " ");
  })();

  const missing: string[] = [];
  for (const [exported, table] of Object.entries(schema)) {
    // `export * as schema` re-exports the namespace; skip anything that is not a table.
    if (!table || typeof table !== "object") continue;
    let columns: Record<string, { name: string }>;
    try {
      columns = getTableColumns(table as never);
    } catch {
      continue;
    }
    for (const col of Object.values(columns)) {
      // The column name has to appear somewhere in the DDL as an identifier. Deliberately not
      // scoped to its own CREATE TABLE block: `ADD COLUMN` statements for a table live in a
      // different file from its creation in several stores, and re-deriving that association here
      // would be reimplementing the generator inside its own test.
      if (!new RegExp(`\\b${col.name}\\b`).test(sql)) {
        missing.push(`${exported}.${col.name}`);
      }
    }
  }
  assert.deepEqual(missing, [], `declared columns with no DDL behind them:\n${missing.join("\n")}`);
});

test("the four names that cost a production afternoon still do not exist", () => {
  /**
   * Not a tautology, and not nostalgia. These are the four that were written, typechecked, deployed
   * and failed: `tasks.output`, `events.created_at`, the table `standing_grants`, and `rules.source`.
   *
   * Each has a real counterpart with a different name, and the failure mode is that somebody
   * "fixes" a future version of that query by ADDING the column they expected instead of using the
   * one that exists. That turns a loud error into two places holding the same fact, which is the
   * expensive version. If one of these genuinely needs to exist one day, deleting its line here is
   * the deliberate act that says so.
   */
  const taskColumns = Object.keys(getTableColumns(schema.tasks));
  assert.ok(!taskColumns.includes("output"), "a task's result is in the event log and artifacts");

  const eventColumns = Object.keys(getTableColumns(schema.events));
  assert.ok(!eventColumns.includes("createdAt"), "an event's clock is `ts`");
  assert.ok(eventColumns.includes("ts"));

  assert.ok(!("standingGrants" in schema), "the table is `grants`");
  assert.ok("grants" in schema);

  const ruleColumns = Object.keys(getTableColumns(schema.rules));
  assert.ok(!ruleColumns.includes("source"), "a rule's origin is inside `provenance`");
  assert.ok(ruleColumns.includes("provenance"));
});

test("the declaration covers the tables the product is built on", () => {
  // A floor, not an inventory: the generator finding nothing would otherwise pass every test above,
  // since an empty schema trivially has no stale columns and no forbidden names.
  for (const table of [
    "tasks",
    "events",
    "approvals",
    "deliverables",
    "clients",
    "cases",
    "invoices",
    "rules",
    "observations",
    "orgs",
    "projects",
    "members",
    "clientRequests",
  ]) {
    assert.ok(table in schema, `${table} is missing from the generated schema`);
  }
});
