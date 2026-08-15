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

# Say it when we degrade.
#
# FOUND IN A STRANGER-INSTALL WALKTHROUGH. The DOCUMENTED install path is `curl … | bash`, which is
# a pipe, so the NONINTERACTIVE test above fires on the path we tell people to use: every prompt
# silently answered itself with its default, `asksecret` returned the empty string, and the script
# still finished with a green "Mycel is set up." The person then has a .env with an empty provider
# key and no reason to suspect it. A default is fine; a default nobody was told about is not.
if [ -n "$NONINTERACTIVE" ]; then
  warn "Running non-interactively (stdin is not a terminal — this is what 'curl … | bash' does)."
  say "    Every question below answers itself with its default, and no provider key is written."
  say "    To answer them yourself:  ${C}git clone https://github.com/mycelhq/mycel && cd mycel && ./setup.sh${N}"
  say "    Or add the key afterwards by editing ${C}.env${N} in the install directory."
  say ""
fi

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
# The default is the kernel's own `standard` tier, READ OUT OF models.ts rather than retyped here.
#
# FOUND IN A STRANGER-INSTALL WALKTHROUGH: this defaulted to an Anthropic model id that does not
# exist, from a vendor none of the kernel's own tiers use. Accepting the default therefore
# sent someone to buy the wrong company's API key for a model that would 404 on first use — and
# because the prompt is skipped entirely on the piped install path, that was the default they got.
# A second copy of the model list in shell is what caused it, so there is no second copy: the
# literal below is only the fallback for a models.ts that has been moved or reshaped, and
# harness/test/setup-sh.test.ts asserts it still matches TIER_MODELS.standard.
DEFAULT_MODEL_FALLBACK="openai/gpt-5.6-luna"
DEFAULT_MODEL="$(sed -n 's/.*MYCEL_MODEL_STANDARD ?? "\([^"]*\)".*/\1/p' "$HERE/harness/src/models.ts" 2>/dev/null | head -1)"
[ -n "$DEFAULT_MODEL" ] || DEFAULT_MODEL="$DEFAULT_MODEL_FALLBACK"
MODEL="$(ask "model" "$DEFAULT_MODEL")"
PROVIDER="${MODEL%%/*}"
case "$PROVIDER" in
  anthropic)  PKEY_VAR="ANTHROPIC_API_KEY";;
  openai)     PKEY_VAR="OPENAI_API_KEY";;
  google)     PKEY_VAR="GOOGLE_GENERATIVE_AI_API_KEY";;
  openrouter) PKEY_VAR="OPENROUTER_API_KEY";;
  *)          PKEY_VAR="$(printf '%s' "$PROVIDER" | tr '[:lower:]' '[:upper:]')_API_KEY";;
esac
PKEY="$(asksecret "  ${PKEY_VAR} for ${MODEL}")"

# No tracing prompt. Every run's trace is served from the kernel's own event log at
# GET /v1/tasks/:id/trace — nothing to configure, so nothing to ask. Anyone who wants Langfuse on top
# for their own LLM debugging sets LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY themselves and runs
# `npm install langfuse`; see .env.example. It was a prompt here when it looked like a product
# feature, which it is not.

# ── write .env ──────────────────────────────────────────────────────────────
ENV_FILE="$HERE/.env"
if [ -f "$ENV_FILE" ]; then cp "$ENV_FILE" "$ENV_FILE.bak"; warn "backed up existing .env → .env.bak"; fi
# FOUND IN A STRANGER-INSTALL WALKTHROUGH: this file was written and then read by nothing. There is
# no dotenv dependency and nothing in harness/src loaded an env file, so .env said
# MYCEL_MODEL=… and the boot banner said something else — every answer collected above, including
# the provider key, was inert. `npm run dev` / `npm start` now pass Node's own
# `--env-file-if-exists=.env` (see package.json), so this file is loaded on boot and absent is fine.
{
  echo "# Loaded by 'npm run dev' / 'npm start' via node --env-file-if-exists=.env."
  echo "# Real environment variables win over anything in here."
  echo "MYCEL_SANDBOX=$BACKEND"
  echo "MYCEL_SANDBOX_IMAGE=mycel/sandbox:latest"
  echo "OPENCODE_PORT=4444"
  echo "MYCEL_MODEL=$MODEL"
  echo "$PKEY_VAR=$PKEY"
  [ -n "$DAYTONA_KEY" ] && echo "DAYTONA_API_KEY=$DAYTONA_KEY"
  echo "MYCEL_LOG_DIR=.mycel/logs"
  echo "PORT=4000"
} > "$ENV_FILE"
ok "wrote .env  (read on boot by 'npm run dev' / 'npm start')"
# Never printed as a value, only as a fact. An empty key is the single most common outcome of the
# piped install and previously produced no signal whatsoever until a task failed for no visible
# reason 60s in.
[ -n "$PKEY" ] || warn "$PKEY_VAR is empty — tasks will fail until you set it in .env (or run 'npm run demo', which needs no key)."

# ── install deps ────────────────────────────────────────────────────────────
say ""
say "${B}Installing dependencies${N}"
( cd "$HERE" && npm install >/dev/null 2>&1 ) && ok "npm install done" || warn "npm install had issues — run it manually"

# ── done ────────────────────────────────────────────────────────────────────
say ""
say "${G}${B}Mycel is set up.${N}"
# The last thing a new install reads, so it has to actually work. It did not: it named a wedge
# `demo` that has never existed (400 "unknown wedge") and it omitted the Authorization header, so it
# would have 401'd before getting that far — the /v1 surface is never unauthenticated, even in dev.
# Two wrong commands at the exact moment someone decides whether this thing works.
say "  Start the harness:  ${C}cd $(basename "$HERE") && npm run dev${N}"
say "                      ${D}it prints an API key on boot — export it as MYCEL_API_KEY${N}"
say "  Submit a task:      ${C}curl localhost:4000/v1/tasks -H \"authorization: Bearer \$MYCEL_API_KEY\" -H 'content-type: application/json' -d '{\"wedge\":\"invoice-chaser\",\"task_type\":\"chase_invoice\",\"input\":{}}'${N}"
say "  Watch it stream:    ${C}curl -N localhost:4000/v1/tasks/<id>/events -H \"authorization: Bearer \$MYCEL_API_KEY\"${N}"
say "  No keys at all:     ${C}npm run demo${N}${D}, then ${N}${C}npm run demo:seed${N} ${D}in another shell${N}"
say ""
if [ -z "$NONINTERACTIVE" ] && yesno "Start the harness now?" "y"; then ( cd "$HERE" && exec npm run dev ); fi
