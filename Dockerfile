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
COPY package.json package-lock.json ./
RUN npm ci

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
