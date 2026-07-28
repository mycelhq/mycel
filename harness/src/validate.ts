// A small, dependency-free validator for task output against a wedge's output_schema (a JSON
// Schema subset: type, required, properties, enum, items). Enough to make output.validated an
// honest signal — not a hardcoded { ok: true }. Not a full JSON Schema implementation.
export interface ValidationResult {
  ok: boolean;
  value?: unknown;
  errors: string[];
}

/** Validate raw agent output (text, ideally JSON) against a schema. Returns parsed value + errors. */
export function validateOutput(raw: string, schema: unknown): ValidationResult {
  if (!schema || typeof schema !== "object") return { ok: true, value: raw, errors: [] };

  // Try to parse JSON; tolerate a fenced ```json block or surrounding prose.
  let value: unknown = raw;
  const s = String(raw).trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  const candidate = fenced ? fenced[1].trim() : s;
  try {
    value = JSON.parse(candidate);
  } catch {
    // Non-JSON. Only an error if the schema actually expects structure.
    const t = (schema as { type?: unknown }).type;
    if (t && t !== "string") return { ok: false, value: raw, errors: [`expected ${String(t)} JSON, got non-JSON text`] };
    return { ok: true, value: raw, errors: [] };
  }

  const errors: string[] = [];
  check(value, schema, "$", errors);
  return { ok: errors.length === 0, value, errors };
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
