#!/usr/bin/env bash
# Mycel setup — the kernel for AI-native service businesses.
# Renders the logo, checks/installs prerequisites, collects your keys, writes .env.
# Works interactively or piped:  curl -fsSL https://mycelai.dev/install | bash
set -euo pipefail

# ── pretty ──────────────────────────────────────────────────────────────────
if [ -t 1 ]; then B=$'\033[1m'; D=$'\033[2m'; G=$'\033[32m'; C=$'\033[36m'; Y=$'\033[33m'; R=$'\033[31m'; N=$'\033[0m'; else B=; D=; G=; C=; Y=; R=; N=; fi
say()  { printf "%s\n" "$*"; }
ok()   { printf "  ${G}✓${N} %s\n" "$*"; }
warn() { printf "  ${Y}!${N} %s\n" "$*"; }
err()  { printf "  ${R}✗${N} %s\n" "$*" >&2; }
have() { command -v "$1" >/dev/null 2>&1; }

# read from the terminal even when the script itself is piped from curl
TTY=/dev/tty; [ -r /dev/tty ] || TTY=/dev/stdin
NONINTERACTIVE="${MYCEL_NONINTERACTIVE:-}"
[ -t 0 ] || [ -r /dev/tty ] || NONINTERACTIVE=1
ask() { # ask "Prompt" "default" -> echoes answer
  local prompt="$1" def="${2:-}" ans=""
  if [ -n "$NONINTERACTIVE" ]; then printf "%s" "$def"; return; fi
  printf "${C}?${N} %s ${D}[%s]${N} " "$prompt" "$def" >&2
  read -r ans < "$TTY" || true
  printf "%s" "${ans:-$def}"
}
asksecret() { # asksecret "Prompt" -> echoes secret (hidden)
  local prompt="$1" ans=""
  if [ -n "$NONINTERACTIVE" ]; then printf ""; return; fi
  printf "${C}?${N} %s ${D}(hidden)${N} " "$prompt" >&2
  read -rs ans < "$TTY" || true; printf "\n" >&2
  printf "%s" "$ans"
}
yesno() { case "$(ask "$1 (y/n)" "${2:-n}")" in y|Y|yes|YES) return 0;; *) return 1;; esac; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"

# ── logo ────────────────────────────────────────────────────────────────────
if [ -f "$HERE/brand/logo.txt" ]; then printf "${G}"; cat "$HERE/brand/logo.txt"; printf "${N}\n";
else printf "${G}${B}  M Y C E L${N}\n"; fi
say "  ${D}the kernel for AI-native service businesses${N}"
say ""

# ── prerequisites ───────────────────────────────────────────────────────────
say "${B}Checking prerequisites${N}"
OS="$(uname -s 2>/dev/null || echo unknown)"

# Node >= 20
NODE_OK=
if have node; then
  MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "$MAJOR" -ge 20 ] 2>/dev/null && { ok "node $(node -v)"; NODE_OK=1; } || warn "node $(node -v) is < 20"
fi
if [ -z "$NODE_OK" ]; then
  err "Node.js >= 20 is required."
  case "$OS" in
    Darwin) say "    install: ${C}brew install node${N}  (or https://nodejs.org)";;
    Linux)  say "    install: ${C}curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs${N}";;
    *)      say "    install from https://nodejs.org";;
  esac
  if have brew && yesno "  Install Node with Homebrew now?"; then brew install node && NODE_OK=1; fi
  [ -n "$NODE_OK" ] || { err "Re-run setup after installing Node."; exit 1; }
fi
have npm && ok "npm $(npm -v)" || { err "npm not found (comes with Node)"; exit 1; }

# ── choose sandbox backend ──────────────────────────────────────────────────
say ""
say "${B}Where should OpenCode run?${N}  ${D}(the sandbox backend)${N}"
say "  ${C}local${N}   — this machine (needs the opencode binary)"
say "  ${C}docker${N}  — a local Docker container (isolation, no cloud account)"
say "  ${C}daytona${N} — an isolated Daytona microVM (cloud)"
BACKEND="$(ask "backend" "local")"

DAYTONA_KEY=""
case "$BACKEND" in
  local)
    if have opencode; then ok "opencode $(opencode --version 2>/dev/null || echo present)";
    elif yesno "  opencode binary not found. Install with 'npm i -g opencode-ai'?"; then
      npm install -g opencode-ai && ok "opencode installed" || warn "opencode install failed — install manually";
    else warn "You'll need the opencode binary before running tasks (or use the docker backend)."; fi ;;
  docker)
    have docker && ok "docker present" || warn "Docker not found — install Docker Desktop / engine first."
    if have docker && yesno "  Build the Mycel sandbox image now (bakes opencode)?"; then
      docker build -t mycel/sandbox:latest "$HERE/docker/sandbox" && ok "image built" || warn "image build failed";
    fi ;;
  daytona)
    DAYTONA_KEY="$(asksecret "  Daytona API key")" ;;
esac

# ── model + provider key ────────────────────────────────────────────────────
say ""
say "${B}Which LLM?${N}  ${D}provider/model${N}"
MODEL="$(ask "model" "anthropic/claude-opus-4-8")"
PROVIDER="${MODEL%%/*}"
case "$PROVIDER" in
  anthropic)  PKEY_VAR="ANTHROPIC_API_KEY";;
  openai)     PKEY_VAR="OPENAI_API_KEY";;
  google)     PKEY_VAR="GOOGLE_GENERATIVE_AI_API_KEY";;
  openrouter) PKEY_VAR="OPENROUTER_API_KEY";;
  *)          PKEY_VAR="$(printf '%s' "$PROVIDER" | tr '[:lower:]' '[:upper:]')_API_KEY";;
esac
PKEY="$(asksecret "  ${PKEY_VAR} for ${MODEL}")"

# ── optional Langfuse tracing ───────────────────────────────────────────────
say ""
LF_SECRET=""; LF_PUBLIC=""; LF_HOST=""
if yesno "${B}Enable Langfuse tracing?${N} ${D}(open-source observability; self-host or cloud)${N}" "n"; then
  LF_HOST="$(ask "  Langfuse host" "https://cloud.langfuse.com")"
  LF_PUBLIC="$(ask "  LANGFUSE_PUBLIC_KEY" "")"
  LF_SECRET="$(asksecret "  LANGFUSE_SECRET_KEY")"
  say "    ${D}self-host: docker compose up at github.com/langfuse/langfuse${N}"
fi

# ── write .env ──────────────────────────────────────────────────────────────
ENV_FILE="$HERE/.env"
if [ -f "$ENV_FILE" ]; then cp "$ENV_FILE" "$ENV_FILE.bak"; warn "backed up existing .env → .env.bak"; fi
{
  echo "MYCEL_SANDBOX=$BACKEND"
  echo "MYCEL_SANDBOX_IMAGE=mycel/sandbox:latest"
  echo "OPENCODE_PORT=4444"
  echo "MYCEL_MODEL=$MODEL"
  echo "$PKEY_VAR=$PKEY"
  [ -n "$DAYTONA_KEY" ] && echo "DAYTONA_API_KEY=$DAYTONA_KEY"
  echo "MYCEL_LOG_DIR=.mycel/logs"
  [ -n "$LF_SECRET" ] && { echo "LANGFUSE_SECRET_KEY=$LF_SECRET"; echo "LANGFUSE_PUBLIC_KEY=$LF_PUBLIC"; echo "LANGFUSE_HOST=$LF_HOST"; }
  echo "PORT=4000"
} > "$ENV_FILE"
ok "wrote .env"

# ── install deps ────────────────────────────────────────────────────────────
say ""
say "${B}Installing dependencies${N}"
( cd "$HERE" && npm install >/dev/null 2>&1 ) && ok "npm install done" || warn "npm install had issues — run it manually"
[ -n "$LF_SECRET" ] && ( cd "$HERE" && npm install langfuse >/dev/null 2>&1 ) && ok "langfuse installed" || true

# ── done ────────────────────────────────────────────────────────────────────
say ""
say "${G}${B}Mycel is set up.${N}"
say "  Start the harness:  ${C}cd $(basename "$HERE") && npm run dev${N}"
say "  Submit a task:      ${C}curl localhost:4000/v1/tasks -H 'content-type: application/json' -d '{\"wedge\":\"demo\",\"task_type\":\"research\",\"input\":{\"goal\":\"hello\"}}'${N}"
say "  Watch it stream:    ${C}curl -N localhost:4000/v1/tasks/<id>/events${N}"
say ""
if [ -z "$NONINTERACTIVE" ] && yesno "Start the harness now?" "y"; then ( cd "$HERE" && exec npm run dev ); fi
