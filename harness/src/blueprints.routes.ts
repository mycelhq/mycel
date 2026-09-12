// The blueprint routes — the packaged operation behind a shaped business.
//
// ═══ WHAT A BLUEPRINT IS, SO THE ROUTES READ ═══
//
// A blueprint is the schedules, connections and task types a trade needs to actually run, applied
// to a project once its shape is confirmed. `readiness` answers what is still missing before it can
// go live; `apply` provisions it with every schedule DISABLED, because a founder confirming a shape
// has not yet agreed to anything being sent on their behalf.
//
// ═══ WHY THEY ARE ONE MODULE ═══
//
// Six standard dependencies and no shared server-local state — the test that decided the order of
// this refactor after /v1/composio failed it with twenty-two. See skills.routes.ts.
import type { Hono } from "hono";
import type { Context } from "hono";
import type { DomainStore } from "./domain";
import type { Store } from "./store";
import { audit } from "./audit";
import { getIdentityStore } from "./identity";
import { CAPABILITIES, capabilityProviders, isCapability } from "./capabilities";
import { importCrmClients, syncCalendar } from "./capability-import";
import { buildChecklist, isProvisioned, listBlueprints, loadBlueprint, provision } from "./blueprints";
import { reconcileProject } from "./payments";
import { fireSchedule } from "./scheduler";
import { setSecret } from "./secrets";
import { loadWedge } from "./wedge";

export interface BlueprintRoutesDeps {
  domain: DomainStore;
  store: Store;
  identity: ReturnType<typeof getIdentityStore>;
  /** The projects this caller may READ — a closure over the request scope, built in createServer. */
  accessible: (c: Context) => Set<string>;
  /** The project a WRITE lands in, or undefined when the caller's scope names none. */
  writeProjectId: (c: Context) => string | undefined;
  /**
   * Make sure this project has the schedules that keep the harness improving itself.
   *
   * The one dependency here that is NOT an import: it is a closure in createServer over the same
   * spawn path every other scheduled run uses. Injected rather than reimplemented for the reason
   * requests.routes.ts gives about spawnFromThread — a second copy drifts on actor scoping and
   * constraint ceilings, and the drift is invisible until a run does something with the wrong
   * authority.
   */
}

export function mountBlueprintRoutes(app: Hono, deps: BlueprintRoutesDeps): void {
  const { domain, store, identity, accessible, writeProjectId } = deps;

app.get("/v1/blueprints", async (c) =>
  c.json(
    listBlueprints().map((b) => ({
      blueprint: b.blueprint,
      title: b.title,
      summary: b.summary,
      wedge: b.wedge,
      sells_as: b.sells_as,
      /**
       * A requirement carries EITHER a capability with its alternatives, or a single kind.
       *
       * `options` replaces what used to be a lone `toolkit`, and the replacement is the visible
       * half of the change: this list is what Cloud turns into app cards, so a single toolkit here
       * is literally what put one Xero card in front of a QuickBooks bookkeeper. Cloud never sees
       * `config` or `secret_hint`, unchanged.
       */
      requires_connections: (b.requires_connections ?? []).map((r) => ({
        name: r.name,
        kind: r.kind,
        why: r.why,
        ...(r.capability && isCapability(r.capability)
          ? {
              capability: r.capability,
              question: CAPABILITIES[r.capability].question,
              options: capabilityProviders(r.capability).map((p) => ({ toolkit: p.toolkit, label: p.label, via: p.via })),
            }
          : {}),
        ...(r.kind === "composio" && r.config?.toolkit ? { toolkit: String(r.config.toolkit) } : {}),
      })),
      schedules: (b.schedules ?? []).map((s) => ({ name: s.name, task_type: s.task_type, cadence: s.cadence })),
      installed: !!loadWedge(b.wedge),
    })),
  ),
);

app.get("/v1/blueprints/:slug", async (c) => {
  const b = loadBlueprint(c.req.param("slug"));
  if (!b) return c.json({ error: "unknown blueprint" }, 404);
  return c.json(b);
});

app.post("/v1/blueprints/:slug/provision", async (c) => {
  const projectId = writeProjectId(c);
  if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
  const b = loadBlueprint(c.req.param("slug"));
  if (!b) return c.json({ error: "unknown blueprint" }, 404);
  if (!loadWedge(b.wedge)) return c.json({ error: `blueprint needs wedge "${b.wedge}", which isn't installed` }, 400);
  if (!identity.projectAllowsWedge(projectId, b.wedge)) {
    return c.json({ error: `wedge "${b.wedge}" is not enabled for this project` }, 403);
  }
  const result = await provision(domain, b, projectId);
  await audit({
    project_id: projectId,
    actor: (c.get("scope").member_id ?? "system") as string,
    action: "project.created",
    entity: "blueprint",
    entity_id: b.blueprint,
    detail: { created: result.created, reused: result.reused, ready: result.ready },
  });
  return c.json(result, 201);
});

/** Readiness — what's still missing before this business can run. */
app.get("/v1/blueprints/:slug/readiness", async (c) => {
  const scope = c.get("scope");
  const projectId = c.req.query("project_id") ?? scope.project_id ?? [...accessible(c)][0];
  if (!projectId || !accessible(c).has(projectId)) return c.json({ error: "not found" }, 404);
  const b = loadBlueprint(c.req.param("slug"));
  if (!b) return c.json({ error: "unknown blueprint" }, 404);
  const [checklist, provisioned] = await Promise.all([
    buildChecklist(domain, b, projectId),
    isProvisioned(domain, b, projectId),
  ]);
  /**
   * `provisioned` is REPORTED, not inferred by the caller.
   *
   * Cloud used to derive it from "does any checklist item carry a connection_id", which was only
   * ever true because provisioning created empty rows. Now that it doesn't, that inference reads
   * "never set up" for a fully set-up business and shows step one of a completed flow.
   */
  return c.json({
    blueprint: b.blueprint,
    project_id: projectId,
    provisioned,
    checklist,
    ready: checklist.every((i) => i.done),
  });
});

/**
 * Store a credential for a blueprint requirement that has no connection row yet.
 *
 * The counterpart of provisioning no longer creating rows. `POST /v1/connections/:id/secret` needs
 * an id, and until the founder acts there is nothing to have an id — so this route creates the row
 * from the blueprint's own spec (its kind and its config, which is where `api_url`, `from` and the
 * rest live) and then stores the secret against it.
 *
 * Idempotent on (project, name): pasting a replacement credential must not leave two rows, one of
 * which the wedge might pick.
 */
app.post("/v1/blueprints/:slug/connections/:name/secret", async (c) => {
  // REQUIRED, never defaulted. A connection created against a guessed project is a credential
  // handed to the wrong tenant's agent.
  const projectId = writeProjectId(c);
  if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
  const b = loadBlueprint(c.req.param("slug"));
  if (!b) return c.json({ error: "unknown blueprint" }, 404);
  const name = c.req.param("name");
  const spec = (b.requires_connections ?? []).find((r) => r.name === name);
  // Only names the blueprint declares. Otherwise this is a general "create any connection you like
  // and put a secret in it" route wearing a blueprint's name.
  if (!spec) return c.json({ error: `blueprint "${b.blueprint}" declares no connection "${name}"` }, 404);
  if (spec.kind === "composio") {
    // There is no credential to store for a brokered app; the token lives at Composio. Accepting
    // one here would take the founder's key, tell them it worked, and connect nothing.
    return c.json({ error: `"${name}" is authorised through the app broker, not pasted`, connect: `POST /v1/composio/toolkits/${String(spec.config?.toolkit ?? name)}/connect` }, 400);
  }
  if (spec.capability || !spec.kind) {
    /**
     * A capability requirement has no single thing to paste a key into — that is the whole reason
     * it is a capability. Which app it resolves to is the founder's choice, made in the connect
     * step, and each choice has its own connect call (`checklist[].options[].action`).
     *
     * Refused rather than guessed at, because guessing here means creating a connection row of an
     * arbitrary kind, storing the founder's credential in it, and reporting success on a
     * requirement that is still unsatisfied.
     */
    return c.json(
      {
        error: `"${name}" is a capability ("${spec.capability}"), not one app — pick a provider from the readiness checklist and connect that`,
        readiness: `GET /v1/blueprints/${b.blueprint}/readiness`,
      },
      400,
    );
  }
  const body = (await c.req.json().catch(() => ({}))) as { value?: string };
  if (typeof body.value !== "string" || !body.value) return c.json({ error: "value is required" }, 400);

  const existing = (await domain.listConnections()).find(
    (x) => x.project_id === projectId && x.name === name,
  );
  const conn =
    existing ??
    (await domain.createConnection({
      project_id: projectId,
      kind: spec.kind,
      name: spec.name,
      owner: { kind: "founder", id: "founder" },
      config: spec.config ?? {},
    }));
  await setSecret(conn.id, body.value);
  await audit({
    project_id: projectId,
    actor: (c.get("scope").member_id ?? "system") as string,
    action: "secret.written",
    entity: "connection",
    entity_id: conn.id,
    detail: { connection: conn.name, kind: conn.kind, from_blueprint: b.blueprint }, // never the value
  });
  return c.json({ ok: true, connection_id: conn.id, created: !existing });
});

app.post("/v1/blueprints/:slug/activate", async (c) => {
  const projectId = writeProjectId(c);
  if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
  const b = loadBlueprint(c.req.param("slug"));
  if (!b) return c.json({ error: "unknown blueprint" }, 404);
  const checklist = await buildChecklist(domain, b, projectId);
  const missing = checklist.filter((i) => !i.done);
  if (missing.length) {
    // Refuse rather than "activate" a business that would fail on its first tick.
    return c.json({ error: "not ready", missing }, 409);
  }
  const names = new Set((b.schedules ?? []).map((s) => s.name));
  const mine = (await domain.listSchedules()).filter((s) => s.project_id === projectId && names.has(s.name));
  for (const s of mine) await domain.updateSchedule(s.id, { enabled: true });
  /**
   * Run one now.
   *
   * `next_run_at` was computed at provision time as the next strictly-future occurrence, so a
   * founder who finished setting up at 10:00 on a wedge that runs daily at 06:00 saw "your
   * business is running" and then nothing at all for twenty hours. They had just been asked for
   * credentials and taught the thing their trade; the product's answer was a promise about
   * tomorrow.
   *
   * One immediate run, so the next screen has something real on it. The rest of the schedule is
   * untouched — this doesn't shift the cadence, it just doesn't make them wait to see it work.
   */
  let firstTask: string | undefined;
  const lead = mine[0];
  if (lead) {
    firstTask = (await fireSchedule(store, domain, lead))?.id;
  }

  /**
   * First sync on go-live — connect granted a capability; activate is when we pull.
   *
   * Connecting Stripe does not dump the ledger into Mycel. Waiting for the overnight reconcile
   * schedule leaves Home empty the morning a founder went live. Same function as the Invoices
   * "Check now" button; failure is returned as data (`ok: false` + detail), never thrown, so a
   * broken payment connection cannot undo activation.
   */
  let sync: { ok: boolean; observed: number; applied: number; settled: number; detail: string } | undefined;
  try {
    const summary = await reconcileProject({ project_id: projectId });
    sync = {
      ok: summary.ok,
      observed: summary.observed,
      applied: summary.applied,
      settled: summary.settled.length,
      detail: summary.detail,
    };
  } catch (e) {
    console.error(`[mycel] post-activate payment sync for ${projectId} failed:`, e);
    sync = {
      ok: false,
      observed: 0,
      applied: 0,
      settled: 0,
      detail: e instanceof Error ? e.message : "payment sync could not run",
    };
  }

  let crm: { ok: boolean; observed: number; created: number; detail: string } | undefined;
  try {
    const summary = await importCrmClients({ project_id: projectId });
    crm = { ok: summary.ok, observed: summary.observed, created: summary.created, detail: summary.detail };
  } catch (e) {
    console.error(`[mycel] post-activate CRM import for ${projectId} failed:`, e);
    crm = { ok: false, observed: 0, created: 0, detail: e instanceof Error ? e.message : "CRM import could not run" };
  }

  let calendar: { ok: boolean; observed: number; detail: string } | undefined;
  try {
    const summary = await syncCalendar({ project_id: projectId });
    calendar = { ok: summary.ok, observed: summary.observed, detail: summary.detail };
  } catch (e) {
    console.error(`[mycel] post-activate calendar sync for ${projectId} failed:`, e);
    calendar = { ok: false, observed: 0, detail: e instanceof Error ? e.message : "calendar sync could not run" };
  }

  return c.json({
    ok: true,
    activated: mine.map((s) => s.name),
    first_task_id: firstTask,
    sync,
    crm,
    calendar,
  });
});
}
