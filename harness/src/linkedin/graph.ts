// Everything LinkedIn tells us, written into the graph so it is worth something tomorrow.
//
// ── WHY RECORDS, NATURALLY KEYED ─────────────────────────────────────────────────────────────────
// A search that returns fifty people to a chat window is a demo. A search that leaves fifty rows in
// `records` under `(project, gtm-operator, people, <public identifier>)` is an asset: the CRM screens
// already read exactly that (`cloud/lib/gtm.ts` `readPerson`/`readCompany`), campaigns enrol from it,
// and running the same search next month ENRICHES those rows rather than duplicating them.
//
// The key choice is the whole thing:
//   · a person is their LinkedIn PUBLIC IDENTIFIER. It is stable, it is what the profile URL is made
//     of, and it is what the sequencer already carries on a case as `profile_id`. A person with no
//     public identifier is not written at all — an unkeyable row can never be re-found or merged, so
//     writing it corrupts the collection instead of filling it.
//   · a company is its REGISTRABLE DOMAIN, not its LinkedIn slug. The domain is the identifier every
//     other system in the business shares — the CRM, the email tool, the billing record — so keying
//     on it is what lets those join later without a mapping table. A company page with no resolvable
//     website is therefore skipped, deliberately, rather than keyed on something local.
//
// ── WHY THE MERGE MATTERS ────────────────────────────────────────────────────────────────────────
// `upsertRecord` in domain.pg.ts is `data = records.data || EXCLUDED.data` — a JSONB shallow merge,
// not a replace. So a search result (name, headline, photo) and a later profile read (title, company,
// location, summary) accumulate into one row, and neither erases the other. That only holds if we
// never write an explicit null over a known value, which is why every record built here goes through
// `defined()` first: a field LinkedIn did not return is ABSENT, not null.
//
// ── PROVENANCE, AND THE POINT OF IT ──────────────────────────────────────────────────────────────
// Every field group carries who resolved it and what it cost. For Voyager that cost is 0.00, and
// that zero IS the finding rather than a missing value: because search, profile and company reads run
// on the messaging session we already hold, a prospect costs bandwidth and nothing else — no
// enrichment vendor, no API key, no per-lead price. The CRM renders this waterfall (`readProvenance`),
// so the claim is checkable on screen rather than believed.
import type { DomainStore } from "../domain";
import { GTM_WEDGE } from "../gtm/stages";
import { defined, registrableDomain, type LiCompany, type LiPerson } from "./people";
import type { LiProfile } from "./profile";

/** The collections the CRM reads. Plural — `cloud/lib/gtm.ts` accepts both spellings, we write one. */
export const PEOPLE_COLLECTION = "people";
export const COMPANY_COLLECTION = "companies";

/**
 * The resolver name that appears in the provenance waterfall.
 *
 * Named for the SURFACE, not for us: a founder reading "linkedin-voyager · $0.00" beside a row learns
 * where the data came from and that it was free. "mycel" would tell them neither.
 */
export const VOYAGER_RESOLVER = "linkedin-voyager";

/**
 * The cost of a Voyager resolution, in dollars. Zero, and it is a literal rather than an omission.
 *
 * See the file header: this is the finding the whole approach rests on.
 */
export const VOYAGER_COST_USD = 0;

/** One provenance entry, in the shape `cloud/lib/gtm.ts` `readProvenance` renders. */
export function provenanceEntry(at: string): Record<string, unknown> {
  return { by: VOYAGER_RESOLVER, cost_usd: VOYAGER_COST_USD, at, attempts: [{ by: VOYAGER_RESOLVER, ok: true, cost_usd: VOYAGER_COST_USD, at }] };
}

/**
 * A person → the `data` blob for their record. Pure, so the merge semantics are testable.
 *
 * `field` names the group this resolution covers ("search" vs "profile"), because the two carry
 * different fields and a founder looking at a row should be able to see WHICH read produced what.
 * The merge is shallow, so a later "profile" entry sits beside the earlier "search" one rather than
 * replacing it, and the waterfall reads as history.
 */
export function personRecord(p: LiPerson | LiProfile, field: "search" | "profile", at: string): Record<string, unknown> {
  const prof = p as LiProfile;
  return {
    ...defined({
      // `profile_id` duplicated into data because `queryRecords.where` matches top-level data fields,
      // and the sequencer needs to find a person by the same id a case carries.
      profile_id: p.public_id,
      name: p.name,
      headline: p.headline,
      title: p.title,
      company: p.company,
      // The edge into the companies collection. Named `company_key` because that is what `readPerson`
      // reads, and it holds a domain because that is what keys a company row.
      company_key: p.company_domain,
      company_domain: p.company_domain,
      company_slug: prof.company_slug,
      photo_url: p.photo_url,
      location: p.location,
      linkedin_url: p.profile_url,
      urn: p.urn,
      industry: prof.industry,
      summary: prof.summary,
      source: "linkedin",
    }),
    provenance: { [field]: provenanceEntry(at) },
  };
}

/** A company → the `data` blob for its record. */
export function companyRecord(c: LiCompany, at: string): Record<string, unknown> {
  return {
    ...defined({
      name: c.name,
      domain: c.domain,
      website: c.website,
      industry: c.industry,
      headcount: c.headcount,
      logo_url: c.logo_url,
      description: c.description,
      linkedin_slug: c.universal_name,
      urn: c.urn,
      source: "linkedin",
    }),
    provenance: { company: provenanceEntry(at) },
  };
}

export interface GraphScope {
  /** The tenant. Absent means DO NOT WRITE — see `writePeople`. */
  project_id?: string;
  /** The engagement these rows belong to, when a sequencer step produced them. */
  case_id?: string;
}

/**
 * Write people into the graph. Returns how many rows were touched.
 *
 * NEVER THROWS, and that is a deliberate asymmetry: enrichment bookkeeping must not be able to turn a
 * successful LinkedIn read into a reported failure. The caller already has the people in hand; losing
 * the write costs a re-search, while propagating the error costs a parked case and a confusing
 * "sequencer error" on a step that actually worked.
 *
 * Refuses to write anything without a project. `queryRecords` fails closed on tenancy, so an unscoped
 * row is invisible to every tenant — writing one is not a leak, it is landfill.
 */
export async function writePeople(
  domain: DomainStore,
  scope: GraphScope,
  people: Array<LiPerson | LiProfile>,
  opts: { field?: "search" | "profile"; at?: string } = {},
): Promise<number> {
  if (!scope.project_id) return 0;
  const at = opts.at ?? new Date().toISOString();
  const field = opts.field ?? "search";
  let n = 0;
  for (const p of people) {
    if (!p.public_id) continue; // unkeyable — see the header
    try {
      await domain.upsertRecord({
        project_id: scope.project_id,
        wedge: GTM_WEDGE,
        collection: PEOPLE_COLLECTION,
        key: p.public_id,
        data: personRecord(p, field, at),
        case_id: scope.case_id,
      });
      n++;
    } catch (e) {
      console.error(`[mycel] could not write person ${p.public_id} to the graph:`, e);
    }
  }
  return n;
}

/** Same contract for companies, keyed on the registrable domain. */
export async function writeCompanies(
  domain: DomainStore,
  scope: GraphScope,
  companies: LiCompany[],
  at = new Date().toISOString(),
): Promise<number> {
  if (!scope.project_id) return 0;
  let n = 0;
  for (const c of companies) {
    const key = c.domain ?? registrableDomain(c.website);
    if (!key) continue; // no domain, no natural key — see the header
    try {
      await domain.upsertRecord({
        project_id: scope.project_id,
        wedge: GTM_WEDGE,
        collection: COMPANY_COLLECTION,
        key,
        data: companyRecord({ ...c, domain: key }, at),
      });
      n++;
    } catch (e) {
      console.error(`[mycel] could not write company ${key} to the graph:`, e);
    }
  }
  return n;
}

/**
 * The company implied by a set of people, as a STUB row.
 *
 * A search result names an employer but never describes one, so this writes a shell — a domain and a
 * name — that a later `get_company` fills in through the same merge. Worth doing: it means the CRM's
 * company list is populated by the act of searching, and `readCompany` falls back to the key for the
 * domain, so a stub renders correctly rather than as a blank row.
 */
export function companyStubs(people: Array<LiPerson | LiProfile>): LiCompany[] {
  const byDomain = new Map<string, LiCompany>();
  for (const p of people) {
    if (!p.company_domain) continue;
    const existing = byDomain.get(p.company_domain);
    if (!existing?.name) byDomain.set(p.company_domain, { domain: p.company_domain, name: p.company });
  }
  return [...byDomain.values()];
}
