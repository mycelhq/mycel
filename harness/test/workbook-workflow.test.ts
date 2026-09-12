import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderWorkbook } from "../src/render/xlsx";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * A REAL SPREADSHEET, FOR ANY TRADE
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `render/xlsx.ts` writes a genuine Excel workbook and records the complaint it was built for: "a
 * client paying £400 a month received a monthly close as a PDF and a CSV… A CSV is a text file with
 * commas in it — their accountant imports it, and nobody else opens it twice."
 *
 * That complaint is not about bookkeeping. A recruiter's longlist, a GEO ranking table, a control
 * matrix — all grids a client wants to sort and forward, all shipped as CSV or flattened into prose.
 *
 * The kernel already rendered a workbook for ANY workflow returning one — `/v1/internal/workflows/:name`
 * does it generically. Only `close_figures` ever did, because only books-keeper wrote the plumbing.
 * Production has produced ZERO `.xlsx` files, ever.
 */
const WORKFLOWS = join(import.meta.dirname, "..", "..", "workflows");
const WEDGES = join(import.meta.dirname, "..", "..", "wedges");

const run = async (args: unknown) => {
  const mod = (await import(join(WORKFLOWS, "workbook.mjs"))) as { default: (a: unknown) => Promise<any> };
  return mod.default(args);
};

test("it produces a workbook the renderer accepts, as a real Excel file", async () => {
  const r = await run({
    filename: "longlist.xlsx",
    currency: "gbp",
    tabs: [
      { name: "Shortlist", header: ["Name", "Fit"], rows: [["Ada", { kind: "n", v: 0.92, format: "pct" }]] },
      { name: "Rejected", header: ["Name", "Why"], rows: [["Alan", "No clearance"]] },
    ],
  });
  assert.equal(r.ok, true);
  const doc = renderWorkbook(r.workbook);
  assert.match(doc.content_type, /spreadsheetml/);
  assert.ok(doc.size_bytes > 1000, "the workbook came back empty");
  // A zip, which is what an xlsx is.
  assert.equal(Buffer.from(doc.content, "base64").subarray(0, 2).toString(), "PK");
});

test("a short row is padded, never dropped", async () => {
  // Same rule as the report's tables: a row missing a trailing cell is one small mistake, and
  // dropping it loses a client's number.
  const r = await run({ tabs: [{ name: "T", header: ["A", "B", "C"], rows: [["1"], ["1", "2", "3", "4"]] }] });
  assert.deepEqual(r.workbook.sheets[0].rows.map((row: unknown[]) => row.length), [3, 3]);
});

test("it never invents a currency", async () => {
  /**
   * The renderer's own rule: "a workbook whose money column silently carries the wrong symbol is
   * worse than one with none. An absent currency formats as a plain number, which is honest, rather
   * than as somebody else's money."
   */
  const none = await run({ tabs: [{ name: "T", header: ["A"], rows: [["x"]] }] });
  assert.equal(none.workbook.currency, undefined);
  const bad = await run({ currency: "pounds", tabs: [{ name: "T", header: ["A"], rows: [["x"]] }] });
  assert.equal(bad.workbook.currency, undefined, "a non-ISO string was accepted as a currency");
});

test("it refuses rather than shipping an empty book", async () => {
  assert.equal((await run({ tabs: [] })).ok, false);
  assert.equal((await run({ tabs: [{ name: "T", header: [], rows: [] }] })).ok, false);
});

test("more than one trade can reach it", async () => {
  // The whole point. If this drops back to a single wedge, the capability has re-narrowed to the
  // trade that happened to need it first.
  const declaring = readdirSync(WEDGES).filter((w) => {
    try {
      const m = JSON.parse(readFileSync(join(WEDGES, w, "wedge.json"), "utf8")) as {
        workflows?: { name?: string }[];
      };
      return (m.workflows ?? []).some((f) => f.name === "workbook");
    } catch {
      return false;
    }
  });
  assert.ok(declaring.length >= 4, `only ${declaring.length} trade(s) can ship a spreadsheet: ${declaring}`);
});
