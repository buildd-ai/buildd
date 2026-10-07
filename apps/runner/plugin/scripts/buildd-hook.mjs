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
// Scope: presence is reported only for a session opened in a git repo that is
// one of the account's buildd workspaces (checked here, against a cached list of
// workspace repos), in a repo whose own .mcp.json names a buildd server, or for
// a session that claimed a buildd task. Anywhere else
// the hook sends nothing at all, not even the folder's name.
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
export const PRESENCE_TOKEN_PREFIX = 'bldp_';
/** Client-side coalescing: at most one touch a minute per session. */
export const TOUCH_INTERVAL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 3_000;
/** A start in a repo missing from the cached workspace list refetches it at most this often. */
export const WORKSPACE_REFRESH_MS = 10 * 60_000;
const LIST_TIMEOUT_MS = 2_000;
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
    case 'Stop':
      return { ...base, event: 'touch' };
    case 'PostToolUse': {
      if (!isBuilddTool(p.tool_name)) return null;
      const workerId = claimedWorkerId(p.tool_input, p.tool_response);
      return workerId ? { ...base, event: 'bind', workerId } : null;
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

export function gitRepo(cwd) {
  try {
    const url = execFileSync('git', ['-C', cwd, 'config', '--get', 'remote.origin.url'], { timeout: 1_000, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    return repoSlug(url);
  } catch {
    return null;
  }
}

/**
 * The credential the hook sends. The person's presence token (written by
 * `buildd login`, BUILDD_PRESENCE_TOKEN overrides) wins: it reaches every team
 * the person is in and can do nothing but report presence. Else the account
 * API key. `apiKey` is the bearer either way; `kind` says which.
 */
export function resolveAuth(env = process.env, home = homedir()) {
  let cfg = {};
  try {
    cfg = JSON.parse(readFileSync(join(env.BUILDD_HOME || join(home, '.buildd'), 'config.json'), 'utf8')) ?? {};
  } catch { /* not logged in */ }
  const server = (env.BUILDD_SERVER || cfg.builddServer || 'https://buildd.dev').replace(/\/+$/, '');
  const presence = env.BUILDD_PRESENCE_TOKEN || cfg.presenceToken || null;
  if (typeof presence === 'string' && presence.startsWith(PRESENCE_TOKEN_PREFIX)) return { apiKey: presence, server, kind: 'presence' };
  const apiKey = env.BUILDD_API_KEY || cfg.apiKey || null;
  return apiKey ? { apiKey, server, kind: 'key' } : null;
}

/** One list per credential: two teams' keys, or a key and a presence token, never share a workspace list. */
export function workspaceCachePath(env = process.env, apiKey = '', home = homedir()) {
  const id = createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
  return join(env.BUILDD_HOME || join(home, '.buildd'), `workspace-repos-${id}.json`);
}

export function readWorkspaceCache(env = process.env, apiKey = '') {
  try {
    const c = JSON.parse(readFileSync(workspaceCachePath(env, apiKey), 'utf8'));
    if (!Array.isArray(c.repos)) return null;
    return { repos: c.repos.filter(r => typeof r === 'string'), fetchedAt: Number(c.fetchedAt) || 0 };
  } catch {
    return null;
  }
}

export function writeWorkspaceCache(env, apiKey, repos, now = Date.now()) {
  try {
    const file = workspaceCachePath(env, apiKey);
    mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify({ repos, fetchedAt: now }), { mode: 0o600 });
  } catch { /* the next start refetches */ }
}

/**
 * owner/name (lowercased) of every workspace repo this key reaches, or null on
 * any failure. A plain list call: it says nothing about the caller's folder.
 */
export async function fetchWorkspaceRepos(auth, fetchImpl = globalThis.fetch) {
  const list = await fetchWorkspaces(auth, fetchImpl);
  return list ? [...new Set(list.map(w => w.repo))].sort() : null;
}

/**
 * `{ id, repo }` (repo as lowercased owner/name) of every workspace with a repo
 * that this key reaches, in the server's order, or null on any failure. The
 * installer needs the id for the per-workspace OAuth MCP endpoint; the hook's
 * cached list keeps only the repos.
 */
export async function fetchWorkspaces(auth, fetchImpl = globalThis.fetch) {
  try {
    // A presence token reads the person's workspace repos across all their
    // teams; it is refused by /api/workspaces like by every non-presence route.
    const path = auth.kind === 'presence' ? '/api/workers/local-sessions/workspaces' : '/api/workspaces';
    const res = await fetchImpl(`${auth.server}${path}`, {
      headers: { Authorization: `Bearer ${auth.apiKey}`, 'X-Buildd-Hook': HOOK_VERSION },
      signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = await res.json();
    if (!Array.isArray(body?.workspaces)) return null;
    return body.workspaces
      .map(w => ({ id: typeof w?.id === 'string' ? w.id : null, repo: repoSlug(w?.repo)?.toLowerCase() ?? null }))
      .filter(w => w.repo);
  } catch {
    return null;
  }
}

/** Whether repo is a workspace repo. Unknown (no list, buildd down) answers false: nothing is sent. */
export async function isWorkspaceRepo(repo, { env = process.env, auth, fetchImpl = globalThis.fetch, now = Date.now() }) {
  if (!repo) return false;
  const want = repo.toLowerCase();
  const cache = readWorkspaceCache(env, auth.apiKey);
  if (cache?.repos.includes(want)) return true;
  if (cache && now - cache.fetchedAt < WORKSPACE_REFRESH_MS) return false;
  const fresh = await fetchWorkspaceRepos(auth, fetchImpl);
  if (!fresh) return false;
  writeWorkspaceCache(env, auth.apiKey, fresh, now);
  return fresh.includes(want);
}

/** Git root of cwd, or null. */
export function gitRoot(cwd) {
  try {
    return execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { timeout: 1_000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null;
  } catch {
    return null;
  }
}

/** The folder's own .mcp.json names a buildd MCP server: someone set it up for buildd on purpose. */
export function hasProjectBuilddMcp(dir) {
  if (!dir) return false;
  try {
    const servers = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8'))?.mcpServers ?? {};
    return Object.values(servers).some(s => typeof s?.url === 'string' && /\/api\/mcp\/?(\?.*)?$/.test(s.url));
  } catch {
    return false;
  }
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

/** Whether to skip a touch because one went out this minute. Start/bind/end always go. */
export function shouldSkip(event, state, now = Date.now()) {
  return event === 'touch' && typeof state.lastSentAt === 'number' && now - state.lastSentAt < TOUCH_INTERVAL_MS;
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

/** Hook stdout for the client, or '' for none. Only a nudge toward the existing delivery path. */
export function hookOutput(client, hookEventName, result) {
  if (client === 'cursor') return hookEventName === 'sessionStart' ? '{}' : '';
  if (!result?.pendingInstructions || hookEventName !== 'UserPromptSubmit') return '';
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: `Buildd has an unread message for the task this session claimed${result.taskId ? ` (${result.taskId.slice(0, 8)})` : ''}. Call buildd update_progress to receive it.`,
    },
  });
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
  if (shouldSkip(n.event, state, now)) return { sent: false, why: 'throttled', output: hookOutput(client, hookEventName, null) };

  // Scope. A claim is explicit buildd work, so bind always goes and the session
  // is in scope from then on. Otherwise the folder decides, once per session
  // (again on a resumed start); an out-of-scope session costs no git call later.
  let scope = state.scope;
  let repo = null;
  if (n.event === 'bind') {
    scope = 'in';
  } else if (scope !== 'in') {
    if (scope === 'out' && n.event !== 'start') {
      return { sent: false, why: 'outside_workspace', output: hookOutput(client, hookEventName, null) };
    }
    repo = gitRepo(n.cwd);
    const inScope = hasProjectBuilddMcp(gitRoot(n.cwd) ?? n.cwd) || await isWorkspaceRepo(repo, { env, auth, fetchImpl, now });
    if (!inScope) {
      writeState(file, { ...state, scope: 'out' });
      return { sent: false, why: 'outside_workspace', output: hookOutput(client, hookEventName, null) };
    }
    scope = 'in';
  } else if (n.event === 'start') {
    repo = gitRepo(n.cwd);
  }

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
  writeState(file, { ...state, scope, lastSentAt: now, lastEvent: n.event });
  return { sent: true, ok: !!result, body, output: hookOutput(client, hookEventName, result) };
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
