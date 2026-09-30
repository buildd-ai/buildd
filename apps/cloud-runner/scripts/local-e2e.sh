#!/usr/bin/env bash
# Local end-to-end test of the cloud runner. No Cloudflare account needed.
#
#   bun run cloud-runner:local                     # from the repo root
#   ANTHROPIC_API_KEY=sk-ant-… bun run cloud-runner:local   # also run the model step
#
# What it does, all on this machine:
#   1. Disposable Postgres + Neon HTTP proxy + soketi (scripts/demo/docker-compose.yml,
#      its own compose project and ports), migrated from packages/core/drizzle.
#   2. The real web app (production build, `next start`) against it, from an empty
#      env (scripts/demo/serve.sh): no .env file is read, nothing points off-box.
#   3. Seeds a team, an open workspace, an admin key and a worker-level runner key.
#   4. `wrangler dev` for apps/cloud-runner: the dispatcher Worker, with task
#      containers on local Docker, BUILDD_SERVER = the local web app as seen from
#      inside Docker (host.docker.internal).
#   5. Points the workspace at the Worker through PATCH /api/workspaces/:id
#      (webhookConfig, what deploy.ts does), creates a task through POST /api/tasks,
#      and lets buildd's own webhook dispatch reach POST /dispatch.
#   6. Waits for the container run to end and checks the claim, the worker and the
#      task's final state in buildd.
#
# ANTHROPIC_API_KEY is optional and only passed through (a temp env file, mode
# 600, deleted at exit) to the local Worker as ANTHROPIC_DIRECT_API_KEY with
# ALLOW_DIRECT_ANTHROPIC=1, so the egress handler forwards model calls straight
# to Anthropic instead of AI Gateway. The container itself never holds the key.
# Without it the model call cannot
# succeed, so the script asserts up to "claimed + worker started" and says the
# model step was skipped.
#
# Tear-down runs on every exit. Knobs: CLOUD_E2E_REUSE_BUILD=1 skips `next build`
# when a build from this checkout exists; *_TIMEOUT_S bound each wait.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CR_DIR="$ROOT/apps/cloud-runner"

# Own ports so a running demo stack (or a real dev server) is never touched.
export DEMO_PG_PORT="${CLOUD_E2E_PG_PORT:-55632}"
export DEMO_NEON_PORT="${CLOUD_E2E_NEON_PORT:-54644}"
export DEMO_SOKETI_PORT="${CLOUD_E2E_SOKETI_PORT:-56201}"
export DEMO_APP_PORT="${CLOUD_E2E_APP_PORT:-3317}"
export DEMO_S3_PORT="${CLOUD_E2E_S3_PORT:-59200}"
WORKER_PORT="${CLOUD_E2E_WORKER_PORT:-8899}"
RUN_TIMEOUT_S="${RUN_TIMEOUT_S:-1200}"
READY_TIMEOUT_S="${READY_TIMEOUT_S:-2400}"
DISPATCH_TIMEOUT_S="${DISPATCH_TIMEOUT_S:-60}"

# Loopback-only env, fail-closed (refuses a non-local DATABASE_URL).
# shellcheck source=../../../scripts/demo/env.sh
source "$ROOT/scripts/demo/env.sh"
export DEMO_LOG="${TMPDIR:-/tmp}/buildd-cloud-e2e-web.log"
export DEMO_PID_FILE="${TMPDIR:-/tmp}/buildd-cloud-e2e-web.pid"

APP="http://localhost:$DEMO_APP_PORT"
WORKER="http://127.0.0.1:$WORKER_PORT"
COMPOSE=(docker compose -p buildd-cloud-e2e -f "$ROOT/scripts/demo/docker-compose.yml")
WRANGLER_LOG="$(mktemp -t cloud-e2e-wrangler.XXXXXX)"
DEV_ENV_FILE="$(mktemp -t cloud-e2e-vars.XXXXXX)"
chmod 600 "$DEV_ENV_FILE"
WRANGLER_PID=""
fail=0

step() { echo; echo "== $*"; }
check() { # label want got
  if [ "$2" = "$3" ]; then echo "   PASS $1 ($3)"; else echo "   FAIL $1: got '$3', want '$2'"; fail=1; fi
}
field() { bun --no-env-file -e 'const s=JSON.parse(process.argv[1]); const v=process.argv[2].split(".").reduce((o,k)=>o==null?o:o[k], s); console.log(v===undefined||v===null?"":typeof v==="object"?JSON.stringify(v):v)' "$1" "$2"; }

cleanup() {
  local code=$?
  step "tear-down"
  if [ -n "$WRANGLER_PID" ]; then
    kill -INT "$WRANGLER_PID" 2>/dev/null || true
    wait "$WRANGLER_PID" 2>/dev/null || true
  fi
  docker ps -q --filter name=workerd-buildd-cloud-runner- | xargs -r docker rm -f >/dev/null 2>&1 || true
  "$ROOT/scripts/demo/serve.sh" --stop >/dev/null 2>&1 || true
  "${COMPOSE[@]}" down -v >/dev/null 2>&1 || true
  rm -f "$DEV_ENV_FILE"
  echo "   stopped wrangler, web app and database (logs: $WRANGLER_LOG, $DEMO_LOG)"
  exit "$code"
}
trap cleanup EXIT

step "database: postgres + neon proxy on 127.0.0.1:$DEMO_PG_PORT / :$DEMO_NEON_PORT"
"${COMPOSE[@]}" up -d --wait postgres >/dev/null 2>&1
"${COMPOSE[@]}" up -d neon-proxy soketi >/dev/null 2>&1
for i in $(seq 1 60); do
  curl -s -o /dev/null -X POST "$NEON_LOCAL_FETCH_ENDPOINT" && break
  sleep 1
  [ "$i" = 60 ] && { echo "   neon proxy never came up"; exit 1; }
done
echo "   up"

step "migrate"
(cd "$ROOT/packages/core" && env -i "HOME=$HOME" "PATH=$PATH" "DATABASE_URL=$DATABASE_URL" \
  "NEON_LOCAL_FETCH_ENDPOINT=$NEON_LOCAL_FETCH_ENDPOINT" bun --no-env-file run db/migrate.ts 2>&1 | tail -3)

step "web app on $APP (production build; a few minutes the first time)"
if [ -z "${CLOUD_E2E_REUSE_BUILD:-}" ]; then export DEMO_REBUILD=1; fi
"$ROOT/scripts/demo/serve.sh" --bg

step "seed: team, workspace, admin key, runner key"
seed_out="$(cd "$ROOT" && env -i "HOME=$HOME" "PATH=$PATH" "DATABASE_URL=$DATABASE_URL" \
  "NEON_LOCAL_FETCH_ENDPOINT=$NEON_LOCAL_FETCH_ENDPOINT" "DEMO_BASE_URL=$DEMO_BASE_URL" \
  "DEMO_PG_PORT=$DEMO_PG_PORT" "DEMO_NEON_PORT=$DEMO_NEON_PORT" "DEMO_APP_PORT=$DEMO_APP_PORT" \
  "DEMO_SOKETI_PORT=$DEMO_SOKETI_PORT" "DEMO_S3_PORT=$DEMO_S3_PORT" \
  bun --no-env-file run apps/cloud-runner/scripts/local-e2e-seed.ts)"
eval "$seed_out"
echo "   workspace $E2E_WORKSPACE_ID"

step "wrangler dev on $WORKER (first run builds the runner image for linux/amd64)"
DISPATCH_TOKEN="e2e-$(openssl rand -hex 16)"
{
  echo "DISPATCH_TOKEN=$DISPATCH_TOKEN"
  echo "BUILDD_API_KEY=$E2E_RUNNER_KEY"
  echo "BUILDD_SERVER=http://host.docker.internal:$DEMO_APP_PORT"
  echo "CONTAINER_START_TIMEOUT_MS=600000"
  if [ -n "${ANTHROPIC_API_KEY:-}" ]; then echo "ALLOW_DIRECT_ANTHROPIC=1"; echo "ANTHROPIC_DIRECT_API_KEY=$ANTHROPIC_API_KEY"; fi
} >"$DEV_ENV_FILE"
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then MODEL_STEP=1; echo "   ANTHROPIC_API_KEY set: the model step runs"; else MODEL_STEP=0; echo "   ANTHROPIC_API_KEY unset: model step will be skipped"; fi
(cd "$CR_DIR" && exec bunx wrangler dev --port "$WORKER_PORT" --ip 127.0.0.1 --env-file "$DEV_ENV_FILE") >"$WRANGLER_LOG" 2>&1 &
WRANGLER_PID=$!
for ((i = 0; i < READY_TIMEOUT_S; i += 5)); do
  if ! kill -0 "$WRANGLER_PID" 2>/dev/null; then echo "   wrangler exited early:"; tail -40 "$WRANGLER_LOG"; exit 1; fi
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$WORKER/")" = 404 ] && break
  sleep 5
done
[ "$(curl -s -o /dev/null -w '%{http_code}' "$WORKER/")" = 404 ] || { echo "   Worker never came up"; tail -40 "$WRANGLER_LOG"; exit 1; }
echo "   up after ~${i}s"
check "Worker rejects a missing token" 401 "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$WORKER/dispatch" -d '{}')"

admin=(-H "Authorization: Bearer $E2E_ADMIN_KEY" -H 'Content-Type: application/json')

step "point the workspace at the Worker (PATCH webhookConfig, as deploy.ts does)"
code="$(curl -s -o /dev/null -w '%{http_code}' -X PATCH "${admin[@]}" "$APP/api/workspaces/$E2E_WORKSPACE_ID" \
  -d "{\"webhookConfig\":{\"url\":\"$WORKER/dispatch\",\"token\":\"$DISPATCH_TOKEN\",\"enabled\":true}}")"
check "PATCH webhookConfig" 200 "$code"
hook="$(curl -s "${admin[@]}" "$APP/api/workspaces" | bun --no-env-file -e "const w=JSON.parse(await Bun.stdin.text()).workspaces.find(w=>w.id===process.argv[1]); console.log(JSON.stringify(w?.webhookConfig??null))" "$E2E_WORKSPACE_ID")"
echo "   listed webhookConfig: $hook"
check "webhook url" "$WORKER/dispatch" "$(field "$hook" url)"
check "token masked in listings" true "$(field "$hook" hasToken)"

step "create a task (buildd's webhook dispatch should reach the Worker)"
task="$(curl -s -X POST "${admin[@]}" "$APP/api/tasks" -d "{\"workspaceId\":\"$E2E_WORKSPACE_ID\",\"title\":\"Reply with OK\",\"description\":\"Reply with the single word OK. Do not read, create or edit any files, and do not run any commands.\",\"outputRequirement\":\"none\"}")"
TASK_ID="$(field "$task" id)"
[ -n "$TASK_ID" ] || { echo "   FAIL task not created: $task"; exit 1; }
echo "   task $TASK_ID"

auth=(-H "Authorization: Bearer $DISPATCH_TOKEN")
dispatched_by=""
for ((i = 0; i < DISPATCH_TIMEOUT_S; i += 2)); do
  s="$(curl -s "${auth[@]}" "$WORKER/tasks/$TASK_ID")"
  if [ "$(field "$s" attempt)" != "" ] && [ "$(field "$s" attempt)" != 0 ]; then dispatched_by=webhook; break; fi
  sleep 2
done
if [ -z "$dispatched_by" ]; then
  echo "   the webhook did not reach the Worker within ${DISPATCH_TIMEOUT_S}s; dispatching by hand"
  grep -i "webhook" "$DEMO_LOG" | tail -5 || true
  curl -s -X POST "${auth[@]}" -H 'Content-Type: application/json' "$WORKER/dispatch" \
    -d "{\"event\":\"task.created\",\"taskId\":\"$TASK_ID\",\"workspaceId\":\"$E2E_WORKSPACE_ID\"}"; echo
  dispatched_by=manual
fi
check "dispatched by buildd's webhook" webhook "$dispatched_by"

step "wait for the container run to end (up to ${RUN_TIMEOUT_S}s)"
for ((i = 0; i < RUN_TIMEOUT_S; i += 5)); do
  s="$(curl -s "${auth[@]}" "$WORKER/tasks/$TASK_ID")"
  [ "$(field "$s" status)" = exited ] && break
  sleep 5
done
echo "   agent state: status=$(field "$s" status) exitCode=$(field "$s" exitCode) outcome=$(field "$s" outcome) workerId=$(field "$s" workerId)"
echo "   runner output (tail):"
bun --no-env-file -e 'for (const l of JSON.parse(process.argv[1]).outputTail ?? []) console.log("     | " + l)' "$s"

WORKER_ID="$(field "$s" workerId)"
check "run exited" exited "$(field "$s" status)"
check "runner claimed the task (BUILDD_WORKER_ID seen)" yes "$([ -n "$WORKER_ID" ] && echo yes || echo no)"
started="$(bun --no-env-file -e 'console.log((JSON.parse(process.argv[1]).outputTail ?? []).some(l => /\[once\] worker .* started for task/.test(l)) ? "yes" : "no")' "$s")"
# The tail keeps the last lines only; a long run can scroll the start line out.
if [ "$started" = no ] && [ -n "$WORKER_ID" ]; then started=yes; fi
check "worker started" yes "$started"
# "Started" is not enough: a run that fails before the agent session exists
# (clone, worktree, install) must not count. The full per-task output is in the
# wrangler log, not just the tail.
setup_fail="$(grep -F "[task $TASK_ID]" "$WRANGLER_LOG" | grep -E 'Session failed to start|Worktree setup failed|could not clone|Cannot resolve workspace' | head -3 || true)"
check "agent session started (no clone/worktree/setup failure)" "" "$setup_fail"

t="$(curl -s "${admin[@]}" "$APP/api/tasks/$TASK_ID")"
TASK_STATUS="$(field "$t" status)"
if [ -z "$TASK_STATUS" ]; then TASK_STATUS="$(field "$t" task.status)"; fi
echo "   buildd task status: $TASK_STATUS"

if [ "$MODEL_STEP" = 1 ]; then
  step "model step"
  check "exit code" 0 "$(field "$s" exitCode)"
  check "outcome" done "$(field "$s" outcome)"
  check "task completed in buildd" completed "$TASK_STATUS"
else
  step "model step: SKIPPED (no ANTHROPIC_API_KEY). The run cannot reach the model with the placeholder key,"
  echo "   so exit $(field "$s" exitCode) / outcome $(field "$s" outcome) is expected. Checked up to claimed + worker started."
  echo "   how the session ended (model-auth errors expected here):"
  grep -F "[task $TASK_ID]" "$WRANGLER_LOG" | grep -iE 'api key|x-api-key|401|authenticat|invalid|error' | tail -4 | sed 's/^/     | /' || true
fi

echo
if [ "$fail" = 0 ]; then echo "== cloud runner local e2e PASSED$([ "$MODEL_STEP" = 0 ] && echo ' (model step skipped)')"; else echo "== cloud runner local e2e FAILED"; fi
exit "$fail"
