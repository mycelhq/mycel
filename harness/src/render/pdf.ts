// Scene → PDF. The expensive half, and the dependency decision.
//
// THE CHOICE, STATED
// ------------------
// Three ways to turn a laid-out document into a PDF:
//
//   1. Headless Chromium (puppeteer / playwright). Perfect SVG fidelity, web fonts, real text flow.
//      It also adds ~300MB to `kernel/Dockerfile`, a browser process per render with its own OOM and
//      zombie-process failure modes, and a sandbox surface inside the harness. For a one-page
//      invoice with no flowed text, that is an enormous amount of machinery to lay out a table whose
//      column positions we already computed.
//
//   2. A JS PDF library (pdfkit ~2MB with its AFM data, pdf-lib similar). Reasonable, but it brings
//      its own layout opinions and its own font pipeline, and the piece we would actually use — the
//      object/xref writer below — is about two hundred lines.
//
//   3. Write the PDF. Base-14 fonts, no embedding, no compression of the content stream.
//
// We take (3). The document is one page of positioned text, rules and a logo; that is squarely
// inside what a hand-written writer does correctly, and the output is a small, uncompressed,
// byte-deterministic file that opens in every reader. The price is that we own typography: no web
// fonts, no automatic hyphenation, no bidi, no CJK. `fonts.ts` carries the metrics that buys back
// exact alignment, and `truncateToWidth` is the honest admission that we do not wrap.
//
// If a future artifact genuinely needs flowed multi-page prose, the seam to reach for is a second
// EMITTER against the same `Scene`, not a rewrite of the templates.
import { fontFor, textWidth, winAnsiBytes, type FontId } from "./fonts";
import { decodeImage } from "./image";
import { hexToRgb, type Scene } from "./scene";

/** Base-14 names in a fixed order so /F1../F4 mean the same thing in every file we produce. */
const FONTS: FontId[] = ["Helvetica", "Helvetica-Bold", "Times-Roman", "Times-Bold"];

const num = (v: number) => (Math.round(v * 100) / 100).toString();

/** A PDF literal string. An unescaped `)` in a client's company name would end the string early and
 *  turn the rest of the document into operators — this is the injection boundary. */
function pdfString(text: string): Buffer {
  const bytes = winAnsiBytes(text);
  const out: number[] = [0x28]; // (
  for (const b of bytes) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) out.push(0x5c);
    out.push(b);
  }
  out.push(0x29); // )
  return Buffer.from(out);
}

/**
 * The scene's drawing operators.
 *
 * Coordinates flip here and only here: a Scene is top-left origin like SVG, a PDF page is
 * bottom-left. One subtraction, in one place, so a template never has to think about it.
 */
function contentStream(scene: Scene, images: Map<string, { name: string }>): Buffer {
  const H = scene.height;
  const parts: Buffer[] = [];
  const push = (s: string) => parts.push(Buffer.from(s, "latin1"));
  const fill = (hex: string) => {
    const [r, g, b] = hexToRgb(hex);
    push(`${num(r)} ${num(g)} ${num(b)} rg\n`);
  };

  fill(scene.background);
  push(`0 0 ${scene.width} ${scene.height} re f\n`);

  for (const node of scene.nodes) {
    if (node.t === "rect") {
      fill(node.fill);
      push(`${num(node.x)} ${num(H - node.y - node.h)} ${num(node.w)} ${num(node.h)} re f\n`);
    } else if (node.t === "line") {
      const [r, g, b] = hexToRgb(node.stroke);
      push(`${num(r)} ${num(g)} ${num(b)} RG ${num(node.width)} w\n`);
      push(`${num(node.x1)} ${num(H - node.y1)} m ${num(node.x2)} ${num(H - node.y2)} l S\n`);
    } else if (node.t === "text") {
      const font = fontFor(node.family, node.weight);
      const width = textWidth(node.text, font, node.size) + (node.tracking ?? 0) * Math.max(0, node.text.length - 1);
      // PDF has no text-anchor. Alignment is the whole reason `fonts.ts` exists.
      const x = node.anchor === "end" ? node.x - width : node.anchor === "middle" ? node.x - width / 2 : node.x;
      fill(node.fill);
      push(`BT /F${FONTS.indexOf(font) + 1} ${num(node.size)} Tf\n`);
      if (node.tracking) push(`${num(node.tracking)} Tc\n`);
      push(`1 0 0 1 ${num(x)} ${num(H - node.y)} Tm\n`);
      parts.push(pdfString(node.text));
      push(` Tj\n`);
      if (node.tracking) push(`0 Tc\n`);
      push(`ET\n`);
    } else {
      const key = `${node.mime}:${node.data}`;
      const img = images.get(key);
      if (!img) continue; // undecodable: the template already drew the wordmark instead
      push(`q ${num(node.w)} 0 0 ${num(node.h)} ${num(node.x)} ${num(H - node.y - node.h)} cm /${img.name} Do Q\n`);
    }
  }
  return Buffer.concat(parts);
}

/**
 * The file.
 *
 * Deterministic by construction: no creation date, no producer version, no compression of the
 * content stream. The same Scene renders to the same bytes forever, which is what makes
 * "this document contains this total" a test rather than a screenshot review.
 */
export function toPdf(scene: Scene): Buffer {
  return toPdfPages([scene]);
}

/**
 * The multi-page seam the header of this file named: an array of Scenes → one PDF, one page each.
 *
 * This is NOT a second layout pass and NOT text flow — pagination is the caller's job (see
 * `report.ts`, which slices flowed prose into per-page Scenes using `fonts.ts` metrics). This
 * function only does what `toPdf` did, N times, sharing the font objects and the image XObjects
 * across every page so a logo that appears on all six pages is embedded once. A single-page render
 * (`toPdf`) is exactly `toPdfPages([scene])`, so invoices and receipts are byte-identical to before.
 */
export function toPdfPages(scenes: Scene[]): Buffer {
  if (scenes.length === 0) throw new Error("toPdfPages needs at least one page");
  // Decode logos once across ALL pages. The same logo on every page is one XObject.
  const images = new Map<string, { name: string; obj: number; decoded: NonNullable<ReturnType<typeof decodeImage>> }>();
  for (const scene of scenes) {
    for (const node of scene.nodes) {
      if (node.t !== "image") continue;
      const key = `${node.mime}:${node.data}`;
      if (images.has(key)) continue;
      const decoded = decodeImage(node.mime, node.data);
      if (decoded) images.set(key, { name: `Im${images.size}`, obj: 0, decoded });
    }
  }

  const objects: Buffer[] = [];
  /** Objects are 1-indexed in a PDF; `add` returns the number to reference. */
  const add = (body: string | Buffer): number => {
    objects.push(typeof body === "string" ? Buffer.from(body, "latin1") : body);
    return objects.length;
  };

  const fontObjs = FONTS.map((f) =>
    add(`<< /Type /Font /Subtype /Type1 /BaseFont /${f} /Encoding /WinAnsiEncoding >>`),
  );

  for (const entry of images.values()) {
    const d = entry.decoded;
    let smaskRef = "";
    if (d.smask) {
      const sm = add(
        Buffer.concat([
          Buffer.from(
            `<< /Type /XObject /Subtype /Image /Width ${d.width} /Height ${d.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${d.smask.length} >>\nstream\n`,
            "latin1",
          ),
          d.smask,
          Buffer.from(`\nendstream`, "latin1"),
        ]),
      );
      smaskRef = ` /SMask ${sm} 0 R`;
    }
    entry.obj = add(
      Buffer.concat([
        Buffer.from(
          `<< /Type /XObject /Subtype /Image /Width ${d.width} /Height ${d.height} /ColorSpace /${d.colorSpace} /BitsPerComponent ${d.bitsPerComponent} /Filter /${d.filter}${smaskRef} /Length ${d.data.length} >>\nstream\n`,
          "latin1",
        ),
        d.data,
        Buffer.from(`\nendstream`, "latin1"),
      ]),
    );
  }

  const fontDict = FONTS.map((_, i) => `/F${i + 1} ${fontObjs[i]} 0 R`).join(" ");
  const xobjDict = [...images.values()].map((e) => `/${e.name} ${e.obj} 0 R`).join(" ");
  const resources = `<< /Font << ${fontDict} >>${xobjDict ? ` /XObject << ${xobjDict} >>` : ""} >>`;

  // Forward reference: every page's /Parent points at the Pages node, which is written last. Its
  // object number is known ahead of time because `add` is deterministic — the pages node is added
  // right after the two-objects-per-page loop below.
  const pagesObj = objects.length + scenes.length * 2 + 1;
  const pageObjNums: number[] = [];
  for (const scene of scenes) {
    const content = contentStream(scene, images);
    const contentObj = add(
      Buffer.concat([
        Buffer.from(`<< /Length ${content.length} >>\nstream\n`, "latin1"),
        content,
        Buffer.from(`\nendstream`, "latin1"),
      ]),
    );
    const pageObj = add(
      `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${scene.width} ${scene.height}] /Resources ${resources} /Contents ${contentObj} 0 R >>`,
    );
    pageObjNums.push(pageObj);
  }
  const pagesRef = add(
    `<< /Type /Pages /Kids [${pageObjNums.map((n) => `${n} 0 R`).join(" ")}] /Count ${scenes.length} >>`,
  );
  const infoObj = add(`<< /Title ${pdfString(scenes[0].title).toString("latin1")} /Producer (Mycel) >>`);
  const catalogObj = add(`<< /Type /Catalog /Pages ${pagesRef} 0 R >>`);

  // ── Assemble, recording each object's byte offset for the cross-reference table ──
  const chunks: Buffer[] = [];
  let offset = 0;
  const write = (b: Buffer) => {
    chunks.push(b);
    offset += b.length;
  };
  // 1.4 is the last version every ancient reader handles and everything we emit predates it.
  write(Buffer.from(`%PDF-1.4\n%\xe2\xe3\xcf\xd3\n`, "latin1"));
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(offset);
    write(Buffer.from(`${i + 1} 0 obj\n`, "latin1"));
    write(body);
    write(Buffer.from(`\nendobj\n`, "latin1"));
  });

  const xrefStart = offset;
  const xref: string[] = [`xref\n0 ${objects.length + 1}\n`, `0000000000 65535 f \n`];
  for (const o of offsets) xref.push(`${String(o).padStart(10, "0")} 00000 n \n`);
  write(Buffer.from(xref.join(""), "latin1"));
  write(
    Buffer.from(
      `trailer\n<< /Size ${objects.length + 1} /Root ${catalogObj} 0 R /Info ${infoObj} 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`,
      "latin1",
    ),
  );
  return Buffer.concat(chunks);
}
