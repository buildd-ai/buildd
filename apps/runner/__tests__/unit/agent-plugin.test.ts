import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, statSync } from 'fs';
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
  writeWorkspaceCache,
  readWorkspaceCache,
  isWorkspaceRepo,
  WORKSPACE_REFRESH_MS,
  resolveAuth,
  readSessionState,
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

/** Make dir a checkout of `repo` and seed the hook's workspace list with it, as `buildd install` does. */
function workspaceCheckout(dir: string, repo = 'acme/widget', workspaces: string[] = [repo]) {
  Bun.spawnSync(['git', 'init', '-q', dir]);
  Bun.spawnSync(['git', '-C', dir, 'remote', 'add', 'origin', `https://github.com/${repo}.git`]);
  writeWorkspaceCache({ BUILDD_HOME: dir }, 'bld_test', workspaces, Date.now());
}

describe('client adapters', () => {
  it('Claude Code: start, touch, bind, end', () => {
    const base = { session_id: 'cc-1', cwd: '/repo', transcript_path: '/t.jsonl' };
    expect(normalizeHookEvent('claude', { ...base, hook_event_name: 'SessionStart', source: 'startup' }, {}))
      .toEqual({ clientSessionId: 'cc-1', cwd: '/repo', event: 'start', interactive: true });
    expect(normalizeHookEvent('claude', { ...base, hook_event_name: 'UserPromptSubmit', user_prompt: 'secret plan' })?.event).toBe('touch');
    expect(normalizeHookEvent('claude', { ...base, hook_event_name: 'Stop', last_assistant_message: 'x' })?.event).toBe('touch');
    expect(normalizeHookEvent('claude', {
      ...base, hook_event_name: 'PostToolUse', tool_name: 'mcp__buildd__buildd',
      tool_input: { action: 'claim_task', params: { taskId: 'x' } },
      tool_response: [{ type: 'text', text: CLAIM_TEXT }],
    }, {})).toEqual({ clientSessionId: 'cc-1', cwd: '/repo', event: 'bind', workerId: WORKER, interactive: true });
    expect(normalizeHookEvent('claude', { ...base, hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' })?.reason).toBe('exit');
    expect(normalizeHookEvent('claude', { ...base, hook_event_name: 'SessionEnd', reason: 'clear' })?.reason).toBe('clear');
    expect(normalizeHookEvent('claude', { ...base, hook_event_name: 'SessionEnd', reason: 'other' })?.reason).toBe('other');
  });

  it('Claude Code: other tools, other actions and failed claims are touches, never binds; unknown events are ignored', () => {
    // A tool call is a turn boundary: a touch (throttled) lets the hook learn a
    // message is waiting. Only a successful claim binds.
    const base = { session_id: 'cc-1', cwd: '/repo', hook_event_name: 'PostToolUse' };
    const touch = { clientSessionId: 'cc-1', cwd: '/repo', event: 'touch' };
    expect(normalizeHookEvent('claude', { ...base, tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: CLAIM_TEXT })).toEqual(touch);
    expect(normalizeHookEvent('claude', { ...base, tool_name: 'mcp__buildd__buildd', tool_input: { action: 'get_task' }, tool_response: CLAIM_TEXT })).toEqual(touch);
    expect(normalizeHookEvent('claude', { ...base, tool_name: 'mcp__buildd__buildd', tool_input: { action: 'claim_task' }, tool_response: 'Nothing claimed: no_slots' })).toEqual(touch);
    expect(normalizeHookEvent('claude', { ...base, tool_name: 'mcp__buildd__buildd', tool_input: { action: 'claim_task' }, tool_response: { isError: true, content: CLAIM_TEXT } })).toEqual(touch);
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
    // `interactive` is a boolean the client derives from its own env, not payload content.
    expect(Object.keys(body).sort()).toEqual(['client', 'clientSessionId', 'event', 'interactive']);
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

  it('nudges toward receive_messages only when a message waits, and never quotes it', () => {
    expect(hookOutput('claude', 'UserPromptSubmit', { pendingInstructions: false })).toBe('');
    const out = JSON.parse(hookOutput('claude', 'UserPromptSubmit', { pendingInstructions: true, taskId: 'abcdef12-0000' }));
    expect(out.hookSpecificOutput.additionalContext).toContain('receive_messages');
    expect(out.hookSpecificOutput.additionalContext).not.toContain('update_progress');
    expect(hookOutput('cursor', 'sessionStart', null)).toBe('{}');
  });

  // B-9: delivery at the next turn boundary, not only when a human types.
  describe('turn-boundary nudges (B-9)', () => {
    const SECRET = 'rotate the prod key now';
    const pending = { pendingInstructions: true, taskId: 'abcdef12-0000', instructions: SECRET };

    for (const client of ['claude', 'codex'] as const) {
      it(`${client}: PostToolUse adds context naming receive_messages`, () => {
        const out = JSON.parse(hookOutput(client, 'PostToolUse', pending));
        expect(out.hookSpecificOutput.hookEventName).toBe('PostToolUse');
        expect(out.hookSpecificOutput.additionalContext).toContain('receive_messages');
      });

      it(`${client}: Stop blocks once, and not when stop_hook_active`, () => {
        const out = JSON.parse(hookOutput(client, 'Stop', pending, { stop_hook_active: false }));
        expect(out.decision).toBe('block');
        expect(out.reason).toContain('receive_messages');
        expect(hookOutput(client, 'Stop', pending, { stop_hook_active: true })).toBe('');
      });

      it(`${client}: no pending message → empty stdout on every event`, () => {
        for (const ev of ['UserPromptSubmit', 'PostToolUse', 'Stop', 'SessionStart', 'SessionEnd']) {
          expect(hookOutput(client, ev, { pendingInstructions: false })).toBe('');
          expect(hookOutput(client, ev, null)).toBe('');
        }
      });
    }

    it('the message text appears in no hook output', () => {
      for (const client of ['claude', 'codex', 'cursor'] as const) {
        for (const ev of ['UserPromptSubmit', 'PostToolUse', 'Stop', 'sessionStart', 'stop']) {
          expect(hookOutput(client, ev, pending, { stop_hook_active: false })).not.toContain(SECRET);
        }
      }
    });

    it('Cursor stays queued-only: no nudge on any event', () => {
      expect(hookOutput('cursor', 'stop', pending)).toBe('');
      expect(hookOutput('cursor', 'afterMCPExecution', pending)).toBe('');
    });

    it('PostToolUse on any tool is a (throttled) touch; a buildd claim is still a bind', () => {
      const base = { session_id: 'cc-1', cwd: '/repo', hook_event_name: 'PostToolUse' };
      expect(normalizeHookEvent('claude', { ...base, tool_name: 'Bash' })?.event).toBe('touch');
      expect(normalizeHookEvent('codex', { ...base, tool_name: 'shell' })?.event).toBe('touch');
    });

    it('Stop is never throttled: it is the last chance this turn', () => {
      const n = normalizeHookEvent('claude', { session_id: 'cc-1', cwd: '/repo', hook_event_name: 'Stop' });
      expect(n?.event).toBe('touch');
      expect(shouldSkip(n!.event, { lastSentAt: 1_000 }, 2_000, n!.force)).toBe(false);
    });

    it('run(): Stop with a waiting message prints the block decision', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'buildd-hook-stop-'));
      // A folder whose .mcp.json names buildd is in scope (see 'workspace scope').
      writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { buildd: { type: 'http', url: 'https://b.test/api/mcp' } } }));
      try {
        const fetchImpl = (async () => Response.json({ ok: true, pendingInstructions: true, taskId: 'abcdef12-0000' })) as any;
        const env = { BUILDD_API_KEY: 'bld_x', BUILDD_SERVER: 'https://b.test', BUILDD_HOME: dir } as any;
        const stdin = JSON.stringify({ session_id: 's-1', cwd: dir, hook_event_name: 'Stop', stop_hook_active: false });
        const r = await run({ client: 'claude', stdin, env, fetchImpl, now: 10_000 });
        expect(JSON.parse(r.output).decision).toBe('block');
        // Immediately again (inside the touch window), with stop_hook_active: no second block.
        const again = await run({ client: 'claude', stdin: JSON.stringify({ session_id: 's-1', cwd: dir, hook_event_name: 'Stop', stop_hook_active: true }), env, fetchImpl, now: 11_000 });
        expect(again.output).toBe('');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

describe('Claude Code: attended vs headless', () => {
  // Claude Code sets these on every hook it spawns: an interactive TUI session
  // reads ATTENDED=1 / ENTRYPOINT=cli, `claude -p` and SDK runs read 0 / sdk-*.
  const start = { session_id: 'cc-1', cwd: '/repo', hook_event_name: 'SessionStart', source: 'startup' };
  const interactive = (env: Record<string, string>) => normalizeHookEvent('claude', start, env)?.interactive;

  it('an unattended session (claude -p, SDK) starts as not interactive', () => {
    expect(interactive({ CLAUDE_CODE_SESSION_ATTENDED: '0', CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' })).toBe(false);
    expect(interactive({ CLAUDE_CODE_SESSION_ATTENDED: '0' })).toBe(false);
    expect(interactive({ CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' })).toBe(false);
  });

  it('an attended session, or a client that says nothing, stays interactive', () => {
    expect(interactive({ CLAUDE_CODE_SESSION_ATTENDED: '1', CLAUDE_CODE_ENTRYPOINT: 'cli' })).toBe(true);
    expect(interactive({ CLAUDE_CODE_ENTRYPOINT: 'cli' })).toBe(true);
    expect(interactive({})).toBe(true);
  });

  it('ATTENDED wins over a stale inherited ENTRYPOINT', () => {
    expect(interactive({ CLAUDE_CODE_SESSION_ATTENDED: '1', CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' })).toBe(true);
    expect(interactive({ CLAUDE_CODE_SESSION_ATTENDED: '0', CLAUDE_CODE_ENTRYPOINT: 'cli' })).toBe(false);
  });

  it('bind and touch carry the same flag, so a presence first created by a bind is right', () => {
    // A session outside a workspace repo sends no start; its first event is the
    // bind, and the server creates the presence from it.
    const headless = { CLAUDE_CODE_SESSION_ATTENDED: '0' };
    const bind = {
      session_id: 'cc-1', cwd: '/repo', hook_event_name: 'PostToolUse', tool_name: 'mcp__buildd__buildd',
      tool_input: { action: 'claim_task', params: {} }, tool_response: [{ type: 'text', text: CLAIM_TEXT }],
    };
    expect(normalizeHookEvent('claude', bind, headless)?.interactive).toBe(false);
    expect(normalizeHookEvent('claude', { ...start, hook_event_name: 'UserPromptSubmit' }, headless)?.interactive).toBe(false);
    expect(normalizeHookEvent('claude', { ...start, hook_event_name: 'Stop' }, {})?.interactive).toBe(true);
    expect(normalizeHookEvent('claude', { ...start, hook_event_name: 'Stop' }, headless)).toMatchObject({ interactive: false, force: true });
    // SessionEnd never needs it.
    expect(normalizeHookEvent('claude', { ...start, hook_event_name: 'SessionEnd', reason: 'other' }, headless)?.interactive).toBeUndefined();
  });

  it('run() reads the hook environment, so the POSTed start says interactive: false', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'buildd-hook-'));
    workspaceCheckout(dir);
    try {
      let body: any = null;
      const fetchImpl = async (_url: string, init: any) => { body = JSON.parse(init.body); return Response.json({ ok: true }); };
      await run({
        client: 'claude', stdin: JSON.stringify({ ...start, cwd: dir }), fetchImpl: fetchImpl as any,
        env: { BUILDD_API_KEY: 'bld_test', BUILDD_SERVER: 'http://127.0.0.1:9', BUILDD_HOME: dir, CLAUDE_CODE_SESSION_ATTENDED: '0' },
      });
      expect(body).toMatchObject({ event: 'start', client: 'claude', interactive: false });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('workspace scope', () => {
  let dir: string;
  let calls: string[];
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'buildd-hook-')); calls = []; });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const env = () => ({ BUILDD_API_KEY: 'bld_test', BUILDD_SERVER: 'http://127.0.0.1:9', BUILDD_HOME: dir });
  const ev = (hook_event_name: string, extra: object = {}) =>
    JSON.stringify({ session_id: 'scope-1', cwd: dir, hook_event_name, ...extra });
  /** Records every URL; answers the workspace list with `workspaces`, presence with ok. */
  const server = (workspaces: Array<{ repo: string | null }>) => (async (url: string) => {
    calls.push(url);
    return url.endsWith('/api/workspaces') ? Response.json({ workspaces }) : Response.json({ ok: true });
  }) as any;
  const presenceCalls = () => calls.filter(u => u.endsWith('/local-sessions'));

  it('a session outside every workspace repo sends nothing, for its whole life', async () => {
    workspaceCheckout(dir, 'someone/else', ['acme/widget']);
    const fetchImpl = server([{ repo: 'https://github.com/acme/widget' }]);
    for (const e of ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd']) {
      expect((await run({ client: 'claude', stdin: ev(e), env: env(), fetchImpl })).why).toBe('outside_workspace');
    }
    expect(presenceCalls()).toEqual([]);
  });

  it('a folder that is not a git repo sends nothing', async () => {
    writeWorkspaceCache({ BUILDD_HOME: dir }, 'bld_test', ['acme/widget']);
    expect((await run({ client: 'claude', stdin: ev('SessionStart'), env: env(), fetchImpl: server([]) })).why).toBe('outside_workspace');
    expect(presenceCalls()).toEqual([]);
  });

  it('a session in a workspace repo is reported, with its repo', async () => {
    workspaceCheckout(dir, 'Acme/Widget', ['acme/widget']);
    const r = await run({ client: 'claude', stdin: ev('SessionStart'), env: env(), fetchImpl: server([]) });
    expect(r.sent).toBe(true);
    expect(r.body).toMatchObject({ event: 'start', repo: 'Acme/Widget' });
  });

  it('claiming a task outside a workspace still binds, and the session is tracked from then on', async () => {
    workspaceCheckout(dir, 'someone/else', ['acme/widget']);
    const fetchImpl = server([]);
    await run({ client: 'claude', stdin: ev('SessionStart'), env: env(), fetchImpl });
    const W = '11111111-2222-4333-8444-555555555555';
    const bind = await run({
      client: 'claude', env: env(), fetchImpl,
      stdin: ev('PostToolUse', {
        tool_name: 'mcp__buildd__buildd', tool_input: { action: 'claim_task', params: {} },
        tool_response: [{ type: 'text', text: `Claimed 1 task(s):\n\n**Worker ID:** ${W}\n**Task:** x` }],
      }),
    });
    expect(bind.body).toMatchObject({ event: 'bind', workerId: W });
    expect((await run({ client: 'claude', stdin: ev('SessionEnd', { reason: 'prompt_input_exit' }), env: env(), fetchImpl })).body)
      .toMatchObject({ event: 'end', reason: 'exit' });
  });

  it('a subagent claim binds to the same session, and which subagent claimed which task stays on this machine', async () => {
    workspaceCheckout(dir, 'acme/widget', ['acme/widget']);
    const fetchImpl = server([]);
    await run({ client: 'claude', stdin: ev('SessionStart'), env: env(), fetchImpl });
    const claim = (w: string) => [{ type: 'text', text: `Claimed 1 task(s):\n\n**Worker ID:** ${w}\n**Task:** x` }];
    const W1 = '11111111-2222-4333-8444-000000000001';
    const W2 = '11111111-2222-4333-8444-000000000002';
    const parent = await run({ client: 'claude', env: env(), fetchImpl, stdin: ev('PostToolUse', {
      tool_name: 'mcp__buildd__buildd', tool_input: { action: 'claim_task', params: {} }, tool_response: claim(W1),
    }) });
    // Claude Code tags a subagent's tool call with agent_id / agent_type and the parent's session_id.
    const sub = await run({ client: 'claude', env: env(), fetchImpl, stdin: ev('PostToolUse', {
      agent_id: 'a0123456789abcdef', agent_type: 'general-purpose',
      tool_name: 'mcp__buildd__buildd', tool_input: { action: 'claim_task', params: {} }, tool_response: claim(W2),
    }) });
    expect(parent.body).toEqual({ event: 'bind', client: 'claude', clientSessionId: 'scope-1', workerId: W1, interactive: expect.any(Boolean) });
    expect(sub.body).toEqual({ event: 'bind', client: 'claude', clientSessionId: 'scope-1', workerId: W2, interactive: expect.any(Boolean) });
    expect(readSessionState({ BUILDD_HOME: dir }, 'claude', 'scope-1').claims).toEqual({ [W1]: null, [W2]: 'a0123456789abcdef' });
  });

  it('fails closed: no list and buildd unreachable means nothing is sent', async () => {
    Bun.spawnSync(['git', 'init', '-q', dir]);
    Bun.spawnSync(['git', '-C', dir, 'remote', 'add', 'origin', 'https://github.com/acme/widget.git']);
    const down = (async (url: string) => { calls.push(url); throw new Error('ECONNREFUSED'); }) as any;
    expect((await run({ client: 'claude', stdin: ev('SessionStart'), env: env(), fetchImpl: down })).why).toBe('outside_workspace');
    expect(presenceCalls()).toEqual([]);
  });

  it('a new workspace is picked up: an unknown repo refetches a stale list, at most every 10 minutes', async () => {
    const now = Date.now();
    writeWorkspaceCache({ BUILDD_HOME: dir }, 'k', ['acme/widget'], now - WORKSPACE_REFRESH_MS - 1);
    const fetchImpl = server([{ repo: 'https://github.com/acme/widget' }, { repo: 'git@github.com:acme/new-thing.git' }]);
    const opts = { env: { BUILDD_HOME: dir }, auth: { server: 'http://x', apiKey: 'k' }, fetchImpl, now };
    expect(await isWorkspaceRepo('acme/new-thing', opts)).toBe(true);
    expect(readWorkspaceCache({ BUILDD_HOME: dir }, 'k')?.repos).toEqual(['acme/new-thing', 'acme/widget']);
    expect(await isWorkspaceRepo('nobody/nothing', opts)).toBe(false);
    expect(calls.filter(u => u.endsWith('/api/workspaces'))).toHaveLength(1);
  });

  it("each key has its own list: another team's key never reads this one", async () => {
    workspaceCheckout(dir, 'acme/widget', ['acme/widget']);
    expect(readWorkspaceCache({ BUILDD_HOME: dir }, 'bld_test')?.repos).toEqual(['acme/widget']);
    expect(readWorkspaceCache({ BUILDD_HOME: dir }, 'bld_other_team')).toBeNull();
  });

  it("a repo whose own .mcp.json names buildd is in scope even if this key's list lacks it", async () => {
    workspaceCheckout(dir, 'someone/else', ['acme/widget']);
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { buildd: { type: 'http', url: 'https://b.test/api/mcp?repo=someone/else' } } }));
    const r = await run({ client: 'claude', stdin: ev('SessionStart'), env: env(), fetchImpl: server([]) });
    expect(r.sent).toBe(true);
    // Any other MCP server in .mcp.json does not count.
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { other: { url: 'https://x.test/mcp' } } }));
    expect((await run({ client: 'claude', stdin: ev('SessionStart', { session_id: 'scope-2' }), env: env(), fetchImpl: server([]) })).why).toBe('outside_workspace');
  });

  it('the list call carries no folder information', async () => {
    workspaceCheckout(dir, 'someone/else', []);
    writeWorkspaceCache({ BUILDD_HOME: dir }, 'bld_test', [], 0);
    let init: any = null;
    const fetchImpl = (async (url: string, i: any) => { calls.push(url); init = i; return Response.json({ workspaces: [] }); }) as any;
    await run({ client: 'claude', stdin: ev('SessionStart'), env: env(), fetchImpl });
    expect(calls).toEqual(['http://127.0.0.1:9/api/workspaces']);
    expect(init.body).toBeUndefined();
  });
});

describe('presence token', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'buildd-hook-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const TOKEN = 'bldp_eyJ0IjoieCIsInUiOiJ5In0.sig';
  const login = (cfg: Record<string, string>) => writeFileSync(join(dir, 'config.json'), JSON.stringify(cfg));

  it("the person's presence token wins over the account key, from config or the environment", () => {
    login({ apiKey: 'bld_team_key', presenceToken: TOKEN, builddServer: 'https://b.test/' });
    expect(resolveAuth({ BUILDD_HOME: dir })).toEqual({ apiKey: TOKEN, server: 'https://b.test', kind: 'presence' });
    expect(resolveAuth({ BUILDD_HOME: dir, BUILDD_API_KEY: 'bld_env_key' })?.kind).toBe('presence');
    login({ apiKey: 'bld_team_key' });
    expect(resolveAuth({ BUILDD_HOME: dir })).toEqual({ apiKey: 'bld_team_key', server: 'https://buildd.dev', kind: 'key' });
    expect(resolveAuth({ BUILDD_HOME: dir, BUILDD_PRESENCE_TOKEN: TOKEN })?.kind).toBe('presence');
  });

  it('a value that is not a presence token is ignored, not sent', () => {
    login({ apiKey: 'bld_team_key', presenceToken: 'bld_wrong_slot' });
    expect(resolveAuth({ BUILDD_HOME: dir })?.apiKey).toBe('bld_team_key');
  });

  it('with a presence token the scope list comes from the presence endpoint, cached under the token', async () => {
    workspaceCheckout(dir, 'acme/widget', []);
    writeWorkspaceCache({ BUILDD_HOME: dir }, TOKEN, [], 0);
    login({ apiKey: 'bld_team_key', presenceToken: TOKEN, builddServer: 'https://b.test' });
    const urls: string[] = [];
    let auth: string | null = null;
    const fetchImpl = (async (url: string, init: any) => {
      urls.push(url);
      auth = init?.headers?.Authorization ?? null;
      return url.endsWith('/workspaces') ? Response.json({ workspaces: [{ repo: 'acme/widget' }] }) : Response.json({ ok: true });
    }) as any;
    const r = await run({ client: 'claude', stdin: JSON.stringify({ session_id: 'pt-1', cwd: dir, hook_event_name: 'SessionStart' }), env: { BUILDD_HOME: dir }, fetchImpl });
    expect(r.sent).toBe(true);
    expect(urls).toEqual(['https://b.test/api/workers/local-sessions/workspaces', 'https://b.test/api/workers/local-sessions']);
    expect(auth).toBe(`Bearer ${TOKEN}`);
    expect(readWorkspaceCache({ BUILDD_HOME: dir }, TOKEN)?.repos).toEqual(['acme/widget']);
  });
});

describe('session usage', () => {
  // Synthetic transcript lines in the shape Claude Code writes: one record per
  // content block, so a message id can repeat with the same usage. Content is
  // filled with text that must never reach the request body.
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'buildd-usage-')); workspaceCheckout(dir); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const SECRET = 'TOP-SECRET-CONTENT';
  const rec = (o: { id: string; model?: string; at: string; input?: number; read?: number; w5m?: number; w1h?: number; out?: number; blocks?: string[]; agentId?: string }) => JSON.stringify({
    type: 'assistant', timestamp: o.at, requestId: `req_${o.id}`, isSidechain: !!o.agentId, ...(o.agentId ? { agentId: o.agentId } : {}),
    message: {
      id: o.id, model: o.model ?? 'claude-sonnet-5', role: 'assistant',
      content: (o.blocks ?? ['text']).map((t, i) => t.startsWith('tool_use')
        ? { type: 'tool_use', id: `toolu_${o.id}_${i}`, name: t.split(':')[1] ?? 'Bash', input: { command: SECRET } }
        : { type: 'text', text: SECRET }),
      usage: {
        input_tokens: o.input ?? 2, cache_read_input_tokens: o.read ?? 0, output_tokens: o.out ?? 10,
        cache_creation_input_tokens: (o.w5m ?? 0) + (o.w1h ?? 0),
        cache_creation: { ephemeral_5m_input_tokens: o.w5m ?? 0, ephemeral_1h_input_tokens: o.w1h ?? 0 },
      },
    },
  });
  const user = (at: string) => JSON.stringify({ type: 'user', timestamp: at, message: { role: 'user', content: SECRET } });
  const W1 = '11111111-2222-4333-8444-0000000000a1';
  const W2 = '11111111-2222-4333-8444-0000000000a2';
  const env = () => ({ BUILDD_API_KEY: 'bld_test', BUILDD_SERVER: 'http://127.0.0.1:9', BUILDD_HOME: dir });
  const transcript = () => join(dir, 'sess.jsonl');
  const subagentFile = (agentId: string) => join(dir, 'sess', 'subagents', `agent-${agentId}.jsonl`);
  const write = (path: string, lines: string[]) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, lines.map(l => l + '\n').join(''), { flag: 'a' }); };
  const ev = (hook_event_name: string, extra: object = {}) => JSON.stringify({ session_id: 'u-1', cwd: dir, transcript_path: transcript(), hook_event_name, ...extra });
  const claimText = (w: string) => [{ type: 'text', text: `Claimed 1 task(s):\n\n**Worker ID:** ${w}\n**Task:** x` }];
  let bodies: any[];
  const fetchImpl = (async (url: string, init: any) => {
    if (url.endsWith('/local-sessions')) bodies.push(JSON.parse(init.body));
    return Response.json({ ok: true });
  }) as any;
  beforeEach(() => { bodies = []; });
  const claim = async (w: string, agentId?: string, now = Date.parse('2026-10-07T12:00:00Z')) => run({
    client: 'claude', env: env(), fetchImpl, now,
    stdin: ev('PostToolUse', { ...(agentId ? { agent_id: agentId, agent_type: 'general-purpose' } : {}), tool_name: 'mcp__buildd__buildd', tool_input: { action: 'claim_task', params: {} }, tool_response: claimText(w) }),
  });
  const stop = (now: number) => run({ client: 'claude', env: env(), fetchImpl, now, stdin: ev('Stop') });

  it('reads only usage numbers, dedupes repeated message records, and counts usage from the claim on', async () => {
    write(transcript(), [
      rec({ id: 'msg_before', at: '2026-10-07T11:59:00Z', input: 999, out: 999 }), // before the claim: not this task's
      user('2026-10-07T12:00:30Z'),
      rec({ id: 'msg_a', at: '2026-10-07T12:01:00Z', input: 3, read: 1000, w5m: 200, out: 40, blocks: ['text'] }),
      rec({ id: 'msg_a', at: '2026-10-07T12:01:00Z', input: 3, read: 1000, w5m: 200, out: 40, blocks: ['tool_use'] }),
      rec({ id: 'msg_b', at: '2026-10-07T12:02:00Z', input: 1, read: 1200, w1h: 50, out: 20, blocks: ['tool_use'] }),
      '{not json',
    ]);
    await claim(W1);
    await stop(Date.parse('2026-10-07T12:03:00Z'));
    const body = bodies.at(-1);
    expect(body.event).toBe('touch');
    // How it was charged rides along as one word (hook-cost-basis.test.ts).
    expect(['real', 'virtual', 'unknown']).toContain(body.usage.costBasis);
    expect(body.usage.workers).toEqual([{
      workerId: W1,
      models: [{ model: 'claude-sonnet-5', input: 4, cacheRead: 2200, cacheWrite5m: 200, cacheWrite1h: 50, output: 60, requests: 2 }],
      toolCalls: 2, toolCounts: { Bash: 2 }, subagents: 0, firstAt: '2026-10-07T12:01:00.000Z', lastAt: '2026-10-07T12:02:00.000Z',
    }]);
    expect(JSON.stringify(bodies)).not.toContain(SECRET);
  });

  it('counts tool calls by tool name, once per tool_use block even when Claude Code repeats the record', async () => {
    // Real Claude Code transcripts write one assistant record per content block,
    // each with the API message id; a tool_use block has its own id.
    const call = (id: string, at: string, name: string) => rec({ id, at, blocks: [`tool_use:${name}`] });
    write(transcript(), [
      call('m1', '2026-10-07T12:01:00Z', 'mcp__buildd__buildd'),
      call('m1', '2026-10-07T12:01:00Z', 'mcp__buildd__buildd'), // the same record again: same tool_use id
      call('m2', '2026-10-07T12:01:30Z', 'Bash'),
      call('m3', '2026-10-07T12:01:40Z', 'mcp__buildd__buildd'),
      rec({ id: 'm4', at: '2026-10-07T12:01:50Z', blocks: ['text'] }),
    ]);
    await claim(W1);
    await stop(Date.parse('2026-10-07T12:03:00Z'));
    const w = bodies.at(-1).usage.workers[0];
    expect(w.toolCalls).toBe(3);
    expect(w.toolCounts).toEqual({ mcp__buildd__buildd: 2, Bash: 1 });
    expect(w.models[0].requests).toBe(4);
  });

  it('a tool name the contract would refuse is counted under "other", never sent raw', async () => {
    write(transcript(), [rec({ id: 'm1', at: '2026-10-07T12:01:00Z', blocks: ['tool_use:rm -rf /; echo'] })]);
    await claim(W1);
    await stop(Date.parse('2026-10-07T12:02:00Z'));
    expect(bodies.at(-1).usage.workers[0].toolCounts).toEqual({ other: 1 });
  });

  it('sends cumulative totals, reading only new bytes since the last report', async () => {
    write(transcript(), [rec({ id: 'm1', at: '2026-10-07T12:01:00Z', out: 10 })]);
    await claim(W1);
    await stop(Date.parse('2026-10-07T12:02:00Z'));
    write(transcript(), [rec({ id: 'm2', at: '2026-10-07T12:05:00Z', out: 5 })]);
    await stop(Date.parse('2026-10-07T12:06:00Z'));
    const last = bodies.at(-1).usage.workers[0];
    expect(last.models[0]).toMatchObject({ output: 15, requests: 2 });
    // A replayed Stop with nothing new resends the same totals (the server only ever raises them).
    await stop(Date.parse('2026-10-07T12:08:00Z'));
    expect(bodies.at(-1).usage.workers[0].models[0]).toMatchObject({ output: 15, requests: 2 });
  });

  it("a subagent's usage goes to the task that subagent claimed; the parent's to the session's own claim", async () => {
    write(transcript(), [rec({ id: 'p1', at: '2026-10-07T12:01:00Z', out: 7 })]);
    write(subagentFile('aSub1'), [rec({ id: 's1', at: '2026-10-07T11:59:30Z', out: 100, agentId: 'aSub1', blocks: ['tool_use'] })]);
    write(subagentFile('aIdle'), [rec({ id: 'i1', at: '2026-10-07T12:01:30Z', out: 1, agentId: 'aIdle' })]);
    await claim(W1);
    await claim(W2, 'aSub1');
    await stop(Date.parse('2026-10-07T12:03:00Z'));
    const byWorker = Object.fromEntries(bodies.at(-1).usage.workers.map((w: any) => [w.workerId, w]));
    // The subagent's whole run is its task's, even the call before its claim landed.
    expect(byWorker[W2].models[0]).toMatchObject({ output: 100, requests: 1 });
    expect(byWorker[W2]).toMatchObject({ toolCalls: 1, toolCounts: { Bash: 1 }, subagents: 1 });
    // A subagent that claimed nothing counts toward the session's own claim.
    expect(byWorker[W1].models[0]).toMatchObject({ output: 8, requests: 2 });
    expect(byWorker[W1].subagents).toBe(1);
  });

  it('nothing is read or sent without a claim, on start, or with BUILDD_HOOK_USAGE=0', async () => {
    write(transcript(), [rec({ id: 'm1', at: '2026-10-07T12:01:00Z' })]);
    await stop(Date.parse('2026-10-07T12:03:00Z'));
    expect(bodies.at(-1).usage).toBeUndefined();
    await claim(W1);
    await run({ client: 'claude', env: { ...env(), BUILDD_HOOK_USAGE: '0' }, fetchImpl, now: Date.parse('2026-10-07T12:09:00Z'), stdin: ev('Stop') });
    expect(bodies.at(-1).usage).toBeUndefined();
  });

  it('end carries the final usage in the same request', async () => {
    write(transcript(), [rec({ id: 'm1', at: '2026-10-07T12:01:00Z', out: 3 })]);
    await claim(W1);
    await run({ client: 'claude', env: env(), fetchImpl, now: Date.parse('2026-10-07T12:02:00Z'), stdin: ev('SessionEnd', { reason: 'prompt_input_exit' }) });
    expect(bodies.at(-1)).toMatchObject({ event: 'end', reason: 'exit', usage: { workers: [{ workerId: W1 }] } });
  });

  it('a model id the contract would refuse is reported as unknown, and synthetic local records are skipped', async () => {
    write(transcript(), [
      rec({ id: 'm1', at: '2026-10-07T12:01:00Z', model: 'weird model id; drop table', out: 4 }),
      rec({ id: 'm2', at: '2026-10-07T12:01:10Z', model: '<synthetic>', out: 0, input: 0 }),
    ]);
    await claim(W1);
    await stop(Date.parse('2026-10-07T12:02:00Z'));
    expect(bodies.at(-1).usage.workers[0].models).toEqual([expect.objectContaining({ model: 'unknown', output: 4, requests: 1 })]);
  });
});

describe('fail open', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'buildd-hook-')); workspaceCheckout(dir); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const env = () => ({ BUILDD_API_KEY: 'bld_test', BUILDD_SERVER: 'http://127.0.0.1:9', BUILDD_HOME: dir });
  // Built per test: `dir` is only assigned in beforeEach.
  const startEv = () => JSON.stringify({ session_id: 's', cwd: dir, hook_event_name: 'SessionStart' });

  it('a thrown fetch, a 500 and a timeout all resolve without throwing', async () => {
    for (const fetchImpl of [
      async () => { throw new Error('ECONNREFUSED'); },
      async () => new Response('boom', { status: 500 }),
      async () => { throw new DOMException('timed out', 'TimeoutError'); },
    ]) {
      const r = await run({ client: 'claude', stdin: startEv(), env: env(), fetchImpl: fetchImpl as any });
      expect(r.sent).toBe(true);
      expect(r.ok).toBe(false);
    }
  });

  it('no key, bad JSON or disabled: nothing is sent', async () => {
    let called = 0;
    const fetchImpl = (async () => { called++; return new Response('{}'); }) as any;
    expect((await run({ client: 'claude', stdin: startEv(), env: { BUILDD_HOME: dir }, fetchImpl })).why).toBe('no_key');
    expect((await run({ client: 'claude', stdin: '{not json', env: env(), fetchImpl })).why).toBe('bad_payload');
    expect((await run({ client: 'claude', stdin: startEv(), env: { ...env(), BUILDD_HOOKS_DISABLED: '1' }, fetchImpl })).why).toBe('disabled');
    expect(called).toBe(0);
  });

  it('sends the contract body with the bearer key to the presence endpoint', async () => {
    let seen: { url: string; init: any } | null = null;
    const fetchImpl = (async (url: string, init: any) => { seen = { url, init }; return new Response(JSON.stringify({ ok: true, pendingInstructions: false })); }) as any;
    const r = await run({ client: 'claude', stdin: startEv(), env: env(), fetchImpl });
    expect(r.ok).toBe(true);
    expect(seen!.url).toBe('http://127.0.0.1:9/api/workers/local-sessions');
    expect(seen!.init.headers.Authorization).toBe('Bearer bld_test');
    expect(JSON.parse(seen!.init.body)).toMatchObject({ event: 'start', client: 'claude', clientSessionId: 's' });
  });

  it('the real script exits 0 with buildd unreachable, fast, printing nothing', () => {
    const t0 = Date.now();
    const p = Bun.spawnSync(['node', SCRIPT, 'claude'], {
      stdin: Buffer.from(startEv()),
      env: { PATH: process.env.PATH ?? '', HOME: dir, ...env() },
    });
    expect(p.exitCode).toBe(0);
    expect(p.stdout.toString()).toBe('');
    expect(Date.now() - t0).toBeLessThan(8_000);
  });

  it('the real script exits 0 on garbage input and an unknown client', () => {
    for (const [args, input] of [[['claude'], 'garbage'], [['vim'], startEv()], [[], startEv()]] as const) {
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

  /** Logged in as `buildd login` leaves it, against a fake server listing `repos` as workspaces. */
  const login = (repos: string[] = ['acme/widget']) => {
    mkdirSync(join(home, '.buildd'), { recursive: true });
    writeFileSync(join(home, '.buildd', 'config.json'), JSON.stringify({ apiKey: 'bld_test', builddServer: 'https://b.test' }));
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return Response.json({ workspaces: repos.map((r, i) => ({ id: `ws-${i + 1}-${r.replace('/', '-')}`, repo: `https://github.com/${r}` })) });
    }) as any;
    // The runner home is the test's own temp dir, never ~/.buildd (buildd-home.ts refuses that in tests).
    return { fetchImpl, urls, env: { BUILDD_HOME: join(home, '.buildd') } as Record<string, string | undefined> };
  };
  const checkout = (path: string, repo: string) => {
    mkdirSync(path, { recursive: true });
    Bun.spawnSync(['git', 'init', '-q', path]);
    Bun.spawnSync(['git', '-C', path, 'remote', 'add', 'origin', `git@github.com:${repo}.git`]);
  };

  it('CLI: detects clients, refuses unknown options, needs a repo for project scope', async () => {
    expect('error' in parseCliArgs(['--client=vim'])).toBe(true);
    expect('error' in parseCliArgs(['--force'])).toBe(true);
    expect('error' in parseCliArgs(['--everywhere'])).toBe(true);
    expect('error' in parseCliArgs(['--global', '--here'])).toBe(true);
    expect(parseCliArgs(['--uninstall', '--global', '--client=claude'])).toEqual({ mode: 'uninstall', scope: 'global', clients: ['claude'], mcp: null, oauth: false });
    expect(parseCliArgs(['--global'])).toMatchObject({ mcp: 'workspaces' });
    expect(parseCliArgs(['--global', '--everywhere'])).toMatchObject({ mcp: 'everywhere' });
    expect((await runCli([], { home, cwd: project })).code).toBe(1);
    const l = login();
    const none = await runCli(['--global'], { home, cwd: project, runtime: '/usr/bin/node', ...l });
    expect(none.lines.join('\n')).toContain('No supported coding client');
    mkdirSync(join(home, '.codex'));
    const one = await runCli(['--global'], { home, cwd: project, runtime: '/usr/bin/node', ...l });
    expect(one.code).toBe(0);
    expect(one.lines.join('\n')).toContain('/hooks');
    expect(existsSync(join(home, '.codex', 'hooks.json'))).toBe(true);
    expect(existsSync(join(home, '.claude'))).toBe(false);
  });

  it('--global registers the MCP server only for workspace folders, and says so', async () => {
    const ws = join(home, 'code', 'widget');
    const wt = join(home, 'code', 'widget-wt');
    const other = join(home, 'code', 'side-project');
    checkout(ws, 'acme/widget');
    checkout(wt, 'acme/widget');
    checkout(other, 'me/side-project');
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude.json'), JSON.stringify({
      theme: 'dark',
      mcpServers: { buildd: { type: 'http', url: 'https://b.test/api/mcp', headers: {} }, other: { command: 'x' } },
      projects: { [ws]: { allowedTools: ['Bash'] }, [wt]: {}, [other]: { mcpServers: { mine: { command: 'y' } } }, [join(home, 'gone')]: {} },
    }));
    const l = login(['acme/widget']);
    const r = await runCli(['--global'], { home, cwd: home, runtime: '/usr/bin/node', ...l });
    expect(r.code).toBe(0);

    const cfg = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
    const entry = { type: 'http', url: 'https://b.test/api/mcp', headers: { Authorization: 'Bearer bld_test' } };
    expect(cfg.projects[ws]).toEqual({ allowedTools: ['Bash'], mcpServers: { buildd: entry } });
    expect(cfg.projects[wt].mcpServers.buildd).toEqual(entry);
    expect(cfg.projects[other].mcpServers).toEqual({ mine: { command: 'y' } });
    // The old every-session entry is gone; anything else the user had stays.
    expect(cfg.mcpServers).toEqual({ other: { command: 'x' } });
    expect(cfg.theme).toBe('dark');
    expect(statSync(join(home, '.claude.json')).mode & 0o777).toBe(0o600);

    const out = r.lines.join('\n');
    expect(out).toContain('registered for your workspace folders only (2)');
    expect(out).toContain('~/code/widget  ');
    expect(out).toContain('Removed the old every-session entry');
    expect(out).toContain('buildd install --here');
    expect(out).toContain('only for sessions in your workspace repos (1): acme/widget, and in repos');
    expect(out).not.toContain('bld_test');
    // The hooks read the same list.
    expect(readWorkspaceCache({ BUILDD_HOME: join(home, '.buildd') }, 'bld_test')?.repos).toEqual(['acme/widget']);
    expect(l.urls).toEqual(['https://b.test/api/workspaces']);
  });

  it('a folder whose own .mcp.json already names buildd is listed and left alone, so it keeps working', async () => {
    const own = join(home, 'code', 'self-configured');
    checkout(own, 'other-team/repo');
    writeFileSync(join(own, '.mcp.json'), JSON.stringify({ mcpServers: { buildd: { type: 'http', url: 'https://b.test/api/mcp', headers: { Authorization: 'Bearer ${BUILDD_API_KEY}' } } } }));
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: { [own]: {} } }));
    const l = login(['acme/widget']);
    const r = await runCli(['--global', '--client=claude'], { home, cwd: home, runtime: '/usr/bin/node', ...l });
    expect(r.lines.join('\n')).toContain('(its own .mcp.json)');
    expect(JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')).projects[own]).toEqual({});
  });

  it('--here registers this folder even when it is not a workspace yet; --everywhere keeps the user-wide entry', async () => {
    const fresh = join(home, 'new-idea');
    mkdirSync(fresh, { recursive: true });
    const l = login([]);
    const here = await runCli(['--here'], { home, cwd: fresh, ...l });
    expect(here.code).toBe(0);
    expect(here.lines.join('\n')).toContain('registered for this folder, ~/new-idea');
    expect(JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')).projects[fresh].mcpServers.buildd.url).toBe('https://b.test/api/mcp');
    expect(existsSync(join(fresh, '.claude'))).toBe(false); // --here touches the MCP entry only

    const all = await runCli(['--global', '--everywhere'], { home, cwd: home, runtime: '/usr/bin/node', ...l });
    expect(all.lines.join('\n')).toContain('registered for every Claude Code session');
    expect(JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')).mcpServers.buildd.url).toBe('https://b.test/api/mcp');
  });

  it('--oauth points each workspace folder at its own OAuth endpoint and writes no key anywhere', async () => {
    const ws = join(home, 'code', 'widget');
    const api = join(home, 'code', 'api');
    const own = join(home, 'code', 'self-configured');
    checkout(ws, 'acme/widget');
    checkout(api, 'acme/api');
    checkout(own, 'acme/own');
    writeFileSync(join(own, '.mcp.json'), JSON.stringify({ mcpServers: { buildd: { type: 'http', url: 'https://b.test/api/mcp', headers: { Authorization: 'Bearer ${BUILDD_API_KEY}' } } } }));
    // A key entry an earlier install wrote, and a user-wide one: both go.
    writeFileSync(join(home, '.claude.json'), JSON.stringify({
      mcpServers: { buildd: { type: 'http', url: 'https://b.test/api/mcp', headers: { Authorization: 'Bearer bld_old' } } },
      projects: { [ws]: { mcpServers: { buildd: { type: 'http', url: 'https://b.test/api/mcp', headers: { Authorization: 'Bearer bld_old' } } } }, [api]: {}, [own]: {} },
    }));
    const l = login(['acme/widget', 'acme/api', 'acme/own']);
    const r = await runCli(['--global', '--oauth', '--client=claude'], { home, cwd: home, runtime: '/usr/bin/node', ...l });
    expect(r.code).toBe(0);

    const raw = readFileSync(join(home, '.claude.json'), 'utf8');
    expect(raw).not.toContain('bld_');
    expect(raw).not.toContain('Authorization');
    const cfg = JSON.parse(raw);
    // The workspace id comes from the list, matched by repo.
    expect(cfg.projects[ws].mcpServers.buildd).toEqual({ type: 'http', url: 'https://b.test/api/mcp-oauth/ws-1-acme-widget' });
    expect(cfg.projects[api].mcpServers.buildd).toEqual({ type: 'http', url: 'https://b.test/api/mcp-oauth/ws-2-acme-api' });
    expect(cfg.projects[own]).toEqual({});
    expect(cfg.mcpServers.buildd).toBeUndefined();

    const out = r.lines.join('\n');
    expect(out).toContain('signing in with OAuth');
    expect(out).toMatch(/~\/code\/widget\s+acme\/widget\s+browser sign-in on first use/);
    expect(out).toMatch(/~\/code\/api\s+acme\/api\s+browser sign-in on first use/);
    expect(out).toContain('(its own .mcp.json)');
  });

  it('--here --oauth uses OAuth for a workspace folder, and the key for a folder that is not one yet', async () => {
    const ws = join(home, 'code', 'widget');
    const fresh = join(home, 'new-idea');
    checkout(ws, 'acme/widget');
    mkdirSync(fresh, { recursive: true });
    const l = login(['acme/widget']);
    const a = await runCli(['--here', '--oauth'], { home, cwd: ws, ...l });
    expect(a.lines.join('\n')).toContain('browser sign-in on first use');
    const b = await runCli(['--here', '--oauth'], { home, cwd: fresh, ...l });
    expect(b.code).toBe(0);
    expect(b.lines.join('\n')).toContain('not a workspace yet');
    const cfg = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
    expect(cfg.projects[ws].mcpServers.buildd.url).toBe('https://b.test/api/mcp-oauth/ws-1-acme-widget');
    expect(cfg.projects[fresh].mcpServers.buildd.headers.Authorization).toBe('Bearer bld_test');
    expect('error' in parseCliArgs(['--global', '--everywhere', '--oauth'])).toBe(true);
    expect('error' in parseCliArgs(['--oauth'])).toBe(true);
  });

  it("--status --global lists each folder's buildd MCP entry as key or OAuth, without the network", async () => {
    const ws = join(home, 'code', 'widget');
    const api = join(home, 'code', 'api');
    writeFileSync(join(home, '.claude.json'), JSON.stringify({
      mcpServers: { buildd: { type: 'http', url: 'https://b.test/api/mcp', headers: { Authorization: 'Bearer bld_x' } } },
      projects: {
        [ws]: { mcpServers: { buildd: { type: 'http', url: 'https://b.test/api/mcp-oauth/ws-1' } } },
        [api]: { mcpServers: { buildd: { type: 'http', url: 'https://b.test/api/mcp', headers: { Authorization: 'Bearer bld_x' } } } },
        [join(home, 'other')]: { mcpServers: { mine: { command: 'y' } } },
      },
    }));
    const offline = (async () => { throw new Error('status must not call the network'); }) as any;
    const r = await runCli(['--status', '--global', '--client=claude'], { home, cwd: home, fetchImpl: offline, env: { BUILDD_HOME: join(home, '.buildd') } });
    const out = r.lines.join('\n');
    expect(out).toMatch(/~\/code\/widget\s+OAuth/);
    expect(out).toMatch(/~\/code\/api\s+key/);
    expect(out).toMatch(/every session\s+key/);
    expect(out).not.toContain('~/other');
    expect(out).not.toContain('bld_x');
  });

  /**
   * Two teams on one machine: the login key reaches team A's workspaces only;
   * the person's presence token reaches A and B (the scope route, with ids).
   */
  const PT = 'bldp_eyJ0IjoieCIsInUiOiJ5In0.sig';
  const loginTwoTeams = (keyRepos: string[], personRepos: Array<[repo: string, team: string]>) => {
    mkdirSync(join(home, '.buildd'), { recursive: true });
    writeFileSync(join(home, '.buildd', 'config.json'), JSON.stringify({ apiKey: 'bld_test', presenceToken: PT, builddServer: 'https://b.test' }));
    const id = (r: string) => `ws-${r.replace('/', '-')}`;
    const urls: string[] = [];
    const fetchImpl = (async (url: string, init: any) => {
      urls.push(url);
      const auth = init?.headers?.Authorization;
      if (url.endsWith('/api/workers/local-sessions/workspaces')) {
        if (auth !== `Bearer ${PT}`) return new Response('{}', { status: 401 });
        return Response.json({ workspaces: personRepos.map(([r, teamId]) => ({ id: id(r), repo: r, teamId })) });
      }
      if (auth !== 'Bearer bld_test') return new Response('{}', { status: 401 });
      return Response.json({ workspaces: keyRepos.map(r => ({ id: id(r), repo: `https://github.com/${r}` })) });
    }) as any;
    return { fetchImpl, urls, env: { BUILDD_HOME: join(home, '.buildd') } as Record<string, string | undefined> };
  };
  const oauthTo = (r: string) => ({ type: 'http', url: `https://b.test/api/mcp-oauth/ws-${r.replace('/', '-')}` });
  const keyEntry = { type: 'http', url: 'https://b.test/api/mcp', headers: { Authorization: 'Bearer bld_test' } };

  it("--global covers every team the person is in: another team's workspace folders sign in with OAuth, never with the login key", async () => {
    const a = join(home, 'code', 'widget');
    const b = join(home, 'code', 'api');
    checkout(a, 'acme/widget');
    checkout(b, 'beta/api');
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: { [a]: {}, [b]: {} } }));
    const l = loginTwoTeams(['acme/widget'], [['acme/widget', 'team-a'], ['beta/api', 'team-b']]);
    const r = await runCli(['--global', '--client=claude'], { home, cwd: home, runtime: '/usr/bin/node', ...l });
    expect(r.code).toBe(0);
    const cfg = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
    expect(cfg.projects[a].mcpServers.buildd).toEqual(keyEntry);
    expect(cfg.projects[b].mcpServers.buildd).toEqual(oauthTo('beta/api'));
    expect(JSON.stringify(cfg.projects[b])).not.toContain('bld_');
    const out = r.lines.join('\n');
    expect(out).toContain('registered for your workspace folders only (2)');
    expect(out).toMatch(/~\/code\/api\s+beta\/api\s+OAuth: your login key's team can't reach it/);
    expect(out).toMatch(/~\/code\/widget\s+acme\/widget\n/);
    expect(out).not.toContain('Run buildd login again');
    expect(out).toContain('your workspace repos (2): acme/widget, beta/api');
    expect(l.urls.sort()).toEqual(['https://b.test/api/workers/local-sessions/workspaces', 'https://b.test/api/workspaces']);
  });

  it("repairs a key entry whose team can't reach the folder's workspace, also where it shadows the folder's own .mcp.json", async () => {
    const b = join(home, 'code', 'api');
    const c = join(home, 'code', 'web');
    const d = join(home, 'code', 'docs');
    checkout(b, 'beta/api');
    checkout(c, 'beta/web');
    checkout(d, 'beta/docs');
    const own = JSON.stringify({ mcpServers: { buildd: { type: 'http', url: 'https://b.test/api/mcp', headers: { Authorization: 'Bearer ${BUILDD_API_KEY}' } } } });
    writeFileSync(join(c, '.mcp.json'), own);
    writeFileSync(join(d, '.mcp.json'), own);
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: {
      [b]: { mcpServers: { buildd: keyEntry } },
      [c]: { allowedTools: ['Bash'], mcpServers: { buildd: keyEntry, mine: { command: 'y' } } },
      [d]: {},
    } }));
    const l = loginTwoTeams(['acme/widget'], [['acme/widget', 'team-a'], ['beta/api', 'team-b'], ['beta/web', 'team-b'], ['beta/docs', 'team-b']]);
    const r = await runCli(['--global', '--client=claude'], { home, cwd: home, runtime: '/usr/bin/node', ...l });
    expect(r.code).toBe(0);
    const cfg = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
    expect(cfg.projects[b].mcpServers.buildd).toEqual(oauthTo('beta/api'));
    // The shadowing local entry is replaced; the folder's other servers and settings stay.
    expect(cfg.projects[c]).toEqual({ allowedTools: ['Bash'], mcpServers: { buildd: oauthTo('beta/web'), mine: { command: 'y' } } });
    // A folder that relies on its own .mcp.json, with nothing shadowing it, is left alone.
    expect(cfg.projects[d]).toEqual({});
    const out = r.lines.join('\n');
    expect(out).toContain("Switched 2 folders from a key whose team can't reach their workspace to OAuth: ~/code/api, ~/code/web");
    expect(out).toMatch(/~\/code\/docs\s+beta\/docs\s+\(its own \.mcp\.json\)/);
  });

  it("--here in another team's workspace folder signs in with OAuth instead of using the login key", async () => {
    const b = join(home, 'code', 'api');
    checkout(b, 'beta/api');
    const l = loginTwoTeams(['acme/widget'], [['acme/widget', 'team-a'], ['beta/api', 'team-b']]);
    const r = await runCli(['--here'], { home, cwd: b, ...l });
    expect(r.code).toBe(0);
    expect(JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')).projects[b].mcpServers.buildd).toEqual(oauthTo('beta/api'));
    expect(r.lines.join('\n')).toContain("signing in with OAuth: your login key's team can't reach this workspace");
  });

  it("--status --global flags a key entry whose team can't reach the folder's workspace, from the cached lists, without the network", async () => {
    const a = join(home, 'code', 'widget');
    const b = join(home, 'code', 'api');
    checkout(a, 'acme/widget');
    checkout(b, 'beta/api');
    mkdirSync(join(home, '.buildd'), { recursive: true });
    writeFileSync(join(home, '.buildd', 'config.json'), JSON.stringify({ apiKey: 'bld_test', presenceToken: PT }));
    const env = { BUILDD_HOME: join(home, '.buildd') };
    writeWorkspaceCache(env, 'bld_test', ['acme/widget']);
    writeWorkspaceCache(env, PT, ['acme/widget', 'beta/api']);
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: { [a]: { mcpServers: { buildd: keyEntry } }, [b]: { mcpServers: { buildd: keyEntry } } } }));
    const offline = (async () => { throw new Error('status must not call the network'); }) as any;
    const r = await runCli(['--status', '--global', '--client=claude'], { home, cwd: home, fetchImpl: offline, env });
    const out = r.lines.join('\n');
    expect(out).toMatch(/~\/code\/api\s+key  its team can't reach beta\/api: run buildd install --global to switch it to OAuth/);
    expect(out).toMatch(/~\/code\/widget\s+key\n/);
    expect(out).not.toContain('bld_test');
  });

  it("without a presence token only the login key's team is covered, and install says how to include the rest", async () => {
    const a = join(home, 'code', 'widget');
    checkout(a, 'acme/widget');
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: { [a]: {} } }));
    const l = login(['acme/widget']);
    const r = await runCli(['--global', '--client=claude'], { home, cwd: home, runtime: '/usr/bin/node', ...l });
    expect(r.code).toBe(0);
    expect(r.lines.join('\n')).toContain("Only your login key's team is included. Run buildd login again to include every team you're in.");
    expect(l.urls).toEqual(['https://b.test/api/workspaces']);
  });

  it('changes nothing when not logged in or when the workspace list cannot be loaded', async () => {
    writeFileSync(join(home, '.claude.json'), '{"mcpServers":{}}');
    const notIn = await runCli(['--global'], { home, cwd: home, env: { BUILDD_HOME: join(home, '.buildd') } });
    expect(notIn.code).toBe(1);
    expect(notIn.lines[0]).toContain('buildd login');
    login();
    const down = await runCli(['--global'], { home, cwd: home, env: { BUILDD_HOME: join(home, '.buildd') }, fetchImpl: (async () => { throw new Error('offline'); }) as any });
    expect(down.code).toBe(1);
    expect(down.lines[0]).toContain('Nothing was changed');
    expect(readFileSync(join(home, '.claude.json'), 'utf8')).toBe('{"mcpServers":{}}');
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
