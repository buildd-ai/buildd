#!/bin/bash
# The extraction's decisive test, locally: with apps/web NOT running, a runner
# claims a task, heartbeats and completes it through the control plane Worker
# (wrangler dev / workerd) against a migrated loopback Postgres.
#
#   DATABASE_URL=postgres://...@localhost:<port>/<db>   migrated loopback Postgres
#   NEON_LOCAL_FETCH_ENDPOINT=http://127.0.0.1:<port>/sql   bun scripts/ci/neon-sql-shim.ts
#   PSQL="docker exec -i <container> psql -U <user> -d <db>"  (or a local psql)
#   CP=http://127.0.0.1:8799   a running `wrangler dev --port 8799 --var DATABASE_URL:... --var NEON_LOCAL_FETCH_ENDPOINT:...`
set -euo pipefail
: "${PSQL:?}" "${CP:=http://127.0.0.1:8799}"
curl -sf "$CP/health" >/dev/null || { echo "control plane not up at $CP"; exit 1; }
KEY="bld_$(uuidgen | tr -d - | tr A-Z a-z)"; HASH=$(printf %s "$KEY" | shasum -a 256 | cut -d' ' -f1); S=$(date +%s%N)
read -r WS TASK < <($PSQL -tA -v ON_ERROR_STOP=1 <<SQL
WITH t AS (INSERT INTO teams (name, slug) VALUES ('cp-$S','cp-$S') RETURNING id),
w AS (INSERT INTO workspaces (name, team_id, access_mode) SELECT 'cp-ws-$S', id, 'open' FROM t RETURNING id, team_id),
a AS (INSERT INTO accounts (type, name, api_key, team_id, level) SELECT 'service', 'cp-runner-$S', '$HASH', team_id, 'worker' FROM w RETURNING id),
k AS (INSERT INTO tasks (workspace_id, title, status) SELECT id, 'control-plane e2e task', 'pending' FROM w RETURNING id)
SELECT (SELECT id FROM w) || ' ' || (SELECT id FROM k);
SQL
)
auth=(-H "authorization: Bearer $KEY" -H 'content-type: application/json')
WID=$(curl -sf -X POST "$CP/api/workers/claim" "${auth[@]}" -d "{\"workspaceId\":\"$WS\",\"runner\":\"cp-e2e\",\"maxTasks\":1}" | python3 -c "import json,sys;print(json.load(sys.stdin)['workers'][0]['id'])")
curl -sf -o /dev/null -X PATCH "$CP/api/workers/$WID" "${auth[@]}" -d '{"status":"running","currentAction":"working through the control plane"}'
curl -sf -o /dev/null -X PATCH "$CP/api/workers/$WID" "${auth[@]}" -d '{"status":"completed","summary":"done through the control plane"}'
STATE=$($PSQL -tAc "select t.status||'/'||w.status||'/'||w.runner from tasks t join workers w on w.task_id=t.id where t.id='$TASK'")
[ "$STATE" = "completed/completed/cp-e2e" ] || { echo "FAIL: $STATE"; exit 1; }
echo "PASS: claim, heartbeat and completion through the control plane ($STATE)"
