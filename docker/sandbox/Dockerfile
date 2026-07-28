# Mycel sandbox image — bakes the OpenCode binary so `opencode serve` starts instantly.
# Used by the `docker` backend (local isolation) AND pushed to Daytona as the snapshot for the
# `daytona` backend. Same image, both places. Modeled on /docker/sandbox/Dockerfile.
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
