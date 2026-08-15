#!/usr/bin/env bash
# Mycel bootstrap — clone + set up in one line:
#   curl -fsSL https://mycelai.dev/init | bash
# (mycelai.dev/init redirects to this file; or run it from a checkout with ./setup.sh)
set -euo pipefail

REPO="${MYCEL_REPO:-https://github.com/mycelhq/mycel.git}"
DIR="${MYCEL_DIR:-mycel}"

if [ -t 1 ]; then G=$'\033[32m'; C=$'\033[36m'; R=$'\033[31m'; N=$'\033[0m'; else G=; C=; R=; N=; fi
have() { command -v "$1" >/dev/null 2>&1; }

printf "%s\n" "${G}Mycel${N} — the open kernel for AI-native service businesses"

have git || { printf "  ${R}git is required.${N} Install git, then re-run.\n" >&2; exit 1; }

if [ -e "$DIR" ]; then
  printf "  '%s' already exists. cd into it and run ${C}./setup.sh${N}\n" "$DIR"
  exit 1
fi

printf "  cloning into ${C}./%s${N} …\n" "$DIR"
git clone --depth 1 "$REPO" "$DIR"
cd "$DIR"
exec bash setup.sh
