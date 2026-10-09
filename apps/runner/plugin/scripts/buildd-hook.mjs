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
// Usage (Claude Code only, once the session has claimed a task): on Stop and
// SessionEnd the hook reads the NEW lines of the session's own transcript files
// (~/.claude/projects/.../<session>.jsonl and <session>/subagents/agent-*.jsonl)
// and keeps, from each API response record, only its message id, model id, the
// four token counts, the timestamp and how many tool_use blocks it had. Message
// text, tool inputs and outputs are never kept or sent. The cumulative counts
// per claimed task ride on the touch/end request. BUILDD_HOOK_USAGE=0 turns
// this off. With the usage goes how it was charged (`costBasis`: real, virtual
// or unknown), read from the client's own environment and config the way the
// client picks its credential; only that one word is sent.
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
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, writeFileSync } from 'node:fs';
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
      // Every event that can create the presence carries the flag: a session
      // outside a workspace repo sends no start, so its first event is a bind
      // (or a touch healing a missed start).
      return { ...base, event: 'touch', interactive: attended(client, env) };
    case 'PostToolUse': {
      if (!isBuilddTool(p.tool_name)) return null;
      const workerId = claimedWorkerId(p.tool_input, p.tool_response);
      if (!workerId) return null;
      // A subagent's tool call carries its agent_id (and the parent's session_id):
      // kept in this machine's session state to know which subagent holds which
      // claim. Never sent.
      const agentId = typeof p.agent_id === 'string' && /^[\w-]{1,64}$/.test(p.agent_id) ? p.agent_id : null;
      return { ...base, event: 'bind', workerId, interactive: attended(client, env), ...(agentId ? { agentId } : {}) };
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

/** This session's local hook state (which claims it holds, and which subagent made each). */
export function readSessionState(env, client, clientSessionId) {
  return readState(statePath(stateDir(env), client, clientSessionId));
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
export function buildBody(client, n, repo, usage = null) {
  return {
    event: n.event,
    client,
    clientSessionId: n.clientSessionId,
    ...(n.clientVersion ? { clientVersion: n.clientVersion } : {}),
    ...(repo ? { repo } : {}),
    ...(typeof n.interactive === 'boolean' ? { interactive: n.interactive } : {}),
    ...(n.event === 'bind' ? { workerId: n.workerId } : {}),
    ...(n.event === 'end' ? { reason: n.reason } : {}),
    ...(usage && (n.event === 'touch' || n.event === 'end') ? { usage } : {}),
  };
}

// ── Cost basis ───────────────────────────────────────────────────────────────
//
// How the session's usage was charged (docs/specs/real-and-virtual-cost.md):
// `real` (per token: an API key, a bearer token, a cloud provider, a gateway),
// `virtual` (a subscription login, valued at list price) or `unknown`. The
// transcript does not record the credential, so this walks Claude Code's own
// authentication precedence (code.claude.com/docs/en/authentication) and stops
// at the first credential the client would use. Only the resulting word leaves
// this machine; no key, token or config value is read into the body or logged.

const truthy = (v) => typeof v === 'string' && v !== '' && v !== '0' && v.toLowerCase() !== 'false';
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function anthropicHost(url) {
  try { return new URL(url).hostname.endsWith('anthropic.com'); } catch { return false; }
}

/**
 * Pure: the basis for these inputs.
 * - `globalConfig`: the client's `.claude.json` (login and API-key approvals)
 * - `settings` / `managedSettings`: parsed settings files, any order
 * - `profilePresent`: an active Anthropic profile file exists
 */
export function costBasisFor({ env = {}, globalConfig = null, settings = [], managedSettings = [], profilePresent = false }) {
  const cfg = isObj(globalConfig) ? globalConfig : {};
  const managed = managedSettings.filter(isObj);
  const all = [...settings.filter(isObj), ...managed];
  // A required gateway sign-in outranks every other source; it routes to a cloud provider.
  if (managed.some(m => m.forceLoginMethod === 'gateway' || typeof m.forceLoginGatewayUrl === 'string')) return 'real';
  if (['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'].some(k => truthy(env[k]))) return 'real';
  if (truthy(env.ANTHROPIC_AUTH_TOKEN)) return 'real';
  if (truthy(env.ANTHROPIC_API_KEY)) {
    // Non-interactive (-p, SDK) sessions always use the key. An interactive
    // one asks once and remembers the key's last 20 characters.
    if (typeof env.CLAUDE_CODE_ENTRYPOINT === 'string' && env.CLAUDE_CODE_ENTRYPOINT.startsWith('sdk')) return 'real';
    const tail = env.ANTHROPIC_API_KEY.slice(-20);
    const r = isObj(cfg.customApiKeyResponses) ? cfg.customApiKeyResponses : {};
    if (Array.isArray(r.approved) && r.approved.includes(tail)) return 'real';
    if (!(Array.isArray(r.rejected) && r.rejected.includes(tail))) return 'unknown';
  }
  if (all.some(s => typeof s.apiKeyHelper === 'string' && s.apiKeyHelper !== '')) return 'real';
  let basis;
  if (truthy(env.CLAUDE_CODE_OAUTH_TOKEN)) basis = 'virtual';
  else if (truthy(env.ANTHROPIC_PROFILE) || (truthy(env.ANTHROPIC_FEDERATION_RULE_ID) && truthy(env.ANTHROPIC_ORGANIZATION_ID))) return 'real';
  else if (profilePresent) return 'unknown';
  else if (typeof cfg.primaryApiKey === 'string' && cfg.primaryApiKey !== '') return 'real';
  else if (isObj(cfg.oauthAccount)) basis = 'virtual';
  else return 'unknown';
  // A subscription credential sent somewhere other than Anthropic: the hook
  // cannot tell how that endpoint charges.
  if (truthy(env.ANTHROPIC_BASE_URL) && !anthropicHost(env.ANTHROPIC_BASE_URL)) return 'unknown';
  return basis;
}

/** Managed settings locations (code.claude.com/docs/en/settings). */
export const MANAGED_SETTINGS_PATHS = [
  '/Library/Application Support/ClaudeCode/managed-settings.json',
  '/etc/claude-code/managed-settings.json',
  'C:\\Program Files\\ClaudeCode\\managed-settings.json',
];

function readJson(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Reads the client's config once and classifies it. Any error is `unknown`. */
export function sessionCostBasis(env = process.env, home = homedir(), cwd = process.cwd(), managedPaths = MANAGED_SETTINGS_PATHS) {
  try {
    const configDir = env.CLAUDE_CONFIG_DIR || join(home, '.claude');
    const globalConfig = readJson(env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, '.claude.json') : join(home, '.claude.json'));
    const root = gitRoot(cwd) ?? cwd;
    const settings = [
      join(configDir, 'settings.json'),
      join(root, '.claude', 'settings.json'),
      join(root, '.claude', 'settings.local.json'),
    ].map(readJson).filter(Boolean);
    const managedSettings = managedPaths.map(p => { try { return readJson(p); } catch { return null; } }).filter(Boolean);
    const anthropicDir = env.ANTHROPIC_CONFIG_DIR || join(home, '.config', 'anthropic');
    const profilePresent = existsSync(join(anthropicDir, 'active_config')) || existsSync(join(anthropicDir, 'configs', 'default'));
    return costBasisFor({ env, globalConfig, settings, managedSettings, profilePresent });
  } catch (err) {
    debug('cost basis unreadable', err?.message ?? err);
    return 'unknown';
  }
}

// ── Session usage ────────────────────────────────────────────────────────────

/** At most this much new transcript is read per file per hook run; the rest next time. */
export const USAGE_READ_CAP = 8 * 1024 * 1024;
const SEEN_CAP = 5000;
const MODEL_ID_RE = /^[A-Za-z0-9._:/@\[\]-]{1,100}$/;
/** A tool name as sent (`Bash`, `mcp__buildd__buildd`); anything else counts as `other`. */
export const TOOL_NAME_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

/** A session's transcript and each of its subagents' (Claude Code's layout). */
export function sessionTranscriptFiles(transcriptPath) {
  if (typeof transcriptPath !== 'string' || !transcriptPath.endsWith('.jsonl')) return [];
  const files = [{ path: transcriptPath, agentId: null }];
  const dir = join(transcriptPath.slice(0, -'.jsonl'.length), 'subagents');
  try {
    for (const f of readdirSync(dir).sort()) {
      const m = /^agent-([\w-]{1,64})\.jsonl$/.exec(f);
      if (m) files.push({ path: join(dir, f), agentId: m[1] });
    }
  } catch { /* no subagents */ }
  return files;
}

/** Complete lines appended since `offset` (capped). Never throws. */
export function readNewLines(path, offset = 0, cap = USAGE_READ_CAP) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const from = size < offset ? 0 : offset; // truncated or replaced: start over
    const len = Math.min(size - from, cap);
    if (len <= 0) return { lines: [], offset: from };
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, from);
    const lastNl = buf.lastIndexOf(10);
    // One line longer than the cap: skip it rather than stall on it forever.
    if (lastNl < 0) return { lines: [], offset: len === cap ? from + len : from };
    return { lines: buf.subarray(0, lastNl).toString('utf8').split('\n'), offset: from + lastNl + 1 };
  } catch {
    return { lines: [], offset };
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
  }
}

const count = v => (Number.isInteger(v) && v >= 0 ? v : 0);

/**
 * The usage of one transcript line, or null. Only these fields are read: the
 * record type, timestamp, message id and model, the usage counts, and the TYPE
 * of each content block (to count tool calls). Nothing else leaves this function.
 */
export function usageRecord(line) {
  let r;
  try { r = JSON.parse(line); } catch { return null; }
  if (r?.type !== 'assistant') return null;
  const m = r.message;
  const u = m?.usage;
  if (!u || typeof u !== 'object') return null;
  const rawModel = typeof m.model === 'string' ? m.model : '';
  if (rawModel === '<synthetic>') return null; // a client-side placeholder, not an API call
  const written = count(u.cache_creation_input_tokens);
  const split = u.cache_creation && typeof u.cache_creation === 'object';
  const w1h = split ? count(u.cache_creation.ephemeral_1h_input_tokens) : 0;
  const w5m = split ? count(u.cache_creation.ephemeral_5m_input_tokens) : written;
  const at = Date.parse(r.timestamp);
  return {
    id: typeof m.id === 'string' ? m.id : typeof r.requestId === 'string' ? r.requestId : null,
    model: MODEL_ID_RE.test(rawModel) ? rawModel : 'unknown',
    input: count(u.input_tokens),
    cacheRead: count(u.cache_read_input_tokens),
    // Anything the split does not explain is billed like a 5-minute write.
    cacheWrite5m: w5m + Math.max(0, written - w1h - w5m),
    cacheWrite1h: w1h,
    output: count(u.output_tokens),
    // Tool names only (`Bash`, `mcp__buildd__buildd`), never inputs or results;
    // a block's own id dedupes a record Claude Code writes more than once.
    tools: Array.isArray(m.content)
      ? m.content.filter(b => b?.type === 'tool_use').map(b => ({
          id: typeof b.id === 'string' ? b.id : null,
          name: typeof b.name === 'string' && TOOL_NAME_RE.test(b.name) ? b.name : 'other',
        }))
      : [],
    at: Number.isFinite(at) ? at : null,
  };
}

/**
 * Fold the new transcript lines into the per-claim totals kept in session
 * state. Attribution: a subagent that claimed a task is that task's for its
 * whole run; everything else (the session itself, and subagents that claimed
 * nothing) is counted toward the session's own newest claim, else its first,
 * and only from the session's first claim on.
 */
export function collectUsage(prev, transcriptPath, claims, claimedAt) {
  const usage = {
    offsets: { ...(prev?.offsets ?? {}) },
    seen: [...(prev?.seen ?? [])],
    perWorker: JSON.parse(JSON.stringify(prev?.perWorker ?? {})),
  };
  const entries = Object.entries(claims ?? {});
  if (entries.length === 0) return { usage, report: [] };
  const byTime = [...entries].sort((a, b) => (claimedAt?.[a[0]] ?? 0) - (claimedAt?.[b[0]] ?? 0));
  const own = byTime.filter(([, agent]) => agent === null);
  const sessionWorker = (own.length ? own[own.length - 1] : byTime[0])[0];
  const earliest = Math.min(...entries.map(([w]) => claimedAt?.[w] ?? 0));
  const workerOfAgent = new Map(entries.filter(([, a]) => a).map(([w, a]) => [a, w]));
  const seen = new Set(usage.seen);

  for (const f of sessionTranscriptFiles(transcriptPath)) {
    const { lines, offset } = readNewLines(f.path, usage.offsets[f.path] ?? 0);
    usage.offsets[f.path] = offset;
    const claimedBySubagent = f.agentId !== null && workerOfAgent.has(f.agentId);
    const worker = claimedBySubagent ? workerOfAgent.get(f.agentId) : sessionWorker;
    for (const line of lines) {
      if (!line) continue;
      const rec = usageRecord(line);
      if (!rec) continue;
      if (!claimedBySubagent && rec.at !== null && rec.at < earliest) continue;
      const t = (usage.perWorker[worker] ??= { models: {}, toolCalls: 0, toolCounts: {}, agents: [], firstAt: null, lastAt: null });
      t.toolCounts ??= {};
      // One API call is written once per content block: each tool_use block
      // counts once (by its own id), its usage is the same on every copy and
      // counts once (by the message id, below).
      for (const tool of rec.tools) {
        const toolKey = tool.id ? `t:${f.agentId ?? ''}:${tool.id}` : null;
        if (toolKey && seen.has(toolKey)) continue;
        if (toolKey) { seen.add(toolKey); usage.seen.push(toolKey); }
        t.toolCalls += 1;
        t.toolCounts[tool.name] = (t.toolCounts[tool.name] ?? 0) + 1;
      }
      if (f.agentId && !t.agents.includes(f.agentId)) t.agents.push(f.agentId);
      if (rec.at !== null) {
        t.firstAt = t.firstAt === null ? rec.at : Math.min(t.firstAt, rec.at);
        t.lastAt = t.lastAt === null ? rec.at : Math.max(t.lastAt, rec.at);
      }
      const key = rec.id ? `${f.agentId ?? ''}:${rec.id}` : null;
      if (key && seen.has(key)) continue;
      if (key) { seen.add(key); usage.seen.push(key); }
      const b = (t.models[rec.model] ??= { input: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0, requests: 0 });
      b.input += rec.input; b.cacheRead += rec.cacheRead; b.cacheWrite5m += rec.cacheWrite5m;
      b.cacheWrite1h += rec.cacheWrite1h; b.output += rec.output; b.requests += 1;
    }
  }
  if (usage.seen.length > SEEN_CAP) usage.seen = usage.seen.slice(-SEEN_CAP);

  const report = Object.entries(usage.perWorker)
    .filter(([w]) => claims[w] !== undefined)
    .map(([workerId, t]) => ({
      workerId,
      models: Object.entries(t.models).map(([model, b]) => ({ model, ...b })),
      toolCalls: t.toolCalls,
      toolCounts: { ...(t.toolCounts ?? {}) },
      subagents: t.agents.length,
      ...(t.firstAt !== null ? { firstAt: new Date(t.firstAt).toISOString() } : {}),
      ...(t.lastAt !== null ? { lastAt: new Date(t.lastAt).toISOString() } : {}),
    }));
  return { usage, report };
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

  // Usage rides on the session's own touch/end, once it holds a claim.
  let usageState = state.usage;
  let usageReport = null;
  const claimsNow = state.claims && Object.keys(state.claims).length > 0 ? state.claims : null;
  if (client === 'claude' && env.BUILDD_HOOK_USAGE !== '0' && claimsNow && (n.event === 'touch' || n.event === 'end')) {
    try {
      const c = collectUsage(state.usage, payload?.transcript_path, claimsNow, state.claimedAt);
      usageState = c.usage;
      if (c.report.length > 0) usageReport = { workers: c.report, costBasis: sessionCostBasis(env, homedir(), n.cwd) };
    } catch (err) {
      debug('usage read failed', err?.message ?? err);
    }
  }

  const body = buildBody(client, n, repo, usageReport);
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
  // claims: worker id -> the subagent that claimed it (null: the session itself).
  const claims = n.event === 'bind' ? { ...(state.claims ?? {}), [n.workerId]: n.agentId ?? null } : state.claims;
  const claimedAt = n.event === 'bind' ? { ...(state.claimedAt ?? {}), [n.workerId]: state.claimedAt?.[n.workerId] ?? now } : state.claimedAt;
  writeState(file, {
    ...state, scope, lastSentAt: now, lastEvent: n.event,
    ...(claims ? { claims } : {}),
    ...(claimedAt ? { claimedAt } : {}),
    ...(usageState ? { usage: usageState } : {}),
  });
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
