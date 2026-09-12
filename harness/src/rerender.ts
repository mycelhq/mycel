/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * RE-RENDERING A BRANDED DOCUMENT FROM THE MARKDOWN IT CAME FROM
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * MEASURED: five of the ten deliverable versions in production carry a PDF and nothing else. The
 * founder could not change one word of any of them, because `editableFormat` refuses a PDF — and it
 * is right to. A PDF is positioned glyphs; rewriting one means reflowing a document whose source
 * you do not hold.
 *
 * We held it. `renderDocument` in the orchestrator does `blocksFromMarkdown(content)` and then never
 * saves `content`. So the deliverable a founder was least able to fix was the one where the fixable
 * original existed for the length of one statement.
 *
 * Now the markdown is stored beside the PDF with `renders_to` pointing at it, the founder edits the
 * markdown through the ordinary block editor, and this turns their version back into a PDF.
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * WHY IT IS ITS OWN MODULE
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Two callers now produce the client's PDF: the run that writes it, and the founder who corrects it.
 * If those two render differently, the founder's version is a DIFFERENT DOCUMENT from the one they
 * reviewed — different margins, different masthead, possibly a missing chart — and they would have
 * no way to know until the client had it.
 *
 * The chart is the one thing deliberately not carried across. It is spliced in from the run's
 * checked output, which a text edit cannot restate; re-deriving it here would mean inventing a
 * figure at the moment a human is correcting the prose. `figuresFromSource` recovers the chart the
 * ORIGINAL render placed, so a re-render keeps the picture that was already reviewed rather than
 * drawing a new one.
 */

import { blocksFromMarkdown } from "./render/report";
import { render, slidesFromBlocks, type RenderedDocument } from "./render";
import { getIdentityStore } from "./identity";

export interface Rerendered {
  name: string;
  content: string;
  content_type: string;
  encoding: "utf8" | "base64";
  size_bytes: number;
}

/**
 * The founder's markdown, as the branded document the client will open.
 *
 * `undefined` — never a throw and never a half-rendered file — when the project has no brand kit.
 * The caller keeps the markdown edit either way: losing the re-render costs a PDF that can be
 * regenerated, and failing the save costs the correction itself.
 */
export function rerenderDocument(args: {
  projectId: string;
  markdown: string;
  title: string;
  /**
   * `true` when the original was rendered as slides.
   *
   * Read off the source artifact's `profile=deck` media type, which the run that produced it wrote
   * down — never inferred from the content. A deck and a report are different documents; guessing
   * wrong turns a client's slide deck into an A4 page of 10pt text at the moment a founder is
   * correcting one sentence in it.
   */
  deck?: boolean;
}): Rerendered | undefined {
  const kit = getIdentityStore().brandKit(args.projectId);
  if (!kit) return undefined;
  try {
    const blocks = blocksFromMarkdown(args.markdown);
    if (!blocks.length) return undefined;
    const doc: RenderedDocument = args.deck
      ? render("deck", { title: args.title, footer: kit.display_name, slides: slidesFromBlocks(blocks, { title: args.title }, kit) }, kit)
      : render("report", { title: args.title, blocks }, kit);
    return {
      name: doc.name,
      content: doc.content,
      content_type: doc.content_type,
      encoding: (doc.encoding ?? "base64") as "utf8" | "base64",
      size_bytes: doc.size_bytes ?? Buffer.byteLength(doc.content, doc.encoding === "utf8" ? "utf8" : "base64"),
    };
  } catch {
    return undefined;
  }
}
