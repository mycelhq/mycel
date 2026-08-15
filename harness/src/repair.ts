// Bounded, deterministic recovery of a near-miss structured answer BEFORE it is allowed to fail a
// run. Pure and dependency-free — no model call, no I/O — so the single most important moment in the
// product (a founder describing their business, the flagship first impression) does not blow up on a
// recoverable slip.
//
// ═══ THE PRODUCTION FAILURE THIS FILE EXISTS FOR ═══
//
// Live dogfooding on openai/gpt-5.6-luna: the `business-shaper` / `draft_shape` run came back failing
// validation with `$.sells / $.sells_to / $.runs_as / $.first_job / $.confidence: required` — every
// required field "missing". `orchestrator.ts` validated the final message once and threw, with no
// repair at any layer, so the flagship first screen a founder ever sees hard-failed on a near-miss.
//
// Two things produce that exact error shape, and both are recoverable WITHOUT inventing a single
// business fact:
//
//   1. THE ANSWER IS NESTED. The model wrapped the object in a key — `{"shape": {…}}`,
//      `{"result": {…}}`, `{"business": {…}}`. Every required field IS present, one level down. The
//      honest fix is to unwrap it: no fact is guessed, the data the model produced is simply read
//      from where it put it.
//
//   2. A SOFT-REQUIRED SCALAR IS OMITTED. The model answered the whole business but dropped a field
//      that has a safe default — `confidence`, which the schema now declares `default: "low"`. Erring
//      toward LOW confidence is honest: it under-claims certainty, never over-claims a business fact.
//
// What this file deliberately CANNOT do is fabricate a substantive field. `sells`, `sells_to`,
// `runs_as` and `first_job` carry no schema `default`, so a value truly missing them still fails —
// and that honest failure degrades to the existing "Set it up myself" fallback in the cloud onboarding
// (see cloud/lib/shape.ts `usable()` and `readShape()`). A missing `confidence` must not, and now does
// not, take the whole moment down with it.

import { validateValue, jsonValues } from "./validate";

export interface RepairResult {
  /** The repaired answer, serialised, ready to feed forward as the run's output. */
  text: string;
  /** The repaired value itself. */
  value: unknown;
  /** What the repair did, human-readable, for the `output.repaired` event. Honest and specific. */
  changes: string[];
}

/**
 * Try to turn a near-miss answer into one that satisfies the schema, deterministically.
 *
 * Called only AFTER `validateOutput` has already failed, so it never touches a valid answer. Returns
 * `null` when nothing honest recovers the value — the caller then fails the run exactly as before.
 *
 * Bounded by construction: a fixed set of strategies (defaults, then one level of unwrapping),
 * applied to the same candidate list `validateOutput` already extracted. No loop that can run away,
 * no model call, no re-prompt.
 */
export function repairOutput(raw: string, schema: unknown): RepairResult | null {
  if (!schema || typeof schema !== "object") return null;
  for (const value of jsonValues(raw, schema)) {
    const attempt = repairValue(value, schema);
    if (attempt) {
      return { text: JSON.stringify(attempt.value), value: attempt.value, changes: attempt.changes };
    }
  }
  return null;
}

/** One candidate, run through every strategy in order. First that validates wins. */
function repairValue(value: unknown, schema: unknown): { value: unknown; changes: string[] } | null {
  // Strategy A — fill declared defaults for missing required scalar fields. Honest because the
  // schema author, not this code, decided which fields are soft-required and what their default is.
  const defaulted = applyDefaults(value, schema);
  if (validateValue(defaulted.value, schema).length === 0) return defaulted;

  // Strategy B — unwrap a wrapper object whose CONTENTS are the real answer. One level: the model
  // put the object under a key, so read it from there. Defaults are applied inside the recursion, so
  // `{"shape": {…, no confidence}}` recovers in one shot.
  const v = defaulted.value;
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [key, inner] of Object.entries(v as Record<string, unknown>)) {
      if (inner && typeof inner === "object") {
        const nested = repairValue(inner, schema);
        if (nested) {
          return { value: nested.value, changes: [`unwrapped the answer from "${key}"`, ...nested.changes] };
        }
      }
    }
  }
  return null;
}

/**
 * Fill missing REQUIRED properties that declare a `default` in the schema, recursively.
 *
 * Only required fields, only when a `default` is declared, and only when the field is absent — a
 * present value, even an ugly one, is the model's answer and is left alone. Returns a fresh value; the
 * input is never mutated.
 */
function applyDefaults(value: unknown, schema: unknown): { value: unknown; changes: string[] } {
  if (!schema || typeof schema !== "object") return { value, changes: [] };
  const s = schema as Record<string, unknown>;
  const type = s.type;
  const isObjectSchema = type === "object" || (!type && !!s.properties);
  if (!isObjectSchema || !value || typeof value !== "object" || Array.isArray(value)) {
    return { value, changes: [] };
  }

  const obj: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  const props = (s.properties as Record<string, unknown> | undefined) ?? {};
  const changes: string[] = [];

  // Recurse into present object-typed properties, so a nested soft-required field is filled too.
  for (const [k, sub] of Object.entries(props)) {
    if (k in obj) {
      const r = applyDefaults(obj[k], sub);
      obj[k] = r.value;
      changes.push(...r.changes);
    }
  }

  for (const req of (s.required as string[] | undefined) ?? []) {
    if (!(req in obj)) {
      const sub = props[req] as Record<string, unknown> | undefined;
      if (sub && "default" in sub) {
        obj[req] = clone(sub.default);
        changes.push(`defaulted "${req}" to ${JSON.stringify(sub.default)}`);
      }
    }
  }

  return { value: obj, changes };
}

/** A tiny deep clone for JSON-shaped defaults, so a shared default object can never be aliased. */
function clone<T>(v: T): T {
  return v === null || typeof v !== "object" ? v : (JSON.parse(JSON.stringify(v)) as T);
}
