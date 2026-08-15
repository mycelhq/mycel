// The artifact renderer. Every test here names the bug it exists to prevent.
//
// The three that matter most, and why they are the three the brief asked for:
//   - money never round-trips through a float. This is the bug that survives review, because
//     `(amount / 100).toFixed(2)` is right for almost every value a developer tries by hand.
//   - a rendered document contains the right total. A renderer that lays out beautifully and prints
//     a different number than the store holds is worse than no renderer.
//   - a tenant's branding reaches the artifact. Branding that silently falls back to house defaults
//     produces documents that are wrong in a way nobody reports and every client notices.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

import { invoiceTotals } from "../src/billing";
import { resolveBrandKit, normalizeBrandKitConfig, publicBrandKit, type BrandKit, type BrandLogo } from "../src/brandkit";
import type { Invoice } from "../src/contract";
import { formatBps, formatMinor, formatMoney, formatQuantityMilli } from "../src/render/money";
import { textWidth, truncateToWidth, winAnsiBytes } from "../src/render/fonts";
import { render, scene } from "../src/render";
import { toPdf } from "../src/render/pdf";
import { toSvg } from "../src/render/svg";
import { decodeImage } from "../src/render/image";

// ── fixtures ───────────────────────────────────────────────────────────────────────────────────

function invoice(over: Partial<Invoice> = {}): Invoice {
  return {
    id: "inv_1",
    project_id: "proj_1",
    client_id: "cli_1",
    number: "INV-0007",
    status: "sent",
    currency: "USD",
    issue_date: "2026-07-01",
    due_date: "2026-07-15",
    lines: [
      { id: "l1", description: "Monthly retainer", kind: "fixed", quantity_milli: 1000, unit_amount: 120000 },
      { id: "l2", description: "Extra hours", kind: "unit", quantity_milli: 2500, unit_amount: 2020 },
    ],
    amount_paid: 0,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
    ...over,
  } as Invoice;
}

const PLAIN: BrandKit = resolveBrandKit(undefined, "Hartley Bookkeeping");

/** The bytes of a valid 2×2 RGBA PNG, built here so the image path is exercised for real. */
function png2x2(): BrandLogo {
  const crcTable: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const byte of b) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, body: Buffer) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(body.length);
    const typed = Buffer.concat([Buffer.from(type, "latin1"), body]);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(typed));
    return Buffer.concat([head, typed, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  // 2 rows, each: filter byte 0 then 2 pixels × 4 bytes
  const raw = Buffer.from([
    0, 255, 0, 0, 255, 0, 255, 0, 255,
    0, 0, 0, 255, 255, 255, 255, 255, 0,
  ]);
  const bytes = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return { mime: "image/png", data: bytes.toString("base64"), width: 2, height: 2 };
}

/** PDF content streams are emitted uncompressed on purpose; that is what makes these assertions
 *  possible without a PDF parser. */
const asText = (pdf: Buffer) => pdf.toString("latin1");

// ── money: the bug is a float ──────────────────────────────────────────────────────────────────

test("money: formatting never divides — BigInt oracle over the whole safe-integer range", () => {
  // BUG THIS PREVENTS: `(amountMinor / 100).toFixed(2)`. It is wrong for large amounts (the double
  // cannot represent the quotient), wrong for JPY (no minor units) and wrong for BHD (three), and
  // every one of those failures prints a number that differs from what the store will charge.
  const oracle = (minor: bigint, exponent: number): string => {
    const neg = minor < 0n;
    const abs = neg ? -minor : minor;
    const digits = abs.toString().padStart(exponent + 1, "0");
    const whole = digits.slice(0, digits.length - exponent);
    const frac = exponent ? digits.slice(digits.length - exponent) : "";
    const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return `${neg ? "-" : ""}${grouped}${frac ? `.${frac}` : ""}`;
  };
  const cases: [number, string, number][] = [
    [0, "USD", 2],
    [1, "USD", 2],
    [5, "USD", 2],
    [99, "USD", 2],
    [100, "USD", 2],
    [-1250, "USD", 2],
    [125050, "USD", 2],
    [1250, "JPY", 0],
    [1250, "BHD", 3],
    [999_999_999_999_999, "USD", 2],
    [9_007_199_254_740_991, "USD", 2],
  ];
  for (const [minor, currency, exponent] of cases) {
    assert.equal(formatMinor(minor, currency), oracle(BigInt(minor), exponent), `${minor} ${currency}`);
  }
  // The value that makes the point, and it is a SAFE integer — this is not an exotic overflow, it
  // is an ordinary amount that the obvious implementation rounds to the wrong penny.
  assert.equal((8_459_831_396_163_929 / 100).toFixed(2), "84598313961639.30");
  assert.equal(formatMinor(8_459_831_396_163_929, "USD"), "84,598,313,961,639.29");
});

test("money: the renderer's money module reaches for none of the float shortcuts", () => {
  // BUG THIS PREVENTS: someone adds a helper here in six months and writes `/ 100` because it is
  // obvious. The comment at the top of money.ts says not to; this makes the comment enforceable.
  const src = readFileSync(join(process.cwd(), "harness/src/render/money.ts"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const forbidden of [/\/\s*10+\b/, /\btoFixed\b/, /\bparseFloat\b/, /\btoLocaleString\b/, /\bIntl\b/]) {
    assert.equal(forbidden.test(code), false, `money.ts must not contain ${forbidden}`);
  }
});

test("money: symbols, zero-decimal currencies and unknown codes", () => {
  assert.equal(formatMoney(125050, "GBP"), "£1,250.50");
  assert.equal(formatMoney(1250, "JPY"), "¥1,250");
  // BUG THIS PREVENTS: guessing a symbol. An unknown currency prints its ISO code, because a wrong
  // symbol on an invoice is a currency dispute.
  assert.equal(formatMoney(125050, "SEK"), "SEK 1,250.50");
  assert.equal(formatMoney(-500, "USD"), "-$5.00");
  assert.equal(formatQuantityMilli(2500), "2.5");
  assert.equal(formatQuantityMilli(1000), "1");
  assert.equal(formatBps(2000), "20%");
  assert.equal(formatBps(1750), "17.5%");
});

// ── the document says the right number ─────────────────────────────────────────────────────────

test("document: the rendered PDF contains the totals the billing module computed", () => {
  // BUG THIS PREVENTS: the renderer recomputing money instead of asking `invoiceTotals`. Two
  // implementations of "what does this invoice total" is the thing billing.ts exists to prevent.
  const inv = invoice({ lines: [
    { id: "l1", description: "Monthly retainer", kind: "fixed", quantity_milli: 1000, unit_amount: 120000, tax_bps: 2000 },
    { id: "l2", description: "Extra hours", kind: "unit", quantity_milli: 2500, unit_amount: 2020 },
  ] } as Partial<Invoice>);
  const totals = invoiceTotals(inv);
  const pdf = Buffer.from(render("invoice", { invoice: inv }, PLAIN).content, "base64");
  const text = asText(pdf);
  for (const amount of [totals.subtotal, totals.tax_total, totals.total, totals.amount_due]) {
    assert.ok(text.includes(formatMinor(amount, "USD")), `expected ${formatMinor(amount, "USD")} in the document`);
  }
  // And the line amounts, which is where a per-line rounding difference would show up.
  assert.ok(text.includes("1,200.00"));
  assert.ok(text.includes("50.50"));
});

test("document: a partly paid invoice shows what is still owed, not the total", () => {
  // BUG THIS PREVENTS: dunning a client for the full amount after they part-paid. `amount_due` and
  // `total` are different numbers and the emphasised one must be `amount_due`.
  const inv = invoice({ amount_paid: 100000 });
  const totals = invoiceTotals(inv);
  assert.equal(totals.total, 125050);
  assert.equal(totals.amount_due, 25050);
  const text = asText(Buffer.from(render("invoice", { invoice: inv }, PLAIN).content, "base64"));
  assert.ok(text.includes("Amount due"));
  assert.ok(text.includes("250.50")); // the outstanding 25050
  assert.ok(text.includes("Paid"));
});

test("document: an overdue invoice says so and a settled one says PAID IN FULL", () => {
  const overdue = asText(Buffer.from(render("invoice", { invoice: invoice(), today: "2026-08-01" }, PLAIN).content, "base64"));
  assert.ok(overdue.includes("OVERDUE"));
  const settled = invoice({ amount_paid: 125050 });
  const paid = asText(Buffer.from(render("invoice", { invoice: settled }, PLAIN).content, "base64"));
  assert.ok(paid.includes("PAID IN FULL"));
  assert.equal(paid.includes("OVERDUE"), false);
});

// ── branding reaches the artifact ──────────────────────────────────────────────────────────────

test("branding: a tenant's accent and name reach the PDF, and two tenants differ", () => {
  // BUG THIS PREVENTS: the renderer ignoring the kit and emitting house branding, which produces
  // documents that are wrong in a way no client reports and every client notices.
  const acme = resolveBrandKit({ display_name: "Acme Studio", accent: "#7c3aed" }, "proj name");
  const other = resolveBrandKit({ display_name: "Bramble & Co", accent: "#0f766e" }, "proj name");
  const a = asText(Buffer.from(render("invoice", { invoice: invoice() }, acme).content, "base64"));
  const b = asText(Buffer.from(render("invoice", { invoice: invoice() }, other).content, "base64"));
  assert.ok(a.includes("Acme Studio"));
  assert.ok(b.includes("Bramble & Co"));
  assert.equal(a.includes("Bramble"), false);
  // #7c3aed → 0.49 0.23 0.93 as a PDF fill operator. The colour is genuinely in the bytes.
  assert.ok(a.includes("0.49 0.23 0.93 rg"), "accent colour missing from the content stream");
  assert.ok(b.includes("0.06 0.46 0.43 rg"));
});

test("branding: the footer small print is on the artifact", () => {
  // BUG THIS PREVENTS: a tax number configured once and absent from every document — the field
  // exists precisely because an invoice without it is not a valid invoice in most of the EU.
  const kit = resolveBrandKit({ footer: ["Acme LLC, 4 Bridge St, Austin TX 78701", "EIN 12-3456789"], support_email: "billing@acme.co" }, "Acme");
  const text = asText(Buffer.from(render("invoice", { invoice: invoice() }, kit).content, "base64"));
  assert.ok(text.includes("EIN 12-3456789"));
  assert.ok(text.includes("billing@acme.co"));
});

test("branding: an uploaded logo is embedded as a real PDF image with its alpha as a soft mask", () => {
  const kit = resolveBrandKit({ display_name: "Acme", logo: png2x2() }, "Acme");
  const pdf = Buffer.from(render("invoice", { invoice: invoice() }, kit).content, "base64");
  const text = asText(pdf);
  assert.ok(text.includes("/XObject"), "no image XObject in the document");
  assert.ok(text.includes("/Width 2 /Height 2"), "the image dictionary must describe the real pixels");
  assert.ok(text.includes("/SMask"), "an RGBA logo must carry its alpha as a soft mask");
  assert.ok(text.includes("/Im0 Do"), "the image is never actually drawn");
});

test("branding: a business that has configured nothing gets a clean document, not a placeholder", () => {
  // BUG THIS PREVENTS: reserving space for a logo that does not exist — an empty box where a brand
  // should be. With no logo the business's NAME is set in the heading face instead.
  const nodes = scene("invoice", { invoice: invoice() }, PLAIN).nodes;
  assert.equal(nodes.some((n) => n.t === "image"), false, "no logo configured, so no image node");
  assert.ok(nodes.some((n) => n.t === "text" && n.text === "Hartley Bookkeeping"));
  assert.equal(PLAIN.accent, "#16a34a"); // the same default GET /v1/host/:host has always used
  assert.deepEqual(PLAIN.footer, []);
});

test("branding: an undecodable or oversized logo degrades to the wordmark, never to a broken render", () => {
  // BUG THIS PREVENTS: a corrupt blob in a jsonb column taking down every invoice render for that
  // tenant. `resolveBrandKit` drops it; if it somehow survived, `decodeImage` returns undefined and
  // the emitter skips the draw rather than writing a broken XObject.
  const corrupt = resolveBrandKit({ logo: { mime: "image/png", data: "bm90IGEgcG5n", width: 10, height: 10 } }, "Acme");
  assert.ok(corrupt.logo, "a well-formed base64 string is accepted by the kit");
  const pdf = Buffer.from(render("invoice", { invoice: invoice() }, corrupt).content, "base64");
  assert.equal(asText(pdf).includes("/XObject"), false);
  assert.ok(pdf.length > 500);
  assert.equal(decodeImage("image/png", "bm90IGEgcG5n"), undefined);
  assert.equal(decodeImage("image/svg+xml", png2x2().data), undefined);
  // Too big to be a mark: refused before it is decoded.
  const huge = resolveBrandKit({ logo: { mime: "image/png", data: "A".repeat(400_000), width: 10, height: 10 } }, "Acme");
  assert.equal(huge.logo, undefined);
});

test("brand kit: the write boundary refuses what the renderer cannot honour, and says why", () => {
  const bad = normalizeBrandKitConfig({ accent: "red", letterhead: "sparkles", logo: { mime: "image/svg+xml", data: "x" } });
  assert.equal(bad.problems.length, 3);
  assert.ok(bad.problems.some((p) => p.field === "accent"));
  // SVG is refused because the PDF emitter cannot embed it, and a brand whose SVG preview and PDF
  // disagree is worse than one that says no.
  assert.ok(bad.problems.some((p) => p.field === "logo" && /SVG/.test(p.message)));
  const good = normalizeBrandKitConfig({ display_name: "Acme", accent: "#7C3AED", letterhead: "band", footer: ["a", "b"] });
  assert.deepEqual(good.problems, []);
  assert.equal(good.config.accent, "#7c3aed");
});

test("brand kit: the public shape carries the brand but never the logo bytes", () => {
  // BUG THIS PREVENTS: inlining 200KB of base64 into every page load of the marketing site, on a
  // route that is explicitly uncached.
  const pub = publicBrandKit(resolveBrandKit({ logo: png2x2() }, "Acme")) as Record<string, unknown>;
  assert.equal(pub.has_logo, true);
  assert.equal("logo" in pub, false);
  assert.equal("mark" in pub, false);
});

// ── the two outputs cannot drift ───────────────────────────────────────────────────────────────

test("scene: the SVG and the PDF are two encodings of ONE layout", () => {
  // BUG THIS PREVENTS: a second layout pass. If the PDF were laid out separately, the preview a
  // founder approves would not be the document their client receives.
  const kit = resolveBrandKit({ display_name: "Acme Studio", accent: "#7c3aed", logo: png2x2() }, "Acme");
  const s = scene("invoice", { invoice: invoice() }, kit);
  const svg = toSvg(s);
  const pdf = asText(toPdf(s));
  for (const node of s.nodes) {
    if (node.t !== "text") continue;
    assert.ok(svg.includes(node.text.replace(/&/g, "&amp;")), `"${node.text}" missing from the SVG`);
    assert.ok(pdf.includes(node.text), `"${node.text}" missing from the PDF`);
  }
  assert.ok(svg.includes("data:image/png;base64,"));
});

test("scene: tenant text is escaped for both encodings", () => {
  // BUG THIS PREVENTS: a client called `Smith ) Co <b>` ending a PDF string early — turning the rest
  // of the document into operators — or injecting markup into the SVG.
  const inv = invoice({ note: "Terms: net 14 <b>strict</b> & payable to Smith ) Co" });
  const doc = render("invoice", { invoice: inv }, PLAIN, "svg");
  assert.ok(doc.content.includes("&lt;b&gt;"));
  assert.ok(doc.content.includes("&amp;"));
  const pdf = asText(toPdf(scene("invoice", { invoice: inv }, PLAIN)));
  assert.ok(pdf.includes("Smith \\) Co"), "an unescaped ) would terminate the PDF string");
});

test("scene: a second artifact type is a template, not a rewrite", () => {
  // The seam, asserted: everything below `Scene` is shared, so a report only has to produce nodes.
  const custom = {
    width: 200,
    height: 100,
    background: "#ffffff",
    title: "Quarterly report",
    nodes: [
      { t: "text" as const, x: 10, y: 20, text: "Revenue", size: 12, family: "serif" as const, weight: "bold" as const, fill: "#111111", anchor: "start" as const },
      { t: "rect" as const, x: 0, y: 30, w: 200, h: 4, fill: "#7c3aed" },
    ],
  };
  const pdf = toPdf(custom);
  assert.ok(asText(pdf).includes("Revenue"));
  assert.ok(asText(pdf).includes("/BaseFont /Times-Bold"));
  assert.ok(toSvg(custom).includes("Revenue"));
});

// ── the file is a file ─────────────────────────────────────────────────────────────────────────

test("pdf: the file is structurally valid and its cross-reference offsets are true", () => {
  // BUG THIS PREVENTS: a document that opens in one reader and is "damaged" in another. A wrong
  // xref offset is the classic hand-rolled-PDF failure and is invisible in the reader you tested in.
  const pdf = toPdf(scene("invoice", { invoice: invoice() }, resolveBrandKit({ logo: png2x2() }, "Acme")));
  const text = asText(pdf);
  assert.ok(text.startsWith("%PDF-1.4\n"));
  assert.ok(text.trimEnd().endsWith("%%EOF"));
  const startxref = Number(text.slice(text.lastIndexOf("startxref") + 9).trim().split("\n")[0]);
  assert.equal(text.slice(startxref, startxref + 4), "xref");
  const rows = text.slice(startxref).split("\n").slice(2).filter((l) => /^\d{10} 00000 n $/.test(l));
  assert.ok(rows.length >= 6, "every object needs an xref row");
  rows.forEach((row, i) => {
    const offset = Number(row.slice(0, 10));
    assert.equal(text.slice(offset, offset + `${i + 1} 0 obj`.length), `${i + 1} 0 obj`, `object ${i + 1} offset is wrong`);
  });
  assert.ok(text.includes(`/Size ${rows.length + 1}`));
});

test("pdf: the same invoice renders to the same bytes, every time", () => {
  // BUG THIS PREVENTS: a creation timestamp or a producer version in the file. Without this the
  // "document contains the right total" tests above become screenshot review.
  const inv = invoice();
  const a = render("invoice", { invoice: inv }, PLAIN).content;
  const b = render("invoice", { invoice: inv }, PLAIN).content;
  assert.equal(a, b);
});

test("artifact: the rendered document is shaped for the existing artifact backend", () => {
  // BUG THIS PREVENTS: storing PDF bytes as utf8. Read the Artifact.content comment in contract.ts:
  // a PDF read as UTF-8 is silently corrupt rather than loudly broken, and the download route keys
  // its Buffer decode off `encoding`.
  const doc = render("invoice", { invoice: invoice() }, PLAIN);
  assert.equal(doc.content_type, "application/pdf");
  assert.equal(doc.encoding, "base64");
  assert.equal(doc.name, "invoice-INV-0007.pdf");
  assert.equal(Buffer.from(doc.content, "base64").length, doc.size_bytes);
  const svgDoc = render("invoice", { invoice: invoice() }, PLAIN, "svg");
  assert.equal(svgDoc.content_type, "image/svg+xml");
  assert.equal(svgDoc.encoding, "utf8");
  // BUG THIS PREVENTS: a filename that escapes a directory (the fs artifact backend writes it to
  // disk) or injects a Content-Disposition header.
  const nasty = render("invoice", { invoice: invoice({ number: "../../etc/passwd\"\r\n" }) }, PLAIN);
  assert.equal(nasty.name, "invoice-.-.-etc-passwd-.pdf");
});

// ── type metrics: what we bought by not shipping a browser ─────────────────────────────────────

test("fonts: widths are real, so a right-aligned column actually aligns", () => {
  // BUG THIS PREVENTS: guessing a fixed character width. Right alignment in a PDF is done by
  // SUBTRACTING the measured width — a wrong measurement is a total that hangs off the page edge.
  assert.equal(textWidth("iii", "Helvetica", 10), 6.66);
  assert.equal(textWidth("WWW", "Helvetica", 10), 28.32);
  assert.ok(textWidth("Total", "Helvetica-Bold", 10) > textWidth("Total", "Helvetica", 10));
  // Currency symbols are digit-width in both families, which is what keeps an amount column square.
  assert.equal(textWidth("£1", "Helvetica", 10), textWidth("01", "Helvetica", 10));
  const cut = truncateToWidth("A description far too long for its column", "Helvetica", 9.5, 60);
  assert.ok(cut.endsWith("…"));
  assert.ok(textWidth(cut, "Helvetica", 9.5) <= 60);
});

test("fonts: a curly apostrophe survives the trip into a PDF string", () => {
  // BUG THIS PREVENTS: emitting UTF-16 code points into a WinAnsi string. A founder pastes a footer
  // out of a word processor and gets `Acme Ã¢ÂÂs` on every invoice.
  assert.deepEqual([...winAnsiBytes("’")], [0x92]);
  assert.deepEqual([...winAnsiBytes("€")], [0x80]);
  assert.deepEqual([...winAnsiBytes("£")], [0xa3]);
  // No glyph → a visible "?", never a corrupt byte sequence.
  assert.deepEqual([...winAnsiBytes("漢")], [0x3f]);
});

test("a project still called `default` never becomes a letterhead", () => {
  // ─── OBSERVED IN PRODUCTION ───
  // An existing account renders its business as literally "default". The kernel bootstraps its first
  // tenant with `name: "default"` on the org AND the project (identity.ts), and signup wrote the same
  // string until the fix that names the first project after the org. `IdentityStore.brandKit()` hands
  // the project name straight to `resolveBrandKit`, so that account printed "default" as the business
  // name on every invoice and receipt PDF it sent, and as the heading of its client portal — the
  // placeholder escaping past the founder to the founder's own customer.
  //
  // There is no rename route, so this has to be repaired on READ. Nothing is written; nobody's
  // business is renamed behind their back.
  assert.equal(resolveBrandKit(undefined, "default").display_name, "Invoice");
  assert.equal(resolveBrandKit(undefined, "  Default  ").display_name, "Invoice");
  assert.equal(resolveBrandKit(undefined, "").display_name, "Invoice");

  // A configured name always wins, including over the placeholder — that IS the founder's own word.
  assert.equal(resolveBrandKit({ display_name: "Kestrel Studio" }, "default").display_name, "Kestrel Studio");
  // And a real project name is untouched. Overshooting here would rename working businesses.
  assert.equal(resolveBrandKit(undefined, "Ridgeline Books").display_name, "Ridgeline Books");
  assert.equal(resolveBrandKit(undefined, "Default Systems Ltd").display_name, "Default Systems Ltd");
});

function invoiceText(over: Parameters<typeof scene>[1]): string {
  return scene("invoice", over as never, PLAIN)
    .nodes.filter((n: { t: string }) => n.t === "text")
    .map((n: { text?: string }) => n.text ?? "")
    .join("\n");
}

test("invoice document: FROM prints the registered address, company number and VAT", () => {
  const text = invoiceText({
    invoice: invoice(),
    seller: { address: ["14 Harbour Lane", "Bristol BS1 4DJ"], company_number: "12345678", vat_number: "GB123456789" },
  });
  assert.match(text, /FROM/);
  assert.match(text, /14 Harbour Lane/);
  assert.match(text, /Company no\. 12345678/);
  assert.match(text, /VAT GB123456789/);
});

test("invoice document: missing seller identity is a sentence, not a complete-looking letterhead", () => {
  const text = invoiceText({
    invoice: invoice(),
    seller: { address: [] },
    seller_missing: "This invoice is missing the registered address and company number an accounts department needs — add them under How clients pay you before you send this to a client who will process it.",
  });
  assert.doesNotMatch(text, /^FROM$/m);
  assert.match(text, /missing the registered address and company number/);
});

test("invoice document: how_to_pay headings beat a pasted URL", () => {
  const text = invoiceText({
    invoice: invoice({ payment_link_url: "https://pay.example/old" }),
    how_to_pay: {
      online: { url: "https://checkout.stripe.com/c/pay/cs_test", label: "Pay by card" },
      blocks: [{ kind: "bank_transfer", heading: "Pay by bank transfer", lines: ["Sort code 04-00-04", "Please quote reference: INV-0007"] }],
    },
  });
  assert.match(text, /HOW TO PAY/);
  assert.match(text, /Pay by card/);
  assert.match(text, /Pay by bank transfer/);
  assert.match(text, /Sort code 04-00-04/);
  assert.doesNotMatch(text, /pay\.example\/old/, "the offer is the authority, not the leftover pasted URL");
});
