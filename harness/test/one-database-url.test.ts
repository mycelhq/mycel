import { test } from "node:test";
import { inMonorepo, ONLY_IN_MONOREPO } from "./_monorepo";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * EVERY STORE ASKS FOR THE DATABASE THE SAME WAY.
 *
 * ─── The bug, and why no amount of care would have caught it ──────────────────────────────────
 *
 * `initBatchStore` read `process.env.DATABASE_URL`. Sixteen other store initialisers call
 * `databaseUrl()` from `config.ts`, which reads `MYCEL_DATABASE_POOLED_URL` then `MYCEL_DATABASE_URL`.
 *
 * `infra/services.tf` gives the kernel and the worker the two `MYCEL_*` variables and never
 * `DATABASE_URL` — that one belongs to the console, the landing app and litellm. So on every
 * production boot the batch store resolved `undefined`, fell through to its in-memory backend, and
 * the `batches` table was never created. Fan-out ran 31 times against coordination records living in
 * one worker's memory.
 *
 * NOTHING ABOUT THAT IS VISIBLE FROM INSIDE `batches.ts`. The line reads correctly, the fallback is
 * deliberate and documented ("or leave them in memory for a local run with no DATABASE_URL"), the
 * tests pass because tests have no database either, and the local `.env` sets both names. It is only
 * wrong in relation to a Terraform file in another directory. That is what makes it a guard's job
 * rather than a reviewer's.
 *
 * It was found by `src/db/verify.ts` on its first run against production — a declared table that was
 * not there — which is the whole argument for that check existing.
 *
 * ─── Two more of the same ─────────────────────────────────────────────────────────────────────
 *
 * `orchestrator.ts` built `getPool(process.env.DATABASE_URL ?? "")` on the auto-release path, twice.
 * An empty connection string is not an error in node-postgres; it falls back to libpq defaults and
 * connects to nothing here, so `readRecord` threw and the catch answered `false` — the gated
 * direction. Auto-release has 0 rows in production.
 *
 * `index.ts` wrapped the release-policy migration in `if (process.env.DATABASE_URL)`, so on every
 * production boot it did not fail — it never attempted. The comment inside that block describes
 * precisely this failure mode and was defeated by the condition around it.
 */

const SRC = new URL("../src/", import.meta.url).pathname;

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) tsFiles(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** A name in prose is not a read. Every guard in this suite that forgot this tripped on itself. */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("nothing in the kernel reads DATABASE_URL directly", () => {
  const offenders: string[] = [];
  for (const file of tsFiles(SRC)) {
    // `config.ts` is where the resolution lives and is allowed to name variables. It reads the
    // `MYCEL_*` pair; if it ever starts reading `DATABASE_URL` too, that is a deliberate change to
    // the one place this is decided and belongs in a diff somebody looks at.
    if (file.endsWith("/config.ts")) continue;
    if (/process\.env\.DATABASE_URL/.test(stripComments(readFileSync(file, "utf8")))) {
      offenders.push(file.slice(SRC.length));
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `these read DATABASE_URL, which infra/services.tf never sets for the kernel or the worker.\n` +
      `Use databaseUrl() from config.ts — it reads the MYCEL_* pair production actually provides:\n` +
      offenders.map((f) => `  ${f}`).join("\n"),
  );
});

test("the deployment really does set the variables config.ts reads", { skip: inMonorepo() ? false : ONLY_IN_MONOREPO }, () => {
  /**
   * The other end of the same wire, and the half that makes the test above mean something.
   *
   * Asserting "everybody calls `databaseUrl()`" is worth nothing if `databaseUrl()` reads names the
   * infrastructure does not set — that is the identical bug one level up, and it is how the first
   * one survived: every individual file was self-consistent.
   *
   * Skipped in the published kernel tree, where `infra/` does not exist — and skipped BY NAME.
   * This used to be `if (!existsSync(infra)) return;` inside the body, which is a decision rather
   * than a swallowed failure but still reports a PASS for a test that measured nothing of what it
   * is about. `_monorepo.ts` makes the argument; seven other files already follow it.
   */
  const tf = readFileSync(new URL("../../../infra/services.tf", import.meta.url).pathname, "utf8");
  const config = readFileSync(join(SRC, "config.ts"), "utf8");

  // Every `MYCEL_*` name `databaseUrl` and `sessionDatabaseUrl` read has to be set somewhere in the
  // service definitions, or the kernel falls back to memory in production exactly as before.
  const read = [...config.matchAll(/process\.env\.(MYCEL_DATABASE\w*)/g)].map((m) => m[1]);
  assert.ok(read.length >= 2, `expected config.ts to read the MYCEL_DATABASE names, found ${read}`);

  for (const name of new Set(read)) {
    assert.ok(tf.includes(name), `config.ts reads ${name}, which infra/services.tf never sets`);
  }
});
