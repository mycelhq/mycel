/**
 * Redaction. The single most important file in this package.
 *
 * A founder's product runs on THEIR customers' data — intake forms, addresses, symptoms, invoices,
 * whatever the service happens to be. An analytics SDK that ships in that product is a hose pointed
 * at our database, and the only thing standing between "we measure the funnel" and "we quietly
 * became a data processor for material we never asked for" is this file.
 *
 * Three rules, in the order they matter:
 *
 * 1. **Paths, never URLs.** `landing/components/analytics.tsx` already holds this line for the
 *    marketing site, and the reason is not hypothetical: a magic sign-in link is a URL whose QUERY
 *    STRING is a credential. Capture `location.href` on the page that link lands on and you have
 *    posted a working login to an analytics endpoint, where it sits in a database, in a log, and in
 *    whatever the retention policy turns out to actually be. So: `location.pathname` only, and
 *    even then id-shaped segments are masked, because `/orders/7f3a…` identifies a person to anyone
 *    who can also read the orders table.
 *
 * 2. **Never form contents.** Not truncated, not hashed — absent. The key filter below is a
 *    DENYLIST on purpose (an allowlist would be safer but would make the package unusable without a
 *    schema per product), so it errs wide: anything that smells like a person, a credential, or
 *    free text is dropped rather than shortened.
 *
 * 3. **Redact at the edge AND at the ingest.** Everything here runs client-side, and the kernel
 *    runs its own copy again on arrival. The client's pass is a courtesy to the network; the
 *    server's pass is the one that is actually load-bearing, because the client is code a founder
 *    can edit and a browser is a thing an attacker controls.
 */
import { LIMITS, type InsightPropValue } from "./types";

/** UUID, ULID, long hex, long opaque token — anything that identifies one row to whoever holds it. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const LONG_HEX = /^[0-9a-f]{16,}$/i;
const NUMERIC = /^\d+$/;
const OPAQUE = /^[A-Za-z0-9_-]{20,}$/;
const EMAILISH = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const JWT = /^ey[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./;

/**
 * Keys whose VALUE is never worth having.
 *
 * Read this as "the answer to 'could this hold something a customer typed, or something that
 * authenticates them?' is not a confident no". `q` and `search` are in there because a search box
 * is a form field; `code` because a one-time code is a credential; `name` because it is the single
 * most common way a real name ends up somewhere it shouldn't.
 */
const SENSITIVE_KEY =
  /(^|_|\b)(e?mail|name|first|last|full|user|phone|tel|mobile|address|street|city|postcode|postal|zip|country|dob|birth|age|gender|password|passwd|pwd|secret|token|api_?key|key|auth|session|cookie|otp|code|pin|ssn|nino|nhs|card|cvv|iban|sort_?code|account|routing|q|query|search|term|message|note|comment|content|body|text|description|reason|answer|input|value|file|upload|photo|image|url|href|link|referrer|ip|lat|lon|latitude|longitude|geo|coords?)($|_|\b)/i;

/** True when this prop key must not be collected at all. Exported so tests can pin the list. */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

/** One path segment, masked if it identifies a row rather than a page. */
function maskSegment(seg: string): string {
  if (!seg) return seg;
  const decoded = safeDecode(seg);
  if (EMAILISH.test(decoded)) return ":email";
  if (NUMERIC.test(decoded)) return ":id";
  if (UUID.test(decoded) || ULID.test(decoded) || LONG_HEX.test(decoded)) return ":id";
  if (OPAQUE.test(decoded)) return ":token";
  // A real page name. Truncated because a route someone generated from user input ("/thanks-jane")
  // is a shape this can't detect, and a long segment is the tell.
  return decoded.slice(0, 40);
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    // Malformed percent-encoding. Keep the raw form; it is still going through the maskers below.
    return s;
  }
}

/**
 * A URL or path in, a safe path out.
 *
 * Accepts a full URL deliberately: the calling code should never HAVE a full URL, but the one time
 * it does — a founder passing `window.location.href` because that is the obvious thing to pass —
 * this must strip it rather than store it. Failing safe beats being right about the caller.
 */
export function redactPath(input: string | null | undefined): string {
  if (!input) return "/";
  let path = String(input);
  // Strip scheme + host if a whole URL arrived. Not `new URL()` — it throws on relative input and
  // this function must never throw on the analytics path.
  const schemeless = path.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  if (schemeless !== path) {
    const slash = schemeless.indexOf("/");
    path = slash === -1 ? "/" : schemeless.slice(slash);
  }
  // Query and hash, gone before anything else looks at them. This is rule 1.
  path = path.split("?")[0] ?? "/";
  path = path.split("#")[0] ?? "/";
  if (!path.startsWith("/")) path = `/${path}`;

  const segments = path.split("/").filter((s) => s.length > 0);
  // A path deeper than this is a crawler or a mistake; either way the tail is not informative.
  const kept = segments.slice(0, 8).map(maskSegment);
  const truncated = segments.length > 8;
  const out = `/${kept.join("/")}${truncated ? "/…" : ""}`;
  return out.slice(0, LIMITS.maxPathLength) || "/";
}

/** Event names are identifiers, not content: `[a-z0-9_$.:-]`, lowercased, capped. */
export function redactEventName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const clean = name.trim().toLowerCase().replace(/[^a-z0-9_$.:-]/g, "_").slice(0, LIMITS.maxEventName);
  return clean.replace(/^_+|_+$/g, "") || null;
}

/**
 * One prop value, or `undefined` to drop it.
 *
 * Numbers and booleans pass (a count, a price band, a boolean flag — the useful cases). Strings are
 * where the danger lives, so they are checked against every credential and identity shape we know
 * and truncated hard afterwards. `null` passes because "this was explicitly absent" is information.
 */
export function redactPropValue(value: unknown): InsightPropValue | undefined {
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined; // objects, arrays, functions, undefined: dropped
  const s = value.trim();
  if (!s) return undefined;
  if (EMAILISH.test(s)) return undefined;
  if (JWT.test(s)) return undefined;
  if (LONG_HEX.test(s)) return undefined;
  if (looksOpaque(s)) return undefined;
  // Anything URL-shaped becomes a path — a prop is not a smarter place to keep a query string than
  // the pageview was.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || s.startsWith("/")) return redactPath(s);
  return s.slice(0, LIMITS.maxPropString);
}

/**
 * Does this string look like a generated token rather than a word a human chose?
 *
 * The naive test — "20+ chars of [A-Za-z0-9_-]" — also eats `residential_deep_clean`, which is
 * exactly the kind of prop this package exists to collect. So entropy is approximated instead:
 * a long string that MIXES case and digits is a key, an id or a token; a long string that doesn't
 * is a slug someone wrote. Anything past 32 characters is treated as opaque regardless, because a
 * prop that long is not a category.
 */
function looksOpaque(s: string): boolean {
  if (!OPAQUE.test(s)) return false;
  if (s.length >= 32) return true;
  return /[A-Z]/.test(s) && /[0-9]/.test(s);
}

/** The whole props bag: keys filtered, values scrubbed, count capped, order made deterministic. */
export function redactProps(props: unknown): Record<string, InsightPropValue> | undefined {
  if (!props || typeof props !== "object" || Array.isArray(props)) return undefined;
  const out: Record<string, InsightPropValue> = {};
  let n = 0;
  for (const rawKey of Object.keys(props as Record<string, unknown>).sort()) {
    if (n >= LIMITS.maxProps) break;
    const key = rawKey.trim().toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, LIMITS.maxPropKey);
    if (!key || isSensitiveKey(key)) continue;
    const value = redactPropValue((props as Record<string, unknown>)[rawKey]);
    if (value === undefined) continue;
    out[key] = value;
    n++;
  }
  return n > 0 ? out : undefined;
}
