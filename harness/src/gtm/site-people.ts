// ═══ CONTACTS FROM A BUSINESS'S OWN WEBSITE, WHICH IS WHERE THEY ALREADY ARE ═══
//
// A service business publishes its email on its contact page because it WANTS to be contacted.
// Paying a waterfall vendor per lead to be told a value sitting in public HTML is the single
// largest avoidable cost in this funnel, and for this ICP — local trades, small firms, agencies —
// the vendor is largely a wrapper around the same open web.
//
// The parsing is `@mycel/sourcing/site-contacts`, the same code the outbound engine has been using
// against real sites for months: obfuscation forms (`info [at] acme [dot] com`, `&#64;`, `(at)`),
// role-mailbox ranking, template-address rejection. Shared rather than reimplemented, because a
// second copy of "is this address real" drifts silently — one side learns a new obfuscation and the
// other keeps enrolling addresses that bounce.
//
// THIS FILE IS THE FETCHING HALF: which pages to try, in what order, under what budget. The parse
// half has no network in it at all, on purpose, so the part that must be exactly right is testable
// without one.

import { fetchWithDeadline } from "../http";
import { CONTACT_PATHS, extractContacts, type SiteContacts } from "@mycel/sourcing";

/** A person we can actually reach, sourced at no per-lead cost. */
export interface SiteContact {
  company: string;
  company_domain: string;
  email?: string;
  phone?: string;
  linkedin_url?: string;
  /** Which page it came off, so a founder asking "where did you get this" has an answer. */
  source_url: string;
}

const PAGE_DEADLINE_MS = 8_000;
/** Homepage plus the pages a contact address actually lives on. Bounded — each is a real fetch. */
const MAX_PAGES_PER_SITE = 3;
const MAX_HTML_BYTES = 600_000;

async function page(url: string): Promise<string | null> {
  // `fetchWithDeadline` already returns the body as text and never throws — its `ok:false, status:0`
  // is the network error, the DNS failure and the timeout, which at this scale are all ordinary.
  const r = await fetchWithDeadline(url, { redirect: "follow" }, { deadlineMs: PAGE_DEADLINE_MS });
  if (!r.ok || !r.text) return null;
  // A JSON or PDF body is not a contact page. `json` being set is the cheapest signal we have that
  // this was not HTML, since the helper does not surface headers.
  if (r.json !== undefined) return null;
  return r.text.slice(0, MAX_HTML_BYTES);
}

/**
 * Read one business's site for a way to reach it.
 *
 * STOPS AT THE FIRST USABLE ADDRESS. The homepage yields one most of the time, and the remaining
 * pages exist for the sites that put contact details only behind /contact. Fetching all of them
 * regardless would triple the request count for no additional contacts on the common case.
 *
 * NEVER THROWS. A site that is down, slow, or serving a parking page is the ordinary case at this
 * scale, not an error worth failing a discovery run over.
 */
export async function contactsForSite(domain: string, company: string): Promise<SiteContact[]> {
  const host = domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!host || !host.includes(".")) return [];

  const urls = [`https://${host}/`, ...CONTACT_PATHS.slice(0, MAX_PAGES_PER_SITE - 1).map((p) => `https://${host}${p}`)];
  const merged: SiteContacts = { emails: [], phones: [], socials: {}, credits: [] };

  for (const url of urls) {
    const html = await page(url);
    if (!html) continue;
    const got = extractContacts(html, host);
    merged.emails.push(...got.emails);
    merged.phones.push(...got.phones);
    merged.socials = { ...got.socials, ...merged.socials };
    if (merged.emails.length) {
      return [
        {
          company,
          company_domain: host,
          email: merged.emails[0],
          ...(merged.phones[0] ? { phone: merged.phones[0] } : {}),
          ...(merged.socials.linkedin ? { linkedin_url: merged.socials.linkedin } : {}),
          source_url: url,
        },
      ];
    }
  }

  // No address, but a phone or a LinkedIn profile is still a way in and still worth filing.
  if (merged.phones.length || merged.socials.linkedin) {
    return [
      {
        company,
        company_domain: host,
        ...(merged.phones[0] ? { phone: merged.phones[0] } : {}),
        ...(merged.socials.linkedin ? { linkedin_url: merged.socials.linkedin } : {}),
        source_url: urls[0]!,
      },
    ];
  }
  return [];
}

/**
 * The same, across the businesses a cheap sweep found.
 *
 * CONCURRENCY IS BOUNDED and the whole pass has a wall-clock budget. This runs inside a task the
 * founder is watching; twenty sequential sites at eight seconds each is a discovery step that looks
 * hung, and unbounded parallelism against a shared egress IP is how the next sweep gets blocked.
 */
export async function contactsForSites(
  businesses: ReadonlyArray<{ name: string; domain: string }>,
  opts: { concurrency?: number; budgetMs?: number } = {},
): Promise<SiteContact[]> {
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 5, 10));
  const deadline = Date.now() + (opts.budgetMs ?? 60_000);
  const queue = [...businesses];
  const out: SiteContact[] = [];

  const worker = async () => {
    for (;;) {
      const b = queue.shift();
      if (!b || Date.now() > deadline) return;
      const got = await contactsForSite(b.domain, b.name);
      out.push(...got);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return out;
}

/**
 * File site contacts as people the sequencer can actually reach.
 *
 * NOT `writePeople`. That writes a `personRecord`, which hardcodes `source: "linkedin"` and has no
 * field for an address — it describes somebody found on LinkedIn, and these people were found on
 * their own website. Filing them through it would label every one of them as a LinkedIn find and
 * then drop the only thing that makes them contactable.
 *
 * THE KEY. `writePeople` refuses a row without a `public_id`, which for a site contact does not
 * exist. The convention here is the one `personKey` already uses in the outbound engine: the
 * LinkedIn slug when the site published one, then the address, then the domain. The last case is a
 * business with only a phone number — still worth filing, still one row per business rather than a
 * new one on every sweep.
 *
 * NEVER THROWS, for the same reason `writePeople` does not: the caller has the contacts in hand and
 * losing the write costs a re-sweep, while propagating the error costs a parked case and a
 * "discovery failed" on a step that worked.
 */
export async function writeSiteContacts(
  domain: { upsertRecord: (r: Record<string, unknown>) => Promise<unknown> },
  scope: { project_id?: string; case_id?: string },
  wedge: string,
  collection: string,
  contacts: readonly SiteContact[],
  at = new Date().toISOString(),
): Promise<number> {
  if (!scope.project_id) return 0;
  let n = 0;
  for (const c of contacts) {
    const slug = c.linkedin_url?.match(/linkedin\.com\/in\/([^/?#]+)/i)?.[1]?.toLowerCase();
    const key = slug ? slug : c.email ? `email:${c.email.toLowerCase()}` : `site:${c.company_domain}`;
    try {
      await domain.upsertRecord({
        project_id: scope.project_id,
        wedge,
        collection,
        key,
        data: {
          profile_id: key,
          company: c.company,
          company_key: c.company_domain,
          company_domain: c.company_domain,
          ...(c.email ? { email: c.email } : {}),
          ...(c.phone ? { phone: c.phone } : {}),
          ...(c.linkedin_url ? { linkedin_url: c.linkedin_url } : {}),
          // Says where this came from, which is the question a founder asks first about a stranger
          // in their pipeline. `source: "linkedin"` on a person nobody looked up on LinkedIn is the
          // specific lie this field exists to avoid.
          source: "website",
          source_url: c.source_url,
        },
        ...(scope.case_id ? { case_id: scope.case_id } : {}),
      });
      n++;
    } catch (e) {
      console.error(`[mycel] could not write site contact ${key}:`, e);
    }
  }
  return n;
}
