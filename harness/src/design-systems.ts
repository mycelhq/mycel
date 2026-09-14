// ═══ THE LOOK, AS BYTES A RUN CAN READ ═══
//
// `design-systems/systems/<id>/` holds 29 vendored style systems, each a `tokens.css` (the values)
// and a `DESIGN.md` (the reasoning — when this look is right, what it refuses, how type and space
// behave). They were vendored and then read by nothing at all, which is the same shape of bug as
// `service-skills/` shipping without a COPY line: complete, correct, unreachable.
//
// WHY BYTES AND NOT A COMPONENT LIBRARY. The systems carry no runtime cascade and no framework. A
// run pastes one `:root` block into a single `<style>` and every deliverable it emits — a site, a
// report, a deck, an invoice — is in the same voice, whatever it was built with. That is the only
// form that works across artefacts we do not control the toolchain of.
//
// SHIPPING: `kernel/design-systems/` is a runtime-DATA directory like `wedges/` and `workflows/`,
// and needs its COPY line in the Dockerfile for the same reason. Without it every read here returns
// nothing and the container looks perfectly healthy.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { libraryPath } from "./library";

export interface DesignSystem {
  id: string;
  /** The `:root { ... }` block, verbatim. Pasted into one `<style>`; never linked. */
  tokens: string;
  /** Prose: when this look is right, what it refuses, how type and space behave. */
  design: string;
}

export function designSystemsDir(): string {
  return process.env.MYCEL_DESIGN_SYSTEMS_DIR ?? join(libraryPath("design-systems"), "systems");
}

/** Ids on disk, sorted. Empty when the directory did not ship — callers degrade, never throw. */
export function designSystemIds(): string[] {
  const dir = designSystemsDir();
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((d) => {
        try {
          return statSync(join(dir, d)).isDirectory() && existsSync(join(dir, d, "tokens.css"));
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}

/** One system, or undefined. Fail-soft: an id that is not on disk is a caller mistake, not a crash. */
export function designSystem(id: string): DesignSystem | undefined {
  // `typeof` as well as the slug test. This id arrives from `identity.design_system`, and
  // `validIdentity` is deliberately loose — it size-caps a plain object and does not type its
  // fields, because it carries design direction between two models. A number here would pass the
  // coercing `.test()` and then throw inside `join()`, turning a bad stored value into a failed run
  // rather than a missing house style.
  if (typeof id !== "string" || !/^[a-z0-9-]+$/.test(id)) return undefined;
  const dir = join(designSystemsDir(), id);
  try {
    const tokens = readFileSync(join(dir, "tokens.css"), "utf8");
    let design = "";
    try {
      design = readFileSync(join(dir, "DESIGN.md"), "utf8");
    } catch {
      design = "";
    }
    return { id, tokens, design };
  } catch {
    return undefined;
  }
}

/**
 * The system as files a run mounts.
 *
 * Two files rather than one blob, because they are read at different moments: `DESIGN.md` while
 * deciding what the artefact should look like, `tokens.css` while writing the markup. Naming them
 * under `brand/` puts them next to the other things a run is told to obey.
 */
/** The identity half of a brand: the tokens that ARE this business, not a house default. */
export interface BrandIdentityTokens {
  /** The founder's accent, from the brand kit. Overrides the system's own. */
  accent?: string;
  /** Their neutral/ink, when set. */
  neutral?: string;
}

/**
 * ═══ THE SYSTEM SUPPLIES THE SHAPE, THE BRAND SUPPLIES THE IDENTITY ═══
 *
 * These were two independent sources of truth and a run got both. `editorial/tokens.css` ships
 * `--accent: #9a5a2f`; the founder's brand kit holds whatever accent they actually chose in
 * `/settings/brand`. A deliver run mounted the system AND the kit, with no rule about which wins,
 * so the model picked — and an agency's white-labelled report came out in our reference brown
 * about as often as in their own colour.
 *
 * The layering is already written down correctly in `landing/lib/brand/tokens.ts`, adapted from
 * open-design's own schema: an accent is IDENTITY, and "no fallback can substitute — an agency's
 * accent is the whole point of white-labelling, and guessing one is worse than refusing." It was
 * simply never applied here.
 *
 * So the overlay: the system keeps everything that makes it a system — type scale, spacing, radii,
 * motion, the relationships between surfaces — and the brand's own colours are substituted in
 * place. One coherent token set, the system's shape wearing the business's identity.
 *
 * Substituted, NOT appended. A second `:root` after the first would leave both values in the file
 * and rely on cascade order to resolve them, which is precisely the "two palettes" failure the
 * comment below warns about — and an agent reading the file would see two answers to one question.
 */
function withBrandIdentity(tokens: string, brand: BrandIdentityTokens | undefined): string {
  if (!brand?.accent && !brand?.neutral) return tokens;
  let out = tokens;
  const swap = (name: string, value: string | undefined) => {
    if (!value?.trim()) return;
    // Only a literal declaration is replaced. A derived token — `color-mix(... var(--accent) ...)`
    // — must keep referring to the variable so it re-derives from the new value rather than
    // freezing the old one.
    out = out.replace(new RegExp(`(--${name}\\s*:\\s*)(#[0-9a-fA-F]{3,8}|rgb\\([^)]*\\))`, "g"), `$1${value.trim()}`);
  };
  swap("accent", brand.accent);
  swap("fg", brand.neutral);
  return out;
}

export function designSystemFilesFor(
  id: string | undefined,
  brand?: BrandIdentityTokens,
): Array<{ name: string; content: string }> {
  if (!id) return [];
  const s = designSystem(id);
  if (!s) return [];
  const branded = withBrandIdentity(s.tokens, brand);
  const overlaid = branded !== s.tokens;
  const out = [
    {
      name: `brand/tokens.css`,
      content:
        `/* DESIGN SYSTEM: ${s.id}. These are the values every artefact in this business wears.\n` +
        ` * Paste this :root block into ONE <style> in the document. Do not link it, do not split it\n` +
        ` * across files, and do not invent a colour that is not here — a second palette is how a set\n` +
        ` * of deliverables stops looking like one firm made them.\n` +
        (overlaid
          ? ` *\n * The colours below are THIS BUSINESS'S OWN, substituted into the ${s.id} system. The system\n` +
            ` * decides the shape — type scale, spacing, radii, motion; the business decides the identity.\n` +
            ` * Where you see a colour here, it is theirs and it is deliberate. */\n\n`
          : ` */\n\n`) +
        branded,
    },
  ];
  if (s.design.trim()) {
    out.push({ name: `brand/DESIGN.md`, content: s.design });
  }
  return out;
}

/**
 * ═══ THE BRIDGE FROM WHAT THE FOUNDER PICKED TO WHAT THE RUN WEARS ═══
 *
 * Onboarding asks for a FEELING — "editorial", "bold", "trust" — and `brandkit.ts` already turns
 * that into shadcn preset values for the site and the PDFs. But a preset is a component theme: it
 * decides button radius and palette name, and it has nothing to say to a run writing a report or a
 * deck from scratch, which is most of what this business delivers. Those runs had no house style at
 * all, so they invented one per artefact.
 *
 * So the archetype resolves a SECOND way, to a full style system with prose. Same seven names the
 * founder already chose from, so nothing new is asked of them.
 *
 * `professional` is the fallback rather than a house look, and that is deliberate: a business whose
 * archetype we do not know should get a competent neutral, not Mycel's own brand leaking onto a
 * client's deliverable.
 */
const ARCHETYPE_SYSTEM: Record<string, string> = {
  editorial: "editorial",
  technical: "application",
  "warm-organic": "warm-editorial",
  "bold-brutalist": "brutalism",
  "minimal-luxury": "luxury",
  playful: "vibrant",
  "corporate-trust": "corporate",
};

/**
 * ═══ WHY A HARVESTED SYSTEM COULD NOT DRESS OUR OWN SURFACES ═══
 *
 * The 29 systems have never styled the console, the landing page or a generated client site, and
 * the reason is not neglect — it is that the two halves of this product speak different token
 * vocabularies and only SEVEN names overlap.
 *
 *   shadcn (landing, cloud, business-template)  --background --foreground --card --primary
 *                                               --muted-foreground --ring --input …
 *   open-design (the 29 systems)                --bg --fg --surface --fg-2 --accent-on
 *                                               --elev-raised --leading-body --container-max …
 *
 * Paste `editorial/tokens.css` into the console and almost nothing changes: every component asks
 * for `--background`, which the system never defines, while the system's `--bg` is read by nobody.
 * The system is not wrong and neither is the app; they were built to different contracts, and
 * nothing translated.
 *
 * This is that translation. It is deliberately ONE-DIRECTIONAL and lossy in the safe direction:
 * the system owns the values, shadcn names borrow them. Where a system has no answer for a shadcn
 * role, the mapping falls back to a related token it does define rather than inventing a colour —
 * an invented colour is how a set of surfaces stops looking like one system.
 *
 * `--primary` maps to the ACCENT rather than to the ink. shadcn's `primary` is the button colour,
 * the thing a user clicks; open-design's equivalent is `accent`. Mapping it to `--fg` would make
 * every button the colour of body text, which is technically a mapping and visibly wrong.
 */
const SHADCN_FROM_SYSTEM: Array<[shadcn: string, from: string[], role: string]> = [
  ["background", ["bg"], "the page"],
  ["foreground", ["fg"], "body text"],
  ["card", ["surface", "bg"], "a raised panel"],
  ["card-foreground", ["fg"], "text on a panel"],
  ["popover", ["surface", "bg"], "a floating panel"],
  ["popover-foreground", ["fg"], "text in one"],
  // shadcn's `primary` is what you click. open-design calls that `accent`.
  ["primary", ["accent"], "the button"],
  ["primary-foreground", ["accent-on"], "text on the button"],
  ["secondary", ["surface-warm", "surface", "bg"], "a quieter fill"],
  ["secondary-foreground", ["fg-2", "fg"], "text on it"],
  ["muted", ["surface-warm", "surface"], "a muted fill"],
  ["muted-foreground", ["muted", "fg-2"], "secondary text"],
  ["accent", ["accent"], "the highlight"],
  ["accent-foreground", ["accent-on"], "text on it"],
  ["destructive", ["danger"], "the dangerous action"],
  ["border", ["border"], "a hairline"],
  ["input", ["border"], "a field edge"],
  /**
   * A COLOUR, not a shadow. open-design's `--focus-ring` is a whole box-shadow value
   * (`0 0 0 4px rgba(...)`); shadcn's `--ring` is the colour a ring is drawn in, and handing it a
   * shadow produces `outline-color: 0 0 0 4px rgba(...)`, which the browser drops. Caught by
   * generating the file and reading it rather than by trusting the name.
   */
  ["ring", ["accent"], "the focus ring colour"],
];

/**
 * A harvested design system, expressed in the vocabulary our own apps already speak.
 *
 * Returns a `:root` block that defines every shadcn role from the system's own values, so the
 * console, the landing page and a generated client site can wear any of the 29 without a component
 * being touched. Fonts and radii ride along because shadcn reads those names too.
 *
 * Returns "" for an unknown system rather than a partial block: a half-mapped `:root` is worse than
 * none, because it restyles some surfaces and leaves the rest on the old palette.
 */
/**
 * ═══ THE 29 SYSTEMS ARE 29 LIGHT SYSTEMS ═══
 *
 * Not one of them ships a dark variant — every `tokens.css` is a single `:root`. That is a real
 * limit of the corpus and it bites in two places:
 *
 *   · A surface with a dark mode gets the system's light palette and keeps its OWN dark one, so the
 *     two halves of the same page come from different systems. That is the "two palettes" failure
 *     again, arriving through the theme switch.
 *   · Every deliverable this product makes is graded on `styled_both_themes`. A run handed a
 *     light-only system fails that criterion structurally, however well it works.
 *
 * So the bridge derives one. Deriving a whole 50-token system would be inventing a design; deriving
 * the FOURTEEN shadcn roles is bounded, and it is the same first pass a competent designer makes:
 *
 *   · page and ink swap — the darkest ink becomes the page, the page becomes the ink
 *   · panels lift OFF the page rather than sitting on it, so `card` is a step lighter than `bg`
 *   · hairlines lighten, because a border that worked on paper disappears on ink
 *   · THE ACCENT DOES NOT MOVE. It is the identity — the one token a brand owns — and re-deriving
 *     it in dark would hand the business a second brand colour after hours.
 *
 * Announced as derived in the file, so an agent with a better dark palette knows it may replace
 * this rather than treating it as the system's own considered answer.
 */
function darkFromLight(light: Record<string, string>): Record<string, string> {
  const has = (k: string) => typeof light[k] === "string" && light[k]!.trim().length > 0;
  const out: Record<string, string> = {};
  // Swap the two that carry the mode, and derive the rest from them so the result is internally
  // consistent rather than a pile of independent guesses.
  if (has("background") && has("foreground")) {
    out.background = light.foreground!;
    out.foreground = light.background!;
    // A panel in dark is LIGHTER than the page. `color-mix` keeps it in the system's own hue
    // instead of introducing a grey the system never chose.
    out.card = `color-mix(in oklab, ${light.foreground}, ${light.background} 8%)`;
    out["card-foreground"] = light.background!;
    out.popover = out.card;
    out["popover-foreground"] = light.background!;
    out.secondary = `color-mix(in oklab, ${light.foreground}, ${light.background} 14%)`;
    out["secondary-foreground"] = light.background!;
    out.muted = out.secondary;
    out["muted-foreground"] = `color-mix(in oklab, ${light.background}, ${light.foreground} 40%)`;
    out.border = `color-mix(in oklab, ${light.foreground}, ${light.background} 20%)`;
    out.input = out.border;
  }
  // Identity is not derived. Accent, its text, and danger stay exactly as the brand set them.
  for (const keep of ["primary", "primary-foreground", "accent", "accent-foreground", "destructive", "ring"]) {
    if (has(keep)) out[keep] = light[keep]!;
  }
  return out;
}

export function shadcnFromDesignSystem(id: string | undefined): string {
  const s = id ? designSystem(id) : undefined;
  if (!s) return "";
  const value = (name: string): string | undefined => {
    const m = s.tokens.match(new RegExp(`--${name}\\s*:\\s*([^;]+);`));
    return m?.[1]?.trim();
  };
  const lines: string[] = [];
  for (const [role, sources, why] of SHADCN_FROM_SYSTEM) {
    const v = sources.map(value).find((x) => x);
    if (v) lines.push(`  --${role}: ${v}; /* ${why} */`);
  }
  // Type and shape, which shadcn also reads by these names.
  for (const [role, from] of [
    ["font-sans", "font-body"],
    ["font-serif", "font-display"],
    ["font-mono", "font-mono"],
    ["radius", "radius-md"],
  ] as const) {
    const v = value(from);
    if (v) lines.push(`  --${role}: ${v};`);
  }
  if (!lines.length) return "";

  // The light values by role, for the dark derivation below.
  const light: Record<string, string> = {};
  for (const [role, sources] of SHADCN_FROM_SYSTEM) {
    const v = sources.map(value).find((x) => x);
    if (v) light[role] = v;
  }
  const dark = darkFromLight(light);
  const darkLines = Object.entries(dark).map(([k, v]) => `  --${k}: ${v};`);

  return [
    `/* ${s.id}, in shadcn's vocabulary.`,
    ` * Generated by shadcnFromDesignSystem — the values are the system's, the NAMES are the ones`,
    ` * our components already ask for. Do not hand-edit: change the system.`,
    ` */`,
    ":root {",
    ...lines,
    "}",
    "",
    `/* Dark, DERIVED — ${s.id} ships no dark variant, as none of the systems do. Page and ink swap,`,
    ` * panels lift off the page, hairlines lighten, and the accent does not move because it is the`,
    ` * brand's and not the mode's. Replace this block if you have a better one; do not delete it,`,
    ` * because a light-only theme fails every artefact graded on both themes. */`,
    ".dark {",
    ...darkLines,
    "}",
  ].join("\n");
}

export const DEFAULT_DESIGN_SYSTEM = "professional";

/**
 * The mapping, readable. The console shows a founder which system their chosen look implies, and it
 * must not own a second copy of this table — two copies is how "Editorial" comes to mean one thing
 * in the chooser and another in the run that makes the document.
 */
export function designSystemsByArchetype(): Record<string, string> {
  return { ...ARCHETYPE_SYSTEM };
}

/** The system id for an archetype, falling back to a competent neutral — never to our own brand. */
export function designSystemForArchetype(archetype: string | undefined): string {
  const mapped = archetype ? ARCHETYPE_SYSTEM[archetype] : undefined;
  const id = mapped ?? DEFAULT_DESIGN_SYSTEM;
  return designSystem(id) ? id : (designSystemIds()[0] ?? "");
}

/**
 * What this business wears: the founder's explicit choice if they made one, otherwise the look
 * their archetype implies.
 *
 * An explicit id that is not on disk is IGNORED rather than honoured, because the alternative is a
 * run with no house style at all — a stored id can outlive the system it names (a rename, a
 * vendored set trimmed) and the founder should get their archetype's look back, not nothing.
 */
export function designSystemFor(identity: { archetype?: string; design_system?: string } | undefined): string {
  const chosen = identity?.design_system;
  if (typeof chosen === "string" && designSystem(chosen)) return chosen;
  return designSystemForArchetype(typeof identity?.archetype === "string" ? identity.archetype : undefined);
}


/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE PALETTE A PRINTED ARTIFACT SHOULD WEAR, TAKEN FROM THE SYSTEM ITSELF
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * There were two mappings from a visual identity to a look. `ARCHETYPE_SYSTEM` above points seven
 * archetypes at these twenty-nine designer-authored systems, and the model reads their `tokens.css`
 * while it writes. `brandkit.ts` kept a SECOND table of seven hand-typed hexes, and that one is what
 * the PDF renderer actually used — so the artifact a client receives was dressed by the copy, not by
 * the system the founder picked.
 *
 * One table had to go, and it was not going to be the twenty-nine files a designer wrote.
 *
 * ═══ WHY `--fg` IS NOT ALWAYS SAFE TO TAKE ═══
 *
 * Four of these systems are dark-themed — `futuristic`, `luxury`, `mission-control`,
 * `trading-terminal` — and their `--fg` is nearly white because it is meant to sit on a near-black
 * surface. A PDF prints on paper. Taking `#fff8ea` as body ink would produce a blank page, and
 * `minimal-luxury` maps to `luxury`, so that is not a hypothetical.
 *
 * So the ink is only adopted when it is genuinely dark. Anything else keeps the caller's default and
 * the system contributes its ACCENT alone — a gold or a cyan reads correctly on white, and it is the
 * part of the identity a reader actually notices.
 *
 * Nothing is invented here. A system with no usable declaration returns nothing and the caller falls
 * back, which is the same direction every other resolution in this file takes.
 */
export interface PrintPalette {
  /** Body ink, only when the system's own foreground is dark enough to print. */
  ink?: string;
  /** The system's accent. Safe on paper whatever the theme. */
  accent?: string;
}

/** Relative luminance, sRGB. Above 0.5 is a light colour and cannot be body ink on white paper. */
function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  if (full.length < 6) return 1;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

const DECL = (tokens: string, name: string): string | undefined => {
  const m = new RegExp(`--${name}\\s*:\\s*(#[0-9a-fA-F]{3,8})`).exec(tokens);
  return m?.[1]?.toLowerCase();
};

export function printPaletteFor(systemId: string): PrintPalette {
  const sys = designSystem(systemId);
  if (!sys?.tokens) return {};
  const out: PrintPalette = {};
  const accent = DECL(sys.tokens, "accent");
  if (accent) out.accent = accent;
  const fg = DECL(sys.tokens, "fg");
  // See the note above: a dark-theme foreground is white, and white ink does not print.
  if (fg && luminance(fg) < 0.5) out.ink = fg;
  return out;
}

/**
 * ═══ WHAT A CHOOSER NEEDS TO SHOW A LOOK WITHOUT SHIPPING THE WHOLE FILE ═══
 *
 * A founder cannot judge a design system from its name, and `editorial` vs `warm-editorial` vs
 * `publication` are three names for things that differ in ways only a picture explains. So the
 * console renders a real specimen — and to do that it needs the actual values, not a label.
 *
 * The swatch is the four decisions that carry a look: page, ink, accent, and what sits on the
 * accent. Those four in a row are recognisable; a twenty-token dump is not.
 */
export interface DesignSystemSummary {
  id: string;
  /** Human label — the id, title-cased. The systems carry no display name of their own. */
  label: string;
  /** The one-line intent from the top of tokens.css, when it has one. */
  feel?: string;
  swatch: { paper?: string; ink?: string; accent?: string; onAccent?: string };
}

/** Read one custom property out of a tokens.css `:root` block. */
function tokenValue(css: string, name: string): string | undefined {
  const m = css.match(new RegExp(`--${name}\\s*:\\s*([^;]+);`));
  const v = m?.[1]?.trim();
  // `color-mix(...)` and `var(...)` are real values in the file and useless as a swatch — a chooser
  // cannot paint them without a browser to resolve them in.
  if (!v || /^(var|color-mix)\(/.test(v)) return undefined;
  return v.slice(0, 64);
}

const titleCase = (id: string) => id.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

export function designSystemSummaries(): DesignSystemSummary[] {
  const out: DesignSystemSummary[] = [];
  for (const id of designSystemIds()) {
    const s = designSystem(id);
    if (!s) continue;
    // The vendored files open with a comment whose third line states the intent, e.g.
    // "neutral app chrome, practical hierarchy, restrained blue action".
    const feel = s.tokens.match(/^\s*\*\s*([a-z][^*\n]{15,120})$/m)?.[1]?.trim().replace(/\.$/, "");
    out.push({
      id,
      label: titleCase(id),
      ...(feel ? { feel } : {}),
      swatch: {
        paper: tokenValue(s.tokens, "bg") ?? tokenValue(s.tokens, "surface"),
        ink: tokenValue(s.tokens, "fg"),
        accent: tokenValue(s.tokens, "accent"),
        onAccent: tokenValue(s.tokens, "accent-on"),
      },
    });
  }
  return out;
}
