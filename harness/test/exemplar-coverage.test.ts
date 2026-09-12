// EVERY TRADE SHIPS THE BAR ITS RUNS ARE HELD TO.
//
// `exemplar.ts` names the failure this prevents: the craft skills are prose, and "824 lines of it
// across ten wedges, and ZERO worked examples. So a run knows the rules and has never been shown the
// game." Depth is the one property prose cannot specify and an example conveys for free.
//
// This is a coverage test rather than a note in a README because the failure is SILENT. A trade with
// no exemplar does not error, does not warn, and produces work that is merely thinner than it should
// be — which nobody notices until a client does. The whole point of the mechanism is that the bar is
// always there, so the rule that it is always there has to be enforced somewhere.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadWedge, wedgesDir } from "../src/wedge";

/**
 * Trades that deliberately ship none, each with its reason.
 *
 * A list rather than a heuristic. "Wedges whose name contains harness" would silently excuse the
 * next internal wedge somebody adds, and the point of this test is that the exception is a decision
 * somebody wrote down.
 */
const NO_CLIENT_DELIVERABLE: Record<string, string> = {
  // Operates on Mycel itself — reflects memory, reviews our own work, rewrites skills. Its output
  // goes to the founder as maintenance, not to a client as a piece of work, so there is no
  // professional standard in a trade to hold it to.
  "harness-operator": "internal: acts on the harness, produces no client deliverable",
};

test("every client-facing wedge ships at least one exemplar", () => {
  const dir = wedgesDir();
  if (!existsSync(dir)) return; // an install with no wedges on disk has nothing to check
  const slugs = readdirSync(dir).filter((f) => !f.startsWith(".") && existsSync(join(dir, f, "wedge.json")));
  assert.ok(slugs.length > 0, "there should be wedges to check");

  const missing: string[] = [];
  for (const slug of slugs) {
    if (NO_CLIENT_DELIVERABLE[slug]) continue;
    const w = loadWedge(slug);
    if (!w) continue;
    if (!w.exemplars.some((f) => f.content.trim().length > 0)) missing.push(slug);
  }
  assert.deepEqual(
    missing,
    [],
    `these trades ship no worked example, so their runs have never been shown what good looks like: ${missing.join(", ")}. ` +
      `Add one to wedges/<slug>/exemplars/, or add the slug to NO_CLIENT_DELIVERABLE with the reason.`,
  );
});

test("a shipped exemplar is deep enough to teach depth", () => {
  // The entire argument for an example is that prose cannot specify how much detail is enough. A
  // 200-word "example" teaches the opposite of what it is mounted to teach — it would license
  // exactly the thin output the mechanism exists to end.
  const dir = wedgesDir();
  if (!existsSync(dir)) return;
  const thin: string[] = [];
  for (const slug of readdirSync(dir).filter((f) => !f.startsWith("."))) {
    const w = loadWedge(slug);
    for (const f of w?.exemplars ?? []) {
      const words = f.content.split(/\s+/).filter(Boolean).length;
      if (words < 400) thin.push(`${slug}/${f.name} (${words} words)`);
    }
  }
  assert.deepEqual(thin, [], `too thin to be a bar: ${thin.join(", ")}`);
});

test("a shipped exemplar says it is invented", () => {
  // The framing is load-bearing. A model told "this is a real deliverable this firm sent a client"
  // about a document we wrote will imitate a client relationship that does not exist. Every shipped
  // one has to disclaim itself, and the check is here rather than in review because it is the kind
  // of line that gets lost when somebody copies an existing exemplar to start a new one.
  const dir = wedgesDir();
  if (!existsSync(dir)) return;
  const undisclaimed: string[] = [];
  for (const slug of readdirSync(dir).filter((f) => !f.startsWith("."))) {
    for (const f of loadWedge(slug)?.exemplars ?? []) {
      if (!/invented|made up|reference document/i.test(f.content)) undisclaimed.push(`${slug}/${f.name}`);
    }
  }
  assert.deepEqual(undisclaimed, [], `these do not say they are invented: ${undisclaimed.join(", ")}`);
});
