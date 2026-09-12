// The seeded close report, and the one property that decides whether it can be shown to anyone.
//
// `/deliverables` and the client portal are the two screens this product is sold on. Until now the
// seed attached a CSV to the delivered work, so both rendered a spreadsheet — honest, and not
// something a founder shows a prospect. The report is the document a client actually opens, and it
// is built FROM `CLOSE_CSV` rather than beside it: two hand-maintained copies of one month's
// figures is how a demo comes to contradict itself.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SEED = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "seed-demo.ts"),
  "utf8",
);

/** The CSV exactly as the seed declares it — the single source both the export and report use. */
function closeCsv(): string[][] {
  const block = SEED.match(/const CLOSE_CSV = \[([\s\S]*?)\]\.join/);
  assert.ok(block, "CLOSE_CSV is gone — if it was renamed, update this test rather than deleting it");
  return block[1]
    .split("\n")
    .map((l) => l.trim().replace(/^"|",?$/g, ""))
    .filter((l) => l && l !== '"')
    .map((l) => l.split(","));
}

/**
 * ═══ THE SUMMARY LINE HAS TO BE POSSIBLE ═══
 *
 * This asserted the P&L accounts summed to `Net`, to the cent, when the fixture was a bookkeeping
 * close. The subject is now share of voice per answer engine, and a WEIGHTED share is not a sum —
 * adding five percentages would give 143%. So the arithmetic property changes with the subject
 * rather than being deleted: a weighted mean must lie between the smallest and largest thing it
 * averages. A demo whose headline figure sits outside its own table is the same defect as one that
 * is out by a cent, and it is the one a prospect checks first.
 */
test("the weighted share of voice lies inside the surfaces it summarises", () => {
  const rows = closeCsv().slice(1).filter((c) => c.length === 4 && c[0] && c[1]);
  const netAt = rows.findIndex((c) => c[0] === "Weighted share of voice");
  assert.ok(netAt > 0, "no weighted total row");
  const surfaces = rows.slice(0, netAt).map((c) => Number(c[1]));
  assert.ok(surfaces.length >= 3, "a share of voice across fewer than three surfaces is not one");
  const stated = Number(rows[netAt][1]);
  assert.ok(
    stated >= Math.min(...surfaces) && stated <= Math.max(...surfaces),
    `stated ${stated}% is outside the range of its surfaces (${Math.min(...surfaces)}–${Math.max(...surfaces)})`,
  );
});

/** Every movement must agree with the two columns beside it, or the report argues with itself. */
test("each change column equals this month minus last", () => {
  for (const c of closeCsv().slice(1).filter((r) => r.length === 4 && r[0] && r[1] && r[3])) {
    const delta = Number(c[1]) - Number(c[2]);
    const stated = Number(String(c[3]).replace(/[^0-9.-]/g, ""));
    if (!Number.isFinite(delta) || !Number.isFinite(stated)) continue;
    assert.ok(
      Math.abs(delta - stated) < 0.05,
      `${c[0]}: ${c[1]} − ${c[2]} is ${delta.toFixed(1)}, table says ${c[3]}`,
    );
  }
});

test("the trailing counts never reach the percentage table", () => {
  // `Questions probed,40,,` has four fields like every surface row, so a shape filter admits it and
  // it renders as "Questions probed  40.0%" — a count formatted as a share. Slicing at the weighted
  // total is what keeps it out, and this asserts the counts are still AFTER it.
  const rows = closeCsv().slice(1).filter((c) => c.length === 4 && c[0] && c[1]);
  const netAt = rows.findIndex((c) => c[0] === "Weighted share of voice");
  const after = rows.slice(netAt + 1).map((c) => c[0]);
  assert.ok(after.some((n) => /probed/i.test(n)), "the counts moved above the total");
  const table = rows.slice(0, netAt).map((c) => c[0]);
  assert.ok(!table.some((n) => /probed|awaiting/i.test(n)), "a count is in the percentage table");
});

test("the close pack is RENDERED BY THE PRODUCT, not hand-built beside it", () => {
  /**
   * This replaces two tests that guarded a hand-written HTML template. Their properties survive —
   * the figures must be read rather than retyped, and the document must not reach the network —
   * but the template is gone: the seed now calls the same `render("report", …)` the server calls
   * for invoices, so the demo shows what this software actually produces instead of a page this
   * script drew.
   *
   * That is the point of the change, so it is the thing pinned. A future edit that quietly goes
   * back to hand-built HTML would make the two screens this product is sold on demonstrate
   * something the product does not do.
   */
  assert.match(SEED, /render\(\s*"report"/, "the seed no longer renders the close pack with the product");
  assert.match(SEED, /resolveBrandKit\(/, "the pack is not going through a brand kit, so it is unbranded");
  assert.match(SEED, /kind: "chart"/, "no chart — the block report.ts exists for is missing from page one");
});

test("every figure in the pack is read from the CSV, not typed beside it", () => {
  // Unchanged in intent from the HTML version: a literal amount in the report is a second copy of
  // the month, and two copies drift the first time anybody edits one.
  const block = SEED.slice(SEED.indexOf('render(\n      "report"'), SEED.indexOf("const reportForm"));
  assert.ok(block.length > 0, "the render call moved — this test can no longer see it");
  assert.match(block, /closeRows/, "the table no longer interpolates the parsed rows");
  const hardcoded = block.match(/\$[0-9][0-9,]*\.[0-9]{2}/g) ?? [];
  assert.deepEqual(hardcoded, [], `hardcoded figures in the pack: ${hardcoded.join(", ")}`);
});

test("a PDF cannot reach the network, which is why it is the better artifact here", () => {
  // The HTML version needed a test proving it had no <link>, no @import and no webfont, because it
  // was served into an iframe where a blocked request is a silently degraded layout. A rendered PDF
  // carries its own metrics from `fonts.ts` and has nowhere to reach — the property is now
  // structural rather than asserted, and this records why the old assertion was dropped.
  assert.doesNotMatch(SEED, /fonts\.googleapis|<link[^>]+href=/, "the seed reaches the network for a font");
});
// ── The state the product is actually sold on ──────────────────────────────────────────────────
//
// The released close was the only deliverable, so `/deliverables` showed one row in one state and
// the lifecycle — drafting → in_review → with_client → accepted — was invisible. The founder's
// gate is this product's core promise ("nothing reaches a client until you release it") and a demo
// could not show it, because nothing was ever waiting.

test("one deliverable is released and one is waiting on the founder", () => {
  const released = SEED.match(/deliverables\/\$\{deliverable\.id\}\/release/);
  assert.ok(released, "the released deliverable is gone");
  // The second must NOT be released — that is the entire reason it exists.
  const afterSecond = SEED.slice(SEED.indexOf("const displacementPdf"));
  assert.ok(
    !/\/release/.test(afterSecond),
    "the in_review deliverable got released, which erases the state it was seeded to show",
  );
});

/**
 * ═══ THE SECOND DELIVERABLE IS ALSO RENDERED BY THE PRODUCT NOW ═══
 *
 * These two tests guarded a hand-written HTML sales-tax sheet: 40 lines of markup with its own
 * stylesheet and its own dark-mode media query, maintained in the seed, sitting beside a
 * deliverable that `render/report.ts` produced. Two document formats for one firm is the defect the
 * brand kit exists to prevent, and a viewer comparing both artifacts on one screen saw two
 * different companies.
 *
 * The properties they protected both survive and are asserted below against the replacement: the
 * figures are read from a table rather than typed, and nothing reaches the network for a font.
 */
test("the displacement review is rendered, and reads from its own table", () => {
  const rows = SEED.match(/const DISPLACEMENT = \[([\s\S]*?)\];/);
  assert.ok(rows, "DISPLACEMENT is gone — if it was renamed, update this test rather than deleting it");
  const parsed = [...rows[1].matchAll(/\[([^\]]+)\]/g)].map((m) =>
    m[1].split(",").map((x) => x.trim().replace(/^"|"$/g, "")),
  );
  assert.ok(parsed.length >= 4, "a displacement review with fewer than three questions says nothing");
  for (const r of parsed) assert.equal(r.length, 4, `ragged row: ${r.join(" | ")}`);

  // The table must be interpolated, not retyped — same rule the close pack follows.
  const block = SEED.slice(SEED.indexOf("const displacementPdf"), SEED.indexOf("const taxForm"));
  assert.match(block, /DISPLACEMENT/, "the table no longer interpolates the parsed rows");
  assert.match(block, /render\(\s*"report"/, "the second deliverable is not rendered by the product");
});

/**
 * The one claim the document makes about itself: it names a competitor in every row, which is why
 * the seeded summary says it needs the founder's eyes before it goes out. A demo whose escalation
 * rule and whose document disagree is teaching the wrong lesson on the screen that sells the gate.
 */
test("the review that must be approved actually names a competitor", () => {
  const rows = SEED.match(/const DISPLACEMENT = \[([\s\S]*?)\];/);
  assert.ok(rows);
  const body = [...rows[1].matchAll(/\[([^\]]+)\]/g)]
    .map((m) => m[1].split(",").map((x) => x.trim().replace(/^"|"$/g, "")))
    .slice(1);
  assert.ok(
    body.every((r) => r[1] && r[1].length > 2),
    "every row must say who wins — that is the whole subject of the document",
  );
  assert.match(SEED, /Anything that names a competitor in a claim we would publish/,
    "the escalation rule that makes this deliverable need approval is gone");
});
