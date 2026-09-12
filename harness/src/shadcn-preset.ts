/**
 * shadcn/create preset model — the founder's design system for the deployed business app.
 *
 * Mirrors the knobs on https://ui.shadcn.com/create (style, base color, theme, fonts, radius).
 * Encoding matches shadcn's own bit-packed preset codes (`b…`) so a founder (or product-builder)
 * can round-trip with `pnpm dlx shadcn@latest init --preset <code>` when rebuilding the seed.
 *
 * Stored on `Project.branding.site.preset`. Applied at runtime by `business-template` via CSS
 * variables (marketing + client portal). Invoice PDF still uses the sans/serif pairing only.
 *
 * ─── THIS FILE IS THE CANONICAL COPY. ─────────────────────────────────────────────────────────
 *
 * It also exists, byte-identical, at `cloud/lib/shadcn-preset.ts` and
 * `business-template/lib/shadcn-preset.ts`. Not a package, because `infra/buildspec.yml` builds
 * each image with the APP DIRECTORY as the Docker context — a sibling under `packages/` is not
 * reachable from a `COPY . .` and cannot be made so without moving three build contexts.
 *
 * Edit here, then copy out to both. `cloud/test/shared-source.test.ts` and
 * `business-template/test/shared-source.test.ts` fail the moment the three disagree.
 */

export const PRESET_STYLES = [
  "nova",
  "vega",
  "maia",
  "lyra",
  "mira",
  "luma",
  "sera",
  "rhea",
] as const;

export const PRESET_BASE_COLORS = [
  "neutral",
  "stone",
  "zinc",
  "gray",
  "mauve",
  "olive",
  "mist",
  "taupe",
] as const;

export const PRESET_THEMES = [
  "neutral",
  "stone",
  "zinc",
  "gray",
  "amber",
  "blue",
  "cyan",
  "emerald",
  "fuchsia",
  "green",
  "indigo",
  "lime",
  "orange",
  "pink",
  "purple",
  "red",
  "rose",
  "sky",
  "teal",
  "violet",
  "yellow",
  "mauve",
  "olive",
  "mist",
  "taupe",
] as const;

export const PRESET_FONTS = [
  "inter",
  "noto-sans",
  "nunito-sans",
  "figtree",
  "roboto",
  "raleway",
  "dm-sans",
  "public-sans",
  "outfit",
  "jetbrains-mono",
  "geist",
  "geist-mono",
  "lora",
  "merriweather",
  "playfair-display",
  "noto-serif",
  "roboto-slab",
  "oxanium",
  "manrope",
  "space-grotesk",
  "montserrat",
  "ibm-plex-sans",
  "source-sans-3",
  "instrument-sans",
  "eb-garamond",
  "instrument-serif",
] as const;

export const PRESET_FONT_HEADINGS = ["inherit", ...PRESET_FONTS] as const;

export const PRESET_RADII = ["default", "none", "small", "medium", "large"] as const;

export const PRESET_ICON_LIBRARIES = ["lucide", "hugeicons", "tabler", "phosphor", "remixicon"] as const;
export const PRESET_MENU_ACCENTS = ["subtle", "bold"] as const;
export const PRESET_MENU_COLORS = [
  "default",
  "inverted",
  "default-translucent",
  "inverted-translucent",
] as const;

export type PresetStyle = (typeof PRESET_STYLES)[number];
export type PresetBaseColor = (typeof PRESET_BASE_COLORS)[number];
export type PresetTheme = (typeof PRESET_THEMES)[number];
export type PresetFont = (typeof PRESET_FONTS)[number];
export type PresetFontHeading = (typeof PRESET_FONT_HEADINGS)[number];
export type PresetRadius = (typeof PRESET_RADII)[number];

export interface ShadcnPresetConfig {
  style: PresetStyle;
  baseColor: PresetBaseColor;
  theme: PresetTheme;
  chartColor?: PresetTheme;
  iconLibrary: (typeof PRESET_ICON_LIBRARIES)[number];
  font: PresetFont;
  fontHeading: PresetFontHeading;
  radius: PresetRadius;
  menuAccent: (typeof PRESET_MENU_ACCENTS)[number];
  menuColor: (typeof PRESET_MENU_COLORS)[number];
}

const PRESET_FIELDS = [
  { key: "menuColor", values: PRESET_MENU_COLORS, bits: 3 },
  { key: "menuAccent", values: PRESET_MENU_ACCENTS, bits: 3 },
  { key: "radius", values: PRESET_RADII, bits: 4 },
  { key: "font", values: PRESET_FONTS, bits: 6 },
  { key: "iconLibrary", values: PRESET_ICON_LIBRARIES, bits: 6 },
  { key: "theme", values: PRESET_THEMES, bits: 6 },
  { key: "baseColor", values: PRESET_BASE_COLORS, bits: 6 },
  { key: "style", values: PRESET_STYLES, bits: 6 },
  { key: "chartColor", values: PRESET_THEMES, bits: 6 },
  { key: "fontHeading", values: PRESET_FONT_HEADINGS, bits: 5 },
] as const;

export const DEFAULT_SHADCN_PRESET: ShadcnPresetConfig = {
  style: "nova",
  baseColor: "neutral",
  theme: "neutral",
  chartColor: "neutral",
  iconLibrary: "lucide",
  font: "inter",
  fontHeading: "inherit",
  radius: "default",
  menuAccent: "subtle",
  menuColor: "default",
};

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function toBase62(num: number): string {
  if (num === 0) return "0";
  let result = "";
  let n = num;
  while (n > 0) {
    result = BASE62[n % 62] + result;
    n = Math.floor(n / 62);
  }
  return result;
}

function fromBase62(str: string): number {
  let result = 0;
  for (let i = 0; i < str.length; i++) {
    const idx = BASE62.indexOf(str[i]);
    if (idx === -1) return -1;
    result = result * 62 + idx;
  }
  return result;
}

/** Encode a preset into a shadcn v2 (`b…`) code. */
export function encodeShadcnPreset(config: Partial<ShadcnPresetConfig>): string {
  const merged = { ...DEFAULT_SHADCN_PRESET, ...config };
  let bits = 0;
  let offset = 0;
  for (const field of PRESET_FIELDS) {
    const val = merged[field.key as keyof ShadcnPresetConfig] as string;
    const idx = (field.values as readonly string[]).indexOf(val);
    bits += (idx === -1 ? 0 : idx) * 2 ** offset;
    offset += field.bits;
  }
  return "b" + toBase62(bits);
}

/** Decode a shadcn preset code, or null if malformed. */
export function decodeShadcnPreset(code: string): ShadcnPresetConfig | null {
  if (!code || code.length < 2) return null;
  const version = code[0];
  if (version !== "a" && version !== "b") return null;
  const fields = version === "a" ? PRESET_FIELDS.slice(0, 8) : PRESET_FIELDS;
  const bits = fromBase62(code.slice(1));
  if (bits < 0) return null;
  const out = { ...DEFAULT_SHADCN_PRESET };
  let n = bits;
  for (const field of fields) {
    const mask = 2 ** field.bits;
    const idx = n % mask;
    n = Math.floor(n / mask);
    const value = (field.values as readonly string[])[idx] ?? field.values[0];
    (out as Record<string, string>)[field.key] = value;
  }
  return out;
}

export const RADIUS_CSS: Record<PresetRadius, string> = {
  default: "0.625rem",
  none: "0",
  small: "0.45rem",
  medium: "0.625rem",
  large: "0.875rem",
};

/**
 * What a shadcn/create *style* actually changes, besides the name.
 *
 * Style is not a colour. It is radius default, shadow, density, and (for Sera) editorial type.
 * Lyra was the only one that appeared to "work" because it was the only one that forced
 * `radius: none`. These traits are what the preview and the live CSS variables apply for the rest.
 */
export interface StyleTraits {
  radius: PresetRadius;
  shadow: string;
  pad: string;
  tracking: string;
  transform: "none" | "uppercase";
  weight: string;
  /** Inputs/buttons; Maia/Luma go pill-shaped. */
  inputRadius: string;
}

export const STYLE_TRAITS: Record<PresetStyle, StyleTraits> = {
  nova: {
    radius: "small",
    shadow: "0 1px 2px oklch(0 0 0 / 0.05)",
    pad: "0.7rem",
    tracking: "-0.01em",
    transform: "none",
    weight: "500",
    inputRadius: "var(--radius)",
  },
  vega: {
    radius: "medium",
    shadow: "0 1px 3px oklch(0 0 0 / 0.08), 0 1px 2px oklch(0 0 0 / 0.04)",
    pad: "0.85rem",
    tracking: "-0.011em",
    transform: "none",
    weight: "500",
    inputRadius: "var(--radius)",
  },
  maia: {
    radius: "large",
    shadow: "0 10px 28px oklch(0 0 0 / 0.08)",
    pad: "1.15rem",
    tracking: "-0.02em",
    transform: "none",
    weight: "500",
    inputRadius: "999px",
  },
  lyra: {
    radius: "none",
    shadow: "none",
    pad: "0.75rem",
    tracking: "0",
    transform: "none",
    weight: "500",
    inputRadius: "0",
  },
  mira: {
    radius: "small",
    shadow: "none",
    pad: "0.5rem",
    tracking: "-0.006em",
    transform: "none",
    weight: "500",
    inputRadius: "var(--radius)",
  },
  luma: {
    radius: "large",
    shadow: "0 12px 32px oklch(0 0 0 / 0.07)",
    pad: "1rem",
    tracking: "-0.018em",
    transform: "none",
    weight: "500",
    inputRadius: "999px",
  },
  sera: {
    radius: "none",
    shadow: "none",
    pad: "0.8rem",
    tracking: "0.08em",
    transform: "uppercase",
    weight: "600",
    inputRadius: "0",
  },
  rhea: {
    radius: "medium",
    shadow: "0 2px 10px oklch(0 0 0 / 0.06)",
    pad: "0.65rem",
    tracking: "-0.012em",
    transform: "none",
    weight: "500",
    inputRadius: "var(--radius)",
  },
};

/** System stacks — no CDN on the portal. Product-builder may wire next/font from the same names. */
export const FONT_STACKS_BY_PRESET: Record<string, string> = {
  inter: 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  geist: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  "geist-mono": 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  "jetbrains-mono": 'ui-monospace, "JetBrains Mono", Menlo, Consolas, monospace',
  "noto-sans": '"Noto Sans", ui-sans-serif, system-ui, sans-serif',
  "nunito-sans": '"Nunito Sans", ui-sans-serif, system-ui, sans-serif',
  figtree: "Figtree, ui-sans-serif, system-ui, sans-serif",
  roboto: "Roboto, ui-sans-serif, system-ui, sans-serif",
  raleway: "Raleway, ui-sans-serif, system-ui, sans-serif",
  "dm-sans": '"DM Sans", ui-sans-serif, system-ui, sans-serif',
  "public-sans": '"Public Sans", ui-sans-serif, system-ui, sans-serif',
  outfit: "Outfit, ui-sans-serif, system-ui, sans-serif",
  oxanium: "Oxanium, ui-sans-serif, system-ui, sans-serif",
  manrope: "Manrope, ui-sans-serif, system-ui, sans-serif",
  "space-grotesk": '"Space Grotesk", ui-sans-serif, system-ui, sans-serif',
  montserrat: "Montserrat, ui-sans-serif, system-ui, sans-serif",
  "ibm-plex-sans": '"IBM Plex Sans", ui-sans-serif, system-ui, sans-serif',
  "source-sans-3": '"Source Sans 3", ui-sans-serif, system-ui, sans-serif',
  "instrument-sans": '"Instrument Sans", ui-sans-serif, system-ui, sans-serif',
  lora: 'Lora, ui-serif, Georgia, "Times New Roman", serif',
  merriweather: 'Merriweather, ui-serif, Georgia, serif',
  "playfair-display": '"Playfair Display", ui-serif, Georgia, serif',
  "noto-serif": '"Noto Serif", ui-serif, Georgia, serif',
  "roboto-slab": '"Roboto Slab", ui-serif, Georgia, serif',
  "eb-garamond": '"EB Garamond", ui-serif, Georgia, serif',
  "instrument-serif": '"Instrument Serif", ui-serif, Georgia, serif',
};

export function fontStack(name: string | undefined): string {
  return FONT_STACKS_BY_PRESET[name ?? ""] ?? FONT_STACKS_BY_PRESET.inter;
}

/** Sans vs serif for invoice PDF pairing. */
export function fontFamilyKind(name: string | undefined): "sans" | "serif" {
  const serif = new Set([
    "lora",
    "merriweather",
    "playfair-display",
    "noto-serif",
    "roboto-slab",
    "eb-garamond",
    "instrument-serif",
  ]);
  return serif.has(name ?? "") ? "serif" : "sans";
}

export function isPresetStyle(v: string): v is PresetStyle {
  return (PRESET_STYLES as readonly string[]).includes(v);
}
export function isPresetBaseColor(v: string): v is PresetBaseColor {
  return (PRESET_BASE_COLORS as readonly string[]).includes(v);
}
export function isPresetTheme(v: string): v is PresetTheme {
  return (PRESET_THEMES as readonly string[]).includes(v);
}
export function isPresetFont(v: string): v is PresetFont {
  return (PRESET_FONTS as readonly string[]).includes(v);
}
export function isPresetFontHeading(v: string): v is PresetFontHeading {
  return (PRESET_FONT_HEADINGS as readonly string[]).includes(v);
}
export function isPresetRadius(v: string): v is PresetRadius {
  return (PRESET_RADII as readonly string[]).includes(v);
}

/** Normalize an unknown body into a full preset (defaults fill gaps). */
export function normalizeShadcnPreset(input: unknown): { config: ShadcnPresetConfig; problems: string[] } {
  const b = (input ?? {}) as Record<string, unknown>;
  const problems: string[] = [];
  const pick = <T extends string>(
    key: string,
    allowed: readonly T[],
    fallback: T,
  ): T => {
    const v = String(b[key] ?? "");
    if (!v) return fallback;
    if (!(allowed as readonly string[]).includes(v)) {
      problems.push(`${key} must be one of ${allowed.join(", ")}`);
      return fallback;
    }
    return v as T;
  };
  const config: ShadcnPresetConfig = {
    style: pick("style", PRESET_STYLES, DEFAULT_SHADCN_PRESET.style),
    baseColor: pick("baseColor", PRESET_BASE_COLORS, DEFAULT_SHADCN_PRESET.baseColor),
    theme: pick("theme", PRESET_THEMES, DEFAULT_SHADCN_PRESET.theme),
    chartColor: pick("chartColor", PRESET_THEMES, DEFAULT_SHADCN_PRESET.theme),
    iconLibrary: pick("iconLibrary", PRESET_ICON_LIBRARIES, DEFAULT_SHADCN_PRESET.iconLibrary),
    font: pick("font", PRESET_FONTS, DEFAULT_SHADCN_PRESET.font),
    fontHeading: pick("fontHeading", PRESET_FONT_HEADINGS, DEFAULT_SHADCN_PRESET.fontHeading),
    radius: pick("radius", PRESET_RADII, DEFAULT_SHADCN_PRESET.radius),
    menuAccent: pick("menuAccent", PRESET_MENU_ACCENTS, DEFAULT_SHADCN_PRESET.menuAccent),
    menuColor: pick("menuColor", PRESET_MENU_COLORS, DEFAULT_SHADCN_PRESET.menuColor),
  };
  // lyra/sera force square corners in shadcn create.
  if (config.style === "lyra" || config.style === "sera") config.radius = "none";
  return { config, problems };
}
