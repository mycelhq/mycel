// Read a business's own website for the things an enrichment vendor charges per-lead for.
//
// ── WHY THIS IS THE CHEAPEST STEP IN THE WATERFALL, BY A LOT ──────────────────────────────────
//
// FullEnrich and its competitors are, for this ICP, a wrapper around the open web: a service
// business publishes its email on its own contact page because it WANTS to be contacted. Paying per
// lead to be told a value that is sitting in public HTML is the single largest avoidable cost in
// the funnel. So the waterfall reads the site first and calls a paid vendor only for the leads
// worth money that the site did not yield.
//
// This file is PARSE ONLY — HTML in, structured contacts out. No fetching, no browser, no network.
// That is deliberate: the fetching layer has retries, proxies, robots handling and timeouts, none
// of which should be entangled with the part that has to be exactly right and is worth testing.
//
// ── AND THE SAME PASS FINDS WEB STUDIOS ───────────────────────────────────────────────────────
//
// Web development studios credit themselves in their clients' footers — "Site by Acme", "Designed
// & built by Acme", "Crafted by Acme". Extracting those credits turns any corpus of ordinary small
// business sites into a list of ACTIVE studios with proof of shipped work and a visible client.
// That is better targeting data than any directory sells, and unlike Clutch or Sortlist it comes
// from fetching normal public pages rather than fighting bot protection for data whose terms
// forbid the use.
//
// ── OBFUSCATION IS THE NORM, NOT THE EXCEPTION ────────────────────────────────────────────────
//
// Small business sites hide their address from naive scrapers constantly, and a regex for
// `\S+@\S+` finds maybe half of them. The forms below are all real and all common:
//
//     info [at] acme [dot] com          info&#64;acme.com          info(at)acme(dot)com
//     <a href="mailto:info@acme.com">    info AT acme DOT com       info&commat;acme.com
//
// Each is handled, because the ones that hide their address are disproportionately the ones a
// competitor's scraper missed.

import { cleanMailbox, isTemplateMailbox, normalizeEmail } from "./mailbox";

export const cleanScrapedEmail = cleanMailbox;

export interface SiteContacts {
  /** Best first. See `rankEmails` for what "best" means and why. */
  emails: string[];
  /** E.164 where confidently US, raw otherwise — normalisation belongs to identity.ts. */
  phones: string[];
  /** Handle-bearing social URLs, deduped, profile pages only. */
  socials: { linkedin?: string; twitter?: string; facebook?: string; instagram?: string };
  /** "Site by …" credits found in the page, for studio discovery. */
  credits: { studio: string; url?: string }[];
}

/**
 * Mailbox names that belong to a ROLE rather than a person.
 *
 * Kept and ranked last rather than dropped: for a five-person agency, `hello@` often reaches the
 * founder directly and is the only address on the site. Dropping it would discard the lead
 * entirely. Ranking it below a named mailbox is the correct trade.
 */
/**
 * ═══ THE ONE ROLE LIST, BECAUSE THERE WERE TWO AND THEY DRIFTED ═══
 *
 * `growth/lib/enrich/send.ts` kept its own `ROLE_LOCALS` and this kept `ROLE_MAILBOXES`. Each held
 * words the other lacked — this one had `ask`, `customerservice`, `service`; that one had
 * `partner`, `requests`, `orders` — so the same address was a desk on one side of the product and a
 * person on the other. Our own outbound and the agency platform disagreed about who may be mailed.
 *
 * It lives HERE because this package is the half both consume: `growth` is our admin, `kernel` is
 * what an agency runs, and both import `@mycel/sourcing`. A rule about who is mailable belongs
 * where both can read it, not in one app's lib directory.
 *
 * The words below are the union, plus what four real hard bounces taught on 2 September:
 * `requests@` was absent, and `partner@` was absent because only `partnerships` was listed.
 *
 * Extended again on 7 September from the live queue rather than from imagination. Of 174 addresses
 * due to be mailed that day, twenty were a desk and this list let eight of them through:
 * `leads@indigousa.com`, `client@rightsem.com`, `ideas@delaneymatrix.com`, `dev@click4corp.com`,
 * `talent@liquidagency.com` among them. Each is a shared inbox that reaches a rota, so it can never
 * book a meeting, and it spends one of thirty sends a day and carries the complaint risk that costs
 * the whole fleet weeks of warm-up ramp.
 *
 * Singular AND plural are both listed because this Set is matched literally — `clients` was here
 * and `client@` was mailed anyway.
 */
export const ROLE_MAILBOXES = new Set([
  "info", "hello", "contact", "contactus", "sales", "support", "admin", "office", "team", "help",
  "enquiries", "inquiries", "enquiry", "inquiry", "mail", "email", "general", "hi", "hey", "ask",
  "service", "services", "customerservice", "marketing", "press", "media", "careers", "jobs", "hr",
  "billing", "accounts", "accounting", "newbusiness", "partnerships", "partner", "partners",
  "requests", "request", "bookings", "booking", "reservations", "reservation", "orders", "order",
  "quotes", "quote", "estimates", "estimate", "scheduling", "reception", "frontdesk", "studio",
  "events", "event", "connect", "success", "grow", "noreply", "no-reply", "donotreply",
  "webmaster", "postmaster", "abuse", "privacy", "legal",
  "leads", "lead", "client", "clients", "ideas", "idea", "dev", "developer", "developers",
  "talent", "recruiting", "recruitment", "discovery", "discoverycall", "askus", "generalinfo",
  // 7 September, second pass. `forms@rivalmind.com` hard-bounced — "Recipient address rejected:
  // User email address is marked as invalid" — and cost a day of ramp on a fleet already clamped
  // to five a day by its complaint history. The rest were queued behind it.
  "forms", "form", "agency", "artwork", "design", "seo", "solutions", "systems", "website", "web",
  "start", "learnmore", "letstalk", "talk", "hire", "apply", "network",
]);

/**
 * Damerau-lite: is `a` reachable from `b` in one insertion, deletion or substitution?
 *
 * Exported because the greeting gate needs the same question asked of a name.
 */
export function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (long.length - short.length > 1) return false;
  let i = 0;
  let j = 0;
  let slack = 1;
  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) {
      i++;
      j++;
      continue;
    }
    if (slack-- === 0) return false;
    if (short.length === long.length) i++;
    j++;
  }
  return true;
}

/**
 * Is this address a desk rather than a person?
 *
 * Separators are stripped, so `new.business@` and `contact_us@` cannot hide behind punctuation.
 *
 * Matching is NOT exact. rc-studios.com publishes `nquiries@` — their own typo for `inquiries@` —
 * and it walked through every gate, was greeted "Hi Nquiries," and hard-bounced. A word one edit
 * from a desk word is still the desk, and no list can enumerate the typos of its own entries.
 *
 * Bounded to five letters or more: below that a single edit genuinely reaches real names (ana, jo,
 * tom), and a neutral miss costs a real prospect.
 */
export function isRoleMailbox(email: string): boolean {
  const raw = email.split("@")[0]?.toLowerCase() ?? "";
  const local = raw.replace(/[._-]/g, "");
  if (!local) return false;
  if (ROLE_MAILBOXES.has(local)) return true;

  /**
   * ═══ A COMPOUND OF A DESK WORD IS STILL THE DESK ═══
   *
   * The Set is matched whole, so it caught `support@` and missed `websupport@`, `techsupport@` and
   * `supportteam@`. Of 93 addresses queued on 7 September, 22 were neither a known desk nor a
   * plausible first name, and nearly every one was a compound of a word already in this list:
   * `internationalsales`, `webinfo`, `infobits`, `contact2023`, `hellochicago`, `theteam`.
   *
   * `hasDeskAffix` in growth/lib/copy/names.ts fixed exactly this for the GREETING gate the same
   * morning; the SEND gate kept the whole-word rule. So a compound was refused a name and then
   * mailed anyway.
   *
   * A matched half must be at least four characters and leave at least two behind, which is what
   * keeps `jeff.klein` — a real person, and the one true name in that list of 22 — out of it.
   * A dotted local part is checked SEGMENT BY SEGMENT first for the same reason: `jeff` and `klein`
   * are names, and only the joined form could ever collide with a desk word by accident.
   */
  const segments = raw.split(/[._-]+/).filter(Boolean);
  if (segments.length > 1 && segments.every((seg) => !ROLE_MAILBOXES.has(seg))) {
    // first.last and friends: no segment is a desk, so the join is not one either.
    return false;
  }
  for (let n = 4; n <= local.length - 2; n++) {
    if (ROLE_MAILBOXES.has(local.slice(0, n)) || ROLE_MAILBOXES.has(local.slice(local.length - n))) {
      return true;
    }
  }

  if (local.length < 5) return false;
  for (const role of ROLE_MAILBOXES) {
    if (role.length >= 5 && withinOneEdit(local, role)) return true;
  }
  return false;
}

/** Image and asset extensions that regularly look like the tail of an email. */
const ASSET_TAIL = /\.(png|jpe?g|gif|svg|webp|css|js|woff2?|ttf|ico|mp4|pdf)$/i;

/**
 * Undo the common ways an address is hidden, before any matching happens.
 *
 * Order matters. HTML entities are decoded FIRST, because `&#64;` must become `@` before the
 * `[at]` rules run, and the bracket forms must be normalised before the bare-word `AT` rule — which
 * is the loosest and would otherwise corrupt ordinary prose containing the word "at".
 */
export function deobfuscate(html: string): string {
  let s = html;
  s = s.replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
  s = s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
  s = s.replace(/&commat;/gi, "@").replace(/&period;/gi, ".").replace(/&amp;/gi, "&");
  s = s.replace(/\s*[[({]\s*at\s*[\])}]\s*/gi, "@");
  s = s.replace(/\s*[[({]\s*dot\s*[\])}]\s*/gi, ".");
  // Bare-word forms: require whitespace on both sides AND a plausible label either side, so
  // "look at dot com pricing" in body copy is not turned into an address.
  s = s.replace(/([a-z0-9._%+-]+)\s+at\s+([a-z0-9.-]+)\s+dot\s+([a-z]{2,})/gi, "$1@$2.$3");
  return s;
}

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}/gi;

/**
 * Is this a plausible, mailable business address?
 *
 * Clean first (the same `normalizeEmail` ingest uses), then the send gate. Scrape and send
 * cannot disagree: a leftover `%20hello@` becomes `hello@` here, and `john@company.com` is
 * refused here and at send. Asset filenames are the one extra check, because `.png` is a
 * legal TLD to the syntax regex and never a mailbox.
 */
export function isPlausibleEmail(raw: string): boolean {
  const e = normalizeEmail(raw);
  if (!e) return false;
  const domain = e.slice(e.lastIndexOf("@") + 1);
  if (ASSET_TAIL.test(domain)) return false;
  return !isTemplateMailbox(e);
}

/**
 * Best address first.
 *
 * The ordering is the whole value of this function, because the caller sends to `emails[0]`:
 *
 *   1. ON THE BUSINESS'S OWN DOMAIN. An address at the site we are reading is theirs; a gmail in
 *      the footer is usually a web designer's or a stock template's.
 *   2. A NAMED MAILBOX over a role mailbox — `sarah@` reaches a person, `info@` reaches a queue
 *      that a junior filters.
 *   3. SHORTER, as a stable tiebreak so the same page always yields the same first address. A
 *      pipeline that picks a different address on re-crawl creates a duplicate touch.
 */
export function rankEmails(emails: string[], ownDomain?: string | null): string[] {
  const seen = new Set<string>();
  const uniq = emails
    .map((e) => normalizeEmail(e))
    .filter((e): e is string => {
      if (!e || !isPlausibleEmail(e) || seen.has(e)) return false;
      seen.add(e);
      return true;
    });

  return uniq.sort((a, b) => {
    const da = a.split("@")[1] ?? "";
    const db = b.split("@")[1] ?? "";
    if (ownDomain) {
      const oa = da === ownDomain || da.endsWith(`.${ownDomain}`);
      const ob = db === ownDomain || db.endsWith(`.${ownDomain}`);
      if (oa !== ob) return oa ? -1 : 1;
    }
    // The same question the send gate asks, so a typo'd desk ranks last too.
    const ra = isRoleMailbox(a);
    const rb = isRoleMailbox(b);
    if (ra !== rb) return ra ? 1 : -1;
    return a.length - b.length || a.localeCompare(b);
  });
}

const SOCIAL_PATTERNS: { k: keyof SiteContacts["socials"]; re: RegExp }[] = [
  { k: "linkedin", re: /https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/(?:company|in)\/[A-Za-z0-9_%-]+/i },
  { k: "twitter", re: /https?:\/\/(?:www\.)?(?:twitter|x)\.com\/(?!share|intent|home)[A-Za-z0-9_]{2,15}/i },
  { k: "facebook", re: /https?:\/\/(?:www\.)?facebook\.com\/(?!sharer|share|tr\?)[A-Za-z0-9.\-]{3,}/i },
  { k: "instagram", re: /https?:\/\/(?:www\.)?instagram\.com\/(?!p\/|reel\/)[A-Za-z0-9_.]{2,30}/i },
];

/**
 * "Site by …" credits.
 *
 * The capture stops at punctuation and at common trailing words so "Site by Acme Studio. All rights
 * reserved" yields "Acme Studio" rather than the rest of the footer. Anything implausibly long is
 * dropped: a runaway match is always a parse failure, never a studio with a 90-character name.
 */
const CREDIT_RE =
  /(?:site|website|design(?:ed)?|develop(?:ed)?|built|crafted|made|created)\s*(?:&(?:amp;)?|and|\/|,)?\s*(?:designed|developed|built|powered)?\s*by[:\s]+([A-Z][A-Za-z0-9&'’.\- ]{1,48}?)(?=\s*(?:[.|·•©<]|$|\ball rights\b|\bin \d{4}\b))/gi;

const CREDIT_STOPWORDS = new Set(["us", "me", "hand", "the team", "our team", "you", "yourself"]);

export function extractCredits(text: string): { studio: string }[] {
  const out: { studio: string }[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(CREDIT_RE)) {
    const studio = (m[1] ?? "").trim().replace(/\s{2,}/g, " ").replace(/[.,\s]+$/, "");
    const key = studio.toLowerCase();
    // THE CAPITAL IS CHECKED HERE, NOT IN THE PATTERN. The regex needs `i` so it matches "Site by"
    // and "SITE BY" alike — and that same flag silently defeats the `[A-Z]` that was supposed to
    // require a proper noun, so "Made by us with love" was captured as the studio "us with love".
    // A studio name is capitalised; a fragment of prose is not.
    if (!/^[A-Z]/.test(studio)) continue;
    if (!studio || studio.length < 2 || CREDIT_STOPWORDS.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push({ studio });
  }
  return out;
}

/** Strip tags, scripts and styles so text rules do not match inside markup or minified JS. */
export function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
}

/**
 * Everything contactable on one page.
 *
 * `ownDomain` is the business's registrable domain from `identity.ts`; passing it is what makes the
 * ranking useful, and omitting it degrades to "named mailboxes first" rather than failing.
 */
export function extractContacts(html: string, ownDomain?: string | null): SiteContacts {
  const decoded = deobfuscate(html);
  const text = visibleText(decoded);

  // mailto: links are the highest-confidence source — an author wrote them deliberately — so they
  // lead the list before ranking refines it.
  const mailtos = [...decoded.matchAll(/mailto:([^"'?>\s]+)/gi)].map((m) => m[1] ?? "");
  const inText = [...`${text} ${decoded}`.matchAll(EMAIL_RE)].map((m) => m[0]);
  const emails = rankEmails([...mailtos, ...inText], ownDomain);

  const phones = [...new Set([...decoded.matchAll(/tel:\+?([0-9().\-\s]{7,20})/gi)].map((m) => (m[1] ?? "").trim()))];

  const socials: SiteContacts["socials"] = {};
  for (const { k, re } of SOCIAL_PATTERNS) {
    const hits = [...decoded.matchAll(new RegExp(re, re.flags.includes("g") ? re.flags : `${re.flags}g`))].map(
      (m) => m[0],
    );
    if (k === "linkedin") {
      // A company page is not a person — personKey refuses it. Prefer /in/ so a team page that
      // also has the company footer still yields someone we can sequence.
      const personal = hits.find((u) => /linkedin\.com\/in\//i.test(u));
      socials.linkedin = personal ?? hits[0];
    } else if (hits[0]) {
      socials[k] = hits[0];
    }
  }

  return { emails, phones, socials, credits: extractCredits(text) };
}

/**
 * Pages worth fetching, in order, for a site whose homepage we already have.
 *
 * Short and ordered by hit rate rather than exhaustive: each extra path is a request against a
 * budget, and past these the yield collapses. `/contact` alone resolves the large majority.
 */
export const CONTACT_PATHS = ["/contact", "/about", "/team", "/contact-us", "/about-us", "/get-in-touch"];
