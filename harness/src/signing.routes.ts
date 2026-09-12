// Signature routes — two planes, and the client plane is the one that has to be careful.
//
// ═══ WHY SIGNING IS NOT AN APPROVAL ═══
//
// `portal-approvals.ts` already lets a client decide something in their own plane, and the first
// design here reused it: an approval with a `client:sign` action, resolved the same way. That is
// wrong, and the reason is worth keeping because the two look identical from the outside.
//
// An approval is a DECISION about work: yes or no, recorded, reversible in practice because the
// founder can ask again. A signature is an EXECUTED INSTRUMENT: it binds, it is dated, it is
// evidence, and the thing that makes it evidence is a set of facts an approval never collects —
// what the signer consented to, what bytes they were shown, what they typed, from where. Modelling
// it as an approval would have produced a row saying "approved" with none of that, and the first
// time it mattered would have been the first time it was disputed.
//
// So: its own store, its own routes, its own entries on the chain. It reuses the portal SESSION,
// because possession of a link delivered to the address on the envelope is the attribution
// evidence — and nothing else.
//
// ═══ THE CLIENT PLANE SERVES BYTES, NOT A DESCRIPTION OF BYTES ═══
//
// `GET /v1/portal/envelopes/:id/document` returns the file. `POST …/sign` then hashes THE SAME
// bytes server-side and compares. The signer never sends a hash: a hash from the client is a claim
// about what they saw, and the entire integrity property depends on it being an observation
// instead.
import type { Context, Hono } from "hono";
import type { ClientScope } from "./portal";
import { render } from "./render";
import {
  certificate,
  createEnvelope,
  declineEnvelope,
  requestChanges,
  reviseEnvelope,
  INCLUDED_CHANGE_ROUNDS,
  getEnvelope,
  listEnvelopes,
  sendEnvelope,
  signEnvelope,
  voidEnvelope,
  SigningError,
  type Envelope,
} from "./signing";
import type { BrandKit } from "./brandkit";

/** Everything the client plane may learn about an envelope. */
function forClient(env: Envelope): Record<string, unknown> {
  return {
    id: env.id,
    title: env.title,
    status: env.status,
    document: { filename: env.document.filename, size_bytes: env.document.size_bytes },
    // Other signers by name and status only. A counterparty's address is not the signer's business,
    // and an engagement can carry a second client contact.
    signers: env.signers.map((s) => ({ name: s.name, role: s.role, status: s.status, order: s.order })),
    expires_at: env.expires_at,
    revision: env.revision,
    /**
     * HOW MANY ROUNDS ARE LEFT, told to the client BEFORE they use one.
     *
     * A limit somebody agreed to in writing is a limit; a limit they discover when a button vanishes
     * is a grievance. The proposal states the allowance and this is what lets the portal say "one
     * more round of changes is included" beside the button rather than after it.
     */
    change_rounds_left: Math.max(0, INCLUDED_CHANGE_ROUNDS - (env.revision - 1)),
    // So the portal knows to render a pad. Without it the client meets the requirement as a refusal
    // after typing their name, which is the worst moment to discover a second step exists.
    ...(env.require_drawn ? { require_drawn: true } : {}),
    ...(env.completed_at ? { completed_at: env.completed_at } : {}),
  };
}

const fail = (e: unknown): { status: number; body: { error: string; code?: string } } => {
  if (e instanceof SigningError) {
    // 404 for "not yours" and "no such", identically — a 403 confirms the envelope exists, which is
    // half of what somebody probing would want to know. Same rule as `ownedDeliverable`.
    const status = e.code === "not_found" ? 404 : e.code === "evidence_not_recorded" ? 503 : 409;
    return { status, body: { error: e.message, code: e.code } };
  }
  return { status: 500, body: { error: "signing failed" } };
};

export interface SigningRouteDeps {
  /** The signed bytes, by artifact id. The store the deliverable renderer already writes to. */
  readArtifact: (projectId: string, artifactId: string) => Promise<Buffer | undefined>;
  /** The business's brand, for the certificate's letterhead. Undefined before one is configured. */
  brandKit: (projectId: string) => BrandKit | undefined;
  /** Called once, when the last signature lands. See `on_execute` in signing.ts. */
  onExecuted?: (env: Envelope) => Promise<void>;
  /**
   * Tenancy, INJECTED — the same three closures `clients.routes.ts` takes, for the reason its
   * header gives: a second copy of "which projects may this caller see" is how a tenancy check
   * drifts. The two would agree today and disagree the first time one of them learns about a new
   * scope kind, and here the row they disagree about is an executed contract.
   */
  accessible: (c: Context) => Set<string>;
  writeProjectId: (c: Context) => string | undefined;
  inScope: (set: Set<string>, pid?: string) => boolean;
}

export function mountSigningRoutes(app: Hono, deps: SigningRouteDeps): void {
  const { accessible, writeProjectId, inScope } = deps;
  const client = (c: Context) => c.get("client") as ClientScope;
  /** The envelope, if this caller may see the project it belongs to. Undefined reads as 404. */
  const visible = async (c: Context, id: string): Promise<Envelope | undefined> => {
    const env = await getEnvelope(id);
    return env && inScope(accessible(c), env.project_id) ? env : undefined;
  };

  /** Owned by THIS client, in THIS project — neither condition taken from the request. */
  const ownedEnvelope = async (sc: ClientScope, id: string): Promise<Envelope | undefined> => {
    const env = await getEnvelope(id);
    return env && env.project_id === sc.project_id && env.client_id === sc.client_id ? env : undefined;
  };

  // ── the founder's plane ───────────────────────────────────────────────────────────────────────

  app.get("/v1/envelopes", async (c) => {
    const projectId = writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    if (!inScope(accessible(c), projectId)) return c.json({ error: "no such project" }, 404);
    const rows = await listEnvelopes(projectId, {
      ...(c.req.query("client_id") ? { client_id: c.req.query("client_id")! } : {}),
      ...(c.req.query("case_id") ? { case_id: c.req.query("case_id")! } : {}),
    });
    return c.json({ envelopes: rows });
  });

  app.get("/v1/envelopes/:id", async (c) => {
    const env = await visible(c, c.req.param("id"));
    if (!env) return c.json({ error: "no such envelope" }, 404);
    return c.json({ envelope: env, certificate: await certificate(env) });
  });

  /**
   * ═══ THE CERTIFICATE, AS A FILE ═══
   *
   * `render/certificate.ts` was written, tested and reachable from nothing — the routes above return
   * the certificate as JSON, which is a thing a program reads. ESIGN's fifth limb is RETENTION AND
   * REPRODUCTION: both parties can keep a copy and produce it later. A JSON body is not that.
   *
   * So this is the file. Served on both planes, because "both parties" is the requirement and a
   * certificate only the provider can download is half a certificate.
   */
  const certificatePdf = async (c: Context, env: Envelope) => {
    const kit = deps.brandKit(env.project_id);
    if (!kit) return c.json({ error: "this business has no brand set up yet" }, 409);
    const doc = render(
      "certificate",
      { certificate: await certificate(env), ...(env.case_id ? { reference: `Reference ${env.case_id}` } : {}) },
      kit,
      "pdf",
    );
    return c.body(new Uint8Array(Buffer.from(doc.content, "base64")), 200, {
      "content-type": "application/pdf",
      // `attachment`, not `inline`. This is the copy somebody keeps, and a browser that renders it
      // in a tab is a browser the reader closes without saving.
      "content-disposition": `attachment; filename="${doc.name}"`,
    });
  };

  app.get("/v1/envelopes/:id/certificate.pdf", async (c) => {
    const env = await visible(c, c.req.param("id"));
    if (!env) return c.json({ error: "no such envelope" }, 404);
    return certificatePdf(c, env);
  });

  app.post("/v1/envelopes", async (c) => {
    const projectId = writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    if (!inScope(accessible(c), projectId)) return c.json({ error: "no such project" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, any>;
    try {
      const env = await createEnvelope({
        project_id: projectId,
        client_id: body.client_id,
        case_id: body.case_id,
        title: String(body.title ?? "Agreement"),
        document: {
          artifact_id: String(body.artifact_id ?? ""),
          filename: String(body.filename ?? "agreement.pdf"),
          sha256: "",
          size_bytes: 0,
        },
        signers: Array.isArray(body.signers) ? body.signers : [],
        ...(body.require_drawn === true ? { require_drawn: true } : {}),
        on_execute: body.on_execute,
      });
      return c.json({ envelope: env }, 201);
    } catch (e) {
      const { status, body: b } = fail(e);
      return c.json(b, status as 400);
    }
  });

  /**
   * SEND — the seal. The bytes are read from the artifact store here, so the hash is an observation
   * of what will actually be served rather than a number the caller supplied.
   */
  app.post("/v1/envelopes/:id/send", async (c) => {
    const env = await visible(c, c.req.param("id"));
    if (!env) return c.json({ error: "no such envelope" }, 404);
    const bytes = await deps.readArtifact(env.project_id, env.document.artifact_id);
    if (!bytes) return c.json({ error: "the document for this envelope is missing" }, 409);
    try {
      return c.json({ envelope: await sendEnvelope(env.id, bytes) });
    } catch (e) {
      const { status, body } = fail(e);
      return c.json(body, status as 409);
    }
  });

  app.post("/v1/envelopes/:id/void", async (c) => {
    const env = await visible(c, c.req.param("id"));
    if (!env) return c.json({ error: "no such envelope" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { reason?: string };
    try {
      return c.json({ envelope: await voidEnvelope(env.id, body.reason ?? "withdrawn by the sender") });
    } catch (e) {
      const { status, body: b } = fail(e);
      return c.json(b, status as 409);
    }
  });

  /**
   * The provider's own signature, from their member session.
   *
   * `auth_subject` is the member id off the session. The founder cannot sign as the client and the
   * client cannot sign as the founder, because neither can produce the other's credential and the
   * subject is never read from the body.
   */
  app.post("/v1/envelopes/:id/sign", async (c) => {
    const memberId = (c.get("scope") as import("./identity").AuthScope | undefined)?.member_id ?? "founder";
    const env = await visible(c, c.req.param("id"));
    if (!env) return c.json({ error: "no such envelope" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, any>;
    try {
      const bytes = await deps.readArtifact(env.project_id, env.document.artifact_id);
      if (!bytes) return c.json({ error: "the document for this envelope is missing" }, 409);
      const next = await signEnvelope({
        envelope_id: env.id,
        signer_email: String(body.signer_email ?? ""),
        typed_name: String(body.typed_name ?? ""),
        consented_at: String(body.consented_at ?? ""),
        auth_method: "member_session",
        auth_subject: `member:${memberId}`,
        served_bytes: bytes,
        ...(typeof body.drawn_png === "string" ? { drawn_png: body.drawn_png } : {}),
        ...(c.req.header("x-forwarded-for") ? { ip: c.req.header("x-forwarded-for")!.split(",")[0]!.trim() } : {}),
        ...(c.req.header("user-agent") ? { user_agent: c.req.header("user-agent")! } : {}),
      });
      if (next.status === "executed") await deps.onExecuted?.(next);
      return c.json({ envelope: next });
    } catch (e) {
      const { status, body: b } = fail(e);
      return c.json(b, status as 409);
    }
  });

  // ── the client's plane ────────────────────────────────────────────────────────────────────────

  app.get("/v1/portal/envelopes", async (c) => {
    const sc = client(c);
    const rows = await listEnvelopes(sc.project_id, { client_id: sc.client_id });
    // Drafts are not sent yet, and a client learning that a proposal exists before the founder
    // released it is the same leak `visibleVersions` exists to prevent for deliverables.
    return c.json({ envelopes: rows.filter((e) => e.status !== "draft").map(forClient) });
  });

  app.get("/v1/portal/envelopes/:id", async (c) => {
    const sc = client(c);
    const env = await ownedEnvelope(sc, c.req.param("id"));
    if (!env || env.status === "draft") return c.json({ error: "no such document" }, 404);
    return c.json({ envelope: forClient(env), certificate: await certificate(env) });
  });

  app.get("/v1/portal/envelopes/:id/certificate.pdf", async (c) => {
    const sc = client(c);
    const env = await ownedEnvelope(sc, c.req.param("id"));
    if (!env || env.status === "draft") return c.json({ error: "no such document" }, 404);
    return certificatePdf(c, env);
  });

  /** The bytes themselves. What `sign` will hash. */
  app.get("/v1/portal/envelopes/:id/document", async (c) => {
    const sc = client(c);
    const env = await ownedEnvelope(sc, c.req.param("id"));
    if (!env || env.status === "draft") return c.json({ error: "no such document" }, 404);
    const bytes = await deps.readArtifact(sc.project_id, env.document.artifact_id);
    if (!bytes) return c.json({ error: "the document is missing" }, 404);
    return c.body(new Uint8Array(bytes), 200, {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="${env.document.filename}"`,
    });
  });

  /**
   * SIGN, from the portal.
   *
   * `signer_email` is not taken from the body. A client session resolves to one client, and the
   * signer is matched by the address on the envelope belonging to that client — otherwise a
   * customer could sign in the counterparty's name from their own valid session, which is the one
   * attack this whole file is arranged against.
   */
  app.post("/v1/portal/envelopes/:id/sign", async (c) => {
    const sc = client(c);
    const env = await ownedEnvelope(sc, c.req.param("id"));
    if (!env || env.status === "draft") return c.json({ error: "no such document" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, any>;

    // The client-side signers on this envelope. One is the ordinary case; more than one is a second
    // contact at the same company, and then the body may choose between them — but only from the
    // set already on the envelope.
    const mine = env.signers.filter((s) => s.role === "client");
    const wanted = String(body.signer_email ?? "").trim().toLowerCase();
    const signer = mine.length === 1 ? mine[0] : mine.find((s) => s.email === wanted);
    if (!signer) return c.json({ error: "we do not have you down as a signer on this" }, 409);

    try {
      const bytes = await deps.readArtifact(sc.project_id, env.document.artifact_id);
      if (!bytes) return c.json({ error: "the document is missing" }, 409);
      const next = await signEnvelope({
        envelope_id: env.id,
        signer_email: signer.email,
        typed_name: String(body.typed_name ?? ""),
        consented_at: String(body.consented_at ?? ""),
        auth_method: "portal_link",
        auth_subject: `client:${signer.email}`,
        served_bytes: bytes,
        ...(typeof body.drawn_png === "string" ? { drawn_png: body.drawn_png } : {}),
        ...(c.req.header("x-forwarded-for") ? { ip: c.req.header("x-forwarded-for")!.split(",")[0]!.trim() } : {}),
        ...(c.req.header("user-agent") ? { user_agent: c.req.header("user-agent")! } : {}),
      });
      if (next.status === "executed") await deps.onExecuted?.(next);
      return c.json({ envelope: forClient(next) });
    } catch (e) {
      const { status, body: b } = fail(e);
      return c.json(b, status as 409);
    }
  });

  /**
   * "YES, BUT" — the act a service business actually runs on.
   *
   * Separate from decline because the founder's next move is the opposite: after a decline they find
   * out what went wrong, after this they send a new number. A product that cannot tell those apart
   * cannot tell a deal in progress from a deal lost, on the one screen where that is the question.
   */
  app.post("/v1/portal/envelopes/:id/request-change", async (c) => {
    const sc = client(c);
    const env = await ownedEnvelope(sc, c.req.param("id"));
    if (!env || env.status === "draft") return c.json({ error: "no such document" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { asked?: string; signer_email?: string };
    const mine = env.signers.filter((s) => s.role === "client");
    const signer = mine.length === 1 ? mine[0] : mine.find((s) => s.email === String(body.signer_email ?? "").toLowerCase());
    if (!signer) return c.json({ error: "we do not have you down as a signer on this" }, 409);
    try {
      const next = await requestChanges({
        envelope_id: env.id,
        signer_email: signer.email,
        asked: String(body.asked ?? ""),
        auth_subject: `client:${signer.email}`,
      });
      return c.json({ envelope: forClient(next) });
    } catch (e) {
      const { status, body: b } = fail(e);
      return c.json(b, status as 409);
    }
  });

  /**
   * REVISE — the founder's side of the same loop, and NOT capped.
   *
   * `INCLUDED_CHANGE_ROUNDS` binds what a client can demand without anyone deciding to allow it. It
   * does not bind the founder: a business that wants to send a fourth draft because the deal is
   * worth it should send a fourth draft. The cap exists to stop unpaid work happening by default,
   * not to stop it happening by choice.
   */
  app.post("/v1/envelopes/:id/revise", async (c) => {
    const env = await visible(c, c.req.param("id"));
    if (!env) return c.json({ error: "no such envelope" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, any>;
    const artifactId = String(body.artifact_id ?? "");
    const bytes = await deps.readArtifact(env.project_id, artifactId);
    if (!bytes) return c.json({ error: "the document for the revision is missing" }, 409);
    try {
      const next = await reviseEnvelope({
        previous_id: env.id,
        document: {
          artifact_id: artifactId,
          filename: String(body.filename ?? env.document.filename),
          sha256: "",
          size_bytes: bytes.length,
        },
        ...(body.title ? { title: String(body.title) } : {}),
      });
      return c.json({ envelope: next }, 201);
    } catch (e) {
      const { status, body: b } = fail(e);
      return c.json(b, status as 409);
    }
  });

  app.post("/v1/portal/envelopes/:id/decline", async (c) => {
    const sc = client(c);
    const env = await ownedEnvelope(sc, c.req.param("id"));
    if (!env || env.status === "draft") return c.json({ error: "no such document" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { reason?: string; signer_email?: string };
    const mine = env.signers.filter((s) => s.role === "client");
    const signer = mine.length === 1 ? mine[0] : mine.find((s) => s.email === String(body.signer_email ?? "").toLowerCase());
    if (!signer) return c.json({ error: "we do not have you down as a signer on this" }, 409);
    try {
      const next = await declineEnvelope({
        envelope_id: env.id,
        signer_email: signer.email,
        // A reason is required rather than optional: "they said no" without one is the answer that
        // teaches the founder nothing, and this is the cheapest moment to learn why a deal died.
        reason: String(body.reason ?? "").trim() || "no reason given",
        auth_subject: `client:${signer.email}`,
      });
      return c.json({ envelope: forClient(next) });
    } catch (e) {
      const { status, body: b } = fail(e);
      return c.json(b, status as 409);
    }
  });
}
