// Pull the target list out of the product's Postgres, once, into local SQLite.
//
// Read-only and one-directional on purpose. The rally is a different risk model on a different
// machine with a different lifetime; it borrows the list and owns everything after that. Nothing
// here writes back, so a laptop that dies mid-launch cannot corrupt the client pipeline.
//
// The filter is the founder's, stated on 8 September: keep only people we can actually reach on
// LinkedIn. The 397 Product Hunt leads with no LinkedIn URL were closed in Postgres the same day.

import type { DatabaseSync } from "node:sqlite";
import { upsertTarget } from "./store";

export interface ImportResult {
  seen: number;
  imported: number;
  skipped: number;
  /** Queued people no longer in Postgres's live list, dropped from the local queue. */
  retired: number;
}

const CANONICAL = /linkedin\.com\/in\/([^/?#\s]+)/i;

/**
 * Who to ask first.
 *
 * A Product Hunt rally is not ordinary outbound: the audience is people who are ACTIVE ON PRODUCT
 * HUNT RIGHT NOW, because those are the ones who will still be there on launch day. So recency of
 * their own launch is the strongest signal available, and it decays fast — somebody who shipped
 * last week is in a completely different frame from somebody who shipped in July.
 *
 * Makers outrank everyone else for the same reason: they have launched, so they know what the day
 * costs, and they are the most likely to show up for someone else's.
 *
 * Returns a score and the sentence explaining it, because a ranked list nobody can audit is a
 * ranked list nobody trusts.
 */
export function rank(row: {
  role?: string | null;
  scrapedVia?: string | null;
  headline?: string | null;
  product?: string | null;
}, now = new Date()): { priority: number; why: string } {
  let score = 0;
  const bits: string[] = [];

  if ((row.role ?? "").toLowerCase() === "maker") {
    score += 40;
    bits.push("maker");
  } else if (row.role) {
    score += 10;
    bits.push(row.role);
  }

  // `scraped_via` looks like `ph:daily:2026-09-06`, sometimes several comma-joined. Take the most
  // recent day it appeared on a leaderboard.
  const days = String(row.scrapedVia ?? "")
    .split(",")
    .map((v) => /(\d{4}-\d{2}-\d{2})/.exec(v)?.[1])
    .filter((v): v is string => Boolean(v))
    .sort();
  const latest = days[days.length - 1];
  if (latest) {
    const ageDays = Math.max(0, Math.round((now.getTime() - Date.parse(latest)) / 86_400_000));
    // 40 points at zero days, nothing left after six weeks.
    score += Math.max(0, 40 - ageDays);
    bits.push(ageDays === 0 ? "launched today" : `launched ${ageDays}d ago`);
  }

  // The product is NOT repeated here: it has its own column in the CRM, and "maker · launched
  // today · Screen Studio" next to a Launched column reading "Screen Studio" is the same fact
  // twice on every one of six hundred rows.
  if (row.headline) score += 5;

  return { priority: score, why: bits.join(" · ") || "no signal" };
}

/** One row per person we can reach. `pg` is any node-postgres-shaped client. */
export async function importFromPostgres(
  db: DatabaseSync,
  pg: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
  opts: { source?: string; limit?: number } = {},
): Promise<ImportResult> {
  const { rows } = await pg.query(
    `SELECT p.key, p.name, p.title, p.enrichment->>'linkedin_url' AS li,
            p.enrichment->>'ph_role' AS role, p.enrichment->>'scraped_via' AS via,
            p.enrichment->>'product_name' AS product, p.avatar_url,
            p.enrichment->>'ph_url' AS ph_url, p.enrichment->>'x_handle' AS x_handle,
            p.enrichment->>'product_url' AS product_url
       FROM growth.people p
      WHERE COALESCE(p.enrichment->>'linkedin_url','') <> ''
        AND p.state NOT IN ('closed_won','closed_lost','opted_out')
        ${opts.source ? "AND p.enrichment->>'source' = $1" : ""}
      ORDER BY p.updated_at DESC
      LIMIT ${Math.max(1, Math.min(5000, opts.limit ?? 1000))}`,
    opts.source ? [opts.source] : [],
  );

  const str = (v: unknown): string | null => (v === null || v === undefined || v === "" ? null : String(v));
  let imported = 0;
  let skipped = 0;
  const seen = new Set<string>();
  const live = new Set<string>();
  for (const r of rows) {
    const raw = String(r.li ?? "");
    const m = CANONICAL.exec(raw);
    // A LinkedIn URL we cannot reduce to a public id is not addressable, and importing it would
    // put a row in the queue that every seat fails on forever.
    if (!m) {
      skipped++;
      continue;
    }
    const id = decodeURIComponent(m[1]!).toLowerCase();
    if (seen.has(id)) {
      skipped++;
      continue;
    }
    seen.add(id);
    live.add(String(r.key));
    const headline = r.title === null || r.title === undefined ? null : String(r.title);
    const { priority, why } = rank({
      role: r.role === null || r.role === undefined ? null : String(r.role),
      scrapedVia: r.via === null || r.via === undefined ? null : String(r.via),
      headline,
      product: r.product === null || r.product === undefined ? null : String(r.product),
    });
    upsertTarget(db, {
      personKey: String(r.key),
      name: String(r.name ?? id),
      headline,
      linkedinUrl: `https://www.linkedin.com/in/${id}/`,
      priority,
      why,
      avatarUrl: str(r.avatar_url),
      phUrl: str(r.ph_url),
      xHandle: str(r.x_handle),
      product: str(r.product),
      productUrl: str(r.product_url),
    });
    imported++;
  }

  /**
   * RECONCILE, DO NOT JUST APPEND.
   *
   * The first version only ever inserted, so a person closed in Postgres stayed in the local queue
   * for good. It showed immediately: the review-page contacts were closed upstream and were still
   * sitting at the top of `rally next` — precisely the list the founder had asked to be rid of.
   *
   * Only `queued` rows are dropped. Somebody already invited stays, because the record of having
   * contacted them is ours and outlives any upstream decision about the list.
   */
  const stale = db
    .prepare(`SELECT person_key FROM targets WHERE state = 'queued'`)
    .all()
    .map((r) => String(r.person_key))
    .filter((k) => !live.has(k));
  const drop = db.prepare(`DELETE FROM targets WHERE person_key = ? AND state = 'queued'`);
  for (const k of stale) drop.run(k);

  return { seen: rows.length, imported, skipped, retired: stale.length };
}
