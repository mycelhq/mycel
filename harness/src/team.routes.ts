// The team routes — who is in this org, what each role may do, and how people join and leave.
//
// ═══ WHY THESE SIX ARE ONE MODULE ═══
//
// They are the only routes that write `members` and `invites`, and every one of them is a decision
// about AUTHORITY: who can approve, who can manage others, who is still here. That is a single
// concern and it was spread through the middle of a 10,000-line file next to routes about projects
// and tasks, which have nothing to do with it.
//
// ═══ WHAT `identity` IS AND WHY IT IS INJECTED ═══
//
// The identity store is a process-wide singleton reached through `getIdentityStore()`, so importing
// it here would work. It is injected anyway, for the reason `requests.routes.ts` gives: a route
// module that reaches for its own collaborators cannot be handed a different one by a test, and
// these routes decide who may act on somebody else's org.
import type { Hono } from "hono";
import type { Context } from "hono";
import { audit, auditList } from "./audit";
import { canManageMembers, getIdentityStore } from "./identity";
import { RESPONSIBILITY_LABEL, inferResponsibilities } from "./team";
import type { Role } from "./identity";

export interface TeamRouteDeps {
  /**
   * Members, invites and roles.
   *
   * The identity store is a process-wide singleton, so this is `ReturnType<typeof getIdentityStore>`
   * rather than a hand-written interface — the store's shape is defined in one place and a second
   * declaration here would be a copy to keep in step.
   */
  identity: ReturnType<typeof getIdentityStore>;
}

export function mountTeamRoutes(app: Hono, deps: TeamRouteDeps): void {
  const { identity } = deps;

  /**
   * Guard for the team-management routes. Returns an error response, or null when allowed.
   *
   * MOVED rather than injected, unlike `accessible` and `inScope`. Those are closures over the
   * request scope that several modules need; this one is used by exactly these six routes and by
   * nothing else, so leaving it in server.ts would have kept a team concern in the file this
   * extraction is trying to empty.
   */
  const requireManager = (c: Context) => {
    const scope = c.get("scope");
    if (scope.kind !== "member") return c.json({ error: "team management requires a member session" }, 403);
    if (!canManageMembers(scope.role)) return c.json({ error: "only an owner or admin can change the team" }, 403);
    return null;
  };

app.get("/v1/team", async (c) => {
  const scope = c.get("scope");
  return c.json({
    members: identity.listMembers(scope.org_id),
    // Pending invitations are only the manager's business — an operator seeing them can't act on
    // them, and each row names an email address that hasn't agreed to anything yet.
    invites: canManageMembers(scope.role) ? identity.listInvites(scope.org_id) : [],
    can_manage: scope.kind === "member" && canManageMembers(scope.role),
  });
});

/**
 * WHO on the team handles WHAT, learned from the audit trail — READ-ONLY.
 *
 * A role is a permission; this is a responsibility, inferred from what people have actually done.
 * Founder-scoped: gather the org's audit entries across its projects, tally per member, and return
 * each member's top areas. This does NOT route anything — we validate the model before wiring it
 * to approvals or escalation.
 */
app.get("/v1/team/responsibilities", async (c) => {
  const scope = c.get("scope");
  const orgId = scope.org_id;
  const projects = identity.listProjects(orgId);
  const entries = (
    await Promise.all(projects.map((p) => auditList(p.id, 500)))
  ).flat();
  const inferred = inferResponsibilities(entries);
  // Only members that belong to this org — an actor id in the audit stream is not by itself a
  // guarantee of current membership.
  const orgMemberIds = new Set(identity.listMembers(orgId).map((m) => m.id));
  const members = [...inferred.entries()]
    .filter(([memberId]) => orgMemberIds.has(memberId))
    .map(([memberId, areas]) => ({
      member_id: memberId,
      areas: areas.slice(0, 4).map((a) => ({
        area: a.area,
        label: RESPONSIBILITY_LABEL[a.area],
        weight: a.weight,
      })),
    }));
  return c.json({ members });
});

/**
 * Invite someone.
 *
 * Returns the raw token ONCE. The kernel does not send email — the product does, because that's
 * where the mail provider and the branded template live. Anything the product doesn't send is
 * unrecoverable, which is the correct failure mode for a credential.
 */
app.post("/v1/team/invites", async (c) => {
  const denied = requireManager(c);
  if (denied) return denied;
  const scope = c.get("scope");
  const b = (await c.req.json().catch(() => ({}))) as { email?: string; role?: string };
  const email = (b.email ?? "").trim().toLowerCase();
  if (!email.includes("@")) return c.json({ error: "a valid email is required" }, 400);
  // Explicit rather than coerced. Silently downgrading an unrecognised role would hand someone an
  // operator when they asked for an admin, and report success.
  const role = (b.role ?? "operator") as Role;
  if (!["admin", "operator", "viewer"].includes(role)) {
    return c.json({ error: "role must be admin, operator or viewer — an org has one owner" }, 400);
  }
  // Counted before sending, including outstanding invitations — otherwise the limit lands on
  // twenty confused recipients at accept time instead of once, here, on the person who set it up.
  const seats = identity.limitsFor(scope.org_id).seats;
  if (seats !== null && identity.seatsUsed(scope.org_id) >= seats) {
    return c.json(
      { error: `your plan includes ${seats} seat${seats === 1 ? "" : "s"}`, code: "seat_limit" },
      402,
    );
  }
  const out = identity.invite({ orgId: scope.org_id, email, role, invitedBy: scope.member_id! });
  if ("error" in out) {
    return c.json(
      {
        error:
          out.error === "taken"
            ? "that email already has a Mycel account"
            : "that email has a pending invitation to another team",
      },
      409,
    );
  }
  return c.json({ invite: out.invite, token: out.token }, 201);
});

app.delete("/v1/team/invites/:id", async (c) => {
  const denied = requireManager(c);
  if (denied) return denied;
  const ok = identity.revokeInvite(c.get("scope").org_id, c.req.param("id"));
  return ok ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
});

app.patch("/v1/team/members/:id", async (c) => {
  const denied = requireManager(c);
  if (denied) return denied;
  const b = (await c.req.json().catch(() => ({}))) as { role?: string };
  if (!["admin", "operator", "viewer"].includes(b.role ?? "")) {
    return c.json({ error: "role must be admin, operator or viewer" }, 400);
  }
  const out = identity.setMemberRole(c.get("scope").org_id, c.req.param("id"), b.role as Role);
  return "error" in out ? c.json(out, 400) : c.json(out);
});

app.delete("/v1/team/members/:id", async (c) => {
  const denied = requireManager(c);
  if (denied) return denied;
  const scope = c.get("scope");
  // Removing yourself would log you out mid-request and, if you were the last admin, strand the
  // org. Leaving is a different feature and it doesn't exist yet.
  if (c.req.param("id") === scope.member_id) return c.json({ error: "you cannot remove yourself" }, 400);
  const out = identity.removeMember(scope.org_id, c.req.param("id"));
  return "error" in out ? c.json(out, 400) : c.json(out);
});
}
