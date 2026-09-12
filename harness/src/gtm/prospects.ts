// Finding people, and turning them into cases the sequencer can advance.
//
// This is the half of the GTM loop that was missing. `search_people`, the Voyager parsers and the
// graph writers all existed and were all unreachable from anything a founder could run, so the
// `people` and `companies` collections stayed empty and the CRM screens in cloud/app/(app)/gtm/
// rendered nothing. A campaign could be proposed, approved and ticked against a prospect list that
// had to be typed in by hand.
//
// TWO STEPS, NOT ONE, AND THAT IS DELIBERATE:
//
//   1. FIND. Search LinkedIn, write everyone found into the graph under their public identifier.
//      This is a READ: it changes nothing on LinkedIn, needs no approval, costs no touch budget, and
//      it is worth running on its own. The rows it leaves are an asset — they outlive the search,
//      they merge with later profile reads, and the next campaign enrols from them instead of
//      searching again.
//   2. ENROL. Turn some of those rows into Cases at stage `queued` for one campaign. This is the
//      step that commits to CONTACTING someone, so it is the step with the consent rule on it.
//
// Collapsing them into one call would mean a search that quietly created outreach, and a founder
// who wanted to see who is out there before deciding would have no way to ask.
import { randomUUID } from "node:crypto";
import { executeAction, type ActionResult } from "../actions";
import type { Case, Connection, Task } from "../contract";
import type { DomainStore } from "../domain";
import { emitEvent } from "../events";
import { COMPANY_COLLECTION, PEOPLE_COLLECTION, writeCompanies, writePeople } from "../linkedin/graph";
import { contactsForSites, writeSiteContacts } from "./site-people";
import { linkedInWedge as linkedInWedgeName } from "@mycel/linkedin/host";

/**
 * Paid people-search, off by default.
 *
 * `MYCEL_PAID_PEOPLE_SEARCH=1` turns FullEnrich's people search back on. Off, discovery runs on the
 * cheap stack alone — which is the instruction, and which the numbers support: a live sweep of six
 * law firms returned four reachable contacts from their own websites in eight seconds.
 */
const USE_PAID_PEOPLE_SEARCH =
  process.env.MYCEL_PAID_PEOPLE_SEARCH === "1" || process.env.MYCEL_PAID_PEOPLE_SEARCH === "true";
import { defined, type LiPerson } from "../linkedin/people";
import { safeCompanySlug } from "../linkedin/profile";
import type { Store } from "../store";
import { enrollProspect, type Campaign, type ProspectDraft } from "./campaign";
import { cheapDiscover, serperConfigured } from "./discover-cheap";
import { fileMapsFinds, mapsConfigured, mapsDiscover } from "./discover-maps";
import { looksLikeJobTitle, webDiscoverPeople } from "./discover-web";
import { enrichEmails } from "./enrich";
import { gtmWedge } from "./stages";

/**
 * The task type. Declared in wedges/gtm-operator/wedge.json so the job is visible on the wedge and
 * a Schedule or a Channel can name it, and matched here so it is HARNESS work rather than agent
 * work — same reasoning as `advance_sequences`: there is nothing for a model to decide, the query
 * is the founder's, and paying for an LLM call to pass six strings to a search endpoint is pure
 * cost.
 */
export const FIND_PROSPECTS_TASK_TYPE = "find_prospects";

/** How many people one search may return. Mirrors the cap in linkedin/search.ts, said out loud. */
const MAX_LIMIT = 49;

// ── AMPLIFICATION (unmetered company-tab expansion) ────────────────────────────────────────────────
//
// The throttled keyword `search_people` seeds a handful of people. Each of those people works
// SOMEWHERE, and the company People tab (`company_people`, linkedin/discover.ts) is NOT commercial
// search — it does not draw on the monthly quota (touch: null) and it is the same resolution the
// capped fallback above already uses in production. So after the base search succeeds we read the
// COMPANIES the found people work at and expand each through `company_people`, deduped against the
// base set. This is PURELY ADDITIVE: it runs only after the base search has already succeeded and
// written its rows, every step is wrapped so a failure just skips, and the base `people`/counts are
// never reduced. If it adds nothing, the result is byte-for-byte what it was before.
//
// The one honest limit: a found person carries a company NAME, not a numeric org id, and
// `company_people` resolves a name only when it is slug-like (getCompany's `safeCompanySlug` rejects
// anything with spaces). Multi-word employers simply do not expand — they are skipped, never faked.
const AMPLIFY_DISCOVERY = true;
/** Distinct companies (top by frequency among the found people) to expand. */
const AMPLIFY_MAX_COMPANIES = 5;
/** People to pull from each company's People tab. The tab pages ~12; this is a page or two. */
const AMPLIFY_PER_COMPANY = 20;
/** Hard ceiling on people ADDED by amplification across all companies, so it can never run away. */
const AMPLIFY_MAX_ADDED = 60;

export interface FindProspectsInput {
  project_id: string;
  /**
   * LinkedIn member session used for ACT and for Voyager fallback search.
   * Optional when FullEnrich web discovery is configured — finding people does not need a seat;
   * messaging does. See discover-web.ts.
   */
  connection_id?: string;
  query?: string;
  title?: string;
  company?: string;
  location?: string;
  /** Who they sell to, as industries. Cheap discover uses these; FullEnrich does not. */
  industries?: string[];
  /** Extra search wording that is not a job title. */
  keywords?: string;
  limit?: number;
  /** Offset, for the second page of the same search. Voyager's search paging is offset-based. */
  start?: number;
  /** The engagement these people belong to, when a case prompted the search. */
  case_id?: string;
  /** Who asked. Defaults to the member — a schedule passes its own actor. */
  actor?: Task["actor"];
  now?: Date;
}

/** One person, as the summary reports them. A subset of the record, chosen to be readable. */
export interface FoundPerson {
  profile_id: string;
  name?: string;
  headline?: string;
  title?: string;
  company?: string;
  company_domain?: string;
  location?: string;
  linkedin_url?: string;
  /** The published profile photo, if the search returned one. Free — no enrichment. Expires, so
   *  the cloud renderer skips it once its signature is stale (see components/face.tsx). */
  photo_url?: string;
}

export interface FindProspectsResult {
  ok: boolean;
  /** The anchor row: what the timeline, the audit entry and any later approval hang off. */
  task_id: string;
  found: number;
  people: FoundPerson[];
  /** Rows actually written to the graph. Lower than `found` when someone had no public identifier. */
  people_written: number;
  companies_written: number;
  /** Feed back as `start` for the next page. Absent means LinkedIn had no more. */
  next_start?: number;
  /** A named, actionable condition — `linkedin_commercial_search_limit` above all. */
  code?: string;
  detail: string;
}

/** A person record's `data` blob → the summary shape. Total; every field is optional upstream. */
function foundFrom(row: Record<string, unknown>): FoundPerson | null {
  const profileId = typeof row.public_id === "string" ? row.public_id : undefined;
  if (!profileId) return null;
  const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  return {
    profile_id: profileId,
    name: s(row.name),
    headline: s(row.headline),
    title: s(row.title),
    company: s(row.company),
    company_domain: s(row.company_domain),
    location: s(row.location),
    linkedin_url: s(row.profile_url),
    photo_url: s(row.photo_url),
  };
}

/** LinkedIn pacing vs a challenge vs everything else — the sentence a founder reads on a failed find. */
function peopleSearchFailure(result: ActionResult): { code?: string; detail: string } {
  const raw = result.detail ?? "the search failed";
  const challenged = /challenged/i.test(raw);
  const paced = !challenged && /\b302\b|redirect count exceeded|didn't return people/i.test(raw);
  const detail = challenged
    ? raw
    : paced
      ? "LinkedIn is pacing this account's searches right now — that is rate-limiting, not a fault. " +
        "It clears on its own; the next scheduled search will try again. Nothing was lost."
      : raw;
  const code = challenged ? (result.code ?? "linkedin_challenged") : paced ? "linkedin_paced" : result.code;
  return { code, detail };
}

/**
 * Search LinkedIn for people and leave them in the graph.
 *
 * Everything real happens through `executeAction` — the same door every other connection kind uses
 * and the same one the sequencer dispatches through. That is not ceremony: it is what puts this
 * search behind the vaulted session, the account's proxy, the pacing gate keyed on the CAPABILITY
 * ID, and the graph writers, none of which this file reimplements or could get subtly wrong.
 *
 * A Commercial Search Limit comes back as a `code`, not a generic failure, all the way to the
 * caller. LinkedIn meters profile searches on a rolling MONTHLY window and simply returns nobody
 * once an account crosses it — which looks exactly like a search for someone who does not exist. A
 * founder who reads "no results" narrows their targeting and searches again, forever; a founder who
 * reads the named condition waits, or upgrades. That difference is the entire reason the code is
 * carried through three layers instead of being flattened at the first one.
 */
export async function findProspects(
  store: Store,
  domain: DomainStore,
  conn: Connection | null,
  input: FindProspectsInput,
): Promise<FindProspectsResult> {
  const now = input.now ?? new Date();
  const iso = now.toISOString();

  // Tenancy, checked here rather than trusted: when a connection is present the graph writers take
  // the project off it, so a connection from another project would write this search into that
  // project's CRM. Web-only discovery scopes purely off `input.project_id`.
  if (!input.project_id) {
    return {
      ok: false,
      task_id: "",
      found: 0,
      people: [],
      people_written: 0,
      companies_written: 0,
      detail: "a project is required to file people into the graph",
    };
  }
  if (conn && conn.project_id !== input.project_id) {
    return {
      ok: false,
      task_id: "",
      found: 0,
      people: [],
      people_written: 0,
      companies_written: 0,
      detail: "that LinkedIn account belongs to another project",
    };
  }

  const task: Task = {
    id: randomUUID(),
    project_id: input.project_id,
    case_id: input.case_id,
    wedge: gtmWedge(),
    task_type: FIND_PROSPECTS_TASK_TYPE,
    actor: input.actor ?? { kind: "user", id: "member" },
    input: {
      query: input.query,
      title: input.title,
      company: input.company,
      location: input.location,
      limit: input.limit,
      ...(conn ? { connection_id: conn.id } : {}),
    },
    // A read: no approval, no model, no budget. `max_cost_usd: 0` is the honest figure and it is
    // the finding the whole Voyager approach rests on — a prospect costs bandwidth and nothing else.
    // FullEnrich web discovery may bill credits separately; that is recorded on the tool event.
    constraints: { max_runtime_s: 120, max_cost_usd: 0, approval_required: false },
    tools: [],
    status: "running",
    cost_usd: 0,
    created_at: iso,
    updated_at: iso,
  };
  await store.createTask(task);

  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(input.limit ?? 10)));

  const industries = (input.industries ?? []).map((s) => s.trim()).filter(Boolean);
  const keywords =
    (input.keywords ?? "").trim() ||
    (input.query && !looksLikeJobTitle(input.query) ? input.query.trim() : "");
  const titleForPeople =
    (input.title ?? "").trim() ||
    (input.query && looksLikeJobTitle(input.query) ? input.query.trim() : "") ||
    undefined;

  let cheapNames: string[] = [];
  /**
   * The same finds, carrying their DOMAIN — which is the only part a website read needs and the one
   * part `cheapNames` throws away. Kept separate rather than widening `cheapNames`, because that
   * list is passed to people-search as company NAMES and a domain is not a company name.
   */
  const cheapBusinesses: Array<{ name: string; domain: string }> = [];
  let sourcedCompaniesWritten = 0;
  const mapsPois: Awaited<ReturnType<typeof mapsDiscover>>["pois"] = [];
  if (serperConfigured() && (industries.length || keywords || input.company)) {
    const cheap = await cheapDiscover({
      industries: industries.length ? industries : input.company ? [input.company] : [],
      location: input.location,
      keywords: keywords || undefined,
      limit,
    });
    await emitEvent(store, task.id, "tool.result", {
      tool: "serper:search",
      ok: cheap.ok,
      detail: cheap.ok
        ? `Found ${cheap.businesses.length} businesses from ${cheap.queries} cheap ${cheap.queries === 1 ? "query" : "queries"}.`
        : (cheap.detail ?? "cheap search did not run"),
      queries: cheap.queries,
    });
    if (cheap.ok && cheap.businesses.length) {
      cheapNames = cheap.businesses.map((b) => b.name);
      for (const b of cheap.businesses) if (b.domain) cheapBusinesses.push({ name: b.name, domain: b.domain });
      sourcedCompaniesWritten = await writeCompanies(
        domain,
        { project_id: input.project_id, case_id: input.case_id },
        cheap.businesses.map((b) => ({
          name: b.name,
          domain: b.domain,
          website: b.url,
          description: b.about,
        })),
      );
    }
  }

  // Azure Maps — same transport as growth harvest. Phone is free. Needs a place string.
  if (mapsConfigured() && (industries.length || keywords) && (input.location ?? "").trim()) {
    const maps = await mapsDiscover({
      industries: industries.length ? industries : undefined,
      location: input.location,
      keywords: keywords || undefined,
      limit,
    });
    await emitEvent(store, task.id, "tool.result", {
      tool: "azure-maps:search",
      ok: maps.ok,
      detail: maps.ok
        ? `Found ${maps.pois.length} ${maps.pois.length === 1 ? "business" : "businesses"} on the map (${maps.queries} ${maps.queries === 1 ? "query" : "queries"}).`
        : (maps.detail ?? "map search did not run"),
      queries: maps.queries,
    });
    if (maps.ok && maps.pois.length) {
      mapsPois.push(...maps.pois);
      for (const p of maps.pois) {
        if (p.name && !cheapNames.includes(p.name)) cheapNames.push(p.name);
      }
    }
  }

  /**
   * ═══ READ THE BUSINESS'S OWN WEBSITE BEFORE PAYING ANYBODY ═══
   *
   * The businesses just discovered publish an address on their contact page, because they want to
   * be contacted. This reads it. For this ICP — local trades, small firms, agencies — that is most
   * of what a waterfall vendor would have sold us, at no per-lead cost and in about a second per
   * site. Measured on a live sweep: six firms in, four reachable contacts out, eight seconds.
   *
   * Runs FIRST, before any paid path, and for the same reason `cheapDiscover` runs before LinkedIn.
   */
  const siteContacts = cheapBusinesses.length
    ? await contactsForSites(cheapBusinesses, { budgetMs: 45_000 })
    : [];
  const siteContactsWritten = siteContacts.length
    ? await writeSiteContacts(
        domain as unknown as { upsertRecord: (r: Record<string, unknown>) => Promise<unknown> },
        { project_id: input.project_id, case_id: input.case_id },
        // The same wedge and collection `writePeople` files LinkedIn finds under, so a case reading
        // its people sees one pipeline rather than two that happen to share a project.
        linkedInWedgeName(),
        PEOPLE_COLLECTION,
        siteContacts,
      )
    : 0;
  if (siteContacts.length) {
    await emitEvent(store, task.id, "tool.result", {
      tool: "site:contacts",
      ok: true,
      detail: `Read ${siteContacts.length} ${siteContacts.length === 1 ? "contact" : "contacts"} off ${cheapBusinesses.length} business ${cheapBusinesses.length === 1 ? "website" : "websites"} — no enrichment credits spent.`,
    });
  }

  // ── FIND people.
  //
  // FullEnrich people-search is OFF. It is a waterfall vendor being paid per lead to return what is
  // largely already on the open web for this ICP, and the founder's instruction was to run on the
  // cheap stack the outbound engine uses: index sweep for the businesses, their own sites for the
  // contacts, LinkedIn only where a session already exists. The code is left in place rather than
  // deleted so turning it back on is a flag and not an archaeology exercise.
  let result: ActionResult;
  const canPeopleSearch =
    USE_PAID_PEOPLE_SEARCH && !!(titleForPeople || input.company || cheapNames.length || input.location);
  const web = canPeopleSearch
    ? await webDiscoverPeople({
        query: titleForPeople && input.query && looksLikeJobTitle(input.query) ? input.query : undefined,
        title: titleForPeople,
        company: input.company,
        companies: cheapNames,
        location: input.location,
        limit,
      })
    : { ok: true as const, people: [] };
  if (web.ok && web.people.length) {
    // One object per person, shaped so it serves BOTH roles: an `LiPerson` for the graph write
    // (keyed on `public_id`) AND a `foundFrom` row for the reader below — the two share every field
    // name (see `personRecord` and `foundFrom`), so there is no second mapping to drift.
    const rows = web.people.map((p) => ({
      public_id: p.profile_id,
      name: p.name,
      headline: p.headline,
      title: p.title,
      company: p.company,
      company_domain: p.company_domain,
      location: p.location,
      profile_url: p.linkedin_url,
      photo_url: p.photo_url,
    }));
    const written = await writePeople(
      domain,
      { project_id: input.project_id, case_id: input.case_id },
      rows as unknown as LiPerson[],
      { field: "search" },
    );
    result = {
      ok: true,
      detail: `Found ${rows.length} ${rows.length === 1 ? "person" : "people"} via FullEnrich — no LinkedIn search used.`,
      data: { people: rows, records_written: written },
    };
    await emitEvent(store, task.id, "tool.result", {
      tool: "fullenrich:people_search",
      ok: true,
      detail: result.detail,
    });
  } else if (!conn) {
    // No member session and web discovery did not fill the graph — cannot fall back to Voyager.
    if (web.ok === false && web.code && web.code !== "fullenrich_not_configured") {
      await emitEvent(store, task.id, "tool.result", {
        tool: "fullenrich:people_search",
        ok: false,
        code: web.code,
      });
    }
    const detail =
      web.ok === false && web.code === "fullenrich_not_configured"
        ? "People search needs FullEnrich configured, or a LinkedIn account for Voyager fallback."
        : web.ok === false
          ? `Web people search failed (${web.code ?? "unknown"}), and no LinkedIn account is attached to fall back on.`
          : "Nobody matched on web search, and no LinkedIn account is attached to fall back on.";
    result = { ok: false, detail, code: web.ok === false ? web.code : "no_linkedin_fallback" };
    await emitEvent(store, task.id, "tool.result", {
      tool: "fullenrich:people_search",
      ok: false,
      detail: result.detail,
      ...(result.code ? { code: result.code } : {}),
    });
  } else {
    // FullEnrich errored (not merely unconfigured) — name it, then fall back to the metered search.
    if (web.ok === false && web.code && web.code !== "fullenrich_not_configured") {
      await emitEvent(store, task.id, "tool.result", {
        tool: "fullenrich:people_search",
        ok: false,
        code: web.code,
      });
    }
    result = await executeAction(conn, "search_people", {
      query: input.query,
      title: input.title,
      company: input.company,
      location: input.location,
      limit,
      start: input.start,
      case_id: input.case_id,
    });
    await emitEvent(store, task.id, "tool.result", {
      tool: "linkedin:search_people",
      ok: result.ok,
      detail: result.detail,
      ...(result.code ? { code: result.code } : {}),
    });
  }

  // TAMING THE MONTHLY CAP. Search is the one metered surface. When LinkedIn caps it and the target
  // names a company, fall back to that company's People tab — which is not commercial search and so
  // does not draw on the quota (see linkedin/discover.ts). Needs a member session.
  if (conn && !result.ok && result.code === "linkedin_commercial_search_limit" && input.company) {
    const viaCompany = await executeAction(conn, "company_people", {
      company: input.company,
      limit,
      start: input.start,
      case_id: input.case_id,
    });
    await emitEvent(store, task.id, "tool.result", {
      tool: "linkedin:company_people",
      ok: viaCompany.ok,
      detail: viaCompany.detail,
      ...(viaCompany.code ? { code: viaCompany.code } : {}),
      fallback: "commercial_search_limit",
    });
    if (viaCompany.ok) result = viaCompany;
  }

  if (!result.ok) {
    /**
     * ═══ RATE-LIMITING IS PACING, NOT A FAULT — and it must not read as one ═══
     *
     * Thirteen production failures in one afternoon (2026-08-13) were LinkedIn 302-ing searches on
     * a throttled session, each recorded verbatim: "LinkedIn didn't return people (302 →
     * https://www.linkedin.com/search/results/people/)". A founder reads thirteen red FAILED rows
     * with URLs in them and concludes the product is broken; the truth is that LinkedIn paces
     * every account's search volume and the session resumes on its own. The known SSR budget is
     * ~2 searches per IP before the 302s start (rate state, not a bug).
     *
     * The status stays `failed` — the search genuinely did not happen, and inventing a softer
     * terminal status would let a schedule count it as progress. What changes is the SENTENCE
     * (founder language, what happens next) and the CODE (`linkedin_paced` / a challenge keeps its
     * reconnect CTA), so every surface that shows this run can tell pacing from breakage.
     *
     * Exception: map finds with a free phone are already in hand. A bakery market with nobody on
     * LinkedIn is not empty. File those shops and succeed; the LinkedIn sentence stays in `detail`.
     */
    const fail = peopleSearchFailure(result);
    if (mapsPois.length) {
      const mapsFile = await fileMapsFinds(
        domain,
        { project_id: input.project_id, case_id: input.case_id },
        mapsPois,
        [],
        iso,
      );
      sourcedCompaniesWritten += mapsFile.companies;
      mapsPois.length = 0;
      if (mapsFile.shops.length) {
        result = {
          ok: true,
          detail:
            `Found ${mapsFile.shops.length} ${mapsFile.shops.length === 1 ? "business" : "businesses"} on the map. ` +
            fail.detail,
          data: {
            people: mapsFile.shops.map((s) => ({
              public_id: s.profile_id,
              name: s.name,
              company: s.company,
              company_domain: s.company_domain,
              location: s.location,
            })),
            records_written: mapsFile.shops.length,
          },
        };
      }
    }
    if (!result.ok) {
      await store.setStatus(task.id, "failed", fail.detail);
      return {
        ok: false,
        task_id: task.id,
        found: 0,
        people: [],
        people_written: 0,
        companies_written: sourcedCompaniesWritten,
        code: fail.code,
        detail: fail.detail,
      };
    }
  }

  const data = (result.data ?? {}) as Record<string, unknown>;
  const rows = Array.isArray(data.people) ? (data.people as Array<Record<string, unknown>>) : [];
  let people = rows.map(foundFrom).filter((p): p is FoundPerson => p !== null);

  // ONE `progress` EVENT PER PERSON, BEFORE THE TASK SUCCEEDS.
  //
  // Cloud's `useGtmStream` closes the EventSource on `task.finished`, and `readStreamEvent` reads
  // exactly this shape (`{ gtm: { person } }`) — but nothing was ever emitting it, so the face wall
  // the GTM page is built around stayed empty for the whole run and only filled on a manual
  // refresh. The founder's first impression of this product is watching real buyers appear one at
  // a time; a spinner followed by a table is a different product.
  //
  // Keyed by `public_id` up front rather than a `.find` per person: a 100-row search was otherwise
  // 10,000 comparisons on a hot path for a cosmetic field.
  const rowByPublicId = new Map<string, Record<string, unknown>>();
  for (const r of rows) {
    if (typeof r.public_id === "string") rowByPublicId.set(r.public_id, r);
  }
  for (const p of people) {
    const row = rowByPublicId.get(p.profile_id) ?? {};
    await emitEvent(store, task.id, "progress", {
      gtm: {
        person: {
          key: p.profile_id,
          name: p.name ?? p.profile_id,
          headline: p.headline ?? p.title,
          title: p.title,
          photo_url: typeof row.photo_url === "string" ? row.photo_url : undefined,
          company_key: p.company_domain ?? p.company,
          company_name: p.company,
        },
      },
      // Best-effort by design: these events are how the wall paints, and the rows are already
      // written to the graph. A dropped event costs a founder an animation, and failing the search
      // over one would cost them the prospects.
    }).catch((e) => console.error(`[mycel] could not stream the discovery of ${p.profile_id}:`, e));
  }

  let peopleWritten = Number(data.records_written ?? 0);
  const companiesWritten = Number(data.companies_written ?? 0);

  /**
   * FOUND TWENTY, KEPT NONE, REPORTED SUCCESS.
   *
   * `writePeople` (`linkedin/graph.ts`) wraps each `upsertRecord` in a `try/catch` that only
   * `console.error`s, so a graph that is down produces `records_written: 0` — and this function
   * used to set the task `succeeded` and return `ok: true` regardless, giving the founder a 200, a
   * `found: 20`, and an empty CRM. The count was in the body and nothing branched on it; the route
   * derived its status purely from `ok`. Exactly the class of bug this repo pays for repeatedly:
   * something failing while reporting success.
   *
   * `found === 0` is untouched and stays a success — LinkedIn legitimately returning nobody for a
   * narrow search is an answer, not a fault. The fault named here is finding people and keeping
   * none of them, and it is reported the way every other named condition on this path is: `ok:
   * false` with a `code` the route can map and a `detail` a founder can act on. The task is failed
   * rather than succeeded, because a task that stored nothing did not succeed.
   */
  if (people.length > 0 && peopleWritten === 0) {
    const detail =
      `found ${people.length} on LinkedIn and stored none of them — the search worked and the write to ` +
      `the graph did not, so these prospects are lost rather than saved. The harness log has the write error.`;
    await store.setStatus(task.id, "failed", detail);
    return {
      ok: false,
      task_id: task.id,
      found: people.length,
      people,
      people_written: 0,
      companies_written: companiesWritten + sourcedCompaniesWritten,
      code: "graph_write_failed",
      detail,
    };
  }

  // Stamp phones onto named people at the same own-domain. File leftover shops as people so a
  // market with no LinkedIn is not reported empty. Already filed above when people-search failed.
  if (mapsPois.length) {
    const mapsFile = await fileMapsFinds(
      domain,
      { project_id: input.project_id, case_id: input.case_id },
      mapsPois,
      people,
      iso,
    );
    sourcedCompaniesWritten += mapsFile.companies;
    peopleWritten += mapsFile.shops.length;
    for (const shop of mapsFile.shops) {
      const fp: FoundPerson = {
        profile_id: shop.profile_id,
        name: shop.name,
        company: shop.company,
        company_domain: shop.company_domain,
        location: shop.location,
      };
      people.push(fp);
      await emitEvent(store, task.id, "progress", {
        gtm: {
          person: {
            key: fp.profile_id,
            name: fp.name ?? fp.profile_id,
            company_key: fp.company_domain ?? fp.company,
            company_name: fp.company,
          },
        },
      }).catch((e) => console.error(`[mycel] could not stream the map find ${fp.profile_id}:`, e));
    }
  }

  // ── AMPLIFY: expand each found person's company via the unmetered People tab ──────────────────────
  //
  // Everything below is best-effort and additive. It runs only now — after the base search produced
  // and PERSISTED `people` — and the whole block is wrapped so it can never throw, block or reduce
  // the base result. Whatever it appends is a bonus; whatever it fails to do costs nothing.
  // Needs a LinkedIn member session — web-only discovery skips this expansion.
  let amplifiedPeople = 0;
  let amplifiedCompanies = 0;
  if (AMPLIFY_DISCOVERY && conn && people.length > 0) {
    try {
      // The set the amplified rows dedupe against — the base found people, by profile id. And the
      // companies already accounted for, so amplification's counts report only what it newly added
      // (company_people re-upserts people it has seen, so its raw records_written double-counts).
      const seen = new Set(people.map((p) => p.profile_id));
      const seenCompanies = new Set(
        people.map((p) => p.company_domain ?? p.company).filter((c): c is string => !!c),
      );

      // Distinct companies among the found people, most frequent first. `company` is the field
      // `company_people` resolves (a vanity name/slug); a person with none is no lead to expand.
      const freq = new Map<string, number>();
      for (const p of people) {
        const name = p.company?.trim();
        if (name) freq.set(name, (freq.get(name) ?? 0) + 1);
      }
      // Only SLUG-LIKE company names can be expanded — company_people resolves a slug, not a
      // display name. A multi-word employer ("Prudential Indonesia (PT ...)", "Nordic Nest Group")
      // is not a slug and must be SKIPPED SILENTLY, not attempted-and-failed: the old loop called
      // company_people for every name and emitted a failed tool.result for each rejection, so a
      // normal search surfaced five "is not a LinkedIn company slug" errors to the founder. Filtered
      // here (safeCompanySlug returns null for anything with a space) so amplification only ever
      // touches names it can actually resolve, and adds nothing noisy when none qualify.
      const companies = [...freq.entries()]
        .filter(([name]) => safeCompanySlug(name) !== null)
        .sort((a, b) => b[1] - a[1])
        .slice(0, AMPLIFY_MAX_COMPANIES)
        .map(([name]) => name);

      for (const company of companies) {
        if (amplifiedPeople >= AMPLIFY_MAX_ADDED) break;
        // Per-company try/catch: an unresolvable name, a 999 challenge or a parser miss on one
        // company must not cost the others, let alone the base result.
        let viaCompany: Awaited<ReturnType<typeof executeAction>>;
        try {
          viaCompany = await executeAction(conn, "company_people", {
            company,
            limit: AMPLIFY_PER_COMPANY,
            start: 0,
            case_id: input.case_id,
          });
        } catch (e) {
          console.error(`[mycel] amplification: company_people threw for "${company}":`, e);
          continue;
        }
        /**
         * ═══ AN ADDITIVE STEP MAY NOT REPORT A FAILURE ═══
         *
         * This loop is a bonus: the base search already succeeded and wrote its rows, and every
         * company here is one we are OPTIMISTICALLY trying to expand. When LinkedIn does not have
         * "Altena-Software", nothing has gone wrong — that company is simply not on LinkedIn under
         * that name. Emitting `ok: false` painted a red FAILED row on the founder's live feed for a
         * step that cost nothing and lost nothing, and the run beside it said `1 running` while the
         * headline read `linkedin:company_people → failed`.
         *
         * The comment thirty lines up already reached this conclusion for names that are not
         * slug-like: "must be SKIPPED SILENTLY, not attempted-and-failed". It filtered those out and
         * left this case — a name that IS a valid slug for a company LinkedIn has never heard of —
         * reporting exactly the way it had just argued nothing should.
         *
         * WHAT IS STILL WORTH SAYING. A miss on one company is noise. A session that has been
         * challenged or paced is not: it stops every remaining company AND the next run, and the
         * founder has to reconnect. So codes that describe the SESSION are surfaced and codes that
         * describe this one company are not.
         */
        const sessionProblem = /challenge|paced|limit|auth|session|cookie/i.test(viaCompany.code ?? "");
        if (viaCompany.ok || sessionProblem) {
          await emitEvent(store, task.id, "tool.result", {
            tool: "linkedin:company_people",
            ok: viaCompany.ok,
            detail: viaCompany.detail,
            ...(viaCompany.code ? { code: viaCompany.code } : {}),
            amplify: company,
          }).catch(() => {});
        }
        if (!viaCompany.ok) {
          // Logged, not shown. "We tried Altena-Software and LinkedIn does not have it" is a fact
          // worth having in the run log and worth nothing on the founder's screen.
          console.info(`[mycel] amplification: skipped "${company}" — ${viaCompany.detail ?? "no people"}`);
          if (sessionProblem) break; // the next company will fail the same way; stop spending on it
          continue;
        }

        // `company_people` already wrote its people/companies to the graph (linkedin/connect.ts
        // discoverCompanyPeople), so no second write path is needed. The counts below fold into the
        // same people_written/companies_written the base rows report, but they count only GENUINELY
        // NEW rows — a person or company already found is a dedupe, not another written prospect.
        const vData = (viaCompany.data ?? {}) as Record<string, unknown>;
        const vRows = Array.isArray(vData.people)
          ? (vData.people as Array<Record<string, unknown>>)
          : [];
        for (const row of vRows) {
          if (amplifiedPeople >= AMPLIFY_MAX_ADDED) break;
          const fp = foundFrom(row);
          if (!fp || seen.has(fp.profile_id)) continue; // dedupe against everyone already found
          seen.add(fp.profile_id);
          people.push(fp);
          amplifiedPeople++;
          const ck = fp.company_domain ?? fp.company;
          if (ck && !seenCompanies.has(ck)) {
            seenCompanies.add(ck);
            amplifiedCompanies++;
          }
          // The SAME per-person progress event the base rows emit, so the face wall streams these
          // exactly like a direct hit — the founder never learns which surface a buyer came from.
          await emitEvent(store, task.id, "progress", {
            gtm: {
              person: {
                key: fp.profile_id,
                name: fp.name ?? fp.profile_id,
                headline: fp.headline ?? fp.title,
                title: fp.title,
                photo_url: typeof row.photo_url === "string" ? row.photo_url : undefined,
                company_key: fp.company_domain ?? fp.company,
                company_name: fp.company,
              },
            },
          }).catch((e) => console.error(`[mycel] amplification: could not stream ${fp.profile_id}:`, e));
        }
      }
    } catch (e) {
      // The outer net: amplification is a bonus, and the base result is already whole. A bug here
      // must never turn a successful search into a failure.
      console.error("[mycel] prospect amplification failed — returning the base result unchanged:", e);
    }
  }

  // ── EMAIL WATERFALL. Same order as growth/lib/enrich: pattern + MX, then scrape, FullEnrich last.
  // `paid: false` — a find is look-around. The paid hop waits until someone is enrolled to contact.
  if (people.length) {
    try {
      await enrichEmails(
        domain,
        { project_id: input.project_id, case_id: input.case_id },
        people.map((p) => ({
          key: p.profile_id,
          name: p.name,
          company: p.company,
          company_domain: p.company_domain,
          linkedin_url: p.linkedin_url,
        })),
        new Date(),
        { paid: false },
      );
    } catch (e) {
      console.error("[mycel] post-search email waterfall failed — people are still filed:", e);
    }
  }

  await store.setStatus(task.id, "succeeded");

  return {
    ok: true,
    task_id: task.id,
    found: people.length,
    people,
    people_written: peopleWritten + amplifiedPeople,
    companies_written: companiesWritten + amplifiedCompanies + sourcedCompaniesWritten,
    next_start: typeof data.next_start === "number" ? data.next_start : undefined,
    detail: result.detail ?? `found ${people.length}`,
  };
}

// ── enrolment ────────────────────────────────────────────────────────────────────────────────────

export interface EnrolResult {
  enrolled: number;
  /** Already in this campaign. Not an error — the second run of the same search finds them again. */
  already: number;
  /** Dropped because they had no public identifier, which is the only key a case can carry. */
  unkeyable: number;
  case_ids: string[];
  /** Set when nothing was enrolled on purpose, so "it did nothing" is never a mystery. */
  note?: string;
}

/**
 * Turn prospects into Cases at stage `queued`, one per prospect per campaign.
 *
 * ONE CASE PER PROSPECT PER CAMPAIGN is the invariant the whole sequencer rests on. `Case.due_at` is
 * the only "look at me at this time" the design has, so two cases for one person in one campaign is
 * literally two sequences running at that person in parallel — two invitations, two DMs, from the
 * founder's real account. The dedupe is therefore not a nicety, and it is done by READING the
 * campaign's existing cases rather than by trusting the caller not to call twice.
 *
 * ENROLMENT STOPS ONCE THE FOUNDER HAS DECIDED, and this is the rule worth arguing about. The
 * approval card says "N prospects", names three of them, and links an artifact holding every message
 * in full. Adding people to a campaign after that is approved makes all three of those false — the
 * founder consented to contacting a list, and a list that grows afterwards is a different decision
 * wearing the first one's signature. So a decided campaign refuses new prospects and the caller is
 * told to propose another one. (Enrolling into a PENDING campaign is the normal path: find, enrol,
 * then approve what you can see.)
 */
export async function enrolProspects(
  store: Store,
  domain: DomainStore,
  campaign: Campaign,
  prospects: ProspectDraft[],
  now: Date = new Date(),
): Promise<EnrolResult> {
  const out: EnrolResult = { enrolled: 0, already: 0, unkeyable: 0, case_ids: [] };
  if (!campaign.project_id) {
    out.note = "this campaign belongs to no project — refusing to create cases that no tenant owns";
    return out;
  }
  if (!prospects.length) {
    out.note = "nobody to enrol";
    return out;
  }

  const approval = await store.getApproval(campaign.approval_id);
  if (approval && approval.status !== "pending") {
    out.note =
      `this campaign was already ${approval.status} — the ${approval.status === "approved" ? "approved" : "decided"} ` +
      "list cannot grow afterwards. Propose a new campaign for these people so the founder sees who they are.";
    return out;
  }

  // The dedupe key set, read once. Scoped, because `listCases` fails closed on tenancy and an
  // unscoped read here would compare this campaign's prospects against every tenant's.
  const existing = await domain.listCases({ project_id: campaign.project_id, wedge: gtmWedge() });
  const enrolledIds = new Set(
    existing
      .filter((k) => (k.data as Record<string, unknown> | undefined)?.campaign_id === campaign.id)
      .map((k) => String((k.data as Record<string, unknown>)?.profile_id ?? ""))
      .filter(Boolean),
  );

  for (const p of prospects) {
    const profileId = (p.profile_id ?? "").trim();
    if (!profileId) {
      // A case with no profile id can never be acted on: every LinkedIn capability addresses a
      // person by their public identifier or a urn derived from it. Writing one would put a row in
      // the founder's pipeline that parks for ever.
      out.unkeyable++;
      continue;
    }
    if (enrolledIds.has(profileId)) {
      out.already++;
      continue;
    }
    enrolledIds.add(profileId);
    const kase = await enrollProspect(domain, campaign, { ...p, profile_id: profileId }, now);
    out.enrolled++;
    out.case_ids.push(kase.id);
  }
  return out;
}

/**
 * Hydrate prospects out of the graph, by public identifier.
 *
 * The point of the two-step design: a search leaves rows behind, and enrolment reads them back
 * rather than being handed a blob by whoever called the search. So the name on the case is the name
 * in the CRM, and a prospect enrolled today carries whatever a profile read learned about them last
 * week.
 *
 * NO COPY IS ATTACHED, and that is not an omission. The message a prospect receives is written and
 * approved at propose time; a case enrolled from the graph has none, so a `send_message` step parks
 * with "no approved copy for this step — nothing will be improvised" rather than inventing one.
 * Warm-ups and bare invitations need no words and run normally.
 */
export async function prospectsFromGraph(
  domain: DomainStore,
  projectId: string,
  profileIds: string[],
): Promise<ProspectDraft[]> {
  if (!projectId || !profileIds.length) return [];
  const out: ProspectDraft[] = [];
  for (const id of profileIds) {
    const key = id.trim();
    if (!key) continue;
    const rows = await domain.queryRecords({
      project_id: projectId,
      wedge: gtmWedge(),
      collection: PEOPLE_COLLECTION,
      // `profile_id` rather than the row key, because `where` matches top-level data fields — which
      // is exactly why graph.ts duplicates the public identifier into the blob.
      where: { profile_id: key },
      limit: 1,
    });
    const data = (rows[0]?.data ?? {}) as Record<string, unknown>;
    // A person we have never seen is skipped rather than invented: enrolling an identifier that is
    // not in the graph would create a case with no name, no headline and nothing to personalise on.
    if (!rows.length) continue;
    out.push({
      profile_id: key,
      name: typeof data.name === "string" ? data.name : undefined,
      // `POST /v1/gtm/prospects/signals` writes this onto the person when it detects one. It was
      // read by nothing: the composer enrolled from the graph and left behind the only field that
      // answers "why this person, today".
      signal: typeof data.signal === "string" && data.signal.trim() ? data.signal.trim() : undefined,
    });
  }
  return out;
}

/** Every case in one campaign, project-scoped. What the CRM's campaign view is made of. */
export async function casesForCampaign(
  domain: DomainStore,
  projectId: string,
  campaignId: string,
): Promise<Case[]> {
  if (!projectId || !campaignId) return [];
  const all = await domain.listCases({ project_id: projectId, wedge: gtmWedge() });
  return all.filter((k) => (k.data as Record<string, unknown> | undefined)?.campaign_id === campaignId);
}
