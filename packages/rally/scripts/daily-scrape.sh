#!/bin/bash
# Every morning until launch day: walk yesterday's Product Hunt leaderboard, pull the makers, add
# anyone new to the list. Installed as a launchd agent by `rally daily install`.
#
# Deliberately SHORT — two days back, not thirty. A daily job that re-walks a month every morning
# spends an hour to find the same people, and the product-level dedup only spans a single run.
# Two days covers yesterday plus an overlap for anything that landed late.
set -uo pipefail

REPO="${RALLY_REPO:-$HOME/conductor/workspaces/agentic-stack-v1/conakry}"
LOG="${RALLY_LOG:-$HOME/.mycel/rally/daily-scrape.log}"
mkdir -p "$(dirname "$LOG")"

exec >>"$LOG" 2>&1
echo "── $(date '+%Y-%m-%d %H:%M') ─────────────────────────────"

# Stop once the launch is behind us: this list exists for one day, and a cron nobody remembers is
# a cron that runs forever.
if [ -n "${RALLY_LAUNCH_AT:-}" ]; then
  if [ "$(date +%s)" -gt "$(date -j -f '%Y-%m-%d' "${RALLY_LAUNCH_AT%%T*}" +%s 2>/dev/null || echo 0)" ]; then
    echo "launch day has passed — nothing to do. Remove with: rally daily uninstall"
    exit 0
  fi
fi

export DATABASE_URL="${DATABASE_URL:-$(aws secretsmanager get-secret-value \
  --secret-id mycel/database-url --query SecretString --output text --region eu-west-2 2>/dev/null)}"
if [ -z "$DATABASE_URL" ]; then echo "no DATABASE_URL — skipping"; exit 1; fi

cd "$REPO/growth" || { echo "no repo at $REPO"; exit 1; }
PH_SCRAPE_DAYS="${PH_SCRAPE_DAYS:-2}" PH_SCRAPE_GOAL="${PH_SCRAPE_GOAL:-200}" \
  npx tsx --conditions=react-server scripts/sources/producthunt.ts
echo "scrape exit $?"

# Fold the new people into the local rally queue, ranked.
cd "$REPO/packages/rally" || exit 1
node --experimental-sqlite --import tsx src/cli.ts import producthunt
echo "── done $(date '+%H:%M') ──"
