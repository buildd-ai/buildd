/**
 * `buildd install` for interactive coding clients: puts the buildd agent
 * plugin's lifecycle hooks (apps/runner/plugin) into Claude Code, Codex and
 * Cursor, and takes them out again.
 *
 *   buildd install --global            hooks + skill for every detected client (user level)
 *   buildd install                     the same, for the current repo only
 *   buildd install --uninstall [--global]
 *   buildd install --status [--global]
 *   buildd install --global --oauth    MCP sign-in with no key on disk, acting as you
 *   buildd install --global --as-agent the same, acting as your agent
 *   --client=claude,codex,cursor       limit to these clients
 *
 * Ownership rule: a hook handler is buildd's if and only if its command names
 * `buildd-hook.mjs`. Install replaces exactly those handlers and appends fresh
 * ones; uninstall removes exactly those and drops a matcher group or event
 * only when buildd's handlers were all it held. Every other hook, setting and
 * key in the file is written back untouched. Both are idempotent.
 *
 * No credential is written into any hook config: the hook reads the key from
 * the environment or ~/.buildd/config.json at run time.
 *
 * Codex asks you to trust each new hook (`/hooks`) before it runs. This never
 * pre-trusts anything; it tells you to review them.
 */
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
// The hook's own helpers, so the installer and the hook agree on what a workspace repo is.
import { fetchWorkspaces, gitRepo, gitRoot, hasProjectBuilddMcp, readWorkspaceCache, resolveAuth, writeWorkspaceCache } from '../plugin/scripts/buildd-hook.mjs';
import { resolveBuilddHome } from './buildd-home';

export const BUILDD_HOOK_MARKER = 'buildd-hook.mjs';
export const BUILDD_SKILL_NAME = 'buildd-session';
export const AGENT_CLIENTS = ['claude', 'codex', 'cursor'] as const;
export type AgentClient = (typeof AGENT_CLIENTS)[number];
export type InstallScope = 'global' | 'project';

type Json = Record<string, any>;

// ── Hook definitions ────────────────────────────────────────────────────────

/**
 * Claude Code / Codex hook events (same schema). `async` keeps the agent loop
 * from waiting on buildd where nothing is returned to it (SessionStart).
 * UserPromptSubmit, PostToolUse and Stop stay synchronous because each may
 * hand the agent a one-line "you have a message, call receive_messages" nudge
 * at that turn boundary (an async hook's output is never read); SessionEnd
 * because an async hook can be cut off as the process exits. PostToolUse
 * matches every tool: any tool call is a boundary. It costs one node start per
 * call, and at most one request a minute (touches are throttled client-side).
 * PreToolUse marks the session as inside a turn before a tool runs, so a long
 * silent command does not read as an abandoned session; nothing is returned to
 * the agent, so it is async (it sends only when the mark flips, or once a minute).
 * Codex does not take `async`, so it gets none.
 */
export function claudeLikeHookEntries(command: string, opts: { async: boolean }): Record<string, Json[]> {
  const handler = (async: boolean) => ({
    type: 'command',
    command,
    timeout: 5,
    ...(opts.async && async ? { async: true } : {}),
  });
  return {
    SessionStart: [{ hooks: [handler(true)] }],
    UserPromptSubmit: [{ hooks: [handler(false)] }],
    Stop: [{ hooks: [handler(false)] }],
    PreToolUse: [{ hooks: [handler(true)] }],
    PostToolUse: [{ hooks: [handler(false)] }],
    SessionEnd: [{ hooks: [handler(false)] }],
  };
}

/** Cursor hook events. No beforeSubmitPrompt: a permission hook's output is parsed strictly. */
export function cursorHookEntries(command: string): Record<string, Json[]> {
  const h = () => ({ command, timeout: 5 });
  return {
    sessionStart: [h()],
    afterAgentResponse: [h()],
    stop: [h()],
    afterMCPExecution: [h()],
    sessionEnd: [h()],
  };
}

export function isBuilddOwned(command: unknown): boolean {
  return typeof command === 'string' && command.includes(BUILDD_HOOK_MARKER);
}

// ── Merge / unmerge (pure) ──────────────────────────────────────────────────

/** Remove buildd's handlers from a Claude/Codex `hooks` settings object. */
export function removeClaudeLikeHooks(settings: Json): Json {
  const out: Json = { ...settings };
  if (!out.hooks || typeof out.hooks !== 'object') return out;
  const hooks: Json = {};
  for (const [event, groups] of Object.entries(out.hooks as Json)) {
    if (!Array.isArray(groups)) { hooks[event] = groups; continue; }
    const kept: Json[] = [];
    for (const group of groups) {
      if (!group || !Array.isArray(group.hooks)) { kept.push(group); continue; }
      const handlers = group.hooks.filter((h: Json) => !isBuilddOwned(h?.command));
      if (handlers.length === group.hooks.length) kept.push(group);
      else if (handlers.length > 0) kept.push({ ...group, hooks: handlers });
    }
    if (kept.length > 0) hooks[event] = kept;
  }
  if (Object.keys(hooks).length > 0) out.hooks = hooks;
  else delete out.hooks;
  return out;
}

export function mergeClaudeLikeHooks(settings: Json, entries: Record<string, Json[]>): Json {
  const out = removeClaudeLikeHooks(settings);
  const hooks: Json = { ...(out.hooks ?? {}) };
  for (const [event, groups] of Object.entries(entries)) {
    hooks[event] = [...(Array.isArray(hooks[event]) ? hooks[event] : []), ...groups];
  }
  return { ...out, hooks };
}

/** Remove buildd's handlers from a Cursor hooks.json. */
export function removeCursorHooks(file: Json): Json {
  const out: Json = { ...file };
  if (!out.hooks || typeof out.hooks !== 'object') return out;
  const hooks: Json = {};
  for (const [event, handlers] of Object.entries(out.hooks as Json)) {
    if (!Array.isArray(handlers)) { hooks[event] = handlers; continue; }
    const kept = handlers.filter((h: Json) => !isBuilddOwned(h?.command));
    if (kept.length > 0) hooks[event] = kept;
  }
  out.hooks = hooks;
  return out;
}

export function mergeCursorHooks(file: Json, entries: Record<string, Json[]>): Json {
  const out = removeCursorHooks(file);
  const hooks: Json = { ...(out.hooks ?? {}) };
  for (const [event, handlers] of Object.entries(entries)) {
    hooks[event] = [...(Array.isArray(hooks[event]) ? hooks[event] : []), ...handlers];
  }
  return { version: out.version ?? 1, ...out, hooks };
}

/** Events that carry at least one buildd handler. */
export function installedEvents(client: AgentClient, file: Json): string[] {
  const hooks = file?.hooks;
  if (!hooks || typeof hooks !== 'object') return [];
  return Object.entries(hooks as Json)
    .filter(([, v]) => Array.isArray(v) && v.some((g: Json) =>
      client === 'cursor' ? isBuilddOwned(g?.command) : Array.isArray(g?.hooks) && g.hooks.some((h: Json) => isBuilddOwned(h?.command))))
    .map(([k]) => k);
}

// ── Files ───────────────────────────────────────────────────────────────────

export interface InstallContext {
  home: string;
  scope: InstallScope;
  /** Repo root for project scope. */
  projectDir: string;
  /** Absolute path of the hook script. */
  scriptPath: string;
  /** Absolute path of the JS runtime that runs it (bun or node). */
  runtime: string;
  /** Directory holding the plugin's skills/. */
  pluginDir: string;
}

export function hookFile(client: AgentClient, ctx: Pick<InstallContext, 'home' | 'scope' | 'projectDir'>): string {
  const base = ctx.scope === 'global' ? ctx.home : ctx.projectDir;
  switch (client) {
    // Project scope uses the local (uncommitted) settings: the hook path is this machine's.
    case 'claude': return ctx.scope === 'global' ? join(base, '.claude', 'settings.json') : join(base, '.claude', 'settings.local.json');
    case 'codex': return join(base, '.codex', 'hooks.json');
    case 'cursor': return join(base, '.cursor', 'hooks.json');
  }
}

/** A client counts as present when its config directory exists. */
export function detectClients(home: string): AgentClient[] {
  return AGENT_CLIENTS.filter(c => existsSync(join(home, `.${c}`)));
}

export function hookCommand(ctx: Pick<InstallContext, 'runtime' | 'scriptPath'>, client: AgentClient): string {
  const isBun = /(^|[\\/])bun(\.exe)?$/.test(ctx.runtime);
  // --no-env-file: a project's .env must never redirect the hook's server or key.
  return `"${ctx.runtime}"${isBun ? ' --no-env-file' : ''} "${ctx.scriptPath}" ${client}`;
}

function readJson(path: string): Json {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, 'utf8');
  if (!raw.trim()) return {};
  // A file we cannot parse is never overwritten.
  return JSON.parse(raw);
}

function writeJson(path: string, value: Json): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

function skillDir(ctx: Pick<InstallContext, 'home' | 'scope' | 'projectDir'>): string {
  return join(ctx.scope === 'global' ? ctx.home : ctx.projectDir, '.claude', 'skills', BUILDD_SKILL_NAME);
}

export interface ClientReport {
  client: AgentClient;
  file: string;
  action: 'installed' | 'updated' | 'removed' | 'unchanged' | 'absent' | 'error';
  events: string[];
  note?: string;
}

export function installClient(client: AgentClient, ctx: InstallContext): ClientReport {
  const file = hookFile(client, ctx);
  try {
    const before = readJson(file);
    const command = hookCommand(ctx, client);
    const after = client === 'cursor'
      ? mergeCursorHooks(before, cursorHookEntries(command))
      : mergeClaudeLikeHooks(before, claudeLikeHookEntries(command, { async: client === 'claude' }));
    const changed = JSON.stringify(before) !== JSON.stringify(after);
    const had = installedEvents(client, before).length > 0;
    if (changed) writeJson(file, after);
    if (client === 'claude') installSkill(ctx);
    return {
      client,
      file,
      action: !changed ? 'unchanged' : had ? 'updated' : 'installed',
      events: installedEvents(client, after),
      ...(client === 'codex' ? { note: 'Codex runs a new hook only after you trust it: open Codex and review them with /hooks.' } : {}),
    };
  } catch (err) {
    return { client, file, action: 'error', events: [], note: `left untouched: ${(err as Error).message}` };
  }
}

export function uninstallClient(client: AgentClient, ctx: Pick<InstallContext, 'home' | 'scope' | 'projectDir'>): ClientReport {
  const file = hookFile(client, ctx);
  try {
    if (client === 'claude') rmSync(skillDir(ctx), { recursive: true, force: true });
    if (!existsSync(file)) return { client, file, action: 'absent', events: [] };
    const before = readJson(file);
    if (installedEvents(client, before).length === 0) return { client, file, action: 'unchanged', events: [] };
    const after = client === 'cursor' ? removeCursorHooks(before) : removeClaudeLikeHooks(before);
    writeJson(file, after);
    return { client, file, action: 'removed', events: [] };
  } catch (err) {
    return { client, file, action: 'error', events: [], note: `left untouched: ${(err as Error).message}` };
  }
}

export function clientStatus(client: AgentClient, ctx: Pick<InstallContext, 'home' | 'scope' | 'projectDir'>): ClientReport {
  const file = hookFile(client, ctx);
  try {
    const events = installedEvents(client, readJson(file));
    return { client, file, action: events.length > 0 ? 'installed' : 'absent', events };
  } catch (err) {
    return { client, file, action: 'error', events: [], note: (err as Error).message };
  }
}

function installSkill(ctx: InstallContext): void {
  const src = join(ctx.pluginDir, 'skills', BUILDD_SKILL_NAME);
  if (!existsSync(src)) return;
  const dest = skillDir(ctx);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true });
}

// ── MCP registration (Claude Code, ~/.claude.json) ──────────────────────────
//
// By default the buildd MCP server is registered per folder, only for folders
// whose git repo is one of the account's workspaces: outside them Claude Code
// loads no buildd tools at all. `--here` registers it for the current folder
// regardless (e.g. to set up a new workspace); `--everywhere` keeps the old
// user-wide entry.
//
// `--oauth` writes no key. On a server that offers one connection across
// workspaces (its /api/mcp answers with an OAuth challenge), each folder points
// at <server>/api/mcp and Claude Code signs the person in in the browser the
// first time; the person picks the workspaces on the consent page. The entry
// pins Claude Code's requested scopes (`oauth.scopes`, see
// code.claude.com/docs/en/mcp) to include `buildd:act-as-person`, so the
// connection acts as the person; `--as-agent` leaves that scope out and the
// connection acts as their agent (for a shared or remote machine). The server
// never advertises the person scope, so only an entry that names it asks for it.
// On an older server each folder points at that workspace's own OAuth endpoint
// (/api/mcp-oauth/<workspaceId>) as before. Opt-in until a full Claude Code
// sign-in has been proven end to end.
//
// The login key belongs to ONE team. The folders come from every team the
// person is in (their presence token's list), and a folder whose workspace
// the key's team cannot reach always gets the OAuth entry: a key entry there
// would shadow the folder's own .mcp.json with a key that cannot see the
// workspace. Re-running repairs such an entry, wherever it is.

export type McpMode = 'workspaces' | 'here' | 'everywhere';

export interface McpPlan {
  config: Json;
  /** Folders that now have the buildd entry (new or refreshed), and whether it signs in with OAuth. */
  folders: Array<{ path: string; repo: string | null; oauth: boolean; otherTeam: boolean }>;
  /** Folders whose key entry, from a team that cannot reach their workspace, was switched to OAuth. */
  repaired: string[];
  /** Workspace folders left alone because their own .mcp.json already names buildd. */
  selfConfigured: Array<{ path: string; repo: string | null }>;
  /** An old user-wide buildd entry was removed. */
  removedGlobal: boolean;
}

export function builddMcpEntry(server: string, apiKey: string): Json {
  return { type: 'http', url: `${server.replace(/\/+$/, '')}/api/mcp`, headers: { Authorization: `Bearer ${apiKey}` } };
}

/** Key-free entry for one workspace: Claude Code runs the OAuth sign-in itself. */
export function builddOAuthMcpEntry(server: string, workspaceId: string): Json {
  return { type: 'http', url: `${server.replace(/\/+$/, '')}/api/mcp-oauth/${encodeURIComponent(workspaceId)}` };
}

/** The scope that asks the consent page for a connection that acts as the person (apps/web/src/lib/oauth/account-consent.ts). */
export const ACT_AS_PERSON_SCOPE = 'buildd:act-as-person';
/**
 * What an as-you entry pins. A pinned set replaces whatever the server would
 * have asked for, so it names read and write too.
 */
export const PERSON_OAUTH_SCOPES = `buildd:read buildd:write ${ACT_AS_PERSON_SCOPE}`;

/**
 * Key-free entry for the one connection across workspaces. `person` pins the
 * scopes so Claude Code's sign-in asks to act as the person; `agent` pins
 * nothing, so it asks for what the server advertises, which never includes
 * the person scope.
 */
export function builddAccountOAuthMcpEntry(server: string, actsAs: 'person' | 'agent'): Json {
  const entry: Json = { type: 'http', url: `${server.replace(/\/+$/, '')}/api/mcp` };
  if (actsAs === 'person') entry.oauth = { scopes: PERSON_OAUTH_SCOPES };
  return entry;
}

/**
 * Whether the server offers the one connection: an unauthenticated request to
 * <server>/api/mcp gets a 401 whose challenge names protected-resource metadata
 * (RFC 9728) for that very resource. That is also exactly what Claude Code
 * needs to start the sign-in. Any other answer, or no answer, means no.
 */
export async function probeAccountOAuth(server: string, fetchImpl: typeof fetch = globalThis.fetch): Promise<boolean> {
  const base = server.replace(/\/+$/, '');
  const resource = `${base}/api/mcp`;
  try {
    const res = await fetchImpl(resource, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'buildd-install', version: '1' } } }),
      signal: AbortSignal.timeout(5000),
    });
    if (res.status !== 401) return false;
    const challenge = res.headers.get('www-authenticate') ?? '';
    const hinted = /resource_metadata="([^"]+)"/i.exec(challenge)?.[1];
    if (!hinted) return false;
    const meta = await fetchImpl(hinted, { signal: AbortSignal.timeout(5000) });
    if (!meta.ok) return false;
    const body = await meta.json() as { resource?: unknown };
    return typeof body.resource === 'string' && body.resource.replace(/\/+$/, '') === resource;
  } catch {
    return false;
  }
}

const OAUTH_MCP_URL = /\/api\/mcp-oauth\/[^/?#]+\/?$/;

/** An entry named buildd pointing at a buildd MCP endpoint (key or OAuth): ours to move. */
export function isBuilddMcpEntry(entry: unknown): boolean {
  const url = (entry as { url?: unknown } | null)?.url;
  return typeof url === 'string' && (/\/api\/mcp\/?(\?.*)?$/.test(url) || OAUTH_MCP_URL.test(url));
}

/** How a buildd entry signs in, for --status. Never returns the credential. */
export function builddMcpAuthKind(entry: unknown): 'OAuth' | 'key' | null {
  if (!isBuilddMcpEntry(entry)) return null;
  const e = entry as { headers?: Record<string, unknown> };
  // No key on the entry: Claude Code signs in with OAuth (per workspace, or the one connection).
  return e.headers?.Authorization ? 'key' : 'OAuth';
}

/**
 * Who a buildd entry's connection acts as, read from the entry alone:
 * `person` (as you) when it pins the person scope, `agent` when it is the one
 * connection without it, `unknown` for a per-workspace OAuth entry (decided at
 * sign-in), `key` for a key entry. Null for anything not buildd's.
 */
export function builddMcpActsAs(entry: unknown): 'person' | 'agent' | 'unknown' | 'key' | null {
  const kind = builddMcpAuthKind(entry);
  if (!kind) return null;
  if (kind === 'key') return 'key';
  const e = entry as { url: string; oauth?: { scopes?: unknown } };
  if (OAUTH_MCP_URL.test(e.url)) return 'unknown';
  const scopes = typeof e.oauth?.scopes === 'string' ? e.oauth.scopes.split(/\s+/) : [];
  return scopes.includes(ACT_AS_PERSON_SCOPE) ? 'person' : 'agent';
}

const ACTS_AS_LABEL = { person: 'as you', agent: 'as your agent', unknown: 'unknown until signed in' } as const;
/** "OAuth, as you" and so on; a key entry is just "key". */
function entryLabel(entry: unknown): string | null {
  const actsAs = builddMcpActsAs(entry);
  if (!actsAs) return null;
  return actsAs === 'key' ? 'key' : `OAuth, ${ACTS_AS_LABEL[actsAs]}`;
}

export function planMcpRegistration(opts: {
  claudeJson: Json;
  /** The key entry, used everywhere unless oauthEntry gives one for the folder. */
  entry: Json;
  /** Per-folder OAuth entry, or null when the folder has no workspace to sign in to. */
  oauthEntry?: (repo: string | null) => Json | null;
  /** The repo's workspace is in another team than the login key's: the key must never be written there. */
  isOtherTeam?: (repo: string | null) => boolean;
  mode: McpMode;
  cwd: string;
  /** Candidate folders with their repo (owner/name), e.g. every folder Claude Code has opened. */
  candidates: Array<{ path: string; repo: string | null; projectMcp?: boolean }>;
  workspaceRepos: string[];
}): McpPlan {
  const config: Json = structuredClone(opts.claudeJson ?? {});
  if (opts.mode === 'everywhere') {
    config.mcpServers = { ...(config.mcpServers ?? {}), buildd: opts.entry };
    return { config, folders: [], selfConfigured: [], removedGlobal: false, repaired: [] };
  }
  const otherTeam = (repo: string | null) => opts.isOtherTeam?.(repo) ?? false;
  const repaired: string[] = [];
  const repos = new Set(opts.workspaceRepos.map(r => r.toLowerCase()));
  const isWorkspace = (c: { repo: string | null }) => !!c.repo && repos.has(c.repo.toLowerCase());
  const selfConfigured = opts.mode === 'here' ? [] : opts.candidates.filter(c => c.projectMcp);
  const folders = opts.mode === 'here'
    ? [opts.candidates.find(c => c.path === opts.cwd) ?? { path: opts.cwd, repo: null }]
    : opts.candidates.filter(c => isWorkspace(c) && !c.projectMcp);
  config.projects = { ...(config.projects ?? {}) };
  const written: McpPlan['folders'] = [];
  for (const f of folders) {
    const oauth = opts.oauthEntry?.(f.repo) ?? null;
    const project = config.projects[f.path] ?? {};
    if (oauth && otherTeam(f.repo) && builddMcpAuthKind(project.mcpServers?.buildd) === 'key') repaired.push(f.path);
    config.projects[f.path] = { ...project, mcpServers: { ...(project.mcpServers ?? {}), buildd: oauth ?? opts.entry } };
    written.push({ path: f.path, repo: f.repo, oauth: !!oauth, otherTeam: otherTeam(f.repo) });
  }
  // A folder with its own .mcp.json is left alone, unless a local key entry from
  // a team that cannot reach its workspace shadows that file: then it signs in
  // with OAuth instead.
  for (const f of selfConfigured) {
    const project = config.projects[f.path];
    if (!project || builddMcpAuthKind(project.mcpServers?.buildd) !== 'key' || !otherTeam(f.repo)) continue;
    const oauth = opts.oauthEntry?.(f.repo) ?? null;
    if (!oauth) continue;
    config.projects[f.path] = { ...project, mcpServers: { ...project.mcpServers, buildd: oauth } };
    repaired.push(f.path);
  }
  let removedGlobal = false;
  if (opts.mode === 'workspaces' && isBuilddMcpEntry(config.mcpServers?.buildd)) {
    const { buildd: _, ...rest } = config.mcpServers;
    config.mcpServers = rest;
    removedGlobal = true;
  }
  return { config, folders: written, selfConfigured: selfConfigured.map(({ path, repo }) => ({ path, repo })), removedGlobal, repaired };
}

/** Folders Claude Code has opened (its own project list) plus cwd, that still exist, with their repo. */
export function candidateFolders(claudeJson: Json, cwd: string): Array<{ path: string; repo: string | null; projectMcp: boolean }> {
  const paths = new Set<string>([...Object.keys(claudeJson?.projects ?? {}), cwd]);
  return [...paths].filter(p => existsSync(p)).sort()
    .map(path => ({ path, repo: gitRepo(path), projectMcp: hasProjectBuilddMcp(gitRoot(path) ?? path) }));
}

function readBuilddConfig(home: string, env: Record<string, string | undefined>): { apiKey: string | null; server: string } {
  let cfg: Json = {};
  try { cfg = JSON.parse(readFileSync(join(resolveBuilddHome({ env }), 'config.json'), 'utf8')); } catch { /* not logged in */ }
  return {
    apiKey: env.BUILDD_API_KEY || cfg.apiKey || null,
    server: (env.BUILDD_SERVER || cfg.builddServer || 'https://buildd.dev').replace(/\/+$/, ''),
  };
}

const tilde = (path: string, home: string) => (path === home ? '~' : path.startsWith(home + '/') ? '~' + path.slice(home.length) : path);

/** The bearer key of a buildd key entry, or null. Never printed. */
function entryKey(entry: unknown): string | null {
  const auth = (entry as { headers?: { Authorization?: unknown } } | null)?.headers?.Authorization;
  return typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : null;
}

/**
 * Each buildd MCP entry in ~/.claude.json and how it signs in. No network: a
 * key entry is flagged when the cached lists (written by install and the hooks)
 * say the person reaches the folder's workspace but that key's team does not.
 */
export function mcpStatusLines(home: string, env: Record<string, string | undefined> = process.env): string[] {
  let cfg: Json;
  try { cfg = readJson(join(home, '.claude.json')); } catch { return ['buildd MCP server: ~/.claude.json could not be parsed.']; }
  const rows: Array<[string, string]> = [];
  const global = entryLabel(cfg?.mcpServers?.buildd);
  if (global) rows.push(['every session', global]);
  let hookEnv: Record<string, string | undefined> | null = null;
  let personRepos: string[] | null = null;
  try {
    hookEnv = { ...env, BUILDD_HOME: resolveBuilddHome({ env }) };
    const auth = resolveAuth(hookEnv);
    personRepos = auth?.kind === 'presence' ? readWorkspaceCache(hookEnv, auth.apiKey)?.repos ?? null : null;
  } catch { /* no runner home: plain listing */ }
  for (const [path, project] of Object.entries((cfg?.projects ?? {}) as Record<string, Json>).sort(([a], [b]) => a.localeCompare(b))) {
    const entry = project?.mcpServers?.buildd;
    const kind = builddMcpAuthKind(entry);
    if (!kind) continue;
    let note = '';
    const key = kind === 'key' ? entryKey(entry) : null;
    if (key && hookEnv && personRepos && existsSync(path)) {
      const repo = gitRepo(path)?.toLowerCase() ?? null;
      const keyRepos = readWorkspaceCache(hookEnv, key)?.repos ?? null;
      if (repo && keyRepos && personRepos.includes(repo) && !keyRepos.includes(repo)) {
        note = `  its team can't reach ${repo}: run buildd install --global to switch it to OAuth`;
      }
    }
    rows.push([tilde(path, home), entryLabel(entry) + note]);
  }
  if (rows.length === 0) return ['buildd MCP server: not registered in ~/.claude.json.'];
  const width = Math.max(...rows.map(([p]) => p.length));
  return ['buildd MCP server:', ...rows.map(([p, k]) => `  ${p.padEnd(width)}  ${k}`)];
}

// ── CLI ─────────────────────────────────────────────────────────────────────

export interface CliOptions {
  mode: 'install' | 'uninstall' | 'status';
  scope: InstallScope;
  clients: AgentClient[] | null;
  mcp: McpMode | null;
  /** Sign each workspace folder in with OAuth instead of writing the key. */
  oauth: boolean;
  /** With oauth: the connection acts as the person's agent, not as the person. */
  asAgent: boolean;
}

export function parseCliArgs(argv: string[]): CliOptions | { error: string } {
  let mode: CliOptions['mode'] = 'install';
  let scope: InstallScope = 'project';
  let clients: AgentClient[] | null = null;
  let mcp: McpMode | null = null;
  let oauth = false;
  let asAgent = false;
  for (const a of argv) {
    if (a === '--global') scope = 'global';
    else if (a === '--uninstall') mode = 'uninstall';
    else if (a === '--status') mode = 'status';
    else if (a === '--everywhere') mcp = 'everywhere';
    else if (a === '--here') mcp = 'here';
    else if (a === '--oauth') oauth = true;
    else if (a === '--as-agent') { oauth = true; asAgent = true; }
    else if (a.startsWith('--client=')) {
      const list = a.slice('--client='.length).split(',').filter(Boolean);
      const bad = list.filter(c => !(AGENT_CLIENTS as readonly string[]).includes(c));
      if (bad.length) return { error: `unknown client(s): ${bad.join(', ')} (expected ${AGENT_CLIENTS.join(', ')})` };
      clients = list as AgentClient[];
    } else return { error: `unknown option: ${a}` };
  }
  if (mcp === 'everywhere' && scope !== 'global') return { error: '--everywhere only applies with --global' };
  if (mcp === 'here' && scope === 'global') return { error: '--here and --global are alternatives: pick one' };
  const flag = asAgent ? '--as-agent' : '--oauth';
  if (oauth && mcp === 'everywhere') return { error: `${flag} signs in per workspace folder, so it cannot apply --everywhere` };
  if (oauth && !(scope === 'global' || mcp === 'here')) return { error: `${flag} applies with --global or --here` };
  // A global install registers the MCP server for workspace folders unless told otherwise.
  if (mode === 'install' && scope === 'global' && !mcp) mcp = 'workspaces';
  if (mode !== 'install') { mcp = null; oauth = false; asAgent = false; }
  return { mode, scope, clients, mcp, oauth, asAgent };
}

export interface CliEnv {
  home?: string;
  cwd?: string;
  runtime?: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  now?: number;
}

/** Register the MCP server per --global/--here/--everywhere. Returns the lines to print. */
async function registerMcp(mode: McpMode, oauth: boolean, asAgent: boolean, home: string, cwd: string, e: CliEnv): Promise<{ ok: boolean; lines: string[]; workspaceRepos: string[] | null }> {
  const env = e.env ?? process.env;
  const { apiKey, server } = readBuilddConfig(home, env);
  if (!apiKey) return { ok: false, lines: ["Not logged in. Run 'buildd login' first."], workspaceRepos: null };
  // The workspace list drives both the MCP folders and the hooks' scope, so it is refreshed either way.
  // The MCP entries use the account key, so their folders (and the OAuth endpoint ids) come from its list.
  const workspaces = await fetchWorkspaces({ server, apiKey }, e.fetchImpl ?? globalThis.fetch);
  const workspaceRepos = workspaces ? [...new Set(workspaces.map(w => w.repo as string))].sort() : null;
  // First workspace per repo, in the server's order: the id the OAuth endpoint is bound to.
  const workspaceIdByRepo = new Map<string, string>();
  for (const w of workspaces ?? []) if (w.id && !workspaceIdByRepo.has(w.repo as string)) workspaceIdByRepo.set(w.repo as string, w.id);
  // The person's list (presence token from buildd login): every workspace in every
  // team they are in, with ids. It picks the folders; the key's list only says which
  // of them the key's team reaches. The hooks' scope list is cached under it too.
  const hookEnv = { ...env, BUILDD_HOME: resolveBuilddHome({ env }) };
  const hookAuth = resolveAuth(hookEnv);
  const personWorkspaces = hookAuth?.kind === 'presence' ? await fetchWorkspaces(hookAuth, e.fetchImpl ?? globalThis.fetch) : null;
  const hookRepos = personWorkspaces ? [...new Set(personWorkspaces.map(w => w.repo as string))].sort() : workspaceRepos;
  const now = e.now ?? Date.now();
  if (hookAuth?.kind === 'presence' && personWorkspaces) writeWorkspaceCache(hookEnv, hookAuth.apiKey, hookRepos, now);
  if (workspaceRepos) writeWorkspaceCache(hookEnv, apiKey, workspaceRepos, now);
  const keyRepos = new Set(workspaceRepos ?? []);
  const personIdByRepo = new Map<string, string>();
  for (const w of personWorkspaces ?? []) if (w.id && !personIdByRepo.has(w.repo as string)) personIdByRepo.set(w.repo as string, w.id);
  // Reachable by the person, not by the key's team: OAuth only, never the key.
  const isOtherTeam = (repo: string | null) => !!repo && !keyRepos.has(repo.toLowerCase()) && personIdByRepo.has(repo.toLowerCase());
  const allRepos = [...new Set([...(workspaceRepos ?? []), ...personIdByRepo.keys()])];
  if (mode === 'workspaces' && !workspaceRepos) {
    return { ok: false, lines: [`Could not load your workspaces from ${server}. Nothing was changed; try again, or pass --everywhere.`], workspaceRepos };
  }
  // --oauth: the one connection when the server offers it, else the per-workspace endpoints.
  const accountEntry = oauth && await probeAccountOAuth(server, e.fetchImpl ?? globalThis.fetch)
    ? builddAccountOAuthMcpEntry(server, asAgent ? 'agent' : 'person')
    : null;
  const actsAsLabel = asAgent ? 'as your agent' : 'as you';
  const file = join(home, '.claude.json');
  let claudeJson: Json;
  try { claudeJson = readJson(file); } catch (err) {
    return { ok: false, lines: [`${tilde(file, home)} could not be parsed; left untouched (${(err as Error).message}).`], workspaceRepos };
  }
  const plan = planMcpRegistration({
    claudeJson, entry: builddMcpEntry(server, apiKey), mode, cwd,
    oauthEntry: repo => {
      // The one connection needs no workspace id, so it also covers a folder that is not a workspace yet.
      if (accountEntry) return accountEntry;
      if (isOtherTeam(repo)) return builddOAuthMcpEntry(server, personIdByRepo.get(repo!.toLowerCase())!);
      const id = oauth && repo ? workspaceIdByRepo.get(repo.toLowerCase()) : undefined;
      return id ? builddOAuthMcpEntry(server, id) : null;
    },
    isOtherTeam,
    candidates: mode === 'here' ? [{ path: cwd, repo: gitRepo(cwd) }] : candidateFolders(claudeJson, cwd),
    workspaceRepos: allRepos,
  });
  writeJson(file, plan.config);
  chmodSync(file, 0o600); // an entry may hold the key, like ~/.buildd/config.json
  const lines: string[] = [];
  // What an --oauth install means, in plain words.
  const oauthNotes = (): string[] => {
    if (!oauth) return [];
    if (!accountEntry) {
      return [
        "  No key is written. This server doesn't offer one connection across workspaces yet, so Claude Code signs you in once per workspace (/mcp shows it),",
        '  and whether that connection acts as you or as your agent is decided when you sign in.',
      ];
    }
    return asAgent
      ? [
        '  No key is written. Claude Code signs you in once in the browser and you pick the workspaces the connection reaches.',
        '  It acts as your agent, not as you: use this on a shared or remote machine. On your own machine, --oauth connects as you.',
      ]
      : [
        '  No key is written. Claude Code signs you in once in the browser and you pick the workspaces the connection reaches.',
        '  It acts as you: what it does there is done as you. On a shared or remote machine, use --as-agent so it acts as your agent instead.',
      ];
  };
  const signIn = (f: { oauth: boolean; otherTeam?: boolean }) => (accountEntry && f.oauth
    ? `  ${actsAsLabel} (browser sign-in on first use)`
    : f.otherTeam
    ? "  OAuth: your login key's team can't reach it, so you sign in as yourself (browser, first use)"
    : f.oauth ? '  browser sign-in on first use' : '');
  if (mode === 'everywhere') {
    lines.push(`buildd MCP server: registered for every Claude Code session (${tilde(file, home)}).`);
  } else if (mode === 'here') {
    const f = plan.folders[0];
    lines.push(accountEntry && f?.oauth
      ? `buildd MCP server: registered for this folder, ${tilde(cwd, home)}, signing in ${actsAsLabel} (browser sign-in on first use).`
      : f?.otherTeam
      ? `buildd MCP server: registered for this folder, ${tilde(cwd, home)}, signing in with OAuth: your login key's team can't reach this workspace (browser sign-in on first use).`
      : f?.oauth
        ? `buildd MCP server: registered for this folder, ${tilde(cwd, home)}, signing in with OAuth (browser sign-in on first use).`
        : `buildd MCP server: registered for this folder, ${tilde(cwd, home)}.`);
    if (oauth && f && !f.oauth) lines.push('  This folder is not a workspace yet, so it uses your key. Run buildd install --here --oauth again once it is.');
    if (f?.oauth) lines.push(...oauthNotes());
  } else {
    if (plan.folders.length === 0 && plan.selfConfigured.length === 0) {
      lines.push('buildd MCP server: none of the folders Claude Code has opened is a checkout of one of your workspaces yet.');
      lines.push('  Open one in Claude Code and run buildd install --global again.');
    } else {
      const all = [...plan.folders, ...plan.selfConfigured];
      lines.push(`buildd MCP server: registered for your workspace folders only (${all.length})${oauth ? ', signing in with OAuth' : ''}:`);
      const width = Math.max(...all.map(f => tilde(f.path, home).length));
      const repoWidth = Math.max(...plan.folders.map(f => (f.repo ?? '').length), 0);
      for (const f of plan.folders) lines.push(`  ${tilde(f.path, home).padEnd(width)}  ${signIn(f) ? (f.repo ?? '').padEnd(repoWidth) + signIn(f) : f.repo}`);
      for (const f of plan.selfConfigured) lines.push(`  ${tilde(f.path, home).padEnd(width)}  ${f.repo ?? ''}  (its own .mcp.json)`);
    }
    if (plan.removedGlobal) lines.push('  Removed the old every-session entry, so other folders load no buildd tools.');
    if (plan.repaired.length) {
      lines.push(`  Switched ${plan.repaired.length} folder${plan.repaired.length === 1 ? '' : 's'} from a key whose team can't reach their workspace to OAuth: ${plan.repaired.map(p => tilde(p, home)).join(', ')}`);
    }
    if (hookAuth?.kind !== 'presence') lines.push("  Only your login key's team is included. Run buildd login again to include every team you're in.");
    if (oauth && plan.folders.some(f => f.oauth)) lines.push(...oauthNotes());
    lines.push('  New checkout? Run buildd install --global again.');
    lines.push('  Need buildd somewhere else, e.g. to set up a new workspace? Run buildd install --here in that folder.');
  }
  return { ok: true, lines, workspaceRepos: hookRepos ?? workspaceRepos };
}

export async function runCli(argv: string[], e: CliEnv = {}): Promise<{ code: number; lines: string[] }> {
  const parsed = parseCliArgs(argv);
  if ('error' in parsed) return { code: 1, lines: [parsed.error] };
  const home = e.home ?? homedir();
  const cwd = e.cwd ?? process.cwd();
  const lines: string[] = [];
  let workspaceRepos: string[] | null = null;
  if (parsed.mode === 'status' && parsed.scope === 'global') lines.push(...mcpStatusLines(home, e.env ?? process.env), '');
  if (parsed.mcp) {
    const r = await registerMcp(parsed.mcp, parsed.oauth, parsed.asAgent, home, cwd, e);
    if (!r.ok) return { code: 1, lines: r.lines };
    lines.push(...r.lines, '');
    workspaceRepos = r.workspaceRepos;
    // --here touches only this folder's MCP entry.
    if (parsed.mcp === 'here') return { code: 0, lines: lines.slice(0, -1) };
  }
  if (parsed.scope === 'project' && !existsSync(join(cwd, '.git'))) {
    return { code: 1, lines: ['Not in a git repository. Run from a repo root, or pass --global.'] };
  }
  const pluginDir = resolve(import.meta.dir, '..', 'plugin');
  const ctx: InstallContext = {
    home,
    scope: parsed.scope,
    projectDir: cwd,
    scriptPath: join(pluginDir, 'scripts', BUILDD_HOOK_MARKER),
    runtime: e.runtime ?? process.execPath,
    pluginDir,
  };
  const detected = detectClients(home);
  const clients = parsed.clients ?? (parsed.mode === 'install' ? detected : [...AGENT_CLIENTS]);
  if (clients.length === 0) {
    lines.push('No supported coding client found (looked for ~/.claude, ~/.codex, ~/.cursor). Pass --client= to install anyway.');
    return { code: 0, lines };
  }
  if (parsed.mode === 'install') lines.push('Session presence hooks:');
  let failed = false;
  for (const client of clients) {
    const r = parsed.mode === 'install' ? installClient(client, ctx)
      : parsed.mode === 'uninstall' ? uninstallClient(client, ctx)
      : clientStatus(client, ctx);
    if (r.action === 'error') failed = true;
    lines.push(`${client.padEnd(7)} ${r.action.padEnd(9)} ${r.file}${r.events.length ? ` (${r.events.join(', ')})` : ''}`);
    if (r.note) lines.push(`        ${r.note}`);
  }
  if (parsed.mode === 'install') {
    lines.push('');
    if (workspaceRepos) {
      lines.push(workspaceRepos.length
        ? `Presence is reported only for sessions in your workspace repos (${workspaceRepos.length}): ${workspaceRepos.join(', ')}, and in repos whose own .mcp.json names buildd.`
        : 'You have no workspace repos yet, so the hooks report nothing until you do.');
    } else {
      lines.push('Presence is reported only for sessions in one of your workspace repos.');
    }
    lines.push('Anywhere else the hooks send nothing, unless that session claims a buildd task.');
    lines.push('They never send prompts, responses or transcripts. Once a session claims a task they report its token counts (BUILDD_HOOK_USAGE=0 turns that off).');
    if (clients.includes('codex')) lines.push('Codex MCP: codex mcp add buildd --url <server>/api/mcp --bearer-token-env-var BUILDD_API_KEY');
    if (clients.includes('cursor')) lines.push('Cursor MCP: add buildd (<server>/api/mcp, Authorization: Bearer <key>) under Settings > MCP if not already there.');
  }
  return { code: failed ? 1 : 0, lines };
}

if (import.meta.main) {
  const { code, lines } = await runCli(process.argv.slice(2));
  for (const l of lines) console.log(l);
  process.exit(code);
}
