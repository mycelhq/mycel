/**
 * Super-admin product analytics, questionnaires, and agency digests.
 *
 * Three surfaces, one file, because they share a gate: a member session on the allowlist, or the
 * control token the product cron holds. A leaked product API key must not list every tenant.
 */
import type { Hono } from "hono";
import { safeEqual } from "./auth";
import { getIdentityStore } from "./identity";
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

export function mountProductOpsRoutes(app: Hono) {
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
    const due = await listDueDigests();
    return c.json({ due });
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
