import { describe, expect, test } from 'bun:test';
import { AcpBridge, type RunnerPort, type WorkerActionName } from '../../src/acp/bridge';
import { MessageCursor, toolKind, toolTitle, replyRoute, waitingText } from '../../src/acp/translate';
import type { PublicWorker } from '../../src/public-worker';

function worker(over: Partial<PublicWorker> = {}): PublicWorker {
  return {
    id: 'w1',
    taskId: 't1',
    taskTitle: 'Fix the flaky test',
    status: 'working',
    worktreePath: '/repos/app/.buildd/worktrees/w1',
    lastActivity: Date.parse('2026-11-19T10:00:00Z'),
    messages: [],
    ...over,
  } as PublicWorker;
}

class FakeRunner implements RunnerPort {
  workers: PublicWorker[] = [];
  actions: Array<{ workerId: string; action: WorkerActionName; message?: string }> = [];
  private listeners = new Set<(w: PublicWorker) => void>();
  actResult = { status: 200, body: { ok: true } as unknown };

  async listWorkers() { return this.workers; }
  async act(workerId: string, action: WorkerActionName, message?: string) {
    this.actions.push({ workerId, action, ...(message === undefined ? {} : { message }) });
    return this.actResult;
  }
  subscribe(fn: (w: PublicWorker) => void) {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }
  push(w: PublicWorker) {
    this.workers = this.workers.map(x => (x.id === w.id ? w : x));
    for (const fn of this.listeners) fn(w);
  }
  get listenerCount() { return this.listeners.size; }
}

function setup(workers: PublicWorker[] = [worker()]) {
  const runner = new FakeRunner();
  runner.workers = workers;
  const updates: Array<{ sessionId: string; update: any }> = [];
  const bridge = new AcpBridge({
    runner,
    notify: (sessionId, update) => updates.push({ sessionId, update }),
    repoRootOf: async (p) => (p.startsWith('/repos/app') ? '/repos/app' : null),
    projectNamesOf: async (cwd) => (cwd.replace(/\\/g, '/').endsWith('/app') ? ['app', 'acme/app'] : []),
    version: '0.0.0-test',
    settleGraceMs: 50,
  });
  return { runner, bridge, updates };
}

const tick = () => new Promise(r => setTimeout(r, 0));
const kinds = (updates: Array<{ update: any }>) => updates.map(u => u.update.sessionUpdate);
const texts = (updates: Array<{ update: any }>) =>
  updates.filter(u => u.update.sessionUpdate === 'agent_message_chunk').map(u => u.update.content.text).join('\n');

describe('translate', () => {
  test('tool kinds follow the tool name', () => {
    expect(toolKind('Read')).toBe('read');
    expect(toolKind('Edit')).toBe('edit');
    expect(toolKind('Write')).toBe('edit');
    expect(toolKind('Grep')).toBe('search');
    expect(toolKind('Bash')).toBe('execute');
    expect(toolKind('WebFetch')).toBe('fetch');
    expect(toolKind('mcp__buildd__buildd_work')).toBe('other');
  });

  test('tool titles say what the call touched', () => {
    expect(toolTitle('Bash', { command: 'bun test', description: 'Run tests' })).toBe('Run tests');
    expect(toolTitle('Bash', { command: 'ls' })).toBe('ls');
    expect(toolTitle('Read', { file_path: '/a/b.ts' })).toBe('Read /a/b.ts');
    expect(toolTitle('Grep', { pattern: 'foo' })).toBe('Grep foo');
    expect(toolTitle('mcp__buildd__buildd_work', {})).toBe('buildd_work');
  });

  test('a cursor emits each message once, even after the 200-message window shifts', () => {
    const cursor = new MessageCursor();
    const a = { type: 'text' as const, content: 'hello', timestamp: 1 };
    const b = { type: 'tool_use' as const, name: 'Bash', input: { command: 'ls' }, timestamp: 2 };
    const first = cursor.next([a, b], { live: true });
    expect(first.map(u => u.sessionUpdate)).toEqual(['agent_message_chunk', 'tool_call']);
    expect(first[1]).toMatchObject({ status: 'in_progress', kind: 'execute', title: 'ls' });

    const c = { type: 'text' as const, content: 'done', timestamp: 3 };
    // the window dropped `a` — nothing is re-emitted, the open tool closes
    const second = cursor.next([b, c], { live: true });
    expect(second.map(u => u.sessionUpdate)).toEqual(['tool_call_update', 'agent_message_chunk']);
    expect(second[0]).toMatchObject({ toolCallId: first[1].toolCallId, status: 'completed' });
    expect(cursor.next([b, c], { live: true })).toEqual([]);
  });

  test('replayed history marks tools completed and keeps user turns', () => {
    const cursor = new MessageCursor();
    const out = cursor.next([
      { type: 'user', content: 'go', timestamp: 1 },
      { type: 'tool_use', name: 'Read', input: { file_path: '/x' }, timestamp: 2 },
    ], { live: false });
    expect(out.map(u => u.sessionUpdate)).toEqual(['user_message_chunk', 'tool_call']);
    expect(out[1]).toMatchObject({ status: 'completed' });
  });

  test('a reply goes to answer, message or follow-up by worker state', () => {
    expect(replyRoute(worker({ status: 'waiting' }))).toBe('answer');
    expect(replyRoute(worker({ status: 'working' }))).toBe('message');
    expect(replyRoute(worker({ status: 'done' }))).toBe('followup');
    expect(replyRoute(worker({ status: 'error' }))).toBe('followup');
  });

  test('a question shows its options', () => {
    const text = waitingText({ type: 'question', prompt: 'Which DB?', options: [{ label: 'Postgres', description: 'the default' }, { label: 'SQLite' }] });
    expect(text).toContain('Which DB?');
    expect(text).toContain('1. Postgres — the default');
    expect(text).toContain('2. SQLite');
  });
});

describe('AcpBridge', () => {
  test('initialize advertises load and list, nothing it cannot do', async () => {
    const { bridge } = setup();
    const res: any = await bridge.handle('initialize', { protocolVersion: 1, clientCapabilities: {} });
    expect(res.protocolVersion).toBe(1);
    expect(res.agentCapabilities.loadSession).toBe(true);
    expect(res.agentCapabilities.sessionCapabilities.list).toEqual({});
    expect(res.agentCapabilities.sessionCapabilities.resume).toBeUndefined();
    expect(res.agentInfo.name).toBe('buildd');
  });

  test('session/list keeps the workers whose worktree belongs to the project', async () => {
    const { bridge } = setup([
      worker({ id: 'w1' }),
      worker({ id: 'w2', worktreePath: '/elsewhere/w2', taskTitle: 'Other repo' }),
    ]);
    const res: any = await bridge.handle('session/list', { cwd: '/repos/app' });
    expect(res.sessions.map((s: any) => s.sessionId)).toEqual(['w1']);
    expect(res.sessions[0]).toMatchObject({ cwd: '/repos/app', title: 'Fix the flaky test', updatedAt: '2026-11-19T10:00:00.000Z' });
  });

  test('a worker with no path left (a finished run) matches by its workspace name', async () => {
    const { bridge } = setup([
      worker({ id: 'w1', worktreePath: undefined, workspaceName: 'App' }),
      worker({ id: 'w2', worktreePath: undefined, workspaceName: 'other' }),
    ]);
    // a Windows client (T3) talking to a runner in WSL hands over a Windows path
    const res: any = await bridge.handle('session/list', { cwd: 'C:\\code\\app' });
    expect(res.sessions.map((s: any) => s.sessionId)).toEqual(['w1']);
    expect(res.sessions[0].cwd).toBe('C:\\code\\app');
  });

  test('session/load replays history and states a pending question', async () => {
    const { bridge, updates } = setup([worker({
      status: 'waiting',
      waitingFor: { type: 'question', prompt: 'Ship it?' },
      messages: [
        { type: 'user', content: 'Fix it', timestamp: 1 },
        { type: 'text', content: 'Looking', timestamp: 2 },
        { type: 'tool_use', name: 'Bash', input: { command: 'bun test' }, timestamp: 3 },
      ],
    })]);
    await bridge.handle('session/load', { sessionId: 'w1', cwd: '/repos/app', mcpServers: [] });
    expect(kinds(updates)).toContain('user_message_chunk');
    expect(kinds(updates)).toContain('tool_call');
    expect(kinds(updates)).toContain('available_commands_update');
    expect(texts(updates)).toContain('Ship it?');
    expect(updates.every(u => u.sessionId === 'w1')).toBe(true);
  });

  test('session/load refuses a worker the runner does not have', async () => {
    const { bridge } = setup([]);
    await expect(bridge.handle('session/load', { sessionId: 'nope', cwd: '/repos/app', mcpServers: [] })).rejects.toThrow(/not on this runner/);
  });

  test('answering a waiting worker streams until it settles again', async () => {
    const { bridge, runner, updates } = setup([worker({ status: 'waiting', waitingFor: { type: 'question', prompt: 'Ship it?' } })]);
    await bridge.handle('session/load', { sessionId: 'w1', cwd: '/repos/app', mcpServers: [] });
    updates.length = 0;

    const turn = bridge.handle('session/prompt', { sessionId: 'w1', prompt: [{ type: 'text', text: 'yes' }] });
    await tick();
    expect(runner.actions).toEqual([{ workerId: 'w1', action: 'answer', message: 'yes' }]);

    runner.push(worker({ status: 'working', messages: [{ type: 'tool_use', name: 'Bash', input: { command: 'git push' }, timestamp: 10 }] }));
    runner.push(worker({ status: 'done', prUrl: 'https://github.com/o/r/pull/1', tokenTally: { inputTokens: 10, outputTokens: 5 }, messages: [
      { type: 'tool_use', name: 'Bash', input: { command: 'git push' }, timestamp: 10 },
      { type: 'text', content: 'Opened the PR', timestamp: 11 },
    ] }));

    const res: any = await turn;
    expect(res.stopReason).toBe('end_turn');
    expect(res.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    expect(kinds(updates)).toEqual(['tool_call', 'tool_call_update', 'agent_message_chunk', 'agent_message_chunk']);
    expect(texts(updates)).toContain('https://github.com/o/r/pull/1');
    expect(runner.listenerCount).toBe(0);
  });

  test('a reply to a running worker is a message, to a finished one a follow-up', async () => {
    const { bridge, runner } = setup([worker({ status: 'working' })]);
    const t1 = bridge.handle('session/prompt', { sessionId: 'w1', prompt: [{ type: 'text', text: 'also fix lint' }] });
    await tick();
    runner.push(worker({ status: 'done' }));
    await t1;
    const t2 = bridge.handle('session/prompt', { sessionId: 'w1', prompt: [{ type: 'text', text: 'one more thing' }] });
    await tick();
    runner.push(worker({ status: 'working' }));
    runner.push(worker({ status: 'done' }));
    await t2;
    expect(runner.actions.map(a => a.action)).toEqual(['message', 'followup']);
  });

  test('/watch sends nothing and follows the run', async () => {
    const { bridge, runner, updates } = setup([worker({ status: 'working' })]);
    const turn = bridge.handle('session/prompt', { sessionId: 'w1', prompt: [{ type: 'text', text: '/watch' }] });
    await tick();
    runner.push(worker({ status: 'working', messages: [{ type: 'text', content: 'step 1', timestamp: 5 }] }));
    runner.push(worker({ status: 'waiting', waitingFor: { type: 'question', prompt: 'Which branch?' }, messages: [{ type: 'text', content: 'step 1', timestamp: 5 }] }));
    const res: any = await turn;
    expect(runner.actions).toEqual([]);
    expect(res.stopReason).toBe('end_turn');
    expect(texts(updates)).toContain('step 1');
    expect(texts(updates)).toContain('Which branch?');
  });

  test('a refused reply ends the turn with the runner\'s reason', async () => {
    const { bridge, runner, updates } = setup([worker({ status: 'waiting', waitingFor: { type: 'question', prompt: '?' } })]);
    runner.actResult = { status: 409, body: { error: 'worker already answered' } };
    const res: any = await bridge.handle('session/prompt', { sessionId: 'w1', prompt: [{ type: 'text', text: 'yes' }] });
    expect(res.stopReason).toBe('end_turn');
    expect(texts(updates)).toContain('worker already answered');
    expect(runner.listenerCount).toBe(0);
  });

  test('a reply nobody picks up ends after the grace period', async () => {
    const { bridge, runner, updates } = setup([worker({ status: 'done' })]);
    const res: any = await bridge.handle('session/prompt', { sessionId: 'w1', prompt: [{ type: 'text', text: 'again' }] });
    expect(res.stopReason).toBe('end_turn');
    expect(texts(updates)).toMatch(/hasn't picked up/);
    expect(runner.listenerCount).toBe(0);
  });

  test('cancel pauses the worker and ends the turn as cancelled', async () => {
    const { bridge, runner } = setup([worker({ status: 'working' })]);
    const turn = bridge.handle('session/prompt', { sessionId: 'w1', prompt: [{ type: 'text', text: '/watch' }] });
    await tick();
    await bridge.handle('session/cancel', { sessionId: 'w1' });
    const res: any = await turn;
    expect(res.stopReason).toBe('cancelled');
    expect(runner.actions).toEqual([{ workerId: 'w1', action: 'pause' }]);
  });

  test('/stop stops the worker', async () => {
    const { bridge, runner } = setup([worker({ status: 'working' })]);
    await bridge.handle('session/prompt', { sessionId: 'w1', prompt: [{ type: 'text', text: '/stop' }] });
    expect(runner.actions).toEqual([{ workerId: 'w1', action: 'stop' }]);
  });

  test('a new thread is told how to open a buildd task, and nothing is sent', async () => {
    const { bridge, runner, updates } = setup();
    const { sessionId }: any = await bridge.handle('session/new', { cwd: '/repos/app', mcpServers: [] });
    const res: any = await bridge.handle('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'build a thing' }] });
    expect(res.stopReason).toBe('end_turn');
    expect(texts(updates)).toMatch(/List sessions/);
    expect(runner.actions).toEqual([]);
  });

  test('an unknown method is a JSON-RPC method-not-found', async () => {
    const { bridge } = setup();
    await expect(bridge.handle('session/fork', {})).rejects.toMatchObject({ code: -32601 });
  });
});
