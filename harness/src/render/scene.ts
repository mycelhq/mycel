// The layout language: a typed subset of SVG.
//
// THE ONE IDEA IN THIS DIRECTORY
// ------------------------------
// A template does not emit a PDF and it does not emit a string. It emits a `Scene` — a flat list of
// absolutely-positioned SVG primitives in points, top-left origin. `toSvg` serialises that list
// verbatim. `toPdf` translates the same list. There is no second layout pass, so the preview a
// founder looks at and the document their client receives cannot drift: they are two encodings of
// one array.
//
// The subset is small on purpose. Rect, line, text, image. No paths, no transforms, no groups, no
// text flow. Every one of those would be a feature the SVG serialiser gets for free and the PDF
// emitter has to reimplement, and that asymmetry is exactly how the two outputs start disagreeing.
//
// THE SEAM FOR A SECOND ARTIFACT TYPE
// -----------------------------------
// A template is `(input, kit: BrandKit) => Scene`. That is the whole contract. A report or a
// proposal is a new function returning a Scene and one line in the registry in `index.ts` — it
// inherits fonts, metrics, colours, the letterhead, the logo, the SVG serialiser, the PDF emitter,
// the artifact plumbing and the download route without touching any of them.
import type { FontId, FontWeight } from "./fonts";
import type { TypeFamily } from "../brandkit";

export interface RectNode {
  t: "rect";
  x: number;
  y: number;
  w: number;
  h: number;
  fill: string;
  /** Corner radius. The only shape nicety worth having; anything more is a path. */
  rx?: number;
}

export interface LineNode {
  t: "line";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  stroke: string;
  width: number;
}

export interface TextNode {
  t: "text";
  /** The anchor point. `y` is the BASELINE, as in both SVG and PDF — one convention, no conversion. */
  x: number;
  y: number;
  text: string;
  size: number;
  family: TypeFamily;
  weight: FontWeight;
  fill: string;
  anchor: "start" | "middle" | "end";
  /** Extra space between glyphs, points. Used for the small-caps-ish column headings. */
  tracking?: number;
}

export interface ImageNode {
  t: "image";
  x: number;
  y: number;
  w: number;
  h: number;
  mime: string;
  /** Raw bytes, base64. The renderer never fetches; see the LOGO STORAGE note in brandkit.ts. */
  data: string;
}

export type SceneNode = RectNode | LineNode | TextNode | ImageNode;

export interface Scene {
  /** Points. A4 is 595.28 × 841.89; we use whole points because nothing here needs the fraction. */
  width: number;
  height: number;
  background: string;
  nodes: SceneNode[];
  /** Document metadata, carried to the PDF's /Info. Never affects layout. */
  title: string;
}

/** Points. Every dimension in a template is one of these or arithmetic on them. */
export const A4 = { width: 595, height: 842 } as const;

/** A builder, so a template reads as a sequence of statements instead of an array literal. */
export class SceneBuilder {
  readonly nodes: SceneNode[] = [];
  constructor(
    readonly width: number,
    readonly height: number,
  ) {}
  rect(n: Omit<RectNode, "t">): this {
    this.nodes.push({ t: "rect", ...n });
    return this;
  }
  line(n: Omit<LineNode, "t">): this {
    this.nodes.push({ t: "line", ...n });
    return this;
  }
  text(n: Omit<TextNode, "t">): this {
    // An empty string is a node that draws nothing and still costs bytes in both outputs.
    if (n.text !== "") this.nodes.push({ t: "text", ...n });
    return this;
  }
  image(n: Omit<ImageNode, "t">): this {
    this.nodes.push({ t: "image", ...n });
    return this;
  }
  done(title: string, background = "#ffffff"): Scene {
    return { width: this.width, height: this.height, background, nodes: this.nodes, title };
  }
}

/** #rrggbb → the three 0..1 components a PDF colour operator wants. Integer-safe; no parsing of
 *  anything the caller did not already validate as a hex triple. */
export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}

/** A colour mixed toward white — how a table heading gets an accent tint without a second colour
 *  in the kit. Integer channels throughout. */
export function tint(hex: string, amount: number): string {
  const h = hex.replace("#", "");
  const mix = (c: number) => Math.round(c + (255 - c) * amount);
  const out = [0, 2, 4].map((i) => mix(parseInt(h.slice(i, i + 2), 16)));
  return `#${out.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

export type { FontId, FontWeight };
