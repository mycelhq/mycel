// Run a capability's reads against whatever the founder actually connected.
//
// The three steps that used to be one hardcoded loop inside payments.ts — resolve the provider,
// call its tools, normalise the answers — with the vendor taken out of all three. payments.ts keeps
// everything it knew about MONEY and loses everything it assumed about STRIPE.
//
// ═══ WHAT IT REFUSES TO DO ═══
//
// It never calls a tool the founder has not declared as a read on the connection. `isReadTool` is the
// authority, not the provider table: the table says which slugs this capability WOULD like, and the
// connection says which slugs the founder actually granted. A capability read that could reach an
// arbitrary slug on a connected accounting system is a capability read that can void an invoice.
//
// It never reports an empty read as a clean one. `reached` is false unless at least one tool call
// came back, and every failure and every normaliser skip is carried out in `failures`/`skipped` for
// the caller to put in front of a person. The single most expensive bug in this repo is something
// failing while reporting success, and a reader is where that bug is easiest to write.
import type { Connection } from "./contract";
import type { ActionResult } from "./actions";
import { isReadTool } from "./composio";
import {
  resolveCapability,
  type CapabilityBinding,
  type CapabilityName,
} from "./capabilities";
import type { Normalised } from "./capabilities.normalise";

export interface CapabilityRead<T> {
  binding: CapabilityBinding;
  /**
   * Items, with `external_id` namespaced by connection id.
   *
   * Namespacing is not cosmetic: two providers can mint the same opaque id (`"1"` is a perfectly good
   * QuickBooks invoice id) and collapsing them would let one provider's row suppress another's
   * genuine one. It also makes the id stable as an idempotency key across a provider being
   * disconnected and reconnected under a new row.
   */
  items: T[];
  /** Namespaced external id → "connection name/toolkit", for the audit trail. */
  sources: Map<string, string>;
  /** Did any tool call actually come back? False means we read nothing and must say so. */
  reached: boolean;
  /** Tool calls that failed, one sentence each. */
  failures: string[];
  /** Rows a normaliser refused to guess at, one sentence each. See `Normalised`. */
  skipped: string[];
  /** Provider slugs we wanted but the founder has not granted as reads on the connection. */
  ungranted: string[];
}

/**
 * Read one capability, for one project.
 *
 * `projectId` is a required field of a required argument and is never defaulted, for the reason
 * `reconcileProject` states at length: reading one tenant's provider and writing the results onto
 * another tenant's invoices both fabricates revenue for one business and keeps chasing the client of
 * another. Two cross-tenant leaks have shipped here and both were a scope that defaulted.
 */
export async function readCapability<T extends { external_id: string }>(args: {
  capability: CapabilityName;
  project_id: string;
  connections: readonly Connection[];
  execute(conn: Connection, capability: string, payload: Record<string, unknown>): Promise<ActionResult>;
  /** The normaliser registry for this capability — `PAYMENT_SHAPES` or `INVOICE_SHAPES`. */
  shapes: Record<string, (data: unknown) => Normalised<T>>;
  /** Passed through to every tool call. Providers page differently; 100 is what Stripe already used. */
  limit?: number;
  /**
   * Connections already read in this pass, and therefore skipped.
   *
   * One toolkit can serve two capabilities — Stripe is both a payment source and an invoice source —
   * and a reconciliation that has already read Stripe's invoices as payments must not read them
   * again as invoices. Not just wasted calls against a founder's rate limit: the same rows would
   * arrive twice under two shapes, and the only thing stopping a double-count would be the
   * idempotency ledger, which is a safety net rather than a plan.
   */
  exclude_connection_ids?: readonly string[];
}): Promise<CapabilityRead<T>> {
  if (!args.project_id) throw new Error("a capability read must be scoped to a project");
  const binding = resolveCapability(args.capability, args.connections, args.project_id);
  const out: CapabilityRead<T> = {
    binding,
    items: [],
    sources: new Map(),
    reached: false,
    failures: [],
    skipped: [],
    ungranted: [],
  };
  // An ambiguous binding is refused rather than half-read: `ok: false` with `ambiguous: true` means
  // two providers claim a single-provider capability, and reading one of them is the arbitrary pick
  // the whole design refuses to make.
  if (!binding.ok && binding.ambiguous) return out;

  const seen = new Set<string>();
  const skip = new Set(args.exclude_connection_ids ?? []);
  for (const b of binding.bound) {
    if (skip.has(b.connection.id)) continue;
    if (b.unreadable) {
      // Already in `binding.detail` as a sentence, but repeated into `failures` because callers that
      // summarise a run read this list and not the binding.
      out.failures.push(
        `${b.provider.label} is connected but this kernel has no reader for it, so nothing was read from it`,
      );
      continue;
    }
    for (const read of b.provider.reads ?? []) {
      const shape = args.shapes[read.shape];
      if (!shape) {
        // Unreachable when `assertCapabilityTableValid` has run at boot. Loud rather than skipped,
        // because the only way to get here is a table that was validated against a different registry.
        out.failures.push(`${b.provider.label}: no normaliser is registered for the shape "${read.shape}"`);
        continue;
      }
      // THE READ GATE. The provider table's wish list is not permission; the connection is.
      if (!isReadTool(b.connection, read.slug)) {
        out.ungranted.push(`${b.connection.name}/${read.slug}`);
        continue;
      }
      const res = await args.execute(b.connection, read.slug, {
        arguments: { limit: args.limit ?? 100, ...(read.arguments ?? {}) },
      });
      if (!res.ok) {
        out.failures.push(`${b.connection.name}/${read.slug}: ${res.detail ?? "no detail"}`);
        continue;
      }
      out.reached = true;
      const norm = shape(res.data);
      out.skipped.push(...norm.skipped);
      for (const item of norm.items) {
        const id = `${b.connection.id}:${item.external_id}`;
        if (seen.has(id)) continue;
        seen.add(id);
        out.sources.set(id, `${b.connection.name}/${b.provider.toolkit}`);
        out.items.push({ ...item, external_id: id });
      }
    }
  }
  return out;
}

/**
 * Why a read produced nothing, as a sentence — or undefined if it did reach the provider.
 *
 * Every branch is a different thing for the founder to do, and collapsing them into "could not read
 * payments" is what made the old failure indistinguishable from a business that simply has not been
 * paid this week.
 */
export function whyNothingRead<T>(read: CapabilityRead<T>): string | undefined {
  if (read.reached) return undefined;
  if (!read.binding.bound.length) return read.binding.detail;
  if (read.binding.ambiguous) return read.binding.detail;
  if (read.failures.length) return `could not read: ${read.failures.join("; ")}`;
  if (read.ungranted.length) {
    return (
      `${read.binding.bound.map((b) => b.provider.label).join(" and ")} is connected but none of the reads it needs ` +
      `(${read.ungranted.join(", ")}) have been granted on it, so nothing was read — reconnect it to grant them`
    );
  }
  return read.binding.detail;
}
