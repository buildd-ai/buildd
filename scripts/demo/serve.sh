#!/usr/bin/env bash
#
# serve.sh — run the real apps/web dashboard against the synthetic demo DB.
#
#   scripts/demo/serve.sh            # production build (if needed) + start, foreground
#   scripts/demo/serve.sh --bg       # same, backgrounded; pid in $DEMO_PID_FILE, log in $DEMO_LOG
#   scripts/demo/serve.sh --stop     # stop a --bg server
#   DEMO_REBUILD=1 scripts/demo/serve.sh --bg   # force `next build` (after UI edits)
#
# Why a production build and not `next dev`: /app/home and /app/tasks/[id]
# deliberately skip the database under NODE_ENV=development ("Development mode -
# no database"), so dev mode can't show them. Production mode uses real Auth.js
# sessions; run-storyboard.ts mints a session cookie for the seeded user with
# the throwaway AUTH_SECRET below (see scripts/demo/lib/session.ts).
#
# The server starts from an EMPTY environment (`env -i`): nothing from your
# shell or from any .env / .env.local file reaches it. Next's own env-file
# loading is disabled via __NEXT_PROCESSED_ENV, and every variable it gets is
# listed below — loopback URLs and throwaway synthetic secrets only.
#
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

DEMO_LOG="${DEMO_LOG:-${TMPDIR:-/tmp}/buildd-demo-server.log}"
DEMO_PID_FILE="${DEMO_PID_FILE:-${TMPDIR:-/tmp}/buildd-demo-server.pid}"

if [ "${1:-}" = "--stop" ]; then
  if [ -f "$DEMO_PID_FILE" ]; then
    pid="$(cat "$DEMO_PID_FILE")"
    pkill -P "$pid" 2>/dev/null || true
    kill "$pid" 2>/dev/null || true
    rm -f "$DEMO_PID_FILE"
    echo "[demo] stopped server $pid"
  fi
  # next dev forks; make sure nothing is left on the port.
  lsof -ti "tcp:$DEMO_APP_PORT" -sTCP:LISTEN | xargs kill 2>/dev/null || true
  exit 0
fi

if lsof -ti "tcp:$DEMO_APP_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "[demo] port $DEMO_APP_PORT already in use — scripts/demo/serve.sh --stop first" >&2
  exit 1
fi

BUN_BIN="$(command -v bun)"
SERVER_ENV=(
  env -i
  "HOME=$HOME" "PATH=$(dirname "$BUN_BIN"):/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin"
  "TERM=${TERM:-xterm}" "TMPDIR=${TMPDIR:-/tmp}"
  "__NEXT_PROCESSED_ENV=true"
  "NEXT_TELEMETRY_DISABLED=1"
  "NODE_ENV=production"
  "AUTH_TRUST_HOST=true"
  "PORT=$DEMO_APP_PORT"
  "DATABASE_URL=$DATABASE_URL"
  "NEON_LOCAL_FETCH_ENDPOINT=$NEON_LOCAL_FETCH_ENDPOINT"
  # Synthetic, throwaway secrets — only valid for this local stack.
  "AUTH_SECRET=$DEMO_AUTH_SECRET"
  "ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000"
  "NEXTAUTH_URL=$DEMO_BASE_URL"
  "AUTH_URL=$DEMO_BASE_URL"
  # Pusher → local soketi (see PUSHER_HOST in apps/web/src/lib/pusher.ts).
  "PUSHER_APP_ID=demo-app" "PUSHER_KEY=demo-key" "PUSHER_SECRET=demo-secret" "PUSHER_CLUSTER=mt1"
  "PUSHER_HOST=127.0.0.1" "PUSHER_PORT=$DEMO_SOKETI_PORT"
  "NEXT_PUBLIC_PUSHER_KEY=demo-key" "NEXT_PUBLIC_PUSHER_CLUSTER=mt1"
  "NEXT_PUBLIC_PUSHER_HOST=127.0.0.1" "NEXT_PUBLIC_PUSHER_PORT=$DEMO_SOKETI_PORT"
)

cd "$DEMO_ROOT/apps/web"

# Build when there is no build yet, or on request. The build bakes in the
# NEXT_PUBLIC_* values above, so it has to run under the same scrubbed env.
BUILD_STAMP=".next/DEMO_BUILD"
if [ -n "${DEMO_REBUILD:-}" ] || [ ! -f "$BUILD_STAMP" ]; then
  echo "[demo] next build (a few minutes)…"
  "${SERVER_ENV[@]}" "$BUN_BIN" --bun next build >"$DEMO_LOG.build" 2>&1 || {
    echo "[demo] build failed:" >&2; tail -40 "$DEMO_LOG.build" >&2; exit 1; }
  date -u +%FT%TZ >"$BUILD_STAMP"
fi

echo "[demo] serving $DEMO_BASE_URL (db $DATABASE_URL)"

if [ "${1:-}" = "--bg" ]; then
  "${SERVER_ENV[@]}" "$BUN_BIN" --bun next start --port "$DEMO_APP_PORT" >"$DEMO_LOG" 2>&1 &
  echo $! >"$DEMO_PID_FILE"
  for i in $(seq 1 180); do
    if curl -sf -o /dev/null "$DEMO_BASE_URL/api/version"; then
      echo "[demo] up after ${i}s (log: $DEMO_LOG)"
      exit 0
    fi
    if ! kill -0 "$(cat "$DEMO_PID_FILE")" 2>/dev/null; then
      echo "[demo] server exited early:" >&2; tail -30 "$DEMO_LOG" >&2; exit 1
    fi
    sleep 1
  done
  echo "[demo] timed out waiting for server" >&2; tail -30 "$DEMO_LOG" >&2; exit 1
fi

exec "${SERVER_ENV[@]}" "$BUN_BIN" --bun next start --port "$DEMO_APP_PORT"
