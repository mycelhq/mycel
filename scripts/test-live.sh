#!/usr/bin/env bash
# The suite, with a REAL Postgres under it.
#
# ═══ WHY THIS EXISTS ═══
#
# Most of the suite runs against the in-memory stores, which is right: it is fast, it needs nothing,
# and it covers the logic. What it cannot cover is the SQL, and the SQL is where a whole class of
# bug lives that no fake can have an opinion about.
#
# `submitVersionSql` used one parameter for both a text column and two `timestamptz` columns.
# Postgres refused to deduce a type and the statement failed to PREPARE — every deliverable version
# submitted in production — while the suite stayed green, because the pg tests hand the statement to
# a `FakeDb` that records the string and never runs it. A string is not a query.
#
# The live tests already existed. They were gated on an environment variable nobody set, and one of
# them was gated on the PRODUCTION variable, so they did not run and could not be trusted when they
# did. This makes running them a single command with a throwaway database, which is the only way a
# tier like this survives.
#
#   ./scripts/test-live.sh              # create a scratch db, run everything, drop it
#   KEEP=1 ./scripts/test-live.sh       # leave the database behind to inspect
set -euo pipefail
cd "$(dirname "$0")/.."

DB="${MYCEL_LIVE_TEST_DB:-mycel_live_$$}"
PSQL_BIN="$(command -v psql || echo /opt/homebrew/opt/postgresql@14/bin/psql)"
if [ ! -x "$PSQL_BIN" ]; then
  echo "psql not found. Install Postgres (brew install postgresql@14) or set MYCEL_TEST_DATABASE_URL yourself." >&2
  exit 2
fi
export PATH="$(dirname "$PSQL_BIN"):$PATH"

# An explicit URL wins — a CI job or a container has its own database and should not have one made.
if [ -n "${MYCEL_TEST_DATABASE_URL:-}" ]; then
  URL="$MYCEL_TEST_DATABASE_URL"
  MADE=0
else
  createdb "$DB" >/dev/null 2>&1 || { echo "could not create database $DB — is Postgres running?" >&2; exit 2; }
  URL="postgres://$(whoami)@localhost/$DB"
  MADE=1
fi

# THE GUARD THAT MATTERS. These tests create tables, drop tables and start a worker that executes
# queued work. Pointed at a real database that is one command from being the production one.
if [ -n "${MYCEL_DATABASE_URL:-}" ] && [ "$URL" = "${MYCEL_DATABASE_URL}" ]; then
  echo "refusing: the test database is the same as MYCEL_DATABASE_URL." >&2
  exit 2
fi

cleanup() {
  if [ "$MADE" = "1" ] && [ -z "${KEEP:-}" ]; then dropdb "$DB" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

echo "==> live suite against $URL"
# `MYCEL_DATABASE_URL` is deliberately NOT exported: each live test installs the throwaway itself
# where its subject needs it, and exporting the production name here is how a scratch run starts
# looking like a real one.
MYCEL_TEST_DATABASE_URL="$URL" npm test
