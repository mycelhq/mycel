/**
 * Super-admin product analytics, questionnaires, and agency digests.
 *
 * Three surfaces, one file, because they share a gate: a member session on the allowlist, or the
 * control token the product cron holds. A leaked product API key must not list every tenant.
 */
import type { Hono } from "hono";
import { safeEqual } from "./auth";
import { listAcceptedAlerts, markAcceptedNotified } from "./founder-alerts";
import { getIdentityStore } from "./identity";
import type { Store } from "./store";
import { listLinkedInStopAlerts, markLinkedInStopNotified } from "./linkedin-alerts";
import { buildProductSnapshot, listDueDigests } from "./product-ops";
import { nextSurvey, publicPrompt } from "./surveys";

function allowOps(c: any): boolean {
  const identity = getIdentityStore();
  const scope = c.get("scope");
  if (scope?.kind === "member" && identity.isSuperAdminMember(scope.member_id)) return true;
  if (scope?.kind === "key") {
    const control = process.env.MYCEL_CONTROL_TOKEN ?? "";
    const presented = c.req.header("x-mycel-control") ?? "";
    if (control && presented && safeEqual(presented, control)) return true;
  }
  return false;
}

/**
 * `store` is threaded in so the digest can count finished work. See `buildAgencyDigest` — every
 * other number in that mail is a state count, and the work ledger is the one that says what the
 * product did.
 */
export function mountProductOpsRoutes(app: Hono, store?: Store) {
  const identity = () => getIdentityStore();

  /**
   * Next outstanding questionnaire for this person. Member-only — a product key has no person.
   *
   * Always 200. `prompt: null` is the idle state; a 204 would make the product treat "nothing to
   * ask" as an error, and a 404 would look like the route was missing.
   */
  app.get("/v1/surveys/next", async (c) => {
    const scope = c.get("scope");
    if (scope?.kind !== "member" || !scope.member_id) {
      return c.json({ error: "member session required" }, 403);
    }
    const member = identity().getMember(scope.member_id);
    if (!member) return c.json({ error: "not found" }, 404);
    const org = identity().getOrg(scope.org_id);
    const raw = (c.req.query("signals") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const signals = {
      went_live: raw.includes("went_live"),
      first_client: raw.includes("first_client"),
      first_chase: raw.includes("first_chase"),
      clock_used: raw.includes("clock_used") || raw.includes("went_live"),
      cancelled: raw.includes("cancelled") || org?.plan_status === "cancelled",
    };
    const prompt = nextSurvey(member.created_at, identity().surveyLog(member.id), signals);
    return c.json({ prompt: prompt ? publicPrompt(prompt) : null });
  });

  app.post("/v1/surveys", async (c) => {
    const scope = c.get("scope");
    if (scope?.kind !== "member" || !scope.member_id) {
      return c.json({ error: "member session required" }, 403);
    }
    const body = (await c.req.json().catch(() => null)) as {
      prompt_id?: string;
      score?: number;
      skip?: boolean;
      comment?: string;
    } | null;
    if (!body || typeof body.prompt_id !== "string") {
      return c.json({ error: "prompt_id is required" }, 400);
    }
    const out = identity().recordSurvey(scope.member_id, {
      prompt_id: body.prompt_id,
      score: body.score,
      skip: body.skip,
      comment: body.comment,
    });
    if (!out) return c.json({ error: "not found" }, 404);
    if ("error" in out && !("id" in out)) return c.json({ error: out.error }, 400);
    return c.json({ ok: true });
  });

  app.get("/v1/ops/product", async (c) => {
    if (!allowOps(c)) return c.json({ error: "not found" }, 404);
    return c.json(await buildProductSnapshot());
  });

  app.get("/v1/ops/digests", async (c) => {
    if (!allowOps(c)) return c.json({ error: "not found" }, 404);
    const due = await listDueDigests(new Date(), store ? (f) => store.listTasks(f) : undefined);
    return c.json({ due });
  });

  /**
   * The invite-only front door's ledger. Same gate as the rest of /v1/ops: a super-admin session
   * or the control token, and a refusal answers 404 so the surface's existence is not confirmable.
   */
  app.get("/v1/ops/signup-access", async (c) => {
    if (!allowOps(c)) return c.json({ error: "not found" }, 404);
    return c.json({
      entries: identity().listSignupAccess(),
      requests: identity().listSignupRequests(),
    });
  });

  /**
   * Record an ask. Same gate as the rest of /v1/ops — the public request-access route on cloud
   * holds the product key and control token, so a stranger cannot write the ledger themselves.
   */
  app.post("/v1/ops/signup-requests", async (c) => {
    if (!allowOps(c)) return c.json({ error: "not found" }, 404);
    const body = (await c.req.json().catch(() => null)) as {
      email?: string;
      source?: string;
      about?: string;
    } | null;
    const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
    const out = identity().recordSignupRequest({
      email,
      source: typeof body?.source === "string" ? body.source : undefined,
      about: typeof body?.about === "string" ? body.about : undefined,
    });
    if ("error" in out && !("email" in out)) return c.json({ error: out.error }, 400);
    return c.json({ request: out }, 201);
  });

  /**
   * Grant access. `email` makes an allowlist row; no email mints a single-use link, and the raw
   * token is in this response ONCE — only its hash is stored, so the product must show the URL now.
   */
  app.post("/v1/ops/signup-access", async (c) => {
    if (!allowOps(c)) return c.json({ error: "not found" }, 404);
    const body = (await c.req.json().catch(() => null)) as { email?: string; note?: string } | null;
    const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : undefined;
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return c.json({ error: "a valid email is required" }, 400);
    }
    const scope = c.get("scope");
    const out = identity().createSignupAccess({
      email,
      note: typeof body?.note === "string" ? body.note : undefined,
      invitedBy: scope?.kind === "member" && scope.member_id ? scope.member_id : "control",
    });
    return c.json(out, 201);
  });

  app.delete("/v1/ops/signup-access/:id", async (c) => {
    if (!allowOps(c)) return c.json({ error: "not found" }, 404);
    if (!identity().deleteSignupAccess(c.req.param("id"))) return c.json({ error: "not found" }, 404);
    return c.json({ ok: true });
  });

  /**
   * What a signup link admits, before anyone commits. Public — the token is the credential, and the
   * middleware bypass in server.ts waves this prefix through. Always 200: {valid: false} is one
   * answer for expired, spent, revoked and never-existed, for the same reason /v1/invites/:token is.
   */
  app.get("/v1/signup-invites/:token", async (c) => {
    return c.json(identity().peekSignupToken(c.req.param("token") ?? ""));
  });

  /**
   * LinkedIn accounts that have stopped and whose founder has not been told.
   *
   * The product's cron drains this and sends the mail — the kernel does not send mail. Same gate as
   * the rest of /v1/ops because the list is cross-tenant. See linkedin-alerts.ts for why this is a
   * pull off a durable stamp rather than a callback off the in-process breaker.
   */
  /**
   * Clients who accepted work whose founder has not been told.
   *
   * Same shape and same gate as the LinkedIn stops below, and for the same reasons — the kernel does
   * not send mail, and the only "have we told them" flag that survives a restart is the one on the
   * row. See founder-alerts.ts.
   */
  app.get("/v1/ops/accepted-alerts", async (c) => {
    if (!allowOps(c)) return c.json({ error: "not found" }, 404);
    return c.json({ due: await listAcceptedAlerts() });
  });

  /**
   * Mark the acceptances the product actually delivered mail for.
   *
   * Only ever called AFTER a successful send. A marker written on a failure is a promise quietly
   * broken: the founder is never told and the row that was the evidence is gone.
   */
  app.post("/v1/ops/accepted-alerts/notified", async (c) => {
    if (!allowOps(c)) return c.json({ error: "not found" }, 404);
    const body = (await c.req.json().catch(() => null)) as { accepted?: unknown } | null;
    const items = Array.isArray(body?.accepted) ? body.accepted : [];
    const marked: string[] = [];
    for (const raw of items.slice(0, 500)) {
      const it = raw as { project_id?: unknown; deliverable_id?: unknown };
      if (typeof it?.project_id !== "string" || typeof it?.deliverable_id !== "string") continue;
      if (await markAcceptedNotified(it.project_id, it.deliverable_id)) marked.push(it.deliverable_id);
    }
    return c.json({ marked });
  });

  app.get("/v1/ops/linkedin-stops", async (c) => {
    if (!allowOps(c)) return c.json({ error: "not found" }, 404);
    return c.json({ due: await listLinkedInStopAlerts() });
  });

  /**
   * Mark the stops the product actually delivered mail for.
   *
   * Only ever called AFTER a successful send: a send that failed must stay due, because the whole
   * promise of this path is that a founder is told, and a marker written on a failure is a promise
   * quietly broken.
   */
  app.post("/v1/ops/linkedin-stops/notified", async (c) => {
    if (!allowOps(c)) return c.json({ error: "not found" }, 404);
    const body = (await c.req.json().catch(() => null)) as { connection_ids?: unknown } | null;
    const ids = Array.isArray(body?.connection_ids)
      ? body.connection_ids.filter((x): x is string => typeof x === "string")
      : [];
    const marked: string[] = [];
    for (const id of ids.slice(0, 500)) {
      if (await markLinkedInStopNotified(id)) marked.push(id);
    }
    return c.json({ marked });
  });

  app.post("/v1/ops/digests/sent", async (c) => {
    if (!allowOps(c)) return c.json({ error: "not found" }, 404);
    const body = (await c.req.json().catch(() => null)) as { org_ids?: unknown } | null;
    const ids = Array.isArray(body?.org_ids) ? body.org_ids.filter((x): x is string => typeof x === "string") : [];
    const marked: string[] = [];
    for (const id of ids.slice(0, 500)) {
      if (identity().markDigestSent(id)) marked.push(id);
    }
    return c.json({ marked });
  });
}
