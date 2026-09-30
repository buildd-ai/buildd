#!/usr/bin/env bash
# Local smoke for the dispatcher Worker + WorkerAgent on local Docker.
#
#   bash apps/cloud-runner/scripts/local-smoke.sh
#   SMOKE_MODEL_ROUTE=proxy bash apps/cloud-runner/scripts/local-smoke.sh
#
# SMOKE_MODEL_ROUTE=proxy also sets MODEL_PROXY_URL/MODEL_PROXY_KEY (to a
# dummy https://litellm.example.com/anthropic) alongside the gateway vars, and
# checks that model traffic goes to the proxy instead: the proxy route wins.
#
# Runs `wrangler dev` (which builds apps/runner/Dockerfile.once for
# linux/amd64 and runs the container on local Docker), dispatches a random
# task ID, and checks that the agent records the runner's exit.
#
# BUILDD_SERVER is a fake buildd this script runs on the host (reached from
# the container as host.docker.internal). It answers 404 to almost everything,
# so the runner cannot fetch the task and exits 1: the expected result is
# `status: exited, outcome: failed`. For one task ID it holds the task fetch
# open for a while, which keeps a container alive long enough to check the
# egress rewrite from inside it. For another it serves the task and a claim;
# the repo clone goes through the echoing egress handler and comes back empty,
# which is enough for the runner to print its clone phase lines and its
# BUILDD_WORKER_ID, so the agent tries to deliver the run report. It accepts run report
# artifact POSTs (`POST /api/workers/<id>/artifacts`) and logs their keys.
# Warm repos (WARM_REPOS=1, local R2 simulation in a throwaway --persist-to
# dir): two more tasks of one workspace clone a real repo the fake buildd
# serves over git's dumb HTTP. The first finds no snapshot, clones and seeds
# one; the second restores from it instead of cloning. The fake answers the
# GitHub-token request (which carries the workspace ID the snapshot keys come
# from) only for these two tasks, and the Worker must reach the fake buildd
# for that: set SMOKE_HOST_ADDR to an address both this host and the
# containers reach (on Docker Desktop, the host's LAN address), or the warm
# case is skipped with a note.
# Every run is checked for the run report recorded in `GET /tasks/:id`. Nothing here can reach a real buildd server;
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
CLONE_TASK="$TASK-clone"
WARM_TASK_1="$TASK-warm1"
WARM_TASK_2="$TASK-warm2"
WARM_WS="smoke-ws-warm"
STATE_DIR="$(mktemp -d -t cloud-runner-smoke-state.XXXXXX)"
GIT_DIR_ROOT="$(mktemp -d -t cloud-runner-smoke-git.XXXXXX)"
EGRESS_HOLD_S="${EGRESS_HOLD_S:-90}"
GW_TOKEN="smoke-gateway-token-$RANDOM$RANDOM"
MODEL_ROUTE="${SMOKE_MODEL_ROUTE:-gateway}"
PROXY_BASE="https://litellm.example.com/anthropic"
PROXY_KEY="smoke-proxy-key-$RANDOM$RANDOM"
# Telemetry: an https collector (never contacted: the handler echoes) and its
# credential, a Worker secret the egress handler adds for that origin only.
OTLP_ENDPOINT="https://otel.example.com"
OTLP_HEADER="x-otlp-key"
OTLP_KEY="smoke-otlp-key-$RANDOM$RANDOM"
proxy_vars=()
case "$MODEL_ROUTE" in
  gateway) ;;
  proxy) proxy_vars=(--var "MODEL_PROXY_URL:$PROXY_BASE/" --var "MODEL_PROXY_KEY:$PROXY_KEY") ;;
  *) echo "SMOKE_MODEL_ROUTE must be gateway or proxy"; exit 2 ;;
esac
fail=0

cd "$DIR"
# A small repo the containers can clone without GitHub: git's dumb HTTP
# protocol is plain static files, which the fake buildd serves under /git/.
(
  set -e
  src="$GIT_DIR_ROOT/src"; git init -q -b main "$src"
  printf 'hello from the warm-repo smoke\n' > "$src/README.md"
  git -C "$src" add README.md
  git -C "$src" -c user.email=smoke@example.com -c user.name=smoke commit -qm 'smoke: initial commit'
  git clone -q --bare "$src" "$GIT_DIR_ROOT/widget.git"
  git -C "$GIT_DIR_ROOT/widget.git" symbolic-ref HEAD refs/heads/main
  git -C "$GIT_DIR_ROOT/widget.git" update-server-info
)
echo "== fake buildd on :$FAKE_PORT (404 for most; holds GET /api/tasks/$EGRESS_TASK for ${EGRESS_HOLD_S}s; serves $CLONE_TASK and its claim)"
EGRESS_TASK="$EGRESS_TASK" CLONE_TASK="$CLONE_TASK" EGRESS_HOLD_S="$EGRESS_HOLD_S" FAKE_PORT="$FAKE_PORT" \
WARM_TASKS="$WARM_TASK_1,$WARM_TASK_2" WARM_WS="$WARM_WS" GIT_DIR_ROOT="$GIT_DIR_ROOT" HOST_ADDR="$HOST_ADDR" bun -e '
  const hold = `/api/tasks/${process.env.EGRESS_TASK}`;
  const cloneTask = process.env.CLONE_TASK;
  const task = { id: cloneTask, title: "smoke clone", description: "", workspaceId: "smoke-ws", status: "pending",
    workspace: { id: "smoke-ws", name: "smoke-widget", repo: "https://github.com/acme/widget.git" } };
  const warmTasks = process.env.WARM_TASKS.split(",");
  const warmWs = process.env.WARM_WS;
  const warmRepo = `http://${process.env.HOST_ADDR}:${process.env.FAKE_PORT}/git/widget.git`;
  const warmTask = (id) => ({ id, title: "smoke warm", description: "", workspaceId: warmWs, status: "pending",
    workspace: { id: warmWs, name: "smoke-warm", repo: warmRepo } });
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  Bun.serve({ port: Number(process.env.FAKE_PORT), hostname: "0.0.0.0", idleTimeout: 0, async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === hold) await Bun.sleep(Number(process.env.EGRESS_HOLD_S) * 1000);
    if (req.method === "GET" && path.startsWith("/git/") && !path.includes("..")) {
      const f = Bun.file(`${process.env.GIT_DIR_ROOT}/${path.slice(5)}`);
      if (await f.exists()) { console.log(`GIT_GET ${path}`); return new Response(f); }
      return new Response("not found", { status: 404 });
    }
    if (req.method === "GET" && path === `/api/tasks/${cloneTask}`) return json(task);
    const warmId = warmTasks.find((t) => path === `/api/tasks/${t}`);
    if (req.method === "GET" && warmId) return json(warmTask(warmId));
    if (req.method === "POST" && path === "/api/runner/github-token") {
      // Only the warm tasks get a grant, and with it the workspace ID the
      // snapshot keys come from. The token is a dummy: nothing here talks to GitHub.
      const body = await req.json().catch(() => ({}));
      console.log(`GITHUB_TOKEN_REQUEST task=${body.taskId} dispatch_token=${req.headers.get("x-buildd-dispatch-token") ? "set" : "missing"}`);
      if (warmTasks.includes(body.taskId)) {
        return json({ token: "ghs_smoke_dummy", expiresAt: new Date(Date.now() + 3600e3).toISOString(),
          repository: { owner: "acme", name: "widget", fullName: "acme/widget" }, workspaceId: warmWs });
      }
      return json({ error: "no" }, 409);
    }
    if (req.method === "POST" && path === "/api/workers/claim") {
      const body = await req.json().catch(() => ({}));
      if (body.taskId === cloneTask) return json({ workers: [{ id: "smoke-worker-clone", taskId: cloneTask, branch: "buildd/smoke", task }] });
      const w = warmTasks.indexOf(body.taskId);
      if (w >= 0) return json({ workers: [{ id: `smoke-worker-warm${w + 1}`, taskId: body.taskId, branch: `buildd/smoke-warm${w + 1}`, task: warmTask(body.taskId) }] });
    }
    if (req.method === "POST" && /^\/api\/workers\/[^/]+\/artifacts$/.test(path)) {
      const body = await req.json().catch(() => ({}));
      console.log(`ARTIFACT_POST ${path} key=${body.key} type=${body.type}`);
      return json({ artifact: { id: "smoke-artifact" } });
    }
    return json({ error: "not found" }, 404);
  } });
' >"$LOG.fake" 2>&1 &
FAKE_PID=$!

echo "== wrangler dev on :$PORT, model route $MODEL_ROUTE (log: $LOG)"
bunx wrangler dev --port "$PORT" --ip 127.0.0.1 \
  --var "DISPATCH_TOKEN:$TOKEN" \
  --var "BUILDD_API_KEY:bld_smoke_not_a_real_key" \
  --var "BUILDD_SERVER:http://$HOST_ADDR:$FAKE_PORT" \
  --var "CONTAINER_START_TIMEOUT_MS:600000" \
  --var "AI_GATEWAY_ACCOUNT_ID:smokeacct" \
  --var "AI_GATEWAY_ID:smokegw" \
  --var "AI_GATEWAY_TOKEN:$GW_TOKEN" \
  --var "EGRESS_DEBUG_ECHO:1" \
  --var "OTEL_EXPORTER_OTLP_ENDPOINT:$OTLP_ENDPOINT" \
  --var "OTEL_EXPORTER_OTLP_AUTH_HEADER:$OTLP_HEADER" \
  --var "OTEL_EXPORTER_OTLP_AUTH_VALUE:$OTLP_KEY" \
  --var "WARM_REPOS:1" \
  --persist-to "$STATE_DIR" \
  ${proxy_vars[@]+"${proxy_vars[@]}"} \
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
  rm -rf "$STATE_DIR" "$GIT_DIR_ROOT"
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
echo "   run report: $(bun -e 'const r=JSON.parse(process.argv[1]).report??{}; console.log(JSON.stringify({timestamps:r.timestamps,durationsMs:r.durationsMs,instanceType:r.instanceType,containerInstanceId:r.containerInstanceId?"<set>":null,runLabel:r.runLabel,delivery:r.delivery}))' "$s")"
check "report recorded for attempt 1" 1 "$(echo_field "$s" report.attempt)"
check "report outcome" failed "$(echo_field "$s" report.outcome)"
check "report exitCode" 1 "$(echo_field "$s" report.exitCode)"
check "report instance type (from config)" standard-1 "$(echo_field "$s" report.instanceType)"
check "report run label" "$TASK.1" "$(echo_field "$s" report.runLabel)"
check "report container instance id set" yes "$([ -n "$(echo_field "$s" report.containerInstanceId)" ] && echo yes || echo no)"
check "report has dispatch/running/exit timestamps" yes "$(bun -e 'const t=JSON.parse(process.argv[1]).report.timestamps; console.log(t.dispatchReceivedAt>0&&t.containerRunningAt>=t.dispatchReceivedAt&&t.exitedAt>=t.containerRunningAt?"yes":"no")' "$s")"
check "no claim, so nothing delivered" no_worker_id "$(echo_field "$s" report.delivery)"

echo "== dispatch again after exit (attempt 2, buildd's retry path)"
r3="$(post_dispatch)"; echo "   $r3"
check "attempt 2 accepted" 2 "$(field "$r3" attempt)"
s="$(wait_exited)" || { echo "   FAIL attempt 2 never exited: $s"; fail=1; }
check "attempt 2 outcome" failed "$(field "$s" outcome)"
check "attempt 2 report" 2 "$(echo_field "$s" report.attempt)"
check "attempt 1 report kept in history" 1 "$(echo_field "$s" reportHistory.0.attempt)"

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
  check "crashed run's report" crashed "$(echo_field "$s" report.outcome)"
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
  check "container env holds no proxy key or proxy settings" 0 "$(printf '%s\n' "$cenv" | grep -c -e "$PROXY_KEY" -e '^MODEL_PROXY_' || true)"
  check "container env holds no GitHub token" 0 "$(printf '%s\n' "$cenv" | grep -c -E '^(GH_TOKEN|GITHUB_TOKEN)=' || true)"
  check "CA bundle built by buildd-once" yes "$(docker exec "$c" sh -c 'test -s /tmp/buildd-ca-bundle.pem && echo yes || echo no')"

  # curl through the combined bundle (what git/gh use), with container-supplied credentials.
  a="$(docker exec "$c" curl -sS --cacert /tmp/buildd-ca-bundle.pem -X POST \
        -H 'x-api-key: sk-ant-container-supplied' -H 'authorization: Bearer container-supplied' \
        -H 'content-type: application/json' https://api.anthropic.com/v1/messages?beta=true -d '{}' 2>&1)"
  echo "   anthropic echo: $a"
  if [ "$MODEL_ROUTE" = proxy ]; then
    MODEL_URL="$PROXY_BASE/v1/messages"
    check "anthropic -> proxy URL (proxy wins over the gateway)" "$MODEL_URL?beta=true" "$(echo_field "$a" url)"
    check "injected" proxy "$(echo_field "$a" injected)"
    check "proxy credential set as Authorization: Bearer (by fingerprint)" "$(fp "Bearer $PROXY_KEY")" "$(echo_field "$a" headers.authorization)"
    check "no gateway credential sent to the proxy" "" "$(echo_field "$a" headers.cf-aig-authorization)"
    check "container x-api-key stripped" "" "$(echo_field "$a" headers.x-api-key)"
  else
    MODEL_URL="https://gateway.ai.cloudflare.com/v1/smokeacct/smokegw/anthropic/v1/messages"
    check "anthropic -> AI Gateway URL" "$MODEL_URL?beta=true" "$(echo_field "$a" url)"
    check "gateway credential set (by fingerprint)" "$(fp "Bearer $GW_TOKEN")" "$(echo_field "$a" headers.cf-aig-authorization)"
    check "container x-api-key stripped" "" "$(echo_field "$a" headers.x-api-key)"
    check "container authorization stripped" "" "$(echo_field "$a" headers.authorization)"
  fi

  # Bun (the runner, and Claude Code) trusting the CA through NODE_EXTRA_CA_CERTS.
  b="$(docker exec -e NODE_EXTRA_CA_CERTS=/etc/cloudflare/certs/cloudflare-containers-ca.crt "$c" \
        bun -e 'const r=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",headers:{"x-api-key":"sk-ant-container-supplied"},body:"{}"}); console.log(await r.text())' 2>&1)"
  check "bun fetch reaches the handler via NODE_EXTRA_CA_CERTS" "$MODEL_URL" "$(echo_field "$b" url)"

  # GitHub: no grant (the fake buildd refuses the token request), so container
  # auth is stripped and nothing is added.
  g="$(docker exec "$c" curl -sS --cacert /tmp/buildd-ca-bundle.pem \
        -H 'authorization: Basic Y29udGFpbmVyLXN1cHBsaWVk' https://github.com/acme/widget.git/info/refs?service=git-upload-pack 2>&1)"
  echo "   github echo: $g"
  check "github: container authorization stripped" "" "$(echo_field "$g" headers.authorization)"
  check "github: nothing injected without a grant" none "$(echo_field "$g" injected)"

  p="$(docker exec "$c" curl -sS -o /dev/null -w '%{http_code}' http://api.anthropic.com/v1/messages 2>&1)"
  check "plain http to a credentialed host refused" 403 "$p"

  # Telemetry (otel.ts): the container has Claude Code's OTel vars and this
  # dispatch's attributes, never the collector credential; the egress handler
  # adds it for the collector's origin after stripping the container's.
  check "container env enables Claude Code telemetry" 1 "$(printf '%s\n' "$cenv" | sed -n 's/^CLAUDE_CODE_ENABLE_TELEMETRY=//p')"
  check "container env has the OTLP endpoint" "$OTLP_ENDPOINT" "$(printf '%s\n' "$cenv" | sed -n 's/^OTEL_EXPORTER_OTLP_ENDPOINT=//p')"
  check "container env has the dispatch attributes" "buildd.task_id=$EGRESS_TASK,buildd.attempt=1" "$(printf '%s\n' "$cenv" | sed -n 's/^OTEL_RESOURCE_ATTRIBUTES=//p')"
  check "container env holds no OTLP credential or headers var" 0 "$(printf '%s\n' "$cenv" | grep -c -e "$OTLP_KEY" -e '^OTEL_EXPORTER_OTLP_AUTH' -e '^OTEL_EXPORTER_OTLP_HEADERS' || true)"
  # otel.example.com has no DNS record; point it at example.com's address so
  # the container can connect and the platform can intercept it (smoke only).
  docker exec -u 0 "$c" sh -c 'ip="$(getent ahostsv4 example.com | awk "{print \$1; exit}")"; [ -n "$ip" ] && echo "$ip otel.example.com" >>/etc/hosts' || echo "   note: could not add an /etc/hosts entry for otel.example.com"
  o="$(docker exec "$c" curl -sS --max-time 20 --cacert /tmp/buildd-ca-bundle.pem -X POST \
        -H "$OTLP_HEADER: container-supplied" -H 'authorization: Bearer container-supplied' \
        -H 'content-type: application/json' "$OTLP_ENDPOINT/v1/logs" -d '{"resourceLogs":[]}' 2>&1)"
  echo "   otlp echo (synthetic POST): $o"
  check "otlp: sent to the collector URL" "$OTLP_ENDPOINT/v1/logs" "$(echo_field "$o" url)"
  check "otlp: injected" otlp "$(echo_field "$o" injected)"
  check "otlp: Worker credential set (by fingerprint), container value replaced" "$(fp "$OTLP_KEY")" "$(echo_field "$o" headers.$OTLP_HEADER)"
  check "otlp: container authorization stripped" "" "$(echo_field "$o" headers.authorization)"
  check "otlp: plain http to the collector refused" 403 "$(docker exec "$c" curl -sS -o /dev/null -w '%{http_code}' "http://otel.example.com/v1/logs" 2>&1)"

  # A real Claude Code session with the container's telemetry env. Its model
  # call is answered by the echoing handler (not a valid response), so it
  # fails; whatever it exports on the way out is logged by the handler.
  docker exec "$c" sh -c 'eval "$(tr "\0" "\n" </proc/1/environ | grep -E "^(OTEL_|CLAUDE_CODE_|ANTHROPIC_API_KEY=)" | sed "s/^/export /")"; export NODE_EXTRA_CA_CERTS=/tmp/buildd-ca-bundle.pem OTEL_LOGS_EXPORT_INTERVAL=1000 OTEL_METRIC_EXPORT_INTERVAL=1000; cd /tmp && timeout 45 claude -p "say hi" --max-turns 1' >"$LOG.claude" 2>&1 || true
  sleep 3
  n_otlp="$(grep -c -F '[cloud-runner] otlp echo' "$LOG" || true)"
  echo "   real Claude Code session: $(head -c 200 "$LOG.claude" | tr '\n' ' ')"
  echo "   otlp exports seen at egress (synthetic + session): $n_otlp; paths: $(grep -o -F -e 'otlp echo /v1/logs' -e 'otlp echo /v1/metrics' -e 'otlp echo /v1/traces' "$LOG" | sort | uniq -c | tr '\n' ' ')"
  if [ "$n_otlp" -gt 1 ]; then echo "   PASS a real Claude Code session exported through the egress handler"; else echo "   note: no export from the real session reached egress; only the synthetic POST was checked"; fi
fi
s="$(wait_exited)" || { echo "   FAIL egress run never exited: $s"; fail=1; }
check "egress run outcome" failed "$(field "$s" outcome)"
echo "   egress counters: $(bun -e 'console.log(JSON.stringify(JSON.parse(process.argv[1]).report?.egress))' "$s")"
check "report counts the model requests (curl + bun)" yes "$(bun -e 'const e=JSON.parse(process.argv[1]).report.egress; console.log(e.model.requests>=2&&e.model.responseBytes>0?"yes":"no")' "$s")"
check "report counts the rejected plain-http request" yes "$(bun -e 'const e=JSON.parse(process.argv[1]).report.egress; console.log(e.model.rejected>=1?"yes":"no")' "$s")"
check "report counts the github request" yes "$(bun -e 'const e=JSON.parse(process.argv[1]).report.egress; console.log(e.github.requests>=1?"yes":"no")' "$s")"
check "report has firstModelRequestAt" yes "$(bun -e 'const r=JSON.parse(process.argv[1]).report; console.log(r.timestamps.firstModelRequestAt>=r.timestamps.containerRunningAt?"yes":"no")' "$s")"
check "report holds no token or URL" 0 "$(bun -e 'console.log(JSON.stringify(JSON.parse(process.argv[1]).report))' "$s" | grep -c -e "$GW_TOKEN" -e "$PROXY_KEY" -e 'bld_smoke' -e 'https://' || true)"

echo "== clone phase lines and report delivery, through a fake claim (github.com is echoed, so the clone is empty and the run fails)"
TASK="$CLONE_TASK"
r6="$(post_dispatch)"; echo "   $r6"
s="$(wait_exited)" || { echo "   FAIL clone run never exited: $s"; fail=1; }
echo "   last runner line: $(bun -e 'const t=JSON.parse(process.argv[1]).outputTail??[]; console.log(t.filter(l=>l.startsWith("[once]")).at(-1)??"")' "$s")"
echo "   runner phases: $(bun -e 'const r=JSON.parse(process.argv[1]).report??{}; console.log(JSON.stringify({runnerPhases:r.runnerPhases,clone:r.durationsMs?.clone}))' "$s")"
check "clone run outcome" failed "$(field "$s" outcome)"
check "clone_start and clone_end recorded" yes "$(bun -e 'const p=JSON.parse(process.argv[1]).report.runnerPhases; console.log(p.clone_start>0&&p.clone_end>=p.clone_start?"yes":"no")' "$s")"
check "clone duration derived" yes "$(bun -e 'const d=JSON.parse(process.argv[1]).report.durationsMs; console.log(typeof d.clone==="number"?"yes":"no")' "$s")"
check "claimed run: worker id in the report" smoke-worker-clone "$(echo_field "$s" report.workerId)"
check "claimed run: claimedAt recorded" yes "$(bun -e 'const t=JSON.parse(process.argv[1]).report.timestamps; console.log(t.claimedAt>=t.containerRunningAt?"yes":"no")' "$s")"
# Delivery runs after `exited`; wait for it to settle.
for ((k = 0; k < 60; k++)); do
  s="$(curl -s "${auth[@]}" "$BASE/tasks/$TASK")"
  [ "$(echo_field "$s" report.delivery)" != pending ] && break
  sleep 1
done
# The Worker runs on this host and uses the same BUILDD_SERVER as the
# container. Docker Desktop's host.docker.internal resolves only inside
# containers, so by default the Worker cannot reach the fake buildd.
if curl -s -o /dev/null --max-time 2 "http://$HOST_ADDR:$FAKE_PORT/"; then
  check "run report delivered" sent "$(echo_field "$s" report.delivery)"
  check "fake buildd got the artifact POST" 1 "$(grep -c -F "ARTIFACT_POST /api/workers/smoke-worker-clone/artifacts key=cloud-run-report:smoke-worker-clone type=data" "$LOG.fake" || true)"
else
  echo "   note: this host cannot reach $HOST_ADDR:$FAKE_PORT, so the Worker's POST cannot reach the fake buildd;"
  echo "         SMOKE_HOST_ADDR=<an address both this host and the container reach> checks delivery end to end"
  check "delivery attempted, recorded as failed, outcome unaffected" "error failed" "$(echo_field "$s" report.delivery) $(field "$s" outcome)"
  check "delivery tried at most twice" 2 "$(grep -c -F "run report failed" "$LOG" | tr -d ' ')"
fi

echo "== warm repos: two runs of one workspace; the second restores instead of cloning"
check "the clone task got no workspace scope (no grant), so it cloned" "clone unavailable" "$(echo_field "$s" report.repo.source) $(echo_field "$s" report.repo.fallbackReason)"
if curl -s -o /dev/null --max-time 2 "http://$HOST_ADDR:$FAKE_PORT/"; then
  phases() { bun -e 'console.log(Object.keys(JSON.parse(process.argv[1]).report?.runnerPhases??{}).join(","))' "$1"; }
  TASK="$WARM_TASK_1"
  r7="$(post_dispatch)"; echo "   $r7"
  s="$(wait_exited)" || { echo "   FAIL warm run 1 never exited: $s"; fail=1; }
  echo "   warm run 1 repo: $(bun -e 'const r=JSON.parse(process.argv[1]).report??{}; console.log(JSON.stringify({repo:r.repo,clone:r.durationsMs?.clone,warmUpload:r.durationsMs?.warmUpload,phases:Object.keys(r.runnerPhases??{})}))' "$s")"
  echo "   warm run 1 last runner lines: $(bun -e 'const t=JSON.parse(process.argv[1]).outputTail??[]; console.log(JSON.stringify(t.filter(l=>/\[(warm|once|isolation)\]/.test(l)).slice(-6)))' "$s")"
  check "warm run 1: no snapshot yet, so it cloned" "clone no_snapshot" "$(echo_field "$s" report.repo.source) $(echo_field "$s" report.repo.fallbackReason)"
  check "warm run 1: the clone itself was timed" yes "$(bun -e 'const d=JSON.parse(process.argv[1]).report.durationsMs; console.log(typeof d.clone==="number"?"yes":"no")' "$s")"
  check "warm run 1: clone bytes measured" yes "$(bun -e 'const b=JSON.parse(process.argv[1]).report.repo.bytes; console.log(b.clone>0?"yes":"no")' "$s")"
  check "warm run 1: seeded a snapshot (upload timed, bytes > 0)" yes "$(bun -e 'const r=JSON.parse(process.argv[1]).report; console.log(typeof r.durationsMs.warmUpload==="number"&&r.repo.bytes.upload>0?"yes":"no")' "$s")"
  check "warm run 1: the Worker asked buildd for the grant with the dispatch token" yes "$(grep -q -F "GITHUB_TOKEN_REQUEST task=$WARM_TASK_1 dispatch_token=set" "$LOG.fake" && echo yes || echo no)"

  TASK="$WARM_TASK_2"
  objects_before="$(grep -c '^GIT_GET .*/objects/' "$LOG.fake" || true)"
  r8="$(post_dispatch)"; echo "   $r8"
  s="$(wait_exited)" || { echo "   FAIL warm run 2 never exited: $s"; fail=1; }
  echo "   warm run 2 repo: $(bun -e 'const r=JSON.parse(process.argv[1]).report??{}; console.log(JSON.stringify({repo:r.repo,restoreWarm:r.durationsMs?.restoreWarm,fetch:r.durationsMs?.fetch,clone:r.durationsMs?.clone,phases:Object.keys(r.runnerPhases??{})}))' "$s")"
  check "warm run 2: restored from the snapshot" warm "$(echo_field "$s" report.repo.source)"
  check "warm run 2: no git clone ran" no "$(phases "$s" | grep -q clone_start && echo yes || echo no)"
  check "warm run 2: restore and fetch timed" yes "$(bun -e 'const d=JSON.parse(process.argv[1]).report.durationsMs; console.log(typeof d.restoreWarm==="number"&&typeof d.fetch==="number"?"yes":"no")' "$s")"
  check "warm run 2: restore bytes > 0" yes "$(bun -e 'const b=JSON.parse(process.argv[1]).report.repo.bytes; console.log(b.restore>0?"yes":"no")' "$s")"
  check "warm run 2: nothing new to fetch" 0 "$(echo_field "$s" report.repo.bytes.fetch)"
  check "warm run 2: a fresh snapshot is not re-uploaded" "" "$(echo_field "$s" report.durationsMs.warmUpload)"
  # The fetch after restore asks for refs only; a clone would pull the pack.
  objects_after="$(grep -c '^GIT_GET .*/objects/' "$LOG.fake" || true)"
  check "warm run 1 fetched objects from origin (the clone)" yes "$([ "$objects_before" -gt 0 ] && echo yes || echo no)"
  check "warm run 2: no objects downloaded from origin" 0 "$((objects_after - objects_before))"
  check "report holds no snapshot key or URL" 0 "$(bun -e 'console.log(JSON.stringify(JSON.parse(process.argv[1]).report))' "$s" | grep -c -e "warm/$WARM_WS" -e 'buildd-snapshots' -e 'ghs_smoke' || true)"
else
  echo "   note: SKIPPED. The Worker cannot reach $HOST_ADDR:$FAKE_PORT, so it cannot fetch the grant that scopes the snapshot store."
  echo "         Re-run with SMOKE_HOST_ADDR=<an address both this host and the containers reach> to exercise warm restore."
fi

echo "== task containers left running (the agent destroys its container after each run)"
sleep 2
left="$(task_containers | grep -c . || true)"
check "no task container left running" 0 "$left"

if [ "$fail" = 0 ]; then echo "== local smoke PASSED"; else echo "== local smoke FAILED (wrangler log: $LOG)"; fi
exit "$fail"
