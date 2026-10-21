/**
 * `buildd top` talk session (talk.ts): what the launch is made of for a mission
 * and for a task, the missing-login refusal, and tmux versus suspend.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CODEX_TOKEN_ENV, NOT_LOGGED_IN, buildTalkLaunch, runTalk, claudeLoggedIn, claudeTranscriptExists, codexLoggedIn, codexTranscriptExists, fileTalkSessions, findCodexSession, starterPrompt, talkContext, talkSessionKey, talkWorkspaceId } from '../../src/top/talk';
import { NOW, fixtureState } from './top-fixture';
import { IS_WINDOWS, openToAllUsers } from '../windows-acl';

const mission = { kind: 'mission' as const, id: 'm-tui-0000-0000', title: 'Runner TUI' };
const base = { loggedIn: true, cwd: '/work/repo', server: 'https://buildd.example/', apiKey: 'bld_secret', mcpConfigPath: '/tmp/x/mcp.json', newSessionId: 'new-session', env: {} };
const ctx = talkContext(fixtureState(), mission, {
  explain: { answer: { situation: { headline: 'Building: 3 tasks running' }, nextAction: 'Answer the question on "installer hint"' } },
  mission: { description: 'Show the runner live.', goalCriteria: [{ type: 'description', label: 'top shows queue' }, { type: 'all_prs_merged' }], goalCriteriaState: { criteria: [{ verdict: 'pass' }, { verdict: 'PENDING' }] } },
}, NOW);

describe('starter prompt', () => {
  test('a mission: title, description, situation, goals, open tasks with why they wait, questions for the owner', () => {
    const p = starterPrompt(ctx);
    expect(p).toContain('organizer for the buildd mission "Runner TUI"');
    expect(p).toContain('Show the runner live.');
    expect(p).toContain('Building: 3 tasks running');
    expect(p).toContain('[pass] top shows queue');
    expect(p).toContain('[PENDING] all_prs_merged');
    expect(p).toContain('name override');
    expect(p).toContain('buildd top');
    expect(p).toMatch(/Waiting on the owner:\n- .*installer hint/);
  });

  test('a task: scoped to that task and its mission, with its own state', () => {
    const c = talkContext(fixtureState(), { kind: 'task', id: 't-hint', title: 'installer hint' }, {}, NOW);
    const p = starterPrompt(c);
    expect(p).toContain('steering the agent working on the buildd task "installer hint"');
    expect(p).toContain('part of the mission "Runner TUI"');
    expect(p).not.toContain('organizer for');
  });

  test('a mission nobody described still gets a prompt', () => {
    const c = talkContext(fixtureState(), mission, {}, NOW);
    expect(starterPrompt(c)).toContain('Runner TUI');
  });
});

describe('buildTalkLaunch', () => {
  test('a mission launches claude in the checkout with the buildd MCP and the organizer system prompt', () => {
    const l = buildTalkLaunch({ ...base, context: ctx });
    if (!l.ok) throw new Error(l.message);
    expect(l.cwd).toBe('/work/repo');
    expect(l.argv[0]).toBe('claude');
    expect(l.argv[l.argv.indexOf('--mcp-config') + 1]).toBe('/tmp/x/mcp.json');
    const sys = l.argv[l.argv.indexOf('--append-system-prompt') + 1];
    expect(sys).toContain('organizer');
    expect(sys).toContain('create_task');
    expect(sys).toContain('answer_question');
    expect(sys).toContain('Never edit code in this checkout');
    expect(l.argv[l.argv.length - 1]).toBe(starterPrompt(ctx));
    expect(l.mcpConfig.mcpServers.buildd).toEqual({ type: 'http', url: 'https://buildd.example/api/mcp', headers: { Authorization: 'Bearer bld_secret' } });
  });

  test('the buildd MCP is bound to the target\'s workspace, so a key that reaches several workspaces opens in the right one', () => {
    const l = buildTalkLaunch({ ...base, workspaceId: 'ws 1', context: ctx });
    if (!l.ok) throw new Error(l.message);
    expect((l.mcpConfig.mcpServers.buildd as { url: string }).url).toBe('https://buildd.example/api/mcp?workspace=ws%201');
  });

  test('a new session gets an id, so a later s can come back to it', () => {
    const l = buildTalkLaunch({ ...base, context: ctx });
    if (!l.ok) throw new Error(l.message);
    expect(l.argv[l.argv.indexOf('--session-id') + 1]).toBe('new-session');
    expect(l.argv).not.toContain('--resume');
    expect(l).toMatchObject({ sessionId: 'new-session', resumed: false });
  });

  test('an earlier session resumes where it left off, with no second starter prompt', () => {
    const l = buildTalkLaunch({ ...base, resumeSessionId: 'old-session', context: ctx });
    if (!l.ok) throw new Error(l.message);
    expect(l.argv[l.argv.indexOf('--resume') + 1]).toBe('old-session');
    expect(l.argv).not.toContain('--session-id');
    expect(l.argv).not.toContain(starterPrompt(ctx));
    expect(l).toMatchObject({ sessionId: 'old-session', resumed: true });
  });

  test('the key is in the config, never on the command line', () => {
    const l = buildTalkLaunch({ ...base, context: ctx });
    if (!l.ok) throw new Error(l.message);
    expect(l.argv.join(' ')).not.toContain('bld_secret');
  });

  test('a task steers that task\'s agent', () => {
    const c = talkContext(fixtureState(), { kind: 'task', id: 't-hint', title: 'installer hint' }, {}, NOW);
    const l = buildTalkLaunch({ ...base, context: c });
    if (!l.ok) throw new Error(l.message);
    expect(l.argv[l.argv.indexOf('--append-system-prompt') + 1]).toContain('steering one task');
  });

  test('no claude login: one line, no session', () => {
    const l = buildTalkLaunch({ ...base, loggedIn: false, context: ctx });
    expect(l).toEqual({ ok: false, message: "Claude isn't logged in on this machine: run claude login" });
    expect(NOT_LOGGED_IN).toBe(l.ok ? '' : l.message);
  });

  test('no checkout or no key says so instead of opening a broken session', () => {
    expect(buildTalkLaunch({ ...base, cwd: null, context: ctx }).ok).toBe(false);
    expect(buildTalkLaunch({ ...base, apiKey: null, context: ctx }).ok).toBe(false);
  });

  test('tmux opens a pane; otherwise top steps aside', () => {
    const t = buildTalkLaunch({ ...base, env: { TMUX: '/tmp/tmux-1000/default,1,0' }, context: ctx });
    const s = buildTalkLaunch({ ...base, context: ctx });
    expect(t.ok && t.mode).toBe('tmux');
    expect(s.ok && s.mode).toBe('suspend');
  });
});

describe('claudeLoggedIn', () => {
  test('exit 0 is logged in; anything else, or a missing binary, is not', async () => {
    expect(await claudeLoggedIn(async () => 0)).toBe(true);
    expect(await claudeLoggedIn(async () => 1)).toBe(false);
    expect(await claudeLoggedIn(async () => { throw new Error('ENOENT'); })).toBe(false);
  });
});

describe('talkWorkspaceId', () => {
  test('a task names its own workspace', () => {
    const s = fixtureState();
    const t = s.tasks.find(x => x.id === 't-hint')!;
    expect(talkWorkspaceId(s, { kind: 'task', id: 't-hint', title: 'x' }, NOW)).toBe(t.workspaceId ?? t.workspace?.id);
  });
});

describe('remembered sessions', () => {
  test('one record per mission or task, kept across top restarts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'talk-sessions-'));
    try {
      const path = join(dir, 'talk-sessions.json');
      fileTalkSessions(path).set(talkSessionKey(mission), { sessionId: 's1', cwd: '/work/repo', paneId: '%3' });
      fileTalkSessions(path).set('task:t1', { sessionId: 's2', cwd: '/work/repo' });
      const again = fileTalkSessions(path);
      expect(again.get('mission:m-tui-0000-0000')).toEqual({ sessionId: 's1', cwd: '/work/repo', paneId: '%3' });
      expect(again.get('task:t1')?.sessionId).toBe('s2');
      expect(again.get('task:other')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a session can be resumed only while claude still has its transcript', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-config-'));
    try {
      mkdirSync(join(dir, 'projects', '-work-repo'), { recursive: true });
      writeFileSync(join(dir, 'projects', '-work-repo', 'kept.jsonl'), '{}\n');
      expect(claudeTranscriptExists('kept', { CLAUDE_CONFIG_DIR: dir })).toBe(true);
      expect(claudeTranscriptExists('gone', { CLAUDE_CONFIG_DIR: dir })).toBe(false);
      expect(claudeTranscriptExists('kept', { CLAUDE_CONFIG_DIR: join(dir, 'missing') })).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Codex (S)', () => {
  test('opens codex in the checkout with the buildd MCP bound to the workspace; the key is only in the environment', () => {
    const l = buildTalkLaunch({ ...base, agent: 'codex', workspaceId: 'ws-1', context: ctx });
    if (!l.ok) throw new Error(l.message);
    expect(l.argv[0]).toBe('codex');
    expect(l.cwd).toBe('/work/repo');
    expect(l.argv).toContain('mcp_servers.buildd.url="https://buildd.example/api/mcp?workspace=ws-1"');
    expect(l.argv).toContain(`mcp_servers.buildd.bearer_token_env_var="${CODEX_TOKEN_ENV}"`);
    expect(l.argv.find(a => a.startsWith('developer_instructions='))).toContain('Never edit code in this checkout');
    expect(l.argv[l.argv.length - 1]).toBe(starterPrompt(ctx));
    expect(l.argv.join(' ')).not.toContain('bld_secret');
    expect(l.secretEnv).toEqual({ [CODEX_TOKEN_ENV]: 'bld_secret' });
    expect(l.mcpConfig).toBeUndefined();
    // codex names its own sessions; top reads the id after.
    expect(l).toMatchObject({ agent: 'codex', sessionId: null, resumed: false });
  });

  test('an earlier Codex session resumes with codex resume and no second starter prompt', () => {
    const l = buildTalkLaunch({ ...base, agent: 'codex', resumeSessionId: 'old', context: ctx });
    if (!l.ok) throw new Error(l.message);
    expect(l.argv.slice(0, 3)).toEqual(['codex', 'resume', 'old']);
    expect(l.argv).not.toContain(starterPrompt(ctx));
    expect(l).toMatchObject({ sessionId: 'old', resumed: true });
  });

  test('no codex login says so, naming codex', () => {
    expect(buildTalkLaunch({ ...base, agent: 'codex', loggedIn: false, context: ctx })).toEqual({ ok: false, message: "Codex isn't logged in on this machine: run codex login" });
  });

  test('codex login status decides it', async () => {
    const seen: string[][] = [];
    expect(await codexLoggedIn(async c => { seen.push(c); return 0; })).toBe(true);
    expect(await codexLoggedIn(async () => 1)).toBe(false);
    expect(seen[0]).toEqual(['codex', 'login', 'status']);
  });

  test('Claude and Codex sessions on one target are remembered apart', () => {
    expect(talkSessionKey(mission, 'codex')).not.toBe(talkSessionKey(mission, 'claude'));
    expect(talkSessionKey(mission)).toBe(talkSessionKey(mission, 'claude'));
  });

  test('the new Codex session is the newest rollout that started in the checkout', () => {
    const home = mkdtempSync(join(tmpdir(), 'codex-home-'));
    try {
      const day = join(home, 'sessions', '2026', '10', '19');
      mkdirSync(day, { recursive: true });
      const meta = (id: string, cwd: string) => JSON.stringify({ type: 'session_meta', payload: { id, cwd } }) + '\n{}\n';
      writeFileSync(join(day, 'rollout-2026-10-19T10-00-00-elsewhere.jsonl'), meta('elsewhere', '/other/repo'));
      writeFileSync(join(day, 'rollout-2026-10-19T10-00-01-ours.jsonl'), meta('ours', '/work/repo'));
      const env = { CODEX_HOME: home };
      expect(findCodexSession('/work/repo', Date.now() - 60_000, env)).toBe('ours');
      // Started before this session: not ours.
      expect(findCodexSession('/work/repo', Date.now() + 60_000, env)).toBeNull();
      expect(codexTranscriptExists('ours', env)).toBe(true);
      expect(codexTranscriptExists('gone', env)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// mcp.json carries the key. Mode bits do nothing on Windows, so the talk dir
// gets an owner-only DACL before it is written, even under a configDir every
// user may write. The session itself checks, since the dir is gone after.
test.skipIf(!IS_WINDOWS)('Windows: the mcp.json a talk session reads grants only its owner', async () => {
  const open = mkdtempSync(join(tmpdir(), 'talk-acl-'));
  try {
    openToAllUsers(open);
    const check = join(open, 'check.js');
    writeFileSync(check, [
      "const p = process.argv[process.argv.indexOf('--mcp-config') + 1];",
      "const ic = (process.env.SystemRoot || 'C:/Windows') + '/System32/icacls.exe';",
      "const out = new TextDecoder().decode(Bun.spawnSync([ic, p]).stdout);",
      "const aces = out.split(String.fromCharCode(10)).filter(l => l.includes(':('));",
      "if (aces.length !== 1) console.error(out);",
      "process.exit(aces.length === 1 && !/BUILTIN|Authenticated/i.test(out) ? 0 : 3);",
    ].join('\n'));
    const code = await runTalk({
      ok: true, agent: 'claude', mode: 'suspend', cwd: open, sessionId: 's', resumed: false,
      argv: [process.execPath, check, '--mcp-config', 'placeholder'],
      mcpConfig: { mcpServers: { buildd: { type: 'http', url: 'https://buildd.example/api/mcp', headers: { Authorization: 'Bearer bld_test' } } } },
    } as Parameters<typeof runTalk>[0], { configDir: open });
    expect(code).toBe(0);
  } finally {
    rmSync(open, { recursive: true, force: true });
  }
});
