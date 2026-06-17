import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const FS_IS_MOCKED = !existsSync('/');

let mockCodexStreamEvents: any[] = [];
let mockCodexConstructor: ReturnType<typeof mock>;
let mockStartThread: ReturnType<typeof mock>;
let mockRunStreamed: ReturnType<typeof mock>;

function makeEventStream(events: any[]): AsyncIterable<any> {
  return (async function* () {
    for (const event of events) yield event;
  })();
}

mockRunStreamed = mock(async (_prompt: string) => ({
  events: makeEventStream([...mockCodexStreamEvents]),
}));

mockStartThread = mock((_opts: any) => ({
  runStreamed: mockRunStreamed,
}));

mockCodexConstructor = mock((_opts: any) => ({
  startThread: mockStartThread,
}));

mock.module('@openai/codex-sdk', () => ({
  Codex: class {
    constructor(opts: any) {
      return mockCodexConstructor(opts) as any;
    }
  },
}));

import { CodexBackend } from '../../../src/backends/codex-backend';
import type { BackendEvent } from '../../../src/backends/types';

const BASE_RUN_OPTS = {
  prompt: 'do something',
  sessionId: 'sess-1',
  cwd: '/tmp',
};

async function collectEvents(
  events: any[],
  opts: Partial<typeof BASE_RUN_OPTS> & { env?: Record<string, string>; maxBudgetUsd?: number; outputSchema?: Record<string, unknown>; model?: string } = {},
  config: ConstructorParameters<typeof CodexBackend>[0] = {},
): Promise<BackendEvent[]> {
  mockCodexStreamEvents = events;
  const backend = new CodexBackend(config);
  const result: BackendEvent[] = [];
  for await (const event of backend.runStreamed({ ...BASE_RUN_OPTS, ...opts })) {
    result.push(event);
  }
  return result;
}

function makeTmpCodexHome(content: object): string {
  const dir = join(tmpdir(), `codex-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'auth.json'), JSON.stringify(content));
  return dir;
}

function resetMocks() {
  mockCodexStreamEvents = [];
  mockRunStreamed.mockClear();
  mockStartThread.mockClear();
  mockCodexConstructor.mockClear();
  mockRunStreamed.mockImplementation(async (_prompt: string) => ({
    events: makeEventStream([...mockCodexStreamEvents]),
  }));
}

const describeAuth = FS_IS_MOCKED ? describe.skip : describe;

describeAuth('CodexBackend auth resolution', () => {
  let tmpDirs: string[] = [];

  beforeEach(() => {
    resetMocks();
    tmpDirs = [];
    delete process.env.CODEX_HOME;
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
    delete process.env.CODEX_HOME;
    delete process.env.OPENAI_API_KEY;
  });

  test('reads api_key from auth.json in codexHome config option', async () => {
    const tmpDir = makeTmpCodexHome({ api_key: 'sk-from-config-codex-home' });
    tmpDirs.push(tmpDir);
    mockCodexStreamEvents = [];

    for await (const _ of new CodexBackend({ codexHome: tmpDir }).runStreamed(BASE_RUN_OPTS)) {}

    expect(mockCodexConstructor.mock.calls[0]?.[0]?.apiKey).toBe('sk-from-config-codex-home');
  });

  test('reads apiKey from auth.json', async () => {
    const tmpDir = makeTmpCodexHome({ apiKey: 'sk-camel-key' });
    tmpDirs.push(tmpDir);

    for await (const _ of new CodexBackend({ codexHome: tmpDir }).runStreamed(BASE_RUN_OPTS)) {}

    expect(mockCodexConstructor.mock.calls[0]?.[0]?.apiKey).toBe('sk-camel-key');
  });

  test('reads nested tokens from raw Codex auth.json', async () => {
    const tmpDir = makeTmpCodexHome({ tokens: { access_token: 'oauth-token' } });
    tmpDirs.push(tmpDir);
    mockRunStreamed.mockImplementationOnce(async (_prompt: string) => ({
      events: (async function* () {
        yield { type: 'item.completed', item: { type: 'agent_message', text: process.env.CODEX_HOME || '' } };
      })(),
    }));

    const events: BackendEvent[] = [];
    for await (const event of new CodexBackend({ codexHome: tmpDir }).runStreamed(BASE_RUN_OPTS)) {
      events.push(event);
    }

    expect(mockCodexConstructor.mock.calls[0]?.[0]?.apiKey).toBeUndefined();
    expect(events.find(e => e.type === 'progress')).toEqual({ type: 'progress', message: tmpDir });
  });

  test('CODEX_HOME in task env takes priority over process env', async () => {
    const taskDir = makeTmpCodexHome({ api_key: 'sk-from-task-env' });
    const processDir = makeTmpCodexHome({ api_key: 'sk-from-process-env' });
    tmpDirs.push(taskDir, processDir);
    process.env.CODEX_HOME = processDir;

    for await (const _ of new CodexBackend({}).runStreamed({
      ...BASE_RUN_OPTS,
      env: { CODEX_HOME: taskDir },
    })) {}

    expect(mockCodexConstructor.mock.calls[0]?.[0]?.apiKey).toBe('sk-from-task-env');
  });

  test('falls back to OPENAI_API_KEY when no auth.json exists', async () => {
    process.env.OPENAI_API_KEY = 'sk-openai-fallback';

    for await (const _ of new CodexBackend({}).runStreamed(BASE_RUN_OPTS)) {}

    expect(mockCodexConstructor.mock.calls[0]?.[0]?.apiKey).toBe('sk-openai-fallback');
  });

  test('OPENAI_API_KEY in task env is used when no CODEX_HOME', async () => {
    for await (const _ of new CodexBackend({}).runStreamed({
      ...BASE_RUN_OPTS,
      env: { OPENAI_API_KEY: 'sk-from-task-env-openai' },
    })) {}

    expect(mockCodexConstructor.mock.calls[0]?.[0]?.apiKey).toBe('sk-from-task-env-openai');
  });

  test('throws when no auth source is available', async () => {
    const gen = new CodexBackend({}).runStreamed(BASE_RUN_OPTS);
    await expect(gen.next()).rejects.toThrow(/No Codex auth found/);
  });

  test('falls through to OPENAI_API_KEY when auth.json is malformed JSON', async () => {
    const tmpDir = makeTmpCodexHome({});
    tmpDirs.push(tmpDir);
    writeFileSync(join(tmpDir, 'auth.json'), '{ not json }');
    process.env.OPENAI_API_KEY = 'sk-fallback-after-bad-json';

    for await (const _ of new CodexBackend({ codexHome: tmpDir }).runStreamed(BASE_RUN_OPTS)) {}

    expect(mockCodexConstructor.mock.calls[0]?.[0]?.apiKey).toBe('sk-fallback-after-bad-json');
  });
});

describe('CodexBackend SDK options', () => {
  beforeEach(() => {
    resetMocks();
    process.env.OPENAI_API_KEY = 'sk-test';
  });

  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.CODEX_ENV_TEST;
  });

  test('"read-only" maps to startThread sandboxMode', async () => {
    for await (const _ of new CodexBackend({}).runStreamed({ ...BASE_RUN_OPTS, sandboxMode: 'read-only' })) {}
    expect(mockStartThread.mock.calls[0]?.[0]?.sandboxMode).toBe('read-only');
  });

  test('"workspace-write" maps to startThread sandboxMode', async () => {
    for await (const _ of new CodexBackend({}).runStreamed({ ...BASE_RUN_OPTS, sandboxMode: 'workspace-write' })) {}
    expect(mockStartThread.mock.calls[0]?.[0]?.sandboxMode).toBe('workspace-write');
  });

  test('undefined sandboxMode defaults to workspace-write', async () => {
    for await (const _ of new CodexBackend({}).runStreamed(BASE_RUN_OPTS)) {}
    expect(mockStartThread.mock.calls[0]?.[0]?.sandboxMode).toBe('workspace-write');
  });

  test('passes model, workingDirectory, and skipGitRepoCheck to startThread', async () => {
    for await (const _ of new CodexBackend({}).runStreamed({ ...BASE_RUN_OPTS, model: 'gpt-5-codex' })) {}
    expect(mockStartThread.mock.calls[0]?.[0]).toMatchObject({
      model: 'gpt-5-codex',
      workingDirectory: '/tmp',
      skipGitRepoCheck: true,
    });
  });

  test('passes baseUrl from OPENAI_BASE_URL', async () => {
    for await (const _ of new CodexBackend({}).runStreamed({
      ...BASE_RUN_OPTS,
      env: { OPENAI_API_KEY: 'sk-test', OPENAI_BASE_URL: 'https://example.test/v1' },
    })) {}

    expect(mockCodexConstructor.mock.calls[0]?.[0]?.baseUrl).toBe('https://example.test/v1');
  });

  test('task env is present when Codex generator starts', async () => {
    mockRunStreamed.mockImplementationOnce(async (_prompt: string) => ({
      events: (async function* () {
        yield { type: 'item.completed', item: { type: 'agent_message', text: process.env.CODEX_ENV_TEST || '' } };
      })(),
    }));

    const events = await collectEvents([], {
      env: { OPENAI_API_KEY: 'sk-test', CODEX_ENV_TEST: 'visible-at-spawn' },
    });

    expect(events.find(e => e.type === 'progress')).toEqual({ type: 'progress', message: 'visible-at-spawn' });
    expect(process.env.CODEX_ENV_TEST).toBeUndefined();
  });
});

describe('CodexBackend BackendEvent mapping', () => {
  beforeEach(() => {
    resetMocks();
    process.env.OPENAI_API_KEY = 'sk-test';
  });

  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
  });

  test('agent_message item.completed maps to progress and complete summary', async () => {
    const events = await collectEvents([
      { type: 'item.completed', item: { type: 'agent_message', text: 'All done' } },
    ]);

    expect(events.find(e => e.type === 'progress')).toEqual({ type: 'progress', message: 'All done' });
    expect(events.at(-1)).toEqual({ type: 'complete', summary: 'All done' });
  });

  test('command execution item maps to progress', async () => {
    const events = await collectEvents([
      { type: 'item.completed', item: { type: 'command_execution', status: 'completed', command: 'bun test' } },
    ]);

    expect(events.find(e => e.type === 'progress')).toEqual({ type: 'progress', message: 'completed: bun test' });
  });

  test('turn.completed maps usage including cached input and result metadata', async () => {
    const progressEvents: any[] = [];
    const backend = new CodexBackend({});
    mockCodexStreamEvents = [
      { type: 'turn.completed', usage: { input_tokens: 200, cached_input_tokens: 50, output_tokens: 80 } },
    ];

    const events: BackendEvent[] = [];
    for await (const event of backend.runStreamed({
      ...BASE_RUN_OPTS,
      model: 'gpt-5-codex',
      onProgress: (raw) => { progressEvents.push(raw); },
    })) {
      events.push(event);
    }

    const tc = events.find(e => e.type === 'turn_complete') as any;
    expect(tc?.usage).toEqual({ inputTokens: 250, outputTokens: 80 });
    const result = progressEvents.find(e => e.type === 'result');
    expect(result?.usage?.byModel?.['gpt-5-codex']).toMatchObject({
      inputTokens: 200,
      cacheReadInputTokens: 50,
      outputTokens: 80,
    });
  });

  test('structured output is parsed from final agent JSON text', async () => {
    const events = await collectEvents([
      { type: 'item.completed', item: { type: 'agent_message', text: '{"ok":true}' } },
      { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } },
    ], { outputSchema: { type: 'object' } });

    expect((events.find(e => e.type === 'turn_complete') as any)?.structuredOutput).toEqual({ ok: true });
    expect((events.at(-1) as any)?.structuredOutput).toEqual({ ok: true });
  });

  test('turn.failed maps to error event', async () => {
    const events = await collectEvents([
      { type: 'turn.failed', error: { message: 'bad auth' } },
    ]);

    expect(events).toEqual([{ type: 'error', error: 'bad auth' }]);
  });

  test('budget harness emits budget error after usage exceeds maxBudgetUsd', async () => {
    const progressEvents: any[] = [];
    const backend = new CodexBackend({});
    mockCodexStreamEvents = [
      { type: 'turn.completed', usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 10_000 } },
    ];

    const events: BackendEvent[] = [];
    for await (const event of backend.runStreamed({
      ...BASE_RUN_OPTS,
      maxBudgetUsd: 0.0001,
      onProgress: (raw) => { progressEvents.push(raw); },
    })) {
      events.push(event);
    }

    expect(events.some(e => e.type === 'turn_complete')).toBe(true);
    expect((events.at(-1) as any).type).toBe('error');
    expect((events.at(-1) as any).error).toContain('Budget limit exceeded');
    expect(progressEvents.find(e => e.subtype === 'error_max_budget_usd')).toBeDefined();
  });

  test('non-text prompts are rejected explicitly', async () => {
    async function* promptParts() {
      yield { type: 'text', text: 'hi' };
    }

    const gen = new CodexBackend({}).runStreamed({
      ...BASE_RUN_OPTS,
      prompt: promptParts(),
    });

    await expect(gen.next()).rejects.toThrow(/does not support non-text prompts/);
  });
});
