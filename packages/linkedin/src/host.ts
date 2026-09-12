// The seams between the LinkedIn core and whatever hosts it.
//
// This package knows how to talk to Voyager — sessions, proxies, request shapes, parsers, the
// bandwidth meter. It deliberately does NOT know where secrets live, what a pacing budget is, how
// connections are persisted, or what a CRM does with an accepted invitation. A host (the Mycel
// kernel, the standalone growth app, a test) supplies those through `setLinkedInHost` before the
// orchestration functions in connect.ts / graph.ts run. The pure modules (voyager, search, people,
// profile, invites, meter, tier, proxy, …) never touch the host and work without one.
//
// The semantics stay with the host on purpose: pacing budgets, windows and multipliers are policy,
// and policy differs between a multi-tenant kernel and a single-founder tool. The package only
// promises to ASK before every touch and to REPORT every touch and engagement signal it observes.

import type { LiInbound } from "./voyager";

// ── Shared vocabulary ─────────────────────────────────────────────────────────────────────────────

/** What an outbound action costs. The unit pacing budgets are denominated in. */
export type TouchKind = "invite" | "message" | "inmail" | "profile_view" | "follow";

/** LinkedIn account tier, as detected from /me (see tier.ts). Pacing ceilings depend on it. */
export type AccountTier = "free" | "premium" | "sales_navigator" | "recruiter";

/** The answer to "may this account spend this touch right now?". `reason` is founder-facing copy. */
export interface PacingVerdict {
  allowed: boolean;
  reason?: string;
}

/** Engagement signals the core observes and reports back so the host can tune its budgets. */
export interface EngagementDelta {
  sent?: number;
  accepted?: number;
  replied?: number;
  flagged?: number;
}

// ── The injected interfaces ───────────────────────────────────────────────────────────────────────

/** Where sessions and proxy urls live. Keys are connection ids (and `${id}:proxy`). */
export interface SecretStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * The pacing engine. The host owns the semantics (budgets, ramps, windows, multipliers); the core
 * owns the discipline of consulting it before every touch and reporting what actually happened.
 */
export interface Pacing {
  assertSendAllowed(connectionId: string, kind: TouchKind): Promise<PacingVerdict>;
  recordTouch(connectionId: string, kind: TouchKind): Promise<void>;
  recordEngagement(connectionId: string, delta: EngagementDelta): Promise<void>;
}

/** The connection owner — mirrors the kernel contract's shape without importing it. */
export interface LinkedInConnectionOwner {
  kind: "founder" | "client";
  id: string;
}

/**
 * The slice of a Connection this package needs. The kernel's `Connection` satisfies it
 * structurally; a standalone host can persist exactly this and nothing more.
 */
export interface LinkedInConnection {
  id: string;
  project_id?: string;
  kind: string;
  name: string;
  owner: LinkedInConnectionOwner;
  /** Non-secret settings (redacted proxy, tier, sync token, challenge flag, …). */
  config: Record<string, unknown>;
  secret_ref?: string;
  created_at?: string;
}

/** Persistence for LinkedIn connections. */
export interface ConnectionStore {
  createConnection(input: {
    project_id?: string;
    kind: "linkedin";
    name: string;
    owner: LinkedInConnectionOwner;
    config: Record<string, unknown>;
  }): Promise<LinkedInConnection>;
  getConnection(id: string): Promise<LinkedInConnection | null | undefined>;
  updateConnection(
    id: string,
    patch: { name?: string; config?: Record<string, unknown> },
  ): Promise<unknown>;
  deleteConnection(id: string): Promise<unknown>;
}

/** Where graph.ts writes what LinkedIn reads taught it. The kernel's DomainStore satisfies this. */
export interface RecordStore {
  upsertRecord(r: {
    project_id?: string;
    wedge: string;
    collection: string;
    key: string;
    data: Record<string, unknown>;
    case_id?: string;
  }): Promise<unknown>;
}

/** The tenant scope inbound bookkeeping is keyed on. `project_id` is required by every sink. */
export interface TenantRef {
  id: string;
  project_id: string;
}

export interface AcceptanceResult {
  /** Cases that moved `invited` → `connected` in this call. The engagement delta, deduped. */
  accepted: number;
  case_ids: string[];
  /** How many cases were still waiting — context for "nothing happened". */
  pending: number;
}

/**
 * What the host does with what a sync observed: replies from people we contacted, strangers who
 * wrote first, invitations that were accepted. All bookkeeping — none of it may fail a sync.
 */
export interface InboundSink {
  /** Returns how many people we contacted have NOW answered for the first time. */
  noteInboundReplies(conn: TenantRef, inbound: LiInbound[]): Promise<number>;
  /** Capture inbound from people we never contacted. Returns how many new cases were opened. */
  captureUnsolicitedInbound(conn: TenantRef, inbound: LiInbound[]): Promise<number>;
  /** Reconcile the observed connections list against pending invitations. */
  noteAcceptedInvitations(conn: TenantRef, observed: { connected: string[] }): Promise<AcceptanceResult>;
}

// ── The host ──────────────────────────────────────────────────────────────────────────────────────

export interface LinkedInHost {
  secrets: SecretStore;
  pacing: Pacing;
  connections: ConnectionStore;
  records: RecordStore;
  inbound: InboundSink;
  /** The wedge stamped on graph rows. Defaults to "outreach" when absent. */
  wedge?: () => string;
  /**
   * Opaque value handed as the FIRST argument to a pacing check injected via `_setPacing`
   * (connect.ts). The kernel passes its DomainStore so existing test doubles keep their shape.
   */
  pacingContext?: () => unknown;
  /**
   * ═══ IS THIS ROW A LEAD? — the host's call, not this package's ═══
   *
   * A discovery sweep files whatever it finds, and what it finds includes rows that are not people:
   * a founder's pipeline showed "Agora Software", "Altena-Software", "International Software
   * Company" and "Dlubal Software FR" between real prospects — the company's own name in the
   * person's name field, no face, nothing to send to.
   *
   * The judgement lives with the HOST rather than here for two reasons. This package's job is to
   * read LinkedIn faithfully, and "faithfully" includes rows a product might not want; and the rule
   * itself is shared with the outbound engine's own sourcing (`@mycel/sourcing/lead-quality`),
   * which this package does not and should not depend on — no `packages/*` imports another.
   *
   * Absent, everything is kept, which is what this package did before the seam existed.
   */
  judgeLead?: (lead: {
    name?: string;
    company?: string;
    company_domain?: string;
    linkedin_url?: string;
    headline?: string;
    title?: string;
  }) => { keep: boolean; reason?: string };
}

let host: LinkedInHost | null = null;

/** Wire the package to its host. Call once, before any connect/graph orchestration runs. */
export function setLinkedInHost(h: LinkedInHost): void {
  host = h;
}

export { bindJarPersist, setSessionRotatedHandler } from "./voyager";

export function getLinkedInHost(): LinkedInHost {
  if (!host) {
    throw new Error(
      "@mycel/linkedin is not wired to a host — call setLinkedInHost({ secrets, pacing, connections, records, inbound }) first",
    );
  }
  return host;
}

/** The wedge graph rows are stamped with. Host-provided, "outreach" when the host does not say. */
export function linkedInWedge(): string {
  return host?.wedge?.() ?? "outreach";
}
