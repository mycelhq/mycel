// The design system, as data. One scale, one rhythm, one palette — for every deliverable we make.
//
// ═══ WHY THIS FILE EXISTS ═══
//
// A close pack came back and the verdict was that it looked like a slab. It did. The fix I reached
// for first was to open `report.ts` and change 22 to 30, 66 to 82, add a rule, tint a panel — and
// that fix is worthless, because the next template starts at zero again and the taste lives in
// whichever afternoon I happened to spend on it.
//
// Look at what `report.ts` contained before this file: 30, 34, 11.5, 17, 10, 15.5, 26, 12, 9.5, 13,
// 18, 116, 92, 8.5, 1.2, 0.965, 0.93, 0.88. Eighteen decisions, each made once, none written down,
// none available to the invoice, the receipt, a slide, or whatever a founder's onboarding invents on
// Tuesday. That is not a design; it is a rendering that happened to come out alright.
//
// ═══ WHAT A DESIGN SYSTEM ACTUALLY IS ═══
//
// Three things, and none of them is a stylesheet:
//
//   1. A TYPE SCALE. Sizes are steps on one geometric ladder, not free numbers. Two sizes a point
//      apart read as a mistake; two sizes a full step apart read as a decision. This is the single
//      biggest difference between a designed page and a generated one, and it is arithmetic.
//   2. A SPATIAL RHYTHM. Every gap is a multiple of one unit. Space that is 12, 14, 16 and 18 in
//      four places looks like nobody was in charge, because nobody was.
//   3. A SEMANTIC PALETTE. Templates ask for `ink`, `muted`, `hairline`, `panel` — never for a tint
//      fraction. `tint(ink, 0.88)` in eleven files is eleven chances to type 0.86.
//
// ═══ AND WHY IT IS PARAMETERISED BY `base` ═══
//
// The scale is the same shape at every size. An A4 document sets `base: 10`; a slide sets `base: 20`
// and a 1280×720 page and gets the same ladder, the same rhythm, the same relationships — at
// presentation size, without one number being retyped. That is the whole test of whether taste has
// been put into the system or applied by hand: can the next format inherit it, or does somebody have
// to have the afternoon again.
//
// The counterpart to this file is `taste.ts`, which checks the result. This one makes good defaults
// available; that one makes bad output impossible to ship. A system needs both — `_figures.mjs`
// gives the arithmetic and `ship-checks.ts` refuses the run that ignored it, and this is that pattern
// applied to how a document looks.
import type { BrandKit, TypeFamily } from "../brandkit";
import type { FontWeight } from "./fonts";
import { tint } from "./scene";

/**
 * A text role: everything a `scene.text()` call needs except the string and where it goes.
 *
 * Roles are named for their JOB, never their appearance. `lede`, not `elevenPointGrey`. A template
 * that asks for "the opening paragraph treatment" keeps working when the treatment changes; one that
 * asks for eleven-point grey has hardcoded a decision it does not own.
 */
export interface TypeRole {
  size: number;
  /** Baseline-to-baseline. Carried WITH the size, because the two are one decision. */
  leading: number;
  family: TypeFamily;
  weight: FontWeight;
  fill: string;
  tracking?: number;
}

export type RoleName =
  | "display" // the document's own title. One per document, and it is the largest thing on the page.
  | "figure" // a headline number. The reason a client opened a close pack.
  | "heading" // a section a reader navigates to
  | "subhead" // a sub-section, or a chart's title
  | "eyebrow" // a tracked, coloured label ABOVE something. The cheapest real hierarchy there is.
  | "lede" // the opening paragraph, set larger because it carries the finding
  | "body"
  | "small" // table cells, chart labels — supporting text that is still read
  | "caption" // meta values, footers — text that is referred to, not read
  | "micro"; // the smallest thing allowed on a page. Below this is decoration pretending to be text.

export interface Surfaces {
  /** Body ink. Not black: pure black on white is harsher on paper than any brand intends. */
  ink: string;
  /** Secondary text. Present, not competing. */
  muted: string;
  /** Labels and metadata. Legible, clearly subordinate. */
  faint: string;
  /** Rules and separators. Should be felt more than seen. */
  hairline: string;
  /** A grouping panel — the fill that makes several rows read as one object. */
  panel: string;
  /** The empty half of a bar, so a short bar is a proportion rather than a stub. */
  track: string;
  accent: string;
  /** Accent mixed to white: a table header, a highlight band. */
  accentWash: string;
}

export interface DesignSystem {
  page: { width: number; height: number; margin: number; gutter: number };
  /** The type scale, by role. */
  role: Record<RoleName, TypeRole>;
  surface: Surfaces;
  /** `space(3)` is three rhythm units. Every vertical gap in a template is one of these. */
  space: (steps: number) => number;
  /** One rhythm unit, in points. Exposed for the rare place that needs the raw number. */
  unit: number;
  /** An arbitrary step on the ladder, for the one thing a role does not cover. Use a role first. */
  step: (n: number) => number;
  /** Content width, i.e. between the margins. */
  content: number;
  /** The x of the right margin. */
  right: number;
}

export interface DesignOptions {
  /** Body size in points. Everything else is derived. A4 document: 10. Slide: 20. */
  base?: number;
  page?: { width: number; height: number };
  /** Page margin. Defaults to a proportion of the page, which is what makes a slide's margin right. */
  margin?: number;
  /**
   * ═══ THE ONE FLEXIBLE DIMENSION ═══
   *
   * Multiplies the RHYTHM and nothing else. Type sizes and leading are untouched, because a document
   * that shrinks its text to avoid a page break has fixed the wrong problem and the reader can tell.
   * Space between blocks is genuinely elastic — every typesetter has known this since metal.
   *
   * It exists for one job: a document that runs 1.05 pages long and puts a single line on page two.
   * `reportScenes` lays out at 1, asks `taste.ts` whether the result dangles, and re-lays out at ~0.78
   * if it does. So the gate drives the fix instead of somebody hand-tuning a gap until it happens to
   * fit this month's numbers.
   */
  squeeze?: number;
}

/**
 * 1.25 — the major third.
 *
 * Not a free parameter. Below about 1.2 adjacent steps are close enough to read as an accident;
 * above about 1.33 a document has three usable sizes and then a jump to a poster. 1.25 gives nine
 * steps that are each obviously different from their neighbour and still relate, which is the entire
 * requirement.
 */
const RATIO = 1.25;

/** Half a point. Finer than a PDF renderer distinguishes, and coarse enough to keep the scale tidy. */
const round = (n: number): number => Math.round(n * 2) / 2;

export function designFor(kit: BrandKit, opts: DesignOptions = {}): DesignSystem {
  const base = opts.base ?? 10;
  const width = opts.page?.width ?? 595;
  const height = opts.page?.height ?? 842;
  /**
   * A margin proportional to the page, not a constant.
   *
   * 48 points is right on A4 and absurd on a 1280-point slide, where it would leave a 4% gutter. 8%
   * of the short edge lands on 48 for A4 by arithmetic rather than by coincidence — which is the
   * point: the same rule produces the right answer for a page nobody has designed for yet.
   */
  const margin = opts.margin ?? Math.round(width > height ? width * 0.07 : Math.min(width, height) * 0.081);
  const step = (n: number): number => round(base * Math.pow(RATIO, n));
  const unit = round(base * 0.4) * (opts.squeeze ?? 1);
  const ink = kit.neutral;
  const head = kit.type.heading;
  const body = kit.type.body;

  const surface: Surfaces = {
    ink,
    muted: tint(ink, 0.12),
    faint: tint(ink, 0.45),
    hairline: tint(ink, 0.88),
    panel: tint(ink, 0.965),
    track: tint(ink, 0.93),
    accent: kit.accent,
    accentWash: tint(kit.accent, 0.86),
  };

  /**
   * LEADING TIGHTENS AS TYPE GROWS, and that is not a preference.
   *
   * At body size the eye needs the extra space to find the start of the next line; at display size
   * the lines are so long and so few that the same ratio leaves a title looking like two unrelated
   * sentences. 1.55 down at body, 1.15 up at display, interpolated — the rule every type foundry's
   * specimen sheet demonstrates and nobody writes down.
   */
  const leadingFor = (size: number): number => round(size * Math.max(1.15, 1.72 - (size / base) * 0.16));

  const role: Record<RoleName, TypeRole> = {
    display: { size: step(5), leading: leadingFor(step(5)), family: head, weight: "bold", fill: ink },
    figure: { size: step(3), leading: leadingFor(step(3)), family: head, weight: "bold", fill: ink },
    heading: { size: step(2), leading: leadingFor(step(2)), family: head, weight: "bold", fill: ink },
    subhead: { size: step(1), leading: leadingFor(step(1)), family: head, weight: "bold", fill: ink },
    eyebrow: { size: step(-1), leading: leadingFor(step(-1)), family: head, weight: "bold", fill: kit.accent, tracking: round(step(-1) * 0.14) },
    lede: { size: step(0.5), leading: leadingFor(step(0.5)), family: body, weight: "normal", fill: ink },
    body: { size: step(0), leading: leadingFor(step(0)), family: body, weight: "normal", fill: surface.muted },
    small: { size: step(-0.5), leading: leadingFor(step(-0.5)), family: body, weight: "normal", fill: surface.muted },
    caption: { size: step(-1), leading: leadingFor(step(-1)), family: body, weight: "normal", fill: surface.faint },
    micro: { size: step(-2), leading: leadingFor(step(-2)), family: body, weight: "normal", fill: surface.faint },
  };

  return {
    page: { width, height, margin, gutter: unit * 3 },
    role,
    surface,
    space: (steps: number) => round(steps * unit),
    unit,
    step,
    content: width - margin * 2,
    right: width - margin,
  };
}

/**
 * A role with something overridden, without a template writing a size.
 *
 *   d.as("body", { fill: d.surface.faint })      — same size, quieter
 *   d.as("eyebrow", { fill: d.surface.faint })   — a label that is not an accent
 *
 * Overriding `size` is allowed and is almost always the wrong call: if a role is the wrong size, the
 * role is wrong. `taste.ts` counts distinct sizes per page for exactly this reason.
 */
export function as(role: TypeRole, over: Partial<TypeRole>): TypeRole {
  const size = over.size ?? role.size;
  return { ...role, ...over, size, leading: over.leading ?? (over.size ? round(size * 1.4) : role.leading) };
}
