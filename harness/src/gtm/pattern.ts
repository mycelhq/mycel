// Tier 1 of the GTM email waterfall — the same policy as growth/lib/enrich.
//
// A name + a company domain is enough to guess the mailbox shape (first.last@) and to ask DNS
// whether that domain receives mail at all. That is free, needs no vendor, and is the hop that
// must run BEFORE Firecrawl or FullEnrich. Writing the guess as the sendable address is how you
// burn a domain: this file only reports the candidate and the MX answer. The sendable field is
// filled by a page scrape or the paid vendor, later in enrich.ts.

import { promises as dns } from "node:dns";

export const PATTERN_RESOLVER = "pattern";

export interface PatternHop {
  ok: boolean;
  /** Ranked guess, never treated as sendable by itself. */
  guess?: string;
  hasMx: boolean;
  note: string;
}

const HONORIFIC = new Set(["mr", "mrs", "ms", "miss", "dr", "prof", "sir", "mx"]);
const POSTNOMINAL = new Set(["jr", "sr", "ii", "iii", "iv", "phd", "mba", "msc", "cfa", "cpa"]);

export function parseName(full: string): { first: string; last: string | null } | null {
  const cleaned = full
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((t) => t && !HONORIFIC.has(t) && !POSTNOMINAL.has(t));
  if (!cleaned[0]) return null;
  if (cleaned.length === 1) return { first: cleaned[0], last: null };
  return { first: cleaned[0], last: cleaned.slice(1).join("") || null };
}

/** The one guess we surface: first.last@, or first@ when there is no surname. */
export function patternGuess(name: string, domain: string): string | null {
  const host = domain.trim().toLowerCase().replace(/^www\./, "");
  if (!host || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) return null;
  const n = parseName(name);
  if (!n) return null;
  const local = n.last ? `${n.first}.${n.last}` : n.first;
  if (!local) return null;
  return `${local}@${host}`;
}

export async function lookupMx(domain: string): Promise<{ hasMx: boolean; note: string }> {
  const host = domain.trim().toLowerCase().replace(/^www\./, "");
  try {
    const records = await Promise.race([
      dns.resolveMx(host),
      new Promise<never>((_, rej) => setTimeout(() => rej(Object.assign(new Error("timeout"), { code: "ETIMEOUT" })), 1500)),
    ]);
    const mx = records.map((r) => r.exchange).filter(Boolean);
    if (!mx.length) return { hasMx: false, note: `${host} publishes no MX record; it receives no mail` };
    return { hasMx: true, note: `${host} receives mail` };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? "";
    if (code === "ENOTFOUND" || code === "ENODATA") {
      return { hasMx: false, note: `${host} has no MX; no address there is deliverable` };
    }
    return { hasMx: false, note: `MX lookup for ${host} failed (${code || "unknown"})` };
  }
}

export async function patternHop(input: { name?: string; company_domain?: string }): Promise<PatternHop | null> {
  const name = (input.name ?? "").trim();
  const domain = (input.company_domain ?? "").trim();
  if (!name || !domain) return null;
  const guess = patternGuess(name, domain);
  if (!guess) {
    return { ok: false, hasMx: false, note: "the name on file produces no usable local part" };
  }
  const mx = await lookupMx(domain);
  return {
    ok: mx.hasMx,
    guess,
    hasMx: mx.hasMx,
    note: mx.hasMx
      ? `guessed ${guess} (${mx.note}) — not sendable until a page or the paid hop confirms it`
      : mx.note,
  };
}
