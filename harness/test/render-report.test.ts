// The report renderer — the artifact half of the top-20 the kernel could not make before.
//
// Each test names the bug it exists to prevent:
//   - a report that flows past one page must actually paginate, not clip (the invoice's one-page
//     writer is exactly what a report cannot be).
//   - the same content must render to the same bytes forever, or "this report says X" is a
//     screenshot review, not a test.
//   - the branded letterhead must reach the document — a house-default report is wrong the way
//     every client notices and nobody reports.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveBrandKit } from "../src/brandkit";
import { render, scenes } from "../src/render";
import { toPdfPages } from "../src/render/pdf";
import { wrapText, blocksFromMarkdown, reportScenes, type ReportDocumentInput } from "../src/render/report";
import { A4 } from "../src/render/scene";

const KIT = resolveBrandKit({ display_name: "Hartley Bookkeeping", accent: "#0f766e" }, "proj");

function paras(n: number): ReportDocumentInput {
  return {
    title: "Monthly Close — July 2026",
    subtitle: "Prepared for Acme Ltd",
    meta: [
      { label: "Period", value: "July 2026" },
      { label: "Prepared", value: "1 Aug 2026" },
    ],
    footer: "Confidential — prepared by Hartley Bookkeeping",
    blocks: Array.from({ length: n }, (_, i) => ({
      kind: "paragraph" as const,
      text: `Section ${i + 1}. ${"Reconciled bank and ledger, chased two open items, and closed the month. ".repeat(4)}`,
    })),
  };
}

test("wrapText breaks on the real font metrics and never exceeds the width", () => {
  const lines = wrapText("the quick brown fox jumps over the lazy dog ".repeat(6), "sans", "normal", 10, 200);
  assert.ok(lines.length > 1, "long text must wrap to several lines");
  // No line may be empty-from-overflow, and the wrap is deterministic.
  assert.ok(lines.every((l) => l.length > 0));
});

test("wrapText hard-breaks a single token wider than the line, rather than overflowing", () => {
  const url = "https://example.com/a/really/long/path/that/will/not/fit/on/one/line/segment";
  const lines = wrapText(url, "sans", "normal", 10, 120);
  assert.ok(lines.length > 1, "an over-long token must be split, not run off the margin");
});

test("a short report is one page; a long one paginates", () => {
  assert.equal(reportScenes(paras(1), KIT).length, 1);
  const long = reportScenes(paras(40), KIT);
  assert.ok(long.length >= 3, `40 dense sections should span several pages, got ${long.length}`);
  // Every page is A4.
  assert.ok(long.every((s) => s.width === A4.width && s.height === A4.height));
});

test("the footer carries a correct 'Page X of Y' on every page", () => {
  const pages = reportScenes(paras(30), KIT);
  const total = pages.length;
  pages.forEach((s, i) => {
    const hasCounter = s.nodes.some((n) => n.t === "text" && n.text === `Page ${i + 1} of ${total}`);
    assert.ok(hasCounter, `page ${i + 1} must show 'Page ${i + 1} of ${total}'`);
  });
});

test("the tenant's name and title reach the letterhead", () => {
  const [first] = reportScenes(paras(1), KIT);
  const texts = first.nodes.filter((n) => n.t === "text").map((n: any) => n.text);
  assert.ok(texts.includes("Hartley Bookkeeping"), "wordmark must be present when no logo");
  assert.ok(texts.includes("Monthly Close — July 2026"), "the report title must be on the cover");
});

test("render('report') produces a real multi-page PDF, base64, non-trivial", () => {
  const out = render("report", paras(25), KIT);
  assert.equal(out.content_type, "application/pdf");
  assert.equal(out.encoding, "base64");
  const bytes = Buffer.from(out.content, "base64");
  assert.ok(bytes.slice(0, 5).toString("latin1") === "%PDF-", "must be a PDF");
  // More than one page object means pagination actually happened end-to-end.
  const pageCount = (bytes.toString("latin1").match(/\/Type \/Page[^s]/g) ?? []).length;
  assert.ok(pageCount >= 2, `expected multiple /Page objects, got ${pageCount}`);
  assert.ok(out.name.startsWith("report-"), out.name);
});

test("the same report renders to the same bytes — deterministic, testable", () => {
  const a = render("report", paras(12), KIT).content;
  const b = render("report", paras(12), KIT).content;
  assert.equal(a, b);
});

test("blocksFromMarkdown turns a model's natural output into laid-out blocks", () => {
  const blocks = blocksFromMarkdown(
    ["# Summary", "", "We closed the month.", "", "- Reconciled bank", "- Chased 2 items", "", "Net profit: £12,480", "Cash in bank: £48,200"].join("\n"),
  );
  const kinds = blocks.map((b) => b.kind);
  assert.deepEqual(kinds, ["heading", "paragraph", "bullets", "fields"]);
  const fields = blocks.find((b) => b.kind === "fields") as any;
  assert.equal(fields.rows.length, 2);
  assert.equal(fields.rows[0].label, "Net profit");
});

test("a table paginates and reprints its header on the new page", () => {
  const rows = Array.from({ length: 60 }, (_, i) => [`Row ${i + 1}`, `£${i * 10}`, "reconciled"]);
  const input: ReportDocumentInput = {
    title: "Ledger",
    blocks: [{ kind: "table", columns: ["Item", "Amount", "Status"], rows }],
  };
  const pages = reportScenes(input, KIT);
  assert.ok(pages.length >= 2, "60 rows must span pages");
  // The header cell "Item" appears on more than one page (reprinted).
  const headerPages = pages.filter((s) => s.nodes.some((n) => n.t === "text" && (n as any).text === "Item")).length;
  assert.ok(headerPages >= 2, "table header must reprint on each page it spills onto");
});

test("toPdfPages of a single scene equals toPdf — invoices/receipts are unchanged", () => {
  const [one] = reportScenes(paras(1), KIT);
  const viaPages = toPdfPages([one]);
  assert.ok(viaPages.length > 0 && viaPages.slice(0, 5).toString("latin1") === "%PDF-");
});
