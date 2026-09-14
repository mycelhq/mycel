# Mycel harness service — the Task API + orchestrator. Deploy this to the cloud (Fly/Render).
# For cloud, use MYCEL_SANDBOX=daytona (isolated microVMs). For local, MYCEL_SANDBOX=local|docker.
FROM public.ecr.aws/docker/library/node:22-bookworm-slim
WORKDIR /app

# `npm ci` from the committed lockfile, NOT `npm install`. `install` re-resolves every `^` range
# fresh at build time, so a build is at the mercy of whatever the registry served that minute — and
# on 2026-08-14 that meant a transitive @aws-sdk sibling demanding `@aws-sdk/client-s3@^3.1111.0`, a
# version npm had not published yet, which failed the kernel image while the lockfile pinned a real
# 3.1101.0 the whole time. `ci` builds exactly the tree in package-lock.json: deterministic, and
# immune to the AWS SDK's lockstep-sibling version skew. The lock must be copied for it to work.
# WORKSPACE PACKAGES, COPIED BEFORE `npm ci` BECAUSE THE LOCKFILE POINTS AT THEM.
#
# `kernel/package.json` depends on `@mycel/linkedin` as `file:./packages/linkedin`. A `file:` dep is
# resolved by npm at INSTALL time, so if the directory is absent `npm ci` either fails or — worse —
# succeeds against a stale tree and the container dies at import with
# "Cannot find package '@mycel/linkedin'". That is exactly how the 2026-08-20 kernel deploy shipped a
# green build whose every task crashed; ECS held the old revision and production only stayed up
# because the new one never passed a health check.
#
# `packages/` is a SIBLING of this Docker context, so `COPY` cannot reach it — same constraint as
# `business-template`, and the same fix: buildspec.yml stages it into `kernel/packages/` first.
# The destination is ABSOLUTE (`/packages`) so that `../packages/linkedin` resolves correctly from
# the `/app` workdir, which keeps the container's layout identical to the repository's and means the
# path in package.json is true in both places rather than true in one and patched in the other.
COPY packages ./packages

# ...AND THEY INSTALL THEIR OWN DEPENDENCIES, because node cannot borrow the kernel's.
#
# `@mycel/linkedin` is a standalone package with its own package.json and lockfile, not an npm
# workspace member. Node resolves an import from `/packages/linkedin/src/proxy.ts` by walking UP —
# `/packages/linkedin/node_modules`, `/packages/node_modules`, `/node_modules` — and never reaches
# `/app/node_modules`. So `undici` being hoisted into the kernel's tree does nothing for it: the
# first fix got past "cannot find @mycel/linkedin" only to die on "cannot find undici", one level in.
#
# It reintroduced itself anyway, with playwright-core: that one was added to kernel/package.json —
# /app/node_modules, the one tree /packages/linkedin/src/login.ts cannot reach — and LinkedIn connect
# answered "Cannot find package 'playwright-core'" in production for two more rounds while people
# checked whether it was installed from /app, where it was. A dependency belongs to the package that
# IMPORTS it; it is an optionalDependency of @mycel/linkedin now and this loop installs it.
#
# The loop covers every staged package rather than naming linkedin, so adding a second one does not
# reintroduce this. `--omit=dev` because the runtime needs the package's dependencies, not its test
# tooling. buildspec.yml rsyncs without node_modules on purpose, so this is a clean install.
RUN for p in /packages/*/; do \
      if [ -f "$p/package-lock.json" ]; then \
        echo "installing deps for $p" && (cd "$p" && npm ci --omit=dev); \
      fi; \
    done

COPY package.json package-lock.json ./
RUN npm ci

# Distro Chromium for the LinkedIn email/password connect path (linkedin/login.ts drives it through
# playwright-core, which deliberately ships no browsers). Discovered by the co-founder in prod: the
# console offered the connect form and the kernel answered "playwright-core is not installed" — the
# dependency was missing AND the error's parenthetical ("Chromium is provided by the environment")
# described an environment nobody had built. The env var is what login.ts launches; distro chromium
# tracks Debian security updates with the base image instead of pinning a playwright download.
RUN apt-get update && apt-get install -y --no-install-recommends chromium \
  && rm -rf /var/lib/apt/lists/*
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium

COPY tsconfig.json ./
COPY harness ./harness

# `wedges/` is DATA the kernel reads from disk at runtime — `wedgesDir()` resolves it against the
# working directory. Without it the container starts, passes its health check, and then answers
# "unknown wedge" to every task: a kernel that runs nothing while looking perfectly healthy. Found by
# running the built image rather than by building it.
COPY wedges ./wedges

# ═══ AND THE REST OF THE RUNTIME LIBRARY, IN ONE LINE ═══
#
# `library/` holds the other seven directories the kernel reads off disk while it runs: blueprints,
# packs, workflows, service-skills, design-systems, craft, templates.
#
# This was seven separate COPY lines and it forgot SIX of them, one at a time, each discovered in
# production. Every one of these resolvers fails soft — the directory is missing, the resolver
# returns nothing, the health check passes, and the product is quietly worse in a way no error
# surface mentions:
#
#   · blueprints        404 to every blueprint
#   · workflows         a `lib`-referencing workflow 404s mid-run
#   · service-skills    the curated skill library seeds EMPTY
#   · design-systems    every deliverable degrades to no house style at all
#   · craft             every client-facing run produced without the rules it is held to
#   · packs             4,442 `workflow:*` calls in production and ZERO `pack:*`, ever, while four
#                       shipped wedges declared packs they could never reach
#
# One line cannot be forgotten six times, and an eighth directory added under it is carried without
# anybody remembering to say so. `the-image-carries-what-the-kernel-reads.test.ts` still checks the
# general property, because a new resolver could always point somewhere else entirely.
#
# `templates/business-template` is a SIBLING of this Docker context (it is also its own image), so CI
# stages it in before building; `library/templates/.gitkeep` keeps this valid when it has not.
COPY library ./library

ENV PORT=4000
EXPOSE 4000
CMD ["npx", "tsx", "harness/src/index.ts"]
