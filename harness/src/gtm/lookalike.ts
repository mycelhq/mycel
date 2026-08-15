// Lookalike expansion: search outward from the people who actually became customers.
//
// The one piece of targeting evidence a founder has that no ICP description can match is a `won`
// case: someone who heard the pitch and bought. This turns that back into a search.
//
// It does NOT enrol and it does NOT send. The output is graph rows and a list, and consent still
// goes through propose + copy like every other campaign — an audience derived from a win is still
// an audience nobody has approved.
import { PEOPLE_COLLECTION } from "../linkedin/graph";
import type { Connection } from "../contract";
import type { DomainStore } from "../domain";
import type { Store } from "../store";
import { findProspects, type FindProspectsResult } from "./prospects";
import { gtmWedge } from "./stages";

/** How many wins to read titles from. Beyond this the modal title has long since stabilised. */
const MAX_SEEDS = 20;

/** The value that appears most often, ties broken by first-seen. `undefined` for an empty list. */
function modal(values: string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: string | undefined;
  let bestN = 0;
  for (const [v, n] of counts) {
    if (n > bestN) {
      best = v;
      bestN = n;
    }
  }
  return best;
}

export async function expandLookalikes(
  store: Store,
  domain: DomainStore,
  conn: Connection,
  input: { project_id: string; limit?: number },
): Promise<FindProspectsResult & { seeds: number }> {
  const empty = { ok: false as const, task_id: "", found: 0, people: [], people_written: 0, companies_written: 0 };
  // Tenancy first and fails closed. `conn` arrives from a route that already checked it, and this
  // checks again anyway: the cost of being wrong is one customer's win list steering a search run
  // from another customer's LinkedIn account.
  if (!input.project_id || conn.project_id !== input.project_id) {
    /**
     * `code` is what stops this being served as a 200. The route derived its status from `ok` and
     * `task_id`, and a tenancy refusal carries neither a task nor anything the route could tell
     * apart from the ordinary "you have no wins yet" — so a cross-tenant attempt and a brand-new
     * account got byte-for-byte the same 200. A refusal indistinguishable from a normal empty
     * answer is a refusal nobody can audit and nobody notices being probed.
     */
    return {
      ...empty,
      seeds: 0,
      code: "wrong_project",
      detail: "that LinkedIn account belongs to another project",
    };
  }

  const won = (await domain.listCases({ project_id: input.project_id, wedge: gtmWedge() })).filter(
    (k) => k.stage === "won",
  );

  // The people rows are read ONCE. This used to run a 500-row `queryRecords` inside the loop over
  // wins — twenty scans of a collection that grows with every search ever run, to look up twenty
  // keys.
  const byKey = new Map<string, Record<string, unknown>>();
  for (const r of await domain.queryRecords({
    project_id: input.project_id,
    wedge: gtmWedge(),
    collection: PEOPLE_COLLECTION,
    limit: 1000,
  })) {
    byKey.set(r.key, (r.data as Record<string, unknown>) ?? {});
  }

  const titles: string[] = [];
  const companies: string[] = [];
  for (const k of won.slice(0, MAX_SEEDS)) {
    const d = (k.data ?? {}) as Record<string, unknown>;
    const profileId = typeof d.profile_id === "string" ? d.profile_id : "";
    const person = profileId ? byKey.get(profileId) : undefined;
    if (!person) continue;
    if (typeof person.title === "string" && person.title.trim()) titles.push(person.title.trim());
    if (typeof person.company === "string" && person.company.trim()) companies.push(person.company.trim());
  }

  // The MOST COMMON title, not the most recent one. Reading `titles[0]` made the whole feature a
  // function of one arbitrary win — the newest — which is the opposite of the argument for using
  // wins at all.
  const title = modal(titles);
  const company = modal(companies);
  if (!title && !company) {
    return {
      ...empty,
      seeds: won.length,
      detail:
        won.length === 0
          ? "no won prospects yet — convert someone first and this searches for more of them"
          : "the won prospects on file carry no title or company to search on",
    };
  }

  const r = await findProspects(store, domain, conn, {
    project_id: input.project_id,
    connection_id: conn.id,
    title,
    company: title ? undefined : company,
    query: title && company ? `${title} ${company}` : undefined,
    limit: input.limit ?? 15,
  });
  return { ...r, seeds: won.length };
}
