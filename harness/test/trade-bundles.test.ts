// TRADE_BUNDLES is a typed table, and the compiler note names that as the hardcoding problem:
// "a shelf and then a lot of typed exceptions." Full derivation needs the library to carry desk
// groupings it does not have yet. Until then, this test is the wire that stops the table becoming
// fiction: every domain a bundle names must have real skills on the shelf, and every shelf domain
// must be reachable through some bundle or named as deliberately unbundled — because a domain that
// silently falls off every desk is 4 files of craft the shaper can never find, which is exactly
// how `turn-measurement-into-work` sat dead in geo-monitor.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { TRADE_BUNDLES } from "../src/skill-arsenal";

const SHELF = new URL("../../service-skills/", import.meta.url).pathname;

/**
 * Domains with skills on disk that no desk sells YET, each with the reason. An entry here is a
 * decision on record; a domain missing from both the bundles and this list is a drift.
 */
const DELIBERATELY_UNBUNDLED: Record<string, string> = {
  architecture: "licensure-bound trade — schematic-design craft exists, but no desk sells it yet",
  coaching: "no wedge sells coaching; skills are seed material for a future desk",
  "event-planning": "same — seed material, no desk",
  "insurance-brokerage": "regulated sales motion; not a desk until compliance is thought through",
  "management-consulting": "QBR/analysis craft is generic input to other desks, not its own",
  "real-estate": "listing-prep craft exists; no desk sells it yet",
  "social-media-management": "adjacent to GEO/GTM desks; folding it in is a decision not yet made",
  "video-production": "asset machinery uses this; not a client-facing desk",
  /**
   * NOT A TRADE — A METHOD, and the distinction is why this list has a reason column.
   *
   * Every other entry here is a trade nobody sells YET. This one is a trade nobody will ever sell:
   * no client buys "working a browser". It is how the work gets done inside systems that have no
   * API — a supplier portal, a council portal, a client's CMS — which is a thing the bookkeeping,
   * ops and GEO desks all do and none of them is defined by.
   *
   * Bundling it into one desk would hide it from the others; giving it its own desk would put a
   * capability on the shelf as though it were a service.
   */
  "browser-work": "a method every desk uses, not a trade any desk sells — see browser-work.ts",
  // virtual-assistant, recruiting and it-managed-services were listed here in this test's first
  // draft — and the contradiction check caught its own author: the `ops` bundle already sells all
  // three. Kept as a comment because it is the proof the check earns its keep on day one.
};

function shelfDomains(): string[] {
  return readdirSync(SHELF).filter((d) => {
    try { return statSync(join(SHELF, d)).isDirectory(); } catch { return false; }
  });
}

test("every domain a bundle names has real skills on the shelf", () => {
  const disk = new Set(shelfDomains());
  const ghosts: string[] = [];
  for (const b of TRADE_BUNDLES) {
    for (const d of b.domains) if (!disk.has(d)) ghosts.push(`${b.id} → ${d}`);
  }
  assert.deepEqual(ghosts, [],
    `bundles naming domains with no skills on disk — the shaper would mount nothing:\n  ${ghosts.join("\n  ")}`);
});

test("every shelf domain is sold by some desk, or unbundled ON RECORD", () => {
  const bundled = new Set(TRADE_BUNDLES.flatMap((b) => b.domains));
  const adrift = shelfDomains().filter((d) => !bundled.has(d) && !DELIBERATELY_UNBUNDLED[d]);
  assert.deepEqual(adrift, [],
    `domains with craft on disk that no desk can reach and no decision covers:\n  ${adrift.join("\n  ")}\n` +
    `Add to a bundle, or record why not in DELIBERATELY_UNBUNDLED.`);
});

test("a domain cannot be both bundled and 'deliberately unbundled' — one truth per domain", () => {
  const bundled = new Set(TRADE_BUNDLES.flatMap((b) => b.domains));
  const both = Object.keys(DELIBERATELY_UNBUNDLED).filter((d) => bundled.has(d));
  assert.deepEqual(both, [], `contradictory records: ${both.join(", ")}`);
});

test("every bundle's `when` reads as a founder's sentence, not a taxonomy label", () => {
  for (const b of TRADE_BUNDLES) {
    assert.ok(b.when.length > 40, `${b.id}: 'when' must be decision-grade — the shaper routes on it`);
    assert.ok(b.domains.length >= 1 && b.domains.length <= 4,
      `${b.id}: a desk drawing on ${b.domains.length} domains is either empty or a vertical in disguise`);
  }
});
