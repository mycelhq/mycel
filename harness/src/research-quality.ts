// ═══ HOW GOOD WAS THE RESEARCH, AS A NUMBER ═══
//
// `research_service` is the only job in this product that leaves the building, and it is the answer
// to the thing the meta-agent is measurably worst at: a judge playing the founder scores a written
// service 3 or below when it is general business admin in the trade's vocabulary, and 8 or above
// when it names the trade's real artefacts, deadlines and counterparties. Those facts are not in the
// model's priors for most trades. They are on the open web, written down by the people who do the
// work.
//
// So the research step matters more than anything else in the chain — and the only thing we knew
// about a research run was `reached: true`. A run that read three trade-body method statements and a
// run that read four agency landing pages both reported `reached: true`, produced findings that both
// looked plausible, and were indistinguishable to every surface downstream.
//
// ═══ WHY SOURCE KIND, AND NOT A CONFIDENCE SCORE ═══
//
// Asking the run how good its own research was gets an opinion. Every finding already carries a
// `source` URL, because the skill has always required one — so the evidence for a quality judgement
// is already in the payload and nobody has ever read it. Classifying WHERE a fact came from is
// checkable, cheap, and cannot be talked up by the run that produced it.
//
// STRUCTURAL, NOT A BLOCKLIST. The tests are about the shape of a URL — a regulator's path, a
// documentation subdomain, a forum — so they hold for trades and countries nobody enumerated. A list
// of known-good domains would need an entry per jurisdiction and would be wrong on its first day
// outside the one it was written in.
//
// ═══ THE KNOWN BIAS, AND WHY IT IS THE SAFE ONE ═══
//
// Trade bodies are very often ACRONYMS — ada.org, rics.org, bda.org, aicpa.org — and no structural
// test can tell those from any other three-letter .org. `ada.org/resources/practice/dental-codes` is
// the American Dental Association defining dental billing codes, and this file scores it
// `marketing`. That is wrong, and it is wrong in the direction that matters: the metric UNDER-states
// research quality and never inflates it.
//
// That direction is chosen. A quality number that flatters the run is worse than useless — it would
// green-light a research step that read four landing pages — while one that is harsh makes a good
// run look mediocre, which costs an argument rather than a bad service. `rics.org` only scores
// `primary` here because its PATH says `/standards`, and that is the honest reason.
//
// The fix, when this matters enough: resolve the acronym from the page's own title on fetch, where
// "American Dental Association" is written out. That belongs in the fetching step, not in a
// classifier over a string.

/** Where a fact came from, best first. The order IS the ranking — see `SOURCE_WEIGHT`. */
export type SourceKind =
  /** A regulator, trade body, standard, or professional syllabus. The trade's own definition of itself. */
  | "primary"
  /** Documentation for the software the trade lives in. Its mandatory fields are the trade's opinion
   *  about what a job must contain, which is often more honest than its prose. */
  | "vendor_docs"
  /** A practitioner writing at length about how they actually do it — a post, a forum, a Q&A. */
  | "practitioner"
  /** A page selling the service. Tells you what it is CALLED, not how it is judged. */
  | "marketing"
  /** No usable source at all. A finding nobody can check. */
  | "none";

/**
 * The weights are a ranking, not a measurement.
 *
 * `primary` is 1.0 because a method statement is the trade defining itself. `marketing` is
 * deliberately LOW rather than zero: a sales page is real evidence of what a service is called and
 * what buyers are promised, which is worth something for `client_expects` and nothing for
 * `mechanics`. Zero would push a run to hide the sales pages it read rather than report them.
 */
const SOURCE_WEIGHT: Record<SourceKind, number> = {
  primary: 1,
  vendor_docs: 0.9,
  practitioner: 0.6,
  marketing: 0.2,
  none: 0,
};

const PRIMARY_HOST = /(^|\.)(gov|gov\.[a-z]{2}|mil|edu|ac\.[a-z]{2})$/i;
const PRIMARY_PATH =
  /\/(standard|standards|guidance|guidelines|code-of-practice|codes|regulation|regulations|syllabus|curriculum|handbook|framework|rulebook|practice-notes?|method-statement)\b/i;
const TRADE_BODY = /\b(institute|association|council|federation|society|chamber|board|college|guild|authority|commission|registry)\b/i;
const VENDOR_DOCS = /(^|\.)(docs|developer|developers|api|support|help|learn|knowledge|kb)\./i;
const VENDOR_PATH = /\/(docs?|documentation|api-reference|reference|developer|kb|knowledge-?base|help-?center)\b/i;
const PRACTITIONER =
  /(^|\.)(blog|forum|community|answers)\.|(^|\.)(medium|substack|reddit|stackexchange|stackoverflow|quora|news\.ycombinator|github)\.com|\/(blog|posts?|forum|thread|discussion|community)\b/i;
const MARKETING_PATH = /\/(services?|pricing|packages?|solutions?|why-us|about-us|contact|get-a-quote|our-work)\b/i;

/**
 * Classify one source URL.
 *
 * Order matters and is the argument: a regulator's blog is still a regulator, and a documentation
 * page on a vendor's marketing domain is still documentation. The most specific claim about the
 * PUBLISHER wins over the shape of the path.
 */
export function classifySource(raw: unknown): SourceKind {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return "none";

  let host = "";
  let path = "";
  try {
    const u = new URL(s.startsWith("http") ? s : `https://${s}`);
    host = u.hostname.toLowerCase().replace(/^www\./, "");
    path = u.pathname.toLowerCase();
  } catch {
    // A source that is not a URL is a citation the reader cannot follow. It is not nothing — the run
    // did name something — but it cannot be verified, so it ranks with the weakest kind that is
    // still a claim rather than with `none`.
    return s.length > 8 ? "marketing" : "none";
  }

  if (PRIMARY_HOST.test(host) || TRADE_BODY.test(host) || PRIMARY_PATH.test(path)) return "primary";
  if (VENDOR_DOCS.test(host) || VENDOR_PATH.test(path)) return "vendor_docs";
  if (PRACTITIONER.test(host) || PRACTITIONER.test(path)) return "practitioner";
  if (MARKETING_PATH.test(path)) return "marketing";
  // A bare domain with no telling path. Most often the trade's own homepage, reached from a search.
  return "marketing";
}

export interface ResearchQuality {
  /** Findings that carry any source at all, over findings total. */
  sourced: number;
  /** Weighted source quality, 0..1. The headline number. */
  depth: number;
  /** How many distinct publishers. One site read five times is one opinion. */
  distinctHosts: number;
  counts: Record<SourceKind, number>;
  /** Findings with no checkable source, by field, so a run can be told what to go back for. */
  unsourced: string[];
}

/** Every `{...,source}` in a research payload, with the field it came from. */
function findings(result: unknown): { field: string; source: unknown }[] {
  if (!result || typeof result !== "object") return [];
  const r = result as Record<string, unknown>;
  const out: { field: string; source: unknown }[] = [];
  for (const [field, value] of Object.entries(r)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === "object" && "source" in (item as object)) {
          out.push({ field, source: (item as { source?: unknown }).source });
        }
      }
    } else if (value && typeof value === "object" && "source" in (value as object)) {
      out.push({ field, source: (value as { source?: unknown }).source });
    }
  }
  return out;
}

/**
 * Score a `research_service` result.
 *
 * `depth` is the mean weight across findings, so a run with two excellent sources does not outscore
 * one with eight good ones purely by being small — a research step that found two facts has not done
 * the job however well it cited them. `sourced` and `distinctHosts` are reported alongside rather
 * than folded in, because they fail differently: everything cited to one blog is a different problem
 * from half the findings citing nothing, and one number hides which.
 */
export function researchQuality(result: unknown): ResearchQuality {
  const all = findings(result);
  const counts: Record<SourceKind, number> = { primary: 0, vendor_docs: 0, practitioner: 0, marketing: 0, none: 0 };
  const hosts = new Set<string>();
  const unsourced: string[] = [];
  let weight = 0;

  for (const f of all) {
    const kind = classifySource(f.source);
    counts[kind] += 1;
    weight += SOURCE_WEIGHT[kind];
    if (kind === "none") unsourced.push(f.field);
    else {
      try {
        hosts.add(new URL(String(f.source).startsWith("http") ? String(f.source) : `https://${f.source}`).hostname);
      } catch {
        /* unparseable — already counted, just not a distinct host */
      }
    }
  }

  const total = all.length;
  return {
    sourced: total ? (total - counts.none) / total : 0,
    depth: total ? weight / total : 0,
    distinctHosts: hosts.size,
    counts,
    unsourced: [...new Set(unsourced)],
  };
}

/**
 * One line a founder or an operator can read.
 *
 * Names the publishers rather than the score, because "three trade-body standards" is the thing that
 * makes somebody believe the research happened, and "depth 0.74" is not.
 */
export function describeResearch(q: ResearchQuality): string {
  const total = Object.values(q.counts).reduce((a, b) => a + b, 0);
  if (!total) return "no sourced findings";
  const parts: string[] = [];
  if (q.counts.primary) parts.push(`${q.counts.primary} from standards or trade bodies`);
  if (q.counts.vendor_docs) parts.push(`${q.counts.vendor_docs} from software documentation`);
  if (q.counts.practitioner) parts.push(`${q.counts.practitioner} from practitioners`);
  if (q.counts.marketing) parts.push(`${q.counts.marketing} from sales pages`);
  if (q.counts.none) parts.push(`${q.counts.none} with nothing to check`);
  return `${total} findings across ${q.distinctHosts} ${q.distinctHosts === 1 ? "source" : "sources"} — ${parts.join(", ")}`;
}
