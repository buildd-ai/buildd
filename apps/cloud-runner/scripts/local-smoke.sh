#!/usr/bin/env bash
# Local smoke for the dispatcher Worker + WorkerAgent on local Docker.
#
#   bash apps/cloud-runner/scripts/local-smoke.sh
#
# Runs `wrangler dev` (which builds apps/runner/Dockerfile.once for
# linux/amd64 and runs the container on local Docker), dispatches a random
# task ID, and checks that the agent records the runner's exit.
#
# BUILDD_SERVER is a fake buildd this script runs on the host (reached from
# the container as host.docker.internal). It answers 404 to everything, so the
# runner cannot fetch the task and exits 1: the expected result is
# `status: exited, outcome: failed`. For one task ID it holds the task fetch
# open for a while, which keeps a container alive long enough to check the
# egress rewrite from inside it. Nothing here can reach a real buildd server;
# the API key and gateway token are dummies, and EGRESS_DEBUG_ECHO=1 makes the
# egress handler answer with the rewritten request instead of forwarding it.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-8799}"
BASE="http://127.0.0.1:$PORT"
TOKEN="smoke-token-$RANDOM$RANDOM"
TASK="smoke-$RANDOM$RANDOM"
READY_TIMEOUT_S="${READY_TIMEOUT_S:-2400}"   # first run builds the image under emulation on arm64
RUN_TIMEOUT_S="${RUN_TIMEOUT_S:-900}"
LOG="${LOG:-$(mktemp -t cloud-runner-smoke.XXXXXX)}"
FAKE_PORT="${FAKE_PORT:-8798}"
# How the container reaches the host. Docker Desktop provides this name.
HOST_ADDR="${SMOKE_HOST_ADDR:-host.docker.internal}"
EGRESS_TASK="$TASK-egress"
EGRESS_HOLD_S="${EGRESS_HOLD_S:-90}"
GW_TOKEN="smoke-gateway-token-$RANDOM$RANDOM"
fail=0

cd "$DIR"
echo "== fake buildd on :$FAKE_PORT (404 for everything; holds GET /api/tasks/$EGRESS_TASK for ${EGRESS_HOLD_S}s)"
EGRESS_TASK="$EGRESS_TASK" EGRESS_HOLD_S="$EGRESS_HOLD_S" FAKE_PORT="$FAKE_PORT" bun -e '
  const hold = `/api/tasks/${process.env.EGRESS_TASK}`;
  Bun.serve({ port: Number(process.env.FAKE_PORT), hostname: "0.0.0.0", idleTimeout: 0, async fetch(req) {
    if (new URL(req.url).pathname === hold) await Bun.sleep(Number(process.env.EGRESS_HOLD_S) * 1000);
    return new Response("{\"error\":\"not found\"}", { status: 404, headers: { "content-type": "application/json" } });
  } });
' >"$LOG.fake" 2>&1 &
FAKE_PID=$!

echo "== wrangler dev on :$PORT (log: $LOG)"
bunx wrangler dev --port "$PORT" --ip 127.0.0.1 \
  --var "DISPATCH_TOKEN:$TOKEN" \
  --var "BUILDD_API_KEY:bld_smoke_not_a_real_key" \
  --var "BUILDD_SERVER:http://$HOST_ADDR:$FAKE_PORT" \
  --var "CONTAINER_START_TIMEOUT_MS:600000" \
  --var "AI_GATEWAY_ACCOUNT_ID:smokeacct" \
  --var "AI_GATEWAY_ID:smokegw" \
  --var "AI_GATEWAY_TOKEN:$GW_TOKEN" \
  --var "EGRESS_DEBUG_ECHO:1" \
  >"$LOG" 2>&1 &
WRANGLER_PID=$!
# The Worker's containers and wrangler's egress proxy sidecar are named
# workerd-<worker>-WorkerAgent-*.
task_containers() { docker ps --format '{{.Names}}' | grep '^workerd-buildd-cloud-runner-WorkerAgent-' | grep -v -- '-proxy$' || true; }
cleanup() {
  # SIGINT is wrangler's graceful stop; it removes the containers it started.
  kill -INT "$WRANGLER_PID" 2>/dev/null || true
  wait "$WRANGLER_PID" 2>/dev/null || true
  kill "$FAKE_PID" 2>/dev/null || true
  wait "$FAKE_PID" 2>/dev/null || true
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
fp() { bun -e 'const d=new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(process.argv[1]))); console.log("sha256:"+Array.from(d.slice(0,8),b=>b.toString(16).padStart(2,"0")).join(""))' "$1"; }
echo_field() { bun -e 'const s=JSON.parse(process.argv[1]); const v=process.argv[2].split(".").reduce((o,k)=>o==null?o:o[k],s); console.log(v===undefined||v===null?"":v)' "$1" "$2"; }
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

echo "== egress rewrite, from inside a live task container"
TASK="$EGRESS_TASK"
r5="$(post_dispatch)"; echo "   $r5"
c=""
for ((k = 0; k < 600; k++)); do c="$(task_containers | head -1)"; [ -n "$c" ] && break; sleep 0.2; done
if [ -z "$c" ]; then
  echo "   FAIL no task container appeared"; fail=1
else
  # buildd-once waits for the platform CA and builds the combined bundle.
  for ((k = 0; k < 60; k++)); do docker exec "$c" test -s /tmp/buildd-ca-bundle.pem 2>/dev/null && break; sleep 0.5; done
  cenv="$(docker exec "$c" cat /proc/1/environ | tr '\0' '\n')"
  check "container env has the cloud marker" cloud "$(printf '%s\n' "$cenv" | sed -n 's/^BUILDD_EXECUTOR=//p')"
  check "container env holds no gateway token" 0 "$(printf '%s\n' "$cenv" | grep -c -F "$GW_TOKEN" || true)"
  check "container env holds no GitHub token" 0 "$(printf '%s\n' "$cenv" | grep -c -E '^(GH_TOKEN|GITHUB_TOKEN)=' || true)"
  check "CA bundle built by buildd-once" yes "$(docker exec "$c" sh -c 'test -s /tmp/buildd-ca-bundle.pem && echo yes || echo no')"

  # curl through the combined bundle (what git/gh use), with container-supplied credentials.
  a="$(docker exec "$c" curl -sS --cacert /tmp/buildd-ca-bundle.pem -X POST \
        -H 'x-api-key: sk-ant-container-supplied' -H 'authorization: Bearer container-supplied' \
        -H 'content-type: application/json' https://api.anthropic.com/v1/messages?beta=true -d '{}' 2>&1)"
  echo "   anthropic echo: $a"
  check "anthropic -> AI Gateway URL" "https://gateway.ai.cloudflare.com/v1/smokeacct/smokegw/anthropic/v1/messages?beta=true" "$(echo_field "$a" url)"
  check "gateway credential set (by fingerprint)" "$(fp "Bearer $GW_TOKEN")" "$(echo_field "$a" headers.cf-aig-authorization)"
  check "container x-api-key stripped" "" "$(echo_field "$a" headers.x-api-key)"
  check "container authorization stripped" "" "$(echo_field "$a" headers.authorization)"

  # Bun (the runner, and Claude Code) trusting the CA through NODE_EXTRA_CA_CERTS.
  b="$(docker exec -e NODE_EXTRA_CA_CERTS=/etc/cloudflare/certs/cloudflare-containers-ca.crt "$c" \
        bun -e 'const r=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",headers:{"x-api-key":"sk-ant-container-supplied"},body:"{}"}); console.log(await r.text())' 2>&1)"
  check "bun fetch reaches the handler via NODE_EXTRA_CA_CERTS" "https://gateway.ai.cloudflare.com/v1/smokeacct/smokegw/anthropic/v1/messages" "$(echo_field "$b" url)"

  # GitHub: no grant (the fake buildd refuses the token request), so container
  # auth is stripped and nothing is added.
  g="$(docker exec "$c" curl -sS --cacert /tmp/buildd-ca-bundle.pem \
        -H 'authorization: Basic Y29udGFpbmVyLXN1cHBsaWVk' https://github.com/acme/widget.git/info/refs?service=git-upload-pack 2>&1)"
  echo "   github echo: $g"
  check "github: container authorization stripped" "" "$(echo_field "$g" headers.authorization)"
  check "github: nothing injected without a grant" none "$(echo_field "$g" injected)"

  p="$(docker exec "$c" curl -sS -o /dev/null -w '%{http_code}' http://api.anthropic.com/v1/messages 2>&1)"
  check "plain http to a credentialed host refused" 403 "$p"
fi
s="$(wait_exited)" || { echo "   FAIL egress run never exited: $s"; fail=1; }
check "egress run outcome" failed "$(field "$s" outcome)"

echo "== task containers left running (the agent destroys its container after each run)"
sleep 2
left="$(task_containers | grep -c . || true)"
check "no task container left running" 0 "$left"

if [ "$fail" = 0 ]; then echo "== local smoke PASSED"; else echo "== local smoke FAILED (wrangler log: $LOG)"; fi
exit "$fail"
