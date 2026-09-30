#!/usr/bin/env bash
# Local smoke for resumable runs (docs/design/cloudflare-sandbox-runner.md,
# Phase 2): park a waiting worker, answer it, resume it in a NEW container on
# the SAME worker, with its uncommitted change and transcript intact.
#
#   bash apps/cloud-runner/scripts/local-smoke-resume.sh
#
# Runs `wrangler dev` with RESUMABLE_RUNS=1 and WARM_REPOS=1 (local R2 in a
# throwaway --persist-to dir) and one fake on the host that plays both buildd
# and the model:
#  - buildd: the task, its claim, the GitHub-token grant (which carries the
#    workspace ID the snapshot keys come from), the park / reattach routes, and
#    worker PATCHes, whose response carries the queued answer once the worker is
#    re-attached (the same `instructions` / `instructionsAck` contract as the
#    real server). The repo is served over git's dumb HTTP.
#  - the model: the Worker's model route is MODEL_PROXY_URL=http://127.0.0.1:<port>/model,
#    so the container's api.anthropic.com traffic lands here. It answers from a
#    script: (1) edit README.md with Bash and leave it uncommitted, (2) ask a
#    question with AskUserQuestion, then, on the resumed session, (3) run
#    `git status; git diff` and (4) finish. It logs what it saw on the resumed
#    session: whether the earlier turns (the transcript) and the answer were
#    in the conversation, and the output of the diff.
#
# Case 2, the orphan park: a second task's session is left hanging on the
# model after its edit; the smoke then restarts the Worker's Durable Objects by
# touching src/index.ts (wrangler dev reloads). If the container survives the
# reload, the restarted agent parks it (`--park-orphan`) and resumes it; if
# wrangler dev takes the container down with the reload, the case says so and
# is skipped, since the orphan path needs a container that outlived its agent.
#
# The Worker, which runs on this host, must reach the fake for the grant, so
# the fake is reached at an address both this host and the containers reach:
# SMOKE_HOST_ADDR, or the host's primary address, detected (smoke-host.sh).
# Docker Desktop's host.docker.internal resolves only inside containers.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-8797}"
BASE="http://127.0.0.1:$PORT"
TOKEN="smoke-token-$RANDOM$RANDOM"
TASK="smoke-resume-$RANDOM$RANDOM"
ORPHAN_TASK="$TASK-orphan"
WORKER="smoke-worker-resume"
ORPHAN_WORKER="smoke-worker-orphan"
WS="smoke-ws-resume"
ANSWER="SMOKE-ANSWER: make it green"
READY_TIMEOUT_S="${READY_TIMEOUT_S:-2400}"
RUN_TIMEOUT_S="${RUN_TIMEOUT_S:-600}"
LOG="${LOG:-$(mktemp -t cloud-runner-resume.XXXXXX)}"
FAKE_PORT="${FAKE_PORT:-8796}"
source "$DIR/scripts/smoke-host.sh"
HOST_ADDR="$(smoke_host_addr)"
STATE_DIR="$(mktemp -d -t cloud-runner-resume-state.XXXXXX)"
GIT_DIR_ROOT="$(mktemp -d -t cloud-runner-resume-git.XXXXXX)"
fail=0

if [ -z "$HOST_ADDR" ]; then
  echo "could not detect a host address; set SMOKE_HOST_ADDR to one both this host and the containers reach (the host's LAN address on Docker Desktop)"
  exit 2
fi

cd "$DIR"
(
  set -e
  src="$GIT_DIR_ROOT/src"; git init -q -b main "$src"
  printf 'hello from the resume smoke\n' > "$src/README.md"
  git -C "$src" add README.md
  git -C "$src" -c user.email=smoke@example.com -c user.name=smoke commit -qm 'smoke: initial commit'
  git clone -q --bare "$src" "$GIT_DIR_ROOT/widget.git"
  git -C "$GIT_DIR_ROOT/widget.git" symbolic-ref HEAD refs/heads/main
  git -C "$GIT_DIR_ROOT/widget.git" update-server-info
)

echo "== fake buildd + model on :$FAKE_PORT"
TASKS="$TASK,$ORPHAN_TASK" WORKERS="$WORKER,$ORPHAN_WORKER" WS="$WS" ANSWER="$ANSWER" ORPHAN_TASK="$ORPHAN_TASK" \
GIT_DIR_ROOT="$GIT_DIR_ROOT" HOST_ADDR="$HOST_ADDR" FAKE_PORT="$FAKE_PORT" bun -e '
  const tasks = process.env.TASKS.split(","), workers = process.env.WORKERS.split(",");
  const ws = process.env.WS, ANSWER = process.env.ANSWER;
  const repo = `http://${process.env.HOST_ADDR}:${process.env.FAKE_PORT}/git/widget.git`;
  const taskOf = (id) => ({ id, title: "smoke resume",
    description: id === process.env.ORPHAN_TASK ? "orphan-marker: edit the README and keep working." : "Edit the README, then ask which colour to use.", workspaceId: ws,
    status: "pending", workspace: { id: ws, name: "smoke-resume", repo } });
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const answered = new Set(), reattached = new Set(), delivered = new Set();
  let reattachCount = {};
  const log = (m) => console.log(m);

  // ── the model ──
  const textOf = (m) => typeof m.content === "string" ? m.content : (m.content ?? []).map((b) => b.type === "text" ? b.text : b.type === "tool_result" ? (typeof b.content === "string" ? b.content : (b.content ?? []).map((c) => c.text ?? "").join("")) : "").join("\n");
  const toolUses = (msgs) => msgs.filter((m) => m.role === "assistant").flatMap((m) => Array.isArray(m.content) ? m.content.filter((b) => b.type === "tool_use").map((b) => b.id) : []);
  const toolResult = (msgs, id) => { for (const m of msgs) if (Array.isArray(m.content)) for (const b of m.content) if (b.type === "tool_result" && b.tool_use_id === id) return typeof b.content === "string" ? b.content : (b.content ?? []).map((c) => c.text ?? "").join(""); return null; };
  function sse(blocks, stop) {
    const enc = new TextEncoder();
    const ev = (t, d) => `event: ${t}\ndata: ${JSON.stringify({ type: t, ...d })}\n\n`;
    let out = ev("message_start", { message: { id: `msg_${Date.now()}`, type: "message", role: "assistant", model: "claude-smoke", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } });
    blocks.forEach((b, i) => {
      if (b.type === "text") {
        out += ev("content_block_start", { index: i, content_block: { type: "text", text: "" } });
        out += ev("content_block_delta", { index: i, delta: { type: "text_delta", text: b.text } });
      } else {
        out += ev("content_block_start", { index: i, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
        out += ev("content_block_delta", { index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
      }
      out += ev("content_block_stop", { index: i });
    });
    out += ev("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } });
    out += ev("message_stop", {});
    return new Response(enc.encode(out), { headers: { "content-type": "text/event-stream", "request-id": "req_smoke" } });
  }
  function message(blocks, stop) {
    return json({ id: `msg_${Date.now()}`, type: "message", role: "assistant", model: "claude-smoke", content: blocks, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } }, 200);
  }
  async function model(req, path) {
    if (path.endsWith("/count_tokens")) return json({ input_tokens: 100 });
    const body = await req.json().catch(() => ({}));
    const reply = (blocks, stop) => body.stream ? sse(blocks, stop) : message(blocks, stop);
    const tools = (body.tools ?? []).map((t) => t.name);
    const msgs = body.messages ?? [];
    if (!tools.includes("Bash")) return reply([{ type: "text", text: "ok" }], "end_turn");
    const system = typeof body.system === "string" ? body.system : (body.system ?? []).map((b) => b.text ?? "").join("\n");
    const all = [system, ...msgs.map(textOf)].join("\n");
    const orphan = all.includes("orphan-marker");
    const used = toolUses(msgs);
    const tag = orphan ? "orphan" : "main";
    if (!used.includes(`toolu_${tag}_edit`)) {
      log(`MODEL_TURN ${tag} edit`);
      return reply([{ type: "tool_use", id: `toolu_${tag}_edit`, name: "Bash", input: { command: `echo "uncommitted ${tag} change" >> README.md && echo edited-${tag}`, description: "Edit the README" } }], "tool_use");
    }
    if (orphan && !used.includes("toolu_orphan_check")) {
      if (!all.includes("platform restarted")) {
        // Hold the session here until the agent is restarted underneath it.
        log("MODEL_TURN orphan hang");
        await Bun.sleep(600_000);
        return reply([{ type: "text", text: "late" }], "end_turn");
      }
      log(`MODEL_RESUMED orphan has_edit_turn=${used.includes("toolu_orphan_edit")} has_nudge=true`);
      return reply([{ type: "tool_use", id: "toolu_orphan_check", name: "Bash", input: { command: "git status --porcelain; git diff", description: "Check" } }], "tool_use");
    }
    if (!orphan && !used.includes("toolu_main_ask")) {
      log("MODEL_TURN main ask");
      return reply([{ type: "tool_use", id: "toolu_main_ask", name: "AskUserQuestion", input: { questions: [{ question: "Which colour should the widget be?", header: "Colour", multiSelect: false, options: [{ label: "Blue", description: "Blue" }, { label: "Green", description: "Green" }] }] } }], "tool_use");
    }
    // Asked, not yet answered: end the turn and wait, as a real model would.
    if (!orphan && !all.includes(ANSWER)) {
      log("MODEL_TURN main wait");
      return reply([{ type: "text", text: "Waiting for your answer on the colour." }], "end_turn");
    }
    const checkId = `toolu_${tag}_check`;
    if (!used.includes(checkId)) {
      const answers = msgs.filter((m) => m.role === "user").map(textOf).filter((t) => t.includes(ANSWER)).length;
      log(`MODEL_RESUMED ${tag} has_edit_turn=${used.includes(`toolu_${tag}_edit`)} has_ask_turn=${used.includes("toolu_main_ask")} answers=${answers}`);
      return reply([{ type: "tool_use", id: checkId, name: "Bash", input: { command: "git status --porcelain; git diff", description: "Check" } }], "tool_use");
    }
    const result = toolResult(msgs, checkId);
    if (result !== null) log(`MODEL_CHECK ${tag} ${Buffer.from(result).toString("base64")}`);
    return reply([{ type: "text", text: "Done." }], "end_turn");
  }

  Bun.serve({ port: Number(process.env.FAKE_PORT), hostname: "0.0.0.0", idleTimeout: 0, async fetch(req) {
    const url = new URL(req.url), path = url.pathname, m = req.method;
    if (path.startsWith("/model/")) return model(req, path);
    if (m === "GET" && path.startsWith("/git/") && !path.includes("..")) {
      const f = Bun.file(`${process.env.GIT_DIR_ROOT}/${path.slice(5)}`);
      return (await f.exists()) ? new Response(f) : new Response("nf", { status: 404 });
    }
    if (m === "POST" && path === "/smoke/answer") { answered.add(url.searchParams.get("worker")); log(`ANSWERED ${url.searchParams.get("worker")}`); return json({ ok: true }); }
    const t = tasks.find((x) => path === `/api/tasks/${x}`);
    if (m === "GET" && t) return json(taskOf(t));
    if (m === "POST" && path === "/api/runner/github-token") {
      const body = await req.json().catch(() => ({}));
      if (!tasks.includes(body.taskId)) return json({ error: "no" }, 409);
      return json({ token: "ghs_smoke_dummy", expiresAt: new Date(Date.now() + 3600e3).toISOString(), repository: { owner: "acme", name: "widget", fullName: "acme/widget" }, workspaceId: ws });
    }
    if (m === "POST" && path === "/api/workers/claim") {
      const body = await req.json().catch(() => ({}));
      const i = tasks.indexOf(body.taskId);
      if (i >= 0) { log(`CLAIM ${workers[i]}`); return json({ workers: [{ id: workers[i], taskId: body.taskId, branch: `buildd/${workers[i]}`, task: taskOf(body.taskId) }] }); }
      return json({ error: "no" }, 409);
    }
    const w = /^\/api\/workers\/([^/]+)(?:\/(park|reattach))?$/.exec(path);
    if (w && workers.includes(w[1])) {
      const id = w[1];
      if (w[2] === "park" && m === "POST") { log(`PARK ${id}`); return json({ parkedUntil: new Date(Date.now() + 86400e3).toISOString() }); }
      if (w[2] === "park" && m === "DELETE") { log(`UNPARK ${id}`); return json({ ok: true }); }
      if (w[2] === "reattach" && m === "POST") {
        reattachCount[id] = (reattachCount[id] ?? 0) + 1;
        if (reattached.has(id)) { log(`REATTACH_REFUSED ${id}`); return json({ error: "not_parked" }, 409); }
        reattached.add(id); log(`REATTACH ${id}`);
        return json({ worker: { id, taskId: tasks[workers.indexOf(id)], status: "waiting_input" } });
      }
      if (m === "PATCH") {
        const body = await req.json().catch(() => ({}));
        if (body.status) log(`PATCH ${id} status=${body.status}`);
        if (typeof body.instructionsDelivered === "string") { delivered.add(id); log(`DELIVERED ${id}`); }
        if (answered.has(id) && reattached.has(id) && !delivered.has(id)) return json({ instructions: ANSWER, instructionsAck: ANSWER });
        return json({});
      }
    }
    if (m === "GET") return json({ error: "not found" }, 404);
    return json({});
  } });
' >"$LOG.fake" 2>&1 &
FAKE_PID=$!

echo "== wrangler dev on :$PORT (log: $LOG)"
bunx wrangler dev --port "$PORT" --ip 127.0.0.1 \
  --var "DISPATCH_TOKEN:$TOKEN" \
  --var "BUILDD_API_KEY:bld_smoke_not_a_real_key" \
  --var "BUILDD_SERVER:http://$HOST_ADDR:$FAKE_PORT" \
  --var "CONTAINER_START_TIMEOUT_MS:600000" \
  --var "MODEL_PROXY_URL:http://127.0.0.1:$FAKE_PORT/model" \
  --var "MODEL_PROXY_KEY:smoke-proxy-key" \
  --var "WARM_REPOS:1" \
  --var "RESUMABLE_RUNS:1" \
  --persist-to "$STATE_DIR" \
  >"$LOG" 2>&1 &
WRANGLER_PID=$!
task_containers() { docker ps --format '{{.Names}}' | grep '^workerd-buildd-cloud-runner-WorkerAgent-' | grep -v -- '-proxy$' || true; }
cleanup() {
  kill -INT "$WRANGLER_PID" 2>/dev/null || true
  wait "$WRANGLER_PID" 2>/dev/null || true
  kill "$FAKE_PID" 2>/dev/null || true
  wait "$FAKE_PID" 2>/dev/null || true
  docker ps -q --filter name=workerd-buildd-cloud-runner- | xargs -r docker rm -f >/dev/null 2>&1 || true
  rm -rf "$STATE_DIR" "$GIT_DIR_ROOT"
}
trap cleanup EXIT
require_host_reachable "$HOST_ADDR" "$FAKE_PORT"

auth=(-H "Authorization: Bearer $TOKEN")
code_of() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
check() { if [ "$2" = "$3" ]; then echo "   PASS $1 ($3)"; else echo "   FAIL $1: got $3, want $2"; fail=1; fi; }
jf() { bun -e 'const s=JSON.parse(process.argv[1]); const v=process.argv[2].split(".").reduce((o,k)=>o==null?o:o[k],s); console.log(v===undefined||v===null?"":v)' "$1" "$2"; }
dispatch() { # taskId [workerId for task.resume]
  local body="{\"event\":\"task.created\",\"taskId\":\"$1\",\"workspaceId\":\"$WS\"}"
  [ -n "${2:-}" ] && body="{\"event\":\"task.resume\",\"taskId\":\"$1\",\"workspaceId\":\"$WS\",\"workerId\":\"$2\"}"
  curl -s -X POST "${auth[@]}" -H 'Content-Type: application/json' "$BASE/dispatch" -d "$body"
}
wait_exited() { # taskId attempt
  local s
  for ((j = 0; j < RUN_TIMEOUT_S; j += 3)); do
    s="$(curl -s "${auth[@]}" "$BASE/tasks/$1")"
    [ "$(jf "$s" status)" = exited ] && [ "$(jf "$s" attempt)" = "$2" ] && { echo "$s"; return 0; }
    sleep 3
  done
  echo "$s"; return 1
}
fakelog() { grep -c -F "$1" "$LOG.fake" | tr -d ' ' || true; }

echo "== waiting for the Worker (up to ${READY_TIMEOUT_S}s)"
for ((i = 0; i < READY_TIMEOUT_S; i += 5)); do
  if ! kill -0 "$WRANGLER_PID" 2>/dev/null; then echo "   wrangler exited early:"; tail -40 "$LOG"; exit 1; fi
  [ "$(code_of "$BASE/")" = 404 ] && break
  sleep 5
done
echo "   up after ~${i}s"

echo "== case 1: park on a question, answer, resume the SAME worker in a new container"
echo "   $(dispatch "$TASK")"
s="$(wait_exited "$TASK" 1)" || { echo "   FAIL attempt 1 never exited: $s"; fail=1; }
echo "   attempt 1 tail: $(bun -e 'const t=JSON.parse(process.argv[1]).outputTail??[]; console.log(JSON.stringify(t.filter(l=>/\[once\]|BUILDD_PARKED|parked/.test(l)).slice(-4)))' "$s")"
check "attempt 1 exit code" 4 "$(jf "$s" exitCode)"
check "attempt 1 outcome" parked "$(jf "$s" outcome)"
check "no crash report for a park" "" "$(jf "$s" crashReport)"
check "the model was asked twice before the park (edit, ask)" "1 1" "$(fakelog 'MODEL_TURN main edit') $(fakelog 'MODEL_TURN main ask')"
check "the runner marked the worker parked" 1 "$(fakelog "PARK $WORKER")"
check "report: park timed and sized" yes "$(bun -e 'const r=JSON.parse(process.argv[1]).report; console.log(typeof r.durationsMs.park==="number"&&r.resume.parkBytes>0?"yes":"no")' "$s")"
sleep 2
check "the parked container is gone" 0 "$(task_containers | grep -c . || true)"

echo "   answering, then task.resume (twice: a duplicate webhook)"
curl -s -X POST "http://127.0.0.1:$FAKE_PORT/smoke/answer?worker=$WORKER" >/dev/null
r1="$(dispatch "$TASK" "$WORKER")"; r2="$(dispatch "$TASK" "$WORKER")"
echo "   $r1"; echo "   $r2"
check "resume accepted" true "$(jf "$r1" accepted)"
check "duplicate task.resume is a no-op" "false already_live" "$(jf "$r2" accepted) $(jf "$r2" reason)"
check "task.resume for another worker is ignored" "false" "$(jf "$(dispatch "$TASK" smoke-worker-nobody)" accepted)"
s="$(wait_exited "$TASK" 2)" || { echo "   FAIL attempt 2 never exited: $s"; fail=1; }
echo "   attempt 2 tail: $(bun -e 'const t=JSON.parse(process.argv[1]).outputTail??[]; console.log(JSON.stringify(t.filter(l=>/\[once\]|Layer|RESUMED/.test(l)).slice(-5)))' "$s")"
echo "   attempt 2 report: $(bun -e 'const r=JSON.parse(process.argv[1]).report??{}; console.log(JSON.stringify({outcome:r.outcome,workerId:r.workerId,resume:r.resume,restorePark:r.durationsMs?.restorePark,repo:r.repo?.source}))' "$s")"
check "resumed on the same worker" "$WORKER" "$(jf "$s" report.workerId)"
check "report: resumed" true "$(jf "$s" report.resume.resumed)"
check "report: gap time recorded" yes "$(bun -e 'const r=JSON.parse(process.argv[1]).report; console.log(r.resume.gapMs>0?"yes":"no")' "$s")"
check "report: layer 1 (the transcript resumed, not a text rebuild)" 1 "$(jf "$s" report.resume.layer)"
check "report: restore of the park bundle timed" yes "$(bun -e 'const r=JSON.parse(process.argv[1]).report; console.log(typeof r.durationsMs.restorePark==="number"?"yes":"no")' "$s")"
check "the second container restored the repo from the warm snapshot" warm "$(jf "$s" report.repo.source)"
check "never a second claim" 1 "$(fakelog "CLAIM $WORKER")"
check "exactly one re-attach" "1 0" "$(fakelog "REATTACH $WORKER") $(fakelog "REATTACH_REFUSED $WORKER")"
check "the answer was acknowledged" yes "$([ "$(fakelog "DELIVERED $WORKER")" -ge 1 ] && echo yes || echo no)"
check "the resumed conversation carried the earlier turns and the answer, once" 1 "$(fakelog 'MODEL_RESUMED main has_edit_turn=true has_ask_turn=true answers=1')"
diff_b64="$(sed -n 's/^MODEL_CHECK main //p' "$LOG.fake" | tail -1)"
diff_text="$(printf '%s' "$diff_b64" | base64 -d 2>/dev/null || true)"
echo "   git status/diff seen by the resumed agent:"; printf '%s\n' "$diff_text" | sed 's/^/     | /' | head -12
check "the uncommitted change is intact, still uncommitted" yes "$(printf '%s' "$diff_text" | grep -q '^ M README.md' && printf '%s' "$diff_text" | grep -q '+uncommitted main change' && echo yes || echo no)"
check "attempt 2 outcome" done "$(jf "$s" outcome)"

echo "== case 2: kill the agent mid-run (orphan park), the resume continues with the change intact"
echo "   $(dispatch "$ORPHAN_TASK")"
for ((k = 0; k < 600; k++)); do [ "$(fakelog 'MODEL_TURN orphan hang')" -ge 1 ] && break; sleep 1; done
if [ "$(fakelog 'MODEL_TURN orphan hang')" -lt 1 ]; then
  echo "   FAIL the orphan task never reached its hanging turn"; fail=1
else
  before="$(task_containers | head -1)"
  echo "   session is live with an uncommitted edit (container $before); restarting the Worker's agents"
  touch "$DIR/src/index.ts"
  for ((k = 0; k < 120; k++)); do grep -q -i 'reload' "$LOG" && break; sleep 1; done
  sleep 5
  alive="$(docker ps --format '{{.Names}}' | grep -c -x -F "$before" || true)"
  # The agent recovers on its next start; a status read wakes it.
  s="$(curl -s "${auth[@]}" "$BASE/tasks/$ORPHAN_TASK")"
  if [ "$alive" = 0 ] && [ "$(fakelog "PARK $ORPHAN_WORKER")" = 0 ]; then
    echo "   note: SKIPPED. wrangler dev took the container down with the reload, so no container outlived its agent;"
    echo "         the orphan park is covered by supervisor.test.ts and run-once.test.ts, and needs a real account to exercise."
  else
    s="$(wait_exited "$ORPHAN_TASK" 2)" || { echo "   FAIL orphan resume never exited: $s"; fail=1; }
    echo "   orphan report: $(bun -e 'const r=JSON.parse(process.argv[1]); console.log(JSON.stringify({outcome:r.outcome,resume:r.report?.resume,history:(r.reportHistory??[]).map(h=>h.outcome)}))' "$s")"
    check "the orphaned run was parked" parked "$(jf "$s" reportHistory.0.outcome)"
    check "and resumed on the same worker" "$ORPHAN_WORKER true" "$(jf "$s" report.workerId) $(jf "$s" report.resume.resumed)"
    check "the resumed session was nudged to continue, with its earlier turn" 1 "$(fakelog 'MODEL_RESUMED orphan has_edit_turn=true')"
    odiff="$(sed -n 's/^MODEL_CHECK orphan //p' "$LOG.fake" | tail -1 | base64 -d 2>/dev/null || true)"
    check "the uncommitted change survived the kill" yes "$(printf '%s' "$odiff" | grep -q '+uncommitted orphan change' && echo yes || echo no)"
  fi
fi

sleep 2
check "no task container left running" 0 "$(task_containers | grep -c . || true)"
if [ "$fail" = 0 ]; then echo "== resume smoke PASSED"; else echo "== resume smoke FAILED (wrangler log: $LOG, fake log: $LOG.fake)"; fi
exit "$fail"
