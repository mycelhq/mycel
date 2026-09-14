# Mycel sandbox image — bakes the OpenCode binary so `opencode serve` starts instantly.
# Used by the `docker` backend (local isolation): setup.sh builds it as mycel/sandbox:latest.
#
# The `daytona` backend does NOT use this file. It builds the same contents as a Daytona *snapshot*
# from the definition in harness/src/sandbox.snapshot.ts — no registry to push to, no credential to
# rotate, and Daytona pre-pulls its own snapshots so cold start is fast. Keep the two in step: the
# opencode install below and the one there are deliberately identical.
FROM node:22-bookworm-slim

ARG OPENCODE_VERSION=1.18.30
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

# ── A REAL BROWSER, AND THE HANDS TO DRIVE IT ────────────────────────────────────────────────────
#
# THIS IMAGE HAD NO BROWSER AT ALL, and the header above says to keep it in step with
# `harness/src/sandbox.snapshot.ts`, which has installed Playwright and Chromium for some time. They
# were not in step, and the gap had a specific victim: `geo-monitor`'s `probe_surface` — the
# measurement the entire GEO service rests on — declares `"shape": "operate"`, so the flagship trade's
# core task could not run on the docker backend at all. Nothing caught it, because the test suite
# never provisions a browser.
#
# Everything below mirrors `sandboxImageSpec()` line for line. When one changes, both change; the
# whole point of a local backend is that it fails the same way production does.
ARG BROWSER_USE_VERSION=0.13.8

RUN npm install --prefix /root playwright@1.62.1 \
    && npx --prefix /root playwright install --with-deps chromium \
    && node -e "const{chromium}=require('/root/node_modules/playwright');chromium.launch().then(b=>b.close()).then(()=>console.log('chromium ok'))"

# browser-use on top of that chromium: an indexed list of the page's interactive elements instead of
# a selector the agent has to invent. Python Playwright shares ~/.cache/ms-playwright with the Node
# one above, so `playwright install chromium` here is a no-op and costs neither the download nor the
# minutes. A venv because Debian 12 marks its system Python externally-managed (PEP 668).
RUN apt-get update && apt-get install -y --no-install-recommends python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/browseruse \
    && /opt/browseruse/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/browseruse/bin/pip install --no-cache-dir "browser-use[cli]==${BROWSER_USE_VERSION}" \
    && /opt/browseruse/bin/python -m playwright install chromium \
    && ln -sf /opt/browseruse/bin/browser-use /usr/local/bin/browser-use \
    && browser-use --version

WORKDIR /root
# The harness writes ~/.config/opencode/opencode.json then runs `opencode serve --port 4444`.
EXPOSE 4444
CMD ["sleep", "infinity"]
