import { describe, expect, test } from 'bun:test';
import { AcpBridge, type RunnerPort, type WorkerActionName } from '../../src/acp/bridge';
import { MessageCursor, toolKind, toolTitle, replyRoute, settledText, waitingText } from '../../src/acp/translate';
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

  workspaces: Array<{ id: string; name: string; repo?: string }> = [{ id: 'ws-app', name: 'app', repo: 'acme/app' }];
  created: Array<{ workspaceId: string; title: string; description: string }> = [];
  claimResult: { status: number; body: unknown } | null = null;

  async listWorkers() { return this.workers; }
  async act(workerId: string, action: WorkerActionName, message?: string) {
    this.actions.push({ workerId, action, ...(message === undefined ? {} : { message }) });
    return this.actResult;
  }
  async listWorkspaces() { return this.workspaces; }
  async createTask(input: { workspaceId: string; title: string; description: string }) {
    this.created.push(input);
    return { status: 200, body: { task: { id: `t${this.created.length}`, title: input.title } } };
  }
  async claim(taskId: string) {
    if (this.claimResult) return this.claimResult;
    const w = worker({ id: `w-${taskId}`, taskId, status: 'working', messages: [] });
    this.workers = [...this.workers, w];
    return { status: 200, body: { worker: w } };
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

function setup(
  workers: PublicWorker[] = [worker()],
  opts: { answer?: (params: any) => Promise<any>; links?: Map<string, string>; runner?: FakeRunner } = {},
) {
  const runner = opts.runner ?? new FakeRunner();
  runner.workers = workers;
  const updates: Array<{ sessionId: string; update: any }> = [];
  const requests: Array<{ method: string; params: any }> = [];
  const links = opts.links ?? new Map<string, string>();
  const bridge = new AcpBridge({
    runner,
    links: { get: (id) => links.get(id) ?? null, set: (id, workerId) => { links.set(id, workerId); } },
    notify: (sessionId, update) => updates.push({ sessionId, update }),
    request: async (method, params) => {
      requests.push({ method, params });
      if (!opts.answer) throw new Error('no client');
      return opts.answer(params);
    },
    repoRootOf: async (p) => (p.startsWith('/repos/app') ? '/repos/app' : null),
    projectNamesOf: async (cwd) => (cwd.replace(/\\/g, '/').endsWith('/app') ? ['app', 'acme/app'] : []),
    version: '0.0.0-test',
    settleGraceMs: 50,
  });
  return { runner, bridge, updates, requests, links };
}

const ELICITING_CLIENT = { protocolVersion: 1, clientCapabilities: { elicitation: { form: {} } } };
const question = (over: Record<string, unknown> = {}) => ({
  status: 'waiting' as const,
  waitingFor: { type: 'question' as const, prompt: 'Which DB?', options: [{ label: 'Postgres', description: 'the default' }, { label: 'SQLite' }], ...over },
});

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

  test('edits carry a diff and the file they touched', () => {
    const cursor = new MessageCursor();
    const [edit, write, read] = cursor.next([
      { type: 'tool_use', name: 'Edit', input: { file_path: '/r/a.ts', old_string: 'a', new_string: 'b' }, timestamp: 1 },
      { type: 'tool_use', name: 'Write', input: { file_path: '/r/b.ts', content: 'new file' }, timestamp: 2 },
      { type: 'tool_use', name: 'Read', input: { file_path: '/r/c.ts' }, timestamp: 3 },
    ], { live: false });
    expect(edit).toMatchObject({ locations: [{ path: '/r/a.ts' }], content: [{ type: 'diff', path: '/r/a.ts', oldText: 'a', newText: 'b' }] });
    expect(write).toMatchObject({ content: [{ type: 'diff', path: '/r/b.ts', oldText: null, newText: 'new file' }] });
    expect(read).toMatchObject({ locations: [{ path: '/r/c.ts' }] });
    expect(read.content).toBeUndefined();
  });

  test('an input cut down on disk (worker-store truncation) degrades to a plain titled call', () => {
    const [u] = new MessageCursor().next([{ type: 'tool_use', name: 'Edit', input: { _truncated: '{"file_path":"/r/a.ts","old_str' }, timestamp: 1 }], { live: false });
    expect(u).toMatchObject({ sessionUpdate: 'tool_call', title: 'Edit', kind: 'edit' });
    expect(u.content).toBeUndefined();
    expect(u.locations).toBeUndefined();
  });

  test('a MultiEdit is one diff per edit', () => {
    const [u] = new MessageCursor().next([{ type: 'tool_use', name: 'MultiEdit', input: { file_path: '/r/a.ts', edits: [{ old_string: '1', new_string: '2' }, { old_string: '3', new_string: '4' }] }, timestamp: 1 }], { live: false });
    expect((u.content as any[]).map(c => [c.oldText, c.newText])).toEqual([['1', '2'], ['3', '4']]);
  });

  test('TodoWrite becomes the plan, not a tool call', () => {
    const out = new MessageCursor().next([{ type: 'tool_use', name: 'TodoWrite', input: { todos: [
      { content: 'Write the test', status: 'completed', activeForm: 'Writing the test' },
      { content: 'Fix it', status: 'in_progress', activeForm: 'Fixing it' },
    ] }, timestamp: 1 }], { live: true });
    expect(out).toEqual([{ sessionUpdate: 'plan', entries: [
      { content: 'Write the test', priority: 'medium', status: 'completed' },
      { content: 'Fix it', priority: 'medium', status: 'in_progress' },
    ] }]);
  });

  test('a question shows its options', () => {
    const text = waitingText({ type: 'question', prompt: 'Which DB?', options: [{ label: 'Postgres', description: 'the default' }, { label: 'SQLite' }] });
    expect(text).toContain('Which DB?');
    expect(text).toContain('1. Postgres — the default');
    expect(text).toContain('2. SQLite');
  });

  // A run that answers through complete_task leaves its answer only inside the
  // tool call; the closing line must carry it as text, or T3 shows "Finished."
  test('a finished run ends on its completion summary', () => {
    const summary = 'No secrets found: only .env.example templates with placeholder values.';
    const worker = { id: 'w1', status: 'done', messages: [
      { type: 'tool_use', name: 'Bash', input: { command: 'ls -a' }, timestamp: 1 },
      { type: 'tool_use', name: 'mcp__buildd__buildd_work', input: { action: 'complete_task', params: { summary } }, timestamp: 2 },
    ] } as unknown as PublicWorker;
    expect(settledText(worker)).toBe(`${summary}\n\nFinished.`);
  });

  test('the summary is read from a flat complete_task call too', () => {
    const worker = { id: 'w1', status: 'done', prUrl: 'https://example.test/pr/2', messages: [
      { type: 'tool_use', name: 'mcp__buildd__complete_task', input: { summary: 'Fixed it.' }, timestamp: 1 },
    ] } as unknown as PublicWorker;
    expect(settledText(worker)).toBe('Fixed it.\n\nFinished. PR: https://example.test/pr/2');
  });

  test('a summary the agent already said as text is not repeated', () => {
    const worker = { id: 'w1', status: 'done', messages: [
      { type: 'tool_use', name: 'mcp__buildd__buildd_work', input: { action: 'complete_task', params: { summary: 'Done.' } }, timestamp: 1 },
      { type: 'text', content: 'Done.', timestamp: 2 },
    ] } as unknown as PublicWorker;
    expect(settledText(worker)).toBe('Finished.');
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

  test('a new thread\'s first message becomes a buildd task on this runner, and the turn follows it', async () => {
    const { bridge, runner, updates } = setup([]);
    const { sessionId }: any = await bridge.handle('session/new', { cwd: '/repos/app', mcpServers: [] });
    const turn = bridge.handle('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Fix the login redirect\n\nIt loops on Safari.' }] });
    await tick(); await tick();
    expect(runner.created).toEqual([{ workspaceId: 'ws-app', title: 'Fix the login redirect', description: 'Fix the login redirect\n\nIt loops on Safari.' }]);
    expect(texts(updates)).toContain('Started a buildd task in app');

    runner.push(worker({ id: 'w-t1', taskId: 't1', status: 'working', messages: [{ type: 'text', content: 'On it', timestamp: 4 }] }));
    runner.push(worker({ id: 'w-t1', taskId: 't1', status: 'done', messages: [{ type: 'text', content: 'On it', timestamp: 4 }] }));
    const res: any = await turn;
    expect(res.stopReason).toBe('end_turn');
    expect(texts(updates)).toContain('On it');

    // the thread is that worker now: the next message is a follow-up, not a second task
    const next = bridge.handle('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'also Chrome' }] });
    await tick();
    runner.push(worker({ id: 'w-t1', status: 'working' }));
    runner.push(worker({ id: 'w-t1', status: 'done' }));
    await next;
    expect(runner.created).toHaveLength(1);
    expect(runner.actions).toEqual([{ workerId: 'w-t1', action: 'followup', message: 'also Chrome' }]);
  });

  test("T3 Code's envelope is unwrapped: the task, follow-ups and commands are what the user typed", async () => {
    // T3 wraps each message in its own instructions and runtime notes. Those are
    // for an agent running inside T3, not a buildd worker, and the first line of
    // the envelope made the task title "<t3_code_instructions>".
    const wrap = (req: string) => `<t3_code_instructions>
## T3 Code interaction mode: Default

Use delegate_task.
</t3_code_instructions>

<user_request>
${req}
</user_request>
<runtime_info>In case you're asked: you are running in T3 Code.</runtime_info>

<pull_request_linking>
Link each PR.
</pull_request_linking>`;
    const request = `Count open PRs

Only targeting dev.`;
    const { bridge, runner } = setup([]);
    const { sessionId }: any = await bridge.handle('session/new', { cwd: '/repos/app', mcpServers: [] });
    const turn = bridge.handle('session/prompt', { sessionId, prompt: [{ type: 'text', text: wrap(request) }] });
    await tick(); await tick();
    expect(runner.created).toEqual([{ workspaceId: 'ws-app', title: 'Count open PRs', description: request }]);
    runner.push(worker({ id: 'w-t1', taskId: 't1', status: 'done' }));
    await turn;

    const next = bridge.handle('session/prompt', { sessionId, prompt: [{ type: 'text', text: wrap('also drafts') }] });
    await tick();
    runner.push(worker({ id: 'w-t1', status: 'working' }));
    runner.push(worker({ id: 'w-t1', status: 'done' }));
    await next;
    expect(runner.actions).toEqual([{ workerId: 'w-t1', action: 'followup', message: 'also drafts' }]);

    await bridge.handle('session/prompt', { sessionId, prompt: [{ type: 'text', text: wrap('/stop') }] });
    expect(runner.actions.at(-1)).toEqual({ workerId: 'w-t1', action: 'stop' });
  });

  test('the thread-to-worker link survives a bridge restart, so a resent message never makes a second task', async () => {
    const links = new Map<string, string>();
    const first = setup([], { links });
    const { sessionId }: any = await first.bridge.handle('session/new', { cwd: '/repos/app', mcpServers: [] });
    const turn = first.bridge.handle('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Do it' }] });
    await tick(); await tick();
    first.runner.push(worker({ id: 'w-t1', status: 'done' }));
    await turn;

    // a fresh bridge process (T3 restarted its agent), same link store
    const second = setup(first.runner.workers, { links });
    await second.bridge.handle('session/load', { sessionId, cwd: '/repos/app', mcpServers: [] });
    const again = second.bridge.handle('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Do it' }] });
    await tick();
    second.runner.push(worker({ id: 'w-t1', status: 'working' }));
    second.runner.push(worker({ id: 'w-t1', status: 'done' }));
    await again;
    expect(second.runner.created).toEqual([]);
    expect(second.runner.actions.map(a => a.action)).toEqual(['followup']);
  });

  test('a project that matches no buildd workspace says so and creates nothing', async () => {
    const { bridge, runner, updates } = setup([]);
    const { sessionId }: any = await bridge.handle('session/new', { cwd: '/elsewhere/zzz', mcpServers: [] });
    const res: any = await bridge.handle('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Do it' }] });
    expect(res.stopReason).toBe('end_turn');
    expect(runner.created).toEqual([]);
    expect(texts(updates)).toMatch(/No buildd workspace/);
  });

  test('several matching workspaces: the client is asked which, and a client without forms is told to choose', async () => {
    const runner = new FakeRunner();
    runner.workspaces = [{ id: 'ws-a', name: 'app', repo: 'acme/app' }, { id: 'ws-b', name: 'app', repo: 'acme/app' }];
    const asked = setup([], { runner, answer: async (p) => ({ action: 'accept', content: { answer: p.requestedSchema.properties.answer.oneOf[1].const } }) });
    await asked.bridge.handle('initialize', ELICITING_CLIENT);
    const { sessionId }: any = await asked.bridge.handle('session/new', { cwd: '/repos/app', mcpServers: [] });
    const turn = asked.bridge.handle('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Do it' }] });
    await tick(); await tick(); await tick();
    expect(runner.created.map(c => c.workspaceId)).toEqual(['ws-b']);
    runner.push(worker({ id: 'w-t1', status: 'done' }));
    await turn;

    const plain = new FakeRunner();
    plain.workspaces = runner.workspaces;
    const told = setup([], { runner: plain });
    const s2: any = await told.bridge.handle('session/new', { cwd: '/repos/app', mcpServers: [] });
    await told.bridge.handle('session/prompt', { sessionId: s2.sessionId, prompt: [{ type: 'text', text: 'Do it' }] });
    expect(plain.created).toEqual([]);
    expect(texts(told.updates)).toMatch(/more than one buildd workspace/);
  });

  test('a task this runner cannot take stays queued, and the thread says why', async () => {
    const runner = new FakeRunner();
    runner.claimResult = { status: 400, body: { error: 'at max concurrent' } };
    const { bridge, updates } = setup([], { runner });
    const { sessionId }: any = await bridge.handle('session/new', { cwd: '/repos/app', mcpServers: [] });
    const res: any = await bridge.handle('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Do it' }] });
    expect(res.stopReason).toBe('end_turn');
    expect(runner.created).toHaveLength(1);
    expect(texts(updates)).toMatch(/queued.*at max concurrent/s);
  });

  test('a command in a thread with no task yet creates nothing', async () => {
    const { bridge, runner } = setup([]);
    const { sessionId }: any = await bridge.handle('session/new', { cwd: '/repos/app', mcpServers: [] });
    await bridge.handle('session/prompt', { sessionId, prompt: [{ type: 'text', text: '/watch' }] });
    expect(runner.created).toEqual([]);
  });

  test('a question mid-run is asked as a form, answered, and the run is followed on', async () => {
    const { bridge, runner, requests, updates } = setup([worker({ status: 'working' })], {
      answer: async () => ({ action: 'accept', content: { answer: 'SQLite' } }),
    });
    await bridge.handle('initialize', ELICITING_CLIENT);
    const turn = bridge.handle('session/prompt', { sessionId: 'w1', prompt: [{ type: 'text', text: '/watch' }] });
    await tick();
    runner.push(worker(question()));
    await tick(); await tick();
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe('elicitation/create');
    expect(requests[0].params).toMatchObject({
      sessionId: 'w1',
      mode: 'form',
      message: 'Which DB?',
      requestedSchema: { type: 'object', required: ['answer'], properties: { answer: { type: 'string', oneOf: [
        { const: 'Postgres', title: 'Postgres', description: 'the default' },
        { const: 'SQLite', title: 'SQLite' },
      ] } } },
    });
    expect(runner.actions).toEqual([{ workerId: 'w1', action: 'answer', message: 'SQLite' }]);

    runner.push(worker({ status: 'working', messages: [{ type: 'text', content: 'Using SQLite', timestamp: 9 }] }));
    runner.push(worker({ status: 'done', messages: [{ type: 'text', content: 'Using SQLite', timestamp: 9 }] }));
    const res: any = await turn;
    expect(res.stopReason).toBe('end_turn');
    expect(texts(updates)).toContain('Using SQLite');
    expect(texts(updates)).not.toContain('Reply here to answer');
  });

  test('a question with no options is a free-text field', async () => {
    const { bridge, runner, requests } = setup([worker({ status: 'working' })], {
      answer: async () => ({ action: 'accept', content: { answer: 'staging' } }),
    });
    await bridge.handle('initialize', ELICITING_CLIENT);
    const turn = bridge.handle('session/prompt', { sessionId: 'w1', prompt: [{ type: 'text', text: '/watch' }] });
    await tick();
    runner.push(worker(question({ prompt: 'Which branch?', options: undefined })));
    await tick(); await tick();
    expect(requests[0].params.requestedSchema.properties.answer).toEqual({ type: 'string', title: 'Which branch?' });
    expect(runner.actions).toEqual([{ workerId: 'w1', action: 'answer', message: 'staging' }]);
    runner.push(worker({ status: 'done' }));
    await turn;
  });

  test('a permission request is a form too, never an auto-approvable permission request', async () => {
    const { bridge, runner, requests } = setup([worker({ status: 'working' })], {
      answer: async () => ({ action: 'accept', content: { answer: 'Deny' } }),
    });
    await bridge.handle('initialize', ELICITING_CLIENT);
    const turn = bridge.handle('session/prompt', { sessionId: 'w1', prompt: [{ type: 'text', text: '/watch' }] });
    await tick();
    runner.push(worker({ status: 'waiting', waitingFor: { type: 'permission', prompt: 'Permission required for Bash: rm -rf dist', options: [{ label: 'Allow once' }, { label: 'Deny' }] } }));
    await tick(); await tick();
    expect(requests.map(r => r.method)).toEqual(['elicitation/create']);
    expect(runner.actions).toEqual([{ workerId: 'w1', action: 'answer', message: 'Deny' }]);
    runner.push(worker({ status: 'done' }));
    await turn;
  });

  test('declining the form ends the turn on the question, so a typed reply still answers it', async () => {
    const { bridge, runner, updates } = setup([worker({ status: 'working' })], {
      answer: async () => ({ action: 'decline' }),
    });
    await bridge.handle('initialize', ELICITING_CLIENT);
    const turn = bridge.handle('session/prompt', { sessionId: 'w1', prompt: [{ type: 'text', text: '/watch' }] });
    await tick();
    runner.push(worker(question()));
    const res: any = await turn;
    expect(res.stopReason).toBe('end_turn');
    expect(runner.actions).toEqual([]);
    expect(texts(updates)).toContain('Reply here to answer');
  });

  test('an answer that arrives after the question was settled elsewhere is dropped', async () => {
    let respond!: (v: any) => void;
    const { bridge, runner } = setup([worker({ status: 'working' })], {
      answer: () => new Promise(r => { respond = r; }),
    });
    await bridge.handle('initialize', ELICITING_CLIENT);
    const turn = bridge.handle('session/prompt', { sessionId: 'w1', prompt: [{ type: 'text', text: '/watch' }] });
    await tick();
    runner.push(worker(question()));
    await tick();
    // answered from the dashboard meanwhile: the run moved on
    runner.push(worker({ status: 'working' }));
    respond({ action: 'accept', content: { answer: 'Postgres' } });
    await tick(); await tick();
    expect(runner.actions).toEqual([]);
    runner.push(worker({ status: 'done' }));
    await turn;
  });

  test('a client without forms gets the question as text', async () => {
    const { bridge, runner, requests, updates } = setup([worker({ status: 'working' })]);
    await bridge.handle('initialize', { protocolVersion: 1, clientCapabilities: {} });
    const turn = bridge.handle('session/prompt', { sessionId: 'w1', prompt: [{ type: 'text', text: '/watch' }] });
    await tick();
    runner.push(worker(question()));
    await turn;
    expect(requests).toEqual([]);
    expect(texts(updates)).toContain('1. Postgres — the default');
  });

  test('the turn ends with what the run cost, and says what kind of dollars they are', async () => {
    const { bridge, runner, updates } = setup([worker({ status: 'working' })]);
    const turn = bridge.handle('session/prompt', { sessionId: 'w1', prompt: [{ type: 'text', text: '/watch' }] });
    await tick();
    runner.push(worker({ status: 'done', spend: { usd: 1.234, kind: 'plan' } } as any));
    const res: any = await turn;
    expect(texts(updates)).toContain('$1.23 at list price (plan usage, not billed)');
    expect(res._meta).toEqual({ buildd: { spend: { usd: 1.234, kind: 'plan' } } });
  });

  test('an unknown method is a JSON-RPC method-not-found', async () => {
    const { bridge } = setup();
    await expect(bridge.handle('session/fork', {})).rejects.toMatchObject({ code: -32601 });
  });
});
