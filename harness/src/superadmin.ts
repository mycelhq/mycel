/**
 * The accounts with no ceilings.
 *
 * The founder and co-founder need to run the product without meeting a limit they wrote — demoing
 * ten businesses on a three-project plan, or reaching the deep tier to reproduce a customer's bug.
 * Everything else in the system derives what an org may do from `PLAN_LIMITS`, so without this the
 * only way to get there is to hand ourselves a plan, and a plan is a commercial fact: it goes into
 * the pricing UI, into Stripe reconciliation, and into the webhook that would then try to find a
 * subscription for it. A `plan: "unlimited"` would be a lie told to the money path.
 *
 * So this is NOT a plan. It is a property of a person, evaluated server-side, and the only thing it
 * changes is which ceilings apply.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY AN ENV ALLOWLIST RATHER THAN A DATABASE COLUMN
 *
 * A column is a value, and every value in this system has an authenticated route that writes it.
 * `Member.prefs` is the proof: it is a free-form, member-writable key-value store returned from
 * `/v1/me`, so a flag stored there would be self-grantable with a single PATCH. A dedicated column
 * is better but not safe by construction — it only takes one future `PATCH /v1/team/members/:id`
 * that spreads its body into the member row for the flag to become reachable from a session, and
 * that class of bug has shipped here before.
 *
 * `MYCEL_SUPERADMIN_EMAILS` cannot be reached from any request at all. There is no code path from
 * an HTTP body to `process.env`, so the property is not "no route writes it today" but "no route
 * can". Granting it requires the deployment credentials and a restart, which is deliberately
 * inconvenient: the inconvenience is the control.
 *
 * The cost is that revocation needs a redeploy rather than a DB update. That is the right trade for
 * an account with no ceilings — the failure we are protecting against is a privilege that gets
 * granted too easily, not one that gets removed too slowly.
 * ---------------------------------------------------------------------------------------------
 *
 * Read at call time, not at module load, so a test can set it and so a redeploy that changes the
 * variable takes effect on the next request rather than on the next process.
 */
export function superAdminEmails(): Set<string> {
  const raw = process.env.MYCEL_SUPERADMIN_EMAILS ?? "";
  return new Set(
    raw
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * Is this address one of ours?
 *
 * Compared lowercased and trimmed because that is exactly how `identity.ts` stores an email
 * (`email.toLowerCase()` on every write path). A case-sensitive comparison here would produce a
 * super-admin who is one on Tuesday and not on Wednesday depending on how they typed their address
 * into the sign-in box, which is the worst possible failure mode for a privilege check: intermittent.
 *
 * An empty or absent variable yields an empty set, so a self-hosted install — and every CI run —
 * has no super-admin at all. Fails closed, like every other authorization check in the kernel.
 */
export function isSuperAdminEmail(email?: string | null): boolean {
  if (!email) return false;
  return superAdminEmails().has(email.trim().toLowerCase());
}
