// A small, dependency-free validator for task output against a wedge's output_schema (a JSON
// Schema subset: type, required, properties, enum, items, minItems, if/then). Enough to make output.validated an
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
/**
 * ═══ A HYPHEN COST A CLIENT THEIR ENTIRE MONTHLY CLOSE ═══
 *
 * The run reconciled sixteen transactions to the penny and wrote a complete profit and loss —
 * revenue, expenses, net, and a nine-line category breakdown. It put it under `profit-and-loss`.
 * The schema declares `profit_and_loss`. Nothing rejected it: the field is not `required` and the
 * schema sets no `additionalProperties`, so validation passed, and the work was then withheld by
 * the ship bar with "this work promises `profit_and_loss` and delivered it empty" — while a correct
 * P&L sat in the output under a key one character different.
 *
 * That message is also a lie, and the founder reading it would go looking for an empty field.
 *
 * So the keys are canonicalised against the schema BEFORE anything judges them. This is not
 * guessing: it renames a key only when it differs from a declared field by separators or case
 * alone, only when the declared field is absent, and only when EXACTLY ONE key in the object
 * matches it that way. Two candidates, or a declared field already present, and nothing moves —
 * ambiguity is the one thing worse than the hyphen.
 *
 * Not a lint on the model. `profit-and-loss`, `profitAndLoss` and `Profit_And_Loss` are the same
 * field to any reader, and a system that discards a month of correct work over which one came out
 * is not strict, it is brittle.
 */
export function canonicaliseKeys(value: unknown, schema: unknown): unknown {
  if (!schema || typeof schema !== "object") return value;
  const s = schema as Record<string, unknown>;

  if (Array.isArray(value)) {
    const items = s.items;
    return items ? value.map((v) => canonicaliseKeys(v, items)) : value;
  }
  if (!value || typeof value !== "object") return value;

  const props = s.properties as Record<string, unknown> | undefined;
  const obj = { ...(value as Record<string, unknown>) };
  if (props) {
    const norm = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, "");
    for (const declared of Object.keys(props)) {
      if (declared in obj) continue;
      const target = norm(declared);
      const matches = Object.keys(obj).filter((k) => norm(k) === target);
      if (matches.length !== 1) continue; // Ambiguous, or nothing to rename.
      obj[declared] = obj[matches[0]!];
      delete obj[matches[0]!];
    }
    for (const [k, sub] of Object.entries(props)) {
      if (k in obj) obj[k] = canonicaliseKeys(obj[k], sub);
    }
  }
  return obj;
}

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
    // Before anything judges it. See `canonicaliseKeys` — a `profit-and-loss` that should be
    // `profit_and_loss` is the same field, and validating the raw spelling means the rest of the
    // system reasons about an output that is missing a field it actually has.
    value = canonicaliseKeys(value, schema);
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
    const required = new Set((s.required as string[] | undefined) ?? []);
    for (const [k, sub] of Object.entries(props)) {
      /**
       * `null` on an OPTIONAL field means the same thing as leaving it out: not known.
       *
       * A bank export is where this bites. A close was refused at the door for
       * `transactions[11].counterparty: expected string, got null` — a card payment with no
       * merchant name on it, which is the most ordinary row in any statement and precisely the one
       * the close exists to flag. Every CSV-to-JSON path in the product emits null for a blank cell,
       * so the strict reading meant either the caller strips nulls before posting, or it substitutes
       * `""` or `"unknown"` — and `"unknown"` becomes a category, lands in the P&L, and is worse
       * than the blank it replaced.
       *
       * Required fields are unchanged: a null `period` is still a close of nothing.
       */
      if (!required.has(k) && obj[k] === null) continue;
      if (k in obj) check(obj[k], sub, `${path}.${k}`, errors);
    }
  }

  if (type === "array" && s.items) {
    for (let i = 0; i < (value as unknown[]).length; i++) {
      check((value as unknown[])[i], s.items, `${path}[${i}]`, errors);
    }
  }

  /**
   * `minItems`, and it only means anything next to `if`/`then` below.
   *
   * Added with the conditional because "this list must not be empty" is never an unconditional
   * truth about a task's output — an empty list is the correct answer most of the time. It is the
   * COMBINATION that is worth expressing.
   */
  if (type === "array" && typeof s.minItems === "number" && (value as unknown[]).length < s.minItems) {
    errors.push(`${path}: needs at least ${s.minItems} item${s.minItems === 1 ? "" : "s"}`);
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════════════
   * `if` / `then` — A REQUIREMENT THAT DEPENDS ON ANOTHER ANSWER
   * ═══════════════════════════════════════════════════════════════════════════════════════════════
   *
   * The subset here was type/required/properties/enum/items, and none of those can express the rule
   * that actually mattered: `draft_shape` answers `runs_as.fit: "none"` — nothing we ship is this
   * business's work — and `runs_as.to_author` is the list of services to write for them. Nothing
   * could require the second when the first was true, so "we cannot run your business, and here is
   * nothing to do about it" was a schema-clean answer. Twelve production shapes said `none`; NINE
   * proposed nothing.
   *
   * I first wrote this as a `ship_checks` entry, which was dead twice over: the manifest key is
   * `ship_checks` and I wrote `checks`, and `client-ready.ts` only evaluates checks for task types
   * that declare `ship_requires` — which is for CLIENT-FACING jobs, and shaping a business is not
   * one. The schema is the enforcement a decide task actually has.
   *
   * AND IT IS A RETRY, NOT A FAILURE, which is the whole reason this is the right layer.
   * `runtime.ts` polls `output/result.txt` and ends the run the moment it validates; an answer that
   * does not validate simply does not finish the run, so the agent keeps working within its eight
   * steps. The founder gets a better answer rather than an error.
   *
   * DELIBERATELY NARROW. `if` is evaluated for its own errors only — no `else`, no nesting beyond
   * what `check` already does — because a validator nobody can predict is worse than one that
   * cannot express everything. If the `if` matches, `then` is applied to the same value.
   */
  if (s.if && s.then) {
    const probe: string[] = [];
    check(value, s.if, path, probe);
    if (probe.length === 0) check(value, s.then, path, errors);
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
