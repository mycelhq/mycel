// THE CLIENT SPEAKING FIRST.
//
// ── The gap this closes ──
//
// Until this file, every thread on the client plane was created BY THE BUSINESS: by the kernel from
// an inbound channel message, or by the founder. `POST /v1/portal/threads/:id/messages` appends to a
// thread that already exists. So a client who opened their portal with a question they had not been
// asked — "can you also do X", "here is a new job" — found a read-only website belonging to their own
// supplier, whose conversations empty state literally said *when we message you, it'll appear here*.
// Observed in production on 2026-08-10: a real client signed in and the entire page contained one
// interactive element, "Sign out of this browser". Asking your agency for work was impossible.
//
// ── The scoping rule, which is the whole of the security of this file ──
//
// A new thread's `client_id` and `project_id` come from `c.get("client")` — the session the middleware
// in server.ts resolved — and from NOWHERE ELSE. They are read as REQUIRED values off `ClientScope`,
// not defaulted from the body with the session as a fallback, because the fallback spelling is how
// both cross-tenant leaks in this repo shipped: a body field that was "usually absent" is a body
// field an attacker supplies. There is deliberately no `client_id`, `project_id`, `case_id` or
// `channel_id` accepted anywhere below. The only things a caller may set are the words they typed.
//
// ── And nothing auto-sends ──
//
// Creating a thread spawns exactly the run a reply spawns, through the SAME `spawnFromThread` the
// message route uses — same wedge, same actor scoping, same constraints. Whatever the business says
// back still stops at the approval gate it always did. This adds an inbound door, not an outbound one.
import type { Hono } from "hono";
import { decodeBrandLogo, type BrandKit } from "./brandkit";
import type { DomainStore } from "./domain";
import type { ClientScope } from "./portal";

/** Mirrors the cap on `POST /v1/portal/threads/:id/messages`, so the two doors take the same message. */
const MAX_BODY = 10_000;
/** A subject is a line, not an essay. Long ones are truncated rather than refused — see `newThread`. */
const MAX_SUBJECT = 200;

export interface PortalThreadDeps {
  domain: DomainStore;
  /**
   * The identical function the reply and attachment routes call. Injected rather than reimplemented:
   * a second spawn path would drift on actor scoping and constraints, and the failure mode is a run
   * started on behalf of a client with the wrong connections in scope.
   */
  spawnFromThread: (
    thread: { id: string; channel_id: string; subject?: string; case_id?: string },
    sc: { client_id: string; project_id: string },
    body: string,
  ) => Promise<string | undefined>;
  /** `identity.brandKit`. Returns undefined for a project that does not exist — never a default kit. */
  brandKit: (projectId: string) => BrandKit | undefined;
  /** `domain.listChannels()` is unscoped, so the project filter below is this file's job. */
  listChannels: () => Promise<{ id: string; project_id?: string; wedge: string }[]>;
}

export function mountPortalThreads(app: Hono, deps: PortalThreadDeps): void {
  const { domain, spawnFromThread, brandKit, listChannels } = deps;
  /** The scope, and the ONLY source of client identity on this plane. Never a path or body field. */
  const session = (c: any) => c.get("client") as ClientScope;

  /**
   * WHOSE PORTAL THIS IS.
   *
   * A client signing in saw no name, no mark and no colour anywhere on the page — nothing at all that
   * said which business they were looking at. The hosted app answers for every tenant on one
   * hostname, so it cannot do what `business-template` does and resolve the brand from the Host
   * header; the only thing it holds is the client's session, and the session names a project.
   *
   * So: the project's public brand, keyed by the SESSION's project id. There is no path parameter to
   * change, which is what makes walking the estate's branding impossible from a client session.
   *
   * Logo BYTES are deliberately not here. This is on the critical path of every portal page load and
   * a logo is up to 256KB of base64; `has_logo` lets a header plan for one, and the wordmark is the
   * house treatment anyway. Reported as the reason a client-plane logo route would be worth adding.
   */
  app.get("/v1/portal/business", async (c) => {
    const sc = session(c);
    const kit = brandKit(sc.project_id);
    // Fail closed rather than defaulting: a session whose project has vanished must not be handed
    // house branding, because "the tenant is gone" and "the tenant configured nothing" are different
    // facts and only one of them should draw a name.
    if (!kit) return c.json({ error: "not found" }, 404);
    return c.json({
      display_name: kit.display_name,
      accent: kit.accent,
      support_email: kit.support_email,
      has_logo: !!kit.logo,
    });
  });

  /**
   * THE TENANT'S LOGO, AS ITS OWN CACHEABLE IMAGE.
   *
   * The counterpart to `has_logo` on `/v1/portal/business`: that read is on the critical path of
   * every page load and deliberately carries no bytes, so the header and the browser tab fetch the
   * logo HERE instead — once, and then from cache. Scoped to the SESSION's project exactly like the
   * brand read above; there is no path or query parameter, so a client cannot ask for another
   * tenant's mark. `decodeBrandLogo` is a pure base64→bytes with the audited mime; no logo set is a
   * 404 so the caller falls back to the wordmark rather than drawing a broken image.
   */
  app.get("/v1/portal/logo", async (c) => {
    const sc = session(c);
    const img = decodeBrandLogo(brandKit(sc.project_id)?.logo);
    if (!img) return c.body(null, 404);
    c.header("content-type", img.contentType);
    // The mark changes rarely and is small; a day of caching keeps it off every page load. `private`
    // because it is fetched with the client's session cookie — a shared cache must not keep one
    // tenant's mark and hand it to the next visitor on this origin.
    c.header("cache-control", "private, max-age=86400");
    c.header("x-content-type-options", "nosniff");
    return c.body(img.bytes);
  });

  /**
   * A client starting a conversation.
   *
   * ── Which channel it lands on ──
   *
   * `threads.channel_id` is NOT NULL (it is a uuid column), so a thread cannot be created without
   * one, and there is no honest way for a client to choose. The channel is therefore derived, in this
   * order: the channel of this client's most recent thread — which is the address they and the
   * business already talk on — then any channel in the session's project. Both are filtered by the
   * session's project id; a channel from another tenant is not reachable from here even if a client's
   * own thread somehow named one.
   *
   * With no channel at all the answer is 409 and an explanation, NOT a thread. A thread on a channel
   * that does not exist can never be replied to by the business, so it would be a message written
   * into a drawer nobody opens — the exact "failed while reporting success" shape this codebase keeps
   * paying for. The portal falls back to its email affordance on a 409.
   */
  app.post("/v1/portal/threads", async (c) => {
    const sc = session(c);
    const b = (await c.req.json().catch(() => ({}))) as { subject?: unknown; body?: unknown };

    const body = typeof b.body === "string" ? b.body.trim() : "";
    if (!body) return c.json({ error: "body is required" }, 400);
    if (body.length > MAX_BODY) return c.json({ error: "message is too long" }, 413);
    // Truncated, not refused. A subject is a convenience; losing the client's whole message because
    // they pasted a paragraph into the subject line would be a worse trade than a clipped heading.
    const typed = typeof b.subject === "string" ? b.subject.trim().slice(0, MAX_SUBJECT) : "";
    // No subject is the common case on a phone. Deriving one from the first line beats storing NULL
    // and rendering "No subject" in the founder's inbox next to a message that plainly has one.
    const subject = typed || firstLine(body);

    const channelId = await channelFor(sc);
    if (!channelId) {
      return c.json(
        { error: "there is no channel on this project, so a new conversation would have nowhere to go" },
        409,
      );
    }

    const thread = await domain.createThread({
      // BOTH of these come off the session. Not `b.project_id ?? sc.project_id` — see the file header.
      project_id: sc.project_id,
      client_id: sc.client_id,
      channel_id: channelId,
      // No `case_id`. A client cannot name an engagement; a run may attach one later (`updateThread`
      // is write-once for exactly that), and guessing here would file a new job under an old one.
      subject,
      status: "open",
    });

    const msg = await domain.addMessage({
      thread_id: thread.id,
      direction: "inbound",
      // Attributed from the session, like every other inbound. A client cannot post as the business.
      author: sc.client_id,
      body,
      status: "sent",
    });

    // The same run a reply would have started. Undefined when the channel's wedge no longer loads, in
    // which case the message is still on record for a human — degraded, not lost.
    const taskId = await spawnFromThread(thread, sc, body);
    return c.json({ thread, message: msg, task_id: taskId }, 201);
  });

  /**
   * The channel a new thread belongs on, chosen from the SESSION's project only.
   *
   * The client's own threads are consulted first and are still project-filtered on the way out: a
   * legacy row pointing at another tenant's channel must not become the route by which this client's
   * next message is delivered there.
   */
  async function channelFor(sc: ClientScope): Promise<string | undefined> {
    // `ch.project_id === sc.project_id`, with NO `!ch.project_id ||` escape. That disjunct is the
    // same fail-open shape that let a project-less task be granted another tenant's connection
    // (`selectGrantableConnections`): an unscoped row matched EVERY tenant, so one channel created
    // without a project would have become the delivery address for every client portal in the
    // deployment. An unscoped channel is a fault to fix, not a wildcard to honour — and the failure
    // it causes here ("we could not start this") is enormously cheaper than the one it prevents
    // (this client's message delivered to a different business).
    const channels = (await listChannels()).filter((ch) => ch.project_id === sc.project_id);
    if (channels.length === 0) return undefined;
    const mine = (await domain.listThreadsForClient(sc.client_id))
      .filter((t) => t.project_id === sc.project_id)
      .sort((x, y) => y.updated_at.localeCompare(x.updated_at));
    for (const t of mine) if (channels.some((ch) => ch.id === t.channel_id)) return t.channel_id;
    return channels[0].id;
  }
}

/** The first sentence or line, clipped — a heading, derived rather than demanded. */
function firstLine(body: string): string {
  const line = body.split(/\r?\n/, 1)[0]!.trim();
  const head = line.length > 72 ? `${line.slice(0, 71).replace(/\s+\S*$/, "")}…` : line;
  return head || "New message";
}
