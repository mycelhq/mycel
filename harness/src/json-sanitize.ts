// Postgres `jsonb` (and `text`) reject a NUL byte (U+0000) and choke on lone UTF-16 surrogates with
// `unsupported Unicode escape sequence` / `invalid byte sequence`. A model's output can carry either:
// books-keeper monthly_close failed a real run this way when gpt-4o emitted a stray U+0000 in its
// close notes and the JSONB write of the case data threw, killing an otherwise-good close.
//
// This is the single sanitize boundary: strip NUL bytes and unpaired surrogates from every string
// before it is serialized into a jsonb/text column. It NEVER changes well-formed content — only the
// bytes Postgres cannot store — so the delivery survives instead of the whole run dying on a byte.

const NUL = /\u0000/g;
const LONE_HIGH_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g;
const LONE_LOW_SURROGATE = /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Remove NUL characters and lone (unpaired) UTF-16 surrogates from a string. */
export function sanitizeStringForDb(s: string): string {
  return s
    .replace(NUL, "")
    // Replace lone surrogates with U+FFFD, leaving valid surrogate PAIRS (real emoji) untouched.
    .replace(LONE_HIGH_SURROGATE, "�")
    .replace(LONE_LOW_SURROGATE, "�");
}

/** Deep-sanitize any JSON-serializable value so it is safe to write into a Postgres jsonb column. */
export function sanitizeForDb<T>(value: T): T {
  if (typeof value === "string") return sanitizeStringForDb(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => sanitizeForDb(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[sanitizeStringForDb(k)] = sanitizeForDb(v);
    }
    return out as unknown as T;
  }
  return value;
}

/** `JSON.stringify` with the jsonb-hostile bytes stripped first — the write boundary helper. */
export function stringifyForDb(value: unknown): string {
  return JSON.stringify(sanitizeForDb(value));
}
