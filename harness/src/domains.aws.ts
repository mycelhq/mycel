/**
 * From "the founder proved they own the name" to "their site answers on it, with a padlock".
 *
 * ═══ THE SEAM THIS MODULE SITS ON ═══
 *
 * The ownership half of custom domains has existed for a while: claim, publish a TXT record,
 * `POST .../domain/verify` does a real DNS lookup, `projectForHost` routes the verified name. What
 * never existed was the SERVING half — a certificate for the name and an edge that answers on it —
 * and `MYCEL_CUSTOM_DOMAINS` exists precisely so the product refuses to pretend otherwise (the
 * whole postmortem is on `NO_CUSTOM_DOMAINS` in server.ts).
 *
 * This module is the serving half. It is small because the infrastructure already made it small:
 * every tenant site is its OWN CloudFront distribution (infra/hosting.tf spells out the
 * arithmetic), so "serve this tenant on their own name" is one ACM certificate plus one alias on
 * one distribution that already exists. No listener quotas, no shared rule lists, no terraform —
 * the exact per-tenant property hosting.tf promised would make a custom domain "a two-line change
 * on that tenant's own resource".
 *
 * ═══ THE STATE MACHINE, AND WHY IT IS RESUMABLE RATHER THAN A WORKFLOW ═══
 *
 *   claimed → ownership_verified → cert_requested → cert_issued → live
 *                                        ↓ (and from any step)
 *                                      failed (with a sentence a founder can act on)
 *
 * Between `cert_requested` and `cert_issued` sits a HUMAN publishing a CNAME at their DNS provider,
 * which takes anywhere from a minute to two days. Nothing here waits: `advanceCustomDomain` takes
 * ONE bounded pass — do whatever is possible right now, record where it stopped, return. The
 * founder's "Check status" button (or re-entering the verify route) calls it again and it picks up
 * from the recorded state. Every step is idempotent, so a double-click, a crashed kernel, or an
 * impatient founder mashing the button converges on the same place instead of minting duplicate
 * certificates. ACM's own idempotency token (derived from project + domain, below) is what makes
 * the request step safe to repeat even when OUR record of the ARN was lost.
 *
 * State lives on the project row (`domain_provisioning`, one jsonb column) rather than in a new
 * table, because it is a fact ABOUT the project's domain — the same place `custom_domain` and its
 * verify token already live — and a restart must resume from Postgres, not from memory.
 */
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

export type DomainProvisionState =
  | "claimed"
  | "ownership_verified"
  | "cert_requested"
  | "cert_issued"
  | "live"
  | "failed";

/** What the kernel remembers between passes. Serialised as-is into `projects.domain_provisioning`. */
export interface DomainProvisioning {
  state: DomainProvisionState;
  /** ACM certificate ARN, from the moment `RequestCertificate` answers. Survives a failure so a
   *  retry describes the SAME certificate instead of requesting a fresh one. */
  cert_arn?: string;
  /** The DNS-validation CNAME ACM wants published. Stored, not re-fetched, so `GET /domain` can
   *  render the founder's checklist without an AWS call on a page load. */
  acm_record_name?: string;
  acm_record_value?: string;
  /** The tenant's own CloudFront distribution, discovered once by alias and then pinned. */
  distribution_id?: string;
  /** `dxxxx.cloudfront.net` — the target of the founder's final CNAME. */
  distribution_domain?: string;
  /** Present only in `failed`. A sentence a founder can read, never a raw AWS error alone. */
  error?: string;
}

// ---------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------

/**
 * CloudFront reads certificates from us-east-1 ONLY — a global-service quirk, not a deployment
 * choice, which is why this is a constant and not an env read. The kernel itself runs in eu-west-2;
 * pointing the ACM client at the kernel's own region would produce certificates CloudFront cannot
 * see, and the failure would surface two steps later as an UpdateDistribution error naming an ARN
 * that looks perfectly valid.
 */
export const ACM_REGION = "us-east-1";

export interface DomainProvisionConfig {
  /** Tenant sites answer at `<slug>.<appsDomain>` — the alias the distribution is found by. */
  appsDomain: string;
}

/** Null when this kernel has no tenant hosting at all, in which case there is no distribution to
 *  put an alias on and the state machine must say so rather than hunt for one. */
export function domainProvisionConfig(): DomainProvisionConfig | null {
  const appsDomain = process.env.MYCEL_APPS_DOMAIN?.trim();
  if (!appsDomain) return null;
  return { appsDomain };
}

// ---------------------------------------------------------------------------------------------
// The AWS calls, behind an interface — the same seam deploy.ts cut, for the same two reasons:
// tests must run without a network, and a self-hosted kernel with no AWS account must still start.
// ---------------------------------------------------------------------------------------------

export interface DomainAwsClient {
  /** Returns the certificate ARN. MUST be idempotent under the same token — ACM guarantees this. */
  requestCertificate(domain: string, sans: string[], idempotencyToken: string): Promise<string>;
  describeCertificate(arn: string): Promise<{
    status: string;
    /** The DNS-validation CNAME for the FOUNDER'S name (never the SAN — see `advance`). */
    validationRecord?: { name: string; value: string };
    failureReason?: string;
  }>;
  /** The tenant's own distribution, located by the alias the deploy pipeline gave it. */
  findDistributionByAlias(alias: string): Promise<{ id: string; domainName: string } | null>;
  /** Add the alias and swap the viewer certificate. MUST be a no-op when both are already set. */
  attachDomain(distributionId: string, domain: string, certArn: string): Promise<void>;
}

let clientOverride: DomainAwsClient | null = null;
/** Test seam. Production never calls this; domains-aws.test.ts does. */
export function setDomainAwsClient(c: DomainAwsClient | null): void {
  clientOverride = c;
}

async function awsClient(): Promise<DomainAwsClient> {
  if (clientOverride) return clientOverride;
  // String constants so a bundler does not resolve these at build time — deploy.ts's trick, kept.
  const acmpkg = "@aws-sdk/client-acm";
  const cfpkg = "@aws-sdk/client-cloudfront";
  const acmmod: any = await import(acmpkg);
  const cfmod: any = await import(cfpkg);
  const acm = new acmmod.ACMClient({ region: ACM_REGION });
  // CloudFront is a global service; its SDK endpoint lives in us-east-1 regardless of where the
  // kernel runs, so the explicit region here is documentation more than configuration.
  const cf = new cfmod.CloudFrontClient({ region: ACM_REGION });
  return {
    async requestCertificate(domain, sans, idempotencyToken) {
      const res = await acm.send(
        new acmmod.RequestCertificateCommand({
          DomainName: domain,
          SubjectAlternativeNames: sans.length ? sans : undefined,
          ValidationMethod: "DNS",
          IdempotencyToken: idempotencyToken,
          // The same tags the deploy pipeline puts on the distribution, so "what is this cert" has
          // an answer in the console and a cleanup script has something to key on. Requires the
          // acm:AddTagsToCertificate grant alongside RequestCertificate.
          Tags: [{ Key: "mycel:managed", Value: "tenant-app" }],
        }),
      );
      const arn = res?.CertificateArn;
      if (!arn) throw new Error("ACM accepted the request but returned no certificate ARN");
      return arn;
    },
    async describeCertificate(arn) {
      const res = await acm.send(new acmmod.DescribeCertificateCommand({ CertificateArn: arn }));
      const cert = res?.Certificate ?? {};
      // Only the FOUNDER'S name needs a record from them. The wildcard SAN's validation CNAME is
      // the one terraform already published for the shared `*.apps` certificate (ACM validation
      // records are deterministic per name + account), so surfacing it would hand the founder an
      // instruction about OUR zone that they cannot act on and do not need to.
      const opt = (cert.DomainValidationOptions ?? []).find(
        (o: any) => o?.DomainName === cert.DomainName && o?.ResourceRecord?.Name && o?.ResourceRecord?.Value,
      );
      return {
        status: String(cert.Status ?? "PENDING_VALIDATION"),
        validationRecord: opt
          ? { name: String(opt.ResourceRecord.Name).replace(/\.$/, ""), value: String(opt.ResourceRecord.Value).replace(/\.$/, "") }
          : undefined,
        failureReason: cert.FailureReason ? String(cert.FailureReason) : undefined,
      };
    },
    async findDistributionByAlias(alias) {
      // The same lookup the deploy buildspec uses to find "its" distribution on a redeploy —
      // paginated here because the fleet is bigger than one page sooner than anyone plans for.
      let marker: string | undefined;
      do {
        const res = await cf.send(new cfmod.ListDistributionsCommand({ Marker: marker }));
        const list = res?.DistributionList ?? {};
        for (const item of list.Items ?? []) {
          if ((item?.Aliases?.Items ?? []).includes(alias)) {
            return { id: String(item.Id), domainName: String(item.DomainName) };
          }
        }
        marker = list.IsTruncated ? list.NextMarker : undefined;
      } while (marker);
      return null;
    },
    async attachDomain(distributionId, domain, certArn) {
      const res = await cf.send(new cfmod.GetDistributionConfigCommand({ Id: distributionId }));
      const cfg = res?.DistributionConfig;
      const etag = res?.ETag;
      if (!cfg || !etag) throw new Error("CloudFront returned no config for the tenant's distribution");
      const aliases: string[] = cfg.Aliases?.Items ?? [];
      const already = aliases.includes(domain) && cfg.ViewerCertificate?.ACMCertificateArn === certArn;
      // Idempotence lives HERE, not in a caller-side flag: a second pass reads the live config and
      // finds nothing to do. An unconditional Update would also work but would churn the
      // distribution into `InProgress` on every "Check status" click for no change at all.
      if (already) return;
      cfg.Aliases = { Quantity: aliases.includes(domain) ? aliases.length : aliases.length + 1,
        Items: aliases.includes(domain) ? aliases : [...aliases, domain] };
      // One certificate per distribution is a HARD CloudFront quota (hosting.tf), so this REPLACES
      // the wildcard cert — which is exactly why `advance` requests the new certificate with the
      // wildcard as a SAN. Without that SAN this line would break TLS on `<slug>.apps.<domain>`
      // the moment the founder's domain went live.
      cfg.ViewerCertificate = {
        ACMCertificateArn: certArn,
        SSLSupportMethod: "sni-only",
        MinimumProtocolVersion: "TLSv1.2_2021",
        CertificateSource: "acm",
      };
      await cf.send(
        new cfmod.UpdateDistributionCommand({ Id: distributionId, IfMatch: etag, DistributionConfig: cfg }),
      );
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Advancing the machine
// ---------------------------------------------------------------------------------------------

/** The slice of the identity store this module needs. Structural, so a test supplies a Map. */
export interface DomainIdentity {
  getProject(id: string):
    | {
        id: string;
        slug?: string;
        custom_domain?: string;
        custom_domain_verified_at?: string;
        domain_provisioning?: DomainProvisioning;
      }
    | undefined;
  setDomainProvisioning(projectId: string, prov: DomainProvisioning): void;
}

/**
 * ACM's IdempotencyToken is at most 32 chars of [A-Za-z0-9_-], scoped to the account for an hour+.
 * Derived from project AND domain, so re-claiming a different name mints a different certificate
 * while retrying the same name returns the same ARN — which is the entire point of the token.
 */
export function certIdempotencyToken(projectId: string, domain: string): string {
  return createHash("sha256").update(`${projectId}:${domain}`).digest("hex").slice(0, 32);
}

/** ACM states that will never become ISSUED on their own. Anything else is "keep waiting". */
const TERMINAL_CERT_STATES = new Set(["FAILED", "VALIDATION_TIMED_OUT", "REVOKED", "EXPIRED"]);

/**
 * One bounded pass over the state machine. Never throws — an AWS refusal becomes `failed` with a
 * sentence, because the caller is a request handler and its reader is a founder, and neither is
 * helped by a stack trace where a checklist item should be.
 *
 * Preconditions the CALLER owns: `MYCEL_CUSTOM_DOMAINS` is on, and the caller is an owner/admin of
 * the project. This function only checks the facts it advances on.
 */
export async function advanceCustomDomain(
  identity: DomainIdentity,
  projectId: string,
  cfg: DomainProvisionConfig | null = domainProvisionConfig(),
): Promise<DomainProvisioning> {
  const p = identity.getProject(projectId);
  const fail = (error: string, keep: Partial<DomainProvisioning> = {}): DomainProvisioning => {
    const prov: DomainProvisioning = { ...(p?.domain_provisioning ?? { state: "failed" as const }), ...keep, state: "failed", error };
    if (p) identity.setDomainProvisioning(projectId, prov);
    return prov;
  };

  if (!p?.custom_domain) return { state: "failed", error: "There is no domain claimed for this business." };
  const domain = p.custom_domain;

  // Ownership first, always. Requesting a certificate for a name nobody proved they control is how
  // a product ends up holding certificates for other people's domains.
  if (!p.custom_domain_verified_at) {
    const prov: DomainProvisioning = { ...(p.domain_provisioning ?? {}), state: "claimed" };
    identity.setDomainProvisioning(projectId, prov);
    return prov;
  }

  if (!cfg) {
    return fail(
      "This deployment doesn't host tenant sites, so there is nothing to serve your domain from. " +
        "The domain is verified and will start working the moment hosting is configured.",
    );
  }

  let prov: DomainProvisioning = { ...(p.domain_provisioning ?? { state: "ownership_verified" }) };
  if (prov.state === "failed") prov.state = "ownership_verified"; // a retry is a fresh attempt, not a replay of the failure
  if (prov.state === "claimed") prov.state = "ownership_verified";
  const save = () => identity.setDomainProvisioning(projectId, prov);

  let client: DomainAwsClient;
  try {
    client = await awsClient();
  } catch {
    return fail(
      "This kernel can't reach AWS to set up your domain — the certificate tooling isn't installed. " +
        "Your verified domain is safe; nothing needs redoing once it is.",
    );
  }

  // ── Find the tenant's distribution FIRST, before any certificate exists ──
  //
  // Deliberately ahead of RequestCertificate for two reasons: a business whose site has never been
  // deployed should hear that NOW, before we mint a certificate for a name nothing can serve; and
  // knowing `dxxxx.cloudfront.net` up front lets `GET /domain` hand the founder ALL THREE records
  // in one sitting — ownership TXT, ACM CNAME, final CNAME — instead of drip-feeding DNS changes
  // across three visits to their registrar.
  if (!prov.distribution_id || !prov.distribution_domain) {
    if (!p.slug) {
      return fail("This business has no site address yet, so there is nothing to point your domain at.");
    }
    try {
      const dist = await client.findDistributionByAlias(`${p.slug}.${cfg.appsDomain}`);
      if (!dist) {
        return fail(
          "Your site hasn't been published yet, so there is nothing to serve your domain from. " +
            "Deploy the site first, then press Check status here again.",
          prov,
        );
      }
      prov.distribution_id = dist.id;
      prov.distribution_domain = dist.domainName;
      save();
    } catch (e) {
      return fail(
        `Couldn't look up your site's edge configuration (${trim(e)}). Nothing is lost — press Check status to retry.`,
        prov,
      );
    }
  }

  // ── Request the certificate (idempotent under the derived token) ──
  if (!prov.cert_arn) {
    try {
      // The wildcard SAN is LOAD-BEARING, not generosity. CloudFront allows exactly one certificate
      // per distribution, and the distribution already serves `<slug>.apps.<domain>` under the
      // shared wildcard cert. Swapping in a cert that only names the founder's domain would break
      // TLS on the mycel address the moment the custom one went live — silently, for every client
      // holding an old link. So the new certificate carries BOTH names. The wildcard validates
      // instantly and invisibly: ACM validation CNAMEs are deterministic per name + account, and
      // terraform already published the `*.apps` one for the shared certificate.
      prov.cert_arn = await client.requestCertificate(
        domain,
        [`*.${cfg.appsDomain}`],
        certIdempotencyToken(p.id, domain),
      );
      prov.state = "cert_requested";
      save();
    } catch (e) {
      return fail(
        `Couldn't request a certificate for ${domain} (${trim(e)}). Nothing is lost — press Check status to retry.`,
        prov,
      );
    }
  }

  // ── Poll issuance — one Describe, never a wait loop. The founder's DNS change is the clock. ──
  try {
    const d = await client.describeCertificate(prov.cert_arn);
    if (d.validationRecord) {
      prov.acm_record_name = d.validationRecord.name;
      prov.acm_record_value = d.validationRecord.value;
    }
    if (TERMINAL_CERT_STATES.has(d.status)) {
      // The certificate is dead; the ARN must go with it, or every retry describes the corpse.
      // VALIDATION_TIMED_OUT is the common case — ACM gives 72 hours for the CNAME — and the fix
      // is genuinely "start the certificate again", which dropping the ARN makes automatic.
      prov.cert_arn = undefined;
      return fail(
        `The certificate for ${domain} was not issued (${d.failureReason ?? d.status}). ` +
          "Usually this means the certificate record above was never published. Add it, then press Check status to start a fresh certificate.",
        prov,
      );
    }
    if (d.status !== "ISSUED") {
      prov.state = "cert_requested";
      save();
      return prov;
    }
    prov.state = "cert_issued";
    save();
  } catch (e) {
    return fail(`Couldn't check the certificate's status (${trim(e)}). Press Check status to retry.`, prov);
  }

  // ── Put the name on the distribution ──
  try {
    await client.attachDomain(prov.distribution_id!, domain, prov.cert_arn!);
    prov.state = "live";
    prov.error = undefined;
    save();
    return prov;
  } catch (e) {
    return fail(
      `The certificate is issued, but attaching ${domain} to your site failed (${trim(e)}). ` +
        "Press Check status to retry — everything up to here is done and stays done.",
      prov,
    );
  }
}

/** An AWS error's first words, bounded. The founder-readable sentence comes first; this is the
 *  part an operator greps the logs for. */
function trim(e: unknown): string {
  return String((e as Error)?.message ?? e).slice(0, 200);
}
