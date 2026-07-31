// Identity & tenancy (v1 foundation). Two auth planes:
//   - Product API keys (machine): a key resolves to a Project (which owns wedges). Server-to-server.
//   - Member sessions (human): a Member logs in and gets a session token the portal forwards.
//     A member sees every Project in their Org.
//
// v1 bootstraps a single default Org + Project + owner Member, so there is exactly one tenant and
// therefore no cross-tenant surface to get wrong. The model is in place; per-project scoping of
// data lands when a second project actually exists. In-memory (note: pg backing next, like domain).
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { loadConfig, databaseUrl } from "./config";

/** A stable, deterministic UUID from a name (UUIDv5-style). The default org/project/owner use
 *  these so their ids survive a restart — otherwise durable rows would be scoped to a dead
 *  project id after every boot. */
function stableUuid(name: string): string {
  const h = createHash("sha1").update(`mycel:${name}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export type Role = "owner" | "admin" | "operator" | "viewer";

/**
 * Plans and limits.
 *
 * The kernel knows what a plan ALLOWS. It does not know what a plan costs, who took the payment, or
 * that Stripe exists — that lives in the commercial control plane, which calls `PUT /v1/org/plan`
 * with a product key. Two reasons. Anyone running the kernel themselves should never meet a
 * paywall, which is why `self_hosted` is the default and its limits are all null. And a billing
 * provider in the open core would be a commercial dependency in an Apache-2.0 licence.
 */
export type Plan = "self_hosted" | "free" | "starter" | "growth" | "scale";

/** `null` means unmetered. Not zero, not Infinity — a number nobody has to remember the meaning of. */
export interface Limits {
  seats: number | null;
  projects: number | null;
  tasks_per_month: number | null;
}

export const PLAN_LIMITS: Record<Plan, Limits> = {
  self_hosted: { seats: null, projects: null, tasks_per_month: null },
  free: { seats: 1, projects: 1, tasks_per_month: 100 },
  starter: { seats: 3, projects: 2, tasks_per_month: 2_000 },
  growth: { seats: 10, projects: 10, tasks_per_month: 20_000 },
  scale: { seats: null, projects: null, tasks_per_month: null },
};

/**
 * What happens when a subscription lapses.
 *
 * `past_due` deliberately does NOT stop the business. A bookkeeping service that silently stops
 * answering its customers because a card expired does far more damage to the founder than the
 * unpaid invoice does to us; the product nags instead. `cancelled` drops to free limits, which
 * keeps the data readable and the work stopped.
 */
export type PlanStatus = "active" | "trialing" | "past_due" | "cancelled";

export interface Org {
  id: string;
  name: string;
  created_at: string;
  plan?: Plan;
  plan_status?: PlanStatus;
  /** The billing provider's customer id. Opaque here — stored, echoed, never interpreted. */
  billing_ref?: string;
  /** When the current period ends, for the UI to render. Set by the control plane. */
  plan_renews_at?: string;
}
export interface Project {
  id: string;
  org_id: string;
  name: string;
  /** Wedge slugs this project may run. Empty = all wedges on disk. */
  wedges: string[];
  created_at: string;
  /**
   * The subdomain this business's client portal answers on: `acme` → acme.mycelai.dev.
   *
   * Allocated at creation from the project name, and stable afterwards — it ends up in emails sent
   * to a founder's customers, and a link that stops working because someone renamed a project is
   * worse than an ugly slug.
   */
  slug?: string;
  /** A domain the founder owns, once they have proved they own it. */
  custom_domain?: string;
  /**
   * The TXT value that proves it. Present from the moment a custom domain is claimed until it
   * verifies; the domain does not serve traffic until `custom_domain_verified_at` is set.
   */
  domain_verify_token?: string;
  custom_domain_verified_at?: string;
  /** What a customer sees. The business app renders from this — it is the founder's brand, not ours. */
  branding?: { display_name?: string; accent?: string; support_email?: string };
}
export type AuthProvider = "password" | "google" | "github";

export interface Member {
  id: string;
  org_id: string;
  email: string;
  role: Role;
  created_at: string;
  /**
   * How they signed in last. Shown on the sign-in screen so someone who used Google three months ago
   * isn't left guessing which of five buttons was theirs — the single biggest cause of accidental
   * duplicate accounts.
   */
  last_provider?: AuthProvider;
  /** Providers this member has ever used. An account reached by two routes is still one account. */
  providers?: AuthProvider[];
}
interface StoredMember extends Member {
  /** Empty for accounts that have only ever used OAuth — there is no password to verify. */
  salt: string;
  hash: string;
  /** Single-use password reset. Hashed, because a leaked database shouldn't hand out logins. */
  reset_hash?: string;
  reset_expires?: number;
}
export interface Session {
  token: string;
  member_id: string;
  org_id: string;
  expires_at: number;
}

/**
 * An outstanding invitation to join an org.
 *
 * Only the token's hash is stored, exactly as for password resets: an invite link is a credential
 * that creates an account with a role, so a stolen database must not hand out working ones.
 */
export interface Invite {
  id: string;
  org_id: string;
  email: string;
  role: Role;
  /** The member who sent it. Shown in the UI so "who let this person in" has an answer. */
  invited_by: string;
  created_at: string;
  expires_at: number;
  accepted_at?: string;
}
interface StoredInvite extends Invite {
  token_hash: string;
}

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Roles that may change who else is in the org. Deliberately short. */
const CAN_MANAGE_MEMBERS: Role[] = ["owner", "admin"];
export const canManageMembers = (role?: Role | string): boolean =>
  CAN_MANAGE_MEMBERS.includes(role as Role);

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function hashPassword(pw: string): { salt: string; hash: string } {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(pw, salt, 64).toString("hex");
  return { salt, hash };
}
function verifyPassword(pw: string, salt: string, hash: string): boolean {
  const got = scryptSync(pw, salt, 64);
  const want = Buffer.from(hash, "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}

export interface AuthScope {
  kind: "key" | "member";
  org_id: string;
  project_id?: string; // set for key auth
  member_id?: string; // set for member auth
  role?: Role;
}

class IdentityStore {
  private orgs = new Map<string, Org>();
  private projects = new Map<string, Project>();
  private members = new Map<string, StoredMember>();
  private apiKeys = new Map<string, { project_id: string; org_id: string }>();
  private sessions = new Map<string, Session>();

  /** Set when a durable backend is attached; writes are mirrored to it. */
  private pg: import("./identity.pg").IdentityPg | null = null;

  constructor() {
    // Bootstrap the default tenant with STABLE ids (see stableUuid) so durable data written in a
    // previous run still resolves to this project. MYCEL_API_KEY is the default project's key.
    const now = new Date().toISOString();
    const org: Org = { id: stableUuid("default-org"), name: "default", created_at: now };
    this.orgs.set(org.id, org);
    const project: Project = {
      id: stableUuid("default-project"), org_id: org.id, name: "default", wedges: [], created_at: now,
      slug: "default",
    };
    this.projects.set(project.id, project);
    this.indexProject(project);
    this.apiKeys.set(loadConfig().apiKey, { project_id: project.id, org_id: org.id });

    // Owner member: from env, or generated + printed (never a blank/known password).
    const email = process.env.MYCEL_OWNER_EMAIL ?? "founder@mycel.local";
    const pw = process.env.MYCEL_OWNER_PASSWORD ?? `own_${randomBytes(9).toString("base64url")}`;
    this.generatedPassword = process.env.MYCEL_OWNER_PASSWORD ? undefined : pw;
    this.ownerEmail = email;
    const { salt, hash } = hashPassword(pw);
    const member: StoredMember = {
      id: stableUuid(`owner:${email.toLowerCase()}`),
      org_id: org.id,
      email: email.toLowerCase(),
      role: "owner",
      created_at: now,
      salt,
      hash,
    };
    this.members.set(member.id, member);
  }

  /** Attach a durable backend: load persisted tenants into the read cache, then mirror writes. */
  async attach(pg: import("./identity.pg").IdentityPg): Promise<void> {
    this.pg = pg;
    const { orgs, projects, members, apiKeys, invites } = await pg.loadAll();
    for (const o of orgs) this.orgs.set(o.id, o);
    for (const p of projects) {
      this.projects.set(p.id, p);
      this.indexProject(p);
    }
    for (const m of members) this.members.set(m.id, m);
    for (const [k, v] of apiKeys) this.apiKeys.set(k, v);
    // Invites outlive a restart deliberately: a link emailed on Friday must still work on Monday.
    for (const i of invites) this.invites.set(i.id, i);
    // persist the bootstrap tenant (idempotent — stable ids)
    for (const o of this.orgs.values()) await pg.upsertOrg(o);
    for (const p of this.projects.values()) await pg.upsertProject(p);
    for (const m of this.members.values()) await pg.upsertMember(m);
    for (const [k, v] of this.apiKeys) await pg.upsertApiKey(k, v);
  }

  readonly ownerEmail: string;
  readonly generatedPassword?: string;

  resolveApiKey(key: string): AuthScope | undefined {
    const m = this.apiKeys.get(key);
    return m ? { kind: "key", org_id: m.org_id, project_id: m.project_id } : undefined;
  }

  findMemberByEmail(email: string): StoredMember | undefined {
    const wanted = email.trim().toLowerCase();
    return [...this.members.values()].find((m) => m.email === wanted);
  }

  private issue(member: StoredMember, provider: AuthProvider) {
    member.last_provider = provider;
    member.providers = [...new Set([...(member.providers ?? []), provider])];
    const session: Session = {
      token: `msess_${randomBytes(24).toString("base64url")}`,
      member_id: member.id,
      org_id: member.org_id,
      expires_at: Date.now() + SESSION_TTL_MS,
    };
    this.sessions.set(session.token, session);
    if (this.pg) void this.pg.upsertMember(member).catch(() => {});
    return { session, member: this.publicMember(member), projects: this.listProjects(member.org_id) };
  }

  login(email: string, pw: string): { session: Session; member: Member; projects: Project[] } | undefined {
    const member = this.findMemberByEmail(email);
    // `!member.hash` means an OAuth-only account. Rejecting here rather than letting an empty
    // password verify against an empty hash is the difference between a guard and a hole.
    if (!member || !member.hash || !verifyPassword(pw, member.salt, member.hash)) return undefined;
    return this.issue(member, "password");
  }

  /**
   * Sign in (or up) someone whose identity a provider has already verified.
   *
   * The kernel never runs the OAuth dance itself — the product does, because that's where the
   * redirect URIs and provider secrets live, and Auth.js already handles the provider zoo. The
   * product then ASSERTS the verified email here, server-to-server with its API key.
   *
   * Which makes the caller's authentication the whole security boundary: this endpoint must never be
   * reachable from a browser, or anyone could claim any email. It is deliberately NOT in the
   * middleware's unauthenticated allowlist.
   *
   * Matching on email means an account reached by password and later by Google is still one account,
   * rather than a silent duplicate the founder can't reconcile.
   */
  federated(args: {
    email: string;
    provider: AuthProvider;
    orgName?: string;
  }): { session: Session; member: Member; projects: Project[]; created: boolean } {
    const existing = this.findMemberByEmail(args.email);
    if (existing) return { ...this.issue(existing, args.provider), created: false };
    const { org } = this.createOrgWithOwner(
      args.orgName ?? args.email.split("@")[1] ?? "my business",
      args.email,
      // No password: this account has only ever been reached through a provider. `login()` refuses
      // an empty hash, so this cannot become a password-less way in.
      "",
    );
    const member = this.findMemberByEmail(args.email)!;
    void org;
    return { ...this.issue(member, args.provider), created: true };
  }

  /** Register a brand-new org with its own owner. Returns undefined if the email is taken. */
  signup(args: {
    email: string;
    password: string;
    orgName?: string;
  }): { session: Session; member: Member; projects: Project[] } | undefined {
    if (this.findMemberByEmail(args.email)) return undefined;
    this.createOrgWithOwner(args.orgName ?? args.email.split("@")[1] ?? "my business", args.email, args.password);
    return this.issue(this.findMemberByEmail(args.email)!, "password");
  }

  /**
   * Begin a password reset. Returns the token for the product to email.
   *
   * Only the HASH is stored, so a stolen database yields no usable reset links. Returns undefined for
   * an unknown email; the caller must still respond identically either way, or the endpoint becomes
   * an account-enumeration oracle.
   */
  requestReset(email: string, ttlMs = 30 * 60_000): { token: string; email: string } | undefined {
    const member = this.findMemberByEmail(email);
    if (!member) return undefined;
    const token = `mrst_${randomBytes(24).toString("base64url")}`;
    member.reset_hash = createHash("sha256").update(token).digest("hex");
    member.reset_expires = Date.now() + ttlMs;
    if (this.pg) void this.pg.upsertMember(member).catch(() => {});
    return { token, email: member.email };
  }

  /** Complete a reset. Single-use and time-bound; consuming it also signs them in. */
  confirmReset(
    token: string,
    password: string,
  ): { session: Session; member: Member; projects: Project[] } | undefined {
    const digest = createHash("sha256").update(token).digest("hex");
    const member = [...this.members.values()].find((m) => m.reset_hash === digest);
    if (!member || !member.reset_expires || member.reset_expires < Date.now()) return undefined;
    const { salt, hash } = hashPassword(password);
    member.salt = salt;
    member.hash = hash;
    // Cleared immediately: a reset link that works twice is a reset link an attacker can reuse from
    // a mailbox they briefly saw.
    member.reset_hash = undefined;
    member.reset_expires = undefined;
    return this.issue(member, "password");
  }

  resolveSession(token: string): AuthScope | undefined {
    const s = this.sessions.get(token);
    if (!s) return undefined;
    if (Date.now() > s.expires_at) {
      this.sessions.delete(token);
      return undefined;
    }
    const member = this.members.get(s.member_id);
    return { kind: "member", org_id: s.org_id, member_id: s.member_id, role: member?.role };
  }

  getMember(id: string): Member | undefined {
    const m = this.members.get(id);
    return m ? this.publicMember(m) : undefined;
  }
  listProjects(orgId: string): Project[] {
    return [...this.projects.values()].filter((p) => p.org_id === orgId);
  }
  getProject(id: string): Project | undefined {
    return this.projects.get(id);
  }

  /** The set of project ids a scope may read. Key → its one project; member → all in its org. */
  /**
   * The projects a READ may see.
   *
   * `requested` is the `X-Mycel-Project` header. Supplying it NARROWS the result to that one
   * project; omitting it means "everything I can see", which is what a fleet-wide view wants.
   *
   * This is the single chokepoint every read route filters through, so narrowing here is what makes
   * a per-project view possible at all. Without it a member in an org with two projects gets both
   * businesses blended into one list — two clients' tasks in one timeline, with nothing marking
   * which is which.
   *
   * Fails closed: a header naming a project outside the caller's scope yields an EMPTY set, not the
   * full one. Asking for something you can't have must never widen what you get.
   */
  accessibleProjectIds(scope: AuthScope, requested?: string): Set<string> {
    const all =
      scope.kind === "key" && scope.project_id
        ? new Set([scope.project_id])
        : new Set(this.listProjects(scope.org_id).map((p) => p.id));
    if (!requested) return all;
    return all.has(requested) ? new Set([requested]) : new Set<string>();
  }

  /** The project a write lands in. Key → fixed. Member → the requested one (if in org), else the
   *  org's sole project, else undefined (the caller must then 400 asking which project). */
  resolveWriteProject(scope: AuthScope, requested?: string): string | undefined {
    if (scope.kind === "key") return scope.project_id;
    const inOrg = this.listProjects(scope.org_id);
    if (requested && inOrg.some((p) => p.id === requested)) return requested;
    if (inOrg.length === 1) return inOrg[0].id;
    return undefined;
  }

  /** A project may run a wedge if its allowlist is empty (all) or contains the slug. */
  projectAllowsWedge(projectId: string, wedge: string): boolean {
    const p = this.projects.get(projectId);
    if (!p) return false;
    return p.wedges.length === 0 || p.wedges.includes(wedge);
  }

  // ---------------------------------------------------------------------------------------------
  // Where a business answers
  //
  // One deployment serves every founder's client portal, resolved by hostname. Deliberately not a
  // container per tenant: the business app holds no data — it renders and forwards a client session,
  // and the KERNEL decides what comes back from that session, not from the hostname. So the worst a
  // host-resolution bug can do is show the wrong logo, where a container per tenant would buy that
  // same isolation at the cost of N deployments to patch on every security fix and a provisioning
  // wait at signup.
  //
  // The hazard that IS real is cookie scope: portal sessions must be scoped to the exact host, never
  // to the parent domain, or a client of one business could carry their session onto another's.
  // ---------------------------------------------------------------------------------------------

  /** Reserved because they are, or will be, ours. A founder claiming `app` would be a phishing kit. */
  private static RESERVED = new Set([
    "app", "platform", "cloud", "www", "docs", "api", "admin", "mail", "status",
    "blog", "help", "support", "static", "assets", "cdn", "auth", "login", "portal",
  ]);

  /** A hostname-safe slug: lowercase, alphanumeric and hyphens, never leading/trailing hyphen. */
  static slugify(name: string): string {
    return name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
  }

  /** Allocate a free slug near `name`, suffixing only when it has to. */
  allocateSlug(name: string): string {
    const base = IdentityStore.slugify(name) || "business";
    const taken = (s: string) => IdentityStore.RESERVED.has(s) || this.bySlug.has(s);
    if (!taken(base)) return base;
    for (let n = 2; n < 500; n++) {
      const candidate = `${base}-${n}`;
      if (!taken(candidate)) return candidate;
    }
    return `${base}-${randomBytes(3).toString("hex")}`;
  }

  /**
   * Which project serves this hostname.
   *
   * A verified custom domain wins over the subdomain, so a founder who has moved to their own
   * domain keeps working on both. An UNVERIFIED custom domain resolves to nothing — otherwise
   * claiming a domain you don't own would let you serve a portal on it the moment DNS happened to
   * point your way.
   */
  projectForHost(host: string, rootDomain: string): Project | undefined {
    const h = (host ?? "").toLowerCase().split(":")[0].replace(/\.$/, "");
    if (!h) return undefined;
    const customId = this.byDomain.get(h);
    const byCustom = customId ? this.projects.get(customId) : undefined;
    if (byCustom?.custom_domain_verified_at) return byCustom;
    const root = rootDomain.toLowerCase();
    if (!h.endsWith(`.${root}`)) return undefined;
    const sub = h.slice(0, -(root.length + 1));
    // Only one level. `a.b.mycelai.dev` must not resolve as `a` — a wildcard certificate covers one
    // label, and treating deeper names as a match would make the boundary fuzzy.
    if (!sub || sub.includes(".")) return undefined;
    const id = this.bySlug.get(sub);
    return id ? this.projects.get(id) : undefined;
  }

  /** Claim a domain the founder says they own. Returns the TXT record they must publish. */
  claimDomain(projectId: string, domain: string): { record: { name: string; value: string } } | { error: string } {
    const p = this.projects.get(projectId);
    if (!p) return { error: "no such project" };
    const d = domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.$/, "");
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) return { error: "that doesn't look like a domain" };
    const clash = [...this.projects.values()].find((x) => x.custom_domain === d && x.id !== projectId);
    if (clash) return { error: "that domain is already claimed" };
    // Re-indexed below: claiming a NEW domain must drop the old one from the routing table, or a
    // founder who moves domains keeps serving on the one they abandoned.
    if (p.custom_domain && p.custom_domain !== d) this.byDomain.delete(p.custom_domain);
    p.custom_domain = d;
    p.custom_domain_verified_at = undefined;
    this.byDomain.delete(d);
    p.domain_verify_token = `mycel-verify=${randomBytes(16).toString("hex")}`;
    if (this.pg) void this.pg.upsertProject(p).catch(() => {});
    return { record: { name: `_mycel.${d}`, value: p.domain_verify_token } };
  }

  /**
   * Record that a claim checked out. The DNS lookup itself lives in the server layer, because the
   * store has no business doing network I/O.
   */
  markDomainVerified(projectId: string): Project | undefined {
    const p = this.projects.get(projectId);
    if (!p || !p.custom_domain) return undefined;
    p.custom_domain_verified_at = new Date().toISOString();
    p.domain_verify_token = undefined;
    this.indexProject(p);
    if (this.pg) void this.pg.upsertProject(p).catch(() => {});
    return p;
  }

  /** Branding is what a customer sees, so it belongs to the founder, not to us. */
  setBranding(projectId: string, branding: Project["branding"]): Project | undefined {
    const p = this.projects.get(projectId);
    if (!p) return undefined;
    p.branding = { ...p.branding, ...branding };
    if (this.pg) void this.pg.upsertProject(p).catch(() => {});
    return p;
  }

  /** Create a project (+ its own product API key) in an org. Mirrored to the durable backend. */
  createProject(orgId: string, name: string, wedges: string[] = []): { project: Project; apiKey: string } {
    const project: Project = {
      id: randomUUID(),
      org_id: orgId,
      name,
      wedges,
      created_at: new Date().toISOString(),
      // Allocated now and never changed. It ends up in emails to a founder's customers, and a link
      // that breaks because someone renamed a project is worse than an ugly slug.
      slug: this.allocateSlug(name),
    };
    this.projects.set(project.id, project);
    this.indexProject(project);
    const apiKey = `msk_${randomBytes(24).toString("base64url")}`;
    this.apiKeys.set(apiKey, { project_id: project.id, org_id: orgId });
    if (this.pg) {
      const pg = this.pg;
      void pg.upsertProject(project).then(() => pg.upsertApiKey(apiKey, { project_id: project.id, org_id: orgId }))
        .catch((e) => console.error("[mycel] persist project error:", e));
    }
    return { project, apiKey };
  }

  /** Create a fresh org with an owner member (used to add tenants; also lets tests prove isolation). */
  createOrgWithOwner(orgName: string, email: string, password: string): { org: Org; project: Project; apiKey: string } {
    const org: Org = { id: randomUUID(), name: orgName, created_at: new Date().toISOString() };
    this.orgs.set(org.id, org);
    const { project, apiKey } = this.createProject(org.id, "default");
    // An empty password means "no password login", NOT "the password is the empty string".
    // `hashPassword("")` returns a perfectly valid 64-byte hash, so without this an OAuth-only
    // account created with `""` could be signed into by anyone submitting a blank password.
    const { salt, hash } = password ? hashPassword(password) : { salt: "", hash: "" };
    const member: StoredMember = {
      id: randomUUID(), org_id: org.id, email: email.toLowerCase(), role: "owner",
      created_at: new Date().toISOString(), salt, hash,
    };
    this.members.set(member.id, member);
    if (this.pg) {
      const pg = this.pg;
      void pg.upsertOrg(org).then(() => pg.upsertMember(member)).catch((e) => console.error("[mycel] persist org error:", e));
    }
    return { org, project, apiKey };
  }
  // ---------------------------------------------------------------------------------------------
  // Team
  //
  // A member belongs to exactly one org. That's the constraint everything below is shaped by: an
  // invite doesn't "add an org" to an existing account, it creates an account. An email that already
  // exists anywhere is therefore refused rather than silently moved, because moving someone between
  // orgs would take their old org's data access away without anyone asking for that.
  // ---------------------------------------------------------------------------------------------

  private invites = new Map<string, StoredInvite>();

  /**
   * Hostname → project, maintained alongside `projects`.
   *
   * `projectForHost` runs on EVERY request to the customer-facing app — it is how the page knows
   * whose brand to render — and it used to scan every project in the process to answer. That is
   * O(tenants) per page load, on the hottest path in the product. These two indexes make it O(1).
   *
   * Rebuilt wholesale on attach and patched on every write, because a stale index here serves one
   * founder's branding to another's customers.
   */
  private bySlug = new Map<string, string>();
  private byDomain = new Map<string, string>();

  private indexProject(p: Project): void {
    if (p.slug) this.bySlug.set(p.slug, p.id);
    // Only a VERIFIED domain is routable. Indexing an unverified claim would serve a portal on a
    // domain nobody has proved they own.
    if (p.custom_domain && p.custom_domain_verified_at) this.byDomain.set(p.custom_domain, p.id);
    else if (p.custom_domain) this.byDomain.delete(p.custom_domain);
  }

  listMembers(orgId: string): Member[] {
    return [...this.members.values()]
      .filter((m) => m.org_id === orgId)
      .map((m) => this.publicMember(m))
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  /**
   * Invite someone. Returns the raw token exactly once — the product emails it and cannot recover
   * it afterwards, which is the point.
   *
   * Re-inviting the same address replaces the outstanding invite instead of accumulating a pile of
   * live links to the same mailbox.
   */
  invite(args: {
    orgId: string;
    email: string;
    role: Role;
    invitedBy: string;
    ttlMs?: number;
  }): { invite: Invite; token: string } | { error: "taken" | "already_invited_elsewhere" } {
    const email = args.email.trim().toLowerCase();
    if (this.findMemberByEmail(email)) return { error: "taken" };
    const clash = [...this.invites.values()].find(
      (i) => i.email === email && !i.accepted_at && i.org_id !== args.orgId && i.expires_at > Date.now(),
    );
    if (clash) return { error: "already_invited_elsewhere" };

    for (const [id, i] of this.invites) {
      if (i.org_id === args.orgId && i.email === email && !i.accepted_at) this.invites.delete(id);
    }
    const token = `minv_${randomBytes(24).toString("base64url")}`;
    const invite: StoredInvite = {
      id: randomUUID(),
      org_id: args.orgId,
      email,
      // Nobody can mint a second owner by invitation. There is one owner per org and it is the
      // account that created it; an invited administrator can do everything else.
      role: args.role === "owner" ? "admin" : args.role,
      invited_by: args.invitedBy,
      created_at: new Date().toISOString(),
      expires_at: Date.now() + (args.ttlMs ?? INVITE_TTL_MS),
      token_hash: createHash("sha256").update(token).digest("hex"),
    };
    this.invites.set(invite.id, invite);
    if (this.pg) void this.pg.upsertInvite(invite).catch(() => {});
    return { invite: this.publicInvite(invite), token };
  }

  /** Outstanding invitations, newest first. Expired ones are shown — the fix is to resend, and
   *  hiding them makes "I never got it" impossible to diagnose. */
  listInvites(orgId: string): (Invite & { expired: boolean })[] {
    return [...this.invites.values()]
      .filter((i) => i.org_id === orgId && !i.accepted_at)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map((i) => ({ ...this.publicInvite(i), expired: i.expires_at < Date.now() }));
  }

  revokeInvite(orgId: string, id: string): boolean {
    const i = this.invites.get(id);
    // Scoped by org, not just by id: an id from another tenant must miss, not delete.
    if (!i || i.org_id !== orgId) return false;
    this.invites.delete(id);
    if (this.pg) void this.pg.deleteInvite(id).catch(() => {});
    return true;
  }

  /** What an invite link shows before anyone commits to anything — no session required. */
  peekInvite(token: string): { email: string; org_name: string; role: Role } | undefined {
    const i = this.findInvite(token);
    if (!i) return undefined;
    return { email: i.email, org_name: this.orgs.get(i.org_id)?.name ?? "a team", role: i.role };
  }

  /**
   * Accept an invitation.
   *
   * `password` may be empty for someone arriving via OAuth — `login()` refuses an empty hash, so
   * that cannot become a password-less way in.
   */
  acceptInvite(
    token: string,
    password: string,
    provider: AuthProvider = "password",
  ): { session: Session; member: Member; projects: Project[] } | undefined {
    const invite = this.findInvite(token);
    if (!invite) return undefined;
    // Between sending and accepting, someone may have signed up with that address directly.
    if (this.findMemberByEmail(invite.email)) return undefined;
    const { salt, hash } = password ? hashPassword(password) : { salt: "", hash: "" };
    const member: StoredMember = {
      id: randomUUID(),
      org_id: invite.org_id,
      email: invite.email,
      role: invite.role,
      created_at: new Date().toISOString(),
      salt,
      hash,
    };
    this.members.set(member.id, member);
    invite.accepted_at = new Date().toISOString();
    if (this.pg) {
      const pg = this.pg;
      void pg.upsertMember(member).then(() => pg.upsertInvite(invite)).catch(() => {});
    }
    return this.issue(member, provider);
  }

  /** Change a member's role. The org's owner cannot be demoted — that would leave it unadministrable. */
  setMemberRole(orgId: string, memberId: string, role: Role): Member | { error: string } {
    const m = this.members.get(memberId);
    if (!m || m.org_id !== orgId) return { error: "no such member" };
    if (m.role === "owner") return { error: "the owner's role cannot be changed" };
    if (role === "owner") return { error: "an org has one owner" };
    m.role = role;
    if (this.pg) void this.pg.upsertMember(m).catch(() => {});
    return this.publicMember(m);
  }

  /** Remove a member and every session they hold, so revoking access takes effect now. */
  removeMember(orgId: string, memberId: string): { ok: true } | { error: string } {
    const m = this.members.get(memberId);
    if (!m || m.org_id !== orgId) return { error: "no such member" };
    if (m.role === "owner") return { error: "the owner cannot be removed" };
    this.members.delete(memberId);
    for (const [token, s] of this.sessions) if (s.member_id === memberId) this.sessions.delete(token);
    if (this.pg) void this.pg.deleteMember(memberId).catch(() => {});
    return { ok: true };
  }

  private findInvite(token: string): StoredInvite | undefined {
    const digest = createHash("sha256").update(token).digest("hex");
    const i = [...this.invites.values()].find((x) => x.token_hash === digest);
    if (!i || i.accepted_at || i.expires_at < Date.now()) return undefined;
    return i;
  }

  /** Allowlist, for the same reason `publicMember` is one: a subtractive spread leaks whatever
   *  field someone adds to StoredInvite next, and the next one is as likely to be a secret. */
  private publicInvite(i: StoredInvite): Invite {
    return {
      id: i.id,
      org_id: i.org_id,
      email: i.email,
      role: i.role,
      invited_by: i.invited_by,
      created_at: i.created_at,
      expires_at: i.expires_at,
      accepted_at: i.accepted_at,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Plan & limits
  // ---------------------------------------------------------------------------------------------

  getOrg(id: string): Org | undefined {
    return this.orgs.get(id);
  }

  /** The limits in force. `cancelled` falls back to free rather than to nothing — the data stays
   *  readable, the work stops. */
  limitsFor(orgId: string): Limits {
    const org = this.orgs.get(orgId);
    const plan = org?.plan ?? "self_hosted";
    if (org?.plan_status === "cancelled") return PLAN_LIMITS.free;
    return PLAN_LIMITS[plan] ?? PLAN_LIMITS.self_hosted;
  }

  /** Set by the commercial control plane after a payment event. The kernel takes it on trust,
   *  which is why the route behind it demands a product key. */
  setPlan(
    orgId: string,
    patch: { plan?: Plan; status?: PlanStatus; billing_ref?: string; renews_at?: string },
  ): Org | undefined {
    const org = this.orgs.get(orgId);
    if (!org) return undefined;
    if (patch.plan) org.plan = patch.plan;
    if (patch.status) org.plan_status = patch.status;
    if (patch.billing_ref) org.billing_ref = patch.billing_ref;
    if (patch.renews_at) org.plan_renews_at = patch.renews_at;
    if (this.pg) void this.pg.upsertOrg(org).catch(() => {});
    return org;
  }

  /**
   * Seats in use: members plus outstanding invitations.
   *
   * Counting invites is the difference between a seat limit and a suggestion — otherwise you send
   * twenty invites on a three-seat plan and the enforcement happens to twenty confused people at
   * accept time instead of once, to you, at invite time.
   */
  seatsUsed(orgId: string): number {
    const members = [...this.members.values()].filter((m) => m.org_id === orgId).length;
    const pending = [...this.invites.values()].filter(
      (i) => i.org_id === orgId && !i.accepted_at && i.expires_at > Date.now(),
    ).length;
    return members + pending;
  }

  /** Which provider this email used last — for the sign-in screen, before anyone is authenticated. */
  lastProviderFor(email: string): AuthProvider | undefined {
    return this.findMemberByEmail(email)?.last_provider;
  }

  /**
   * The member as the API may return it.
   *
   * Allowlist, not denylist. This used to spread everything except salt/hash, so the reset-token
   * hash and its expiry — added later — would have been served from /v1/me to anyone with a session.
   * A subtractive filter silently leaks every field someone adds afterwards; naming the public ones
   * fails safe instead.
   */
  private publicMember(m: StoredMember): Member {
    return {
      id: m.id,
      org_id: m.org_id,
      email: m.email,
      role: m.role,
      created_at: m.created_at,
      last_provider: m.last_provider,
      providers: m.providers,
    };
  }
}

let cached: IdentityStore | null = null;
export function getIdentityStore(): IdentityStore {
  if (!cached) cached = new IdentityStore();
  return cached;
}

/** Boot-time: attach durable identity when MYCEL_DATABASE_URL is set (tenants survive restarts). */
export async function initIdentityStore(): Promise<{ backend: string }> {
  const url = databaseUrl();
  const store = getIdentityStore();
  if (!url) return { backend: "memory" };
  const { IdentityPg } = await import("./identity.pg");
  await store.attach(await IdentityPg.connect(url));
  return { backend: "postgres" };
}

export type { StoredInvite, StoredMember };
