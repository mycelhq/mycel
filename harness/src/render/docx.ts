// A real Word document, written by hand. No dependency.
//
// ═══ WHY THIS EXISTS, AND IT IS NOT "PARITY WITH XLSX" ═══
//
// Eight of ten wedges ship `document`, and a document is a PDF. That is right for a report somebody
// reads and wrong for the whole class of work where THE CLIENT'S NEXT MOVE IS TO EDIT IT: a
// contract their lawyer redlines, a proposal they paste their own numbers into, a grant application
// a committee marks up, a bid the buyer's procurement team fills half of, a policy that has to be
// adopted under someone else's letterhead.
//
// A PDF says *do not touch this*. A .docx says *this is yours now*. For those trades the format IS
// the deliverable's usefulness, and sending a PDF is how a firm gets asked for "the Word version"
// — the request that reveals the work was not actually finished.
//
// That is also the honest reason this is worth building rather than a nice-to-have: legal,
// consulting, grant writing, bid writing and PR are five trades the catalogue cannot serve properly
// without it, and `deliverable_shape` already declares the SECTIONS for several of them.
//
// ═══ WHY NOT A LIBRARY, AGAIN ═══
//
// `xlsx.ts` won this argument and `ooxml.ts` now holds the shared half. A .docx is a ZIP of XML —
// four small parts and a container — and Node ships the zip. What a library would add on top is a
// layout engine, a style inheritance model and a font pipeline, all of which exist to render
// something we deliberately do not render: Word does that, on the client's machine, which is the
// entire point of sending them a Word file.
//
// ═══ WHAT THIS DELIBERATELY DOES NOT DO ═══
//
// No images, no tables-inside-tables, no headers and footers, no tracked changes, no comments, no
// numbering restarts. Each of those is a real feature of the format and none is a thing a client
// has asked for; the seam for any of them is a new block kind below. Refusing them now is what
// keeps this file readable, and `taste.ts` cannot lint what it cannot see.
//
// TABLES ARE IN, and that is the one non-obvious inclusion. Ten of twelve shipped exemplars had a
// table that the prose path silently dropped — a grid shipped as sentences is the defect
// `STANDARD.md` counts, and a contract's payment schedule is a grid.
import { zip } from "./ooxml";

/** One block of a document. A closed vocabulary — see the note above about what is refused. */
export type Block =
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "para"; text: string; bold?: boolean }
  | { kind: "bullets"; items: string[] }
  | { kind: "numbers"; items: string[] }
  /** Header row plus body. Ragged rows are padded rather than refused — see `tableXml`. */
  | { kind: "table"; header: string[]; rows: string[][] }
  | { kind: "pagebreak" };

export interface Document {
  /** Shown in Word's title bar and in a document-properties pane. Not rendered on the page. */
  title: string;
  blocks: Block[];
}

/**
 * XML text escaping, and the reason it is not optional anywhere in this file.
 *
 * Every string here came from a model or from a client's own words. An unescaped `&` in a company
 * name — "Smith & Partners", which is most law firms — produces a file Word refuses to open at all,
 * with an error naming a line number in a part the founder has never heard of. That is not a
 * cosmetic bug; it is a deliverable that cannot be opened by the person paying for it.
 *
 * Control characters go too: XML 1.0 forbids them outright, and a model occasionally emits one.
 */
function esc(s: string): string {
  return String(s ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * A run of text inside a paragraph.
 *
 * `xml:space="preserve"` because Word strips leading and trailing whitespace otherwise, and a
 * deliberate indent in a quoted clause is meaningful in a contract.
 */
function run(text: string, bold = false): string {
  return `<w:r>${bold ? "<w:rPr><w:b/></w:rPr>" : ""}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
}

function para(text: string, opts: { style?: string; bold?: boolean } = {}): string {
  const pr = opts.style ? `<w:pPr><w:pStyle w:val="${opts.style}"/></w:pPr>` : "";
  return `<w:p>${pr}${run(text, opts.bold)}</w:p>`;
}

/**
 * A table.
 *
 * RAGGED ROWS ARE PADDED, NOT REFUSED. A model that emits five headers and a four-cell row has made
 * a mistake, and the two available responses are to throw — losing an otherwise complete document
 * over one short row — or to pad and let the gap be visible in the file, where the founder reviewing
 * it will see an empty cell and know exactly what to fix. Refusing the whole document teaches
 * nobody anything and costs a re-run.
 *
 * Extra cells beyond the header are dropped for the opposite reason: a row wider than its table is
 * not renderable at all, and silently widening the table would change the shape of every other row.
 */
function tableXml(header: string[], rows: string[][]): string {
  const cols = Math.max(1, header.length);
  const width = Math.floor(9360 / cols); // twentieths of a point across a 6.5in text column
  const cell = (text: string, bold = false) =>
    `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/></w:tcPr>${para(text, { bold })}</w:tc>`;
  const row = (cells: string[], bold = false) =>
    `<w:tr>${Array.from({ length: cols }, (_, i) => cell(cells[i] ?? "", bold)).join("")}</w:tr>`;

  return (
    `<w:tbl><w:tblPr><w:tblStyle w:val="Grid"/><w:tblW w:w="0" w:type="auto"/>` +
    `<w:tblBorders>` +
    ["top", "left", "bottom", "right", "insideH", "insideV"]
      .map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="D0D0D0"/>`)
      .join("") +
    `</w:tblBorders></w:tblPr>` +
    row(header, true) +
    rows.map((r) => row(r)).join("") +
    `</w:tbl>`
  );
}

function blockXml(b: Block): string {
  switch (b.kind) {
    case "heading":
      return para(b.text, { style: `Heading${b.level}` });
    case "para":
      return para(b.text, { bold: b.bold });
    case "bullets":
      return b.items.map((i) => para(i, { style: "ListBullet" })).join("");
    case "numbers":
      return b.items.map((i) => para(i, { style: "ListNumber" })).join("");
    case "table":
      // A table must be followed by a paragraph or Word merges it with whatever comes next.
      return tableXml(b.header, b.rows) + "<w:p/>";
    case "pagebreak":
      return `<w:p><w:r><w:br w:type="page"/></w:r></w:p>`;
  }
}

/**
 * The style part.
 *
 * Six styles and no theme. Word supplies its own defaults for everything not named here, which is
 * deliberate: a document that arrives carrying our typography is a document that looks like OUR
 * letterhead on the client's screen, and the client is about to put it on THEIRS. `xlsx.ts` makes
 * the same call for the same reason — own the structure, leave the appearance to the application
 * the file is opened in.
 */
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/><w:spacing w:before="240" w:after="120"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:pPr><w:outlineLvl w:val="1"/><w:spacing w:before="200" w:after="100"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:pPr><w:outlineLvl w:val="2"/><w:spacing w:before="160" w:after="80"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListBullet"><w:name w:val="List Bullet"/><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="ListNumber"><w:name w:val="List Number"/><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr></w:pPr></w:style>
<w:style w:type="table" w:styleId="Grid"><w:name w:val="Table Grid"/></w:style>
</w:styles>`;

/** Two lists: bullets and decimals. Nothing restarts, nothing nests — see the refusals above. */
const NUMBERING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>
<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`;

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`;

const DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
</Relationships>`;

/**
 * A Word document, as bytes.
 *
 * Base64 with an `encoding`, like every other artifact in this system — the road `render/pdf.ts`
 * and `render/xlsx.ts` both take. Returning a Buffer would make this the one renderer whose output
 * needs special handling at every boundary it crosses.
 */
export function renderDocument(doc: Document): {
  content: string;
  encoding: "base64";
  content_type: string;
  size_bytes: number;
} {
  const body = doc.blocks.map(blockXml).join("");
  const documentXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}` +
    // A4 with 1in margins. The section properties must be the last child of the body.
    `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>` +
    `</w:body></w:document>`;

  /*
    No `dcterms:created`. `ooxml.ts` fixes the ZIP timestamps at a constant so two renders of the
    same content are byte-identical — a diff between two months shows what changed in the words, and
    a rebuilt artifact does not look like a new one. Stamping a clock into the core properties would
    undo that in the one part nobody thinks to look at.
  */
  const core =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
    `xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${esc(doc.title)}</dc:title></cp:coreProperties>`;

  const bytes = zip([
    { name: "[Content_Types].xml", xml: CONTENT_TYPES },
    { name: "_rels/.rels", xml: ROOT_RELS },
    { name: "docProps/core.xml", xml: core },
    { name: "word/_rels/document.xml.rels", xml: DOC_RELS },
    { name: "word/document.xml", xml: documentXml },
    { name: "word/styles.xml", xml: STYLES },
    { name: "word/numbering.xml", xml: NUMBERING },
  ]);

  return {
    content: bytes.toString("base64"),
    encoding: "base64",
    content_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    size_bytes: bytes.length,
  };
}
