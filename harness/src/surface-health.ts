// Which answer engines we can actually reach, and for how long we have not been able to.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// THE MEASUREMENT SERVICE HAS TO KNOW WHEN IT CANNOT MEASURE
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// `probe_surface` reports `reached: false` honestly, one probe at a time, and each of those is a
// small true statement that nothing was keeping. So the same wall was rediscovered on every run: the
// eighth blocked probe of the week cost the same thirty seconds and the same tokens as the first,
// and the founder was never told the reason their report had a hole in it.
//
// Measured 30 August 2026, all four surfaces, from production: chatgpt captcha, perplexity and
// claude Cloudflare Turnstile. Not a code failure — the probes leave from a datacenter IP and
// Turnstile scores the ASN before the first request finishes.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// WHY THIS IS A FOUNDER-FACING FACT AND NOT AN OPS METRIC
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// The founder is selling a monitoring retainer. If ChatGPT has been unreachable for nine days they
// need to know BEFORE their client asks, because the alternative is finding out in the meeting. And
// "we could not reach ChatGPT this period, here is what we did measure" is a survivable sentence
// where a quietly incomplete report is not.
//
// So it is recorded per surface, with the reason and the streak, and it is on a screen.
import type { RecordStoreish } from "./skill-arsenal";

/** The record collection. One row per surface per project. */
export const SURFACE_HEALTH_COLLECTION = "geo_surface_health";

/** The task type whose outcome this is derived from. */
export const PROBE_TASK_TYPE = "probe_surface";

export interface SurfaceHealth {
  surface: string;
  /** Consecutive probes that never got an answer. Reset by a single success. */
  blocked_streak: number;
  /** ISO timestamp of the last probe that DID get an answer, if there has ever been one. */
  last_reached_at?: string;
  last_probe_at: string;
  /** Why the most recent probe failed, verbatim from the agent. */
  last_blocked_by?: string;
  /** Whether the most recent probe got an answer. */
  reached: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Fold one probe outcome into the surface's record.
 *
 * Pure, and separate from the store, because the interesting judgement is the streak arithmetic and
 * it should be testable without a database. `prev` is whatever was stored, which may be nothing and
 * may be a shape written by an older version — hence the defensive reads.
 */
export function foldProbe(
  prev: Partial<SurfaceHealth> | undefined,
  probe: { surface: string; reached: boolean; blocked_by?: string; at: string },
): SurfaceHealth {
  const streak = typeof prev?.blocked_streak === "number" ? prev.blocked_streak : 0;
  return {
    surface: probe.surface,
    // A SINGLE SUCCESS CLEARS THE STREAK, deliberately. These blocks are probabilistic — a surface
    // that let one probe through is reachable, and carrying a decayed count would keep warning a
    // founder about a wall that is no longer there.
    blocked_streak: probe.reached ? 0 : streak + 1,
    last_probe_at: probe.at,
    reached: probe.reached,
    ...(probe.reached ? { last_reached_at: probe.at } : prev?.last_reached_at ? { last_reached_at: prev.last_reached_at } : {}),
    ...(probe.reached ? {} : probe.blocked_by ? { last_blocked_by: probe.blocked_by } : {}),
  };
}

/**
 * Record what a probe found out about its surface.
 *
 * Called on every `probe_surface` completion, reached or not — unlike `keepServiceResearch`, which
 * deliberately drops the unreached ones. The difference is what the two records are FOR: that one
 * stores what was learned about a market, and a failed look teaches nothing about a market. This one
 * stores what was learned about the surface, and a failed look is the entire lesson.
 */
export async function noteProbe(
  domain: RecordStoreish,
  args: { project_id: string; output: unknown; at?: string },
): Promise<void> {
  if (!args.project_id || !isRecord(args.output)) return;
  const surface = typeof args.output.surface === "string" ? args.output.surface.trim() : "";
  if (!surface) return;
  const at = args.at ?? new Date().toISOString();

  const rows = (await domain
    .queryRecords({ project_id: args.project_id, wedge: "kernel", collection: SURFACE_HEALTH_COLLECTION })
    .catch(() => [])) as unknown[];
  const prev = rows
    .map((r) => (isRecord(r) && isRecord(r.data) ? (r.data as Partial<SurfaceHealth>) : undefined))
    .find((d) => d?.surface === surface);

  const next = foldProbe(prev, {
    surface,
    // `reached` is required by the output schema, so an absent one means a shape nobody validated.
    // Treated as unreached: the safe reading is "we did not get an answer", because the cost of
    // being wrong the other way is a report that claims a measurement it does not have.
    reached: args.output.reached === true,
    ...(typeof args.output.blocked_by === "string" ? { blocked_by: args.output.blocked_by } : {}),
    at,
  });

  await domain.upsertRecord({
    project_id: args.project_id,
    wedge: "kernel",
    collection: SURFACE_HEALTH_COLLECTION,
    // Keyed by surface, so the row is replaced rather than accumulated. The history that matters is
    // the streak, and it is carried in the row.
    key: surface,
    data: next as unknown as Record<string, unknown>,
    observed_at: at,
  });
}

/** Below this a block is noise — surfaces refuse a single probe for all sorts of reasons. */
export const PERSISTENT_BLOCK = 3;

export interface SurfaceWarning {
  surface: string;
  says: string;
  blocked_streak: number;
}

/**
 * The surfaces a founder needs to be told about, worst first.
 *
 * Only PERSISTENT blocks. A one-off refusal is normal operation and warning about it would train
 * the founder to ignore this, which costs the warning that matters.
 */
export function surfaceWarnings(rows: readonly Partial<SurfaceHealth>[]): SurfaceWarning[] {
  return rows
    .filter((r): r is SurfaceHealth => typeof r?.surface === "string" && (r.blocked_streak ?? 0) >= PERSISTENT_BLOCK)
    .map((r) => ({
      surface: r.surface,
      blocked_streak: r.blocked_streak,
      says:
        `${label(r.surface)} has blocked the last ${r.blocked_streak} probes` +
        (r.last_blocked_by ? ` (${r.last_blocked_by})` : "") +
        // NEVER REACHED reads differently from STOPPED REACHING, and a founder about to talk to a
        // client needs the second one framed as a change rather than as a standing condition.
        (r.last_reached_at
          ? `. Last answer was ${r.last_reached_at.slice(0, 10)}.`
          : `. It has never returned an answer for this client.`) +
        ` Reports for this period cover the surfaces that did answer, and say so.`,
    }))
    .sort((a, b) => b.blocked_streak - a.blocked_streak);
}

function label(s: string): string {
  const known: Record<string, string> = {
    chatgpt: "ChatGPT",
    perplexity: "Perplexity",
    claude: "Claude",
    google_ai: "Google AI Mode",
    copilot: "Copilot",
  };
  return known[s] ?? s;
}
