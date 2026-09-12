import { RESEARCH_COLLECTION, latestServiceResearch, withDraftServiceArsenal } from "./skill-arsenal";

/**
 * EVERYTHING THIS BUSINESS SELLS, NOT JUST THE ONE JOB WE STARTED WITH.
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * THE EVIDENCE WE ALREADY PAID FOR AND THREW AWAY
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `research_service` is the only job in this product that leaves the building. It reads how a trade
 * actually works and returns, among other things, `deliverables[]` — the nouns a client receives,
 * each with a cadence, an hours estimate and the URL it was read from. Production's single research
 * record holds EIGHT of them: a visibility audit, a tracked prompt set, a weekly answer-engine
 * report, a citation gap analysis, and four more.
 *
 * The founder has never seen one of them. The findings were written to a record, handed to the
 * drafting run, and exposed on no route — so the product asked "what do you sell", took one sentence
 * back, went and researched the real answer, and then never mentioned it. Onboarding's header still
 * says "Your service", singular, to a business that the research says delivers eight things.
 *
 * That is the gap this closes, and it is deliberately not a form. A blank "list your services" box
 * is the worst version of this question: it asks a founder to do the recall work at the exact moment
 * they are least motivated, and what comes back is four words. Showing them eight specific
 * deliverables their own trade publishes, and asking which ones they actually do, is a different
 * question — recognition instead of recall, which is the oldest result in this field and the reason
 * a menu beats a prompt.
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THE PICKS ARE STORED SEPARATELY FROM THE RESEARCH
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The research is what the WORLD says the trade does; the offering is what THIS founder says they
 * do. Writing the picks back onto the research record would destroy that distinction, and it is the
 * distinction that makes both useful — a founder who does two of the eight has told us something
 * specific and valuable about their positioning, and that fact is only legible next to the eight.
 *
 * It also means a re-run of the research cannot silently un-pick things the founder confirmed.
 */

export const OFFERING_COLLECTION = "service_offering";

/** One thing a client receives. `source` is a URL a research run actually opened. */
export interface ResearchedDeliverable {
  what: string;
  cadence?: string;
  source?: string;
  typical_hours?: number;
}

export interface OfferingItem {
  /** As the founder would name it. Theirs when they typed it, the research's when they ticked it. */
  what: string;
  cadence?: string;
  typical_hours?: number;
  /**
   * Where this came from. `research` means we proposed it and they agreed; `founder` means they
   * added it themselves — and that difference matters, because a deliverable nobody found on the
   * open web is exactly the one worth asking more about.
   */
  from: "research" | "founder";
}

export interface Offering {
  items: OfferingItem[];
  at: string;
}

interface RecordStoreish {
  queryRecords(q: { project_id: string; wedge: string; collection: string }): Promise<unknown[]>;
  upsertRecord(r: {
    project_id: string;
    wedge: string;
    collection: string;
    key: string;
    data: Record<string, unknown>;
    observed_at?: string;
  }): Promise<unknown>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** A number that a model may have written as a string, or as nonsense. Absent beats wrong. */
function hours(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.trim()) : NaN;
  // Nothing a person delivers takes zero hours, and nothing this list describes takes a fortnight.
  // Both bounds exist so a bad parse shows up as "we don't know" rather than as a confident 0.
  return Number.isFinite(n) && n > 0 && n <= 400 ? n : undefined;
}

const clean = (v: unknown, max: number): string | undefined => {
  const s = String(v ?? "").trim();
  return s ? s.slice(0, max) : undefined;
};

/**
 * What the research found this trade delivers.
 *
 * Deliberately NOT freshness-checked, unlike `latestServiceResearch`. That function gates what gets
 * fed to a drafting run, where stale evidence would silently shape a service; this one answers "what
 * did we find out about your trade", and a four-week-old answer to that is still the true answer to
 * what we found. Hiding it would put a founder back on the empty screen this exists to replace.
 */
export async function researchedDeliverables(
  domain: RecordStoreish,
  projectId: string | undefined,
): Promise<ResearchedDeliverable[]> {
  if (!projectId) return [];
  try {
    const rows = await domain.queryRecords({ project_id: projectId, wedge: "kernel", collection: RESEARCH_COLLECTION });
    const data = (rows ?? []).map((r) => (r as { data?: unknown }).data).find(isRecord);
    const raw = Array.isArray(data?.deliverables) ? data.deliverables : [];
    const out: ResearchedDeliverable[] = [];
    const seen = new Set<string>();
    for (const d of raw) {
      if (!isRecord(d)) continue;
      const what = clean(d.what, 200);
      if (!what) continue;
      // Two research passes over the same trade return overlapping nouns. A list that shows the
      // same deliverable twice reads as a product that cannot count, on the screen where we are
      // asking to be trusted with the whole business.
      const k = what.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ what, cadence: clean(d.cadence, 120), source: clean(d.source, 400), typical_hours: hours(d.typical_hours) });
    }
    return out.slice(0, 12);
  } catch {
    return [];
  }
}

export async function readOffering(domain: RecordStoreish, projectId: string | undefined): Promise<Offering | undefined> {
  if (!projectId) return undefined;
  try {
    const rows = await domain.queryRecords({ project_id: projectId, wedge: "kernel", collection: OFFERING_COLLECTION });
    const data = (rows ?? []).map((r) => (r as { data?: unknown }).data).find(isRecord);
    if (!data) return undefined;
    return { items: normalizeItems(data.items), at: String(data.at ?? "") };
  } catch {
    return undefined;
  }
}

/**
 * Clean a submitted offering.
 *
 * Exported because the route needs it and so does the test, and because every rule it enforces is a
 * rule about what a founder is allowed to have typed rather than a detail of storage.
 */
export function normalizeItems(raw: unknown): OfferingItem[] {
  if (!Array.isArray(raw)) return [];
  const out: OfferingItem[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    if (!isRecord(r)) continue;
    const what = clean(r.what, 200);
    if (!what) continue;
    const k = what.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({
      what,
      cadence: clean(r.cadence, 120),
      typical_hours: hours(r.typical_hours),
      from: r.from === "founder" ? "founder" : "research",
    });
    // Eight is the manifest's own ceiling for jobs in one service. A list longer than the thing it
    // feeds is a list that promises something the next step cannot deliver.
    if (out.length >= 12) break;
  }
  return out;
}

/**
 * The offering as one line for a drafting run's input.
 *
 * A SENTENCE, not JSON. This is read by a model that is writing a service definition, and a list of
 * objects invites it to copy the shape rather than the meaning. Hours are included where known
 * because "6 hours" is what tells the drafter this is a real piece of work and not a checkbox.
 */
export function offeringLine(o: Offering | undefined): string | undefined {
  if (!o?.items.length) return undefined;
  const parts = o.items.map((i) => {
    const bits = [i.cadence, i.typical_hours ? `${i.typical_hours}h` : undefined].filter(Boolean);
    return bits.length ? `${i.what} (${bits.join(", ")})` : i.what;
  });
  return `The founder confirmed they deliver: ${parts.join("; ")}.`;
}

/**
 * Store what the founder said they deliver.
 *
 * `key: "latest"` and an upsert, matching `keepServiceResearch` — there is one answer to "what do
 * you sell" per business, and a history of every time they re-ticked the list is data nobody would
 * ever read. Changing their mind should look like changing their mind, not like an audit trail.
 *
 * An EMPTY list is stored, not skipped. "I do none of these eight" is a real and useful answer — it
 * says the research missed the trade — and refusing to persist it would make the screen re-ask a
 * question the founder has already answered, which is the single most reliable way to make somebody
 * stop answering.
 */
export async function saveOffering(
  domain: RecordStoreish,
  args: { project_id: string; items: unknown; at?: string },
): Promise<Offering> {
  const at = args.at ?? new Date().toISOString();
  const items = normalizeItems(args.items);
  await domain.upsertRecord({
    project_id: args.project_id,
    wedge: "kernel",
    collection: OFFERING_COLLECTION,
    key: "latest",
    data: { items, at },
    /**
     * NO `observed_at`, and that is the whole reason this upserts rather than accumulating.
     *
     * The conflict key is `(project_id, wedge, collection, key, observed_at)` — Postgres and the
     * in-memory twin agree on that — so a fresh timestamp makes every save a DIFFERENT key, and it
     * inserts instead of updating.
     *
     * Reads survive that: `queryRecords` sorts newest-first, so the latest answer still wins. What
     * does not survive is the table. This is the one record in the product a founder edits
     * repeatedly, so it is one row per tick, forever, behind a `limit 200` read — and the answer
     * goes quietly unreachable on the two-hundred-and-first. `keepServiceResearch` passes a
     * timestamp and gets away with it only because research runs once per business.
     *
     * The timestamp still lives inside `data.at`, where it is a fact to display rather than part of
     * an identity. And because the whole list sits under one top-level key, jsonb `||` replaces it
     * outright — an untick actually unticks.
     */
  });
  return { items, at };
}

/**
 * Everything a `draft_service` run is given: the trade's research, and this founder's answer to it.
 *
 * ONE FUNCTION, called from ONE place, because the alternative is what this repo keeps shipping.
 * Composing these three calls inline in `runtime.ts` would leave the behaviour testable only through
 * a full task run, and the tests that got written instead would exercise `withDraftServiceArsenal`
 * and `offeringLine` directly — proving both helpers work and nothing at all about whether the
 * drafting run is handed either. `arsenal-reaches-delivery.test.ts` exists because that already
 * happened once.
 *
 * Both lookups fail soft on their own. A drafting run that dies because a record lookup did is
 * strictly worse than one written the way it was written before any of this existed.
 */
export async function draftServiceInput(
  domain: RecordStoreish & Parameters<typeof latestServiceResearch>[0],
  task: { input?: unknown; project_id?: string },
): Promise<Record<string, unknown>> {
  const [research, offering] = await Promise.all([
    latestServiceResearch(domain, task.project_id),
    readOffering(domain, task.project_id),
  ]);
  const withResearch = withDraftServiceArsenal(task.input, research);
  const stated = offeringLine(offering);
  /**
   * A key on the input, so it lands in the `Input: {…}` line every run already reads, next to the
   * description the founder typed. Not folded into `research`: what the web says the trade does and
   * what this founder says THEY do are different claims, and a drafter that cannot tell them apart
   * will write the average firm's service and call it theirs.
   */
  return stated ? { ...withResearch, offering: stated } : withResearch;
}
