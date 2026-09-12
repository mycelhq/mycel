// One business, one row, forever — across sources, across months, across spellings.
//
// ── WHY THIS IS THE LOAD-BEARING FILE OF THE WHOLE FUNNEL ──────────────────────────────────────
//
// The funnel has to produce FRESH leads every month, from many sources, without ever mailing the
// same business twice. Both halves of that are one question: given a business we just found, have
// we seen it before? Get it wrong in the loose direction and a prospect gets two sequences from two
// inboxes, which is how a domain gets burned. Get it wrong in the tight direction and the pipeline
// silently re-sources the same seven hundred companies every week and reports growth.
//
// So identity is computed here, once, by pure functions, with tests — not inferred at the call
// site by whoever is writing the next importer.
//
// ── THE TRAP THAT MATTERS MOST: SHARED PLATFORM DOMAINS ───────────────────────────────────────
//
// `growth.companies` is keyed by domain, which is correct for agencies and WRONG the moment we
// source local service businesses. An enormous share of plumbers, clinics and salons do not have
// their own domain — they have:
//
//     joespluming.wixsite.com/home      business.site/...        facebook.com/joesplumbing
//     joes-plumbing.square.site         sites.google.com/...     linktr.ee/joesplumbing
//
// Key those on "domain" and EVERY Wix business in America collapses into a single row called
// `wixsite.com`. The first import looks like a triumph — thousands of leads, hundreds of rows —
// and the pipeline has actually destroyed the data. Worse, it is silent: the row count is
// plausible, and nobody diffs it.
//
// So a domain only confers identity if it is REGISTRABLE BY THE BUSINESS ITSELF. Everything on a
// shared host is treated as no domain at all, and identity falls through to something that is
// genuinely per-business.
//
// ── THE LADDER, STRONGEST FIRST ────────────────────────────────────────────────────────────────
//
//   1. `place:<place_id>` — Google's own stable identifier for a physical business. Authoritative,
//      survives renames and re-tiling, and is the reason the harvest ledger stores it.
//   2. `domain:<registrable>` — their own site. Stable and cross-source: the same domain found on
//      Clutch and in Places is the same company, which is exactly the join we want.
//   3. `tel:<e164>` — a US phone. Weaker (answering services, shared reception), so it is a last
//      resort and never overrides 1 or 2.
//
// Deliberately NOT name+address fuzzy matching. It is the classic next step and it is where this
// kind of system starts merging "Smith Dental" in two different states. When nothing above
// resolves, we would rather refuse the lead than guess.

/** Everything a source can tell us about a business, before we decide what it IS. */
export interface SourcedBusiness {
  /** Google Places `place_id`, when the source is Places. Authoritative. */
  placeId?: string | null;
  /** Whatever URL the source had — full URL, bare host, anything. */
  website?: string | null;
  /** Whatever the source called a phone number, in any format. */
  phone?: string | null;
  name?: string | null;
}

/**
 * Hosts on which a domain says nothing about WHO the business is.
 *
 * Every entry here is a real place US service businesses put their sites. The list is deliberately
 * about SHARED HOSTING rather than "free" — a paid Wix plan on a wixsite.com subdomain is exactly
 * as non-identifying as a free one.
 *
 * Matching is on the registrable domain, so `anything.wixsite.com` and `wixsite.com` both hit.
 */
export const SHARED_HOSTS = new Set([
  "wixsite.com",
  "wix.com",
  "squarespace.com",
  "square.site",
  "weebly.com",
  "godaddysites.com",
  "business.site", // Google Business Profile sites — very common for local trades
  "sites.google.com",
  "webnode.com",
  "webs.com",
  "jimdosite.com",
  "strikingly.com",
  "myshopify.com",
  "wordpress.com",
  "blogspot.com",
  "tumblr.com",
  // Social and link-in-bio pages, which local businesses routinely list as "website".
  "facebook.com",
  "fb.com",
  "instagram.com",
  "linktr.ee",
  "linkedin.com",
  "yelp.com",
  "nextdoor.com",
  "houzz.com",
  "angi.com",
  "thumbtack.com",
  "bbb.org",
  // Directories that sometimes appear in a `website` field by mistake.
  "clutch.co",
  "sortlist.com",
  "upcity.com",
  "google.com",
  "goo.gl",
  "maps.app.goo.gl",
]);

/**
 * Two-label public suffixes we must not mistake for a registrable domain.
 *
 * `foo.co.uk` is registrable; `co.uk` is not. Without this, every UK business would key on `co.uk`
 * — the same collapse as the shared-host bug, with a smaller blast radius only because the ICP is
 * mostly US. Not the full Public Suffix List: pulling that in is a dependency and a data-freshness
 * problem for a handful of suffixes we actually meet.
 */
const TWO_LABEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "me.uk", "ltd.uk", "plc.uk", "net.uk", "sch.uk", "ac.uk", "gov.uk",
  "com.au", "net.au", "org.au", "co.nz", "co.za", "com.br", "co.in", "com.mx", "co.jp",
]);

/**
 * The part of a hostname the business could actually have registered.
 *
 * `https://WWW.Joes-Plumbing.com/contact?x=1` → `joes-plumbing.com`
 * `joesplumbing.wixsite.com/home`             → `wixsite.com`  (then rejected as shared)
 *
 * Returns null for anything that is not a hostname: IP literals, `localhost`, single labels, and
 * the empty string. A source that hands us junk should produce NO identity rather than a fake one.
 */
export function registrableDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  let host = String(input).trim().toLowerCase();
  if (!host) return null;

  // Strip scheme, credentials, path, query, fragment and port without needing a valid URL — sources
  // hand us bare hosts as often as they hand us URLs, and `new URL("foo.com")` throws.
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  host = host.replace(/^[^/@]*@/, "");
  host = host.split(/[/?#]/)[0] ?? "";
  host = host.split(":")[0] ?? "";
  host = host.replace(/\.+$/, ""); // a trailing dot is a legal FQDN and a different string

  if (!host || host === "localhost") return null;
  // An IP literal identifies a server, never a business.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes("[")) return null;

  const labels = host.split(".").filter(Boolean);
  if (labels.length < 2) return null;
  if (labels.some((l) => !/^[a-z0-9-]+$/.test(l))) return null;

  const lastTwo = labels.slice(-2).join(".");
  if (labels.length >= 3 && TWO_LABEL_SUFFIXES.has(lastTwo)) return labels.slice(-3).join(".");
  return lastTwo;
}

/** Does this domain belong to the business, or to the platform hosting it? */
export function isSharedHost(domain: string | null | undefined): boolean {
  return !!domain && SHARED_HOSTS.has(domain);
}

/**
 * A domain we are willing to treat as this business's identity, or null.
 *
 * The single call every importer should use. `registrableDomain` alone is the sharp edge.
 */
export function ownDomain(website: string | null | undefined): string | null {
  const d = registrableDomain(website);
  return d && !isSharedHost(d) ? d : null;
}

/**
 * A US phone in E.164, or null.
 *
 * Extensions are DROPPED rather than encoded: `555-0100 x204` and `555-0100 ext 9` are the same
 * switchboard, and keeping the extension would make one business look like several. Losing the
 * extension costs nothing here — this value is an identity key, not a dial string.
 *
 * Deliberately US-only (`+1`, 10 digits, area code not starting 0 or 1). A number we cannot
 * confidently normalise produces NO key, because a wrong phone key merges two businesses.
 */
export function e164US(input: string | null | undefined): string | null {
  if (!input) return null;
  const cut = String(input).split(/(?:ext|x|#)\.?\s*\d+\s*$/i)[0] ?? "";
  const digits = cut.replace(/\D/g, "");
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (ten.length !== 10) return null;
  // NANP: area code and exchange both start 2-9. This rejects 000/111 placeholder junk that
  // directories are full of.
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(ten)) return null;
  return `+1${ten}`;
}

/**
 * The identity of a sourced business, or null when we cannot honestly claim one.
 *
 * NULL IS A REAL ANSWER AND MUST NOT BE PAPERED OVER. A business with no place id, a Wix site and
 * an unparseable phone cannot be deduplicated, so importing it guarantees a duplicate later. The
 * caller should drop it and count the drop, not invent a key from the name.
 */
export function businessKey(b: SourcedBusiness): string | null {
  if (b.placeId && String(b.placeId).trim()) return `place:${String(b.placeId).trim()}`;
  const d = ownDomain(b.website);
  if (d) return `domain:${d}`;
  const tel = e164US(b.phone);
  if (tel) return `tel:${tel}`;
  return null;
}

/**
 * Every key this business could ALSO be known by, strongest first.
 *
 * The same company arrives from Places with a `place_id` and from Clutch with only a domain, and
 * those must resolve to one row. So a caller looks up all of these before inserting, and writes
 * them all as aliases afterwards. Without it the funnel double-counts precisely the businesses
 * good enough to appear in two sources — the best leads it has.
 */
export function allKeys(b: SourcedBusiness): string[] {
  const keys: string[] = [];
  if (b.placeId && String(b.placeId).trim()) keys.push(`place:${String(b.placeId).trim()}`);
  const d = ownDomain(b.website);
  if (d) keys.push(`domain:${d}`);
  const tel = e164US(b.phone);
  if (tel) keys.push(`tel:${tel}`);
  return keys;
}
