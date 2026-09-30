#!/usr/bin/env bash
# Local smoke for the dispatcher Worker + WorkerAgent on local Docker.
#
#   bash apps/cloud-runner/scripts/local-smoke.sh
#
# Runs `wrangler dev` (which builds apps/runner/Dockerfile.once for
# linux/amd64 and runs the container on local Docker), dispatches a random
# task ID, and checks that the agent records the runner's exit.
#
# BUILDD_SERVER is http://127.0.0.1:9 *inside the container*: its own
# loopback, where nothing listens. The runner cannot fetch the task and exits
# 1, so the expected result is `status: exited, outcome: failed`. Nothing here
# can reach a real buildd server; the API key is a dummy.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-8799}"
BASE="http://127.0.0.1:$PORT"
TOKEN="smoke-token-$RANDOM$RANDOM"
TASK="smoke-$RANDOM$RANDOM"
READY_TIMEOUT_S="${READY_TIMEOUT_S:-2400}"   # first run builds the image under emulation on arm64
RUN_TIMEOUT_S="${RUN_TIMEOUT_S:-900}"
LOG="${LOG:-$(mktemp -t cloud-runner-smoke.XXXXXX)}"
fail=0

cd "$DIR"
echo "== wrangler dev on :$PORT (log: $LOG)"
bunx wrangler dev --port "$PORT" --ip 127.0.0.1 \
  --var "DISPATCH_TOKEN:$TOKEN" \
  --var "BUILDD_API_KEY:bld_smoke_not_a_real_key" \
  --var "BUILDD_SERVER:http://127.0.0.1:9" \
  --var "CONTAINER_START_TIMEOUT_MS:600000" \
  >"$LOG" 2>&1 &
WRANGLER_PID=$!
# The Worker's containers and wrangler's egress proxy sidecar are named
# workerd-<worker>-WorkerAgent-*.
task_containers() { docker ps --format '{{.Names}}' | grep '^workerd-buildd-cloud-runner-WorkerAgent-' | grep -v -- '-proxy$' || true; }
cleanup() {
  # SIGINT is wrangler's graceful stop; it removes the containers it started.
  kill -INT "$WRANGLER_PID" 2>/dev/null || true
  wait "$WRANGLER_PID" 2>/dev/null || true
  docker ps -q --filter name=workerd-buildd-cloud-runner- | xargs -r docker rm -f >/dev/null 2>&1 || true
}
trap cleanup EXIT

auth=(-H "Authorization: Bearer $TOKEN")
code_of() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
check() { # label want got
  if [ "$2" = "$3" ]; then echo "   PASS $1 ($3)"; else echo "   FAIL $1: got $3, want $2"; fail=1; fi
}
field() { bun -e "const s=JSON.parse(process.argv[1]); const v=s[process.argv[2]]; console.log(v===undefined||v===null?'':v)" "$1" "$2"; }

echo "== waiting for the Worker (up to ${READY_TIMEOUT_S}s)"
for ((i = 0; i < READY_TIMEOUT_S; i += 5)); do
  if ! kill -0 "$WRANGLER_PID" 2>/dev/null; then echo "   wrangler exited early:"; tail -40 "$LOG"; exit 1; fi
  [ "$(code_of "$BASE/")" = 404 ] && break
  sleep 5
done
[ "$(code_of "$BASE/")" = 404 ] || { echo "   Worker never came up"; tail -40 "$LOG"; exit 1; }
echo "   up after ~${i}s"

echo "== auth and validation"
check "no token -> 401" 401 "$(code_of -X POST "$BASE/dispatch" -d "{\"taskId\":\"$TASK\"}")"
check "bad body -> 400" 400 "$(code_of -X POST "${auth[@]}" "$BASE/dispatch" -d '{"taskId":"--help"}')"

post_dispatch() {
  curl -s -X POST "${auth[@]}" -H 'Content-Type: application/json' "$BASE/dispatch" \
    -d "{\"event\":\"task_created\",\"taskId\":\"$TASK\",\"workspaceId\":\"smoke\",\"missionId\":null,\"backend\":null,\"roleSlug\":null}"
}
wait_exited() {
  local s status
  for ((j = 0; j < RUN_TIMEOUT_S; j += 3)); do
    s="$(curl -s "${auth[@]}" "$BASE/tasks/$TASK")"
    status="$(field "$s" status)"
    [ "$status" = exited ] && { echo "$s"; return 0; }
    sleep 3
  done
  echo "$s"; return 1
}

echo "== dispatch $TASK (attempt 1)"
r1="$(post_dispatch)"; echo "   $r1"
check "first dispatch accepted" true "$(field "$r1" accepted)"
r2="$(post_dispatch)"; echo "   $r2"
check "duplicate while live is a no-op" false "$(field "$r2" accepted)"

echo "== waiting for the run to exit (up to ${RUN_TIMEOUT_S}s)"
s="$(wait_exited)" || { echo "   FAIL never exited: $s"; fail=1; }
echo "   last runner line: $(bun -e 'const t=JSON.parse(process.argv[1]).outputTail??[]; console.log(t.filter(l=>l.startsWith("[once]")).at(-1)??"")' "$s")"
check "status" exited "$(field "$s" status)"
check "exitCode" 1 "$(field "$s" exitCode)"
check "outcome" failed "$(field "$s" outcome)"
check "attempt" 1 "$(field "$s" attempt)"

echo "== dispatch again after exit (attempt 2, buildd's retry path)"
r3="$(post_dispatch)"; echo "   $r3"
check "attempt 2 accepted" 2 "$(field "$r3" attempt)"
s="$(wait_exited)" || { echo "   FAIL attempt 2 never exited: $s"; fail=1; }
check "attempt 2 outcome" failed "$(field "$s" outcome)"

echo "== crash path: kill the container mid-run"
TASK="$TASK-crash"
r4="$(post_dispatch)"; echo "   $r4"
victim=""
for ((k = 0; k < 600; k++)); do victim="$(task_containers | head -1)"; [ -n "$victim" ] && break; sleep 0.1; done
if [ -n "$victim" ]; then
  docker kill "$victim" >/dev/null
  s="$(wait_exited)" || { echo "   FAIL crashed run never exited: $s"; fail=1; }
  check "killed container -> crashed" crashed "$(field "$s" outcome)"
  # Killed before the claim, so there is no worker to mark failed.
  check "crash report" no_worker_id "$(field "$s" crashReport)"
else
  echo "   FAIL no task container appeared"; fail=1
fi

echo "== task containers left running (the agent destroys its container after each run)"
sleep 2
left="$(task_containers | grep -c . || true)"
check "no task container left running" 0 "$left"

if [ "$fail" = 0 ]; then echo "== local smoke PASSED"; else echo "== local smoke FAILED (wrangler log: $LOG)"; fi
exit "$fail"
