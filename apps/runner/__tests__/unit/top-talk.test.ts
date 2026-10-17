/**
 * `buildd top` talk session (talk.ts): what the launch is made of for a mission
 * and for a task, the missing-login refusal, and tmux versus suspend.
 */
import { describe, expect, test } from 'bun:test';
import { NOT_LOGGED_IN, buildTalkLaunch, claudeLoggedIn, starterPrompt, talkContext, talkWorkspaceId } from '../../src/top/talk';
import { NOW, fixtureState } from './top-fixture';

const mission = { kind: 'mission' as const, id: 'm-tui-0000-0000', title: 'Runner TUI' };
const base = { loggedIn: true, cwd: '/work/repo', server: 'https://buildd.example/', apiKey: 'bld_secret', mcpConfigPath: '/tmp/x/mcp.json', env: {} };
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
