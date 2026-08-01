// The campaign surface: propose, approve, tick. Mounted with one line in server.ts.
//
// There is a route here for approving a campaign, rather than reusing `POST /v1/approvals/:id/approve`,
// for a specific reason: that endpoint resolves an IN-PROCESS WAITER — it exists to unblock a run
// suspended inside `awaitApproval`, and it answers 409 when there is nobody blocked. A campaign
// approval has nobody blocked ON PURPOSE (that is the entire point of approving once instead of two
// hundred times), so it needs a path that decides the row and nothing else.
import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
import type { Connection, Task } from "../contract";
import { audit } from "../audit";
import type { DomainStore } from "../domain";
import type { Store } from "../store";
import {
  CampaignError,
  enrollProspect,
  loadCampaign,
  proposeCampaign,
  type ProspectDraft,
  type SequenceStep,
} from "./campaign";
import { advanceSequences, ensureSequenceSchedule } from "./sequence";

export interface GtmRouteDeps {
  store: Store;
  domain: DomainStore;
  getConnection(id: string): Promise<Connection | undefined>;
  accessible(c: any): Set<string>;
  writeProjectId(c: any): string | undefined;
  inScope(set: Set<string>, pid?: string): boolean;
}

export function mountGtm(app: Hono, deps: GtmRouteDeps): void {
  const { store, domain } = deps;

  /**
   * Propose a campaign. Writes the record, the full-copy artifact and ONE approval — and returns
   * immediately. Nothing is sent until a human approves, and nothing blocks while they think.
   */
  app.post("/v1/gtm/campaigns", async (c) => {
    const projectId = deps.writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    const b = (await c.req.json().catch(() => ({}))) as {
      connection_id?: string;
      name?: string;
      prospects?: ProspectDraft[];
      steps?: SequenceStep[];
      valid_days?: number;
    };
    if (!b.connection_id || !b.name || !b.prospects?.length) {
      return c.json({ error: "connection_id, name and at least one prospect are required" }, 400);
    }
    const conn = await deps.getConnection(b.connection_id);
    if (!conn || !deps.inScope(deps.accessible(c), conn.project_id)) return c.json({ error: "unknown connection" }, 404);
    if (conn.project_id !== projectId) return c.json({ error: "that account belongs to another project" }, 403);

    // The proposal is itself a task: it is what the approval and the artifact hang off, and it is
    // where the timeline of this campaign begins.
    const iso = new Date().toISOString();
    const task: Task = {
      id: randomUUID(),
      project_id: projectId,
      wedge: "gtm-operator",
      task_type: "propose_campaign",
      actor: { kind: "user", id: "member" },
      input: { name: b.name, prospects: b.prospects.length },
      constraints: { max_runtime_s: 60, max_cost_usd: 0, approval_required: true },
      tools: [],
      status: "awaiting_approval",
      cost_usd: 0,
      created_at: iso,
      updated_at: iso,
    };
    await store.createTask(task);

    try {
      const { campaign, approval_id } = await proposeCampaign(store, domain, {
        task_id: task.id,
        project_id: projectId,
        connection_id: b.connection_id,
        name: b.name,
        prospects: b.prospects,
        steps: b.steps,
        valid_days: b.valid_days,
      });
      const cases = [];
      for (const p of b.prospects) cases.push((await enrollProspect(domain, campaign, p)).id);
      // The ticker is created here rather than at boot: a project that has never run a campaign
      // does not need a schedule waking up every five minutes on its behalf.
      await ensureSequenceSchedule(domain, projectId);
      return c.json({ campaign_id: campaign.id, approval_id, artifact_id: campaign.artifact_id, task_id: task.id, cases: cases.length }, 201);
    } catch (e) {
      await store.setStatus(task.id, "failed", String((e as Error)?.message ?? e));
      if (e instanceof CampaignError) return c.json({ error: e.message }, 400);
      throw e;
    }
  });

  app.get("/v1/gtm/campaigns/:id", async (c) => {
    const projectId = deps.writeProjectId(c);
    const campaign = await loadCampaign(domain, projectId, c.req.param("id") ?? "");
    if (!campaign || !deps.inScope(deps.accessible(c), campaign.project_id)) return c.json({ error: "not found" }, 404);
    const approval = await store.getApproval(campaign.approval_id);
    return c.json({ ...campaign, approval_status: approval?.status ?? "missing" });
  });

  const decide = (decision: "approved" | "rejected") => async (c: any) => {
    const projectId = deps.writeProjectId(c);
    const campaign = await loadCampaign(domain, projectId, c.req.param("id") ?? "");
    if (!campaign || !deps.inScope(deps.accessible(c), campaign.project_id)) return c.json({ error: "not found" }, 404);
    const approval = await store.getApproval(campaign.approval_id);
    if (!approval) return c.json({ error: "not found" }, 404);
    // Only the first transition off "pending" wins — the same no-TOCTOU rule the task gate uses.
    if (approval.status !== "pending") return c.json({ error: `already ${approval.status}` }, 409);
    await store.setApproval(campaign.approval_id, decision);
    await store.setStatus(campaign.task_id, decision === "approved" ? "succeeded" : "rejected");
    await audit({
      project_id: campaign.project_id,
      actor: "member",
      action: decision === "approved" ? "approval.granted" : "approval.rejected",
      entity: "task",
      entity_id: campaign.task_id,
      detail: { campaign_id: campaign.id, approval_id: campaign.approval_id, prospects_scope: campaign.connection_id },
    });
    return c.json({ ok: true, campaign_id: campaign.id, decision });
  };
  app.post("/v1/gtm/campaigns/:id/approve", decide("approved"));
  app.post("/v1/gtm/campaigns/:id/reject", decide("rejected"));

  /** Run one tick now. The schedule does this every five minutes; this is for a founder in a hurry. */
  app.post("/v1/gtm/tick", async (c) => {
    const projectId = deps.writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    return c.json(await advanceSequences(store, domain, { project_id: projectId }));
  });
}
