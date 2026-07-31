# Mycel harness service — the Task API + orchestrator. Deploy this to the cloud (Fly/Render).
# For cloud, use MYCEL_SANDBOX=daytona (isolated microVMs). For local, MYCEL_SANDBOX=local|docker.
FROM node:22-bookworm-slim
WORKDIR /app

COPY package.json ./
RUN npm install

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

ENV PORT=4000
EXPOSE 4000
CMD ["npx", "tsx", "harness/src/index.ts"]
