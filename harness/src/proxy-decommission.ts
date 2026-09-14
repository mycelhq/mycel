import { getIdentityStore } from "./identity";
import { getDomainStore } from "./domain";
import { releaseDedicatedIp } from "./linkedin/proxy-pool";

/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * WHEN SOMEBODY STOPS PAYING, STOP PAYING FOR THEM
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A LinkedIn connection leases a DEDICATED ISP address in the member's country — bought from Bright
 * Data the moment they connect, billed monthly, held for as long as we hold it. Nothing gave one
 * back. So a founder could cancel, have their work stop the same minute (`INACTIVE_LIMITS` refuses
 * every new task), and leave us paying a proxy vendor for an address nobody will ever connect
 * through again. That is a cost that only ever goes up, one cancelled customer at a time.
 *
 * ── WHY THIS IS PER CONNECTION AND NOT PER ORG ──
 *
 * The lease is keyed on the LinkedIn MEMBER, not on the tenant, because two orgs that connect the
 * same LinkedIn account must share one address — a second IP for "org B" is the exact instability
 * LinkedIn scores against. So the release is asked per connection and `releaseDedicatedIp` refuses
 * on its own while any other connection is still bound to that member. Cancelling org A does not
 * pull the address out from under org B's live session.
 *
 * ── IT NEVER THROWS, AND IT NEVER DELETES ──
 *
 * The caller is a plan write. A founder cancelling must not be blocked because a proxy vendor is
 * unreachable, so every failure is caught and counted. And the CONNECTION ROWS stay: `workBlockedBy`
 * makes the same promise about tasks and artifacts — "records we destroyed to save $2 of storage are
 * records we cannot give back when they pay". What is released is the rented address, which is not
 * theirs and not a record.
 */
export interface ProxyDecommission {
  /** Connections looked at. */
  considered: number;
  /** Addresses actually handed back to the provider. */
  released: number;
  /** Held on to — shared with another live connection, or the provider refused. Still billing. */
  kept: string[];
}

export async function releaseOrgProxies(orgId: string): Promise<ProxyDecommission> {
  const identity = getIdentityStore();
  const projectIds = new Set(identity.listProjects(orgId, { includeArchived: true }).map((p) => p.id));
  if (projectIds.size === 0) return { considered: 0, released: 0, kept: [] };

  const connections = (await getDomainStore().listConnections()).filter(
    (c) => c.kind === "linkedin" && !!c.project_id && projectIds.has(c.project_id),
  );

  let released = 0;
  const kept: string[] = [];
  for (const c of connections) {
    const out = await releaseDedicatedIp(c.id).catch(() => ({ released: false }) as { released: boolean; ip?: string });
    if (out.released) released += 1;
    // Only an address we KNOW about counts as kept. A connection with no dedicated lease — a BYO
    // proxy, or a session-only gateway lease — has nothing to give back and is not a cost.
    else if (out.ip) kept.push(out.ip);
  }

  if (kept.length > 0) {
    console.warn(
      `[mycel] org ${orgId} cancelled; ${kept.length} dedicated IP(s) still held: ${kept.join(", ")}`,
    );
  }
  return { considered: connections.length, released, kept };
}
