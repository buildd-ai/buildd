#!/usr/bin/env bash
# Serve the checked-out application for either local or remote visual review.
# DATABASE_URL must name a synthetic/local database (see scripts/demo/).
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"
: "${DATABASE_URL:?Set DATABASE_URL to a synthetic/local database before serving}"
export QA_PORT="${QA_PORT:-3100}"
export QA_OUTPUT="${QA_OUTPUT:-/tmp/qa}"
mkdir -p "$QA_OUTPUT"
rm -f "$QA_OUTPUT/service.json"
NODE_ENV=development DISABLE_WRITES=true PORT="$QA_PORT" \
  bun --filter @buildd/web dev --hostname 0.0.0.0 >"$QA_OUTPUT/server.log" 2>&1 &
QA_SERVER_PID=$!
cleanup() { pkill -P "$QA_SERVER_PID" 2>/dev/null || true; kill "$QA_SERVER_PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM
bun -e 'import { exposeService } from "./scripts/qa/browser-provider.ts";
const mapping = await exposeService({ port: Number(process.env.QA_PORT), timeoutMs: Number(process.env.QA_READY_TIMEOUT_MS || 300000) });
await Bun.write(`${process.env.QA_OUTPUT}/service.json`, JSON.stringify({ ...mapping, data: "synthetic" }, null, 2));
console.log(`[serve] ready ${mapping.browserUrl} (${mapping.provider})`);'
wait "$QA_SERVER_PID"
