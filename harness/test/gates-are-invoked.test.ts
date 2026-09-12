/**
 * ═══ A GATE NOTHING CALLS ═══
 *
 * This is the most-repeated defect in this codebase, and it does not look like a defect: the
 * function exists, it is correct, it has tests, and its doc comment describes the protection it
 * provides in the present tense. Nothing calls it.
 *
 * Two found in one sweep on 6 September:
 *
 *   `assertWedgeRolesValid` — "Boot gate. Called once from `createServer` so a bad manifest stops
 *   the kernel starting." It was not called from anywhere. Two OTHER boot gates cite it as their
 *   precedent (`capabilities.ts` calls itself "the counterpart of assertWedgeRolesValid";
 *   `blueprints.ts` copies its not-swallowed argument), so the codebase had three gates modelled
 *   on one that never ran.
 *
 *   `tasteBlockers` — every rendered document is linted for text off the page, text on text and a
 *   page that is one line. `render/index.ts` says "the delivery path holds the task when one of
 *   them is `isBlocking`". Outside tests, `isBlocking` had no caller at all.
 *
 * A doc comment is not a call site. This test is the difference.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dirname, "..", "src");

/** Every non-test source file, as CODE — comment lines removed so a mention is not a call. */
function codeFiles(dir = SRC, acc: Array<{ path: string; code: string }> = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      codeFiles(p, acc);
      continue;
    }
    if (!entry.endsWith(".ts") || entry.includes(".test.")) continue;
    const code = readFileSync(p, "utf8")
      .split("\n")
      .filter((l) => {
        const t = l.trim();
        return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
      })
      .join("\n");
    acc.push({ path: p, code });
  }
  return acc;
}

/**
 * Gates whose entire value is that something calls them. Each entry is the function and the file it
 * is DECLARED in — a reference from that file alone does not count, or a gate could satisfy this by
 * mentioning its own name.
 *
 * Add to this list whenever you write something whose failure mode is silence.
 */
const GATES: Array<{ fn: string; declaredIn: string; why: string }> = [
  { fn: "assertWedgeRolesValid", declaredIn: "roles.ts", why: "two wedges claiming one role boot silently and a client is chased in the wrong trade's voice" },
  { fn: "assertCapabilityTableValid", declaredIn: "capabilities.ts", why: "a capability whose adapter key points at nothing fails at send time instead of at boot" },
  { fn: "assertBlueprintsValid", declaredIn: "blueprints.ts", why: "a blueprint shipping a placeholder address reaches a real client" },
  { fn: "tasteBlockers", declaredIn: "render/index.ts", why: "a PDF with text printed off the page is delivered and nobody sees it first" },
  { fn: "lintArtifact", declaredIn: "design-lint.ts", why: "the anti-slop rules are the difference between a document and a machine-made one" },
  { fn: "compile", declaredIn: "compile.ts", why: "a job with no definition of done, no craft or no access spends a budget producing work that looks finished" },
  { fn: "deliverableShapeAsSkill", declaredIn: "deliverable-shape.ts", why: "the run re-invents the section order of a document its trade settled decades ago" },
];

test("every gate has a caller that is not itself", () => {
  const files = codeFiles();
  const orphaned: string[] = [];
  for (const gate of GATES) {
    const callers = files.filter(
      (f) => !f.path.endsWith(gate.declaredIn) && new RegExp(`\\b${gate.fn}\\s*\\(`).test(f.code),
    );
    if (callers.length === 0) orphaned.push(`${gate.fn} — ${gate.why}`);
  }
  // Named, not counted. A count assertion passes the day someone adds a gate, having found nothing.
  assert.deepEqual(orphaned, [], `these gates are written, tested, documented, and never run:\n  ${orphaned.join("\n  ")}`);
});

test("each gate in the list actually exists under that name", () => {
  // The failure this catches is a rename: the gate moves, the list keeps the old spelling, and the
  // test above goes green because it is now checking a function nobody has.
  const files = codeFiles();
  const missing: string[] = [];
  for (const gate of GATES) {
    const home = files.find((f) => f.path.endsWith(gate.declaredIn));
    if (!home) {
      missing.push(`${gate.declaredIn} (file is gone)`);
      continue;
    }
    if (!new RegExp(`export (?:async )?(?:function|const) ${gate.fn}\\b`).test(home.code)) {
      missing.push(`${gate.fn} is not exported from ${gate.declaredIn}`);
    }
  }
  assert.deepEqual(missing, [], `the gate list has drifted from the source: ${missing.join(", ")}`);
});
