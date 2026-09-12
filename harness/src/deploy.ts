/**
 * From "a run built an app" to "it is live at a URL".
 *
 * THE SHAPE OF THE HANDOFF, and why it is this shape.
 *
 * A `build` run assembles a Next.js application inside a Daytona microVM. `workspace.ts` tars that
 * directory up before the sandbox is destroyed. This module takes that tarball, puts it in S3, and
 * asks CodeBuild to turn it into a Lambda behind a CloudFront distribution (infra/hosting.tf,
 * infra/buildspec.tenant.yml).
 *
 * THE SANDBOX IS NEVER GIVEN AWS CREDENTIALS, and that constraint is the reason for every awkward
 * part of this file. It would be simpler for the sandbox — which already has the source, and has
 * already run `npm install` — to build and publish in place. It would also mean handing
 * `lambda:UpdateFunctionCode` to an environment executing model-authored code, where the entire
 * security model (see infra/sandbox.tf) is that a sandbox holds ONE per-task nonce naming ONE task
 * and nothing else. A prompt injection in a customer's requirements document would end with
 * attacker code running as a tenant's server. So the bytes travel as DATA — a tarball — and the
 * privileged half runs in CodeBuild under a role scoped by name prefix and resource tag.
 *
 * THE KERNEL IS NOT TOLD WHEN THE BUILD FINISHES. It polls `BatchGetBuilds`. A callback would need
 * either a credential for the kernel inside CodeBuild or a new public ingress on the kernel, and
 * both are worse than a poll of something that takes minutes anyway.
 *
 * EVERYTHING HERE DEGRADES TO A NO-OP when the deploy environment is unset, which is the state of
 * every developer machine and every test run. `deployConfig()` returning null means a `build` wedge
 * still runs, still exports its workspace, and still produces a downloadable artifact — it just does
 * not go live. That is the status quo, and a kernel that refused to start without an S3 bucket would
 * be a worse kernel.
 */
import type { Deployment } from "./contract";
import type { DomainStore } from "./domain";
import { ingestKeyFor } from "./insight/keys";
import { brandKeyFor } from "./scopedkeys";

// ---------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------

export interface DeployConfig {
  /** S3 bucket the workspace tarball is written to. `aws_s3_bucket.tenant_builds`. */
  bucket: string;
  /** CodeBuild project that builds and publishes it. `aws_codebuild_project.tenant_deploy`. */
  project: string;
  /** Tenant apps answer at `<slug>.<appsDomain>`. `local.apps_domain`. */
  appsDomain: string;
  region: string;
  /**
   * The kernel URL the DEPLOYED APP will use — a public hostname, not a service-discovery name
   * like `kernel.<something>.internal`.
   *
   * A tenant Lambda runs outside the VPC and cannot resolve service discovery. Attaching it to the
   * VPC instead would reintroduce the NAT gateway main.tf deleted, plus ENI cold starts, to reach
   * something already reachable over TLS. Optional: unset means the app is built without a kernel
   * URL and renders its fallback branding rather than a live portal.
   */
  portalUrl?: string;
}

/**
 * Read the deploy environment, or null when this kernel cannot deploy.
 *
 * All three of bucket, project and domain or none — a partial configuration is the dangerous state,
 * because it fails at the END of a build run rather than before one. `assertExportableBackend` makes
 * the same argument about the artifact backend for the same reason.
 */
export function deployConfig(): DeployConfig | null {
  const bucket = process.env.MYCEL_DEPLOY_BUCKET?.trim();
  const project = process.env.MYCEL_DEPLOY_PROJECT?.trim();
  const appsDomain = process.env.MYCEL_APPS_DOMAIN?.trim();
  if (!bucket || !project || !appsDomain) return null;
  return {
    bucket,
    project,
    appsDomain,
    region: process.env.AWS_REGION?.trim() || "eu-west-2",
    portalUrl: process.env.MYCEL_PORTAL_URL?.trim() || undefined,
  };
}

// ---------------------------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------------------------

/**
 * Hostnames Mycel keeps for itself.
 *
 * `apps.<domain>` is a separate namespace from the `*.<domain>` the business portal uses, so the
 * collision risk is lower than it is for portal slugs — but it is not zero, and the cost of getting
 * it wrong is a customer's app answering on a name the platform later wants. `www` and `api` are
 * here because they are the two every platform eventually needs.
 */
const RESERVED_SLUGS = new Set([
  "www", "api", "app", "admin", "kernel", "sandbox", "docs", "status", "static",
  "assets", "cdn", "mail", "internal", "test", "staging", "preview", "dashboard",
]);

/**
 * Is this a name that can safely become a DNS label, a Lambda function name, an S3 key prefix and a
 * CloudFront alias?
 *
 * All four at once, which is why this is stricter than any one of them requires. The specific
 * failures it prevents:
 *
 *   · A slug containing `/` writes into ANOTHER TENANT'S asset prefix. The buildspec re-checks this
 *     for exactly that reason, but a value that never leaves here in a bad state is better than one
 *     caught downstream.
 *   · A slug containing `.` claims a subdomain nobody allocated (`a.b` under `*.apps.<domain>` is
 *     not even covered by the wildcard certificate, so it fails as a TLS error).
 *   · Leading or trailing `-` is not a legal DNS label; Route53 accepts it and resolvers do not.
 *   · Upper case is legal in DNS and NOT legal in an S3 key used as a bucket-style host, and the
 *     mismatch shows up as a 404 on assets only.
 *
 * Throws rather than returning false: every caller would have to turn a false into an error anyway,
 * and a silently-skipped deploy is the failure mode this whole module exists to avoid.
 */
export function assertDeployableSlug(slug: string): string {
  const s = (slug ?? "").trim().toLowerCase();
  if (!s) throw new Error("deploy: the project has no slug to publish under");
  // 63 is the DNS label limit. Lambda allows 64 characters for a whole function name and the name
  // is `mycel-tenant-<project_id>`, so the function name is bounded separately — see `functionName`.
  if (s.length > 63) throw new Error(`deploy: slug "${slug}" is longer than a DNS label allows (63)`);
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(s)) {
    throw new Error(
      `deploy: slug "${slug}" is not a valid hostname label — lower-case letters, digits and ` +
        `internal hyphens only. A slug with a slash or a dot in it would address another tenant.`,
    );
  }
  if (RESERVED_SLUGS.has(s)) throw new Error(`deploy: "${s}" is reserved and cannot be a tenant hostname`);
  return s;
}

/** Where the world reaches this tenant's app. */
export function deployUrl(slug: string, appsDomain: string): string {
  return `https://${assertDeployableSlug(slug)}.${appsDomain}`;
}

/**
 * The S3 key the tarball is written to.
 *
 * Keyed by project AND deployment, never by slug. A slug is renameable and a project id is not, and
 * a build input addressed by a mutable name is a build that can be pointed at the wrong source by
 * renaming something.
 */
export function sourceKey(projectId: string, deploymentId: string): string {
  return `${projectId}/${deploymentId}/workspace.tar.gz`;
}

/**
 * The Lambda function name for a SITE.
 *
 * `mycel-tenant-<site_id>` — the prefix is the IAM boundary (`aws_iam_role_policy.tenant_deploy`
 * scopes every Lambda action to `mycel-tenant-*`), so this string is security-relevant and not
 * cosmetic. Keyed by site rather than by deployment because the function is UPDATED in place on
 * every deploy: a function per deployment would burn the region's 300GB code-storage quota, which is
 * the one AWS will not raise.
 *
 * IT USED TO TAKE A PROJECT ID, and that is why an agency could not host two clients — the second
 * client's build overwrote the first one's function. A site id IS the project id for a wedge that
 * builds the founder's own product, so nothing already deployed changes name; see
 * `site-identity.ts`.
 */
export function functionName(siteId: string): string {
  const name = `mycel-tenant-${siteId}`;
  if (name.length > 64) throw new Error(`deploy: site id "${siteId}" makes a function name over 64 characters`);
  return name;
}

// ---------------------------------------------------------------------------------------------
// Starting a deploy
// ---------------------------------------------------------------------------------------------

/** What `startDeploy` needs. Structural, so a test can supply it without an AWS account. */
export interface DeployRequest {
  projectId: string;
  /**
   * Which site this publishes. Defaults to the project when absent, which is what every caller
   * meant before sites existed.
   */
  siteId?: string;
  slug: string;
  taskId?: string;
  /** base64 of the gzipped tar, exactly as `exportDirectory` returns it. */
  base64: string;
}

/**
 * The AWS calls, behind an interface, so everything above and below can be tested without a network.
 *
 * The real implementation dynamically imports the AWS SDK the same way `artifacts.ts`'s S3 backend
 * does — the kernel must not take a hard dependency on `@aws-sdk/*` for a feature most installs
 * never use, and a self-hosted kernel with no AWS account must still start.
 */
export interface DeployClient {
  putObject(bucket: string, key: string, body: Buffer): Promise<void>;
  startBuild(project: string, env: Record<string, string>): Promise<string>;
  /** Terminal build status, or null while it is still running. */
  buildStatus(buildId: string): Promise<"succeeded" | "failed" | null>;
}

let clientOverride: DeployClient | null = null;
/** Test seam. Production never calls this; `deploy.test.ts` does. */
export function setDeployClient(c: DeployClient | null): void {
  clientOverride = c;
}

async function awsClient(cfg: DeployConfig): Promise<DeployClient> {
  if (clientOverride) return clientOverride;
  // String constants so a bundler does not try to resolve these at build time — the same trick
  // artifacts.ts uses, and for the same reason.
  const s3pkg = "@aws-sdk/client-s3";
  const cbpkg = "@aws-sdk/client-codebuild";
  const s3mod: any = await import(s3pkg);
  const cbmod: any = await import(cbpkg);
  const s3 = new s3mod.S3Client({ region: cfg.region });
  const cb = new cbmod.CodeBuildClient({ region: cfg.region });
  return {
    async putObject(bucket, key, body) {
      await s3.send(new s3mod.PutObjectCommand({ Bucket: bucket, Key: key, Body: body }));
    },
    async startBuild(project, env) {
      const res = await cb.send(
        new cbmod.StartBuildCommand({
          projectName: project,
          environmentVariablesOverride: Object.entries(env).map(([name, value]) => ({
            name,
            value,
            type: "PLAINTEXT",
          })),
        }),
      );
      const id = res?.build?.id;
      if (!id) throw new Error("deploy: CodeBuild accepted the request but returned no build id");
      return id;
    },
    async buildStatus(buildId) {
      const res = await cb.send(new cbmod.BatchGetBuildsCommand({ ids: [buildId] }));
      const s = res?.builds?.[0]?.buildStatus;
      if (!s || s === "IN_PROGRESS") return null;
      return s === "SUCCEEDED" ? "succeeded" : "failed";
    },
  };
}

/**
 * Record a deployment, upload the tarball, and start the build.
 *
 * ORDER MATTERS, and this is the order:
 *
 *   1. validate the slug        — before anything exists, so a bad name costs nothing
 *   2. create the row `queued`  — so a crash between here and step 4 leaves EVIDENCE. A deploy that
 *                                 died with no row is a customer asking why nothing happened and
 *                                 nobody able to answer.
 *   3. upload the tarball
 *   4. start the build, record `building` and the build id
 *
 * A failure at 3 or 4 marks the row `failed` with the reason rather than throwing it away, because
 * the run that produced these bytes has already succeeded — its artifact is safe, and the deploy is
 * a separate thing that can be retried.
 */
/**
 * STEP ONE OF TWO: put the bytes somewhere durable and ask a person.
 *
 * ═══ WHY A BUILD NO LONGER PUBLISHES ITSELF ═══
 *
 * This used to be the whole of `startDeploy`, called from `orchestrator.ts` as a finished build run
 * wound down. The page went to S3, CodeBuild ran, CloudFront invalidated, and a stranger was reading
 * a new version of somebody's business front door — with no human step anywhere between a model
 * deciding it was done and the public seeing the result.
 *
 * Every other thing this product produces is held for a signature. The founder's own site was the
 * exception, and `takeability` in `moves.ts` refuses to offer a "build my site" button BECAUSE of
 * it, in as many words: such a button "would not be 'start work', it would be 'publish a new
 * homepage', and it would look identical to the button next to it that only drafts an email". It
 * names the fix as an approval gate on the deploy. This is that gate.
 *
 * ═══ THE UPLOAD HAPPENS NOW, NOT ON APPROVAL ═══
 *
 * The bytes go to S3 here, while the run is still alive and holding them. They cannot be fetched
 * later from the sandbox — it is destroyed minutes after the run ends — and keeping a tarball in a
 * database row to wait for a click would put megabytes of agent output in a table that is read on
 * every page of the deployments list.
 *
 * So a reviewed deploy costs exactly one extra S3 object over an unreviewed one, and a DISCARDED one
 * costs that object and nothing else: no CodeBuild minutes, no Lambda, no invalidation. The
 * expensive half is the half that waits for a person.
 *
 * Returns a row at `awaiting_review`. `listInFlightDeployments` watches only `building` and
 * `queued`, so the poller will not touch it and no timer will expire it — it waits until somebody
 * answers, which is the point.
 */
export async function proposeDeploy(
  domain: Pick<DomainStore, "createDeployment" | "updateDeployment">,
  req: DeployRequest,
  cfg: DeployConfig,
): Promise<Deployment> {
  if (!req.projectId) throw new Error("deploy: refusing to deploy a task with no project");
  const slug = assertDeployableSlug(req.slug);
  const siteId = req.siteId || req.projectId;

  const dep = await domain.createDeployment({
    project_id: req.projectId,
    site_id: siteId,
    task_id: req.taskId,
    slug,
    url: deployUrl(slug, cfg.appsDomain),
    status: "awaiting_review",
  });

  const key = sourceKey(req.projectId, dep.id);
  try {
    const client = await awsClient(cfg);
    await client.putObject(cfg.bucket, key, Buffer.from(req.base64, "base64"));
  } catch (e) {
    const error = String((e as Error)?.message ?? e).slice(0, 500);
    // `failed`, not `discarded`. Nobody refused this — the upload broke, which is an engineering
    // fault and belongs in the record as one. See the note on `discarded` in `contract.ts`.
    await domain.updateDeployment(dep.id, req.projectId, { status: "failed", error }).catch(() => undefined);
    throw new Error(`deploy: could not store the build (${error})`);
  }
  return (await domain.updateDeployment(dep.id, req.projectId, { source_key: key })) ?? dep;
}

/**
 * A PERSON SAID NO.
 *
 * Terminal and cheap: the row records the refusal, the tarball stays in S3, and nothing is built.
 * Reversible in the only way that matters — by proposing another build — rather than by trying to
 * resurrect these bytes, which is what a founder actually wants after looking at a page and
 * disliking it.
 *
 * Refuses anything not `awaiting_review`, so a second click cannot discard a site that is already
 * live and a race between two tabs settles once.
 */
export async function discardDeploy(
  domain: Pick<DomainStore, "getDeployment" | "updateDeployment">,
  deploymentId: string,
  projectId: string,
  reason?: string,
): Promise<Deployment | undefined> {
  const dep = await domain.getDeployment(deploymentId, projectId);
  if (!dep || dep.status !== "awaiting_review") return undefined;
  return domain.updateDeployment(deploymentId, projectId, {
    status: "discarded",
    error: reason?.slice(0, 500),
  });
}

/**
 * STEP TWO OF TWO: a person said yes, so build it.
 *
 * Everything CodeBuild is told still comes from the kernel's own row — `projectId`, `site_id` and
 * `slug` are read back from the database, NOT from the request that approved it and never from the
 * tarball. That property is the reason this function takes a deployment id rather than a
 * `DeployRequest`: there is no parameter here a caller could use to point somebody else's bytes at
 * their own site, because the only thing a caller supplies is which row to publish, and
 * `getDeployment` is scoped by project.
 *
 * Refuses anything not `awaiting_review`. Publishing a `live` row again would start a second build
 * of the same bytes; publishing a `discarded` one would overturn a refusal with a stale click.
 */
export async function publishDeploy(
  domain: Pick<DomainStore, "getDeployment" | "updateDeployment">,
  deploymentId: string,
  projectId: string,
  cfg: DeployConfig,
): Promise<Deployment | undefined> {
  const dep = await domain.getDeployment(deploymentId, projectId);
  if (!dep || dep.status !== "awaiting_review") return undefined;
  if (!dep.source_key) {
    // A row at `awaiting_review` with no key means `proposeDeploy` died between the insert and the
    // patch. There are no bytes to build, and saying so beats starting a build that cannot succeed.
    return domain.updateDeployment(deploymentId, projectId, {
      status: "failed",
      error: "the build's source was never stored",
    });
  }
  return fireBuild(domain, dep, dep.source_key, cfg);
}

/**
 * The CodeBuild call, shared by the one path that reaches it.
 *
 * Split out of `startDeploy` when the gate landed, and the split is what keeps the security property
 * legible: every environment override below is derived from `dep`, a row this kernel wrote.
 */
async function fireBuild(
  domain: Pick<DomainStore, "updateDeployment">,
  dep: Deployment,
  key: string,
  cfg: DeployConfig,
): Promise<Deployment> {
  const siteId = dep.site_id || dep.project_id;
  try {
    const client = await awsClient(cfg);

    // Every one of these comes from the kernel's own database. NOTHING here is read out of the
    // tarball — if the archive could influence PROJECT_ID or TENANT_SLUG, one tenant's run could
    // publish over another tenant's site. The buildspec re-validates all four for the same reason.
    const buildId = await client.startBuild(cfg.project, {
      PROJECT_ID: dep.project_id,
      /**
       * Which resources this build owns, as distinct from which tenant owns THEM.
       *
       * `PROJECT_ID` still scopes the S3 asset prefix and the resource tags — that is a tenancy
       * boundary and must not become finer-grained just because addressing did. `SITE_ID` names only
       * the Lambda. The buildspec defaults it to `PROJECT_ID` when absent, so an older kernel and a
       * newer buildspec agree, which matters because they deploy separately.
       */
      SITE_ID: siteId,
      DEPLOYMENT_ID: dep.id,
      TENANT_SLUG: dep.slug,
      SOURCE_KEY: key,
      ...(cfg.portalUrl ? { PORTAL_URL: cfg.portalUrl } : {}),
      // The tenant app's analytics credential, MINTED HERE from the project id this deployment
      // already belongs to.
      //
      // This is the single line that closes the evidence loop, and its whole value is where the
      // project id comes from: `dep.project_id`, the kernel's own row, the same value that decides
      // which site is being overwritten. Not the tarball, not a field a founder typed, not a
      // header. A key derived from anything the run could influence would let one tenant's build
      // post analytics into another tenant's project — which is worse than useless, because the
      // agent would then rewrite a stranger's homepage on the strength of it.
      //
      // Derived, not stored (`insight/keys.ts`), so there is nothing to look up, nothing to expire,
      // and redeploying the same project yields the same key. It rides as a plaintext CodeBuild
      // override like everything else here, which is acceptable for a credential whose entire
      // authority is "append events to this one project" — it cannot read, and it is the only kind
      // of credential that may travel this path.
      INSIGHT_INGEST_KEY: ingestKeyFor(dep.project_id),
      /**
       * The tenant app's BRANDING credential, minted the same way and from the same `dep.project_id`.
       *
       * ═══ THIS LINE IS A BUG FIX, NOT A FEATURE ═══
       *
       * `hostLookup` in business-template asked for `MYCEL_API_KEY` and nothing ever set it — not
       * here, not in `infra/buildspec.tenant.yml`. So on every hosted tenant the lookup returned
       * null, `businessBrand()` fell through to `SOLO_BRAND`, and the site rendered the hardcoded
       * "Your business" and the default accent. The BrandKit the kernel computes and serves on
       * `GET /v1/host/:host` was reaching development and self-hosted installs only.
       *
       * It is NOT fixed by shipping the product key. That key starts tasks and reads every client in
       * the estate, and the runtime it would sit in is public-facing and was written by a model.
       * `infra/portal.tf` refused to publish this route for exactly that reason and named the
       * precondition: "a credential of its own that is scoped to one project." This is it — its
       * whole authority is the public face of this one project, and the route cross-checks the
       * key's project against the host's before it answers.
       */
      MYCEL_BRAND_KEY: brandKeyFor(dep.project_id),
    });

    return (
      (await domain.updateDeployment(dep.id, dep.project_id, {
        status: "building",
        build_id: buildId,
      })) ?? dep
    );
  } catch (e) {
    const error = String((e as Error)?.message ?? e).slice(0, 500);
    await domain
      .updateDeployment(dep.id, dep.project_id, { status: "failed", error })
      // A store that is also broken must not turn a deploy failure into an unhandled rejection that
      // takes the worker down mid-run.
      .catch(() => undefined);
    throw new Error(`deploy: could not start the build (${error})`);
  }
}

/**
 * Bring one in-flight deployment's row in line with what CodeBuild says.
 *
 * Called by a poller. Returns the updated row, or the original when the build is still running.
 *
 * The supersede happens BEFORE the row is marked live, which is required rather than tidy:
 * `deployments_one_live` is a partial unique index, and the other order raises a constraint
 * violation. Under a genuine race between two workers that violation is the CORRECT outcome — the
 * second one fails loudly instead of leaving a project with two live URLs and no way to say which
 * one a customer should be shown.
 */
export async function reconcileDeployment(
  domain: Pick<DomainStore, "updateDeployment" | "supersedeDeployments">,
  dep: Deployment,
  cfg: DeployConfig,
): Promise<Deployment> {
  if (dep.status !== "building" && dep.status !== "queued") return dep;
  if (!dep.build_id) return dep;

  const client = await awsClient(cfg);
  const status = await client.buildStatus(dep.build_id);
  if (!status) return dep;

  if (status === "failed") {
    return (
      (await domain.updateDeployment(dep.id, dep.project_id, {
        status: "failed",
        error: "the build failed; see the CodeBuild log for this build id",
      })) ?? dep
    );
  }

  // By SLUG: an agency's second client going live must not retire their first client's site.
  await domain.supersedeDeployments(dep.project_id, dep.slug, dep.id);
  return (await domain.updateDeployment(dep.id, dep.project_id, { status: "live" })) ?? dep;
}

/**
 * Poll CodeBuild for every in-flight deploy and mark rows live or failed.
 *
 * WHY THIS EXISTS AS A LOOP, NOT A CALLBACK. CodeBuild finishing has nowhere safe to POST: a
 * callback would need either a credential inside CodeBuild for the kernel, or a new public ingress.
 * Polling `BatchGetBuilds` is the boring answer and the right one — builds take minutes, and a
 * 30-second lag after they finish is invisible to a founder watching a URL come up.
 *
 * WHY IT WAS MISSING. `reconcileDeployment` was written, unit-tested, and never called from
 * production. CodeBuild could succeed, the Function URL could answer, and `GET /v1/deployments/current`
 * would still 404 because the row stayed `building` forever. That is how a demo shows "still
 * building" against a live site — or worse, never offers the URL at all.
 *
 * Degrades to a no-op when `deployConfig()` is null (dev machines, tests without AWS).
 */
export function startDeploymentReconciler(
  domain: Pick<DomainStore, "listInFlightDeployments" | "updateDeployment" | "supersedeDeployments">,
  intervalMs = 30_000,
): { stop(): void; tick(): Promise<number> } {
  let running = false;

  async function tick(): Promise<number> {
    const cfg = deployConfig();
    if (!cfg) return 0;
    if (running) return 0;
    running = true;
    let n = 0;
    try {
      const inflight = await domain.listInFlightDeployments(50);
      for (const dep of inflight) {
        try {
          const before = dep.status;
          const after = await reconcileDeployment(domain, dep, cfg);
          if (after.status !== before) n++;
        } catch (e) {
          console.error(`[mycel] deploy reconcile ${dep.id} failed:`, e);
        }
      }
    } catch (e) {
      console.error("[mycel] deploy reconciler tick error:", e);
    } finally {
      running = false;
    }
    return n;
  }

  const timer = setInterval(() => void tick(), intervalMs);
  (timer as { unref?: () => void }).unref?.();
  const boot = setTimeout(() => void tick(), 2_000);
  (boot as { unref?: () => void }).unref?.();

  return {
    stop() {
      clearInterval(timer);
      clearTimeout(boot);
    },
    tick,
  };
}
