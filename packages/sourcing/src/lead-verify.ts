// ═══ IS THIS LEAD STILL TRUE? ═══
//
// `lead-quality.ts` asks whether a row is a PERSON — structural, pure, no network. This asks the
// other question, and it is the one that costs money to get wrong: the row was true when it was
// filed, and the world has moved since.
//
// The founder's own examples, both real:
//
//   · a LinkedIn URL on file that now 404s — the profile was renamed, or deleted
//   · a website on file that redirects to a hospital — the domain changed hands, or the person
//     changed careers and the page about them is years old
//
// No amount of email verification catches either. A verifier answers "does this mailbox accept
// mail", which a hospital's mailbox does. We would spend a send, a warming inbox's daily ramp and
// the one first impression on somebody who is not there.
//
// ═══ WHAT THIS DELIBERATELY IS NOT ═══
//
// It is not a scoring model and it does not ask a language model anything. Every check below is a
// FREE signal we can get from a request we were already going to make, and each one refuses only
// on POSITIVE evidence that the record is stale. That asymmetry is the whole design:
//
//   · a 404 from LinkedIn is evidence. A timeout is not.
//   · a redirect to a different registrable domain is evidence. A redirect to www is not.
//   · a site that never once names the business we recorded is evidence. A site we could not read
//     is not.
//
// FAILS OPEN, everywhere. A network blip must never delete a good lead: the cost of wrongly
// keeping one is a single send, and the cost of wrongly dropping one is a prospect we never
// contact and never learn about. Where this cannot tell, it says so and the lead survives.

/** The record as it was filed, and what we would be trusting if nobody checked. */
export interface RecordedLead {
  /** The business name Maps or the directory gave us. */
  company?: string | null;
  /** The registrable domain we recorded for them. */
  domain?: string | null;
  /** A LinkedIn profile URL, when one was found. */
  linkedinUrl?: string | null;
  /** The person we believe works there. */
  personName?: string | null;
}

export type StaleReason =
  /** The LinkedIn profile is gone: renamed, deleted, or never existed. */
  | "linkedin_gone"
  /** The site redirects somewhere unrelated — the domain moved on. */
  | "domain_moved"
  /** The site is live and never names the business we recorded. */
  | "not_this_business"
  /** The site is live, names the business, and no longer names the person. */
  | "person_gone";

export interface LeadFreshness {
  /** True when nothing contradicted the record. Absence of evidence keeps the lead. */
  fresh: boolean;
  /** Every contradiction found, so a founder can see WHICH part went stale. */
  stale: StaleReason[];
  /** One sentence, in words a founder would accept, or "" when fresh. */
  reason: string;
  /** Checks that could not run — a timeout, an unreadable page. Never a reason to drop. */
  unchecked: string[];
}

/** Fold to comparable letters. `R&C Studios, Inc.` and `rc studios` become the same string. */
export function fold(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\band\b/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

/**
 * LEGAL FORMS ONLY, and the distinction matters.
 *
 * "Inc" is not part of an identity: "Northlight Grounds LLC" and "Northlight Grounds" are the same
 * firm and a site prints the shorter one. But "Studios" IS — strip it from "R&C Studios" and what
 * is left is "rc", which matches almost anything. An earlier version of this stripped trade words
 * too and could not recognise a business by its own name.
 */
const LEGAL_FORM =
  /\b(inc|llc|l\.l\.c|ltd|limited|plc|corp|corporation|company|co|gmbh|ag|sarl|sas|sasu|eurl|bv|nv|ab|oy|aps|spa|srl|sl|pty|pte|kft)\b/gi;

/** The name with its legal form removed — what the site itself would print. */
export function nameStem(company: string): string {
  const stripped = fold(company.replace(LEGAL_FORM, " "));
  // A business literally called "Co" keeps its whole name rather than becoming empty.
  return stripped.length >= 3 ? stripped : fold(company);
}

/**
 * The leading distinctive word, for the common case where a site prints only the first part.
 *
 * "Northlight Grounds LLC" on file, "Welcome to Northlight" on the page: the stem
 * `northlightgrounds` is not in that text, but `northlight` is, and it is the same firm. Requires
 * five letters, because a short leading token ("the", "new", "rc") appears inside ordinary words
 * and would match any page at all.
 */
export function leadToken(company: string): string {
  for (const raw of company.replace(LEGAL_FORM, " ").split(/[^A-Za-z0-9]+/)) {
    const t = fold(raw);
    if (t.length >= 5) return t;
  }
  return "";
}

/**
 * Does this page still name the business we recorded?
 *
 * Deliberately generous. A match anywhere in the visible text counts, because a real site prints
 * its own name in the header, the footer, the copyright line and the title — and a page that
 * prints it NOWHERE is a page about something else. Short stems are refused rather than matched:
 * a three-letter stem appears inside ordinary words and would make this check meaningless.
 */
export function siteNamesBusiness(company: string, siteText: string): boolean | null {
  const text = fold(siteText);
  /**
   * A PAGE TOO THIN TO READ CANNOT DISPROVE A NAME.
   *
   * This is the same rule the header states for an unreachable site, and it was missed for a site
   * that IS reachable and simply has little text: an image-heavy homepage, a JS-rendered page that
   * plain fetch sees empty, a splash screen. Concluding "not this business" from forty characters
   * is drawing a conclusion from a fetch that failed in a way that returned 200.
   *
   * Caught by five existing promote tests, whose fixtures are a mailto and a phone link — which is
   * exactly what a real minimal page looks like.
   */
  if (text.length < 120) return null;
  const stem = nameStem(company);
  const token = leadToken(company);
  // Nothing long enough to be distinctive — cannot tell, and must not count against the lead.
  if (stem.length < 4 && token.length < 5) return null;
  if (stem.length >= 4 && text.includes(stem)) return true;
  if (token.length >= 5 && text.includes(token)) return true;
  return false;
}

/**
 * The registrable domain, so `www.acme.com` and `acme.com` compare equal and a redirect to a
 * genuinely different owner does not.
 *
 * Not a public-suffix implementation: this keeps the last two labels, which is right for `.com`
 * and wrong for `.co.uk` in the direction that is SAFE — it treats `a.co.uk` and `b.co.uk` as the
 * same registrable domain and therefore does NOT flag a redirect between them. Under-flagging is
 * the correct failure for a check that deletes leads.
 */
export function registrable(host: string): string {
  const parts = host.toLowerCase().replace(/^www\./, "").split(".").filter(Boolean);
  return parts.length <= 2 ? parts.join(".") : parts.slice(-2).join(".");
}

export interface FreshnessDeps {
  /**
   * Status of a HEAD/GET against a URL. Return null when the request could not be made at all —
   * that is "unchecked", not "gone".
   */
  statusOf?: (url: string) => Promise<number | null>;
  /** The page as finally served: its LANDING url after redirects, and its visible text. */
  readSite?: (url: string) => Promise<{ finalUrl: string; text: string } | null>;
}

/**
 * LinkedIn's answer to a profile that is not there.
 *
 * 404 and 410 are the honest ones. 999 is LinkedIn refusing US, not the profile being gone — it is
 * their anti-scraping response and treating it as evidence would delete every lead the moment we
 * were rate-limited. 429 likewise.
 */
const GONE = new Set([404, 410]);

/**
 * Check a filed lead against the world as it is now.
 *
 * Order is by cost: the LinkedIn HEAD is one cheap request; the site read is the expensive one and
 * runs once, with both site-derived checks drawn from the same fetch.
 */
export async function verifyLead(lead: RecordedLead, deps: FreshnessDeps = {}): Promise<LeadFreshness> {
  const stale: StaleReason[] = [];
  const unchecked: string[] = [];

  if (lead.linkedinUrl && deps.statusOf) {
    const status = await deps.statusOf(lead.linkedinUrl).catch(() => null);
    if (status == null) unchecked.push("linkedin");
    else if (GONE.has(status)) stale.push("linkedin_gone");
  } else if (lead.linkedinUrl) {
    unchecked.push("linkedin");
  }

  if (lead.domain && deps.readSite) {
    const site = await deps.readSite(`https://${lead.domain}`).catch(() => null);
    if (!site) {
      // A site we cannot read is not a site that moved. Sourcing already records unreachable
      // domains separately; this check has nothing to say about them.
      unchecked.push("site");
    } else {
      let landedElsewhere = false;
      try {
        const landed = registrable(new URL(site.finalUrl).hostname);
        landedElsewhere = !!landed && landed !== registrable(lead.domain);
        if (landedElsewhere) stale.push("domain_moved");
      } catch {
        unchecked.push("site_url");
      }

      // Only ask "is this still them" of a page that did not already announce it is somewhere
      // else — otherwise a domain sale reports twice for one fact.
      if (!landedElsewhere && lead.company) {
        const named = siteNamesBusiness(lead.company, site.text);
        if (named === null) unchecked.push("company_name");
        else if (!named) stale.push("not_this_business");
        else if (lead.personName) {
          // The site IS theirs and still does not mention the person: they left, or they were
          // never on it. Checked last and only here, because on somebody else's site the absence
          // of our contact says nothing.
          const person = fold(lead.personName);
          if (person.length >= 5 && !fold(site.text).includes(person)) stale.push("person_gone");
        }
      }
    }
  } else if (lead.domain) {
    unchecked.push("site");
  }

  return { fresh: stale.length === 0, stale, reason: describe(stale, lead), unchecked };
}

/** The sentence a founder reads next to a dropped lead. Names the fact, not the rule. */
function describe(stale: StaleReason[], lead: RecordedLead): string {
  if (stale.length === 0) return "";
  const who = lead.company || lead.domain || "this lead";
  const parts: string[] = [];
  if (stale.includes("linkedin_gone")) parts.push("their LinkedIn profile no longer exists");
  if (stale.includes("domain_moved")) parts.push(`${lead.domain} now redirects to a different site`);
  if (stale.includes("not_this_business")) parts.push(`the site at ${lead.domain} is not ${who} any more`);
  if (stale.includes("person_gone")) parts.push(`${lead.personName} is no longer named on their site`);
  return `${parts.join("; ")} — filed before that changed, so it was not worth a send.`;
}
