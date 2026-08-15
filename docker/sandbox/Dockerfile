# Mycel sandbox image — bakes the OpenCode binary so `opencode serve` starts instantly.
# Used by the `docker` backend (local isolation): setup.sh builds it as mycel/sandbox:latest.
#
# The `daytona` backend does NOT use this file. It builds the same contents as a Daytona *snapshot*
# from the definition in harness/src/sandbox.snapshot.ts — no registry to push to, no credential to
# rotate, and Daytona pre-pulls its own snapshots so cold start is fast. Keep the two in step: the
# opencode install below and the one there are deliberately identical.
FROM node:22-bookworm-slim

ARG OPENCODE_VERSION=1.17.6
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      bash curl ca-certificates git python3 ripgrep \
    && rm -rf /var/lib/apt/lists/*

# Install the OpenCode binary directly — the npm postinstall is unreliable in Docker, so we
# fetch the platform tarball.
RUN set -eux; \
    tmp="$(mktemp -d)"; \
    curl -sSL "https://registry.npmjs.org/opencode-linux-x64/-/opencode-linux-x64-${OPENCODE_VERSION}.tgz" -o "$tmp/oc.tgz"; \
    tar -xzf "$tmp/oc.tgz" -C "$tmp"; \
    cp "$tmp/package/bin/opencode" /usr/local/bin/opencode; \
    chmod +x /usr/local/bin/opencode; \
    rm -rf "$tmp"; \
    opencode --version || true

WORKDIR /root
# The harness writes ~/.config/opencode/opencode.json then runs `opencode serve --port 4444`.
EXPOSE 4444
CMD ["sleep", "infinity"]
