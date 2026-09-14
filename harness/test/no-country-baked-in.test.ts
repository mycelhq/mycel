// A PRODUCT THAT PRICES IN DOLLARS AND WRITES DATES LIKE LONDON.
//
// Measured: `toLocaleDateString("en-GB", …)` on eight surfaces — the sidebar, billing, the portal,
// the digest email, the renewal notice — and 41 pound signs across the skills and prompts the AGENT
// reads before it does anybody's books.
//
// Neither is only a formatting question. The plan table is $299 and $899, so a founder in Austin saw
// a dollar price beside a London date; and an agent shown "£4,070.61" in every worked example writes
// pounds for a client who has never held one.
//
// ── WHY NOT JUST DROP THE LOCALE ARGUMENT ──
//
// `toLocaleDateString(undefined, …)` uses the RUNTIME's locale, and half of these render on a server
// whose locale is whatever the container image carries. That is unpredictable, not neutral — the
// same date could format one way in a page and another in the email about it. Month tables instead.

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

/**
 * ═══ TWO LAYOUTS, AND THIS FILE USED TO ONLY WORK IN ONE ═══
 *
 * In the monorepo, `harness/test` → `..` → `..` is `kernel`, and one more is the repo root, which is
 * where `cloud/` and `landing/` live. In the PUBLISHED open-source repo the kernel IS the root
 * (`scripts/publish-oss.sh`, kernel-at-root), so that third `..` lands outside the checkout: every
 * path below resolved to nothing, `scanned` was 0, and the count guard — added precisely to catch a
 * ROOT that is one level off — failed all three tests. The publish script's verify step runs the
 * suite in the STAGED tree, so this blocked publishing entirely.
 *
 * Resolved by asking the filesystem instead of counting dots, and the probe is `cloud/` because that
 * is the directory that exists in exactly one of the two layouts.
 */
const KERNEL = join(import.meta.dirname, "..", "..");
const MONOREPO = existsSync(join(KERNEL, "..", "cloud"));
const ROOT = MONOREPO ? join(KERNEL, "..") : KERNEL;
/** Where the kernel's own sources are, relative to ROOT, in whichever layout this is. */
const K = MONOREPO ? "kernel" : ".";

function walk(dir: string, exts: string[], out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name === "graphify-out" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, exts, out);
    else if (exts.some((e) => p.endsWith(e))) out.push(p);
  }
  return out;
}

test("no surface formats a date by country", () => {
  /**
   * Any explicit locale, not just en-GB: swapping it for en-US would move the bias rather than
   * remove it, and the fix is a month table that is the same everywhere.
   */
  const offenders: string[] = [];
  let scanned = 0;
  // The paid surfaces are not in the published repo, and their absence there is correct rather than a
  // gap — which is why the floor below is per-layout instead of one number that has to suit both.
  const dirs = MONOREPO
    ? ["kernel/harness/src", "cloud/lib", "cloud/app", "cloud/components", "landing/lib", "landing/app"]
    : ["harness/src"];
  for (const dir of dirs) {
    let files: string[];
    try {
      files = walk(join(ROOT, dir), [".ts", ".tsx"]);
    } catch {
      /*
        A missing directory used to `continue` silently, and with ROOT one level short EVERY cloud
        path was missing — so this passed having scanned nothing but the kernel. The count below is
        what turns that from a green test into a red one.
      */
      continue;
    }
    scanned += files.length;
    for (const f of files) {
      const src = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
      for (const m of src.matchAll(/toLocale(?:Date|Time)?String\(\s*["'`]([a-z]{2}-[A-Z]{2})["'`]/g)) {
        offenders.push(`${f.slice(ROOT.length + 1)} — ${m[1]}`);
      }
    }
  }
  // 300 in the kernel alone (it has 330 .ts files), 1000 with the console and the marketing site. A
  // floor that only the smaller layout has to clear would pass a monorepo run that silently lost
  // `cloud/`, which is the exact regression the original count was added for.
  const floor = MONOREPO ? 1000 : 300;
  assert.ok(
    scanned > floor,
    `only ${scanned} files scanned in the ${MONOREPO ? "monorepo" : "published kernel"} layout — the roots are wrong and this guard is measuring nothing`,
  );
  assert.deepEqual(
    offenders,
    [],
    `these format by country, on a product sold in dollars to anybody:\n  ${offenders.join("\n  ")}`,
  );
});

test("nothing the agent reads is denominated in one country's money", () => {
  /**
   * The skills and schema descriptions are what the model imitates. Shown "£4,070.61" in every
   * worked example, it writes pounds into a close for a client in Denver — and the founder has to
   * notice, which is the one thing this product exists to stop them having to do.
   *
   * The runtime prompt is included because it carries worked examples too.
   */
  const offenders: string[] = [];
  for (const f of [
    ...walk(join(ROOT, K, "wedges"), [".md", ".json"]),
    join(ROOT, K, "harness/src/runtime.ts"),
  ]) {
    const src = readFileSync(f, "utf8");
    const n = (src.match(/£/g) ?? []).length;
    if (n) offenders.push(`${f.slice(ROOT.length + 1)} — ${n}`);
  }
  assert.deepEqual(offenders, [], `pound signs in what the agent reads:\n  ${offenders.join("\n  ")}`);
});

test("the currency in a worked example is not a country's default", () => {
  /*
    `close-the-month.md` showed `"currency":"GBP"` in the JSON an agent copies. A default in an
    EXAMPLE is stronger than a default in code: the model does not read the schema's fallback, it
    reads the sample and matches it.
  */
  const skill = readFileSync(join(ROOT, K, "wedges/books-keeper/skills/close-the-month.md"), "utf8");
  assert.ok(!/"currency"\s*:\s*"GBP"/.test(skill), "the worked example hands the model a British default again");
});
