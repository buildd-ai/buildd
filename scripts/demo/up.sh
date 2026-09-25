#!/usr/bin/env bash
#
# up.sh — start the synthetic demo stack (postgres + neon http proxy + soketi)
# and migrate it. Idempotent: re-running just re-applies pending migrations.
#
#   scripts/demo/up.sh            # start + migrate
#   scripts/demo/up.sh --down     # tear down (containers + tmpfs data)
#
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

COMPOSE=(docker compose -f "$DEMO_DIR/docker-compose.yml")

if [ "${1:-}" = "--down" ]; then
  "${COMPOSE[@]}" down -v
  exit 0
fi

echo "[demo] starting containers…"
"${COMPOSE[@]}" up -d --wait postgres
"${COMPOSE[@]}" up -d neon-proxy soketi

echo "[demo] waiting for neon http proxy on $NEON_LOCAL_FETCH_ENDPOINT …"
for i in $(seq 1 60); do
  # Any HTTP answer (even 4xx) means the proxy is listening.
  if curl -s -o /dev/null -X POST "$NEON_LOCAL_FETCH_ENDPOINT"; then break; fi
  sleep 1
  if [ "$i" -eq 60 ]; then echo "[demo] neon proxy never came up" >&2; exit 1; fi
done

echo "[demo] migrating $DATABASE_URL …"
(cd "$DEMO_ROOT/packages/core" && bun run db:migrate)

echo "[demo] up. Next: bun run scripts/demo/seed.ts <story.json>  then  scripts/demo/serve.sh"
