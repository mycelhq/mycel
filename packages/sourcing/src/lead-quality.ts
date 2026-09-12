// ═══ WHAT IS NOT A LEAD ═══
//
// A discovery sweep files whatever it finds, and what it finds includes rows that are not people.
// A founder's pipeline showed, between real prospects: "Agora Software", "Teranga Software",
// "Altena-Software", "International Software Company", "Dlubal Software FR" — each with the company
// name in the person's name field, no face, no headline, and nothing to send to.
//
// They are not harmless. Every one is a card the founder has to read and dismiss, a slot in the
// "26 on file" count that implies work that has not happened, and — if a campaign enrols them — a
// message addressed to a limited company by name.
//
// TWO PLACES THIS RUNS, and it has to be both:
//   · at WRITE time, so junk never enters the graph;
//   · as a SWEEP, because the rows already in there were written before this existed.
//
// JUDGEMENT, NOT A BLOCKLIST. The test is structural — does this name describe an organisation, is
// it the same string as its own employer, is there any way to reach it — so it holds for trades and
// languages nobody thought about. A blocklist of company names would need a new entry per country.

/** What a lead has to be judged on. Every field optional: absence is most of the signal. */
export interface LeadLike {
  name?: string | null;
  company?: string | null;
  company_domain?: string | null;
  email?: string | null;
  linkedin_url?: string | null;
  phone?: string | null;
  headline?: string | null;
  title?: string | null;
}

export interface LeadVerdict {
  keep: boolean;
  /** Why it was dropped, in words a founder would accept. Absent when kept. */
  reason?: string;
}

/**
 * Legal forms and organisation words, across the markets this actually runs in. A PERSON is not
 * called any of these; matching one as a whole word is decisive about a name that is a company.
 *
 * `software` and `technologies` are here because they were the actual offenders, and they are safe:
 * they are the tail of a company name, never a person's name.
 */
const ORG_WORDS =
  /\b(inc|llc|ltd|limited|plc|corp|corporation|company|co|gmbh|ag|kg|ug|sarl|sas|sasu|eurl|sa|bv|nv|ab|oy|a\/s|aps|spa|srl|sl|pty|pte|kft|zoo|sp\s?z\s?o\s?o|holdings?|group|groupe|partners|associates|ventures|capital|studios?|agency|agence|consulting|solutions|systems|technologies|technology|software|digital|labs?|media|industries|international|worldwide|global|enterprises?|services)\b/i;

/** Marks that only ever appear in a trading name. */
const ORG_MARKS = /(&|\+|\/|@|\.(com|io|co|net|org|fr|de|nl|es|it|uk)\b|\bs\.?a\.?r\.?l\.?|\bs\.?a\.?s\.?)/i;

/** A placeholder a scraper produced rather than a person a human named. */
const PLACEHOLDER =
  /^(n\/?a|none|null|undefined|unknown|test|sample|example|linkedin member|member|user|guest|admin|info|contact|team|support|sales|hello|owner|founder|profile|anonymous)$/i;

const clean = (s: string | null | undefined) => (typeof s === "string" ? s.trim() : "");
const fold = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

/**
 * Does this string name an organisation rather than a person?
 *
 * Exported because the same question is asked of a scraped contact name, an imported CSV column and
 * a LinkedIn search row, and it must be answered identically in all three.
 */
export function looksLikeOrganisation(raw: string | null | undefined): boolean {
  const s = clean(raw);
  if (!s) return false;
  if (ORG_MARKS.test(s)) return true;
  if (ORG_WORDS.test(s)) return true;
  // FOUR OR MORE WORDS is a description, not a name. "Siyam Kham Business Software",
  // "Software Technology Resources". Three is still plausible for a person with two surnames.
  if (s.split(/\s+/).filter(Boolean).length >= 4) return true;
  return false;
}

/**
 * Is there any way at all to reach this lead?
 *
 * A row with no address, no profile and no number is not a prospect, whatever else it has. It
 * cannot be sequenced, so it can only ever be a card somebody scrolls past.
 */
export function isReachable(l: LeadLike): boolean {
  return !!(clean(l.email) || clean(l.linkedin_url) || clean(l.phone));
}

/**
 * Keep or drop, with the sentence to say about it.
 *
 * ORDER MATTERS: the most specific reason wins, so a founder reading "this was the company's own
 * name" is told the real thing rather than the generic "no way to contact them".
 */
export function judgeLead(l: LeadLike): LeadVerdict {
  const name = clean(l.name);
  const company = clean(l.company);

  if (!name && !clean(l.email) && !clean(l.linkedin_url)) {
    return { keep: false, reason: "no name and no way to reach them" };
  }
  if (PLACEHOLDER.test(name)) {
    return { keep: false, reason: `"${name}" is a placeholder, not a person` };
  }
  // The exact offender in the founder's pipeline: the person IS the company.
  if (name && company && fold(name) === fold(company)) {
    return { keep: false, reason: `"${name}" is the company's own name, not somebody who works there` };
  }
  if (name && company && fold(company).length > 4 && fold(name) === fold(company).replace(/(fr|uk|us|de|nl|es|it)$/, "")) {
    return { keep: false, reason: `"${name}" is the company's own name, not somebody who works there` };
  }
  if (looksLikeOrganisation(name) && !clean(l.headline) && !clean(l.title)) {
    // A NAME THAT READS AS A COMPANY, with nothing human attached. The headline check matters:
    // "Elena Debbaut · Turnaround • Strategic Execution" is a real person whose name happens to be
    // unusual, and a real headline is the strongest evidence there is a human here.
    return { keep: false, reason: `"${name}" is a company, not a person` };
  }
  if (!isReachable(l)) {
    return { keep: false, reason: "no email, profile or phone — there is no way to contact them" };
  }
  return { keep: true };
}

/** Partition a batch. Returns what to keep and what was dropped, with reasons, for the log. */
export function screenLeads<T extends LeadLike>(leads: readonly T[]): {
  keep: T[];
  dropped: Array<{ lead: T; reason: string }>;
} {
  const keep: T[] = [];
  const dropped: Array<{ lead: T; reason: string }> = [];
  for (const l of leads) {
    const v = judgeLead(l);
    if (v.keep) keep.push(l);
    else dropped.push({ lead: l, reason: v.reason ?? "not a usable lead" });
  }
  return { keep, dropped };
}
