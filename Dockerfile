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
# `kernel/package.json` depends on `@mycel/linkedin` as `file:../packages/linkedin`. A `file:` dep is
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
COPY packages /packages

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

# The wedges and blueprints are DATA the kernel reads from disk at runtime — `wedgesDir()` and
# `blueprintsDir()` both resolve against the working directory. Without them the container starts,
# passes its health check, and then answers "unknown wedge" to every task and 404 to every
# blueprint: a kernel that runs nothing while looking perfectly healthy.
#
# Found by running the built image rather than by building it. Both directories are small and
# version-controlled, so they belong in the image; a founder's runtime edits live in the database
# and are merged over these at task time.
COPY wedges ./wedges
COPY blueprints ./blueprints

# Two more runtime-DATA directories, same category of bug as wedges above and found the same way.
# `workflowLibDir()` resolves `<cwd>/workflows` (the shared deterministic workflow library a wedge
# references by `lib`) and `skillsSeedDir()` resolves `<cwd>/service-skills` (the curated skill
# library seeded into the store on boot). Without these bytes in the image the container is perfectly
# healthy while a `lib`-referencing workflow 404s and the whole skill library seeds EMPTY — which is
# exactly what shipped: neither directory was ever copied. Both are small and version-controlled.
COPY workflows ./workflows
COPY service-skills ./service-skills

# Third runtime-DATA directory, same bug, same fix. `designSystemsDir()` resolves
# `<cwd>/design-systems/systems` — 29 vendored style systems that are what stops every deliverable
# this kernel emits from looking like raw markdown. Without these bytes `designSystemIds()` returns
# [] and every run degrades silently to no house style at all.
COPY design-systems ./design-systems

# FOURTH runtime-DATA directory missing its COPY, and the most expensive of them. `craft/` holds the
# rules `sharedCraft()` mounts on EVERY run that produces something a client receives — the eight
# things a model playing a paying client rejected a deliverable for, none of which were about the
# trade. `craft.ts` fails soft to [] by design, so without these bytes every deliverable in
# production was produced with none of it and nothing anywhere said so.
COPY craft ./craft

# THE SCAFFOLD A BUILD RUN STARTS FROM, staged into `kernel/templates/` by buildspec.yml.
#
# Same category of bug as the two directories above, and found the same way. `product-builder`
# declares `seed: "business-template"`, and `seedRoot()` looks in `<cwd>/templates/<name>` first.
# Without these bytes in the image, `seedWorkspace` degrades to "create an empty ~/app and say so on
# the feed" — survivable by design, but it means every hosted build run starts the agent from
# nothing and then fails its `npm run build` verification, while the container looks perfectly
# healthy. `business-template/` is a SIBLING of this Docker context (it is also its own image), so
# CI copies it in before building; `templates/.gitkeep` keeps this COPY valid when it has not.
COPY templates ./templates

ENV PORT=4000
EXPOSE 4000
CMD ["npx", "tsx", "harness/src/index.ts"]
