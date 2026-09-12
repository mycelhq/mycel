// The list of people this business may not email, and the one check that reads it.
//
// ═══ WHAT WAS MISSING ═══
//
// Nothing. There was no list. An agency running on this kernel could mail an address that
// hard-bounced an hour earlier, mail somebody who had marked the previous message as spam, and keep
// doing both on every step of the sequence — because the only place a bounce was ever noticed was
// the AgentMail webhook, which acknowledged it and threw it away.
//
// That is not a slow leak. A bounce rate is the number that gets a sending domain blocked, and
// retrying a dead address is the one behaviour that feeds it deliberately. The agency whose domain
// went cold would have been right to blame the platform that let them.
//
// ═══ WHY IT SITS ON THE RECORD STORE ═══
//
// A suppression is per-tenant and must be: an unsubscribe from agency A's client does not bind
// agency B, and one shared list across every business on this deployment would leak the fact that
// two agencies share a prospect. `Record_` is already project-scoped with a fail-closed tenant
// filter and a natural key that upserts, which is precisely the shape of this list, and a bespoke
// table would be a migration plus a second thing to get the tenancy wrong in.
//
// ═══ WHY THE RULES ARE NOT IN THIS FILE ═══
//
// They are in `@mycel/deliverability`, shared with `growth/`. What the key is, whether a second
// reason overwrites the first, whether the plaintext may be kept — those have to be the same answers
// on both sides or the two systems disagree about who asked us to stop. This file is the storage and
// nothing else.
import { createHash } from "node:crypto";
import {
  addressKey,
  keepsPlaintext,
  merge,
  refusalSaid,
  type Suppression,
  type SuppressReason,
} from "@mycel/deliverability";
import { getDomainStore } from "./../domain";
import type { Record_ } from "../contract";

/** The collection every suppression lives in. One list per project, one question, one answer. */
export const SUPPRESSION_COLLECTION = "email_suppressions";
/**
 * Suppressions belong to the BUSINESS, not to a service.
 *
 * A person who unsubscribed from a chase must not then receive an outreach message from the same
 * firm because a different wedge asked. `Record_.wedge` is required, so it is a constant here rather
 * than the calling wedge — which is the whole point: the list is not scoped to whoever wrote to it.
 */
export const SUPPRESSION_WEDGE = "_business";

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/**
 * The stored form.
 *
 * `key` is carried IN `data` as well as being `Record_.key`, and the duplication is load-bearing:
 * `queryRecords`'s `where` filters on `data` only, so a lookup keyed on the record's own key matched
 * nothing and every second suppression of the same address created a second row. The first version
 * of this file did exactly that, and the test that caught it is the one asserting first-write-wins.
 */
interface Stored {
  key: string;
  reason: SuppressReason;
  at: string;
  email?: string;
  detail?: Record<string, unknown>;
}

const readStored = (r: Record_ | undefined): Suppression | undefined => {
  if (!r) return undefined;
  const d = r.data as unknown as Stored;
  if (!d?.reason) return undefined;
  return { key: r.key, reason: d.reason, at: d.at ?? r.created_at, ...(d.email ? { email: d.email } : {}), ...(d.detail ? { detail: d.detail } : {}) };
};

/** May this business email this address? `undefined` means yes. */
export async function suppressionFor(projectId: string, email: string): Promise<Suppression | undefined> {
  if (!projectId || !email) return undefined;
  const key = addressKey(email, sha256);
  const rows = await getDomainStore().queryRecords({
    project_id: projectId,
    wedge: SUPPRESSION_WEDGE,
    collection: SUPPRESSION_COLLECTION,
    where: { key },
    limit: 1,
  });
  // Belt and braces: `where` narrowed the read, and this is the authority on identity.
  return readStored(rows.find((r) => r.key === key || (r.data as { key?: string }).key === key));
}

export interface SuppressArgs {
  project_id: string;
  email: string;
  reason: SuppressReason;
  at?: string;
  detail?: Record<string, unknown>;
}

/**
 * Add to the list. Idempotent, and FIRST WRITE WINS on the reason — see `merge` in the package for
 * why the March unsubscribe outranks the June hard bounce.
 */
export async function suppressAddress(args: SuppressArgs): Promise<{ created: boolean; row: Suppression }> {
  const key = addressKey(args.email, sha256);
  const existing = await suppressionFor(args.project_id, args.email);
  const incoming: Suppression = {
    key,
    reason: args.reason,
    at: args.at ?? new Date().toISOString(),
    // The plaintext only when the reason permits it. A request to stop is honoured by the hash;
    // writing that person's address into a new permanent row is the wrong shape.
    ...(keepsPlaintext(args.reason) ? { email: args.email.trim().toLowerCase() } : {}),
    ...(args.detail ? { detail: args.detail } : {}),
  };
  const kept = merge(existing, incoming);
  if (existing) return { created: false, row: kept };
  await getDomainStore().upsertRecord({
    project_id: args.project_id,
    wedge: SUPPRESSION_WEDGE,
    collection: SUPPRESSION_COLLECTION,
    key,
    data: { key, reason: kept.reason, at: kept.at, ...(kept.email ? { email: kept.email } : {}), ...(kept.detail ? { detail: kept.detail } : {}) },
  });
  return { created: true, row: kept };
}

/** Newest first, for a founder asking who this business has stopped emailing. */
export async function recentSuppressions(projectId: string, limit = 20): Promise<Suppression[]> {
  const rows = await getDomainStore().queryRecords({
    project_id: projectId,
    wedge: SUPPRESSION_WEDGE,
    collection: SUPPRESSION_COLLECTION,
    limit: Math.max(1, Math.min(200, limit)),
  });
  return rows
    .map(readStored)
    .filter((s): s is Suppression => !!s)
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, limit);
}

export { refusalSaid };
