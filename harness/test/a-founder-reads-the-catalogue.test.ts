/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * "FAN-OUT USES BATCH SO LATENCY TRACKS WORKER COUNT, NOT SERIAL SANDBOX TIME"
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * That sentence was the last line of the GEO monitor's description, on `/services/geo-monitor`, on
 * the live demo. Found by opening it in a browser on 13 September and reading it as a founder would.
 *
 * A blueprint `summary` is not documentation. It is the paragraph somebody reads while deciding
 * whether to turn a service on — in the catalogue, on the service page, and in the shaper's
 * read-back during onboarding. Three of six were written for an engineer:
 *
 *   geo-monitor            "compute share of voice with a pinned pack… Fan-out uses Batch so
 *                           latency tracks worker count, not serial sandbox time."
 *   recruiting-desk        "screen a longlist in parallel via Batch, and keep the engagement on a Case"
 *   security-questionnaire "Fans out per question via Batch"
 *
 * The other three show what the voice should be. `books-keeper`: "Reconcile a client's books to the
 * cent every month. Pulls the bank feed daily, chases missing receipts, closes the month, prepares
 * the sales tax return for your approval." Outcome first, mechanism as proof, every word in the
 * founder's vocabulary — which is `docs/UX.md` rule 4 and the landing page's own rule about leading
 * with the money rather than the machinery.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(import.meta.dirname, "..", "..", "library", "blueprints");
const blueprints = readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => [f.replace(/\.json$/, ""), JSON.parse(readFileSync(join(DIR, f), "utf8"))] as const);

/**
 * OUR words for our machinery. Each one was found in a shipped summary or is one keystroke from it.
 *
 * `arithmetic` is deliberately absent: contract-desk promises "the arithmetic done in whole pennies",
 * which is a claim about correctness a founder cares about, not an implementation note. A banned
 * list that fires on that is a list somebody turns off.
 */
const MACHINERY =
  /\b(fan-?outs?|batch(es|ing)?|sandbox(es)?|latenc(y|ies)|worker count|serial|payloads?|idempoten\w*|pinned pack|harness|kernel|wedges?|manifests?|endpoints?|queue[sd]?|concurren\w*|throughput|schemas?|CRUD|webhooks?)\b/i;

test("THE CATALOGUE IS WRITTEN FOR A FOUNDER", () => {
  const offenders: string[] = [];
  for (const [slug, b] of blueprints) {
    for (const field of ["summary", "title", "sells_as"] as const) {
      const v = (b as Record<string, unknown>)[field];
      if (typeof v !== "string") continue;
      const hit = MACHINERY.exec(v);
      if (hit) offenders.push(`${slug}.${field}: "${hit[0]}" in "${v.slice(0, 80)}…"`);
    }
  }
  assert.deepEqual(offenders, [], `a founder deciding whether to buy this reads:\n  ${offenders.join("\n  ")}`);
});

test("and it says what the client GETS before how it is done", () => {
  /**
   * Not a style preference. The landing page's own rule — and the one the founder has repeated —
   * is to lead with the money or the outcome and let the mechanism be proof. A summary whose first
   * sentence is a mechanism has buried the reason to care.
   */
  for (const [slug, b] of blueprints) {
    const summary = (b as { summary?: string }).summary ?? "";
    assert.ok(summary.length > 60, `${slug} has no summary worth reading`);
    const first = summary.split(/(?<=\.)\s/)[0]!;
    assert.ok(
      first.length < 200,
      `${slug}'s opening sentence is ${first.length} characters — nobody reads that far before deciding`,
    );
  }
});

test("every service says what it is sold as, in money", () => {
  // The catalogue is a price list as much as a feature list. A service with no `sells_as` cannot be
  // put in front of a founder who is deciding whether it pays for itself.
  for (const [slug, b] of blueprints) {
    const sells = (b as { sells_as?: string }).sells_as ?? "";
    assert.match(sells, /[£$€]\s?[\d,]+/, `${slug} does not say what it is worth`);
  }
});

test("the scan would actually catch the sentence that started this", () => {
  /**
   * A banned-word list that does not fire on the original offender is a list that was tuned until it
   * passed. This is the real string, from the real file, on the real demo.
   */
  assert.match(
    "Fan-out uses Batch so latency tracks worker count, not serial sandbox time.",
    MACHINERY,
    "the rule no longer catches the sentence it was written for",
  );
  // And it leaves the good ones alone.
  assert.doesNotMatch("Reconcile a client's books to the cent every month.", MACHINERY);
  assert.doesNotMatch("the arithmetic done in whole pennies", MACHINERY);
});
