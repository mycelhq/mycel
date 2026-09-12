// Mailbox parsing and judgement, shared by the outbound engine and the kernel's GTM.
//
// MOVED HERE, NOT COPIED. It lived in `growth/lib/` and the kernel needed the same rules the moment
// it started reading contacts off a business's own website. A second copy of "is this address real"
// goes wrong quietly: one side learns a new obfuscation or a new template domain and the other
// keeps enrolling addresses that bounce. `growth` re-exports from here, so every existing import
// path still resolves and there is exactly one definition.

/**
 * An address, or null.
 *
 * Clean first — the same leftovers that stripping `mailto:` already handled. `%20hello@…` and
 * `\u003ehello@…` are the inbox the author wrote, with scrape junk in front; mailing the raw
 * string is a 550. Then the local part is judged narrower than RFC 5321, because `/` is legal
 * unquoted and is how `//info@gordowebdesign.com` became a person key.
 */
export function cleanMailbox(raw: string): string {
  let e = raw.trim().toLowerCase();
  e = e.replace(/^mailto:\/*/, "").trim();
  try {
    e = decodeURIComponent(e);
  } catch {
    /* malformed percent-encoding stays; the shape check below refuses leftover `%` */
  }
  // JSON `\u0022` / HTML `&gt;` that never got decoded. One leading escape only — a real local
  // part does not start this way, and stripping more would eat `u00` out of a legitimate name.
  e = e.replace(/^u00[0-9a-f]{2}/i, "").replace(/^[\s<>"'`]+/, "").replace(/[.@]+$/g, "");
  return e.trim();
}

export const normalizeEmail = (email: string | null | undefined): string | null => {
  if (!email) return null;
  const e = cleanMailbox(email);
  // The local part is deliberately NARROWER than RFC 5321 allows. `/` is a legal unquoted
  // character and is the one that let `//info@...` through — it is also a character no agency has
  // ever put in a contact address, so admitting it buys nothing and costs exactly this bug. Same
  // for the rest of the punctuation set. What is left is what real addresses use.
  if (!/^[a-z0-9._%+'-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(e)) return null;
  // A leading, trailing or doubled dot in the local part is invalid and is what a mangled scrape
  // looks like. The pattern above already refuses these; this is the assertion that says so.
  const local = e.slice(0, e.indexOf("@"));
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return null;
  return e;
};

/**
 * Theme boilerplate, never a prospect.
 *
 * WordPress / Elementor / "contact us" kits ship `john@company.com` in the HTML. Ranked as a
 * named mailbox it beats `info@their-real-domain.com`, becomes the person, and gets enrolled.
 * Mailing it is a bounce on a warming inbox. These hosts are not businesses we sell to.
 */
export const TEMPLATE_DOMAINS = new Set([
  "example.com",
  "example.org",
  "example.net",
  "domain.com",
  "yourdomain.com",
  "email.com",
  "company.com",
  "company.net",
  "company.org",
  "yourcompany.com",
  "mycompany.com",
  "companyname.com",
  "website.com",
  "mysite.com",
  "yoursite.com",
  "sitename.com",
  "placeholder.com",
  "sample.com",
  "test.com",
  "sentry.io",
  "wixpress.com",
  "godaddy.com",
  "squarespace.com",
  "wordpress.org",
  "w3.org",
  "schema.org",
  "googleapis.com",
  "gstatic.com",
  "cloudflare.com",
  "jquery.com",
  "bootstrapcdn.com",
]);

export const TEMPLATE_LOCALS = new Set([
  "you",
  "your",
  "email",
  "youremail",
  "name",
  "username",
  "user",
  "test",
  "sample",
  "dummy",
  "placeholder",
  "example",
]);

/**
 * Addresses that cannot receive mail, judged by SHAPE rather than by a list of known-bad domains.
 *
 * ═══ WHY A LIST WAS NEVER GOING TO BE ENOUGH ═══
 *
 * Production held sixteen addresses of the form `frame-<32 hex>@mhtml.blink`, ten of them enrolled
 * and queued to send. That string is what a browser writes into a page it has SAVED — MHTML
 * serialises each frame under a synthetic content-id — so a scraper read a saved copy of a site and
 * harvested the plumbing as if it were contact details.
 *
 * `mhtml.blink` was never going to be on a blocklist, because nobody would think to add it. Neither
 * will the next artifact. And the cost is not a wasted send: these are GUARANTEED hard bounces, at
 * a moment when the sending domains were five days into a warm-up ramp, and bounce rate is the
 * number AWS suspends a sending identity over. A handful is enough to matter.
 *
 * So this asks structural questions with definite answers, which generalise to artifacts nobody has
 * seen yet.
 */
export function isUndeliverableShape(local: string, domain: string): boolean {
  const tld = domain.slice(domain.lastIndexOf(".") + 1);

  /**
   * TLDs that are reserved, private, or invented by software. RFC 2606 and RFC 6761 set aside
   * test/example/invalid/localhost precisely so they can never resolve; `local`, `internal`, `lan`
   * and `home` are private-network conventions; `blink` is Chromium's serialiser. None of them can
   * receive mail from the public internet, by definition rather than by policy.
   */
  const RESERVED_TLDS = new Set([
    "blink", "test", "example", "invalid", "localhost", "local", "internal", "lan", "home", "arpa",
  ]);
  if (RESERVED_TLDS.has(tld)) return true;

  // A TLD is letters. A trailing numeric label means the "domain" was an IP or a version string
  // that something mistook for a host.
  if (!/^[a-z]{2,24}$/.test(tld)) return true;

  /**
   * A hex blob is a machine identifier, not a person. `frame-00c5eb434a2d1df783505bff6b16540b` is
   * the exact shape MHTML emits; 16+ unbroken hex characters is not something anyone types into a
   * mailbox name, and requiring the whole run to be hex keeps ordinary words safe.
   */
  if (/[0-9a-f]{16,}/.test(local)) return true;

  /**
   * A marketing slogan in the local part, e.g.
   * `bookameetingwithansapbusinessonesolutionexpertnow@…`.
   *
   * Forty characters is deliberately generous — real addresses use first.last and initials, and the
   * longest plausible human local part is nowhere near it. Anything this long is a landing-page
   * alias or a catch-all, and a catch-all accepts everything and reads nothing, which is worse than
   * a bounce: it looks delivered while reaching no one.
   */
  if (local.length > 40) return true;

  /**
   * A guessed company-shaped local on any host. Production mailed `onum_company@mail.com` — a
   * slug plus `_company` stuffed onto a consumer webmail domain — and mail.com 550'd it. Nobody
   * names a mailbox that. The same suffix on a real corporate host is equally a scrape artifact.
   */
  if (/_company$/.test(local) || /^company_/.test(local)) return true;

  // The textbook placeholder, found queued as john@acme.com for a firm that is not Acme.
  // Not the whole of acme.com — that is a real company, and blocking it would drop a real lead.
  if ((local === "john" || local === "jane") && domain === "acme.com") return true;

  /**
   * Scraper leftovers, found queued on 2 Sep 2026:
   *   `%20hello@madewithnrg.com`     a URL-encoded space from an href
   *   `u0022webmaster@…` / `u003ehello@…`  JSON `\u0022` / HTML `&gt;` that never got decoded
   * Percent-encoding and JS unicode escapes are not how anyone types an inbox name.
   */
  if (/%/.test(local)) return true;
  if (/^u00[0-9a-f]{2}/i.test(local)) return true;

  return false;
}

export function isTemplateMailbox(email: string): boolean {
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at < 1) return false;
  const local = e.slice(0, at);
  const domain = e.slice(at + 1);
  return TEMPLATE_DOMAINS.has(domain) || TEMPLATE_LOCALS.has(local) || isUndeliverableShape(local, domain);
}
