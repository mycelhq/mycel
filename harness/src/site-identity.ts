// WHICH SITE A BUILD IS PUBLISHING — a question the deploy pipeline never asked.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// THE BUG THIS EXISTS TO FIX, AND WHY IT WAS INVISIBLE
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// Everything downstream of a build was keyed by PROJECT: the Lambda is `mycel-tenant-<project_id>`,
// the publish slug is the project's slug, and `deployments_one_live` is a unique index on
// `(project_id) WHERE status='live'`.
//
// A project is the AGENCY. So an agency with two clients could not host two sites: the second
// deploy overwrote the first one's Lambda, pointed the same hostname at it, and the database
// actively refused to record both as live. That is fine — correct, even — for the only build wedge
// that existed, `product-builder`, which builds the founder's OWN product and is `internal: true`.
// One founder, one product, one address.
//
// It stops being fine the moment web development is something an agency SELLS, which is the entire
// point of `site-studio`. A studio with ten clients needs ten addresses, and the constraint was not
// in one place — it was in the schema, in the slug, and in the Lambda name, each of which looked
// locally reasonable.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// A SITE IS DECLARED, NOT INFERRED
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// The tempting rule is "if the task has a case, the site belongs to the case". It is wrong in the
// direction that costs the most: a `product-builder` run that happened to be filed under a case
// would silently start publishing the founder's own product to a new address, orphaning the old one
// with no error anywhere. Inference here fails silently and permanently.
//
// So a wedge SAYS. `workspace.site: "project" | "case"`, defaulting to `"project"` — which is what
// every existing manifest means, so nothing already deployed changes address. A wedge that builds
// for clients declares `"case"` and gets one site per engagement.
import { createHash } from "node:crypto";

/** What a wedge may declare. `project` is the default and the safe one. */
export type SiteScope = "project" | "case";

export interface SiteRef {
  /**
   * The resource key. Names the Lambda (`mycel-tenant-<site_id>`) and nothing else — the S3 asset
   * prefix stays keyed by project, because that is a TENANCY boundary and must not become finer
   * grained just because addressing did.
   */
  site_id: string;
  /** The DNS label this site answers on: `<slug>.<appsDomain>`. */
  slug: string;
}

/**
 * How many characters of the case hash go in the slug.
 *
 * Eight hex characters is 4.3 billion values. Collisions only matter WITHIN one project — the
 * project's own slug prefixes it — so this is birthday-bounded against the number of engagements one
 * agency has, where even ten thousand cases sit at roughly one in a hundred thousand. Long enough to
 * be safe, short enough that a founder can read the address out over the phone.
 */
const CASE_HASH_CHARS = 8;

/** DNS labels stop at 63. The project slug plus a hyphen plus the hash has to fit inside it. */
const MAX_LABEL = 63;

/**
 * Where this build publishes.
 *
 * `projectSlug` is the agency's own label and is assumed already validated — `assertDeployableSlug`
 * is the authority on that and runs again in `startDeploy`, which is the right place for it because
 * this function is also used to DISPLAY an address before anything is deployed.
 *
 * A `case` scope with no case falls back to the project rather than throwing. A run that lost its
 * case id publishing to the agency's main address is wrong, but it is loudly wrong — somebody sees
 * the wrong site at a known URL — whereas throwing would fail a build that had already succeeded,
 * and refusing to publish work that exists is the worse of the two.
 */
export function siteFor(args: {
  scope: SiteScope | undefined;
  projectId: string;
  projectSlug: string;
  caseId?: string;
}): SiteRef {
  const projectSlug = String(args.projectSlug ?? "").trim().toLowerCase();
  if (args.scope !== "case" || !args.caseId) {
    return { site_id: args.projectId, slug: projectSlug };
  }

  const hash = createHash("sha256").update(args.caseId).digest("hex").slice(0, CASE_HASH_CHARS);
  // Truncate the PROJECT's part, never the hash. The hash is what makes the address unique; a
  // shortened project slug is only less recognisable, while a shortened hash starts colliding.
  const room = MAX_LABEL - 1 - CASE_HASH_CHARS;
  const head = projectSlug.slice(0, Math.max(1, room)).replace(/-+$/, "");
  return {
    // NOT the slug. A slug is renameable and a resource key must not be: renaming an agency would
    // orphan every Lambda it owns and silently create a second set. The case id never changes.
    site_id: args.caseId,
    slug: `${head}-${hash}`,
  };
}

/**
 * Is this run publishing somewhere other than the agency's own address?
 *
 * Used for the sentence a founder reads, so they are never surprised by which site a build replaced.
 */
export const isClientSite = (ref: SiteRef, projectId: string): boolean => ref.site_id !== projectId;
