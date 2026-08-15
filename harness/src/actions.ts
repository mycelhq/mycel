// Executors: perform a real-world action through a Connection using its server-held secret. This
// is the far side of the action proxy — reached only after the human approval gate has said yes.
// Secrets are resolved here (never returned by any API, never sent to the sandbox).
//
// email + webhook are real (generic provider-over-HTTP + outbound webhook). stripe/sms/whatsapp/
// calendar are structured stubs — wire the provider call and they light up without touching the
// security model.
import type { Connection, ConnectionKind } from "./contract";
import {
  composioConfig,
  composioUserId,
  connConfig as composioConnConfig,
  executeTool,
} from "./composio";
import { resolveSecret } from "./secrets";
import {
  capabilitiesForConnection,
  guardSend,
  isMessagingSend,
  outboundFromPayload,
  type SendContext,
} from "./outreach/guard";
import { agentMailConfig, inboxIdFor, sendMessage as sendAgentMailMessage } from "./agentmail";
import {
  discoverCompanyPeople,
  getLinkedInCompany,
  getLinkedInProfile,
  searchLinkedInPeople,
  sendLinkedInFirstMessage,
  sendLinkedInInvite,
  sendLinkedInMessage,
  reactToLinkedInPost,
  followLinkedInPerson,
  viewLinkedInProfile,
  withdrawLinkedInInvite,
  type LiActionResult,
} from "./linkedin/connect";

export interface ActionResult {
  ok: boolean;
  detail?: string;
  data?: unknown;
  /**
   * A NAMED failure, when the executor knows which one this is.
   *
   * `linkedin_commercial_search_limit` and `linkedin_invite_quota` are the reason this field
   * exists: both are quotas with a calendar on them, and a founder who reads "search failed"
   * retries forever while a founder who reads "the monthly window is spent" makes a decision. A
   * generic `ok: false` throws that distinction away at the executor boundary, which is the last
   * place it is still known.
   */
  code?: string;
}

/** A short, human-readable preview of what will happen — shown on the approval card. */
/**
 * What an approval card may carry.
 *
 * The preview is PERSISTED in the approvals row and RENDERED to a human, so whatever goes in here
 * outlives the run and gets read. That is right for the amount and the recipient — a human
 * approving "create an invoice in Xero" has to see them — and wrong for three things the agent can
 * put in a tool argument without anyone intending it:
 *
 *   · A credential. Some brokered tools take a token or a webhook secret as an argument. Once one
 *     lands in an approval row it is in the database, in the UI, and in anything that reads either.
 *   · A document. An argument can be an entire attachment or a 200KB body. A preview is a summary
 *     for a human to judge, not a copy of the payload.
 *   · Depth. Nested structures render as unreadable JSON, which trains people to approve without
 *     looking — the worst possible outcome for a gate whose whole value is that it is read.
 *
 * Subtractive by key name and size, deliberately: an allowlist would need to know every tool in
 * Composio's catalogue, and a tool added tomorrow would silently show nothing.
 */
const SECRET_KEY = /token|secret|password|passwd|api[-_]?key|authorization|credential|private[-_]?key|signature|bearer/i;
/** Long enough to show an invoice line or an email subject; short enough not to be a document. */
const MAX_STRING = 400;
const MAX_ITEMS = 20;
const MAX_DEPTH = 4;

export function redactPreview(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}… [${value.length} chars]` : value;
  }
  if (typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "[nested]";
  if (Array.isArray(value)) {
    const head = value.slice(0, MAX_ITEMS).map((v) => redactPreview(v, depth + 1));
    return value.length > MAX_ITEMS ? [...head, `… ${value.length - MAX_ITEMS} more`] : head;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    // Redacted rather than dropped: a human deciding whether to approve should be able to see THAT
    // a token was going to be sent, just not what it is.
    out[k] = SECRET_KEY.test(k) ? "[redacted]" : redactPreview(v, depth + 1);
  }
  return out;
}

/**
 * The recipient inside a brokered tool's arguments, if one of the usual keys holds a string.
 *
 * A guess, and bounded like one: known keys only, first hit wins, strings and string arrays only.
 * Returning `undefined` when unsure is correct — the card simply omits the "To" row, which is what
 * it did before. Showing the WRONG recipient on an approval card would be worse than showing none.
 */
const RECIPIENT_KEYS = [
  "to",
  "recipient",
  "recipient_email",
  "recipients",
  "to_email",
  "email",
  "customer_email",
  "channel",
  "phone",
  "phone_number",
];

function composioRecipient(args: unknown): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const bag = args as Record<string, unknown>;
  for (const k of RECIPIENT_KEYS) {
    const v = bag[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (Array.isArray(v)) {
      const s = v.find((x): x is string => typeof x === "string" && !!x.trim());
      if (s) return s.trim();
    }
  }
  return undefined;
}

export function actionPreview(
  conn: Connection,
  capability: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  // `endpoint` is the host the credential will actually be sent to, taken from the CONNECTION
  // rather than the payload. A human approving an outbound call should be able to see the
  // destination; a preview that only echoes what the agent asked for isn't a check on the agent.
  const endpoint = conn.config.url ?? conn.config.api_url ?? undefined;
  if (conn.kind === "composio") {
    // For a brokered call the meaningful preview is the toolkit, the tool and its arguments — a
    // human approving "create an invoice in Xero" needs to see the amount and the customer, and
    // there is no `to`/`subject`/`body` to fall back on.
    const cc = composioConnConfig(conn);
    return {
      connection: conn.name,
      kind: conn.kind,
      capability,
      toolkit: cc.toolkit,
      tool: capability,
      // Arguments only. Never the Composio API key, and never the connected account's token —
      // neither is in `payload`, and this is the note that keeps it that way.
      arguments: redactPreview(payload.arguments ?? payload.body ?? {}),
      // WHO THIS REACHES, lifted to a top-level field.
      //
      // Every other connection kind sets `to`, and the approval card renders it as its own row. A
      // brokered send set it nowhere, so a founder approving `composio:GMAIL_SEND_EMAIL` was shown
      // a toolkit and a tool slug and had to find the recipient inside the arguments blob — on the
      // one card in this product whose entire purpose is that it gets read. The recipient lives in
      // the arguments under a different key per toolkit, and this is the layer that knows them.
      //
      // Redacted through the same path as everything else, and only ever COPIED out of arguments —
      // nothing new reaches the preview that was not already in it.
      to: composioRecipient(redactPreview(payload.arguments ?? payload.body ?? {})),
      preview: `${cc.toolkit}: ${capability}`,
    };
  }
  return {
    connection: conn.name,
    kind: conn.kind,
    capability,
    to: redactPreview(payload.to ?? payload.recipient ?? undefined),
    endpoint,
    subject: payload.subject ?? undefined,
    preview: typeof payload.body === "string" ? payload.body.slice(0, 400) : payload.body,
  };
}

// ── reads ──
// Reads are the asymmetric half of the trust model: a read is *ungated* (an agent that has to
// wait for a human before it can look at today's transactions is useless) but still *scoped* —
// only through a granted connection, only GET, host set by the connection, size-capped, traced.
export const MAX_READ_BYTES = 256 * 1024;

/** Result of a scoped read. `truncated` tells the agent it didn't get everything. */
export interface ReadResult {
  ok: boolean;
  status?: number;
  detail?: string;
  bytes?: number;
  truncated?: boolean;
  body?: string;
  data?: unknown;
}

/** The security crux, for reads AND writes: the sandbox supplies a PATH, never a host. Anything that
 *  could escape the connection's base URL (absolute URL, protocol-relative, traversal) is rejected.
 *  No SSRF, and no sending a connection's credential to a host the agent chose. */
export function safeReadPath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const p = raw.trim();
  if (!p) return "";
  if (/^[a-z][a-z0-9+.-]*:/i.test(p)) return null; // http:, file:, gopher: …
  if (p.startsWith("//")) return null; // protocol-relative → different host
  if (p.includes("..")) return null; // traversal
  if (/[\r\n]/.test(p)) return null; // header injection
  return p.replace(/^\/+/, "");
}

/**
 * Read through the broker. The capability IS the tool slug, exactly as it is for a brokered write.
 *
 * ═══ THE BUG THIS IS ═══
 *
 * `executeAction` has branched on `conn.kind === "composio"` since Composio landed. `executeRead`
 * did not, and the failure was silent in the way this repo keeps paying for. A Composio connection
 * has no `config.api_url` — the entire point of a broker is that the harness never holds the
 * vendor's base URL or its token — so every declared Composio read arriving over the MCP bridge
 * fell through to the HTTP path and came back `connection "xero" has no config.api_url to read
 * from`. An agent asked to check whether an invoice was paid read that as "nothing found" and drafted
 * on. A read that cannot happen must say the provider is unreachable, not return an empty answer.
 *
 * It survived review because all four cases in `reads.test.ts` stand up a local HTTP server and
 * point an `http` connection at it, so the branch that did not exist was never the branch under
 * test. The regression test added with this fix drives the MCP bridge against a `composio`
 * connection for exactly that reason.
 *
 * ═══ WHAT THIS DOES NOT WIDEN ═══
 *
 * The read/write asymmetry is enforced one layer up: `/v1/internal/reads/:capability` refuses any
 * slug the connection does not list in `read_tools` (`isReadTool`), so XERO_CREATE_INVOICE is not a
 * read just because an agent called it through /reads. This function executes the tool the caller
 * was ALREADY allowed to name. It does not decide who may name it, and adding that decision here
 * would be a second opinion about the same question — which is how the two end up disagreeing.
 *
 * `status` is deliberately left unset: there is no HTTP status here, and inventing a 200 would let
 * a caller branch on a number the broker never returned. `ok` plus `detail` is the whole answer.
 */
async function readComposio(
  conn: Connection,
  capability: string,
  params: Record<string, unknown>,
): Promise<ReadResult> {
  const cfg = composioConfig();
  if (!cfg) return { ok: false, detail: "COMPOSIO_API_KEY is not set on the harness" };
  const cc = composioConnConfig(conn);
  if (!cc.connected_account_id) {
    return {
      ok: false,
      detail: `connection "${conn.name}" is not connected yet — authorise ${cc.toolkit || "the toolkit"} first`,
    };
  }
  // `arguments` first, `query` second. A brokered tool takes named arguments and not a query string,
  // but the MCP bridge's read tool describes its parameters as `path`/`query` for the HTTP case, and
  // an agent that has only ever read over HTTP will send `query`. Accepting both is the difference
  // between a working read and one that silently filters nothing. `path` is meaningless here and is
  // ignored rather than smuggled into the arguments, where it would become a field the tool rejects.
  const args = (params.arguments ?? params.query ?? {}) as Record<string, unknown>;
  try {
    const r = await executeTool(cfg, {
      slug: capability,
      userId: composioUserId(conn),
      connectedAccountId: cc.connected_account_id,
      arguments: args,
    });
    return {
      ok: r.successful,
      detail: r.error ?? (r.successful ? undefined : "tool reported failure"),
      data: r.data,
    };
  } catch (e) {
    // A Composio error message can quote request context, so the message only — never headers, and
    // never the key. Same rule `runComposioTool` states for the write side.
    return { ok: false, detail: `composio: ${(e as Error).message}` };
  }
}

export async function executeRead(
  conn: Connection,
  capability: string,
  params: Record<string, unknown>,
): Promise<ReadResult> {
  if (conn.kind === "composio") return readComposio(conn, capability, params);

  const secret = await resolveSecret(conn.secret_ref, conn.id);
  const base = String(conn.config.api_url ?? conn.config.base_url ?? conn.config.url ?? "");
  if (!base) return { ok: false, detail: `connection "${conn.name}" has no config.api_url to read from` };

  const path = safeReadPath(params.path ?? "");
  if (path === null) return { ok: false, detail: "invalid path: must be a relative path, not a URL" };

  const url = new URL(`${base.replace(/\/+$/, "")}/${path}`);
  const query = params.query;
  if (query && typeof query === "object") {
    for (const [k, v] of Object.entries(query as Record<string, unknown>)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }

  try {
    const res = await fetch(url, {
      method: "GET", // reads are reads
      headers: {
        accept: "application/json",
        ...(secret ? { authorization: `Bearer ${secret}` } : {}),
      },
      signal: AbortSignal.timeout(20_000),
    });
    const raw = await res.text();
    const truncated = raw.length > MAX_READ_BYTES;
    const body = truncated ? raw.slice(0, MAX_READ_BYTES) : raw;
    let data: unknown;
    try {
      data = JSON.parse(body);
    } catch {
      /* not json — the agent gets `body` */
    }
    return { ok: res.ok, status: res.status, bytes: raw.length, truncated, body: data ? undefined : body, data };
  } catch (e) {
    return { ok: false, detail: String((e as Error)?.message ?? e) };
  }
}

// ── LinkedIn ─────────────────────────────────────────────────────────────────────────────────────
//
// Every LinkedIn capability is reached through THIS switch, and that is the whole design.
//
// It used to be one function that sent a DM whatever `capability` said, so a sequencer step named
// `send_invite` either sent a message or (in the sequencer's own dispatcher) was parked as
// "unsupported" — which is why a campaign could never get past its first step. The wrappers in
// linkedin/connect.ts already did the careful work: vaulted session, store-backed pacing at the
// door, the proxy underneath, `noteLinkedInTouch` with the CAPABILITY ID on success, and a
// best-effort graph write. None of it was reachable.
//
// Routing them here rather than inventing a second outbound path means each one inherits what this
// file IS: the far side of the human approval gate. `send_invite` — the single most
// restriction-prone action LinkedIn offers — arrives at the same door `send_message` does, and
// there is deliberately no branch that skips it.
type LinkedInExecutor = (conn: Connection, payload: Record<string, unknown>) => Promise<LiActionResult>;

/** A trimmed string, or undefined. Payload fields arrive from an agent or from a case blob. */
const str = (v: unknown): string | undefined => {
  const s = typeof v === "string" ? v.trim() : v === undefined || v === null ? "" : String(v).trim();
  return s || undefined;
};

/**
 * The engagement these rows belong to, when the caller had one.
 *
 * Passed through to the graph writers so a person found while advancing a case is filed against
 * that case. It cannot widen anything: the TENANT always comes off the connection (see `scopeOf`
 * in connect.ts), never from here.
 */
const caseOf = (payload: Record<string, unknown>): string | undefined => str(payload.case_id);

const LINKEDIN_EXECUTORS: Record<string, LinkedInExecutor> = {
  /**
   * Two doors, and which one opens is decided by whether a conversation already exists.
   *
   * `capabilities.ts` has always documented this action as taking "a conversation urn, or
   * profile_id to start one", and only the first half was implemented. The consequence was not a
   * bad error message: after an invitation is accepted there is no conversation yet, so the FIRST
   * DM of every sequence — the message the whole campaign is for — was refused for want of an urn
   * that nothing in the loop could produce. It parked, and parked again, indefinitely.
   *
   * `to` means the person, not the thread, matching `send_invite` below. It used to be read as a
   * third alias for `thread`, which no caller ever used and which reads backwards next to every
   * other executor in this table.
   */
  async send_message(conn, payload) {
    const text = str(payload.body ?? payload.text ?? payload.message);
    if (!text) return { ok: false, detail: "linkedin send needs `body` text" };

    const thread = str(payload.thread ?? payload.thread_id);
    if (thread) {
      const res = await sendLinkedInMessage(conn, thread, text);
      return {
        ok: res.ok,
        detail: res.detail ?? (res.ok ? "sent" : "send failed"),
        // The urn goes back on every send, not just the first, so a caller persisting it from the
        // result never has to know which of the two doors it went through.
        data: { ...(res.message_id ? { message_id: res.message_id } : {}), thread },
      };
    }

    const profileId = str(payload.profile_id ?? payload.to ?? payload.public_id);
    if (!profileId) {
      return { ok: false, detail: "linkedin send needs a `thread` (conversation urn) or a `profile_id` to start one" };
    }
    const res = await sendLinkedInFirstMessage(conn, profileId, text);
    return {
      ok: res.ok,
      detail: res.detail ?? (res.ok ? "sent" : "send failed"),
      data: {
        ...(res.message_id ? { message_id: res.message_id } : {}),
        ...(res.thread ? { thread: res.thread } : {}),
      },
    };
  },

  async send_invite(conn, payload) {
    const profileId = str(payload.profile_id ?? payload.to ?? payload.public_id);
    if (!profileId) return { ok: false, detail: "an invitation needs a `profile_id` (public identifier or urn)" };
    // The note is whatever the caller approved and NOTHING is substituted for it: an invitation with
    // an improvised note performs worse than one with no note, and the founder's name is on it.
    return sendLinkedInInvite(conn, profileId, str(payload.note ?? payload.body ?? payload.text), caseOf(payload));
  },

  async withdraw_invite(conn, payload) {
    const invitationId = str(payload.invitation_id ?? payload.invitation);
    if (!invitationId) return { ok: false, detail: "withdrawing needs the `invitation_id` LinkedIn minted" };
    return withdrawLinkedInInvite(conn, invitationId, str(payload.shared_secret));
  },

  // Warm-up engagement — reachable by an EXPLICIT action only, and inert unless MYCEL_LINKEDIN_WARMUP=1.
  // These are deliberately NOT added to any auto-running sequence (SEQUENCE_LIVE stays view/invite/
  // message/email); they live here so a human can fire one by hand once the endpoints are verified.
  async react_to_post(conn, payload) {
    const postUrn = str(payload.post_urn ?? payload.post ?? payload.activity_urn);
    if (!postUrn) return { ok: false, detail: "a reaction needs a `post_urn`" };
    const reaction = str(payload.reaction) ?? "like";
    return reactToLinkedInPost(conn, postUrn, reaction);
  },

  async follow_person(conn, payload) {
    const memberUrn = str(payload.profile_id ?? payload.member ?? payload.urn ?? payload.public_id);
    if (!memberUrn) return { ok: false, detail: "a follow needs a member `profile_id` (urn)" };
    return followLinkedInPerson(conn, memberUrn);
  },

  async view_profile(conn, payload) {
    const profileId = str(payload.profile_id ?? payload.public_id);
    if (!profileId) return { ok: false, detail: "a profile view needs a `profile_id`" };
    return viewLinkedInProfile(conn, profileId, caseOf(payload));
  },

  async get_profile(conn, payload) {
    const profileId = str(payload.profile_id ?? payload.public_id);
    if (!profileId) return { ok: false, detail: "a profile read needs a `profile_id`" };
    return getLinkedInProfile(conn, profileId, caseOf(payload));
  },

  async get_company(conn, payload) {
    const slug = str(payload.company ?? payload.slug ?? payload.universal_name);
    if (!slug) return { ok: false, detail: "a company read needs a `company` slug" };
    return getLinkedInCompany(conn, slug);
  },

  async search_people(conn, payload) {
    const limit = Number(payload.limit);
    const start = Number(payload.start);
    return searchLinkedInPeople(
      conn,
      {
        query: str(payload.query ?? payload.keywords),
        title: str(payload.title),
        company: str(payload.company),
        location: str(payload.location),
        limit: Number.isFinite(limit) ? limit : undefined,
        start: Number.isFinite(start) ? start : undefined,
      },
      caseOf(payload),
    );
  },

  async company_people(conn, payload) {
    const limit = Number(payload.limit);
    const start = Number(payload.start);
    return discoverCompanyPeople(
      conn,
      {
        company: str(payload.company ?? payload.slug ?? payload.universal_name),
        company_id: str(payload.company_id ?? payload.organization_id),
        limit: Number.isFinite(limit) ? limit : undefined,
        start: Number.isFinite(start) ? start : undefined,
      },
      caseOf(payload),
    );
  },
};

/**
 * Is there a real executor behind this capability yet?
 *
 * Asked by the sequencer's dispatcher so a step whose capability has no executor is reported as a
 * GAP rather than silently skipped — skipping an invitation and then messaging a stranger who never
 * accepted is worse than doing nothing and saying so. One list, read by both, so the two cannot
 * disagree about what is wired.
 */
export const hasLinkedInExecutor = (capability: string): boolean =>
  Object.prototype.hasOwnProperty.call(LINKEDIN_EXECUTORS, capability);

async function runLinkedIn(
  conn: Connection,
  capability: string,
  payload: Record<string, unknown>,
): Promise<ActionResult> {
  const run = LINKEDIN_EXECUTORS[capability];
  if (!run) {
    // Named rather than defaulted to "send a DM", which is what this used to do. A capability the
    // agent invented, or one declared in capabilities.ts but not yet built, must not be able to
    // reach a stranger's inbox by accident.
    return {
      ok: false,
      detail:
        `"${capability}" has no LinkedIn executor — declared capabilities without one are listed in ` +
        "linkedin/capabilities.ts and are not reachable until they are wired here",
    };
  }
  const res = await run(conn, payload);
  return { ok: res.ok, detail: res.detail, data: res.data, code: res.code };
}

/**
 * Perform a real-world action through a connection — the ONE door every send goes through.
 *
 * ═══ WHY THE PLATFORM GUARD IS IN HERE AND NOT IN THE CALLER ═══
 *
 * It used to be in the caller, and had exactly one: the agent action proxy in server.ts. The
 * sequencer (`gtm/sequence.ts`) and the approved-reply path (`gtm/reply.ts`) call this function
 * directly — so `guardSend` never ran on the two paths that produce essentially all of the outbound
 * volume, and `cold_initiate_requires_approval` (LinkedIn cold opens) was skipped on precisely the
 * automated sends it exists to force a human onto. A guard whose enforcement depends on which
 * caller you came through is a convention; a guard inside the executor is a fact.
 *
 * The proxy still guards BEFORE its approval gate, and that is not redundancy to be tidied away:
 * refusing there saves parking a doomed send in a founder's approval queue, and the proxy is the
 * only caller that can act on `force_approval`. `guardSend` is pure, so running it twice costs
 * nothing and the two cannot disagree — they read the same payload through `outboundFromPayload`.
 *
 * ═══ WHAT `ctx` IS FOR ═══
 *
 * Reply windows (WhatsApp's 24h) are measured from the customer's last inbound, which only the
 * caller can look up. Omitting it FAILS CLOSED for windowed platforms, which is the safe direction:
 * every caller that exists today either sends on a platform with no window (LinkedIn, email) or,
 * like the proxy, reads the thread and passes it.
 */
export async function executeAction(
  conn: Connection,
  capability: string,
  payload: Record<string, unknown>,
  ctx?: SendContext,
): Promise<ActionResult> {
  const cap = capabilitiesForConnection(conn);
  if (isMessagingSend(cap, capability)) {
    const verdict = guardSend(cap, outboundFromPayload(payload, ctx?.thread), ctx);
    if (!verdict.allow) {
      // A named code, not a generic failure: the sequencer parks a step on `cannot_initiate`
      // differently from how it retries a transport error.
      return { ok: false, code: verdict.code, detail: verdict.reason };
    }
    if (verdict.force_approval && !ctx?.approved) {
      // The platform insists a human signs off on a cold open, and no caller has said one did.
      // Refusing here is what makes the rule unbypassable: it used to be checked only in the action
      // proxy, so every send the SEQUENCER made skipped it.
      return {
        ok: false,
        code: "approval_required",
        detail: `${cap.platform} cold outreach requires a human to sign off, and nothing on this send records that one did.`,
      };
    }
  }
  const secret = await resolveSecret(conn.secret_ref, conn.id);
  try {
    switch (conn.kind as ConnectionKind) {
      case "email":
        return await sendEmail(conn, payload, secret);
      case "agentmail":
        return await sendAgentMail(conn, payload);
      case "webhook":
      case "custom":
        return await postWebhook(conn, payload, secret);
      case "composio":
        return await runComposioTool(conn, capability, payload);
      case "linkedin":
        return await runLinkedIn(conn, capability, payload);
      default:
        // Anything else is a config mistake, and saying so beats a stub that pretends to work.
        // Stripe, SMS, WhatsApp and calendars all live behind `composio` now.
        return {
          ok: false,
          detail: `no executor for connection kind "${conn.kind}" — use kind "composio" with the matching toolkit`,
        };
    }
  } catch (e) {
    return { ok: false, detail: String((e as Error)?.message ?? e) };
  }
}

// Generic email-over-HTTP (Postmark/SendGrid/Resend-style): POST to config.api_url with the
// secret as a bearer token. Configure api_url + from on the connection.
//
// ═══ WHERE DOES A REPLY GO? ═══
//
// It used to go nowhere, and that matters more for a dunning email than for anything else this
// kernel sends. `from` is a connection-level address like `billing@yourdomain.com` — usually a
// send-only transactional identity nobody reads — and no `Reply-To` header was set at all. So the
// end-to-end story behind the founder's question ran: we mail a client demanding money, the client
// replies "I paid this on the 3rd, here is the reference", that reply lands in an unmonitored
// mailbox or bounces, and three days later the ladder escalates. Silence read as non-payment when
// the client had in fact answered us. That is the same reputational failure as chasing a paid
// invoice, reached from the other direction.
//
// `config.reply_to` is the fix available at THIS layer, and it is honest about its limit: it routes
// the reply to a mailbox a human reads. It does NOT make the reply visible to the kernel. The
// guarantee an `email` connection can give is "a human sees the reply", not "the agent sees it".
//
// ═══ WHAT CHANGED, AND WHAT DELIBERATELY DID NOT ═══
//
// The paragraph above used to end "neither is wired for the dunning path today". One of them now is:
// the `agentmail` kind below sends from an inbox that can receive, and `POST /v1/agentmail/webhook`
// verifies a Svix signature and lands the reply on the same intake pipeline a form uses — so the
// client's "I paid on the 3rd" becomes an inbound Message on the Thread that chase opened, and stands
// the ladder down. See agentmail.ts. A connection of kind `email` is unchanged and still deaf; that
// is a reason to move a business onto `agentmail`, not a reason to pretend `email` can hear.
//
// What did NOT change: `payments.ts` still decides staleness from a poll it controls, and nothing in
// the reconciler consults inbound. Read the `paymentConfidence` argument before touching that. An
// inbound is a message from the DEBTOR — evidence that a human should look, never evidence the money
// arrived — and a ladder that treated "they said they paid" as payment would be trivially talked out
// of chasing. Inbound suppresses; only the poll, or a human, settles.
//
// Set from the CONNECTION, never from the payload, exactly like `from`. An agent that could choose
// its own Reply-To could route a client's answer away from the business.
async function sendEmail(
  conn: Connection,
  payload: Record<string, unknown>,
  secret?: string,
): Promise<ActionResult> {
  const apiUrl = String(conn.config.api_url ?? "");
  if (!apiUrl) return { ok: false, detail: "email connection missing config.api_url" };
  const replyTo = typeof conn.config.reply_to === "string" ? conn.config.reply_to.trim() : "";
  const res = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(secret ? { authorization: `Bearer ${secret}` } : {}),
    },
    body: JSON.stringify({
      from: conn.config.from,
      to: payload.to,
      subject: payload.subject ?? "",
      text: payload.body ?? payload.text ?? "",
      html: payload.html,
      // Both spellings, because this one body is posted to whichever provider the founder configured
      // and they disagree: Postmark reads `ReplyTo`, Resend and SendGrid read `reply_to`. Sending
      // both is harmless (each ignores the other's key) and is the only way one generic shape can
      // actually set the header on all three.
      //
      // Omitted ENTIRELY when unset rather than sent as null or "": Postmark rejects a present-but-
      // empty ReplyTo, which would turn a missing line of config into a failed dunning send.
      ...(replyTo ? { reply_to: replyTo, ReplyTo: replyTo } : {}),
    }),
  });
  return { ok: res.ok, detail: `HTTP ${res.status}`, data: await safeJson(res) };
}

/**
 * Send from the tenant's own AgentMail inbox.
 *
 * ═══ WHY THE RECIPIENT IS THE ONLY THING THE PAYLOAD CHOOSES ═══
 *
 * `inbox_id` comes from the connection, never the payload — the same rule as `from` and `reply_to`
 * above, and here it is load-bearing for tenancy rather than merely for etiquette. The inbox IS the
 * sending identity and it is also the routing key the inbound webhook resolves a project from. An
 * agent that could name its own inbox could send a chase from another business's address, and every
 * reply to it would then be attributed to that business. The action-grant check upstream already
 * restricts which connections a run may touch; this keeps the payload from reaching around it.
 *
 * ═══ THE RETURNED THREAD ID IS NOT DECORATION ═══
 *
 * `data.thread_id` is what makes a reply attachable. The action proxy in server.ts writes it into a
 * project-scoped link row against this run's thread, case and invoice, and the inbound webhook joins
 * on it. Without it the reply still arrives, but on the client's general thread with no engagement —
 * it lands, and it does not stop the ladder. So this executor returns `data` rather than swallowing
 * it, and the proxy treats a missing `thread_id` as a warning worth logging.
 */
async function sendAgentMail(conn: Connection, payload: Record<string, unknown>): Promise<ActionResult> {
  const cfg = agentMailConfig();
  // Absent, not broken: a deployment with no AgentMail key must say so in one sentence a founder can
  // act on, rather than throw or — far worse — report a send that never happened.
  if (!cfg) {
    return { ok: false, detail: "AgentMail is not configured on this deployment (AGENTMAIL_API_KEY is unset)" };
  }
  const inboxId = inboxIdFor(conn);
  if (!inboxId) return { ok: false, detail: `connection "${conn.name}" has no config.inbox_id, so it has no mailbox to send from` };

  const to = Array.isArray(payload.to)
    ? payload.to.filter((v): v is string => typeof v === "string" && !!v.trim())
    : typeof payload.to === "string" && payload.to.trim()
      ? [payload.to.trim()]
      : [];
  if (!to.length) return { ok: false, detail: "no recipient" };

  const text = typeof payload.body === "string" ? payload.body : typeof payload.text === "string" ? payload.text : "";
  const res = await sendAgentMailMessage(cfg, inboxId, {
    to,
    subject: typeof payload.subject === "string" ? payload.subject : "",
    text,
    ...(typeof payload.html === "string" ? { html: payload.html } : {}),
    // So a human in the AgentMail console can tell an agent's send from one they typed themselves.
    labels: ["mycel"],
  });
  return {
    ok: res.ok,
    detail: res.detail,
    ...(res.data ? { data: res.data as unknown as Record<string, unknown> } : {}),
  };
}

async function postWebhook(
  conn: Connection,
  payload: Record<string, unknown>,
  secret?: string,
): Promise<ActionResult> {
  // The host comes from the CONNECTION, never from the payload.
  //
  // This used to be `payload.url ?? conn.config.url`, so an agent-supplied url won outright — and
  // since the connection's secret is attached below as a bearer token, that was a way to post the
  // credential itself to any host the agent named. Reads have always been guarded this way
  // (`safeReadPath`); writes were not, which is the wrong asymmetry: the gated half of the trust
  // boundary was the loose one.
  //
  // The agent may still choose a path within the connection's host, which is what a webhook
  // connection legitimately needs.
  const base = String(conn.config.url ?? conn.config.api_url ?? "");
  if (!base) return { ok: false, detail: "webhook connection missing config.url" };
  const suffix = payload.path ?? payload.url;
  const rel = suffix === undefined ? "" : safeReadPath(suffix);
  if (rel === null) {
    return { ok: false, detail: "path must stay within the connection's host (no absolute url, no traversal)" };
  }
  const url = rel ? `${base.replace(/\/+$/, "")}/${rel}` : base;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(secret ? { authorization: `Bearer ${secret}` } : {}),
    },
    body: JSON.stringify(payload.body ?? payload),
  });
  return { ok: res.ok, detail: `HTTP ${res.status}`, data: await safeJson(res) };
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

/**
 * Execute a Composio tool. The capability IS the tool slug.
 *
 * Note what the agent does not get to choose: the API key (harness-held), the Composio user
 * (derived from the connection owner) and the connected account (from the connection's config). It
 * chooses the tool and its arguments, and a human still approves. Same shape as every other action —
 * Composio widens what the business can reach without widening what the sandbox can hold.
 */
async function runComposioTool(
  conn: Connection,
  capability: string,
  payload: Record<string, unknown>,
): Promise<ActionResult> {
  const cfg = composioConfig();
  if (!cfg) return { ok: false, detail: "COMPOSIO_API_KEY is not set on the harness" };
  const cc = composioConnConfig(conn);
  if (!cc.connected_account_id) {
    return { ok: false, detail: `connection "${conn.name}" is not connected yet — authorise ${cc.toolkit || "the toolkit"} first` };
  }
  const args = (payload.arguments ?? payload.body ?? {}) as Record<string, unknown>;
  try {
    const r = await executeTool(cfg, {
      slug: capability,
      userId: composioUserId(conn),
      connectedAccountId: cc.connected_account_id,
      arguments: args,
    });
    return { ok: r.successful, detail: r.error ?? (r.successful ? "ok" : "tool reported failure"), data: r.data };
  } catch (e) {
    // A Composio error message can quote request context, so pass through the message only — never
    // headers, and never the key.
    return { ok: false, detail: `composio: ${(e as Error).message}` };
  }
}
