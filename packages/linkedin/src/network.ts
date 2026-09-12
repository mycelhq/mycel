// The return path: who accepted.
//
// ── THE PROBLEM ──────────────────────────────────────────────────────────────────────────────────
// LinkedIn has no webhook and no push. An invitation goes out and, as far as this system was
// concerned, nothing ever came back — so a case sat at `invited` until the sequencer closed it
// `lost` at twenty-one days, and `connected`, `dm1` and `dm2` were unreachable stages. The whole
// outbound half of the GTM loop worked and could never produce a conversation.
//
// ── WHY THE CONNECTIONS LIST, AND NOT THE OTHER TWO CANDIDATES ───────────────────────────────────
// Three surfaces could answer "did they accept":
//
//   1. PER-PROFILE RELATIONSHIP DEGREE (`/identity/profiles/{id}/profileView`, read `distance`).
//      Precise, and disqualified on cost and on shape: it is ONE REQUEST PER PENDING PROSPECT, so a
//      founder with 200 invitations out generates 200 profile fetches per poll. That is both the
//      most expensive option by two orders of magnitude and — far worse — it is the exact traffic
//      pattern automation detection is built to find. No human opens 200 profiles an hour, every
//      hour, in the same order.
//
//   2. THE SENT-INVITATIONS LIST (`/relationships/sentInvitationViewsV2`). Cheap, and it answers a
//      different question than it appears to: an invitation LEAVES that list when it is accepted,
//      when it is withdrawn, AND when the recipient simply dismisses it. Absence is therefore
//      ambiguous, and resolving the ambiguity needs the connections list anyway — so this would be
//      a second request that adds nothing the first one does not already say.
//
//   3. THE CONNECTIONS LIST (here). ONE request per account per poll, whatever the pipeline size,
//      sorted newest-first so the people who just accepted are on page one. It is the request
//      linkedin.com/mynetwork/invite-connect/connections/ makes on page load, with the same headers
//      and the same page size, so it adds no distinguishable pattern to the account. And presence
//      is UNAMBIGUOUS in the direction that matters: someone who is first-degree, on a case that
//      says we invited them, accepted our invitation. There is no other way for that pair of facts
//      to be true.
//
// ── WHAT THIS DELIBERATELY DOES NOT DO ───────────────────────────────────────────────────────────
// It does not page. One page, newest first, and if a founder somehow gained more than a page of
// connections between two polls the extra ones are learned on the next poll or not at all. Paging
// through an entire connection graph to find three acceptances is the scraping behaviour this file
// is written to avoid, and the cost of missing one is a message sent a day late.
//
// ── ENDPOINT CONFIDENCE ──────────────────────────────────────────────────────────────────────────
//   · `GET /voyager/api/relationships/connections?start&count&sortType=RECENTLY_ADDED` — CONFIDENT
//     on the path and on `sortType`; it is the long-lived connections endpoint. INFERRED on the
//     exact response envelope, which is why the parsing below reuses search.ts's recursive walk
//     rather than a path lookup: the paths are what LinkedIn renames, and a walk survives it.
import { parsePeople } from "./search";
import { VOYAGER, voyagerCall, type LinkedInSession, type VoyagerCtx } from "./voyager";

/**
 * How many recent connections one poll reads.
 *
 * Forty is what the web client's own first page asks for. It is also comfortably more than an
 * account operating inside this system's pacing can accumulate in an hour — the poll interval —
 * so a single page really is the whole delta in every non-pathological case.
 */
export const CONNECTIONS_PAGE = Math.max(1, Math.min(100, Number(process.env.MYCEL_LINKEDIN_CONNECTIONS_COUNT ?? 40)));

export interface RecentConnections {
  ok: boolean;
  /** Public identifiers, newest first. THE natural key — the same one a case carries as `profile_id`. */
  public_ids: string[];
  /** Decoded response size, so a caller can assert this stayed the cheap read it claims to be. */
  bytes: number;
  detail?: string;
}

/**
 * The public identifiers in a connections payload.
 *
 * Pure, so it is testable against a fixture without a session — the same split search.ts and
 * people.ts make, and for the same reason: the fetch is unverifiable from here and the parser is
 * the part that breaks on a LinkedIn deploy.
 *
 * `parsePeople` is reused rather than reimplemented because it already walks every envelope shape
 * Voyager serves, already drops nodes with no public identifier (unkeyable, so unmatchable against
 * a case), and already merges duplicates that the walk finds twice by design.
 */
export function connectionIds(payload: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of parsePeople(payload)) {
    if (!p.public_id || seen.has(p.public_id)) continue;
    seen.add(p.public_id);
    out.push(p.public_id);
  }
  return out;
}

/**
 * Read the account's most recent first-degree connections.
 *
 * NEVER THROWS on a LinkedIn refusal — it reports `ok: false`. The caller is a poller running
 * inside the sequencer tick, and a 403 from Voyager must not become an exception that parks
 * twenty-five unrelated cases with "sequencer error".
 */
export async function recentConnections(
  session: LinkedInSession,
  ctx: VoyagerCtx,
  count: number = CONNECTIONS_PAGE,
): Promise<RecentConnections> {
  const params = new URLSearchParams({ start: "0", count: String(Math.max(1, Math.min(100, count))), sortType: "RECENTLY_ADDED" });
  const r = await voyagerCall(`${VOYAGER}/relationships/connections?${params}`, session, ctx, "connections");
  if (!r.ok) return { ok: false, public_ids: [], bytes: r.decoded, detail: `voyager connections ${r.status}` };
  return { ok: true, public_ids: connectionIds(r.json), bytes: r.decoded };
}
