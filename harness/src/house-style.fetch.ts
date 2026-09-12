import { type MeasuredStyle, measureStyle } from "./house-style.measure";

/**
 * GOING AND GETTING THE BYTES.
 *
 * Split from `house-style.measure.ts` so the measurement stays PURE and can be tested exhaustively
 * without a network — the same split `lib/offering.rule.ts` uses in cloud, and the property
 * `file-shape.ts` and `design-lint.ts` both hold. A test asserts the measuring half contains no
 * `fetch`, no `await` and no model call; that assertion is only meaningful while the two are apart.
 *
 * Deliberately dumb: fetch the page, find the stylesheets it links, fetch
 * those, hand the concatenation to `measureStyle`. No browser, no JavaScript execution, no model.
 *
 * WHAT THAT COSTS, STATED RATHER THAN HIDDEN: a site that styles itself at runtime returns a shell,
 * and `measureStyle` says so in words instead of returning an empty palette that reads like "your
 * brand has no colours". That is the honest failure and it is common — which is why the sentence
 * names JavaScript as the likely cause rather than blaming the reader.
 */

/** Big enough for a real site's CSS, small enough that a hostile one cannot exhaust the worker. */
const MAX_CSS_BYTES = 2_000_000;
const MAX_SHEETS = 8;

export interface FetchedStyle extends MeasuredStyle {
  /** Where this was read from, after redirects. Shown to the founder — a claim needs a source. */
  url?: string;
  /** How many stylesheets were read. Part of "we actually opened it". */
  sheets?: number;
}

/**
 * Normalise what a founder typed into something fetchable, or refuse.
 *
 * `https` is forced rather than defaulted: a founder typing `example.com` means their website, and
 * following that to `http://` would let a network-level attacker choose the CSS we then treat as
 * this firm's brand. A site that is genuinely http-only is a site we decline to read.
 */
export function siteUrl(raw: string | undefined): string | undefined {
  const t = String(raw ?? "").trim();
  if (!t) return undefined;
  const withScheme = /^https?:\/\//i.test(t) ? t.replace(/^http:/i, "https:") : `https://${t}`;
  try {
    const u = new URL(withScheme);
    /**
     * PUBLIC HOSTS ONLY. Without this the field is a server-side request forgery hole with a
     * friendly label: a founder — or anyone who can set that field — types `http://169.254.169.254`
     * and the worker fetches cloud instance metadata on their behalf.
     */
    const h = u.hostname.toLowerCase();
    if (
      !h.includes(".") ||
      h === "localhost" ||
      /^(\d+\.){3}\d+$/.test(h) ||
      /^\[?::1\]?$/.test(h) ||
      h.endsWith(".internal") ||
      h.endsWith(".local")
    ) {
      return undefined;
    }
    return u.toString();
  } catch {
    return undefined;
  }
}

/**
 * Fetch a site and measure what it wears.
 *
 * Never throws. Every failure comes back as a `problem` sentence, because this runs behind a founder
 * looking at a screen and a stack trace is not something they can act on.
 */
export async function measureSite(
  raw: string | undefined,
  fetcher: (url: string) => Promise<{ ok: boolean; body: string; url?: string }>,
): Promise<FetchedStyle> {
  const url = siteUrl(raw);
  if (!url) {
    return { colors: [], fonts: [], declarations: 0, problem: "That does not look like a public website address." };
  }
  let page: { ok: boolean; body: string; url?: string };
  try {
    page = await fetcher(url);
  } catch {
    return { colors: [], fonts: [], declarations: 0, url, problem: "We could not reach that site." };
  }
  if (!page.ok || !page.body) {
    return { colors: [], fonts: [], declarations: 0, url, problem: "We could not read anything at that address." };
  }

  const base = page.url ?? url;
  let css = "";
  // Inline first: a small site frequently has its whole brand in one `<style>` block.
  for (const m of page.body.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) css += (m[1] ?? "") + "\n";

  const hrefs: string[] = [];
  for (const m of page.body.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/rel\s*=\s*["']?[^"'>]*stylesheet/i.test(tag)) continue;
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!href) continue;
    try {
      const abs = new URL(href, base).toString();
      if (/^https:/i.test(abs) && !hrefs.includes(abs)) hrefs.push(abs);
    } catch {
      /* a malformed href is one sheet, not a failure */
    }
  }

  let sheets = 0;
  for (const href of hrefs.slice(0, MAX_SHEETS)) {
    if (css.length > MAX_CSS_BYTES) break;
    try {
      const r = await fetcher(href);
      if (r.ok && r.body) {
        css += r.body.slice(0, MAX_CSS_BYTES) + "\n";
        sheets++;
      }
    } catch {
      /* one unreachable sheet is not a failed reading */
    }
  }

  return { ...measureStyle(css.slice(0, MAX_CSS_BYTES)), url: base, sheets };
}
