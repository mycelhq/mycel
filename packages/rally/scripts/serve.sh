#!/bin/bash
# Keep the CRM up. Run by the launchd agent `ai.mycel.rally.crm` with KeepAlive, so it comes back
# after a crash, a logout or a reboot — the founder should never have to remember a command to see
# the list.
#
# DATABASE_URL is fetched here rather than baked into the plist: it is only needed for the Sync
# button, it rotates, and a secret in a plist is a secret in a file nobody thinks about again.
set -uo pipefail

REPO="${RALLY_REPO:-$HOME/conductor/workspaces/agentic-stack-v1/conakry}"
LOG="${RALLY_LOG:-$HOME/.mycel/rally/crm.log}"
mkdir -p "$(dirname "$LOG")"
exec >>"$LOG" 2>&1
echo "── start $(date '+%Y-%m-%d %H:%M') ─────────────────────"

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
# launchd starts with almost no environment, so the profile has to be named here or the AWS call
# below resolves no credentials and Sync silently stops working.
export AWS_PROFILE="${AWS_PROFILE:-mycel}"
export DATABASE_URL="${DATABASE_URL:-$(aws secretsmanager get-secret-value \
  --secret-id mycel/database-url --query SecretString --output text --region eu-west-2 2>/dev/null)}"
[ -z "${DATABASE_URL:-}" ] && echo "warning: no DATABASE_URL — the Sync button will not work"

cd "$REPO/packages/rally" || { echo "no repo at $REPO"; exit 1; }
exec node --experimental-sqlite --import tsx src/cli.ts crm
