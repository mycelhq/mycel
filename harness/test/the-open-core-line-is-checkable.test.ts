/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * THE README DESCRIBED THE OPPOSITE OF THIS REPOSITORY
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Until 14 September the License section said, in these words:
 *
 *   > **What that gets you:** the `/v1` contract, the harness, every gate, every service definition,
 *   > and an operator console to run and approve work from. **What it does not:** clients,
 *   > engagements, invoices, chasing, a client-facing portal, or the machinery for finding clients —
 *   > that is the hosted product.
 *
 * Every item in the second list is in this repository. `/v1/portal` has 41 routes. `/v1/gtm` has 23.
 * Invoices have 13 and the chase ladder is `dunning.ts`. And the one thing the first list promises
 * that is NOT here is the console — the same README says eighty lines earlier that there is no UI in
 * this repository.
 *
 * So it over-promised the one thing it does not have and disowned six things it does, while linking
 * to `docs/OPEN-CORE.md` for the details, which 404ed.
 *
 * For an open-core project that is not a typo. Somebody reading "you do not get clients, invoices,
 * chasing or a portal" concludes the repo is a wrapper around a paywall and closes the tab — and
 * they are the exact person we want. The repo was undersold into looking like a toy.
 *
 * ═══ WHY A TEST AND NOT A PROOFREAD ═══
 *
 * Because it will drift again. The boundary moves whenever a route moves, and prose has no way to
 * notice. Every claim in the open-core table is a file or a route, so every claim is checkable, and
 * this fails the build rather than misleading a stranger.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const README = read("README.md");
const OPEN_CORE = read("docs/OPEN-CORE.md");

/** Every `"/v1/<thing>` literal in the harness, counted — the same command the doc tells you to run. */
function routeCounts(): Map<string, number> {
  const out = execFileSync("grep", ["-rhoE", '"/v1/[a-z-]+', join(ROOT, "harness/src")], {
    encoding: "utf8",
  });
  const counts = new Map<string, number>();
  for (const line of out.split("\n")) {
    const m = /"\/v1\/([a-z-]+)/.exec(line);
    if (!m) continue;
    counts.set(m[1]!, (counts.get(m[1]!) ?? 0) + 1);
  }
  return counts;
}

test("THE THINGS THE README SAYS YOU GET ARE ACTUALLY HERE", () => {
  /*
    The half that was wrong. Each of these was listed as NOT included, and each has a live route
    surface — so if one is ever genuinely moved out, this fails and the README has to be corrected
    in the same commit rather than three weeks later.
  */
  const counts = routeCounts();
  for (const [area, floor] of [["portal", 20], ["gtm", 10], ["invoices", 5], ["deliverables", 5], ["clients", 3], ["cases", 3]] as const) {
    assert.ok(
      (counts.get(area) ?? 0) >= floor,
      `the README promises ${area} in the open kernel and it has ${counts.get(area) ?? 0} routes`,
    );
  }
  // And the chase ladder, which is a module rather than a route surface.
  assert.ok(existsSync(join(ROOT, "harness/src/dunning.ts")), "the README promises the chase ladder");
});

test("THE README DOES NOT PROMISE A UI IT DOES NOT SHIP", () => {
  // It said "an operator console to run and approve work from" eighty lines after saying "there is
  // no UI in this repository".
  assert.match(README, /no UI in this repository/, "the headless claim went missing");
  const dirs = readdirSync(ROOT, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  for (const ui of ["cloud", "console", "web", "portal-app"]) {
    assert.ok(!dirs.includes(ui), `a UI directory appeared (${ui}) — the headless claim is now false`);
  }
  assert.doesNotMatch(
    README.slice(README.indexOf("## License")),
    /operator console to run and approve/,
    "the License section promises a console this repository does not contain",
  );
});

test("every file the open-core table names exists", () => {
  // The table's whole job is being checkable. A path that does not resolve makes it decoration.
  const paths = [...OPEN_CORE.matchAll(/`((?:harness|wedges|blueprints|skills|docker)\/[A-Za-z0-9._/-]+)`/g)]
    .map((m) => m[1]!)
    .filter((p) => !p.endsWith("/"));
  assert.ok(paths.length >= 10, `the table stopped naming files: ${paths.length}`);
  const missing = [...new Set(paths)].filter((p) => !existsSync(join(ROOT, p)));
  assert.deepEqual(missing, [], `open-core table names files that are not here: ${missing.join(", ")}`);
});

test("EVERY LINK THE README MAKES RESOLVES, INCLUDING THE ABSOLUTE ONES", () => {
  /**
   * `docs/OPEN-CORE.md` was linked as a full `https://github.com/mycelhq/mycel/blob/main/...` URL and
   * did not exist. A relative-link check misses that shape entirely, which is how a 404 sat on the
   * single question every open-core reader asks first.
   */
  const relative = [...README.matchAll(/\]\((\.\/[^)]+|docs\/[^)]+)\)/g)].map((m) => m[1]!);
  const selfAbsolute = [...README.matchAll(/https:\/\/github\.com\/mycelhq\/mycel\/blob\/main\/([^)#]+)/g)]
    .map((m) => m[1]!);
  const images = [...README.matchAll(/src="((?!https?:)[^"]+)"/g)].map((m) => m[1]!);

  const all = [...new Set([...relative, ...selfAbsolute, ...images])].map((p) => p.replace(/^\.\//, ""));
  assert.ok(all.length >= 8, `the README stopped linking anything: ${all.length}`);
  const missing = all.filter((p) => !existsSync(join(ROOT, p.split("#")[0]!)));
  assert.deepEqual(missing, [], `the README links to files that do not exist: ${missing.join(", ")}`);
});

test("no public doc publishes our production resources", () => {
  /**
   * `docs/AGENTMAIL.md` shipped a table headed "Live resources" with our webhook endpoint id and our
   * two ops mailboxes in it, in a public repository, referenced by nothing. It was a runbook for our
   * deployment rather than documentation of the product, and it moved to the private monorepo.
   *
   * Secrets were never in it — they live in Secrets Manager — so this is not a leak hunt. It is the
   * rule that a doc in this repo is for the person who cloned it.
   */
  const LEAKS = [
    [/ep_[A-Za-z0-9]{18,}/, "a webhook endpoint id"],
    [/\b\d{12}\b(?![-.\d])/, "an AWS account number"],
    [/arn:aws:/, "an AWS ARN"],
    [/Live resources/, "a live-resources inventory"],
  ] as const;
  for (const f of readdirSync(join(ROOT, "docs")).filter((f) => f.endsWith(".md"))) {
    const body = read(join("docs", f));
    for (const [re, what] of LEAKS) {
      assert.doesNotMatch(body, re, `docs/${f} publishes ${what}`);
    }
  }
});

test("THE HERO IMAGE CANNOT QUIETLY BECOME A SEVEN-MEGABYTE DOWNLOAD", () => {
  /**
   * The banner is the first thing above the fold on the repo page, so it is the first thing a
   * stranger waits for. The first render inherited the LinkedIn pipeline's 2× device pixel ratio and
   * came out at 4864px and **6.7 MB** — a design that looks identical at display size and costs
   * thirteen times the bytes, which is the kind of regression nobody notices by looking.
   *
   * The grain is shader noise and PNG cannot compress it, so the budget is held by rendering at 1×
   * and quantising to 64 colours with no dither. `design/brand/banner/README.md` carries the command.
   */
  const banner = join(ROOT, "design/brand/banner-readme.png");
  assert.ok(existsSync(banner), "the README hero is gone — the top of the page is a broken image");
  const kb = statSync(banner).size / 1024;
  assert.ok(kb < 600, `the README hero is ${Math.round(kb)} KB, over the 600 KB budget`);
  assert.match(README, /brand\/banner-readme\.png/, "the README stopped using the hero");
});
