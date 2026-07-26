#!/usr/bin/env bash
#
# shoot.sh — boot the web app in dev mode, screenshot pages, tear down.
#
# One command to review the visual impact of a change: starts `next dev` with
# NODE_ENV=development (which bypasses auth via getCurrentUser's dev short-circuit —
# see apps/web/src/lib/auth-helpers.ts), waits for it to come up, runs the Playwright
# capture pass, then kills the server. No login, no session cookie required — just a
# reachable DATABASE_URL (your dev DB or a Neon dev-branch clone; both are fine).
#
# Usage:
#   scripts/qa/shoot.sh                                  # capture the full manifest
#   scripts/qa/shoot.sh /app/tasks/<id> /app/missions/<id>   # capture specific pages
#   DEV_USER_EMAIL=you@example.com scripts/qa/shoot.sh   # render as a real user's workspace
#
# Env vars:
#   DEV_USER_EMAIL   — render as this real DB user (else a mock dev@localhost user)
#   QA_PORT          — port to serve the app on (default: 3100, to avoid clashing with `bun dev`)
#   QA_OUTPUT        — screenshot output dir (default: /tmp/qa)
#   QA_ROUTES        — comma-separated ad-hoc paths (CLI args override this)
#   DISABLE_WRITES   — default "true" here, so a capture pass can't mutate the DB
#   DATABASE_URL     — inherited from your .env; point it at a dev clone to be safe
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

QA_PORT="${QA_PORT:-3100}"
QA_OUTPUT="${QA_OUTPUT:-/tmp/qa}"
BASE_URL="http://localhost:${QA_PORT}"

# CLI args, if any, become the ad-hoc route list.
if [ "$#" -gt 0 ]; then
  QA_ROUTES="$(IFS=,; echo "$*")"
fi

echo "[shoot] repo=$ROOT port=$QA_PORT output=$QA_OUTPUT"
echo "[shoot] routes=${QA_ROUTES:-<manifest>}"
echo "[shoot] dev user=${DEV_USER_EMAIL:-<mock dev@localhost>}"

# --- start the app ---
echo "[shoot] starting dev server…"
NODE_ENV=development \
DISABLE_WRITES="${DISABLE_WRITES:-true}" \
PORT="$QA_PORT" \
DEV_USER_EMAIL="${DEV_USER_EMAIL:-}" \
  bun --filter @buildd/web dev >/tmp/qa-server.log 2>&1 &
SERVER_PID=$!

cleanup() {
  echo "[shoot] stopping dev server (pid $SERVER_PID)…"
  pkill -P "$SERVER_PID" 2>/dev/null || true
  kill "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT

# --- wait for readiness ---
echo "[shoot] waiting for $BASE_URL/api/version …"
for i in $(seq 1 120); do
  if curl -sf -o /dev/null "$BASE_URL/api/version"; then
    echo "[shoot] app is up (after ${i}s)"
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "[shoot] dev server exited early — last log lines:" >&2
    tail -20 /tmp/qa-server.log >&2 || true
    exit 1
  fi
  sleep 1
  if [ "$i" -eq 120 ]; then
    echo "[shoot] timed out waiting for the app — last log lines:" >&2
    tail -20 /tmp/qa-server.log >&2 || true
    exit 1
  fi
done

# --- capture ---
# QA_NO_LOGIN: the dev server bypasses auth server-side, so skip the slow login POST.
QA_BASE_URL="$BASE_URL" \
QA_OUTPUT="$QA_OUTPUT" \
QA_ROUTES="${QA_ROUTES:-}" \
QA_NO_LOGIN=1 \
  bun run scripts/qa/capture.ts

echo "[shoot] done → $QA_OUTPUT/screenshots/"
