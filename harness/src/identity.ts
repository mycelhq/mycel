// Identity & tenancy (v1 foundation). Two auth planes:
//   - Product API keys (machine): a key resolves to a Project (which owns wedges). Server-to-server.
//   - Member sessions (human): a Member logs in and gets a session token the portal forwards.
//     A member sees every Project in their Org.
//
// v1 bootstraps a single default Org + Project + owner Member, so there is exactly one tenant and
// therefore no cross-tenant surface to get wrong. The model is in place; per-project scoping of
// data lands when a second project actually exists. In-memory (note: pg backing next, like domain).
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { loadConfig } from "./config";

/** A stable, deterministic UUID from a name (UUIDv5-style). The default org/project/owner use
 *  these so their ids survive a restart — otherwise durable rows would be scoped to a dead
 *  project id after every boot. */
function stableUuid(name: string): string {
  const h = createHash("sha1").update(`mycel:${name}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export type Role = "owner" | "admin" | "operator" | "viewer";

export interface Org {
  id: string;
  name: string;
  created_at: string;
}
export interface Project {
  id: string;
  org_id: string;
  name: string;
  /** Wedge slugs this project may run. Empty = all wedges on disk. */
  wedges: string[];
  created_at: string;
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
    const project: Project = { id: stableUuid("default-project"), org_id: org.id, name: "default", wedges: [], created_at: now };
    this.projects.set(project.id, project);
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
    const { orgs, projects, members, apiKeys } = await pg.loadAll();
    for (const o of orgs) this.orgs.set(o.id, o);
    for (const p of projects) this.projects.set(p.id, p);
    for (const m of members) this.members.set(m.id, m);
    for (const [k, v] of apiKeys) this.apiKeys.set(k, v);
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

  /** Create a project (+ its own product API key) in an org. Mirrored to the durable backend. */
  createProject(orgId: string, name: string, wedges: string[] = []): { project: Project; apiKey: string } {
    const project: Project = { id: randomUUID(), org_id: orgId, name, wedges, created_at: new Date().toISOString() };
    this.projects.set(project.id, project);
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
  const url = process.env.MYCEL_DATABASE_URL;
  const store = getIdentityStore();
  if (!url) return { backend: "memory" };
  const { IdentityPg } = await import("./identity.pg");
  await store.attach(await IdentityPg.connect(url));
  return { backend: "postgres" };
}

export type { StoredMember };
