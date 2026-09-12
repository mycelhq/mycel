/**
 * Compare the declared schema against a real database, and print what is missing.
 *
 * The manual twin of the boot-time `reportSchemaDrift`. That one logs during startup where nobody is
 * looking; this one is for the moment somebody wants to ask the question — after a manual change in
 * the console, or after a restore, or before trusting a query written against `src/db/schema.ts`.
 *
 * Read-only by construction: `verifyLiveSchema` issues exactly one `information_schema` SELECT and
 * has no DDL path. Point `MYCEL_DATABASE_URL` at whichever database you want to ask about.
 */
import { verifyLiveSchema } from "../src/db/verify";

const drift = await verifyLiveSchema();
if (!drift) {
  console.log("no database configured (MYCEL_DATABASE_URL is unset)");
} else {
  console.log(`checked ${drift.checked.tables} tables / ${drift.checked.columns} columns`);
  console.log(`missing tables:  ${drift.missingTables.length ? drift.missingTables.join(", ") : "none"}`);
  console.log(
    `missing columns: ${drift.missing.length ? drift.missing.map((m) => `${m.table}.${m.column}`).join(", ") : "none"}`,
  );
}
process.exit(0);
