/**
 * THE FIRM'S OWN PALETTE, MEASURED OFF THEIR OWN SITE.
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * "THE NUMBERS ARE MEASURED, NOT REMEMBERED"
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * opendesign's whole argument, and it is the right one: an AI asked for "Stripe-ish blue" produces
 * the mathematical average of its training data, and an average has no brand. Their library exists
 * because a design is recognisable through its ACTUAL tokens, not an approximation of them.
 *
 * Until now every house style we assigned was `chosen`, `derived` or `default` — a designer-authored
 * system picked off a shelf of twenty-nine. Good taste, correctly argued, and not theirs. A firm
 * with a real brand got a look that was merely compatible with it.
 *
 * This reads the brand they already have. Not by asking a model what their site looks like — that is
 * the remembering this exists to replace — but by fetching the stylesheets the site actually ships
 * and counting what is in them.
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * WHY COUNTING BEATS LOOKING
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * opendesign drives a real browser and reads `getComputedStyle`, which is the gold standard and is
 * not available to us: `BROWSERUSE_TOOLS` has `browser_get_html` and no `evaluate`. What we can do
 * is better than the alternative and worse than theirs, which is worth stating plainly rather than
 * overclaiming — we read the DECLARED values rather than the COMPUTED ones. A colour behind a media
 * query we never trigger still counts here; a value produced by a cascade we did not run does not.
 *
 * FREQUENCY IS THE SIGNAL. A brand colour appears in a stylesheet dozens of times; a one-off in an
 * illustration appears once. Ranking by count is what separates the two, and it needs no judgement.
 *
 * PURE. CSS text in, a reading out. No network, no model — the same property `file-shape.ts` and
 * `design-lint.ts` have, and for the same reason: the part that must be exactly right should be
 * testable without either.
 */

export interface MeasuredStyle {
  /** `#rrggbb`, most-used first. Neutrals are filtered out — see `isNeutral`. */
  colors: string[];
  /** Font families as declared, most-used first, stacks reduced to their first name. */
  fonts: string[];
  /** How much CSS this was read from. A reading off two rules is not a brand. */
  declarations: number;
  /** Why the reading is not usable, when it is not. A sentence, not a code. */
  problem?: string;
}

/**
 * `hsl(210 40% 50%)` → `#4d80b3`.
 *
 * Worth the twelve lines: Stripe's stylesheet uses `hsl` twenty-seven times, and a firm whose CSS is
 * written in it would otherwise read as having no brand colour at all — the most confidently wrong
 * answer this module can give.
 *
 * `oklch()` is deliberately NOT handled, and the reason is not the maths. Every real use of it found
 * on live sites is `oklch(var(--brand-blue))` — the components live in a custom property, so parsing
 * the function without resolving the cascade yields nothing. Guessing there would be worse than the
 * honest "we found no colour" this returns instead.
 */
function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return `#${[r, g, b].map((v) => Math.round((v + m) * 255).toString(16).padStart(2, "0")).join("")}`;
}

/** `#abc` → `#aabbcc`; `rgb(1,2,3)` → `#010203`. Anything else is dropped rather than guessed at. */
function toHex(raw: string): string | undefined {
  const s = raw.trim().toLowerCase();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(s);
  if (short) return `#${short[1]!.repeat(2)}${short[2]!.repeat(2)}${short[3]!.repeat(2)}`;
  const long = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/.exec(s);
  if (long) return `#${long[1]}`;
  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(s);
  if (rgb) {
    const [r, g, b] = [rgb[1], rgb[2], rgb[3]].map((v) => Math.min(255, Number(v)));
    return `#${[r, g, b].map((v) => v!.toString(16).padStart(2, "0")).join("")}`;
  }
  // Both spellings: legacy `hsl(210, 40%, 50%)` and modern space-separated `hsl(210 40% 50%)`.
  const hsl = /^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/.exec(s);
  if (hsl) {
    const h = ((Number(hsl[1]) % 360) + 360) % 360;
    return hslToHex(h, Math.min(100, Number(hsl[2])) / 100, Math.min(100, Number(hsl[3])) / 100);
  }
  return undefined;
}

/**
 * Greys, near-whites and near-blacks.
 *
 * Every site on earth ships more `#fff`, `#000` and `#f5f5f5` than anything else, so an unfiltered
 * frequency count returns the same three neutrals for every firm and tells us nothing. What makes a
 * brand recognisable is the chromatic minority.
 *
 * The test is channel spread rather than a saturation formula: a colour whose R, G and B are within
 * 18/255 of each other has no hue worth having. Cheap, and it does not need a colour space.
 */
function isNeutral(hex: string): boolean {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return Math.max(r!, g!, b!) - Math.min(r!, g!, b!) <= 18;
}

/** Faces the browser supplies. Counting them would rank "sans-serif" as every firm's brand font. */
const GENERIC = new Set([
  "inherit", "initial", "unset", "serif", "sans-serif", "monospace", "cursive", "fantasy",
  "system-ui", "ui-sans-serif", "ui-serif", "ui-monospace", "ui-rounded", "-apple-system",
  "blinkmacsystemfont", "segoe ui", "helvetica", "arial", "helvetica neue", "roboto",
]);

const MIN_DECLARATIONS = 40;

/**
 * Read a firm's palette out of the CSS their site ships.
 *
 * `limit` is deliberately small. Three colours and two faces is a brand; twelve of each is a
 * screenshot of a stylesheet, and handing that to a run produces a document wearing everything at
 * once.
 */
export function measureStyle(css: string, limit = 3): MeasuredStyle {
  const text = String(css ?? "").replace(/\/\*[\s\S]*?\*\//g, " ");
  const decls = text.split(/[;{}]/).map((d) => d.trim()).filter(Boolean);
  if (decls.length < MIN_DECLARATIONS) {
    return {
      colors: [],
      fonts: [],
      declarations: decls.length,
      // The commonest real cause by a distance: the site renders its styling with JavaScript, so the
      // stylesheet we fetched is a shell. A founder can act on that sentence; a zero cannot.
      problem:
        `Only ${decls.length} style rules were readable, under the ${MIN_DECLARATIONS} needed to tell ` +
        `a brand colour from a one-off. The site probably styles itself with JavaScript.`,
    };
  }

  const colors = new Map<string, number>();
  const fonts = new Map<string, number>();
  for (const d of decls) {
    /**
     * Colour-bearing properties only. A bare hex sweep would count the ones inside `background-image`
     * gradients and SVG data URIs, which are illustration rather than brand — and on a site with one
     * big hero image that noise outweighs everything real.
     */
    if (/^(--[\w-]+|color|background(-color)?|border(-\w+)?-color|fill|stroke|outline-color)\s*:/i.test(d)) {
      for (const m of d.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g)) {
        const hex = toHex(m[0]);
        if (hex && !isNeutral(hex)) colors.set(hex, (colors.get(hex) ?? 0) + 1);
      }
    }
    const ff = /^font-family\s*:\s*(.+)$/i.exec(d);
    if (ff) {
      // The first name in the stack is the choice; the rest are fallbacks the brand did not pick.
      const first = ff[1]!.split(",")[0]!.trim().replace(/^["']|["']$/g, "").toLowerCase();
      if (first && !GENERIC.has(first) && !first.startsWith("var(")) {
        fonts.set(first, (fonts.get(first) ?? 0) + 1);
      }
    }
  }

  const top = (m: Map<string, number>) =>
    [...m.entries()]
      // Once is not a brand — it is an illustration, a one-off badge, a third-party embed.
      .filter(([, n]) => n > 1)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, limit)
      .map(([v]) => v);

  const out: MeasuredStyle = { colors: top(colors), fonts: top(fonts), declarations: decls.length };
  if (!out.colors.length) {
    out.problem =
      "The site's CSS is readable but carries no repeated colour with any hue in it — everything is " +
      "black, white and grey. There is nothing here to take as a brand colour.";
  }
  return out;
}

/** One line a founder reads to know we opened their site. Specific, because specificity is the proof. */
export function describeMeasured(m: MeasuredStyle): string {
  if (m.problem) return m.problem;
  const c = m.colors.length ? `${m.colors.length} colour${m.colors.length === 1 ? "" : "s"} (${m.colors.join(", ")})` : "";
  const f = m.fonts.length ? `${m.fonts.join(", ")}` : "";
  return [c, f].filter(Boolean).join(" · ") || "Nothing usable found.";
}
