import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { serviceNotEnabled, unknownService } from "../src/service-words";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE KERNEL'S REFUSALS ARE READ BY FOUNDERS, WORD FOR WORD
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The console shows a kernel refusal verbatim, and that is deliberate: `lib/run-refusal.ts` exists
 * because a plan refusal rendered as "couldn't start that, try again in a moment" is a retry
 * instruction for a decision. The kernel is the only thing that knows whether a subscription ended
 * or a ceiling was hit, so its sentence is the one that ships.
 *
 * Which means `no-vocabulary-of-ours.test.ts` — the console's guard, clean for weeks — was only
 * half the wall. `unknown wedge: books-keeper` reached a founder's screen the first time one asked
 * for something a service could not do.
 *
 * ── THE LINE, WHICH IS THE CONSOLE'S LINE ──
 *
 * Not "avoid jargon". A word a founder DID NOT NAME, CANNOT CHANGE, AND CANNOT ACT ON. `wedge` is
 * ours; an invoice is theirs.
 *
 * ── WHAT IS ALLOWED, AND WHY IT IS NOT A LOOPHOLE ──
 *
 * A sentence naming a JSON FIELD in a request body is for whoever is posting it, and the field
 * really is called `wedge` — "service and task_type are required" would send an integrator looking
 * for a key that does not exist. Those are listed by hand below. A list you have to maintain is a
 * list somebody reads, and adding to it is the friction that makes you ask who is going to read the
 * sentence.
 */

const SRC = join(import.meta.dirname, "..", "src");

/**
 * Sentences that name a request field rather than a concept. Exact matches only — a prefix rule
 * would quietly cover anything that started the same way.
 */
const NAMES_A_FIELD = new Set([
  "wedge and task_type are required",
  "wedge and title are required",
  "client_id and wedge are both required",
  "address, wedge and task_type are required",
  "channel_id or wedge+task_type are required",
  "trigger_slug, wedge and task_type are required",
  "name, wedge, task_type and cadence are required",
  "wedge, collection and key are required",
  "wedge and task_type are required — an inbox nothing runs on is a mailbox that swallows replies",
  "children must use the parent wedge (cross-wedge batches are not supported yet)",
]);

/**
 * `error: "…"` / `error: `…`` — the strings that cross to a caller.
 *
 * INTERPOLATIONS ARE BLANKED, and that is the difference between a guard and a nuisance. The word in
 * `${b.wedge}` is a VARIABLE NAME: what the founder reads is the slug it holds. The first version of
 * this check reported eight sentences that were already in plain English, purely because the
 * expression inside them mentioned the field it was reading — which is the same mistake as a guard
 * matching its own documentation, one level down.
 */
function refusals(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/\berror:\s*(["'`])((?:\\.|(?!\1).)*)\1/g)) {
    out.push(m[2].replace(/\$\{[^}]*\}/g, "…"));
  }
  return out;
}

test("the guard reads the whole kernel, or it proves nothing", () => {
  // The vacuous-pass failure mode: a path that resolves to nothing, a regex that matches nothing.
  // Both look exactly like success. See the sibling guards that have been caught doing it.
  const files = readdirSync(SRC).filter((f) => f.endsWith(".ts"));
  assert.ok(files.length > 50, `only ${files.length} source files — the path is wrong`);
  const found = files.flatMap((f) => refusals(readFileSync(join(SRC, f), "utf8")));
  assert.ok(found.length > 100, `only ${found.length} refusal strings — the pattern is wrong`);
});

test("no refusal a founder can read calls a service a wedge", () => {
  const bad: string[] = [];
  for (const f of readdirSync(SRC).filter((f) => f.endsWith(".ts"))) {
    for (const s of refusals(readFileSync(join(SRC, f), "utf8"))) {
      if (!/\bwedges?\b/i.test(s)) continue;
      if (NAMES_A_FIELD.has(s)) continue;
      bad.push(`${f}: ${s}`);
    }
  }
  assert.deepEqual(
    bad,
    [],
    `${bad.length} refusal(s) say "wedge" to somebody who has never heard the word:\n` +
      bad.map((b) => `  ${b}`).join("\n") +
      `\nUse \`unknownService\` / \`serviceNotEnabled\` from src/service-words.ts, or — if the ` +
      `sentence names a request FIELD rather than a concept — add it to NAMES_A_FIELD there with ` +
      `the reason.`,
  );
});

test("the two sentences name the thing that is wrong", () => {
  // A refusal that does not say WHICH service is a refusal nobody can act on — the same reason
  // `unknown wedge: ${slug}` interpolated in the first place.
  assert.match(unknownService("books-keeper"), /books-keeper/);
  assert.match(serviceNotEnabled("books-keeper"), /books-keeper/);
  for (const s of [unknownService("x"), serviceNotEnabled("x")]) {
    assert.ok(!/\bwedge\b/i.test(s), s);
  }
});
