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
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';

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

// ── CLI ─────────────────────────────────────────────────────────────────────

export interface CliOptions {
  mode: 'install' | 'uninstall' | 'status';
  scope: InstallScope;
  clients: AgentClient[] | null;
}

export function parseCliArgs(argv: string[]): CliOptions | { error: string } {
  let mode: CliOptions['mode'] = 'install';
  let scope: InstallScope = 'project';
  let clients: AgentClient[] | null = null;
  for (const a of argv) {
    if (a === '--global') scope = 'global';
    else if (a === '--uninstall') mode = 'uninstall';
    else if (a === '--status') mode = 'status';
    else if (a.startsWith('--client=')) {
      const list = a.slice('--client='.length).split(',').filter(Boolean);
      const bad = list.filter(c => !(AGENT_CLIENTS as readonly string[]).includes(c));
      if (bad.length) return { error: `unknown client(s): ${bad.join(', ')} (expected ${AGENT_CLIENTS.join(', ')})` };
      clients = list as AgentClient[];
    } else return { error: `unknown option: ${a}` };
  }
  return { mode, scope, clients };
}

export function runCli(argv: string[], env: { home?: string; cwd?: string; runtime?: string } = {}): { code: number; lines: string[] } {
  const parsed = parseCliArgs(argv);
  if ('error' in parsed) return { code: 1, lines: [parsed.error] };
  const home = env.home ?? homedir();
  const cwd = env.cwd ?? process.cwd();
  if (parsed.scope === 'project' && !existsSync(join(cwd, '.git'))) {
    return { code: 1, lines: ['Not in a git repository. Run from a repo root, or pass --global.'] };
  }
  const pluginDir = resolve(import.meta.dir, '..', 'plugin');
  const ctx: InstallContext = {
    home,
    scope: parsed.scope,
    projectDir: cwd,
    scriptPath: join(pluginDir, 'scripts', BUILDD_HOOK_MARKER),
    runtime: env.runtime ?? process.execPath,
    pluginDir,
  };
  const detected = detectClients(home);
  const clients = parsed.clients ?? (parsed.mode === 'install' ? detected : [...AGENT_CLIENTS]);
  const lines: string[] = [];
  if (clients.length === 0) {
    lines.push('No supported coding client found (looked for ~/.claude, ~/.codex, ~/.cursor). Pass --client= to install anyway.');
    return { code: 0, lines };
  }
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
    lines.push('', 'Hooks report session presence only. They never send prompts, responses or transcripts.');
    if (clients.includes('codex')) lines.push('Codex MCP: codex mcp add buildd --url <server>/api/mcp --bearer-token-env-var BUILDD_API_KEY');
    if (clients.includes('cursor')) lines.push('Cursor MCP: add buildd (<server>/api/mcp, Authorization: Bearer <key>) under Settings > MCP if not already there.');
  }
  return { code: failed ? 1 : 0, lines };
}

if (import.meta.main) {
  const { code, lines } = runCli(process.argv.slice(2));
  for (const l of lines) console.log(l);
  process.exit(code);
}
