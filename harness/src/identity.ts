// Identity & tenancy (v1 foundation). Two auth planes:
//   - Product API keys (machine): a key resolves to a Project (which owns wedges). Server-to-server.
//   - Member sessions (human): a Member logs in and gets a session token the portal forwards.
//     A member sees every Project in their Org.
//
// v1 bootstraps a single default Org + Project + owner Member, so there is exactly one tenant and
// therefore no cross-tenant surface to get wrong. The model is in place; per-project scoping of
// data lands when a second project actually exists. In-memory (note: pg backing next, like domain).
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { loadConfig } from "./config";

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
export interface Member {
  id: string;
  org_id: string;
  email: string;
  role: Role;
  created_at: string;
}
interface StoredMember extends Member {
  salt: string;
  hash: string;
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

  constructor() {
    // Bootstrap the default tenant. The existing MYCEL_API_KEY becomes the default project's key.
    const org: Org = { id: randomUUID(), name: "default", created_at: new Date().toISOString() };
    this.orgs.set(org.id, org);
    const project: Project = {
      id: randomUUID(),
      org_id: org.id,
      name: "default",
      wedges: [],
      created_at: new Date().toISOString(),
    };
    this.projects.set(project.id, project);
    this.apiKeys.set(loadConfig().apiKey, { project_id: project.id, org_id: org.id });

    // Owner member: from env, or generated + printed (never a blank/known password).
    const email = process.env.MYCEL_OWNER_EMAIL ?? "founder@mycel.local";
    const pw = process.env.MYCEL_OWNER_PASSWORD ?? `own_${randomBytes(9).toString("base64url")}`;
    this.generatedPassword = process.env.MYCEL_OWNER_PASSWORD ? undefined : pw;
    this.ownerEmail = email;
    const { salt, hash } = hashPassword(pw);
    const member: StoredMember = {
      id: randomUUID(),
      org_id: org.id,
      email: email.toLowerCase(),
      role: "owner",
      created_at: new Date().toISOString(),
      salt,
      hash,
    };
    this.members.set(member.id, member);
  }

  readonly ownerEmail: string;
  readonly generatedPassword?: string;

  resolveApiKey(key: string): AuthScope | undefined {
    const m = this.apiKeys.get(key);
    return m ? { kind: "key", org_id: m.org_id, project_id: m.project_id } : undefined;
  }

  login(email: string, pw: string): { session: Session; member: Member; projects: Project[] } | undefined {
    const member = [...this.members.values()].find((m) => m.email === email.toLowerCase());
    if (!member || !verifyPassword(pw, member.salt, member.hash)) return undefined;
    const session: Session = {
      token: `msess_${randomBytes(24).toString("base64url")}`,
      member_id: member.id,
      org_id: member.org_id,
      expires_at: Date.now() + SESSION_TTL_MS,
    };
    this.sessions.set(session.token, session);
    return { session, member: this.publicMember(member), projects: this.listProjects(member.org_id) };
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
  accessibleProjectIds(scope: AuthScope): Set<string> {
    if (scope.kind === "key" && scope.project_id) return new Set([scope.project_id]);
    return new Set(this.listProjects(scope.org_id).map((p) => p.id));
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

  /** Create a project (+ its own product API key) in an org. */
  createProject(orgId: string, name: string, wedges: string[] = []): { project: Project; apiKey: string } {
    const project: Project = { id: randomUUID(), org_id: orgId, name, wedges, created_at: new Date().toISOString() };
    this.projects.set(project.id, project);
    const apiKey = `msk_${randomBytes(24).toString("base64url")}`;
    this.apiKeys.set(apiKey, { project_id: project.id, org_id: orgId });
    return { project, apiKey };
  }

  /** Create a fresh org with an owner member (used to add tenants; also lets tests prove isolation). */
  createOrgWithOwner(orgName: string, email: string, password: string): { org: Org; project: Project; apiKey: string } {
    const org: Org = { id: randomUUID(), name: orgName, created_at: new Date().toISOString() };
    this.orgs.set(org.id, org);
    const { project, apiKey } = this.createProject(org.id, "default");
    const { salt, hash } = hashPassword(password);
    const member: StoredMember = {
      id: randomUUID(), org_id: org.id, email: email.toLowerCase(), role: "owner",
      created_at: new Date().toISOString(), salt, hash,
    };
    this.members.set(member.id, member);
    return { org, project, apiKey };
  }
  private publicMember(m: StoredMember): Member {
    const { salt: _s, hash: _h, ...pub } = m;
    return pub;
  }
}

let cached: IdentityStore | null = null;
export function getIdentityStore(): IdentityStore {
  if (!cached) cached = new IdentityStore();
  return cached;
}
