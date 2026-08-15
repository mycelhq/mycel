// The two planes of a client request, mounted with one line. Referenced by name from the
// `ClientRequest` doc comment in contract.ts, which is the design — read that first.
//
// FOUNDER PLANE (`/v1/requests*`): the business asks. Scoped by `writeProjectId`/`accessible`, like
// every other founder route.
//
// CLIENT PLANE (`/v1/portal/requests*`): the client answers. Scoped by the portal SESSION and
// nothing else. There is no client id, project id or thread id in any of these paths that widens
// what the caller can see: the only identifiers a client supplies are request ids, and every one of
// them is looked up with `(session.project_id, id)` so an id belonging to another tenant or another
// customer reads as "not found" rather than as a row to be checked afterwards.
//
// ── The loop ──
//
// Answering is not a status change. `POST /v1/portal/requests/:id/respond` does three things in
// order, and the order is the point:
//
//   1. resolve the row ATOMICALLY (`open → resolved` inside the WHERE clause), so two tabs cannot
//      both proceed;
//   2. post the answer into the client's thread as an inbound message, because the answer is
//      something the client said and the transcript is what an operator reads afterwards;
//   3. spawn the run that was waiting, from that thread.
//
// Step 1 gates 2 and 3. Before it did, a client double-clicking "send" sent the agent off twice on
// the same answer — two replies to the customer, two charges.
import type { Hono } from "hono";
import type { Thread } from "./contract";
import type { DomainStore } from "./domain";
import type { Store } from "./store";
import type { ClientScope } from "./portal";
import { getRequestStore, normalizeAsk, normalizeToolkit, PARTY_ROLES, REQUEST_KINDS } from "./requests";
import type { RequestPartyRole } from "./contract";
import { setNudgeDeps, startNudge, type NudgeDeps } from "./nudges";
import { setCheckInDeps } from "./checkin";
import { ensureUpkeepQuietly } from "./upkeep";
import { getDomainStore } from "./domain";
import { noteRequestAnswered, systemMoveAuthority } from "./moves";
import { taskClientId } from "./runtime";
import { mintPartyLink } from "./party";

export interface RequestRouteDeps {
  domain: DomainStore;
  /** Artifact ownership checks for document replies. */
  store: Store;
  /** The projects the caller may READ. Fails closed; see `identity.accessibleProjectIds`. */
  accessible(c: any): Set<string>;
  /** The project a write lands in, or undefined when the caller named none. */
  writeProjectId(c: any): string | undefined;
  /** Does this client id name a client in this project? Refuses cross-tenant attachment. */
  clientInProject(clientId: string, projectId: string): Promise<boolean>;
  /**
   * Post-and-spawn, shared verbatim with `POST /v1/portal/threads/:id/messages`.
   *
   * Deliberately injected rather than reimplemented: an answer that spawned a run through a second,
   * subtly different path would drift from the reply path on constraints, actor scoping and case
   * attribution — and the actor scoping is what keeps a run on this client's connections.
   */
  spawnFromThread(
    thread: { id: string; channel_id: string; subject?: string; case_id?: string },
    sc: { client_id: string; project_id: string },
    body: string,
  ): Promise<string | undefined>;
  /** What the nudge carrier needs. Registered onto nudges.ts at mount time — see `setNudgeDeps`. */
  wedgeEnabled: NudgeDeps["wedgeEnabled"];
  spawnTask: NudgeDeps["spawnTask"];
}

/**
 * What crosses to the client.
 *
 * `task_id` is FOUNDER-PLANE ONLY — the contract says so, and it is the one field on this row that
 * describes the operator's machinery rather than the customer's obligation. A client has no use for
 * a run id and every use for not seeing one.
 */
function toPortal(r: import("./contract").ClientRequest) {
  return {
    id: r.id,
    kind: r.kind,
    ask: r.ask,
    detail: r.detail,
    status: r.status,
    case_id: r.case_id,
    thread_id: r.thread_id,
    due_at: r.due_at,
    response: r.response,
    response_artifact_ids: r.response_artifact_ids,
    connection_toolkit: r.connection_toolkit,
    party_role: r.party_role,
    party_label: r.party_label,
    resolved_at: r.resolved_at,
    created_at: r.created_at,
  };
}

/** Client portal only shows asks addressed to the client — not candidate/contractor packets. */
function isClientFacing(r: import("./contract").ClientRequest): boolean {
  return !r.party_role || r.party_role === "client";
}

export function mountRequestRoutes(app: Hono, deps: RequestRouteDeps): void {
  const { domain, store, accessible, writeProjectId, clientInProject, spawnFromThread } = deps;
  const requests = () => getRequestStore();

  /**
   * Hand the scheduled nudge sweep the SAME two capabilities this file was injected with.
   *
   * The sweep lives in `nudges.ts` and is driven by `fireSchedule`, which has a store and a domain
   * store and nothing else — no constraint ceilings, no wedge manifest resolution. Registering here
   * rather than importing there keeps `server.ts` the single place that knows how to spawn a clamped
   * run, and guarantees that a reminder the sweep starts and one a founder starts differ in nothing
   * but their `source`.
   *
   * Until this line runs, the sweep does nothing at all. See `setNudgeDeps`.
   */
  setNudgeDeps({ wedgeEnabled: deps.wedgeEnabled, spawnTask: deps.spawnTask });
  /**
   * And the check-in carrier, from the SAME two functions, on the same line of the boot.
   *
   * It is registered here — next to the nudge, in a file about client requests — rather than in a
   * home of its own, because the two need exactly the same thing (a clamped spawn and the wedge
   * enablement check) and the failure this guards against is one of them being wired and the other
   * not. A kernel where `POST /v1/requests/:id/nudge` works and taking a check-in off `/next`
   * silently answers "not wired up in this deployment" is a kernel that half-boots, and nothing in
   * the startup path would say so. One line, one place, both or neither.
   */
  setCheckInDeps({ wedgeEnabled: deps.wedgeEnabled, spawnTask: deps.spawnTask });

  // ────────────────────────────── founder plane ──────────────────────────────

  /**
   * Ask a client for something.
   *
   * Every id in the body is verified to be in THIS project before it is stored. An unchecked
   * `thread_id` here would be the sharpest edge in the file: the answer is posted into that thread,
   * so a bad one posts one customer's words into another customer's conversation — and the portal
   * would then show it to them, because the portal reads threads by ownership and this row would
   * have made the claim look legitimate.
   */
  app.post("/v1/requests", async (c) => {
    const projectId = writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

    const clientId = typeof b.client_id === "string" ? b.client_id : "";
    if (!(await clientInProject(clientId, projectId))) return c.json({ error: "unknown client" }, 400);

    const ask = normalizeAsk(b.ask);
    if (!ask) return c.json({ error: "ask is required" }, 400);
    const kind = REQUEST_KINDS.includes(b.kind as never) ? (b.kind as (typeof REQUEST_KINDS)[number]) : "answer";

    let connectionToolkit: string | undefined;
    if (kind === "connection") {
      try {
        connectionToolkit = normalizeToolkit(b.connection_toolkit ?? b.toolkit);
      } catch (e) {
        return c.json({ error: (e as Error).message }, 400);
      }
      if (!connectionToolkit) return c.json({ error: "a connection ask needs a toolkit (e.g. xero)" }, 400);
    }

    const partyRole: RequestPartyRole = PARTY_ROLES.includes(b.party_role as never)
      ? (b.party_role as RequestPartyRole)
      : "client";
    const partyLabel =
      typeof b.party_label === "string" ? b.party_label.trim().slice(0, 200) || undefined : undefined;
    const partyEmail =
      typeof b.party_email === "string" ? b.party_email.trim().slice(0, 320) || undefined : undefined;
    if (partyRole !== "client" && !partyLabel && !partyEmail) {
      return c.json({ error: "a third-party ask needs a name or email for who must answer" }, 400);
    }

    let caseId: string | undefined;
    if (typeof b.case_id === "string" && b.case_id) {
      const kase = await domain.getCase(b.case_id);
      if (!kase || kase.project_id !== projectId || (kase.client_id && kase.client_id !== clientId)) {
        return c.json({ error: "unknown case" }, 400);
      }
      caseId = kase.id;
    }

    let threadId: string | undefined;
    if (typeof b.thread_id === "string" && b.thread_id) {
      const th = await domain.getThread(b.thread_id);
      if (!th || th.project_id !== projectId || th.client_id !== clientId) {
        return c.json({ error: "unknown thread" }, 400);
      }
      threadId = th.id;
    }

    let row;
    try {
      row = await requests().createRequest({
        project_id: projectId,
        client_id: clientId,
        case_id: caseId,
        thread_id: threadId,
        task_id: typeof b.task_id === "string" ? b.task_id : undefined,
        kind,
        ask,
        detail: typeof b.detail === "string" ? b.detail.slice(0, 5_000) : undefined,
        due_at: typeof b.due_at === "string" ? b.due_at : undefined,
        connection_toolkit: connectionToolkit,
        party_role: partyRole,
        party_label: partyLabel,
        party_email: partyEmail,
      });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }

    /**
     * ASKING A CLIENT FOR SOMETHING IS WHAT TURNS THE NUDGE CLOCK ON. See upkeep.ts.
     *
     * `ensureNudgeSchedule` shipped complete, tested, documented — and with ZERO callers repo-wide.
     * `ClientRequest` was, in this file's sibling's own words, "the best noun in the kernel and the
     * deadest one"; nudges.ts was written to fix exactly that and still never fired, because nothing
     * ever created the Schedule the scheduler claims. Every test passed. No client was ever reminded
     * of anything.
     *
     * The ask is the fact. Awaited and non-fatal: if no installed wedge declares
     * `nudge_client_request` no sweep is created and the reason is logged, because a clock over work
     * that can only ever be refused is the same lie as no clock at all.
     */
    await ensureUpkeepQuietly(domain, projectId);

    // Third-party asks get a scoped link at create time so the founder can copy it immediately.
    // Client asks stay on the client portal — no party link.
    let party_link: { token: string; expires_at: string } | undefined;
    if (partyRole !== "client") {
      party_link = mintPartyLink({
        project_id: projectId,
        client_id: clientId,
        request_id: row.id,
        party_role: partyRole,
        party_label: partyLabel,
      });
    }
    return c.json({ ...row, party_link }, 201);
  });

  /** Re-mint a party link (previous token is left to expire unused). */
  app.post("/v1/requests/:id/party-link", async (c) => {
    const projectId = writeProjectId(c);
    if (!projectId || !accessible(c).has(projectId)) return c.json({ error: "not found" }, 404);
    const row = await requests().getRequest(projectId, c.req.param("id"));
    if (!row) return c.json({ error: "not found" }, 404);
    if (!row.party_role || row.party_role === "client") {
      return c.json({ error: "this ask is for the client — they use the client portal" }, 409);
    }
    if (row.status !== "open") return c.json({ error: "that request is already closed" }, 409);
    const party_link = mintPartyLink({
      project_id: row.project_id,
      client_id: row.client_id,
      request_id: row.id,
      party_role: row.party_role,
      party_label: row.party_label,
    });
    return c.json({ ok: true, party_link, party_email: row.party_email, party_label: row.party_label });
  });

  /**
   * The founder's view of what every client owes them.
   *
   * One project at a time, always — `X-Mycel-Project` when the caller has more than one. There is
   * deliberately no fleet-wide read: see `RequestFilter`.
   */
  app.get("/v1/requests", async (c) => {
    const set = accessible(c);
    const named = c.req.header("x-mycel-project");
    const projectId = named && set.has(named) ? named : set.size === 1 ? [...set][0] : undefined;
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    const status = c.req.query("status");
    return c.json(
      await requests().listRequests({
        project_id: projectId,
        client_id: c.req.query("client_id") || undefined,
        case_id: c.req.query("case_id") || undefined,
        thread_id: c.req.query("thread_id") || undefined,
        status: status === "open" || status === "resolved" || status === "cancelled" ? status : undefined,
        limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
      }),
    );
  });

  app.get("/v1/requests/:id", async (c) => {
    const set = accessible(c);
    // Tried against each accessible project rather than read-then-check: `getRequest` takes the
    // tenant as an argument, so there is no code path here that has ever held another tenant's row.
    for (const pid of set) {
      const row = await requests().getRequest(pid, c.req.param("id"));
      if (row) return c.json(row);
    }
    return c.json({ error: "not found" }, 404);
  });

  /**
   * Chase a client about one ask, now.
   *
   * `pacing: "override"` — a founder looking at this request has decided something the ladder cannot
   * know, and a button that silently declines is worse than a slightly early reminder. The stamp
   * still happens so the four-hourly sweep SEES it and does not add a second reminder on top, and
   * `MAX_NUDGES` is still enforced: the budget is about the customer's patience, which a founder
   * clicking a button does not increase.
   *
   * IT DOES NOT SEND. `startNudge` spawns a run whose message goes through `awaitApproval` like every
   * other consequence. A refusal is a 409 with a machine `reason` and a sentence — "we asked them
   * yesterday" is a true and useful answer, "something went wrong" is neither.
   */
  app.post("/v1/requests/:id/nudge", async (c) => {
    const set = accessible(c);
    for (const pid of set) {
      // Scoped read per project, exactly like the routes around it: there is no code path here that
      // has ever held another tenant's row.
      const row = await requests().getRequest(pid, c.req.param("id"));
      if (!row) continue;
      const started = await startNudge(domain, row, { pacing: "override" });
      if (!started.ok) return c.json({ error: started.message, code: `nudge.${started.reason}` }, 409);
      return c.json(started, 201);
    }
    return c.json({ error: "not found" }, 404);
  });

  /** Withdraw an ask. A cancelled request stops nagging the client and stops blocking the run. */
  app.post("/v1/requests/:id/cancel", async (c) => {
    const set = accessible(c);
    for (const pid of set) {
      const row = await requests().cancelRequest(pid, c.req.param("id"));
      if (row) return c.json(row);
    }
    return c.json({ error: "not found" }, 404);
  });

  // ─────────────────────────────── client plane ───────────────────────────────
  // These sit under `/v1/portal/*`, so the session middleware registered in server.ts has already
  // run and `c.get("client")` is a verified `ClientScope`. Nothing below reads a project or client
  // id from the request.

  const session = (c: any) => c.get("client") as ClientScope;

  /** What is blocking this client's work. The single highest-value thing a portal does. */
  app.get("/v1/portal/requests", async (c) => {
    const sc = session(c);
    const status = c.req.query("status");
    const rows = await requests().listRequests({
      // Both from the SESSION. Pushed into the query rather than filtered afterwards, because a
      // post-filter only protects the rows the query happened to return and leaks the moment a
      // `limit` truncates — the exact mistake `GET /v1/portal/cases` was fixed for.
      project_id: sc.project_id,
      client_id: sc.client_id,
      status: status === "open" || status === "resolved" || status === "cancelled" ? status : undefined,
    });
    // Third-party asks (candidate / contractor) stay off the client portal — same grammar, different
    // counterparty. Founder plane still lists them.
    return c.json(rows.filter(isClientFacing).map(toPortal));
  });

  /**
   * A client clearing what they were blocked on. THE LOOP — see the header.
   *
   * A `response` is required even for a `document` request, because an upload that arrives with no
   * word from the client is indistinguishable from the client having sent the wrong thing. Files may
   * arrive as `artifact_ids` (already uploaded via the thread attachment door) so the next episode
   * opens the exact bytes without scraping the chat.
   */
  app.post("/v1/portal/requests/:id/respond", async (c) => {
    const sc = session(c);
    const b = (await c.req.json().catch(() => ({}))) as { response?: string; artifact_ids?: unknown };
    const response = (b.response ?? "").trim();
    if (!response) return c.json({ error: "an answer is required" }, 400);
    if (response.length > 10_000) return c.json({ error: "that answer is too long" }, 413);
    const rawIds = Array.isArray(b.artifact_ids) ? b.artifact_ids.map(String).slice(0, 20) : [];

    // Scoped read BEFORE the write, purely so a request belonging to someone else is a 404 rather
    // than a 409 — the atomic resolve below would refuse it either way, but the status code would
    // have told a prober that the id was real.
    const existing = await requests().getRequest(sc.project_id, c.req.param("id"));
    if (!existing || existing.client_id !== sc.client_id) return c.json({ error: "not found" }, 404);
    if (existing.status !== "open") return c.json({ error: "that request is already closed" }, 409);
    if (existing.kind === "connection") {
      return c.json(
        {
          error:
            "this ask is cleared by connecting the app — use the Connect button, not a typed answer",
        },
        400,
      );
    }

    // Document asks may attach files; other kinds ignore them rather than error — a client pasting
    // an id by mistake must not fail an answer/decision they already typed.
    const artifactIds: string[] = [];
    if (existing.kind === "document" && rawIds.length) {
      for (const id of rawIds) {
        const a = await store.getArtifact(id);
        if (!a) return c.json({ error: "one of those files is no longer available" }, 400);
        const t = await store.getTask(a.task_id);
        if (!t || t.project_id !== sc.project_id || taskClientId(t) !== sc.client_id) {
          return c.json({ error: "one of those files is not yours to attach" }, 400);
        }
        artifactIds.push(id);
      }
    }

    const resolved = await requests().resolveRequest(sc.project_id, existing.id, response, artifactIds);
    // Lost the race with another tab. Return the row as it stands and spawn NOTHING — the run was
    // already released by whoever won.
    if (!resolved) return c.json({ error: "that request is already closed" }, 409);

    /**
     * The nudge that plausibly earned this answer, credited automatically.
     *
     * AFTER the atomic resolve, so the outcome is written exactly once — the loser of the race
     * returned above and never reaches this line. Attribution is `noteRequestAnswered`'s job and not
     * this route's, including refusing to credit an answer to a request nobody ever nudged, and
     * `.catch` because a ledger write must never cost a client their answer.
     */
    await noteRequestAnswered(
      getDomainStore(),
      systemMoveAuthority(resolved.project_id),
      resolved,
      resolved.resolved_at ?? new Date().toISOString(),
    ).catch(() => undefined);

    let taskId: string | undefined;
    let thread: Thread | undefined;
    if (resolved.thread_id) {
      thread = await domain.getThread(resolved.thread_id);
      // Re-checked against the session even though the founder route verified it on the way in.
      // Ownership at write time is not ownership at read time, and this is the one place a client's
      // words get written into a conversation.
      if (thread && thread.client_id === sc.client_id && (!thread.project_id || thread.project_id === sc.project_id)) {
        const body =
          artifactIds.length > 0
            ? `${response}\n\n(Attached ${artifactIds.length} file${artifactIds.length === 1 ? "" : "s"}.)`
            : response;
        await domain.addMessage({
          thread_id: thread.id,
          direction: "inbound",
          // From the session. A client cannot post as the agent or as another customer.
          author: sc.client_id,
          body,
          status: "sent",
        });
        taskId = await spawnFromThread(thread, sc, body);
      }
    }
    return c.json({ request: toPortal(resolved), task_id: taskId });
  });
}
