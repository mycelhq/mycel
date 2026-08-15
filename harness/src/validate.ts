// A small, dependency-free validator for task output against a wedge's output_schema (a JSON
// Schema subset: type, required, properties, enum, items). Enough to make output.validated an
// honest signal — not a hardcoded { ok: true }. Not a full JSON Schema implementation.
export interface ValidationResult {
  ok: boolean;
  value?: unknown;
  errors: string[];
}

/**
 * Validate raw agent output (text, ideally JSON) against a schema. Returns parsed value + errors.
 *
 * ═══ WHY EXTRACTION IS MORE THAN A TRIM ═══
 *
 * The value handed here is the agent's FINAL ASSISTANT MESSAGE (runtime.ts), and a chat model
 * writing to a human writes like one: "Here's the shape of your business:" before the object, or a
 * "Let me know if you'd like to adjust anything." after it. Structured output is deliberately not
 * used (see the comments in runtime.ts / harness.ts / opencode.ts — the pinned OpenCode's synthetic
 * StructuredOutput tool hid the answer entirely, 0% success over five signups), so prose around the
 * JSON is a NORMAL, expected model behaviour rather than a malfunction.
 *
 * This used to be trim + one fenced-block regex, so an unfenced object with a one-line preamble
 * failed outright with `expected object JSON, got non-JSON text`. There is no retry at any layer,
 * so that failure landed on the founder's very FIRST action after signup — describing their
 * business — and it landed intermittently, which is worse: the same text resubmitted succeeded.
 * Observed in production 2026-08-10.
 *
 * The fix is extraction only. Candidates are tried in order and the first one that BOTH parses AND
 * satisfies the schema wins; nothing about the schema check is loosened, and if no candidate parses
 * the same error shape comes back as before. Fails closed.
 */
export function validateOutput(raw: string, schema: unknown): ValidationResult {
  if (!schema || typeof schema !== "object") return { ok: true, value: raw, errors: [] };

  const s = String(raw).trim();
  const expected = (schema as { type?: unknown }).type;

  // The first candidate that parses at all, kept so a genuine SCHEMA failure still reports schema
  // errors rather than being downgraded to "not JSON" by a later candidate that never parsed.
  let firstParsed: { value: unknown; errors: string[] } | undefined;

  for (const candidate of jsonCandidates(s, expected)) {
    let value: unknown;
    try {
      value = JSON.parse(candidate);
    } catch {
      continue;
    }
    const errors: string[] = [];
    check(value, schema, "$", errors);
    if (errors.length === 0) return { ok: true, value, errors: [] };
    firstParsed ??= { value, errors };
  }

  if (firstParsed) return { ok: false, value: firstParsed.value, errors: firstParsed.errors };

  // Nothing parsed. Only an error if the schema actually expects structure.
  if (expected && expected !== "string") {
    return { ok: false, value: raw, errors: [`expected ${String(expected)} JSON, got non-JSON text`] };
  }
  return { ok: true, value: raw, errors: [] };
}

/**
 * Validate an ALREADY-PARSED value against a schema, with no text extraction. Returns the schema
 * errors (empty means valid).
 *
 * The extraction in `validateOutput` is for model prose; once a candidate has been carved out and
 * parsed — or built by the repair pass in repair.ts — the only question left is whether the VALUE
 * satisfies the schema. Sharing `check` here keeps the two answers to that question identical, so a
 * value repair.ts believes it fixed cannot then be rejected by a subtly different validator.
 */
export function validateValue(value: unknown, schema: unknown): string[] {
  if (!schema || typeof schema !== "object") return [];
  const errors: string[] = [];
  check(value, schema, "$", errors);
  return errors;
}

/**
 * Every parseable JSON value inside a model answer, most-likely first. Extraction ONLY — no schema
 * check — so the repair pass can reach a near-miss object that `validateOutput` parsed but rejected,
 * rather than re-deriving the same fragile carving of prose a second time.
 */
export function jsonValues(raw: string, schema: unknown): unknown[] {
  const expected = (schema as { type?: unknown } | null)?.type;
  const out: unknown[] = [];
  for (const candidate of jsonCandidates(String(raw).trim(), expected)) {
    try {
      out.push(JSON.parse(candidate));
    } catch {
      // Not JSON — the next candidate might be.
    }
  }
  return out;
}

/** How many balanced slices to pull out of one message before giving up. Generous, and bounded. */
const MAX_SLICES = 5;

/**
 * Candidate JSON texts inside a model answer, most-likely first.
 *
 * Order matters and is deliberate: a fenced block is an explicit "this is the answer" from the
 * model, the whole string is what a well-behaved answer looks like (and is what this function used
 * to accept exclusively), and only then do we start carving balanced slices out of prose.
 */
function* jsonCandidates(s: string, expected: unknown): Generator<string> {
  const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (let m = fence.exec(s); m; m = fence.exec(s)) {
    const inner = m[1].trim();
    if (inner) yield inner;
  }

  yield s;

  // Slicing is only safe when the schema expects a structure to slice. For a `string` schema the
  // whole message IS the answer, and cutting an object out of a sentence that merely mentions one
  // would silently replace a founder's prose with a fragment of it.
  if (expected !== "object" && expected !== "array") return;

  let from = 0;
  for (let n = 0; n < MAX_SLICES; n++) {
    const slice = balancedSlice(s, from);
    if (!slice) return;
    yield s.slice(slice.start, slice.end);
    from = slice.end;
  }
}

/**
 * The first brace/bracket at or after `from`, paired with its MATCHING close.
 *
 * String-aware on purpose: `{"note":"we close at 5pm }"}` and `{"q":"say \"hi\""}` both contain
 * characters that a naive depth counter (or a lastIndexOf("}")) reads as structure. Getting either
 * wrong turns a valid answer into a parse failure — the exact class of bug this whole function
 * exists to stop.
 */
function balancedSlice(s: string, from: number): { start: number; end: number } | null {
  const brace = s.indexOf("{", from);
  const bracket = s.indexOf("[", from);
  const start = brace === -1 ? bracket : bracket === -1 ? brace : Math.min(brace, bracket);
  if (start === -1) return null;

  const open = s[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return { start, end: i + 1 };
    }
  }
  // Unterminated — a truncated answer. Skip past this opener so a later, complete structure in the
  // same message can still be found, rather than rescanning the same broken one forever.
  return { start, end: start + 1 };
}

function check(value: unknown, schema: unknown, path: string, errors: string[]): void {
  if (!schema || typeof schema !== "object") return;
  const s = schema as Record<string, unknown>;

  if (Array.isArray(s.enum) && !s.enum.some((e) => e === value)) {
    errors.push(`${path}: not one of ${JSON.stringify(s.enum)}`);
  }

  const type = s.type as string | undefined;
  if (type && !typeMatches(value, type)) {
    errors.push(`${path}: expected ${type}, got ${jsType(value)}`);
    return; // downstream checks assume the type held
  }

  if (type === "object" || (!type && s.properties)) {
    const obj = (value ?? {}) as Record<string, unknown>;
    for (const req of (s.required as string[] | undefined) ?? []) {
      if (!(req in obj)) errors.push(`${path}.${req}: required`);
    }
    const props = (s.properties as Record<string, unknown> | undefined) ?? {};
    for (const [k, sub] of Object.entries(props)) {
      if (k in obj) check(obj[k], sub, `${path}.${k}`, errors);
    }
  }

  if (type === "array" && s.items) {
    for (let i = 0; i < (value as unknown[]).length; i++) {
      check((value as unknown[])[i], s.items, `${path}[${i}]`, errors);
    }
  }
}

function typeMatches(v: unknown, type: string): boolean {
  switch (type) {
    case "object":
      return typeof v === "object" && v !== null && !Array.isArray(v);
    case "array":
      return Array.isArray(v);
    case "string":
      return typeof v === "string";
    case "number":
      return typeof v === "number";
    case "integer":
      return typeof v === "number" && Number.isInteger(v);
    case "boolean":
      return typeof v === "boolean";
    case "null":
      return v === null;
    default:
      return true;
  }
}

function jsType(v: unknown): string {
  if (Array.isArray(v)) return "array";
  if (v === null) return "null";
  return typeof v;
}
