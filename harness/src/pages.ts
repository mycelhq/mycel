// Public unlisted pages: the URL a client opens on their phone.
//
// ═══ WHY THIS EXISTS ═══
//
// Fulfillment that ships HTML as a file the inspector iframes is a preview of work, not the work.
// An SEO retainer is a page they can send someone. That page has to live at an https URL, not
// inside `srcdoc` with `sandbox=""`.
//
// ═══ WHY THIS IS NOT ARTIFACT PREVIEW ═══
//
// `artifact-preview.ts` will never serve customer HTML as `text/html` from the authenticated
// kernel origin — that is stored XSS against the founder's session. Downloads force attachment
// and rewrite HTML to octet-stream for the same reason. This module is a different door: an
// unguessable token, a route that is not under `/v1`, CSP that forbids script, and HTML that
// has already been stripped of executable tags. The inspector still never serves HTML as a
// document. The client opens `/p/:token`.
//
// Tokens are capability URLs, not secrets hashed at rest. A leaked database lists unreleased
// pages. That is the unlisted-link contract, same as a staging URL. Do not add a listing route.
import { randomBytes, randomUUID } from "node:crypto";
import { databaseUrl } from "./config";

const MAX_PAGE_BYTES = 400_000;

/**
 * CSP on every published page. Script is forbidden even if sanitizer misses a tag.
 * JSON-LD stays in the HTML source for crawlers; it does not need to execute.
 */
export const PUBLISHED_PAGE_CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src https: data:",
  "font-src https: data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

export type PublishedPage = {
  id: string;
  token: string;
  project_id: string;
  html: string;
  title: string;
  created_at: string;
};

export type PublishPageInput = {
  project_id: string;
  html: string;
  title?: string;
};

const pages = new Map<string, PublishedPage>();

let pg: import("./pages.pg").PagesPg | null = null;

export async function initPagesStore(): Promise<{ backend: "postgres" | "memory" }> {
  const url = databaseUrl();
  if (!url) return { backend: "memory" };
  const { PagesPg } = await import("./pages.pg");
  pg = await PagesPg.connect(url);
  return { backend: "postgres" };
}

export async function closePagesStore(): Promise<void> {
  await pg?.close().catch(() => {});
  pg = null;
}

/** Test seam. */
export function _resetPages(): void {
  pages.clear();
}

/**
 * Where published pages are advertised to live.
 *
 * `MYCEL_PAGES_URL` is the public host (`https://pages.<domain>` in the cloud stack). Fall back
 * to `MYCEL_PUBLIC_URL` only for self-hosted kernels that expose `/p` on the same origin.
 * Localhost is last resort so a laptop demo still produces a URL a browser can open — wrap will
 * accept loopback http, nothing else. Do not advertise sandbox.<domain>: that host 404s `/p/*`.
 */
export function pagesBaseUrl(): string {
  const env = (process.env.MYCEL_PAGES_URL || process.env.MYCEL_PUBLIC_URL || "").trim().replace(/\/$/, "");
  if (env) return env;
  return `http://127.0.0.1:${process.env.PORT ?? 4000}`;
}

export function publishedPageUrl(token: string): string {
  return `${pagesBaseUrl()}/p/${token}`;
}

/**
 * A URL a client can actually open. https always; http only on loopback so local kernel demos
 * wrap. `http://insecure.test` is not a delivery.
 */
export function isLivePageUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (u.protocol === "https:") return true;
  if (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1")) return true;
  return false;
}

export function looksLikeHtmlPage(html: string): boolean {
  const t = html.trim();
  if (t.length < 400) return false;
  return /<!doctype html/i.test(t) || /<html[\s>]/i.test(t);
}

/**
 * Would a competent GEO agency send this URL to the client as this week's work?
 *
 * `looksLikeHtmlPage` only asks "is this HTML". This asks "is it a commercial page" — header/nav,
 * footer, an extractable table or definition list, FAQ JSON-LD, enough copy that the first two
 * sentences are an opening rather than the entire document. A cream stub with two paragraphs is
 * how we embarrassed a sales meeting; wrap still hosts whatever is valid HTML, but ship_page
 * must not deliver a stub.
 */
export function shippedPageFaults(html: string): string[] {
  const faults: string[] = [];
  if (!looksLikeHtmlPage(html)) return ["not a complete HTML document"];
  if (html.length < 6_000) faults.push("too short to be a page they would put on their domain");
  const withoutLd = html.replace(/<script\b[\s\S]*?<\/script>/gi, " ");
  const text = withoutLd.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (text.length < 1_800) faults.push("almost no visible copy");
  if (!/application\/ld\+json/i.test(html)) faults.push("missing JSON-LD (FAQPage or Organization)");
  if (!/<table\b/i.test(html) && !/<dl\b/i.test(html)) faults.push("no extractable table or definition list");
  if (!/<nav\b/i.test(html) && !/<header\b/i.test(html)) faults.push("no site chrome (header or nav)");
  if (!/<footer\b/i.test(html)) faults.push("no footer");
  if ((html.match(/<h[23]\b/gi) ?? []).length < 3) faults.push("not enough section headings");
  if (!/\d/.test(text.slice(0, 2_400))) faults.push("no checkable number near the top");
  return faults;
}

/**
 * Strip the executable class before the page is stored. CSP is the belt; this is the braces.
 * JSON-LD `<script type="application/ld+json">` stays — crawlers read it as text, it does not run.
 */
export function sanitizePublishedHtml(html: string): string | undefined {
  if (Buffer.byteLength(html, "utf8") > MAX_PAGE_BYTES) return undefined;
  if (!looksLikeHtmlPage(html)) return undefined;

  let out = html;
  out = out.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (full, attrs: string) => {
    if (/\btype\s*=\s*["']application\/ld\+json["']/i.test(attrs)) return full;
    return "";
  });
  out = out.replace(/<iframe\b[\s\S]*?<\/iframe>/gi, "");
  out = out.replace(/<object\b[\s\S]*?<\/object>/gi, "");
  out = out.replace(/<embed\b[^>]*>/gi, "");
  out = out.replace(/<base\b[^>]*>/gi, "");
  out = out.replace(/<meta\b[^>]*http-equiv\s*=\s*(["']?)refresh\1[^>]*>/gi, "");
  out = out.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  out = out.replace(/\b(href|src|xlink:href)\s*=\s*(["'])\s*javascript:[\s\S]*?\2/gi, "$1=$2#$2");

  if (!/name\s*=\s*["']robots["']/i.test(out)) {
    out = out.replace(/<head([^>]*)>/i, `<head$1>\n<meta name="robots" content="noindex,nofollow"/>`);
  }
  return out;
}

export function isPageToken(raw: string): boolean {
  return /^[A-Za-z0-9_-]{16,64}$/.test(raw);
}

export async function publishPage(input: PublishPageInput): Promise<PublishedPage | undefined> {
  const projectId = input.project_id.trim();
  if (!projectId) return undefined;
  const html = sanitizePublishedHtml(input.html);
  if (!html) return undefined;
  const token = randomBytes(18).toString("base64url");
  const page: PublishedPage = {
    id: randomUUID(),
    token,
    project_id: projectId,
    html,
    title: (input.title ?? "").trim().slice(0, 200),
    created_at: new Date().toISOString(),
  };
  const url = publishedPageUrl(token);
  if (!isLivePageUrl(url)) return undefined;
  pages.set(token, page);
  if (pg) await pg.put(page);
  return page;
}

export async function getPublishedPage(token: string): Promise<PublishedPage | undefined> {
  if (!isPageToken(token)) return undefined;
  const hit = pages.get(token);
  if (hit) return hit;
  if (!pg) return undefined;
  const row = await pg.get(token);
  if (row) pages.set(token, row);
  return row ?? undefined;
}
