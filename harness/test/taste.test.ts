// Whether a document LOOKS like something a person made, checked mechanically.
//
// ═══ WHY THIS TEST EXISTS, AND WHY IT IS THE POINT ═══
//
// A close pack came back with the verdict "it looks like a slab". The fix I reached for first was to
// open `report.ts` and change 22 to 30, add a rule, tint a panel — and that fix is worth nothing,
// because the next template starts at zero and the taste lives in whichever afternoon I spent on it.
// Worse: the linter's first run on my hand-tuned version found NINE type sizes and SIX text colours,
// sprawl I introduced myself while trying to make it look better.
//
// So taste is in the system in three pieces, and this file holds all three to account:
//
//   `design.ts`  — the ladder. Sizes are steps, gaps are rhythm units, colours are named roles.
//   `taste.ts`   — the linter. What makes a page look generated, as arithmetic over a Scene.
//   the ratchet  — the last test below. EVERY document type the kernel can render, linted, zero
//                  findings. A new template cannot ship ugly; it fails here first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { render, scenes, slidesFromBlocks, tasteFindings, isBlocking } from "../src/render";
import { blocksFromMarkdown, chartBlock, insertChart } from "../src/render/report";
import { designFor } from "../src/render/design";
import { SceneBuilder, A4 } from "../src/render/scene";
import { resolveBrandKit } from "../src/brandkit";
import { renderWorkbook } from "../src/render/xlsx";
import { machineHeaders } from "../src/render/taste";
import { malformedCsv } from "../src/runtime";
import closeFigures from "../../workflows/close-figures.mjs";
import type { ReportDocumentInput } from "../src/render/report";
import type { DeckDocumentInput, InvoiceDocumentInput, ReceiptDocumentInput } from "../src/render";
import type { Invoice } from "../src/contract";

const kit = resolveBrandKit({ display_name: "Hartley Bookkeeping", accent: "#0f766e" }, "Hartley");
const rules = (fs: { rule: string }[]): string[] => fs.map((f) => f.rule);

test("the slab is caught, and named as the four things that make it one", () => {
  // Thirty correct lines, one size, one margin, nothing drawn. This is what the complaint was about
  // and every one of the four findings is a separate reason the page reads as generated.
  const b = new SceneBuilder(A4.width, A4.height);
  for (let i = 0; i < 30; i++) {
    b.text({ x: 48, y: 60 + i * 15, text: `Line ${i} of correct and unreadable prose about the month.`, size: 10, family: "sans", weight: "normal", fill: "#1f2937", anchor: "start" });
  }
  const found = rules(tasteFindings([b.done("slab")]));
  assert.ok(found.includes("flat-hierarchy"), "nothing is bigger than anything else");
  assert.ok(found.includes("single-axis"), "everything starts at the same x");
  assert.ok(found.includes("no-structure"), "no rule, panel or grouping anywhere");
  assert.ok(found.includes("wall-of-text"), "no landing for the eye");
});

test("text off the page and text on text are BLOCKING, the rest are not", () => {
  // The distinction matters: a gate that refuses a delivery over eight type sizes gets switched off,
  // and one that ships a document with the total printed over the client's address should not exist.
  const b = new SceneBuilder(A4.width, A4.height);
  for (let i = 0; i < 14; i++) b.text({ x: 48, y: 60 + i * 15, text: "body line", size: 10, family: "sans", weight: "normal", fill: "#1f2937", anchor: "start" });
  b.text({ x: 430, y: 300, text: "https://example.com/a/very/long/reference/that/keeps/going/forever", size: 10, family: "sans", weight: "normal", fill: "#1f2937", anchor: "start" });
  b.text({ x: 48, y: 60, text: "colliding heading", size: 20, family: "sans", weight: "bold", fill: "#1f2937", anchor: "start" });

  const found = tasteFindings([b.done("broken")]);
  assert.ok(rules(found).includes("off-page"));
  assert.ok(rules(found).includes("collision"));
  assert.deepEqual(
    found.filter(isBlocking).map((f) => f.rule).sort(),
    ["collision", "off-page"],
    "single-axis and no-structure are nudges, not refusals",
  );
  // Every finding says what to change, not only what is wrong. A gate that teaches nothing gets the
  // same document back wearing different words — the argument tells.ts already made about prose.
  for (const f of found) assert.ok(f.detail.length > 40 && /\./.test(f.detail), `${f.rule} must say what to do`);
});

test("a caption at 5pt is unreadable, and that is a refusal", () => {
  const b = new SceneBuilder(A4.width, A4.height);
  b.text({ x: 48, y: 60, text: "terms and conditions apply", size: 5, family: "sans", weight: "normal", fill: "#1f2937", anchor: "start" });
  const found = tasteFindings([b.done("tiny")]);
  assert.ok(rules(found).includes("unreadable-type"));
  assert.ok(found.filter(isBlocking).length === 1);
});

/** A close pack that runs a hair over one page — the shape that produced the bug. */
const CLOSE: ReportDocumentInput = {
  title: "July close — Harlow & Finch",
  label: "Close pack",
  subtitle: "Prepared 30 August 2026 · covering 1–31 July",
  footer: "Hartley Bookkeeping · hello@hartley.co.uk",
  meta: [{ label: "Period", value: "July 2026" }, { label: "Prepared", value: "30 Aug 2026" }],
  blocks: [
    { kind: "paragraph", text: "July reconciles to the supplied closing balance of £13,494.61 with no difference. Money in was £9,840.00 and money out was £4,469.39. Four items need your answer before the VAT return can be finalised, and July PAYE was due on 22 August — I cannot see a payment for it." },
    { kind: "fields", rows: [
      { label: "Closing balance", value: "£13,494.61" },
      { label: "Money in", value: "£9,840.00" },
      { label: "Money out", value: "-£4,469.39" },
      { label: "Provisional result", value: "£4,070.61" },
    ] },
    { kind: "heading", text: "Where the money went", level: 1 },
    { kind: "chart", series: [
      { label: "payroll", value: 1950, note: "£1,950.00 · 47%" },
      { label: "rent", value: 1280, note: "£1,280.00 · 31%" },
      { label: "subcontractors", value: 396, note: "£396.00 · 10%" },
      { label: "entertaining", value: 147.5, note: "£147.50 · 4%" },
      { label: "software", value: 103.99, note: "£103.99 · 3%" },
      { label: "insurance", value: 96, note: "£96.00 · 2%" },
    ] },
    { kind: "heading", text: "What I need from you", level: 1 },
    { kind: "bullets", items: [
      "The £340.00 card payment on 20 July — I would hold it outside expenses as a director's loan until it is identified. Asking because there is no counterparty on the transaction.",
      "The £147.50 lunch at The Ox — I would treat it as client entertaining, which is not deductible for corporation tax and carries no reclaimable VAT. Confirm who attended.",
      "July PAYE and NIC were due on 22 August. If that has not gone, it is late now and interest runs daily.",
    ] },
  ],
};

test("a document that would put one line on page two is re-laid out, not shipped", () => {
  // THE ONE THIS MECHANISM EXISTS FOR. At full rhythm this pack overflows by a single bullet, and a
  // page carrying a header, a footer and one sentence is what a client remembers about it.
  //
  // The fix is not a hand-shaved gap — it is the linter telling the template to try again at tighter
  // rhythm. Type size and leading are untouched; only the space between blocks moves, because that is
  // the one genuinely elastic dimension on a page.
  const pages = scenes("report", CLOSE, kit);
  assert.equal(pages.length, 1, "the retry pulled it back onto one page");
  assert.deepEqual(tasteFindings(pages), []);

  // And the squeeze is bounded: it changes rhythm, never type. The title is the same size either way.
  const loose = designFor(kit);
  const tight = designFor(kit, { squeeze: 0.78 });
  assert.equal(loose.role.display.size, tight.role.display.size);
  assert.equal(loose.role.body.leading, tight.role.body.leading);
  assert.ok(tight.space(4) < loose.space(4));
});

test("the ladder is the point: one scale, and it moves with `base`", () => {
  const d = designFor(kit);
  /**
   * Two sizes a point apart read as a mistake; two a full step apart read as a decision. That is the
   * single biggest difference between a designed page and a generated one, and it is arithmetic —
   * so it is assertable. Roles MAY share a size (`eyebrow` and `caption` do, and differ by weight,
   * colour and tracking) — what must never happen is two sizes close enough to look accidental.
   */
  const sizes = [...new Set(Object.values(d.role).map((r) => r.size))].sort((a, b) => a - b);
  for (let i = 1; i < sizes.length; i++) {
    assert.ok(sizes[i]! / sizes[i - 1]! >= 1.09, `${sizes[i - 1]}pt and ${sizes[i]}pt are too close to read as different`);
  }
  // Hierarchy is real by construction, which is what `flat-hierarchy` measures on the output.
  assert.ok(d.role.display.size >= d.role.body.size * 2.5);

  /**
   * THE GENERALISATION TEST. A slide is `base: 20` and a 1280×720 page — the same ladder, the same
   * rhythm, the same named colours, at presentation size. If this held only for A4 then taste was
   * applied to one template rather than put into the system, which is the whole complaint.
   */
  const slide = designFor(kit, { base: 20, page: { width: 1280, height: 720 } });
  assert.equal(slide.role.body.size, 20);
  assert.ok(slide.role.display.size > d.role.display.size * 1.9);
  assert.ok(slide.page.margin > 50, `a slide margin scales with the page, got ${slide.page.margin}`);
  assert.equal(slide.content, 1280 - slide.page.margin * 2);
  // And the colours are the same four names, so a slide cannot invent a fifth grey.
  assert.deepEqual(Object.keys(slide.surface), Object.keys(d.surface));
});

test("figures get the page's largest type and a second axis — the other half of 'slab'", () => {
  const pages = scenes("report", CLOSE, kit);
  const texts = pages[0]!.nodes.filter((n) => n.t === "text");
  const d = designFor(kit);
  // The four figures are set at `figure`, two steps above the body. On a close those rows ARE the
  // deliverable and they used to be the quietest thing on the page.
  const headline = ["£13,494.61", "£9,840.00", "-£4,469.39", "£4,070.61"];
  const cards = texts.filter((n) => n.t === "text" && headline.includes(n.text));
  assert.equal(cards.length, 4);
  assert.ok(cards.every((n) => n.t === "text" && n.size === d.role.figure.size), "the figures are set at `figure`, two steps above the body");
  // And they are the largest thing on the page after the title, which is the hierarchy the
  // `flat-hierarchy` rule measures from the other end.
  const bodyish = texts.filter((n) => n.t === "text" && n.size === d.role.body.size);
  assert.ok(bodyish.length > 4 && d.role.figure.size >= d.role.body.size * 1.9);
  // And the cards put content at four x positions on a page that otherwise has one.
  assert.ok(new Set(texts.map((n) => n.t === "text" && n.x)).size >= 4);
});

/**
 * ═══ THE RATCHET ═══
 *
 * Every document type the kernel can render, linted, zero findings. This is what stops the next
 * template — written in a hurry for a service business the onboarding invented on a Tuesday — from
 * reaching a founder's client as a wall of 9pt text. The founder cannot be the quality gate: they
 * find out what it looks like at the same moment their client does.
 */
test("every document the kernel can render passes its own linter", () => {
  const inv: Invoice = {
    id: "inv_1",
    project_id: "proj_1",
    client_id: "cli_1",
    number: "INV-0007",
    status: "sent",
    currency: "GBP",
    issue_date: "2026-08-01",
    due_date: "2026-08-15",
    lines: Array.from({ length: 5 }, (_, i) => ({
      id: `l${i}`,
      description: `Monthly bookkeeping — retainer line ${i + 1}`,
      kind: "fixed" as const,
      quantity_milli: 1000,
      unit_amount: 24000,
    })),
    amount_paid: 0,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
  };
  const invoice: InvoiceDocumentInput = {
    invoice: inv,
    bill_to: { name: "Harlow & Finch Ltd", email: "ap@harlow.co.uk", address: ["12 Bridge Street", "Bristol", "BS1 4AA"] },
    today: "2026-08-10",
  };
  const receipt: ReceiptDocumentInput = {
    invoice: { ...inv, status: "paid", amount_paid: 144000 },
    bill_to: invoice.bill_to,
    payments: [{
      project_id: inv.project_id,
      invoice_id: inv.id,
      external_id: "manual:e1",
      amount_minor: 144000,
      currency: "GBP",
      paid_at: "2026-08-14",
      basis: "human",
      source: "recorded by hand",
      method: "bank_transfer",
      reference: "FT2608",
    }],
  };

  assert.deepEqual(render("invoice", invoice, kit).taste, []);
  assert.deepEqual(render("receipt", receipt, kit).taste, []);
  assert.deepEqual(render("deck", DECK, kit).taste, []);
  const report = render("report", CLOSE, kit);
  assert.deepEqual(report.taste, [], report.taste.map((f) => `${f.rule} — ${f.detail}`).join(" | "));
  // Attached even when empty, so a caller that checks it never wonders whether the check ran.
  assert.ok(Array.isArray(report.taste));
});

// ── The same idea, a different medium ─────────────────────────────────────────────────────────────
//
// A workbook fails the person who opened it in exactly the same way a PDF does — it arrives looking
// like something a person made, or like a table somebody exported and emailed. And the difference is
// just as mechanical, so it is the same linter with the same finding shape.

test("our field names never reach a client's spreadsheet", () => {
  // THE ONE THAT MATTERS MOST, and the reason it is BLOCKING rather than a nudge.
  //
  // Our outputs are snake_case objects, so the shortest path from a result to a sheet is
  // `Object.keys(row)` as the header row — and that hands a founder's CLIENT the field names of our
  // internal schema. The rule is that a founder never sees the guts of the platform; a file their
  // client opens is where it matters twice as much.
  const wb = renderWorkbook({
    currency: "GBP",
    sheets: [{
      name: "July",
      header: ["closing_balance_minor", "companyDomain", "id"],
      rows: [[{ kind: "n", v: 13494.61, format: "money" }, { kind: "s", v: "harlow.co.uk" }, { kind: "s", v: "a1" }]],
    }],
  });
  const f = wb.taste.find((x) => x.rule === "machine-headers")!;
  assert.ok(f, "a snake_case heading is a leak of our internals, not a column name");
  assert.ok(f.detail.includes("closing_balance_minor"));
  assert.match(f.where, /July/, "it names the tab in the words the reader would use");
  assert.ok(wb.taste.filter(isBlocking).some((x) => x.rule === "machine-headers"));
});

test("a column of money Excel cannot sum is caught", () => {
  // The single most common way a workbook fails: the client selects the column, looks at the status
  // bar, and there is no total — because every cell is a string that happens to look like money.
  // What they were sent was a picture of a spreadsheet.
  const wb = renderWorkbook({
    sheets: [{
      name: "Costs",
      header: ["Category", "Amount"],
      rows: [
        [{ kind: "s", v: "payroll" }, { kind: "s", v: "£1,950.00" }],
        [{ kind: "s", v: "rent" }, { kind: "s", v: "£1,280.00" }],
      ],
    }],
  });
  const f = wb.taste.find((x) => x.rule === "numbers-as-text")!;
  assert.ok(f);
  assert.match(f.detail, /cannot be summed/);
  assert.match(f.where, /Amount/);
  // "payroll" is text and must NOT trip it — the rule fires on formatted numbers, not on words.
  assert.equal(wb.taste.filter((x) => x.rule === "numbers-as-text").length, 1);
});

test("dates that sort alphabetically, and money without a money format", () => {
  const wb = renderWorkbook({
    sheets: [{
      name: "Ledger",
      header: ["Date", "Total"],
      rows: [
        [{ kind: "s", v: "2026-07-01" }, { kind: "n", v: 1200 }],
        [{ kind: "s", v: "2026-07-14" }, { kind: "n", v: 340.5 }],
      ],
    }],
  });
  assert.ok(wb.taste.some((x) => x.rule === "dates-as-text"));
  // Not blocking: the column sums correctly. It just shows 340.5 where a client expects 340.50.
  const money = wb.taste.find((x) => x.rule === "unformatted-money")!;
  assert.ok(money && !isBlocking(money));
  assert.match(money.detail, /1,234\.50/);
});

test("a clean workbook is clean, and every finding says what to change", () => {
  const wb = renderWorkbook({
    currency: "GBP",
    sheets: [{
      name: "July close",
      header: ["Category", "Amount", "Date"],
      rows: [
        [{ kind: "s", v: "Payroll" }, { kind: "n", v: 1950, format: "money" }, { kind: "d", v: "2026-07-28" }],
        [{ kind: "s", v: "Rent" }, { kind: "n", v: 1280, format: "money" }, { kind: "d", v: "2026-07-01" }],
      ],
    }],
  });
  assert.deepEqual(wb.taste, []);

  // And the vocabulary is shared across both mediums: same shape, same `isBlocking`, same promise
  // that a finding teaches rather than only refuses.
  const bad = renderWorkbook({ sheets: [{ name: "Dump", header: ["a_b", ""], rows: [] }] });
  for (const f of bad.taste) {
    assert.ok(f.rule && f.where && f.detail.length > 40, `${f.rule} must name itself, where it is, and what to do`);
    assert.ok(!/\bsnake_case\b|artifact|wedge|capability/i.test(f.where), "the location is in the reader's words, never ours");
  }
});

// ── The same rule, wherever a header row appears ─────────────────────────────────────────────────

test("a CSV a wedge ships is refused if its header row is our field names", () => {
  // Structure was the only thing checked here, and a perfectly-formed CSV whose first line reads
  // `date,amount_minor,description` has still failed the client's accountant. Two of this repo's own
  // workflows shipped exactly that, which is why the check lives at the door rather than in a
  // reviewer's head.
  const bad = malformedCsv("ledger.csv", "date,amount_minor,description\n2026-07-04,-128000,Rent\n");
  assert.ok(bad, "a field name in a header row is a fault, not a style note");
  assert.match(bad!, /amount_minor/);
  assert.match(bad!, /never see how we store things/);

  // Title-case headings pass, and a comma inside a quoted heading does not confuse the split.
  assert.equal(malformedCsv("ledger.csv", 'Date,Amount,"Description, full"\n2026-07-04,-1280.00,Rent\n'), undefined);
  // camelCase is nobody's deliberate choice of heading either.
  assert.match(malformedCsv("x.csv", "companyDomain,Amount\na.com,1\n")!, /companyDomain/);
  // Structure still comes first: a shifted column is the worse fault and is reported as such.
  assert.match(malformedCsv("x.csv", "Date,Amount\n2026-07-04,-1280.00,extra\n")!, /not valid CSV/);
});

test("the workflows that write client files keep their own field names out of them", () => {
  // THE RATCHET FOR THE RULE. Not a review note — the two workflows that actually produce files a
  // client opens, run, with every header row they emit checked.
  const close = closeFigures({
    period: "July 2026",
    currency: "GBP",
    opening_balance_minor: 812400,
    closing_balance_minor: 1349461,
    transactions: [
      { date: "2026-07-04", amount_minor: -128000, description: "Studio rent, July", counterparty: "Marlowe Property", category: "rent" },
      { date: "2026-07-26", amount_minor: 144000, description: "Invoice INV-2026-073", counterparty: "Kestrel Coffee Ltd", category: "sales" },
    ],
  });

  for (const [name, body] of Object.entries(close.files)) {
    if (!name.endsWith(".csv")) continue;
    assert.equal(malformedCsv(name, body), undefined, `${name} carries our vocabulary into a client's file`);
  }
  for (const sheet of close.workbook.sheets) assert.deepEqual(machineHeaders(sheet.header), [], `the ${sheet.name} tab`);

  // And the amount column is a number an importer can read, not a picture of one.
  const [head, first] = close.files["ledger.csv"]!.trim().split("\n");
  assert.equal(head, "Date,Amount,Currency,Description,Counterparty,Category,Status");
  assert.match(first!, /^2026-07-04,-1280\.00,GBP,/, "a plain decimal, with the currency in its own column");
  assert.ok(!first!.includes("£"), "a currency symbol in a numeric column is the column Excel cannot sum");
});

// ── A deck: the proof the ladder is a system and not a stylesheet ────────────────────────────────

/** A quarterly review, in the shape a founder's client actually gets one. */
const DECK: DeckDocumentInput = {
  title: "Q3 review — Harlow & Finch",
  subtitle: "Prepared by Hartley Bookkeeping · 30 August 2026",
  footer: "Harlow & Finch · Q3 2026",
  slides: [
    { kind: "title", title: "Q3 review — Harlow & Finch", subtitle: "Three months, one number that changed", footnote: "Commercial in confidence" },
    { kind: "statement", text: "You made £12,211 more this quarter than last, and £9,400 of it came from two clients.", support: "Which is the risk, not the win." },
    { kind: "stats", title: "The quarter", rows: [
      { label: "Revenue", value: "£84,310" },
      { label: "Costs", value: "£58,940" },
      { label: "Result", value: "£25,370" },
    ] },
    { kind: "section", title: "Where the money came from", eyebrow: "Part two" },
    { kind: "chart", title: "Revenue by client", series: [
      { label: "Kestrel Coffee", value: 31200, note: "£31,200 · 37%" },
      { label: "Vale Dental", value: 22400, note: "£22,400 · 27%" },
      { label: "Thorne & Sons", value: 15800, note: "£15,800 · 19%" },
      { label: "Marlowe", value: 9100, note: "£9,100 · 11%" },
      { label: "6 others", value: 5810, note: "£5,810 · 7%" },
    ] },
    { kind: "bullets", title: "What I would do next", items: [
      "Two clients are 64% of revenue. One leaving takes the quarter with it.",
      "Your average invoice is paid in 41 days against 14-day terms — that is £11,400 sitting out.",
      "Software spend is up 38% and nobody has cancelled anything since March.",
    ] },
    { kind: "quote", text: "They told me about the concentration risk before I noticed it myself.", attribution: "— what we would like the next referral to say" },
  ],
};

test("a deck is a page size — the same ladder, at presentation scale", () => {
  // THE TEST THAT SAYS WHETHER ANY OF THIS WAS WORTH IT.
  //
  // A deck shares nothing with a monthly close except the brand: different page, different sizes,
  // different everything a person would call "the design". If the ladder were only a stylesheet for
  // report.ts, this would be a second afternoon of hand-picked numbers. `deck.ts` contains no point
  // values at all — it asks designFor(kit, {base: 20, page: 1280x720}) and lays out roles.
  const pages = scenes("deck", DECK, kit);
  assert.equal(pages.length, DECK.slides.length, "one Scene per slide");
  assert.equal(pages[0]!.width, 1280);
  assert.equal(pages[0]!.height, 720);
  assert.deepEqual(tasteFindings(pages), [], tasteFindings(pages).map((f) => `${f.where} ${f.rule}`).join(" | "));

  // The figures are the largest type in the deck, because on a slide the number IS the slide.
  const statTexts = pages[2]!.nodes.filter((n) => n.t === "text" && n.text.startsWith("£"));
  const d = designFor(kit, { base: 20, page: { width: 1280, height: 720 } });
  assert.equal(statTexts.length, 3);
  assert.ok(statTexts.every((n) => n.t === "text" && n.size >= d.role.figure.size));
  // And they are set at slide scale, not document scale — the whole claim of `base`.
  assert.ok(statTexts.every((n) => n.t === "text" && n.size > designFor(kit).role.display.size));
});

test("a slide holding a document is caught, and only on a slide", () => {
  // A deck is read AT a room while somebody talks over it. The moment a slide holds a paragraph the
  // room stops listening and starts reading, and the speaker is competing with their own slide.
  const wordy: DeckDocumentInput = {
    title: "Wordy",
    slides: [{
      kind: "bullets",
      title: "Everything we did",
      items: Array.from({ length: 6 }, () =>
        "This is a full sentence of the kind that belongs in the covering note rather than on a slide, because a room cannot listen to a person and read a paragraph at the same time.",
      ),
    }],
  };
  const found = tasteFindings(scenes("deck", wordy, kit));
  assert.ok(found.some((f) => f.rule === "overfull-slide"), found.map((f) => f.rule).join(","));

  // The same word count in a REPORT is a report, and must not be flagged: the rule is about how a
  // deck is read, not about how much text is too much in general.
  const long: ReportDocumentInput = {
    title: "A long note",
    blocks: [{ kind: "paragraph", text: (wordy.slides[0] as { items: string[] }).items.join(" ") }],
  };
  assert.ok(!tasteFindings(scenes("report", long, kit)).some((f) => f.rule === "overfull-slide"));
});

// ── Markdown → slides: the model's job does not change ───────────────────────────────────────────

/** What a geo week's model actually writes, and what its pack returns. */
const GEO_MD = `Kestrel Coffee was named in 11 of 24 answers this week, up from 7. Being named is reputation; being cited is a page doing work, and only 4 of those 11 linked you. Perplexity is where you are strongest and Google's AI overview is where you are absent.

Share of voice: 45.8%
Queries asked: 24
Answers naming you: 11
Answers citing a page: 4

## Who is ahead

## What to do this week

- Small: add a two-sentence direct answer to the top of the "flat white vs cortado" page.
- Medium: write the Bristol coffee subscription comparison — three of the four answers that skipped you were comparisons.
- Large: run the roastery origin survey and publish the numbers.

We start on the Small on Monday and it should be live by Wednesday.`;

const GEO_CHART = chartBlock(
  { series: "top_competitors", label: "name", value: "beat_us_on", title: "Who is winning the citations" },
  { top_competitors: [
    { name: "Clifton Coffee", beat_us_on: 9 },
    { name: "Extract", beat_us_on: 6 },
    { name: "Triple Co", beat_us_on: 4 },
  ] },
);

test("the chart fills the slot the author left for it", () => {
  // `## Who is ahead` with nothing underneath is the model reserving a place for the picture — it has
  // been told not to write markup, so an empty heading is the only way it CAN ask. Splicing the chart
  // after the first paragraph instead left that heading titling the section after it, which came out
  // as a slide holding two words and a page number.
  const blocks = insertChart(blocksFromMarkdown(GEO_MD), GEO_CHART);
  const headingAt = blocks.findIndex((b) => b.kind === "heading" && b.text === "Who is ahead");
  assert.ok(headingAt >= 0);
  assert.equal(blocks[headingAt + 1]!.kind, "chart", "the chart goes under the heading written for it");

  // With no empty heading, the old rule still applies: after the opening paragraph, never at the end
  // past the questions the client has to answer.
  const plain = insertChart(blocksFromMarkdown("An opening line.\n\n## Findings\n\n- one\n- two"), GEO_CHART);
  assert.equal(plain[1]!.kind, "chart");
});

test("a geo week becomes a deck a client can forward", () => {
  const blocks = insertChart(blocksFromMarkdown(GEO_MD), GEO_CHART);
  const slides = slidesFromBlocks(blocks, { title: "AI visibility — Kestrel Coffee" }, resolveBrandKit(undefined, "Kestrel Coffee"));

  assert.deepEqual(slides.map((s) => s.kind), ["title", "statement", "statement", "stats", "chart", "bullets", "statement"]);
  // The author's heading titles the chart slide, not the wedge's declared default: they wrote it for
  // this slide, and using ours would drop a line somebody chose in favour of a fallback.
  assert.equal((slides[4] as { title?: string }).title, "Who is ahead");
  assert.equal((slides[5] as { title?: string }).title, "What to do this week");

  // ONE BULLET ON A SLIDE IS NOT A LIST. The first version of this transform put the last sentence of
  // the lede and the closing commitment on their own slides as single bullets — the deck equivalent
  // of the dangling page, and worse, because a bullet announces "one of several" and there is one.
  assert.ok(!slides.some((s) => s.kind === "bullets" && s.items.length === 1 && !s.title));
  assert.match((slides[6] as { text: string }).text, /Monday/, "the closing line is a statement, not a lone bullet");

  // NOTHING IS DROPPED. Every sentence and every figure in the markdown is somewhere in the deck.
  const words = JSON.stringify(slides);
  for (const phrase of ["11 of 24", "Perplexity", "45.8%", "Clifton Coffee", "roastery origin survey", "Wednesday"]) {
    assert.ok(words.includes(phrase), `"${phrase}" fell out of the deck`);
  }
  assert.deepEqual(tasteFindings(scenes("deck", { title: "AI visibility — Kestrel Coffee", footer: "Northbound", slides }, kit)), []);
});

test("geo-monitor's weekly report is declared as a deck, so the renderer is reached", () => {
  // A renderer nothing calls is a renderer that rots. This asserts the wiring end to end: the wedge
  // declares it, and the chart it declares points at fields the pack actually returns.
  const wedge = JSON.parse(readFileSync(new URL("../../wedges/geo-monitor/wedge.json", import.meta.url), "utf8")) as {
    task_types: Record<string, { deck?: boolean; chart?: { series: string; label: string; value: string } }>;
  };
  const weekly = wedge.task_types.weekly_report!;
  assert.equal(weekly.deck, true);
  assert.equal(weekly.chart?.series, "top_competitors");
  // `packs/share_of_voice/1/run.mjs` returns `{ name, beat_us_on }` rows — a chart spec pointing at
  // fields that do not exist renders nothing and complains about nothing, which is the silent kind.
  assert.equal(weekly.chart?.label, "name");
  assert.equal(weekly.chart?.value, "beat_us_on");
  const pack = readFileSync(new URL("../../packs/share_of_voice/1/run.mjs", import.meta.url), "utf8");
  assert.match(pack, /beat_us_on/);
});
