#!/usr/bin/env node
// buildd agent plugin: lifecycle hook.
//
//   node buildd-hook.mjs <claude|codex|cursor>   (hook payload JSON on stdin)
//
// Reports that an interactive coding session exists to buildd, so buildd can
// show it as presence and keep the task it claimed alive. It sends ONE typed
// event per hook (start | touch | bind | end) and nothing else: no transcript,
// prompt, response or reasoning ever leaves this machine. The only tool output
// it reads is the worker id in buildd's own claim_task reply.
//
// It never breaks the agent loop: every failure (no key, buildd down, non-2xx,
// bad payload, timeout) is swallowed and the script exits 0. MCP stays the
// control plane; without this hook buildd still works exactly as before.
//
// Auth: BUILDD_API_KEY / BUILDD_SERVER from the environment, else
// ~/.buildd/config.json (written by `buildd login`). No key is stored in hook
// config. Set BUILDD_HOOKS_DISABLED=1 to turn it off. BUILDD_HOOK_DEBUG=1 logs
// to stderr.
//
// Zero dependencies: Node 18+ (or Bun), so it runs wherever the client does.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const HOOK_VERSION = '1';
/** Client-side coalescing: at most one touch a minute per session. */
export const TOUCH_INTERVAL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 3_000;
const STDIN_TIMEOUT_MS = 2_000;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const WORKER_ID_RE = /Worker ID:\**\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

const debug = (...a) => { if (process.env.BUILDD_HOOK_DEBUG === '1') console.error('[buildd-hook]', ...a); };

/** buildd's MCP tool, under any server name the client gave it (buildd, plugin_buildd_buildd, ...). */
export function isBuilddTool(toolName, serverName) {
  if (typeof toolName !== 'string') return false;
  const prefixed = /^mcp__(.+)__buildd(_work)?$/i.exec(toolName);
  if (prefixed) return /buildd/i.test(prefixed[1]);
  // Cursor names the tool without the server prefix and reports the server separately.
  return /^buildd(_work)?$/i.test(toolName) && (serverName == null || /buildd/i.test(String(serverName)));
}

function parseMaybeJson(v) {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return v; }
}

/** The worker id from a successful claim_task reply, or null. */
export function claimedWorkerId(toolInput, toolResponse) {
  const input = parseMaybeJson(toolInput);
  if (!input || typeof input !== 'object' || input.action !== 'claim_task') return null;
  const text = typeof toolResponse === 'string' ? toolResponse : JSON.stringify(toolResponse ?? '');
  if (/"isError"\s*:\s*true/.test(text)) return null;
  const m = WORKER_ID_RE.exec(text);
  return m && UUID_RE.test(m[1]) ? m[1].toLowerCase() : null;
}

/**
 * One client's hook payload → a buildd session event, or null to ignore.
 * Returns { event, clientSessionId, cwd, clientVersion?, interactive?, workerId?, reason? }.
 * Only these fields are ever read from the payload.
 */
export function normalizeHookEvent(client, payload, env = process.env) {
  if (!payload || typeof payload !== 'object') return null;
  if (client === 'cursor') return normalizeCursor(payload);
  if (client === 'claude' || client === 'codex') return normalizeClaudeLike(client, payload, env);
  return null;
}

/**
 * Whether a person is at the keyboard. Claude Code sets both variables on every
 * hook it spawns: ATTENDED=0 / ENTRYPOINT=sdk-* for `claude -p` and SDK runs.
 * ATTENDED is checked first because a child process can inherit its parent's
 * ENTRYPOINT. A client that sets neither (Codex) is treated as attended.
 */
function attended(client, env) {
  if (client !== 'claude') return true;
  if (env.CLAUDE_CODE_SESSION_ATTENDED === '0') return false;
  if (env.CLAUDE_CODE_SESSION_ATTENDED === '1') return true;
  return !(typeof env.CLAUDE_CODE_ENTRYPOINT === 'string' && env.CLAUDE_CODE_ENTRYPOINT.startsWith('sdk'));
}

function normalizeClaudeLike(client, p, env) {
  const clientSessionId = typeof p.session_id === 'string' ? p.session_id : null;
  if (!clientSessionId) return null;
  const base = { clientSessionId, cwd: typeof p.cwd === 'string' ? p.cwd : process.cwd() };
  switch (p.hook_event_name) {
    case 'SessionStart':
      return { ...base, event: 'start', interactive: attended(client, env) };
    case 'UserPromptSubmit':
      return { ...base, event: 'touch' };
    // The end of the agent's turn: the last chance to hand it a waiting
    // message this turn, so it is never throttled.
    case 'Stop':
      return { ...base, event: 'touch', force: true };
    case 'PostToolUse': {
      // A successful buildd claim binds. Any other tool call is a turn
      // boundary: a (throttled) touch, whose answer says whether a message waits.
      const workerId = isBuilddTool(p.tool_name) ? claimedWorkerId(p.tool_input, p.tool_response) : null;
      return workerId ? { ...base, event: 'bind', workerId } : { ...base, event: 'touch' };
    }
    case 'SessionEnd': {
      // Claude: clear | resume | logout | prompt_input_exit | other. Codex: always other.
      const r = p.reason;
      const reason = r === 'clear' ? 'clear' : r === 'logout' || r === 'prompt_input_exit' || r === 'resume' ? 'exit' : 'other';
      return { ...base, event: 'end', reason };
    }
    default:
      return null;
  }
}

function normalizeCursor(p) {
  // conversation_id is on every Cursor hook and stable across turns.
  const clientSessionId = typeof p.conversation_id === 'string' ? p.conversation_id
    : typeof p.session_id === 'string' ? p.session_id : null;
  if (!clientSessionId) return null;
  const roots = Array.isArray(p.workspace_roots) ? p.workspace_roots : [];
  const base = {
    clientSessionId,
    cwd: typeof roots[0] === 'string' ? roots[0] : process.cwd(),
    ...(typeof p.cursor_version === 'string' ? { clientVersion: p.cursor_version } : {}),
  };
  switch (p.hook_event_name) {
    case 'sessionStart':
      return { ...base, event: 'start', interactive: p.is_background_agent !== true };
    case 'afterAgentResponse':
    case 'stop':
      return { ...base, event: 'touch' };
    case 'afterMCPExecution': {
      if (!isBuilddTool(p.tool_name, p.mcp_server_name)) return null;
      const workerId = claimedWorkerId(p.tool_input, p.result_json);
      return workerId ? { ...base, event: 'bind', workerId } : null;
    }
    case 'sessionEnd':
      // Only a closed window/tab is the session going away. A completed or
      // aborted agent run leaves the conversation open, so it stays a touch.
      return p.reason === 'window_close' || p.reason === 'user_close'
        ? { ...base, event: 'end', reason: 'exit' }
        : { ...base, event: 'touch' };
    default:
      return null;
  }
}

/** owner/name of a git remote, credentials and host dropped. Mirrors normalizeRepoSlug in @buildd/shared. */
export function repoSlug(remote) {
  if (!remote || typeof remote !== 'string') return null;
  let s = remote.trim().replace(/\.git\/?$/, '').replace(/\/+$/, '');
  const scp = /^[^@/\s]+@[^:/\s]+:(.+)$/.exec(s);
  let path;
  if (scp) path = scp[1];
  else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) { try { path = new URL(s).pathname; } catch { return null; } }
  else path = s;
  const parts = path.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const [owner, name] = parts.slice(-2);
  return /^[\w.-]+$/.test(owner) && /^[\w.-]+$/.test(name) ? `${owner}/${name}` : null;
}

function gitRepo(cwd) {
  try {
    const url = execFileSync('git', ['-C', cwd, 'config', '--get', 'remote.origin.url'], { timeout: 1_000, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    return repoSlug(url);
  } catch {
    return null;
  }
}

export function resolveAuth(env = process.env, home = homedir()) {
  let apiKey = env.BUILDD_API_KEY || null;
  let server = env.BUILDD_SERVER || null;
  if (!apiKey || !server) {
    try {
      const cfg = JSON.parse(readFileSync(join(env.BUILDD_HOME || join(home, '.buildd'), 'config.json'), 'utf8'));
      apiKey = apiKey || cfg.apiKey || null;
      server = server || cfg.builddServer || null;
    } catch { /* not logged in */ }
  }
  return apiKey ? { apiKey, server: (server || 'https://buildd.dev').replace(/\/+$/, '') } : null;
}

function stateDir(env = process.env) {
  return env.CLAUDE_PLUGIN_DATA || env.PLUGIN_DATA || join(env.BUILDD_HOME || join(homedir(), '.buildd'), 'local-sessions');
}

function statePath(dir, client, clientSessionId) {
  return join(dir, `${createHash('sha256').update(`${client}:${clientSessionId}`).digest('hex').slice(0, 32)}.json`);
}

function readState(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; }
}

function writeState(file, state) {
  try {
    mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
  } catch { /* throttling degrades to server-side coalescing */ }
}

/** Whether to skip a touch because one went out this minute. Start/bind/end and forced touches (Stop) always go. */
export function shouldSkip(event, state, now = Date.now(), force = false) {
  return !force && event === 'touch' && typeof state.lastSentAt === 'number' && now - state.lastSentAt < TOUCH_INTERVAL_MS;
}

/** The exact body POSTed. Built from the normalized event only. */
export function buildBody(client, n, repo) {
  return {
    event: n.event,
    client,
    clientSessionId: n.clientSessionId,
    ...(n.clientVersion ? { clientVersion: n.clientVersion } : {}),
    ...(repo ? { repo } : {}),
    ...(typeof n.interactive === 'boolean' ? { interactive: n.interactive } : {}),
    ...(n.event === 'bind' ? { workerId: n.workerId } : {}),
    ...(n.event === 'end' ? { reason: n.reason } : {}),
  };
}

/**
 * Hook stdout for the client, or '' for none. Only a nudge toward the MCP
 * (`receive_messages`): the message text itself never travels through a hook,
 * and only the boolean `pendingInstructions` is read from buildd's answer.
 *
 * At every turn boundary the client exposes: a prompt (UserPromptSubmit), a
 * tool call (PostToolUse, context for the next model call) and the end of the
 * turn (Stop: block once so the agent collects it before stopping, never
 * again while `stop_hook_active`, so it cannot loop). Cursor stays queued-only.
 */
export function hookOutput(client, hookEventName, result, payload = null) {
  if (client === 'cursor') return hookEventName === 'sessionStart' ? '{}' : '';
  if (!result?.pendingInstructions) return '';
  const nudge = `Buildd has an unread message for the task this session claimed${typeof result.taskId === 'string' ? ` (${result.taskId.slice(0, 8)})` : ''}. Call buildd receive_messages to read it.`;
  switch (hookEventName) {
    case 'UserPromptSubmit':
    case 'PostToolUse':
      return JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: nudge } });
    case 'Stop':
      if (payload?.stop_hook_active === true) return '';
      return JSON.stringify({ decision: 'block', reason: nudge });
    default:
      return '';
  }
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  return new Promise(resolve => {
    let data = '';
    const t = setTimeout(() => resolve(data), STDIN_TIMEOUT_MS);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => { data += c; if (data.length > 5_000_000) { clearTimeout(t); resolve(data); } });
    process.stdin.on('end', () => { clearTimeout(t); resolve(data); });
    process.stdin.on('error', () => { clearTimeout(t); resolve(data); });
  });
}

export async function run({ client, stdin, env = process.env, fetchImpl = globalThis.fetch, now = Date.now() }) {
  if (env.BUILDD_HOOKS_DISABLED === '1') return { sent: false, why: 'disabled', output: '' };
  let payload;
  try { payload = JSON.parse(stdin || '{}'); } catch { return { sent: false, why: 'bad_payload', output: '' }; }
  const hookEventName = payload?.hook_event_name;
  const n = normalizeHookEvent(client, payload, env);
  if (!n) return { sent: false, why: 'ignored', output: hookOutput(client, hookEventName, null) };
  const auth = resolveAuth(env);
  if (!auth) return { sent: false, why: 'no_key', output: hookOutput(client, hookEventName, null) };

  const file = statePath(stateDir(env), client, n.clientSessionId);
  const state = readState(file);
  if (shouldSkip(n.event, state, now, n.force === true)) return { sent: false, why: 'throttled', output: hookOutput(client, hookEventName, null) };

  const repo = n.event === 'start' ? gitRepo(n.cwd) : null;
  const body = buildBody(client, n, repo);
  let result = null;
  try {
    const res = await fetchImpl(`${auth.server}/api/workers/local-sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.apiKey}`, 'X-Buildd-Hook': HOOK_VERSION },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.ok) result = await res.json().catch(() => null);
    else debug('non-2xx', res.status);
  } catch (err) {
    debug('request failed', err?.message ?? err);
  }
  writeState(file, { ...state, lastSentAt: now, lastEvent: n.event });
  return { sent: true, ok: !!result, body, output: hookOutput(client, hookEventName, result, payload) };
}

async function main() {
  const client = process.argv[2];
  try {
    const stdin = await readStdin();
    const r = await run({ client, stdin });
    if (r.output) process.stdout.write(r.output);
    debug(r.why ?? (r.ok ? 'ok' : 'failed'), r.body?.event ?? '');
  } catch (err) {
    debug('unexpected', err?.message ?? err);
  }
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
