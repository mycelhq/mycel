// Persistence for insight, on top of the records store. No new table.
//
// `records` already gives us the two things this needs: a natural key with an upsert, and a
// `project_id` column whose query filter FAILS CLOSED (an unscoped row never answers a scoped
// query — see `domain.ts`). Inventing an `insight_events` table would mean a migration, a second
// tenancy filter to get right, and a second place for a cross-tenant bug to live. There have been
// four of those in this codebase in the last two days and every one of them was a scoping filter
// written twice.
//
// ── Why a row per BATCH and not a running per-day counter ──
//
// The obvious shape is one row per project per day whose `data` holds counters that ingest
// increments. It does not work here, and the reason is worth writing down so nobody "fixes" it
// back. The records upsert merges with `records.data || EXCLUDED.data` — a SHALLOW merge, where a
// top-level key from the incoming document REPLACES the stored one. There is no arithmetic in that
// statement. Incrementing therefore means read-modify-write, which loses updates the moment two
// browsers post at once, and this is the one write path in the kernel guaranteed to be concurrent.
// (`bumpPacing` exists precisely because that same trap was hit for pacing counters, and the fix
// was a store method with arithmetic in the SQL. Adding another one is the right long-term move;
// it is not this change.)
//
// So ingest APPENDS: each accepted batch is one immutable row of pre-aggregated counts, written
// with a unique key so the upsert never conflicts and never merges. Concurrency is a non-issue
// because nothing is ever updated. Each row is bounded by the batch caps (≤50 events, so ≤50
// distinct names), and the client already coalesces up to 20 events per row. The cost is row COUNT
// over time, which is what retention is for; `pruneBefore` is the seam, deliberately not wired to a
// scheduler here.
import { randomUUID } from "node:crypto";
import type { DomainStore } from "../domain";
import { LIMITS, type NormalBatch } from "./schema";

/** All insight rows live under one wedge slug so a wedge-scoped read never has to know about them. */
export const INSIGHT_WEDGE = "insight";
export const BATCH_COLLECTION = "insight_batch";
export const FUNNEL_COLLECTION = "insight_funnel";

/** Reserved names the kernel understands without the product declaring them. Mirrors `RESERVED`. */
const PAGEVIEW = "$pageview";
const SESSION = "$session";

/** One immutable row: what a single accepted batch contributed, already counted. */
export interface BatchRow {
  v: 1;
  /** Kernel wall-clock. The client's `t` is never persisted — see `ingest`. */
  at: string;
  /** UTC date, so a summary can bucket without parsing every timestamp. */
  day: string;
  funnel?: string;
  events: number;
  sessions: number;
  pageviews: number;
  names: Record<string, number>;
  paths: Record<string, number>;
  steps: Record<string, number>;
}

export interface Aggregate {
  batches: number;
  events: number;
  sessions: number;
  pageviews: number;
  names: Record<string, number>;
  paths: Record<string, number>;
  steps: Record<string, number>;
}

export const emptyAggregate = (): Aggregate => ({
  batches: 0,
  events: 0,
  sessions: 0,
  pageviews: 0,
  names: {},
  paths: {},
  steps: {},
});

function bump(into: Record<string, number>, key: string, by = 1): void {
  into[key] = (into[key] ?? 0) + by;
}

/**
 * Count a normalised batch into the row that will be stored.
 *
 * Exported separately from the write so the counting can be tested without a store, and so it is
 * obvious by reading it that NOTHING per-visitor survives: the anonymous id and the session id were
 * already dropped by `normaliseBatch`, and per-event timestamps are dropped here. What remains is
 * "on this day, this project saw N of this event on this path" — which answers the funnel question
 * and cannot reconstruct a person's visit.
 */
export function countBatch(batch: NormalBatch, now: Date): BatchRow {
  const row: BatchRow = {
    v: 1,
    at: now.toISOString(),
    day: now.toISOString().slice(0, 10),
    ...(batch.funnel ? { funnel: batch.funnel } : {}),
    events: batch.events.length,
    sessions: 0,
    pageviews: 0,
    names: {},
    paths: {},
    steps: {},
  };
  for (const e of batch.events) {
    bump(row.names, e.name);
    if (e.name === SESSION) row.sessions += 1;
    if (e.name === PAGEVIEW) row.pageviews += 1;
    // Paths are counted for pageviews only. Every event carries the path it happened on, and
    // counting them all would make "top pages" a ranking of wherever the product happens to call
    // `track()` most, rather than of where customers actually are.
    if (e.name === PAGEVIEW && e.path) bump(row.paths, e.path);
    if (e.step) bump(row.steps, e.step);
  }
  return row;
}

/**
 * Persist one accepted batch against a project.
 *
 * `projectId` is the id the ingest key's signature resolved to and nothing else — the caller has no
 * other way to supply one, which is the point. The record's natural key carries a fresh UUID so
 * this is always an INSERT: see the header for why an update would be wrong.
 */
export async function storeBatch(
  domain: DomainStore,
  projectId: string,
  batch: NormalBatch,
  now: Date = new Date(),
): Promise<BatchRow> {
  const row = countBatch(batch, now);
  await domain.upsertRecord({
    project_id: projectId,
    wedge: INSIGHT_WEDGE,
    collection: BATCH_COLLECTION,
    // Day-prefixed so the keys sort chronologically, which makes a manual `SELECT ... LIKE` during
    // an incident possible without a date function.
    key: `${row.day}:${randomUUID()}`,
    data: row as unknown as Record<string, unknown>,
  });
  return row;
}

export interface FunnelDeclaration {
  name: string;
  steps: string[];
  updated_at: string;
}

/**
 * Remember a product's declared funnel, so the summary knows the ORDER of steps it is counting.
 *
 * Last writer wins, on purpose: when a founder's product ships a changed funnel, the newest
 * declaration is the one that describes the code customers are actually using. This IS an update to
 * an existing row (`steps` is replaced wholesale by the shallow merge, which is what we want here),
 * and it is safe to do as read-free write because there is no arithmetic involved.
 */
export async function storeFunnel(
  domain: DomainStore,
  projectId: string,
  name: string,
  steps: string[],
  now: Date = new Date(),
): Promise<void> {
  await domain.upsertRecord({
    project_id: projectId,
    wedge: INSIGHT_WEDGE,
    collection: FUNNEL_COLLECTION,
    key: name,
    data: { name, steps, updated_at: now.toISOString() } satisfies FunnelDeclaration as unknown as Record<string, unknown>,
  });
}

export async function loadFunnel(
  domain: DomainStore,
  projectId: string,
  name?: string,
): Promise<FunnelDeclaration | undefined> {
  // `project_id` is pushed DOWN into the query rather than filtered afterwards. A post-filter only
  // protects the rows the query happened to return, and silently leaks the moment a `limit`
  // truncates another tenant's rows into the window. Same rule as everywhere else in this codebase.
  const rows = await domain.queryRecords({
    project_id: projectId,
    wedge: INSIGHT_WEDGE,
    collection: FUNNEL_COLLECTION,
    limit: 50,
  });
  const wanted = name ? rows.find((r) => r.key === name) : rows[0];
  const data = wanted?.data as FunnelDeclaration | undefined;
  if (!data || !Array.isArray(data.steps) || data.steps.length < 2) return undefined;
  return { name: data.name, steps: data.steps, updated_at: data.updated_at };
}

/** How many batch rows a single summary will read. Past this the answer is marked `truncated`. */
export const MAX_ROWS_PER_SUMMARY = 5_000;

export interface WindowSlice {
  aggregate: Aggregate;
  /** True when the row cap was hit, so the caller can say so instead of quietly under-reporting. */
  truncated: boolean;
}

/**
 * Aggregate every batch row between two instants, for one project.
 *
 * Rows come back newest-first, so hitting the cap loses the OLDEST rows in the range — which for a
 * "what happened lately" question is the right end to lose, and is reported either way.
 */
export async function aggregateWindow(
  domain: DomainStore,
  projectId: string,
  fromIso: string,
  toIso: string,
): Promise<WindowSlice> {
  const rows = await domain.queryRecords({
    project_id: projectId,
    wedge: INSIGHT_WEDGE,
    collection: BATCH_COLLECTION,
    limit: MAX_ROWS_PER_SUMMARY,
  });
  const out = emptyAggregate();
  for (const r of rows) {
    const data = r.data as unknown as BatchRow | undefined;
    // `data.at` is the kernel's own clock at ingest, which is what the window means. `created_at`
    // would say the same thing today and would stop saying it the first time a row is backfilled.
    const at = typeof data?.at === "string" ? data.at : r.created_at;
    if (at < fromIso || at >= toIso) continue;
    out.batches += 1;
    out.events += num(data?.events);
    out.sessions += num(data?.sessions);
    out.pageviews += num(data?.pageviews);
    mergeCounts(out.names, data?.names);
    mergeCounts(out.paths, data?.paths);
    mergeCounts(out.steps, data?.steps);
  }
  return { aggregate: out, truncated: rows.length >= MAX_ROWS_PER_SUMMARY };
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function mergeCounts(into: Record<string, number>, from: unknown): void {
  if (!from || typeof from !== "object") return;
  for (const [k, v] of Object.entries(from as Record<string, unknown>)) bump(into, k, num(v));
}

/**
 * Collapse a count map to its top `n`, bucketing the tail as `__other`.
 *
 * The cap is a read-side concern (see `LIMITS.maxCardinalityPerDay`): storage is already bounded
 * per row, but a product that emits `track(uuid())` would otherwise hand a model a million-key
 * object. Collapsing keeps the totals honest — and "you emit unbounded event names" is itself the
 * finding, which is why the bucket is named rather than dropped.
 */
export function topCounts(counts: Record<string, number>, n = LIMITS.maxCardinalityPerDay): Array<{ key: string; count: number }> {
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const head = sorted.slice(0, n).map(([key, count]) => ({ key, count }));
  const tail = sorted.slice(n).reduce((sum, [, count]) => sum + count, 0);
  if (tail > 0) head.push({ key: "__other", count: tail });
  return head;
}

/**
 * Retention seam. Nothing calls it yet, deliberately.
 *
 * Insight rows are append-only, so they grow without limit, and the honest place to bound them is a
 * scheduled prune with a retention period a founder can see and change. Wiring that into the
 * scheduler is a product decision (how long may we hold a customer's behavioural data?) rather than
 * an implementation one, and shipping a silent 90-day delete because it seemed tidy would be making
 * that decision on their behalf. This function is here so the answer, when it comes, is one line.
 */
export async function pruneBefore(domain: DomainStore, projectId: string, beforeIso: string): Promise<number> {
  const rows = await domain.queryRecords({
    project_id: projectId,
    wedge: INSIGHT_WEDGE,
    collection: BATCH_COLLECTION,
    limit: MAX_ROWS_PER_SUMMARY,
  });
  let deleted = 0;
  for (const r of rows) {
    const at = (r.data as unknown as BatchRow | undefined)?.at ?? r.created_at;
    if (at < beforeIso && (await domain.deleteRecord(r.id))) deleted += 1;
  }
  return deleted;
}
