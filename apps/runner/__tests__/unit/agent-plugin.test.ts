import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import {
  normalizeHookEvent,
  claimedWorkerId,
  buildBody,
  hookOutput,
  run,
  shouldSkip,
  isBuilddTool,
  repoSlug,
} from '../../plugin/scripts/buildd-hook.mjs';
import {
  claudeLikeHookEntries,
  cursorHookEntries,
  mergeClaudeLikeHooks,
  removeClaudeLikeHooks,
  mergeCursorHooks,
  removeCursorHooks,
  installClient,
  uninstallClient,
  clientStatus,
  installedEvents,
  hookCommand,
  parseCliArgs,
  runCli,
  type InstallContext,
} from '../../src/agent-plugin-install';
import { normalizeRepoSlug } from '@buildd/shared';

const PLUGIN_DIR = resolve(import.meta.dir, '../../plugin');
const SCRIPT = join(PLUGIN_DIR, 'scripts', 'buildd-hook.mjs');
const WORKER = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';

// The claim_task reply as packages/core/mcp-tools.ts formats it, in each client's envelope.
const CLAIM_TEXT = `Claimed 1 task(s):\n\n**Worker ID:** ${WORKER}\n**Task:** Fix it\n**Branch:** buildd/abc`;

describe('client adapters', () => {
  it('Claude Code: start, touch, bind, end', () => {
    const base = { session_id: 'cc-1', cwd: '/repo', transcript_path: '/t.jsonl' };
    expect(normalizeHookEvent('claude', { ...base, hook_event_name: 'SessionStart', source: 'startup' }))
      .toEqual({ clientSessionId: 'cc-1', cwd: '/repo', event: 'start', interactive: true });
    expect(normalizeHookEvent('claude', { ...base, hook_event_name: 'UserPromptSubmit', user_prompt: 'secret plan' })?.event).toBe('touch');
    expect(normalizeHookEvent('claude', { ...base, hook_event_name: 'Stop', last_assistant_message: 'x' })?.event).toBe('touch');
    expect(normalizeHookEvent('claude', {
      ...base, hook_event_name: 'PostToolUse', tool_name: 'mcp__buildd__buildd',
      tool_input: { action: 'claim_task', params: { taskId: 'x' } },
      tool_response: [{ type: 'text', text: CLAIM_TEXT }],
    })).toEqual({ clientSessionId: 'cc-1', cwd: '/repo', event: 'bind', workerId: WORKER });
    expect(normalizeHookEvent('claude', { ...base, hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' })?.reason).toBe('exit');
    expect(normalizeHookEvent('claude', { ...base, hook_event_name: 'SessionEnd', reason: 'clear' })?.reason).toBe('clear');
    expect(normalizeHookEvent('claude', { ...base, hook_event_name: 'SessionEnd', reason: 'other' })?.reason).toBe('other');
  });

  it('Claude Code: ignores other tools, other actions, failed claims and unknown events', () => {
    const base = { session_id: 'cc-1', cwd: '/repo', hook_event_name: 'PostToolUse' };
    expect(normalizeHookEvent('claude', { ...base, tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: CLAIM_TEXT })).toBeNull();
    expect(normalizeHookEvent('claude', { ...base, tool_name: 'mcp__buildd__buildd', tool_input: { action: 'get_task' }, tool_response: CLAIM_TEXT })).toBeNull();
    expect(normalizeHookEvent('claude', { ...base, tool_name: 'mcp__buildd__buildd', tool_input: { action: 'claim_task' }, tool_response: 'Nothing claimed: no_slots' })).toBeNull();
    expect(normalizeHookEvent('claude', { ...base, tool_name: 'mcp__buildd__buildd', tool_input: { action: 'claim_task' }, tool_response: { isError: true, content: CLAIM_TEXT } })).toBeNull();
    expect(normalizeHookEvent('claude', { session_id: 'cc-1', hook_event_name: 'PreCompact' })).toBeNull();
    expect(normalizeHookEvent('claude', { hook_event_name: 'SessionStart' })).toBeNull();
  });

  it('Claude Code: plugin-namespaced and grouped buildd tools are recognised', () => {
    expect(isBuilddTool('mcp__buildd__buildd')).toBe(true);
    expect(isBuilddTool('mcp__plugin_buildd_buildd__buildd')).toBe(true);
    expect(isBuilddTool('mcp__buildd__buildd_work')).toBe(true);
    expect(isBuilddTool('mcp__other__buildd')).toBe(false);
    expect(isBuilddTool('mcp__buildd__recall')).toBe(false);
  });

  it('Codex: same schema, client codex, SessionEnd reason always other', () => {
    const base = { session_id: 'cx-1', cwd: '/repo', model: 'gpt', turn_id: 't1' };
    expect(normalizeHookEvent('codex', { ...base, hook_event_name: 'SessionStart', source: 'startup' })?.event).toBe('start');
    expect(normalizeHookEvent('codex', {
      ...base, hook_event_name: 'PostToolUse', tool_name: 'mcp__buildd__buildd',
      tool_input: { action: 'claim_task' }, tool_response: { content: [{ type: 'text', text: CLAIM_TEXT }] }, tool_use_id: 'u',
    })?.workerId).toBe(WORKER);
    expect(normalizeHookEvent('codex', { ...base, hook_event_name: 'SessionEnd', reason: 'other' })).toMatchObject({ event: 'end', reason: 'other' });
  });

  it('Cursor: conversation id, version, background flag, MCP bind with stringified JSON', () => {
    const base = { conversation_id: 'cu-1', generation_id: 'g', cursor_version: '1.7.2', workspace_roots: ['/repo'], user_email: 'x@y' };
    expect(normalizeHookEvent('cursor', { ...base, hook_event_name: 'sessionStart', session_id: 's', is_background_agent: true }))
      .toEqual({ clientSessionId: 'cu-1', cwd: '/repo', clientVersion: '1.7.2', event: 'start', interactive: false });
    expect(normalizeHookEvent('cursor', { ...base, hook_event_name: 'afterAgentResponse', text: 'reply' })?.event).toBe('touch');
    expect(normalizeHookEvent('cursor', {
      ...base, hook_event_name: 'afterMCPExecution', tool_name: 'buildd', mcp_server_name: 'buildd',
      tool_input: JSON.stringify({ action: 'claim_task' }), result_json: JSON.stringify({ content: [{ type: 'text', text: CLAIM_TEXT }] }),
    })?.workerId).toBe(WORKER);
    expect(normalizeHookEvent('cursor', { ...base, hook_event_name: 'sessionEnd', reason: 'window_close' })).toMatchObject({ event: 'end', reason: 'exit' });
    // A finished agent run is not the conversation closing: never releases a claim.
    expect(normalizeHookEvent('cursor', { ...base, hook_event_name: 'sessionEnd', reason: 'completed' })?.event).toBe('touch');
    expect(normalizeHookEvent('cursor', { ...base, hook_event_name: 'beforeShellExecution', command: 'ls' })).toBeNull();
  });

  it('claimedWorkerId only reads a claim_task reply', () => {
    expect(claimedWorkerId({ action: 'claim_task' }, CLAIM_TEXT)).toBe(WORKER);
    expect(claimedWorkerId({ action: 'update_progress' }, CLAIM_TEXT)).toBeNull();
    expect(claimedWorkerId(null, CLAIM_TEXT)).toBeNull();
  });
});

describe('privacy', () => {
  it('the body carries only contract fields, never prompt/response/transcript', () => {
    const payload = {
      session_id: 'cc-1', cwd: '/repo', hook_event_name: 'UserPromptSubmit',
      user_prompt: 'TOP SECRET PROMPT', transcript_path: '/home/me/t.jsonl', last_assistant_message: 'REPLY',
    };
    const body = buildBody('claude', normalizeHookEvent('claude', payload), null);
    const s = JSON.stringify(body);
    expect(s).not.toContain('TOP SECRET');
    expect(s).not.toContain('t.jsonl');
    expect(s).not.toContain('REPLY');
    expect(Object.keys(body).sort()).toEqual(['client', 'clientSessionId', 'event']);
  });

  it('repo slugs drop credentials, and match the server normalizer', () => {
    for (const r of ['https://u:tok@github.com/acme/app.git', 'git@github.com:acme/app.git', 'ssh://git@host/acme/app', 'acme/app', 'nope']) {
      expect(repoSlug(r)).toBe(normalizeRepoSlug(r));
    }
    expect(repoSlug('https://u:tok@github.com/acme/app.git')).toBe('acme/app');
  });
});

describe('throttle and output', () => {
  it('touches coalesce to one a minute; start/bind/end always go', () => {
    expect(shouldSkip('touch', { lastSentAt: 1_000 }, 30_000)).toBe(true);
    expect(shouldSkip('touch', { lastSentAt: 1_000 }, 62_000)).toBe(false);
    expect(shouldSkip('end', { lastSentAt: 1_000 }, 2_000)).toBe(false);
    expect(shouldSkip('bind', { lastSentAt: 1_000 }, 2_000)).toBe(false);
  });

  it('nudges toward update_progress only when a message waits, and never quotes it', () => {
    expect(hookOutput('claude', 'UserPromptSubmit', { pendingInstructions: false })).toBe('');
    const out = JSON.parse(hookOutput('claude', 'UserPromptSubmit', { pendingInstructions: true, taskId: 'abcdef12-0000' }));
    expect(out.hookSpecificOutput.additionalContext).toContain('update_progress');
    expect(hookOutput('claude', 'Stop', { pendingInstructions: true })).toBe('');
    expect(hookOutput('cursor', 'sessionStart', null)).toBe('{}');
  });
});

describe('fail open', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'buildd-hook-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const env = () => ({ BUILDD_API_KEY: 'bld_test', BUILDD_SERVER: 'http://127.0.0.1:9', BUILDD_HOME: dir });
  const start = JSON.stringify({ session_id: 's', cwd: dir, hook_event_name: 'SessionStart' });

  it('a thrown fetch, a 500 and a timeout all resolve without throwing', async () => {
    for (const fetchImpl of [
      async () => { throw new Error('ECONNREFUSED'); },
      async () => new Response('boom', { status: 500 }),
      async () => { throw new DOMException('timed out', 'TimeoutError'); },
    ]) {
      const r = await run({ client: 'claude', stdin: start, env: env(), fetchImpl: fetchImpl as any });
      expect(r.sent).toBe(true);
      expect(r.ok).toBe(false);
    }
  });

  it('no key, bad JSON or disabled: nothing is sent', async () => {
    let called = 0;
    const fetchImpl = (async () => { called++; return new Response('{}'); }) as any;
    expect((await run({ client: 'claude', stdin: start, env: { BUILDD_HOME: dir }, fetchImpl })).why).toBe('no_key');
    expect((await run({ client: 'claude', stdin: '{not json', env: env(), fetchImpl })).why).toBe('bad_payload');
    expect((await run({ client: 'claude', stdin: start, env: { ...env(), BUILDD_HOOKS_DISABLED: '1' }, fetchImpl })).why).toBe('disabled');
    expect(called).toBe(0);
  });

  it('sends the contract body with the bearer key to the presence endpoint', async () => {
    let seen: { url: string; init: any } | null = null;
    const fetchImpl = (async (url: string, init: any) => { seen = { url, init }; return new Response(JSON.stringify({ ok: true, pendingInstructions: false })); }) as any;
    const r = await run({ client: 'claude', stdin: start, env: env(), fetchImpl });
    expect(r.ok).toBe(true);
    expect(seen!.url).toBe('http://127.0.0.1:9/api/workers/local-sessions');
    expect(seen!.init.headers.Authorization).toBe('Bearer bld_test');
    expect(JSON.parse(seen!.init.body)).toMatchObject({ event: 'start', client: 'claude', clientSessionId: 's' });
  });

  it('the real script exits 0 with buildd unreachable, fast, printing nothing', () => {
    const t0 = Date.now();
    const p = Bun.spawnSync(['node', SCRIPT, 'claude'], {
      stdin: Buffer.from(start),
      env: { PATH: process.env.PATH ?? '', HOME: dir, ...env() },
    });
    expect(p.exitCode).toBe(0);
    expect(p.stdout.toString()).toBe('');
    expect(Date.now() - t0).toBeLessThan(8_000);
  });

  it('the real script exits 0 on garbage input and an unknown client', () => {
    for (const [args, input] of [[['claude'], 'garbage'], [['vim'], start], [[], start]] as const) {
      const p = Bun.spawnSync(['node', SCRIPT, ...args], { stdin: Buffer.from(input), env: { PATH: process.env.PATH ?? '', HOME: dir, ...env() } });
      expect(p.exitCode).toBe(0);
    }
  });
});

describe('installer', () => {
  let home: string;
  let project: string;
  const ctx = (): InstallContext => ({
    home, scope: 'global', projectDir: project,
    scriptPath: SCRIPT, runtime: '/usr/local/bin/bun', pluginDir: PLUGIN_DIR,
  });
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'buildd-home-'));
    project = mkdtempSync(join(tmpdir(), 'buildd-proj-'));
  });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); rmSync(project, { recursive: true, force: true }); });

  const userSettings = () => ({
    model: 'opus',
    permissions: { allow: ['Bash(ls)'] },
    hooks: {
      PostToolUse: [{ matcher: 'Write|Edit', hooks: [{ type: 'command', command: 'prettier --write' }] }],
      SessionStart: [{ hooks: [{ type: 'command', command: '~/bin/greet.sh' }] }],
      Notification: [{ hooks: [{ type: 'command', command: 'notify-send hi' }] }],
    },
  });

  it('merge keeps every unrelated hook and setting; unmerge restores the original exactly', () => {
    const original = userSettings();
    const merged = mergeClaudeLikeHooks(original, claudeLikeHookEntries('node /x/buildd-hook.mjs claude', { async: true }));
    expect(merged.model).toBe('opus');
    expect(merged.hooks.PostToolUse).toHaveLength(2);
    expect(merged.hooks.SessionStart[0].hooks[0].command).toBe('~/bin/greet.sh');
    expect(merged.hooks.Notification).toEqual(original.hooks.Notification);
    expect(installedEvents('claude', merged).sort()).toEqual(['PostToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit']);
    expect(removeClaudeLikeHooks(merged)).toEqual(original);
  });

  it('merge is idempotent and replaces an old buildd entry instead of duplicating it', () => {
    const entries = claudeLikeHookEntries('node /old/buildd-hook.mjs claude', { async: true });
    const once = mergeClaudeLikeHooks(userSettings(), entries);
    const twice = mergeClaudeLikeHooks(once, entries);
    expect(twice).toEqual(once);
    const moved = mergeClaudeLikeHooks(once, claudeLikeHookEntries('node /new/buildd-hook.mjs claude', { async: true }));
    expect(JSON.stringify(moved)).not.toContain('/old/');
    expect(moved.hooks.SessionEnd).toHaveLength(1);
  });

  it('unmerge keeps a user handler that shares a matcher group with buildd', () => {
    const mixed = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }, { type: 'command', command: 'node /x/buildd-hook.mjs claude' }] }] } };
    expect(removeClaudeLikeHooks(mixed)).toEqual({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } });
    expect(removeClaudeLikeHooks({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node buildd-hook.mjs' }] }] } })).toEqual({});
  });

  it('Cursor merge/unmerge preserves other hooks and the version', () => {
    const original = { version: 1, hooks: { afterFileEdit: [{ command: './format.sh' }], stop: [{ command: './audit.sh' }] } };
    const merged = mergeCursorHooks(original, cursorHookEntries('node /x/buildd-hook.mjs cursor'));
    expect(merged.hooks.stop).toHaveLength(2);
    expect(merged.hooks.afterFileEdit).toEqual(original.hooks.afterFileEdit);
    expect(removeCursorHooks(merged)).toEqual(original);
  });

  it('install → status → reinstall → uninstall on real files, all three clients', () => {
    const claudeFile = join(home, '.claude', 'settings.json');
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(claudeFile, JSON.stringify(userSettings(), null, 2));
    const cursorFile = join(home, '.cursor', 'hooks.json');
    mkdirSync(join(home, '.cursor'), { recursive: true });
    writeFileSync(cursorFile, JSON.stringify({ version: 1, hooks: { afterFileEdit: [{ command: './format.sh' }] } }));

    for (const c of ['claude', 'codex', 'cursor'] as const) expect(installClient(c, ctx()).action).toBe('installed');
    expect(existsSync(join(home, '.claude', 'skills', 'buildd-session', 'SKILL.md'))).toBe(true);
    for (const c of ['claude', 'codex', 'cursor'] as const) expect(clientStatus(c, ctx()).action).toBe('installed');
    for (const c of ['claude', 'codex', 'cursor'] as const) expect(installClient(c, ctx()).action).toBe('unchanged');

    const installed = readFileSync(claudeFile, 'utf8');
    expect(installed).toContain('--no-env-file');
    expect(installed).not.toMatch(/bld_|Authorization/);

    for (const c of ['claude', 'codex', 'cursor'] as const) expect(uninstallClient(c, ctx()).action).toBe('removed');
    expect(JSON.parse(readFileSync(claudeFile, 'utf8'))).toEqual(userSettings());
    expect(JSON.parse(readFileSync(cursorFile, 'utf8'))).toEqual({ version: 1, hooks: { afterFileEdit: [{ command: './format.sh' }] } });
    expect(existsSync(join(home, '.claude', 'skills', 'buildd-session'))).toBe(false);
    expect(uninstallClient('claude', ctx()).action).toBe('unchanged');
  });

  it('never overwrites a settings file it cannot parse', () => {
    const f = join(home, '.claude', 'settings.json');
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(f, '{ "model": "opus", // a comment\n }');
    expect(installClient('claude', ctx()).action).toBe('error');
    expect(readFileSync(f, 'utf8')).toBe('{ "model": "opus", // a comment\n }');
  });

  it('project scope writes the local (uncommitted) Claude settings', () => {
    const r = installClient('claude', { ...ctx(), scope: 'project' });
    expect(r.file).toBe(join(project, '.claude', 'settings.local.json'));
  });

  it('hook command: bun gets --no-env-file, node does not', () => {
    expect(hookCommand({ runtime: '/h/.bun/bin/bun', scriptPath: '/p/buildd-hook.mjs' }, 'claude')).toBe('"/h/.bun/bin/bun" --no-env-file "/p/buildd-hook.mjs" claude');
    expect(hookCommand({ runtime: '/usr/bin/node', scriptPath: '/p/buildd-hook.mjs' }, 'cursor')).toBe('"/usr/bin/node" "/p/buildd-hook.mjs" cursor');
  });

  it('CLI: detects clients, refuses unknown options, needs a repo for project scope', () => {
    expect('error' in parseCliArgs(['--client=vim'])).toBe(true);
    expect('error' in parseCliArgs(['--force'])).toBe(true);
    expect(parseCliArgs(['--uninstall', '--global', '--client=claude'])).toEqual({ mode: 'uninstall', scope: 'global', clients: ['claude'] });
    expect(runCli([], { home, cwd: project }).code).toBe(1);
    const none = runCli(['--global'], { home, cwd: project, runtime: '/usr/bin/node' });
    expect(none.lines[0]).toContain('No supported coding client');
    mkdirSync(join(home, '.codex'));
    const one = runCli(['--global'], { home, cwd: project, runtime: '/usr/bin/node' });
    expect(one.code).toBe(0);
    expect(one.lines.join('\n')).toContain('/hooks');
    expect(existsSync(join(home, '.codex', 'hooks.json'))).toBe(true);
    expect(existsSync(join(home, '.claude'))).toBe(false);
  });
});

describe('plugin package', () => {
  const read = (p: string) => JSON.parse(readFileSync(join(PLUGIN_DIR, p), 'utf8'));

  it('the shipped Claude/Codex/Cursor hook files cover the same events the installer writes', () => {
    const claudeEvents = Object.keys(claudeLikeHookEntries('x', { async: true })).sort();
    expect(Object.keys(read('hooks/hooks.json').hooks).sort()).toEqual(claudeEvents);
    expect(Object.keys(read('com.openai.codex/hooks.json').hooks).sort()).toEqual(claudeEvents);
    expect(Object.keys(read('com.cursor/hooks.json').hooks).sort()).toEqual(Object.keys(cursorHookEntries('x')).sort());
    expect(installedEvents('claude', read('hooks/hooks.json')).sort()).toEqual(claudeEvents);
  });

  it('manifests are valid and carry no credential', () => {
    const manifest = read('plugin.json');
    expect(manifest.$schema).toContain('agent-plugins.org');
    expect(manifest.name).toMatch(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/);
    expect(existsSync(join(PLUGIN_DIR, 'skills', 'buildd-session', 'SKILL.md'))).toBe(true);
    for (const f of ['plugin.json', 'mcp.json', '.claude-plugin/plugin.json', 'hooks/hooks.json']) {
      expect(readFileSync(join(PLUGIN_DIR, f), 'utf8')).not.toMatch(/bld_[A-Za-z0-9]/);
    }
    expect(read('mcp.json').mcpServers.buildd.headers.Authorization).toBe('Bearer ${BUILDD_API_KEY}');
  });
});
