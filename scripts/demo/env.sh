# shellcheck shell=bash
# Shared env + fail-closed guards for scripts/demo/*.sh. Source, don't execute.
#
# Everything here is synthetic and loopback-only. The demo NEVER reads an env
# file: every variable the app needs is set explicitly below, and Next.js's own
# .env loading is switched off (__NEXT_PROCESSED_ENV) so a checkout that holds a
# real apps/web/.env.local cannot leak a live DATABASE_URL or API key into the
# demo server.

DEMO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEMO_DIR="$DEMO_ROOT/scripts/demo"

export DEMO_PG_PORT="${DEMO_PG_PORT:-55432}"
export DEMO_NEON_PORT="${DEMO_NEON_PORT:-54444}"
export DEMO_SOKETI_PORT="${DEMO_SOKETI_PORT:-56001}"
export DEMO_APP_PORT="${DEMO_APP_PORT:-3217}"

# Demo database — intentionally NOT overridable from the caller's environment,
# so an exported prod DATABASE_URL in your shell can't slip through.
export DATABASE_URL="postgres://demo:demo@localhost:${DEMO_PG_PORT}/buildd_demo"
export NEON_LOCAL_FETCH_ENDPOINT="http://127.0.0.1:${DEMO_NEON_PORT}/sql"
export DEMO_BASE_URL="http://localhost:${DEMO_APP_PORT}"
# Throwaway secret for the local Auth.js session cookie. Only this stack uses it.
export DEMO_AUTH_SECRET="buildd-demo-local-auth-secret-not-real-0000"

demo_is_loopback_url() {
  # $1 = URL. Accept only localhost / 127.0.0.1 / [::1] as the host.
  local host
  host="$(printf '%s' "$1" | sed -E 's#^[a-zA-Z][a-zA-Z0-9+.-]*://([^@/]*@)?(\[[^]]*\]|[^:/?]*).*#\2#')"
  case "$host" in
    localhost|127.0.0.1|'[::1]') return 0 ;;
    *) return 1 ;;
  esac
}

demo_guard() {
  local v
  for v in DATABASE_URL NEON_LOCAL_FETCH_ENDPOINT DEMO_BASE_URL; do
    if ! demo_is_loopback_url "${!v}"; then
      echo "[demo] REFUSING: $v is not a localhost URL" >&2
      exit 1
    fi
  done
}

demo_guard
