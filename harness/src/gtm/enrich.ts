// Email enrichment — the hop Voyager cannot do, and the only one in this system that costs money.
//
// ── WHY THERE IS A SECOND RESOLVER AT ALL ────────────────────────────────────────────────────────
// linkedin/graph.ts is the only resolver in the codebase and its `VOYAGER_COST_USD` is literally 0,
// which is the finding the whole GTM approach rests on: search, profile and company reads run on the
// messaging session we already hold, so a prospect costs bandwidth and nothing else. That remains
// true and this file does not weaken it. What it fixes is a narrower thing: LinkedIn never returns
// an email address (see search.ts's header — v1 deliberately needed none), so `person.email` was
// unresolvable by construction, and `cloud/app/(app)/gtm/page.tsx` renders a MULTI-HOP EMAIL
// WATERFALL under every face. With no email resolver in existence that waterfall showed empty hops
// and $0.00 for ever — a real feature that reads exactly like a broken one.
//
// ── WHY FULLENRICH SPECIFICALLY ──────────────────────────────────────────────────────────────────
// FullEnrich is not one data vendor, it is a waterfall of 15+ of them behind a single call: it tries
// the cheap sources first and falls through until something resolves. So the provenance UI stops
// being a stub and starts being TRUE — "we tried the free thing, it does not carry emails, then we
// paid for one" is a real sequence of hops rather than a decoration. A single-source vendor would
// have made the waterfall a one-hop list and left the screen looking the same.
//
// ── THE KEY DOES NOT EXIST YET, AND ABSENCE IS A FIRST-CLASS STATE ───────────────────────────────
// `FULLENRICH_API_KEY` is unset in every environment as this ships. That is not a broken
// configuration and this file must never make it look like one:
//
//   · `fullEnrichConfigured()` is false, `enrichEmails` returns `{ ok: false, reason: "not
//     configured" }`, and NOTHING IS WRITTEN. No record, no provenance entry, and above all NO HOP.
//   · A hop is a claim that something was attempted. Writing a `fullenrich` hop with `ok: false`
//     when no request ever left the building would put a lie on the founder's screen, and the entire
//     point of the provenance UI is that its claims are checkable. An absent resolver leaves the
//     waterfall honestly showing the one hop that did happen — Voyager, free, no email — which is
//     the true story of the system as configured today.
//
// ── WHAT A CREDIT COSTS, AND WHY THAT NUMBER IS ABSENT RATHER THAN ZERO ──────────────────────────
// FullEnrich bills in CREDITS and reports `cost.credits` on the result; it does not report dollars,
// and the dollars-per-credit depends on the plan a founder signs. So `credits` is always recorded,
// and `cost_usd` is recorded ONLY when `FULLENRICH_USD_PER_CREDIT` is set. Writing `cost_usd: 0` for
// an unpriced plan would be the worst of the three options: `cloud/lib/gtm.ts` `readProvenance` sums
// hop costs into the figure the founder reads as what enrichment has spent, so a zero there would
// under-report real money — and it would destroy the meaning of Voyager's zero, which is the one
// place in this product where $0.00 is a genuine finding rather than a missing value. `cost_usd` is
// optional in `ProvenanceHop`, so absent renders correctly.
//
// ── ENDPOINT CONFIDENCE ──────────────────────────────────────────────────────────────────────────
// Taken from FullEnrich's public v2 docs, not inferred:
//   · POST `https://app.fullenrich.com/api/v2/contact/enrich/bulk` → `{ enrichment_id }`
//   · GET  `https://app.fullenrich.com/api/v2/contact/enrich/bulk/{enrichment_id}`
//   · `Authorization: Bearer <key>`; status ∈ CREATED | IN_PROGRESS | CANCELED | CREDITS_INSUFFICIENT
//     | FINISHED | RATE_LIMIT | UNKNOWN; emails carry `{ email, status }` where status ∈ DELIVERABLE
//     | HIGH_PROBABILITY | CATCH_ALL | INVALID | INVALID_DOMAIN.
// It is ASYNCHRONOUS — the POST only enqueues — so this submits and then polls. UNVERIFIED against a
// live account, because there is no key to verify with; every failure path therefore returns a
// reason rather than throwing.
import type { DomainStore } from "../domain";
import { PEOPLE_COLLECTION, VOYAGER_RESOLVER, VOYAGER_COST_USD } from "../linkedin/graph";
import { gtmWedge } from "./stages";
import {
  FIRECRAWL_KEY_ENV,
  FIRECRAWL_RESOLVER,
  firecrawlConfigured,
  firecrawlPerson,
  type FirecrawlHop,
} from "./firecrawl";

/**
 * The environment variable a founder sets to turn this on. Nothing else is needed.
 *
 * Read at call time rather than captured at import, so a test — and a founder restarting a process
 * with a new key — does not need the module cache invalidated to change the answer.
 */
export const FULLENRICH_KEY_ENV = "FULLENRICH_API_KEY";

/** Optional. Dollars per FullEnrich credit, from the founder's plan. See the header on why. */
export const FULLENRICH_RATE_ENV = "FULLENRICH_USD_PER_CREDIT";

/** The resolver name in the waterfall. Named for the VENDOR, matching `linkedin-voyager`'s rule. */
export const FULLENRICH_RESOLVER = "fullenrich";

/** Read at call time, like the key, so a process does not have to be re-imported to be reconfigured. */
const base = () => process.env.FULLENRICH_BASE_URL ?? "https://app.fullenrich.com/api/v2";

/**
 * How many people one call may enrich.
 *
 * This is a SPEND ceiling, not a performance one — it is the only limit between a mistyped loop and
 * a founder's enrichment credits. Deliberately small; the caller batches.
 */
export const ENRICH_BATCH = Math.max(1, Math.min(100, Number(process.env.FULLENRICH_BATCH ?? 25)));

/** How long to wait for an asynchronous job before giving up and saying so. */
const POLL_INTERVAL_MS = Number(process.env.FULLENRICH_POLL_MS ?? 3_000);
const POLL_ATTEMPTS = Number(process.env.FULLENRICH_POLL_ATTEMPTS ?? 20);

/** Is the resolver present? False is a normal, supported state — see the header. */
export function fullEnrichConfigured(): boolean {
  return !!(process.env[FULLENRICH_KEY_ENV] ?? "").trim();
}

/** Either hop can enrich. Both off is the only "not configured". */
export function enrichmentConfigured(): boolean {
  return fullEnrichConfigured() || firecrawlConfigured();
}

/** Dollars per credit, or undefined when the founder has not told us. Never guessed. */
function usdPerCredit(): number | undefined {
  const raw = Number(process.env[FULLENRICH_RATE_ENV]);
  return Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

/** One person to resolve. Everything here comes off a `people` record we already hold. */
export interface EnrichTarget {
  /** The `people` collection key — the LinkedIn public identifier. Required: it is where the row goes. */
  key: string;
  name?: string;
  linkedin_url?: string;
  company_domain?: string;
  company?: string;
}

export interface EnrichedPerson {
  key: string;
  email?: string;
  /** FullEnrich's own verification verdict, kept verbatim — a CATCH_ALL is not a DELIVERABLE. */
  email_status?: string;
  personal_email?: string;
  phone?: string;
  linkedin_url?: string;
  headline?: string;
  title?: string;
  photo_url?: string;
  company_logo_url?: string;
  company_domain?: string;
  company_name?: string;
  credits?: number;
}

export interface EnrichResult {
  ok: boolean;
  /** Rows written to the graph. */
  written: number;
  /** How many of the targets came back with a usable address. */
  found: number;
  /** Credits FullEnrich charged for the whole batch, as it reported them. */
  credits: number;
  /** Only present when `FULLENRICH_USD_PER_CREDIT` is configured. */
  cost_usd?: number;
  people: EnrichedPerson[];
  /** Why nothing happened, in words a founder can act on. Present on every non-`ok` return. */
  reason?: string;
}

const NOT_CONFIGURED =
  `lead enrichment is not configured — set ${FIRECRAWL_KEY_ENV} to crawl public company pages, ` +
  `or ${FULLENRICH_KEY_ENV} for the paid email waterfall`;

/** Which paid fields to ask for. Phones cost ~10 credits — off unless FULLENRICH_INCLUDE_PHONES=1. */
export function enrichFieldsRequested(): string[] {
  const fields = ["contact.work_emails", "contact.personal_emails"];
  if ((process.env.FULLENRICH_INCLUDE_PHONES ?? "").trim() === "1") fields.push("contact.phones");
  return fields;
}

/** Split a display name the way FullEnrich wants it. Best effort; it also accepts a LinkedIn URL. */
function splitName(name?: string): { first_name?: string; last_name?: string } {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return { first_name: parts[0] };
  return { first_name: parts[0], last_name: parts.slice(1).join(" ") };
}

/**
 * Which address to keep when the vendor returns several.
 *
 * Ranked rather than "first one wins", because putting a CATCH_ALL in front of a founder as if it
 * were verified is how a sending domain gets burned. INVALID grades are dropped entirely — a known
 * bad address is worse than no address, since it is the one thing that will definitely bounce.
 */
const EMAIL_RANK: Record<string, number> = { DELIVERABLE: 3, HIGH_PROBABILITY: 2, CATCH_ALL: 1 };

export function bestEmail(emails: unknown): { email: string; status: string } | undefined {
  if (!Array.isArray(emails)) return undefined;
  let best: { email: string; status: string; rank: number } | undefined;
  for (const raw of emails) {
    const e = raw as { email?: unknown; status?: unknown };
    if (typeof e?.email !== "string" || !e.email.includes("@")) continue;
    const status = typeof e.status === "string" ? e.status : "UNKNOWN";
    const rank = EMAIL_RANK[status] ?? 0;
    if (rank === 0) continue; // INVALID / INVALID_DOMAIN / anything unrecognised
    if (!best || rank > best.rank) best = { email: e.email, status, rank };
  }
  return best ? { email: best.email, status: best.status } : undefined;
}

function bestPhone(phones: unknown): string | undefined {
  if (!Array.isArray(phones)) return undefined;
  for (const raw of phones) {
    const n = (raw as { number?: unknown })?.number;
    if (typeof n === "string" && n.trim()) return n.trim();
  }
  return undefined;
}

/** Pull LinkedIn URL + role + company logo from a FullEnrich contact row (free with any enrich). */
export function parseRichProfile(row: unknown): {
  linkedin_url?: string;
  headline?: string;
  title?: string;
  location?: string;
  company_name?: string;
  company_domain?: string;
  company_logo_url?: string;
  company_linkedin_url?: string;
  company_industry?: string;
  company_headcount?: number;
} {
  const r = (row ?? {}) as Record<string, unknown>;
  const social = (r.social_profiles as Record<string, unknown> | undefined)?.professional_network as
    | Record<string, unknown>
    | undefined;
  const linkedin_url =
    typeof social?.url === "string"
      ? social.url
      : typeof r.linkedin_url === "string"
        ? r.linkedin_url
        : undefined;
  const loc = r.location as Record<string, unknown> | undefined;
  const location = [loc?.city, loc?.region, loc?.country].filter((x) => typeof x === "string").join(", ") || undefined;
  const emp = (r.employment as Record<string, unknown> | undefined)?.current as Record<string, unknown> | undefined;
  const company = (emp?.company ?? r.company) as Record<string, unknown> | undefined;
  const coSocial = (company?.social_profiles as Record<string, unknown> | undefined)?.professional_network as
    | Record<string, unknown>
    | undefined;
  const industry = (company?.industry as Record<string, unknown> | undefined)?.main_industry;
  return {
    linkedin_url,
    headline: typeof r.headline === "string" ? r.headline : undefined,
    title: typeof emp?.title === "string" ? emp.title : typeof r.title === "string" ? r.title : undefined,
    location,
    company_name: typeof company?.name === "string" ? company.name : undefined,
    company_domain: typeof company?.domain === "string" ? company.domain : undefined,
    company_logo_url: typeof company?.logo_url === "string" ? company.logo_url : undefined,
    company_linkedin_url: typeof coSocial?.url === "string" ? coSocial.url : undefined,
    company_industry: typeof industry === "string" ? industry : undefined,
    company_headcount: typeof company?.headcount === "number" ? company.headcount : undefined,
  };
}

/**
 * Contact_info from FullEnrich — docs use work_emails / personal_emails; older fixtures used emails.
 */
export function contactEmailsFromRow(row: unknown): {
  work?: { email: string; status: string };
  personal?: { email: string; status: string };
  phone?: string;
} {
  const info = ((row as { contact_info?: Record<string, unknown> } | undefined)?.contact_info ??
    {}) as Record<string, unknown>;
  const work =
    bestEmail(info.work_emails) ??
    bestEmail(info.emails) ??
    (typeof (row as { most_probable_work_email?: { email?: string; status?: string } }).most_probable_work_email
      ?.email === "string"
      ? {
          email: (row as { most_probable_work_email: { email: string; status?: string } }).most_probable_work_email
            .email,
          status:
            (row as { most_probable_work_email: { status?: string } }).most_probable_work_email.status ??
            "UNKNOWN",
        }
      : undefined);
  const personal = bestEmail(info.personal_emails);
  const phone =
    bestPhone(info.phones) ??
    (typeof (row as { most_probable_phone?: { number?: string } }).most_probable_phone?.number === "string"
      ? (row as { most_probable_phone: { number: string } }).most_probable_phone.number
      : undefined);
  return { work, personal, phone };
}

/**
 * The provenance entry for the email field, as `cloud/lib/gtm.ts` `readProvenance` renders it.
 *
 * TWO HOPS, ALWAYS, and the first one is the point. Voyager is recorded as a MISS at $0.00 because
 * that is exactly what happened: the free surface was tried first and LinkedIn does not carry email
 * addresses. Recording only the winner would collapse the waterfall to one line and lose the claim
 * the screen exists to make — "it tried the cheap one first" is decoration until you can see the
 * miss.
 */
export function emailProvenance(
  at: string,
  found: boolean,
  credits?: number,
  fire?: Pick<FirecrawlHop, "ok" | "credits" | "reason">,
): Record<string, unknown> {
  const rate = usdPerCredit();
  const paid = credits !== undefined && rate !== undefined ? { cost_usd: Number((credits * rate).toFixed(4)) } : {};
  const attempts: Array<Record<string, unknown>> = [
    { by: VOYAGER_RESOLVER, ok: false, found: false, cost_usd: VOYAGER_COST_USD, at, note: "LinkedIn does not expose email addresses" },
  ];
  if (fire) {
    attempts.push({
      by: FIRECRAWL_RESOLVER,
      ok: fire.ok,
      found: fire.ok,
      ...(fire.credits !== undefined ? { credits: fire.credits } : {}),
      at,
      note: fire.ok ? "address appeared on a public company page" : (fire.reason ?? "no address on the public pages"),
    });
  }
  if (credits !== undefined || found || !fire) {
    attempts.push({
      by: FULLENRICH_RESOLVER,
      ok: found,
      found,
      ...(credits !== undefined ? { credits } : {}),
      ...paid,
      at,
    });
  }
  const by = found ? FULLENRICH_RESOLVER : fire?.ok ? FIRECRAWL_RESOLVER : undefined;
  return {
    email: {
      by,
      at,
      ...paid,
      attempts,
    },
  };
}

/** Provenance for LinkedIn URL / firmographics filled from FullEnrich (often free with enrich). */
export function profileEnrichProvenance(at: string, foundLinkedIn: boolean): Record<string, unknown> {
  return {
    fullenrich_profile: {
      by: foundLinkedIn ? FULLENRICH_RESOLVER : undefined,
      at,
      attempts: [
        {
          by: FULLENRICH_RESOLVER,
          ok: foundLinkedIn,
          found: foundLinkedIn,
          at,
          note: foundLinkedIn
            ? "profile / company fields returned with enrichment"
            : "enrichment returned no professional-network URL",
        },
      ],
    },
  };
}

interface FullEnrichCall {
  ok: boolean;
  status: number;
  json?: unknown;
  detail?: string;
}

/**
 * Strip the credential out of anything on its way to a human.
 *
 * `detail` is returned to the founder and stored on a task, and the strings it is built from are not
 * ours: a vendor error body can echo the request, and a transport error can carry the whole URL. One
 * support screenshot is all it takes, so the redaction happens at the boundary rather than at each
 * site that happens to remember.
 */
function redact(s: string, key: string): string {
  return key ? s.split(key).join("«FULLENRICH_API_KEY»") : s;
}

async function call(path: string, init: RequestInit): Promise<FullEnrichCall> {
  const key = (process.env[FULLENRICH_KEY_ENV] ?? "").trim();
  try {
    const res = await fetch(`${base()}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...(init.headers ?? {}) },
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      /* a non-JSON body is a gateway page, not a result */
    }
    return { ok: res.ok, status: res.status, json, detail: res.ok ? undefined : `fullenrich ${res.status}` };
  } catch (e) {
    return { ok: false, status: 0, detail: redact(`fullenrich unreachable: ${(e as Error)?.message ?? "network error"}`, key) };
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Resolve a rich lead card for people already in this project's graph, and write what came back.
 *
 * Not email-only: FullEnrich returns LinkedIn URL, role, and company logo/firmographics with any
 * enrich (docs). We ask for work + personal emails (phones optional — expensive), then merge onto
 * `people` and refresh `companies` when a logo/domain lands.
 *
 * NEVER THROWS. Money-spending I/O — every failure is a sentence a founder can act on.
 */
export async function enrichEmails(
  domain: DomainStore,
  scope: { project_id: string; case_id?: string },
  targets: EnrichTarget[],
  now: Date = new Date(),
): Promise<EnrichResult> {
  const empty: EnrichResult = { ok: false, written: 0, found: 0, credits: 0, people: [] };
  if (!scope?.project_id) {
    return { ...empty, reason: "lead enrichment needs a project — an unscoped record write lands in the wrong tenant" };
  }
  if (!enrichmentConfigured()) return { ...empty, reason: NOT_CONFIGURED };

  const wanted = targets.filter((t) => t?.key).slice(0, ENRICH_BATCH);
  if (!wanted.length) {
    return { ...empty, ok: false, reason: "nobody to enrich — everyone already has an address, or nobody was selected" };
  }

  const fireOn = firecrawlConfigured();
  const fullOn = fullEnrichConfigured();
  const fireByKey = new Map<string, FirecrawlHop>();
  if (fireOn) {
    for (const t of wanted) {
      fireByKey.set(t.key, await firecrawlPerson(t));
    }
  }

  const stillNeed = fullOn ? wanted.filter((t) => !fireByKey.get(t.key)?.email) : [];

  const fields = enrichFieldsRequested();
  let credits = 0;
  let body: { status?: unknown; data?: unknown; cost?: { credits?: unknown } } | undefined;
  if (stillNeed.length) {
    const submit = await call("/contact/enrich/bulk", {
      method: "POST",
      body: JSON.stringify({
        name: `mycel ${scope.project_id} ${now.toISOString()}`,
        data: stillNeed.map((t) => ({
          ...splitName(t.name),
          ...(t.company_domain ? { domain: t.company_domain } : {}),
          ...(t.company ? { company_name: t.company } : {}),
          ...(t.linkedin_url ? { linkedin_url: t.linkedin_url } : {}),
          enrich_fields: fields,
          custom: { user_id: t.key },
        })),
      }),
    });
    const enrichmentId = (submit.json as { enrichment_id?: unknown } | undefined)?.enrichment_id;
    if (!submit.ok || typeof enrichmentId !== "string") {
      return { ...empty, reason: submit.detail ?? "fullenrich did not accept the batch" };
    }

    for (let i = 0; i < POLL_ATTEMPTS; i++) {
      await sleep(POLL_INTERVAL_MS);
      const got = await call(`/contact/enrich/bulk/${encodeURIComponent(enrichmentId)}`, { method: "GET" });
      if (!got.ok) {
        if (got.status === 429) continue;
        return { ...empty, reason: got.detail ?? "fullenrich result read failed" };
      }
      body = got.json as typeof body;
      const status = String(body?.status ?? "");
      if (status === "FINISHED") break;
      if (status === "CREDITS_INSUFFICIENT") {
        return { ...empty, reason: "your FullEnrich account is out of credits — top it up and run this again" };
      }
      if (status === "CANCELED") return { ...empty, reason: "fullenrich cancelled this enrichment" };
      body = undefined;
    }
    if (!body) return { ...empty, reason: "fullenrich did not finish in time — the credits are not spent twice if you retry" };
    credits = Number(body.cost?.credits ?? 0) || 0;
  }

  const at = now.toISOString();
  const rows = Array.isArray(body?.data) ? body!.data : [];
  const byKey = new Map(wanted.map((t) => [t.key, t]));
  const fullByKey = new Map<string, unknown>();
  for (const raw of rows) {
    const key = typeof (raw as { custom?: { user_id?: unknown } })?.custom?.user_id === "string"
      ? (raw as { custom: { user_id: string } }).custom.user_id
      : "";
    if (key) fullByKey.set(key, raw);
  }

  const existing = new Map<string, Record<string, unknown>>();
  try {
    for (const rec of await domain.queryRecords({ project_id: scope.project_id, wedge: gtmWedge(), collection: PEOPLE_COLLECTION })) {
      const prov = (rec.data as Record<string, unknown> | undefined)?.provenance;
      if (byKey.has(rec.key) && prov && typeof prov === "object") existing.set(rec.key, prov as Record<string, unknown>);
    }
  } catch (e) {
    console.error("[mycel] could not read existing provenance before enrichment:", e);
  }
  const people: EnrichedPerson[] = [];
  let written = 0;
  let found = 0;
  const fireCredits = [...fireByKey.values()].reduce((s, h) => s + h.credits, 0);

  for (const t of wanted) {
    const raw = fullByKey.get(t.key);
    const fire = fireByKey.get(t.key);
    const emails = raw
      ? contactEmailsFromRow(raw)
      : { work: fire?.email ? { email: fire.email, status: "ON_PAGE" } : undefined, personal: undefined, phone: fire?.phone };
    const rich = raw ? parseRichProfile(raw) : {};
    if (emails.work) found++;

    const person: EnrichedPerson = {
      key: t.key,
      email: emails.work?.email,
      email_status: emails.work?.status,
      personal_email: emails.personal?.email,
      phone: emails.phone ?? fire?.phone,
      linkedin_url: rich.linkedin_url,
      headline: rich.headline,
      title: rich.title,
      company_logo_url: rich.company_logo_url,
      company_domain: rich.company_domain ?? t.company_domain,
      company_name: rich.company_name ?? t.company,
    };
    people.push(person);

    const fullShare = stillNeed.length && raw !== undefined ? credits / stillNeed.length : stillNeed.length ? 0 : undefined;
    try {
      const data: Record<string, unknown> = {
        ...(emails.work ? { email: emails.work.email, email_status: emails.work.status } : {}),
        ...(emails.personal
          ? { personal_email: emails.personal.email, personal_email_status: emails.personal.status }
          : {}),
        ...(person.phone ? { phone: person.phone } : {}),
        ...(rich.linkedin_url ? { linkedin_url: rich.linkedin_url } : {}),
        ...(rich.headline ? { headline: rich.headline } : {}),
        ...(rich.title ? { title: rich.title } : {}),
        ...(rich.location ? { location: rich.location } : {}),
        ...(rich.company_name ? { company: rich.company_name } : {}),
        ...(rich.company_domain ? { company_domain: rich.company_domain, company_key: rich.company_domain } : {}),
        provenance: {
          ...(existing.get(t.key) ?? {}),
          ...emailProvenance(at, !!raw && !!emails.work, fullShare, fire),
          ...(raw ? profileEnrichProvenance(at, !!rich.linkedin_url) : {}),
        },
      };
      await domain.upsertRecord({
        project_id: scope.project_id,
        wedge: gtmWedge(),
        collection: PEOPLE_COLLECTION,
        key: t.key,
        data,
        case_id: scope.case_id,
      });
      written++;

      if (rich.company_domain || rich.company_name) {
        const ckey = rich.company_domain ?? rich.company_name!.toLowerCase().replace(/\s+/g, "-");
        try {
          await domain.upsertRecord({
            project_id: scope.project_id,
            wedge: gtmWedge(),
            collection: "companies",
            key: ckey,
            data: {
              ...(rich.company_name ? { name: rich.company_name } : {}),
              ...(rich.company_domain ? { domain: rich.company_domain } : {}),
              ...(rich.company_logo_url ? { logo_url: rich.company_logo_url } : {}),
              ...(rich.company_linkedin_url ? { linkedin_url: rich.company_linkedin_url } : {}),
              ...(rich.company_industry ? { industry: rich.company_industry } : {}),
              ...(rich.company_headcount !== undefined ? { headcount: rich.company_headcount } : {}),
              source: raw ? "fullenrich" : "firecrawl",
            },
            case_id: scope.case_id,
          });
        } catch (e) {
          console.error(`[mycel] could not write enriched company ${ckey}:`, e);
        }
      }
    } catch (e) {
      console.error(`[mycel] could not write enriched person ${t.key}:`, e);
    }
  }

  const rate = usdPerCredit();
  const lost = people.length > 0 && written === 0;
  const totalCredits = credits + fireCredits;
  return {
    ok: !lost && written > 0,
    ...(lost
      ? {
          reason:
            `enrichment ran and ${totalCredits} credit(s) were spent, but none of the ${people.length} result(s) could be ` +
            `written — the addresses were paid for and are not saved. The harness log has the write error.`,
        }
      : written === 0
        ? { reason: "enrichment ran and nothing could be written" }
        : {}),
    written,
    found,
    credits: totalCredits,
    ...(rate !== undefined ? { cost_usd: Number((credits * rate).toFixed(4)) } : {}),
    people,
  };
}

/**
 * The targets for a project, read out of the graph.
 *
 * Skips anyone who already has a work email AND a LinkedIn URL — both sides of the lead card.
 * Re-resolving costs credits; a missing LinkedIn with an email (or the reverse) still qualifies.
 */
export async function enrichableFromGraph(
  domain: DomainStore,
  projectId: string,
  keys: string[],
): Promise<EnrichTarget[]> {
  if (!projectId || !keys.length) return [];
  const rows = await domain.queryRecords({ project_id: projectId, wedge: gtmWedge(), collection: PEOPLE_COLLECTION });
  const byKey = new Map(rows.map((r) => [r.key, r]));

  const out: EnrichTarget[] = [];
  for (const key of keys) {
    const row = byKey.get(key);
    if (!row) continue;
    const d = (row.data ?? {}) as Record<string, unknown>;
    const hasEmail = typeof d.email === "string" && !!d.email;
    const hasLi = typeof d.linkedin_url === "string" && !!d.linkedin_url;
    if (hasEmail && hasLi) continue;
    out.push({
      key,
      name: typeof d.name === "string" ? d.name : undefined,
      linkedin_url: typeof d.linkedin_url === "string" ? d.linkedin_url : undefined,
      company_domain:
        typeof d.company_domain === "string"
          ? d.company_domain
          : typeof d.company_key === "string"
            ? d.company_key
            : undefined,
      company: typeof d.company === "string" ? d.company : undefined,
    });
  }
  return out;
}

/** @deprecated Prefer calling enrichEmails — same function; name kept for older routes. */
export const enrichLeads = enrichEmails;
