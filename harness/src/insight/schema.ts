// The ingest schema, and the redaction that runs on arrival.
//
// This is the kernel's OWN copy of the contract in `packages/insight/src/types.ts`, and the
// duplication is deliberate. The kernel ships as a container that does not contain that package —
// but more importantly, an ingest endpoint must treat its client as hostile. Sharing a type with
// the sender makes it feel as though the sender's shape is the truth; it is not. The truth is what
// survives this file.
//
// Everything here is total: no throw, no rejection that depends on a field the caller controls
// being well-formed. A malformed batch is a 400 and a line in nobody's log.
//
// **What is dropped here and never reaches storage:**
//   - `aid`, the anonymous id. Accepted on the wire, discarded at this boundary. Keeping it would
//     make a per-visitor timeline reconstructable, which is the exact thing this feature promises
//     not to hold. Sessions are counted from `$session` markers instead.
//   - `sid`, likewise.
//   - Anything not in the shape below. No passthrough, no `...rest`.
//   - Query strings, fragments and hosts — see `redactPath`.
//   - Props whose key looks like a person or a credential, and props whose value does.
//
// **What is never READ, anywhere in this feature:** the client IP, `x-forwarded-for`, the user
// agent, the referrer, and cookies. Not redacted afterwards — never looked at. Redaction you can
// forget to apply; a header you never read cannot leak.

export const INSIGHT_VERSION = 1;

export const LIMITS = {
  maxEventsPerBatch: 50,
  maxBodyBytes: 64 * 1024,
  maxEventName: 64,
  maxPathLength: 200,
  maxProps: 12,
  maxPropKey: 40,
  maxPropString: 120,
  /** Steps in a declared funnel. Longer than this is a journey map, not a funnel. */
  maxFunnelSteps: 20,
  /**
   * Distinct event names / paths / steps carried into a summary. Everything past it is bucketed as
   * `__other`.
   *
   * Storage is already bounded per row — a batch holds at most `maxEventsPerBatch` events, so at
   * most that many distinct names. This cap is about the READ: a product looping `track(uuid())`
   * would otherwise make the rollup a million-key object that the summary serialises in full and
   * hands to a model with a context window. The names are still counted; they just collapse into
   * one bucket, which is also the honest report — "you emit unbounded event names" is the finding.
   */
  maxCardinalityPerDay: 200,
} as const;

export type PropValue = string | number | boolean | null;

export interface NormalEvent {
  name: string;
  path?: string;
  step?: string;
  props?: Record<string, PropValue>;
}

export interface NormalBatch {
  funnel?: string;
  /**
   * The funnel's ordered steps, when this batch carried the declaration. Only meaningful alongside
   * `funnel`; a step list with no funnel name has nothing to be the order OF, and is dropped.
   */
  funnelSteps?: string[];
  events: NormalEvent[];
}

export type Normalised = { ok: true; batch: NormalBatch } | { ok: false; status: 400 | 413; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const LONG_HEX = /^[0-9a-f]{16,}$/i;
const NUMERIC = /^\d+$/;
const OPAQUE = /^[A-Za-z0-9_-]{20,}$/;
const EMAILISH = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const JWT = /^ey[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./;

/** Mirrors `packages/insight/src/redact.ts`. Kept in step by the tests on both sides. */
const SENSITIVE_KEY =
  /(^|_|\b)(e?mail|name|first|last|full|user|phone|tel|mobile|address|street|city|postcode|postal|zip|country|dob|birth|age|gender|password|passwd|pwd|secret|token|api_?key|key|auth|session|cookie|otp|code|pin|ssn|nino|nhs|card|cvv|iban|sort_?code|account|routing|q|query|search|term|message|note|comment|content|body|text|description|reason|answer|input|value|file|upload|photo|image|url|href|link|referrer|ip|lat|lon|latitude|longitude|geo|coords?)($|_|\b)/i;

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function maskSegment(seg: string): string {
  const d = safeDecode(seg);
  if (EMAILISH.test(d)) return ":email";
  if (NUMERIC.test(d)) return ":id";
  if (UUID.test(d) || ULID.test(d) || LONG_HEX.test(d)) return ":id";
  if (OPAQUE.test(d) && (d.length >= 32 || (/[A-Z]/.test(d) && /[0-9]/.test(d)))) return ":token";
  return d.slice(0, 40);
}

/**
 * Path only. Never a URL.
 *
 * The rule the marketing site's analytics component already documents: a magic sign-in link is a
 * credential that lives in a query string, so capturing a full URL captures a working login. This
 * runs even though the client ran it too — the client is code an attacker controls.
 */
export function redactPath(input: unknown): string {
  if (typeof input !== "string" || !input) return "/";
  let path = input;
  const schemeless = path.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  if (schemeless !== path) {
    const slash = schemeless.indexOf("/");
    path = slash === -1 ? "/" : schemeless.slice(slash);
  }
  path = (path.split("?")[0] ?? "/").split("#")[0] ?? "/";
  if (!path.startsWith("/")) path = `/${path}`;
  const segments = path.split("/").filter(Boolean);
  const out = `/${segments.slice(0, 8).map(maskSegment).join("/")}${segments.length > 8 ? "/…" : ""}`;
  return out.slice(0, LIMITS.maxPathLength) || "/";
}

export function redactName(value: unknown, max = LIMITS.maxEventName): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim().toLowerCase().replace(/[^a-z0-9_$.:-]/g, "_").slice(0, max).replace(/^_+|_+$/g, "");
  return clean || null;
}

export function redactPropValue(value: unknown): PropValue | undefined {
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const s = value.trim();
  if (!s) return undefined;
  if (EMAILISH.test(s) || JWT.test(s) || LONG_HEX.test(s)) return undefined;
  if (OPAQUE.test(s) && (s.length >= 32 || (/[A-Z]/.test(s) && /[0-9]/.test(s)))) return undefined;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || s.startsWith("/")) return redactPath(s);
  return s.slice(0, LIMITS.maxPropString);
}

export function redactProps(props: unknown): Record<string, PropValue> | undefined {
  if (!props || typeof props !== "object" || Array.isArray(props)) return undefined;
  const out: Record<string, PropValue> = {};
  let n = 0;
  for (const rawKey of Object.keys(props as Record<string, unknown>).sort()) {
    if (n >= LIMITS.maxProps) break;
    const key = rawKey.trim().toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, LIMITS.maxPropKey);
    if (!key || SENSITIVE_KEY.test(key)) continue;
    const v = redactPropValue((props as Record<string, unknown>)[rawKey]);
    if (v === undefined) continue;
    out[key] = v;
    n++;
  }
  return n > 0 ? out : undefined;
}

/**
 * Parse and clean one batch. Fails CLOSED at every branch: unknown version, wrong shape, too many
 * events, nothing usable left after redaction — all refusals, none of them "accept what we can".
 *
 * The one exception is per-event: an individual malformed event is skipped rather than failing the
 * whole batch, because one bad `track()` call in a founder's product would otherwise silently
 * discard the twenty good events batched alongside it.
 */
export function normaliseBatch(raw: unknown): Normalised {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, status: 400, error: "malformed body" };
  const b = raw as Record<string, unknown>;
  if (b.v !== INSIGHT_VERSION) return { ok: false, status: 400, error: "unsupported schema version" };
  if (!Array.isArray(b.events)) return { ok: false, status: 400, error: "events must be an array" };
  if (b.events.length === 0) return { ok: false, status: 400, error: "empty batch" };
  if (b.events.length > LIMITS.maxEventsPerBatch) return { ok: false, status: 413, error: "batch too large" };

  // Note what is NOT read from the body: `project_id` in any spelling. The project comes from the
  // signature on the ingest key and from nowhere else. A body field named `project_id` is ignored
  // here as thoroughly as a field named `banana`.
  const funnel = redactName(b.f, 64) ?? undefined;

  // The declared step order, when this batch carried it. Redacted like any other identifier and
  // de-duplicated, because a repeated step would make the drop-off maths compare a step with
  // itself. Dropped entirely without a funnel name, and dropped entirely below two steps — a
  // one-step "funnel" has no transition, so there is nothing it could tell anyone.
  let funnelSteps: string[] | undefined;
  if (funnel && Array.isArray(b.fs)) {
    const seen = new Set<string>();
    for (const raw of b.fs.slice(0, LIMITS.maxFunnelSteps)) {
      const step = redactName(raw);
      if (!step || seen.has(step)) continue;
      seen.add(step);
    }
    if (seen.size >= 2) funnelSteps = [...seen];
  }

  const events: NormalEvent[] = [];
  for (const item of b.events) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const e = item as Record<string, unknown>;
    const name = redactName(e.n);
    if (!name) continue;
    const out: NormalEvent = { name };
    if (e.p !== undefined) out.path = redactPath(e.p);
    const step = redactName(e.s);
    if (step) out.step = step;
    const props = redactProps(e.props);
    if (props) out.props = props;
    events.push(out);
  }
  if (events.length === 0) return { ok: false, status: 400, error: "no usable events" };
  return { ok: true, batch: { ...(funnel ? { funnel } : {}), ...(funnelSteps ? { funnelSteps } : {}), events } };
}
