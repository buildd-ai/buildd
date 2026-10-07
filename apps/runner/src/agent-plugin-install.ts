/**
 * `buildd install` for interactive coding clients: puts the buildd agent
 * plugin's lifecycle hooks (apps/runner/plugin) into Claude Code, Codex and
 * Cursor, and takes them out again.
 *
 *   buildd install --global            hooks + skill for every detected client (user level)
 *   buildd install                     the same, for the current repo only
 *   buildd install --uninstall [--global]
 *   buildd install --status [--global]
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
import { fetchWorkspaceRepos, gitRepo, gitRoot, hasProjectBuilddMcp, writeWorkspaceCache } from '../plugin/scripts/buildd-hook.mjs';

export const BUILDD_HOOK_MARKER = 'buildd-hook.mjs';
export const BUILDD_SKILL_NAME = 'buildd-session';
export const AGENT_CLIENTS = ['claude', 'codex', 'cursor'] as const;
export type AgentClient = (typeof AGENT_CLIENTS)[number];
export type InstallScope = 'global' | 'project';

type Json = Record<string, any>;

// ── Hook definitions ────────────────────────────────────────────────────────

/**
 * Claude Code / Codex hook events (same schema). `async` keeps the agent loop
 * from waiting on buildd where nothing is returned to it; UserPromptSubmit
 * stays synchronous because it may add a one-line "you have a message" nudge,
 * and SessionEnd because an async hook can be cut off as the process exits.
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
    Stop: [{ hooks: [handler(true)] }],
    PostToolUse: [{ matcher: 'mcp__.*buildd.*', hooks: [handler(true)] }],
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

export type McpMode = 'workspaces' | 'here' | 'everywhere';

export interface McpPlan {
  config: Json;
  /** Folders that now have the buildd entry (new or refreshed). */
  folders: Array<{ path: string; repo: string | null }>;
  /** Workspace folders left alone because their own .mcp.json already names buildd. */
  selfConfigured: Array<{ path: string; repo: string | null }>;
  /** An old user-wide buildd entry was removed. */
  removedGlobal: boolean;
}

export function builddMcpEntry(server: string, apiKey: string): Json {
  return { type: 'http', url: `${server.replace(/\/+$/, '')}/api/mcp`, headers: { Authorization: `Bearer ${apiKey}` } };
}

/** An entry named buildd pointing at a buildd MCP endpoint: ours to move. */
export function isBuilddMcpEntry(entry: unknown): boolean {
  const url = (entry as { url?: unknown } | null)?.url;
  return typeof url === 'string' && /\/api\/mcp\/?(\?.*)?$/.test(url);
}

export function planMcpRegistration(opts: {
  claudeJson: Json;
  entry: Json;
  mode: McpMode;
  cwd: string;
  /** Candidate folders with their repo (owner/name), e.g. every folder Claude Code has opened. */
  candidates: Array<{ path: string; repo: string | null; projectMcp?: boolean }>;
  workspaceRepos: string[];
}): McpPlan {
  const config: Json = structuredClone(opts.claudeJson ?? {});
  if (opts.mode === 'everywhere') {
    config.mcpServers = { ...(config.mcpServers ?? {}), buildd: opts.entry };
    return { config, folders: [], selfConfigured: [], removedGlobal: false };
  }
  const repos = new Set(opts.workspaceRepos.map(r => r.toLowerCase()));
  const isWorkspace = (c: { repo: string | null }) => !!c.repo && repos.has(c.repo.toLowerCase());
  const selfConfigured = opts.mode === 'here' ? [] : opts.candidates.filter(c => c.projectMcp);
  const folders = opts.mode === 'here'
    ? [opts.candidates.find(c => c.path === opts.cwd) ?? { path: opts.cwd, repo: null }]
    : opts.candidates.filter(c => isWorkspace(c) && !c.projectMcp);
  config.projects = { ...(config.projects ?? {}) };
  for (const f of folders) {
    const project = config.projects[f.path] ?? {};
    config.projects[f.path] = { ...project, mcpServers: { ...(project.mcpServers ?? {}), buildd: opts.entry } };
  }
  let removedGlobal = false;
  if (opts.mode === 'workspaces' && isBuilddMcpEntry(config.mcpServers?.buildd)) {
    const { buildd: _, ...rest } = config.mcpServers;
    config.mcpServers = rest;
    removedGlobal = true;
  }
  return { config, folders: folders.map(({ path, repo }) => ({ path, repo })), selfConfigured: selfConfigured.map(({ path, repo }) => ({ path, repo })), removedGlobal };
}

/** Folders Claude Code has opened (its own project list) plus cwd, that still exist, with their repo. */
export function candidateFolders(claudeJson: Json, cwd: string): Array<{ path: string; repo: string | null; projectMcp: boolean }> {
  const paths = new Set<string>([...Object.keys(claudeJson?.projects ?? {}), cwd]);
  return [...paths].filter(p => existsSync(p)).sort()
    .map(path => ({ path, repo: gitRepo(path), projectMcp: hasProjectBuilddMcp(gitRoot(path) ?? path) }));
}

function readBuilddConfig(home: string, env: Record<string, string | undefined>): { apiKey: string | null; server: string } {
  let cfg: Json = {};
  try { cfg = JSON.parse(readFileSync(join(env.BUILDD_HOME || join(home, '.buildd'), 'config.json'), 'utf8')); } catch { /* not logged in */ }
  return {
    apiKey: env.BUILDD_API_KEY || cfg.apiKey || null,
    server: (env.BUILDD_SERVER || cfg.builddServer || 'https://buildd.dev').replace(/\/+$/, ''),
  };
}

const tilde = (path: string, home: string) => (path === home ? '~' : path.startsWith(home + '/') ? '~' + path.slice(home.length) : path);

// ── CLI ─────────────────────────────────────────────────────────────────────

export interface CliOptions {
  mode: 'install' | 'uninstall' | 'status';
  scope: InstallScope;
  clients: AgentClient[] | null;
  mcp: McpMode | null;
}

export function parseCliArgs(argv: string[]): CliOptions | { error: string } {
  let mode: CliOptions['mode'] = 'install';
  let scope: InstallScope = 'project';
  let clients: AgentClient[] | null = null;
  let mcp: McpMode | null = null;
  for (const a of argv) {
    if (a === '--global') scope = 'global';
    else if (a === '--uninstall') mode = 'uninstall';
    else if (a === '--status') mode = 'status';
    else if (a === '--everywhere') mcp = 'everywhere';
    else if (a === '--here') mcp = 'here';
    else if (a.startsWith('--client=')) {
      const list = a.slice('--client='.length).split(',').filter(Boolean);
      const bad = list.filter(c => !(AGENT_CLIENTS as readonly string[]).includes(c));
      if (bad.length) return { error: `unknown client(s): ${bad.join(', ')} (expected ${AGENT_CLIENTS.join(', ')})` };
      clients = list as AgentClient[];
    } else return { error: `unknown option: ${a}` };
  }
  if (mcp === 'everywhere' && scope !== 'global') return { error: '--everywhere only applies with --global' };
  if (mcp === 'here' && scope === 'global') return { error: '--here and --global are alternatives: pick one' };
  // A global install registers the MCP server for workspace folders unless told otherwise.
  if (mode === 'install' && scope === 'global' && !mcp) mcp = 'workspaces';
  if (mode !== 'install') mcp = null;
  return { mode, scope, clients, mcp };
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
async function registerMcp(mode: McpMode, home: string, cwd: string, e: CliEnv): Promise<{ ok: boolean; lines: string[]; workspaceRepos: string[] | null }> {
  const env = e.env ?? process.env;
  const { apiKey, server } = readBuilddConfig(home, env);
  if (!apiKey) return { ok: false, lines: ["Not logged in. Run 'buildd login' first."], workspaceRepos: null };
  // The workspace list drives both the MCP folders and the hooks' scope, so it is refreshed either way.
  const workspaceRepos = await fetchWorkspaceRepos({ server, apiKey }, e.fetchImpl ?? globalThis.fetch);
  if (workspaceRepos) writeWorkspaceCache({ ...env, BUILDD_HOME: env.BUILDD_HOME || join(home, '.buildd') }, apiKey, workspaceRepos, e.now ?? Date.now());
  if (mode === 'workspaces' && !workspaceRepos) {
    return { ok: false, lines: [`Could not load your workspaces from ${server}. Nothing was changed; try again, or pass --everywhere.`], workspaceRepos };
  }
  const file = join(home, '.claude.json');
  let claudeJson: Json;
  try { claudeJson = readJson(file); } catch (err) {
    return { ok: false, lines: [`${tilde(file, home)} could not be parsed; left untouched (${(err as Error).message}).`], workspaceRepos };
  }
  const plan = planMcpRegistration({
    claudeJson, entry: builddMcpEntry(server, apiKey), mode, cwd,
    candidates: mode === 'here' ? [{ path: cwd, repo: gitRepo(cwd) }] : candidateFolders(claudeJson, cwd),
    workspaceRepos: workspaceRepos ?? [],
  });
  writeJson(file, plan.config);
  chmodSync(file, 0o600); // the entry holds the key, like ~/.buildd/config.json
  const lines: string[] = [];
  if (mode === 'everywhere') {
    lines.push(`buildd MCP server: registered for every Claude Code session (${tilde(file, home)}).`);
  } else if (mode === 'here') {
    lines.push(`buildd MCP server: registered for this folder, ${tilde(cwd, home)}.`);
  } else {
    if (plan.folders.length === 0 && plan.selfConfigured.length === 0) {
      lines.push('buildd MCP server: none of the folders Claude Code has opened is a checkout of one of your workspaces yet.');
      lines.push('  Open one in Claude Code and run buildd install --global again.');
    } else {
      const all = [...plan.folders, ...plan.selfConfigured];
      lines.push(`buildd MCP server: registered for your workspace folders only (${all.length}):`);
      const width = Math.max(...all.map(f => tilde(f.path, home).length));
      for (const f of plan.folders) lines.push(`  ${tilde(f.path, home).padEnd(width)}  ${f.repo}`);
      for (const f of plan.selfConfigured) lines.push(`  ${tilde(f.path, home).padEnd(width)}  ${f.repo ?? ''}  (its own .mcp.json)`);
    }
    if (plan.removedGlobal) lines.push('  Removed the old every-session entry, so other folders load no buildd tools.');
    lines.push('  New checkout? Run buildd install --global again.');
    lines.push('  Need buildd somewhere else, e.g. to set up a new workspace? Run buildd install --here in that folder.');
  }
  return { ok: true, lines, workspaceRepos };
}

export async function runCli(argv: string[], e: CliEnv = {}): Promise<{ code: number; lines: string[] }> {
  const parsed = parseCliArgs(argv);
  if ('error' in parsed) return { code: 1, lines: [parsed.error] };
  const home = e.home ?? homedir();
  const cwd = e.cwd ?? process.cwd();
  const lines: string[] = [];
  let workspaceRepos: string[] | null = null;
  if (parsed.mcp) {
    const r = await registerMcp(parsed.mcp, home, cwd, e);
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
    lines.push('They never send prompts, responses or transcripts.');
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
