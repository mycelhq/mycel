// The one place a business's visual identity is defined.
//
// WHY THIS FILE EXISTS AND WHY IT IS NOT A NEW TABLE
// -------------------------------------------------
// Branding already had a home: `Project.branding`, a jsonb column, served to the generated business
// app by `GET /v1/host/:host` and read there by `businessProfile()` in `business-template/lib/
// kernel.ts`. That home held exactly three fields — display_name, accent, support_email.
//
// The temptation, when the renderer needed a logo and a footer, was to invent an `ArtifactTheme`
// beside it. That is the mistake `client-context.ts` argues against at length: a second home for the
// truth starts disagreeing with the first, and then a founder's invoice and a founder's website are
// two different companies. So `BrandKit` is a strict SUPERSET of the old three fields, stored in the
// same column, served on the same route. `Project.branding` IS the kit; nothing else stores brand.
//
// WHY IT LIVES HERE AND NOT IN contract.ts
// ----------------------------------------
// `identity.ts` (which owns Project) imports nothing from `contract.ts` — deliberately; contract.ts
// is the OPERATOR domain and identity is underneath it. This module depends only on `shadcn-preset`
// (pure). Both identity.ts and the renderer can depend on it without either depending on the
// other, and the renderer stays a pure function of (data, kit).
//
// LOGO STORAGE
// ------------
// A logo is a binary a tenant uploads that then gets embedded into every artifact. It lives INLINE
// in the kit as base64, capped at MAX_LOGO_BYTES, in the project's jsonb — not in the artifact
// backend. Two reasons. The artifact backend keys off a task id and its download route authorises
// through that task; a logo belongs to no run, so it has no task to hang from and no one to
// authorise. And the renderer must be a pure function: handing it a storage handle so it can fetch
// a logo mid-layout would give a document template broad read access to tenant blobs, which is a
// much larger surface than "here are 40KB of PNG". The cap is what makes inline honest — it is a
// mark, not a media library.

import {
  DEFAULT_SHADCN_PRESET,
  encodeShadcnPreset,
  fontFamilyKind,
  normalizeShadcnPreset,
  type ShadcnPresetConfig,
} from "./shadcn-preset";

export type { ShadcnPresetConfig };
export { DEFAULT_SHADCN_PRESET, encodeShadcnPreset };

/** How big a logo may be, decoded. A wordmark PNG at 4× is a few tens of KB; this is generous. */
export const MAX_LOGO_BYTES = 256 * 1024;

/**
 * What the PDF emitter can actually embed, and therefore what the upload boundary accepts.
 *
 * SVG is deliberately absent. The PDF emitter would have to interpret arbitrary SVG — filters,
 * gradients, foreignObject — and whatever it failed to interpret would render in the SVG preview
 * and vanish from the PDF. A brand system whose two outputs disagree is worse than one that says no.
 */
export const LOGO_MIME_TYPES = ["image/png", "image/jpeg"] as const;
export type LogoMime = (typeof LOGO_MIME_TYPES)[number];

export interface BrandLogo {
  mime: LogoMime;
  /** Raw bytes, base64. Never a data URL — the prefix is a parsing bug waiting to happen. */
  data: string;
  /** Intrinsic pixel size, so a renderer can preserve aspect ratio without decoding the image. */
  width: number;
  height: number;
}

/** Which of the PDF base-14 families a role uses. See `render/fonts.ts` for why only two. */
export type TypeFamily = "sans" | "serif";

/**
 * How the top of a document is dressed.
 *   plain — nothing. The most conservative, and what a business with no configured brand gets.
 *   rule  — a hairline in the accent under the header. Quiet, works with any logo.
 *   band  — a solid accent bar across the head of the page. Loud, and what most agencies pick.
 */
export type LetterheadStyle = "plain" | "rule" | "band";

export type HeroShape = "stack" | "split" | "lede";

export interface SiteDesign {
  /** Optional marketing fold override; when absent, product-builder picks from style. */
  hero_shape?: HeroShape;
  /** Full shadcn/create preset — source of truth for colours, type, radius on the live site. */
  preset?: Partial<ShadcnPresetConfig> & { code?: string };
}

/**
 * The resolved kit. Every field is present — a renderer never asks "and if this is missing?".
 *
 * Produced only by `resolveBrandKit`, which is the only function allowed to decide a default.
 */
/**
 * The approved visual identity for this business — the output of the `design_identity` task, stored
 * so `build_feature` reads it as the brief and every future rebuild reuses it. It is design DIRECTION,
 * not tokens: the tokens live in `site.preset` / `accent` / `type` and this says how to USE them.
 *
 * Typed loosely on purpose. It is produced by a model against the `design_identity` output_schema and
 * read by another model (the build agent); over-validating every nested string here would reject a
 * good identity because one enum drifted. It is stored as an opaque object under a size cap (see
 * `validIdentity`) and every field is optional — an unset identity is the honest "not designed yet"
 * state that keeps the old single-template behaviour rather than half-applying a broken brief.
 */
export interface VisualIdentity {
  archetype?: string;
  rationale?: string;
  palette?: { accent_use?: string; neutral_temperature?: string; default_mode?: "light" | "dark"; notes?: string };
  typography?: { heading?: string; body?: string; pairing_rationale?: string; scale?: string };
  layout?: { hero_shape?: HeroShape; grid?: string; rhythm?: string; signature_motif?: string };
  motion?: string;
  sections?: Array<{ kind?: string; intent?: string }>;
  voice?: string;
  avoid?: string[];
  /** When the founder approved it — set by the branding write, so a rebuild can say "designed on …". */
  approved_at?: string;
}

export interface BrandKit {
  display_name: string;
  /** #rrggbb. Validated on the way in; a colour reaches a style attribute and a PDF colour op. */
  accent: string;
  /** The ink. Body text, rules, table headings. Dark grey rather than black reads better on paper. */
  neutral: string;
  support_email?: string;
  logo?: BrandLogo;
  /** A square-ish variant for tight spots. Falls back to `logo`, then to the wordmark. */
  mark?: BrandLogo;
  type: { heading: TypeFamily; body: TypeFamily };
  letterhead: LetterheadStyle;
  /**
   * The small print at the foot of every artifact: registered address, tax number, payment terms.
   * Lines, not a paragraph, because a renderer must not have to decide where to break.
   */
  footer: string[];
  site: {
    hero_shape: HeroShape;
    preset: ShadcnPresetConfig & { code: string };
  };
  /** The approved bespoke design direction, when one has been synthesised and approved. */
  identity?: VisualIdentity;
}

/**
 * The STORED shape — every field optional, because a business that has configured nothing is the
 * normal case and must not be represented by a row full of our guesses.
 *
 * This is what `Project.branding` is typed as. The first three fields are the original branding
 * object, unchanged, so every existing row is already a valid config.
 */
export interface BrandKitConfig {
  display_name?: string;
  accent?: string;
  support_email?: string;
  neutral?: string;
  logo?: BrandLogo;
  mark?: BrandLogo;
  type?: { heading?: TypeFamily; body?: TypeFamily };
  letterhead?: LetterheadStyle;
  footer?: string[];
  site?: SiteDesign;
  identity?: VisualIdentity;
}

/** The same green `GET /v1/host/:host` has always defaulted to. Changing it would restyle every
 *  unconfigured tenant's website, so it stays where it is and is stated once. */
export const DEFAULT_ACCENT = "#16a34a";
const DEFAULT_NEUTRAL = "#1f2937";

export const HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * A name the product wrote for the founder rather than the other way round.
 *
 * Exported because the console has the same rule (cloud/lib/business-name.ts) and the two must
 * agree: a business shown as "Your business" in the sidebar and "default" on its own invoices is
 * arguably worse than being wrong consistently. Only one string, deliberately — treating a real,
 * chosen name as a placeholder would be a worse bug than the one this fixes.
 */
export function isPlaceholderName(name: string | undefined | null): boolean {
  const t = (name ?? "").trim().toLowerCase();
  return t === "" || t === "default";
}

/**
 * Config + the project's own name → a kit with no holes.
 *
 * `projectName` is required rather than defaulted because the fallback for a missing display name is
 * "what the founder called this business", and only the caller holding the Project knows that. A
 * default baked in here would be some other tenant's idea of a name.
 *
 * A business that has configured NOTHING gets: its own name set in the heading face, the house
 * accent, a hairline rule, no logo and no footer. That is a clean plain document — never an empty
 * box where a logo should be, and never a layout that reserved space for something absent.
 */
/**
 * The look each archetype implies, as concrete preset values — the bridge from the design_identity's
 * `archetype` to the brand kit. Used ONLY when the founder has NOT configured a preset: it turns an
 * "editorial" identity into a serif display and warm neutrals instead of the house Inter-and-green,
 * so an archetype actually changes the look. The instant a founder sets their own preset in Settings
 * → Brand, that wins and this is ignored — the identity proposes, the founder disposes.
 *
 * Values are drawn from the closed preset enums (shadcn-preset.ts). `accent` is the `--business-accent`
 * hex the site and PDFs use; the `theme` drives the shadcn palette. Fonts are self-hostable (no CDN).
 */
const ARCHETYPE_PRESET: Record<
  string,
  { preset: Partial<ShadcnPresetConfig>; accent: string; type: { heading: TypeFamily; body: TypeFamily } }
> = {
  editorial: {
    preset: { style: "maia", theme: "stone", baseColor: "stone", font: "inter", fontHeading: "playfair-display", radius: "small" },
    accent: "#1c1917",
    type: { heading: "serif", body: "sans" },
  },
  technical: {
    preset: { style: "nova", theme: "blue", baseColor: "zinc", font: "geist", fontHeading: "geist-mono", radius: "small" },
    accent: "#2563eb",
    type: { heading: "sans", body: "sans" },
  },
  "warm-organic": {
    preset: { style: "luma", theme: "amber", baseColor: "stone", font: "dm-sans", fontHeading: "inherit", radius: "large" },
    accent: "#c2571a",
    type: { heading: "sans", body: "sans" },
  },
  "bold-brutalist": {
    preset: { style: "lyra", theme: "neutral", baseColor: "neutral", font: "inter", fontHeading: "space-grotesk", radius: "none" },
    accent: "#111111",
    type: { heading: "sans", body: "sans" },
  },
  "minimal-luxury": {
    preset: { style: "sera", theme: "taupe", baseColor: "taupe", font: "inter", fontHeading: "eb-garamond", radius: "none" },
    accent: "#3f3c37",
    type: { heading: "serif", body: "sans" },
  },
  playful: {
    preset: { style: "vega", theme: "violet", baseColor: "gray", font: "outfit", fontHeading: "inherit", radius: "large" },
    accent: "#7c3aed",
    type: { heading: "sans", body: "sans" },
  },
  "corporate-trust": {
    preset: { style: "nova", theme: "indigo", baseColor: "gray", font: "ibm-plex-sans", fontHeading: "inherit", radius: "default" },
    accent: "#4338ca",
    type: { heading: "sans", body: "sans" },
  },
};

/** The archetype's look, or nothing — for an unknown/absent archetype or one we have no mapping for. */
function archetypeLook(identity: VisualIdentity | undefined) {
  const a = identity?.archetype;
  return a ? ARCHETYPE_PRESET[a] : undefined;
}

export function resolveBrandKit(config: BrandKitConfig | undefined, projectName: string): BrandKit {
  const c = config ?? {};
  // The identity proposes a look ONLY where the founder has set none. A configured preset always wins.
  const look = c.site?.preset ? undefined : archetypeLook(c.identity);
  const presetBody = normalizeShadcnPreset(c.site?.preset ?? look?.preset ?? {});
  const preset = presetBody.config;
  const code =
    typeof c.site?.preset?.code === "string" && c.site.preset.code.length > 1
      ? c.site.preset.code
      : encodeShadcnPreset(preset);
  const headingFromPreset = fontFamilyKind(
    preset.fontHeading === "inherit" ? preset.font : preset.fontHeading,
  );
  const bodyFromPreset = fontFamilyKind(preset.font);
  const heading =
    c.type?.heading === "serif" || c.type?.heading === "sans" ? c.type.heading : headingFromPreset;
  const body = c.type?.body === "serif" || c.type?.body === "sans" ? c.type.body : bodyFromPreset;
  const hero_shape =
    c.site?.hero_shape === "stack" || c.site?.hero_shape === "split" || c.site?.hero_shape === "lede"
      ? c.site.hero_shape
      : "stack";
  return {
    /**
     * `default` IS NOT A NAME and must never become a letterhead.
     *
     * The kernel bootstraps its first tenant with `name: "default"` on both the org and the project
     * (identity.ts), and `POST /v1/auth/signup` wrote the same string until the fix that names the
     * first project after the org. `IdentityStore.brandKit()` passes the project name straight in,
     * so an account still carrying the placeholder printed "default" as the business name on every
     * invoice and receipt PDF it sent and as the heading of its client portal. That is the
     * placeholder escaping past the founder to the founder's OWN customer, which is the worst place
     * for it to land, and it cannot be fixed by renaming the row — there is no rename route and a
     * migration would be renaming somebody's business behind their back.
     *
     * Falling through to "Invoice" is no great name either, but it is a word about the document
     * rather than our word for an unconfigured tenant, and it is already the answer for a project
     * with no name at all.
     */
    display_name:
      (c.display_name || (isPlaceholderName(projectName) ? "" : projectName) || "").slice(0, 80) ||
      "Invoice",
    accent: HEX.test(c.accent ?? "") ? c.accent!.toLowerCase() : (look?.accent ?? DEFAULT_ACCENT),
    neutral: HEX.test(c.neutral ?? "") ? c.neutral!.toLowerCase() : DEFAULT_NEUTRAL,
    support_email: c.support_email || undefined,
    logo: validLogo(c.logo),
    mark: validLogo(c.mark) ?? validLogo(c.logo),
    type: { heading, body },
    letterhead: c.letterhead === "band" || c.letterhead === "plain" ? c.letterhead : "rule",
    footer: (Array.isArray(c.footer) ? c.footer : []).map((l) => String(l).slice(0, 200)).slice(0, 6),
    site: {
      hero_shape,
      preset: { ...preset, code },
    },
    ...(validIdentity(c.identity) ? { identity: validIdentity(c.identity) } : {}),
  };
}

/**
 * An identity we are willing to store and hand to a build agent, or nothing.
 *
 * Checked here (read side) as well as at the write boundary, because a row can have been written by
 * an older build. The bar is deliberately low — a plain object under a size cap — because this is
 * design direction produced by one model and read by another, not a value that reaches a PDF content
 * stream or a style attribute the way a colour does. What it must NOT be is unbounded (it rides on
 * every brand-kit read) or a non-object (which would break the build agent's read of `.archetype`).
 */
const MAX_IDENTITY_BYTES = 12_000;
export function validIdentity(v: unknown): VisualIdentity | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  let json: string;
  try {
    json = JSON.stringify(v);
  } catch {
    return undefined; // circular / unserialisable
  }
  if (json.length > MAX_IDENTITY_BYTES) return undefined;
  return v as VisualIdentity;
}

/**
 * A logo the renderer is willing to touch, or nothing.
 *
 * Checked HERE as well as at the write boundary, because a kit can also come out of a jsonb column
 * written by an older version of this code, and "the database only ever contains valid rows" is the
 * assumption that puts a corrupt base64 blob into a PDF a client opens.
 */
function validLogo(l: BrandLogo | undefined): BrandLogo | undefined {
  if (!l || typeof l.data !== "string" || !l.data) return undefined;
  if (!(LOGO_MIME_TYPES as readonly string[]).includes(l.mime)) return undefined;
  if (!Number.isFinite(l.width) || !Number.isFinite(l.height) || l.width <= 0 || l.height <= 0) return undefined;
  // 4 base64 chars per 3 bytes; compare without decoding so a huge blob is rejected before it costs
  // us the allocation.
  if (l.data.length > Math.ceil((MAX_LOGO_BYTES / 3) * 4) + 4) return undefined;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(l.data)) return undefined;
  return { mime: l.mime as LogoMime, data: l.data, width: Math.round(l.width), height: Math.round(l.height) };
}

export interface BrandKitProblem {
  field: string;
  message: string;
}

/**
 * Validate what a founder (or a UI, or a script) is asking us to store.
 *
 * Returns the config to persist plus the reasons anything was refused. Refusals are returned rather
 * than silently dropped: a logo that vanishes with a 200 is a support ticket.
 */
export function normalizeBrandKitConfig(input: unknown): { config: BrandKitConfig; problems: BrandKitProblem[] } {
  const b = (input ?? {}) as Record<string, any>;
  const problems: BrandKitProblem[] = [];
  const config: BrandKitConfig = {};

  if (b.display_name !== undefined) config.display_name = String(b.display_name).slice(0, 80);
  if (b.support_email !== undefined) config.support_email = String(b.support_email).slice(0, 200);

  for (const key of ["accent", "neutral"] as const) {
    if (b[key] === undefined) continue;
    const v = String(b[key]);
    // A colour goes into a style attribute on a page served to a founder's customers AND into a PDF
    // content stream. Anything that is not a hex triple is an injection into one of the two.
    if (!HEX.test(v)) problems.push({ field: key, message: `${key} must be a hex colour like #16a34a` });
    else config[key] = v.toLowerCase();
  }

  for (const key of ["logo", "mark"] as const) {
    if (b[key] === undefined) continue;
    if (b[key] === null) { config[key] = undefined; continue; }
    const l = b[key] as Record<string, any>;
    if (!(LOGO_MIME_TYPES as readonly string[]).includes(String(l?.mime))) {
      problems.push({ field: key, message: `logo must be one of ${LOGO_MIME_TYPES.join(", ")} — SVG is not embeddable in a PDF` });
      continue;
    }
    const ok = validLogo({ mime: l.mime, data: String(l.data ?? ""), width: Number(l.width), height: Number(l.height) });
    if (!ok) problems.push({ field: key, message: `logo must be base64 image bytes under ${MAX_LOGO_BYTES / 1024}KB with a positive width and height` });
    else config[key] = ok;
  }

  if (b.type !== undefined) {
    config.type = {
      heading: b.type?.heading === "serif" ? "serif" : "sans",
      body: b.type?.body === "serif" ? "serif" : "sans",
    };
  }
  if (b.letterhead !== undefined) {
    if (!["plain", "rule", "band"].includes(String(b.letterhead))) {
      problems.push({ field: "letterhead", message: "letterhead must be plain, rule or band" });
    } else config.letterhead = b.letterhead as LetterheadStyle;
  }
  if (b.footer !== undefined) {
    if (!Array.isArray(b.footer)) problems.push({ field: "footer", message: "footer must be an array of lines" });
    else config.footer = b.footer.map((l: unknown) => String(l).slice(0, 200)).slice(0, 6);
  }
  if (b.site !== undefined) {
    if (!b.site || typeof b.site !== "object") {
      problems.push({ field: "site", message: "site must be an object" });
    } else {
      const site: SiteDesign = {};
      const hs = String(b.site.hero_shape ?? "");
      if (b.site.hero_shape !== undefined) {
        if (!["stack", "split", "lede"].includes(hs)) {
          problems.push({ field: "site.hero_shape", message: "hero_shape must be stack, split or lede" });
        } else site.hero_shape = hs as HeroShape;
      }
      if (b.site.preset !== undefined) {
        if (!b.site.preset || typeof b.site.preset !== "object") {
          problems.push({ field: "site.preset", message: "preset must be an object" });
        } else {
          const { config: preset, problems: presetProblems } = normalizeShadcnPreset(b.site.preset);
          for (const p of presetProblems) problems.push({ field: "site.preset", message: p });
          const code =
            typeof b.site.preset.code === "string" && b.site.preset.code.length > 1
              ? String(b.site.preset.code).slice(0, 32)
              : encodeShadcnPreset(preset);
          site.preset = { ...preset, code };
          // Keep invoice type pairing in step with the preset fonts unless the caller set type.
          if (b.type === undefined) {
            config.type = {
              heading: fontFamilyKind(
                preset.fontHeading === "inherit" ? preset.font : preset.fontHeading,
              ),
              body: fontFamilyKind(preset.font),
            };
          }
        }
      }
      config.site = site;
    }
  }
  if (b.identity !== undefined) {
    if (b.identity === null) {
      config.identity = undefined; // an explicit clear — back to the un-designed default
    } else {
      const ident = validIdentity(b.identity);
      if (!ident) {
        problems.push({
          field: "identity",
          message: `identity must be an object under ${MAX_IDENTITY_BYTES / 1000}KB`,
        });
      } else {
        // Stamp the approval time here, at the write, unless the caller already set one. This is what
        // makes "designed on <date>" truthful — it is the moment a human accepted it, not the moment
        // the model drafted it.
        config.identity = ident.approved_at ? ident : { ...ident, approved_at: new Date().toISOString() };
      }
    }
  }
  return { config, problems };
}

/**
 * What crosses to a browser — the kit WITHOUT the logo bytes.
 *
 * The generated marketing site wants the accent, the name and the type pairing on every page load;
 * it does not want 200KB of base64 inlined into an HTML document that is not cached. The logo is
 * fetched as an image when it is actually shown.
 */
export function publicBrandKit(kit: BrandKit): Omit<BrandKit, "logo" | "mark"> & { has_logo: boolean; has_mark: boolean } {
  const { logo, mark, ...rest } = kit;
  return { ...rest, has_logo: !!logo, has_mark: !!mark };
}

/**
 * The logo, decoded, ready to become an HTTP body — or a 404.
 *
 * Pure so the "no logo set → 404 so the caller falls back to the name" decision is asserted in a
 * test rather than trusted in a route handler. `data` is raw base64 (never a data URL — see
 * `BrandLogo`), so this is a straight decode with no prefix to strip. The mime is one of two audited
 * values, so it goes onto `content-type` verbatim.
 */
export interface LogoImage {
  contentType: LogoMime;
  bytes: Uint8Array<ArrayBuffer>;
}
export function decodeBrandLogo(logo: BrandLogo | undefined): LogoImage | undefined {
  if (!logo?.data) return undefined;
  const buf = Buffer.from(logo.data, "base64");
  const bytes = new Uint8Array(buf.byteLength);
  bytes.set(buf);
  return { contentType: logo.mime, bytes };
}
