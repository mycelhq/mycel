// The insight surface: one near-public write, two founder-authed reads. Mounted with one line.
//
// ── The credential split, which is the whole security story ──
//
// `POST /v1/insight/events` is reachable, in effect, by anyone who can load a founder's homepage.
// It therefore does NOT accept the founder's product key — that key can start tasks, read every
// client, mint sessions and change the plan. It accepts only a per-project ingest key whose entire
// authority is "append events to this one project" (`keys.ts`), and the project it writes to is the
// one the key's SIGNATURE resolves to. There is no code path here that reads a project id out of a
// request body, a query string or a header. That is not an oversight to be tidied up later; it is
// the only reason a public write path is acceptable at all.
//
// `GET /v1/insight/summary` and `GET /v1/insight/key` are the opposite: they read, so they sit
// behind the normal founder credential and the normal tenancy helpers, and an ingest key is useless
// against them.
import type { Hono } from "hono";
import type { DomainStore } from "../domain";
import { bearer } from "../auth";
import { ingestKeyFor, projectForIngestKey } from "./keys";
import { LIMITS, normaliseBatch } from "./schema";
import { storeBatch, storeFunnel } from "./store";
import { buildSummary } from "./summary";

export interface InsightRouteDeps {
  domain: DomainStore;
  /** The projects the caller may READ. Fails closed; see `identity.accessibleProjectIds`. */
  accessible(c: any): Set<string>;
}

/**
 * Per-project write ceiling.
 *
 * A minute's worth of batches from one project. This is not abuse prevention — an ingest key holder
 * can always spread writes over time — it is blast-radius control: one product in a loop must not
 * be able to fill the records table on behalf of every other tenant sharing it. Keyed by the
 * VERIFIED project, never by anything the caller supplies, so it cannot be evaded by rotating a
 * header. In-process, like the task rate limiter above it in server.ts; with N replicas the real
 * ceiling is N× this, which is still a ceiling.
 */
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_BATCHES = 600;
const rate = new Map<string, { count: number; until: number }>();

function rateLimited(projectId: string, now: number): boolean {
  const seen = rate.get(projectId);
  if (!seen || seen.until <= now) {
    rate.set(projectId, { count: 1, until: now + RATE_WINDOW_MS });
    // Bounded: the map would otherwise grow one entry per project id ever seen, and project ids
    // come from verified keys but the set of projects is not fixed.
    if (rate.size > 5_000) for (const [k, v] of rate) if (v.until <= now) rate.delete(k);
    return false;
  }
  seen.count += 1;
  return seen.count > RATE_MAX_BATCHES;
}

export function mountInsight(app: Hono, deps: InsightRouteDeps): void {
  const { domain } = deps;

  /**
   * Ingest. Authenticated by ingest key, scoped by its signature, redacted on arrival.
   *
   * Fails closed at every branch, and says as little as possible while doing it: the body of a
   * refusal would tell someone probing which cap they tripped, and there is nobody on the other end
   * of this request who benefits from knowing. `sendBeacon` ignores the response entirely.
   */
  app.post("/v1/insight/events", async (c) => {
    const projectId = projectForIngestKey(bearer(c));
    // Not 403: an unverifiable key is indistinguishable from no key, and saying "wrong project"
    // would confirm that a project id someone guessed exists.
    if (!projectId) return c.body(null, 401);

    // Length header first — it is free — and then the actual bytes, because `content-length` is a
    // claim, and a chunked body carries no length at all.
    const declared = Number(c.req.header("content-length") ?? 0);
    if (Number.isFinite(declared) && declared > LIMITS.maxBodyBytes) return c.body(null, 413);
    let raw: string;
    try {
      raw = await c.req.text();
    } catch {
      return c.body(null, 400);
    }
    if (raw.length > LIMITS.maxBodyBytes) return c.body(null, 413);

    if (rateLimited(projectId, Date.now())) return c.body(null, 429);

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return c.body(null, 400);
    }
    const result = normaliseBatch(parsed);
    if (!result.ok) return c.body(null, result.status);

    const now = new Date();
    // The declaration is written first: it is what makes the events that follow interpretable, and
    // a batch that fails halfway is better off having recorded the shape than the contents.
    if (result.batch.funnel && result.batch.funnelSteps) {
      await storeFunnel(domain, projectId, result.batch.funnel, result.batch.funnelSteps, now);
    }
    await storeBatch(domain, projectId, result.batch, now);
    // 204 and nothing else. No id, no echo of what was stored, no count — every one of those is a
    // free oracle for someone testing what gets through the redactor.
    return c.body(null, 204);
  });

  /**
   * The summary a MODEL reads. See `summary.ts` for why it is shaped the way it is.
   *
   * One project per call, always. `accessibleProjectIds` narrows to the `X-Mycel-Project` header
   * when one is given and fails closed when it names a project outside the caller's scope — so a
   * member in an org with two projects must say which, rather than getting an average of both that
   * describes neither.
   */
  app.get("/v1/insight/summary", async (c) => {
    const set = deps.accessible(c);
    if (set.size === 0) return c.json({ error: "no project in scope" }, 403);
    if (set.size > 1) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    const projectId = [...set][0]!;
    const days = Number(c.req.query("days") ?? 7);
    const funnel = c.req.query("funnel")?.trim().toLowerCase() || undefined;
    return c.json(
      await buildSummary(domain, projectId, {
        days: Number.isFinite(days) ? days : 7,
        funnel,
      }),
    );
  });

  /**
   * Mint the project's ingest key, for the founder to put in their product's server environment.
   *
   * Derived rather than stored, so this is idempotent and there is nothing to leak by asking twice
   * (`keys.ts`). It still requires the founder credential: the key is not a secret worth much, but
   * handing it out unauthenticated would let anyone who knows a project id poison its analytics.
   */
  app.get("/v1/insight/key", async (c) => {
    const set = deps.accessible(c);
    if (set.size === 0) return c.json({ error: "no project in scope" }, 403);
    if (set.size > 1) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    const projectId = [...set][0]!;
    return c.json({
      project_id: projectId,
      ingest_key: ingestKeyFor(projectId),
      // Said here rather than only in the docs, because this value is going to be copied into a
      // hosting dashboard by someone who is not reading the docs at that moment.
      env: "INSIGHT_INGEST_KEY",
      note: "Server env var only — never NEXT_PUBLIC_. It appends events to this project and nothing else.",
    });
  });
}
