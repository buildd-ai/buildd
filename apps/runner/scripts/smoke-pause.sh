#!/usr/bin/env bash
# Host-runner smoke for pausing a running agent (task baf3809a): a REAL
# WorkerManager, a REAL Claude Code process and a real git worktree, against a
# fake buildd and a fake model on 127.0.0.1. Nothing reaches a real server.
#
#   bash apps/runner/scripts/smoke-pause.sh
#
# What it proves, end to end on the host (pauseMode 'session'):
#  1. The model is held mid-turn (no tool executing) and the fake buildd serves
#     `pauseRequested` on the worker's PATCH, the durable path (no Pusher here).
#  2. The runner stops the session, reports waiting_input with a `pause`
#     waitingFor (never `failed`), keeps the worktree, and stops counting the
#     worker as holding a slot.
#  3. The answer (Resume) is drained by the waiting worker's sync and resumes
#     the SAME Claude Code session: the model sees the same session id, the
#     earlier turns, and a marker printed before the pause ("recall").
#
# Isolation: runs from a temp dir with a temp HOME and BUILDD_HOME and a
# scrubbed environment (env -i), so no local .env, login or API key is read
# (never run a runner inside a checkout that holds a live .env).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
FAKE_PORT="${FAKE_PORT:-8791}"
TMP="$(mktemp -d -t buildd-smoke-pause.XXXXXX)"
LOG="$TMP/fake.log"
RECALL="SMOKE-RECALL-$RANDOM$RANDOM"
ANSWER="Resume (SMOKE-RESUME)"
WORKER="smoke-worker-pause-host"
TASK="smoke-task-pause-host"
fail=0

cleanup() {
  if [ -n "${FAKE_PID:-}" ]; then kill "$FAKE_PID" 2>/dev/null || true; wait "$FAKE_PID" 2>/dev/null || true; fi
  if [ "${KEEP_TMP:-0}" = 1 ]; then echo "kept $TMP"; else rm -rf "$TMP"; fi
}
trap cleanup EXIT

mkdir -p "$TMP/home" "$TMP/buildd-home" "$TMP/projects" "$TMP/run"
(
  set -e
  src="$TMP/src"; git init -q -b main "$src"
  printf 'hello from the pause smoke\n' > "$src/README.md"
  git -C "$src" add README.md
  git -C "$src" -c user.email=smoke@example.com -c user.name=smoke commit -qm 'smoke: initial commit'
  git clone -q --bare "$src" "$TMP/widget.git"
  git clone -q "$TMP/widget.git" "$TMP/projects/widget"
  git -C "$TMP/projects/widget" config user.email smoke@example.com
  git -C "$TMP/projects/widget" config user.name smoke
)

echo "== fake buildd + model on :$FAKE_PORT"
SMOKE_DEBUG="${SMOKE_DEBUG:-}" WORKER="$WORKER" TASK="$TASK" ANSWER="$ANSWER" RECALL="$RECALL" FAKE_PORT="$FAKE_PORT" bun -e '
  const { WORKER, TASK, ANSWER, RECALL } = process.env;
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const log = (m) => console.log(m);
  let pauseArmed = false, pausedSeen = false, answered = false, delivered = false;
  const textOf = (m) => typeof m.content === "string" ? m.content : (m.content ?? []).map((b) => b.type === "text" ? b.text : b.type === "tool_result" ? (typeof b.content === "string" ? b.content : (b.content ?? []).map((c) => c.text ?? "").join("")) : "").join("\n");
  const toolUses = (msgs) => msgs.filter((m) => m.role === "assistant").flatMap((m) => Array.isArray(m.content) ? m.content.filter((b) => b.type === "tool_use").map((b) => b.id) : []);
  const toolResult = (msgs, id) => { for (const m of msgs) if (Array.isArray(m.content)) for (const b of m.content) if (b.type === "tool_result" && b.tool_use_id === id) return typeof b.content === "string" ? b.content : (b.content ?? []).map((c) => c.text ?? "").join(""); return null; };
  // Claude Code names its session in a header and in metadata.user_id (JSON).
  const sessionOf = (req, body) => req.headers.get("x-claude-code-session-id") ?? (/"session_id":"([0-9a-f-]{36})"/.exec(String(body?.metadata?.user_id ?? "")) ?? [])[1] ?? "none";
  function sse(blocks, stop) {
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
    return new Response(new TextEncoder().encode(out), { headers: { "content-type": "text/event-stream", "request-id": "req_smoke" } });
  }
  const message = (blocks, stop) => json({ id: `msg_${Date.now()}`, type: "message", role: "assistant", model: "claude-smoke", content: blocks, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } });
  async function model(req, path) {
    if (path.endsWith("/count_tokens")) return json({ input_tokens: 100 });
    const body = await req.json().catch(() => ({}));
    const reply = (blocks, stop) => body.stream ? sse(blocks, stop) : message(blocks, stop);
    const tools = (body.tools ?? []).map((t) => t.name);
    const msgs = body.messages ?? [];
    if (!tools.includes("Bash")) return reply([{ type: "text", text: "ok" }], "end_turn");
    const all = msgs.map(textOf).join("\n");
    const used = toolUses(msgs);
    if (!used.includes("toolu_edit")) {
      if (process.env.SMOKE_DEBUG) log(`MODEL_META ${JSON.stringify({ headers: [...req.headers.entries()].filter(([k]) => !/auth|key/i.test(k)), metadata: body.metadata })}`);
      log(`MODEL_TURN edit session=${sessionOf(req, body)}`);
      return reply([{ type: "tool_use", id: "toolu_edit", name: "Bash", input: { command: `echo "uncommitted pause change" >> README.md && echo ${RECALL}`, description: "Edit the README" } }], "tool_use");
    }
    if (!all.includes(ANSWER)) {
      log("MODEL_TURN hold");
      pauseArmed = true;
      await Promise.race([Bun.sleep(300_000), new Promise((r) => req.signal?.addEventListener?.("abort", r))]);
      return reply([{ type: "text", text: "late" }], "end_turn");
    }
    if (!used.includes("toolu_check")) {
      const answers = msgs.filter((m) => m.role === "user").map(textOf).filter((t) => t.includes(ANSWER)).length;
      log(`MODEL_RESUMED has_edit_turn=true recall=${all.includes(RECALL)} answers=${answers} session=${sessionOf(req, body)}`);
      return reply([{ type: "tool_use", id: "toolu_check", name: "Bash", input: { command: "git status --porcelain; git diff", description: "Check" } }], "tool_use");
    }
    const result = toolResult(msgs, "toolu_check");
    if (result !== null) log(`MODEL_CHECK ${Buffer.from(result).toString("base64")}`);
    return reply([{ type: "text", text: "Done." }], "end_turn");
  }
  const task = { id: TASK, title: "smoke pause", description: "Edit the README and keep working.", workspaceId: "smoke-ws", status: "pending", priority: 1, outputRequirement: "none", workspace: { id: "smoke-ws", name: "widget", repo: "widget" } };
  Bun.serve({ port: Number(process.env.FAKE_PORT), hostname: "127.0.0.1", idleTimeout: 0, async fetch(req) {
    const url = new URL(req.url), path = url.pathname, m = req.method;
    if (path.startsWith("/v1/messages")) return model(req, path);
    if (m === "POST" && path === "/smoke/answer") { answered = true; log("ANSWERED"); return json({ ok: true }); }
    if (m === "GET" && path === "/smoke/state") return json({ pauseArmed, pausedSeen, answered, delivered });
    if (m === "POST" && path === "/api/workers/claim") { log(`CLAIM ${WORKER}`); return json({ workers: [{ id: WORKER, taskId: TASK, branch: `buildd/${WORKER}`, task }] }); }
    if (m === "GET" && path === `/api/tasks/${TASK}`) return json(task);
    if (path === `/api/workers/${WORKER}` && m === "PATCH") {
      const body = await req.json().catch(() => ({}));
      if (body.status) log(`PATCH status=${body.status}${body.waitingFor?.type ? ` waitingFor=${body.waitingFor.type}` : ""}`);
      if (body.status === "waiting_input" && body.waitingFor?.type === "pause" && !pausedSeen) { pausedSeen = true; log("PAUSED"); }
      if (typeof body.instructionsDelivered === "string") { delivered = true; log("DELIVERED"); }
      if (answered && !delivered) return json({ status: "waiting_input", instructions: ANSWER, instructionsAck: ANSWER });
      if (pauseArmed && !pausedSeen) return json({ status: "running", pauseRequested: true });
      return json({ status: body.status === "waiting_input" ? "waiting_input" : "running" });
    }
    if (m === "GET") return json({}, 404);
    return json({});
  } });
' >"$LOG" 2>&1 &
FAKE_PID=$!
for _ in $(seq 1 50); do curl -s "http://127.0.0.1:$FAKE_PORT/smoke/state" >/dev/null && break; sleep 0.2; done

cat > "$TMP/run/driver.ts" <<EOF
const { WorkerManager } = await import('$ROOT/apps/runner/src/workers.ts');
const { createWorkspaceResolver } = await import('$ROOT/apps/runner/src/workspace.ts');
const FAKE = 'http://127.0.0.1:$FAKE_PORT';
const config: any = {
  projectsRoot: '$TMP/projects', projectRoots: ['$TMP/projects'],
  builddServer: FAKE, apiKey: 'bld_smoke_not_a_real_key',
  maxConcurrent: 1, serverless: true, acceptRemoteTasks: false, bypassPermissions: true,
  localUiUrl: 'http://127.0.0.1:1/smoke-pause',
};
const wm = new WorkerManager(config, createWorkspaceResolver(config.projectRoots));
const out: Record<string, unknown> = {};
const until = async (label: string, cond: () => boolean | Promise<boolean>, ms: number) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return true; await Bun.sleep(500); }
  console.log('TIMEOUT ' + label); return false;
};
const state = async () => (await fetch(FAKE + '/smoke/state')).json();
await wm.claimAndStart({ id: '$TASK', title: 'smoke pause', description: 'Edit the README and keep working.', workspaceId: 'smoke-ws', workspace: { id: 'smoke-ws', name: 'widget', repo: 'widget' }, status: 'pending', priority: 1, outputRequirement: 'none' } as any);
const w = () => wm.getWorker('$WORKER') as any;
// The quiet sync of a working worker serves pauseRequested within ~30s.
await until('paused', async () => (await state()).pausedSeen && !wm.hasLiveSession('$WORKER'), 150_000);
out.afterPause = { status: w()?.status, waitingFor: w()?.waitingFor?.type, liveSession: wm.hasLiveSession('$WORKER'), sessionId: w()?.sessionId, worktreeKept: !!w()?.worktreePath && (await Bun.file(w().worktreePath + '/README.md').exists()) };
await fetch(FAKE + '/smoke/answer', { method: 'POST' });
await until('resumed', () => ['done', 'error'].includes(w()?.status) && !wm.hasLiveSession('$WORKER'), 150_000);
out.afterResume = { status: w()?.status, sessionId: w()?.sessionId, error: w()?.error ?? null };
console.log('DRIVER ' + JSON.stringify(out));
wm.destroy();
process.exit(0);
EOF

echo "== real WorkerManager + Claude Code, scrubbed env, temp HOME"
( cd "$TMP/run" && env -i PATH="$PATH" HOME="$TMP/home" BUILDD_HOME="$TMP/buildd-home" TMPDIR="${TMPDIR:-/tmp}" \
    ANTHROPIC_BASE_URL="http://127.0.0.1:$FAKE_PORT" ANTHROPIC_API_KEY="sk-ant-smoke-not-a-real-key" \
    BUILDD_DISABLE_SANDBOX=1 BUILDD_DISABLE_AUTO_UPDATE=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    BUILDD_TRUSTED_MODEL_BASE_URL="http://127.0.0.1:$FAKE_PORT" \
    bun driver.ts ) >"$TMP/driver.log" 2>&1 || true

driver="$(sed -n 's/^DRIVER //p' "$TMP/driver.log" | tail -1)"
echo "   driver: $driver"
fakelog() { grep -c -F -- "$1" "$LOG" | tr -d ' ' || true; }
jf() { bun -e 'const s=JSON.parse(process.argv[1]||"{}"); const v=process.argv[2].split(".").reduce((o,k)=>o==null?o:o[k],s); console.log(v===undefined||v===null?"":v)' "$1" "$2"; }
check() { if [ "$2" = "$3" ]; then echo "   PASS $1 ($3)"; else echo "   FAIL $1: got $3, want $2"; fail=1; fi; }

check "the pause landed while the model held its turn (no tool executing)" 1 "$(fakelog 'MODEL_TURN hold')"
check "reported waiting_input with a pause" 1 "$(fakelog 'PAUSED')"
check "never reported failed" 0 "$(fakelog 'PATCH status=failed')"
check "after the pause: waiting, pause, no live session" "waiting pause false" "$(jf "$driver" afterPause.status) $(jf "$driver" afterPause.waitingFor) $(jf "$driver" afterPause.liveSession)"
check "the worktree was kept" true "$(jf "$driver" afterPause.worktreeKept)"
check "Resume was drained into the session" yes "$([ "$(fakelog 'DELIVERED')" -ge 1 ] && echo yes || echo no)"
check "the resumed conversation recalls what came before the pause, and the Resume, once" 1 "$(fakelog 'MODEL_RESUMED has_edit_turn=true recall=true answers=1')"
first_sid="$(sed -n 's/^MODEL_TURN edit session=//p' "$LOG" | head -1)"
resumed_sid="$(sed -n 's/^MODEL_RESUMED .* session=//p' "$LOG" | tail -1)"
echo "   Claude Code session id before the pause: $first_sid, after: $resumed_sid"
check "the SAME session id before and after the pause" yes "$([ -n "$first_sid" ] && [ "$first_sid" != none ] && [ "$first_sid" = "$resumed_sid" ] && echo yes || echo no)"
check "the runner's session id did not change" yes "$([ -n "$(jf "$driver" afterPause.sessionId)" ] && [ "$(jf "$driver" afterPause.sessionId)" = "$(jf "$driver" afterResume.sessionId)" ] && echo yes || echo no)"
pdiff="$(sed -n 's/^MODEL_CHECK //p' "$LOG" | tail -1 | base64 -d 2>/dev/null || true)"
check "the uncommitted change is intact after the pause" yes "$(printf '%s' "$pdiff" | grep -q '+uncommitted pause change' && echo yes || echo no)"

if [ "$fail" = 0 ]; then
  echo "== host pause smoke PASSED"
else
  echo "== host pause smoke FAILED"; echo "-- fake log"; tail -40 "$LOG"; echo "-- driver log"; grep -v '^$' "$TMP/driver.log" | tail -60
fi
exit "$fail"
