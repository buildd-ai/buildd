import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Whether the `fs` module is backed by the real filesystem at RUN time.
//
// Sibling suites (e.g. env-scan.test.ts, agent-teams.test.ts) call
// mock.module('fs') process-wide. Those mocks register during the load phase —
// AFTER this file's top-level code runs — so a load-time check is unreliable.
// We probe at runtime (in beforeEach) instead. The probe catches both mock
// shapes: existsSync-always-false (real '/' fails) and existsSync-always-true
// (a guaranteed-absent path returns true). The disk-dependent auth tests run
// only when fs is real (i.e. when this file runs in isolation).
function probeFsIsReal(): boolean {
  try {
    return existsSync('/') && !existsSync(join(tmpdir(), `__codex_fs_probe_${process.pid}_${Math.random().toString(16).slice(2)}`));
  } catch {
    return false;
  }
}

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

// Runs the body only when fs is real; otherwise records a skip. Keeps the
// disk-backed auth tests meaningful in isolation without failing the shared
// CI run where a sibling suite has mocked fs.
function authTest(name: string, fn: () => Promise<void>) {
  test(name, async () => {
    if (!probeFsIsReal()) {
      console.warn(`[codex-backend.test] skipping "${name}" — fs is mocked by a sibling suite (covered when run in isolation)`);
      return;
    }
    await fn();
  });
}

describe('CodexBackend auth resolution', () => {
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

  authTest('reads api_key from auth.json in codexHome config option', async () => {
    const tmpDir = makeTmpCodexHome({ api_key: 'sk-from-config-codex-home' });
    tmpDirs.push(tmpDir);
    mockCodexStreamEvents = [];

    for await (const _ of new CodexBackend({ codexHome: tmpDir }).runStreamed(BASE_RUN_OPTS)) {}

    expect(mockCodexConstructor.mock.calls[0]?.[0]?.apiKey).toBe('sk-from-config-codex-home');
  });

  authTest('reads apiKey from auth.json', async () => {
    const tmpDir = makeTmpCodexHome({ apiKey: 'sk-camel-key' });
    tmpDirs.push(tmpDir);

    for await (const _ of new CodexBackend({ codexHome: tmpDir }).runStreamed(BASE_RUN_OPTS)) {}

    expect(mockCodexConstructor.mock.calls[0]?.[0]?.apiKey).toBe('sk-camel-key');
  });

  authTest('reads nested tokens from raw Codex auth.json', async () => {
    const tmpDir = makeTmpCodexHome({ tokens: { access_token: 'oauth-token' } });
    tmpDirs.push(tmpDir);
    mockRunStreamed.mockImplementationOnce(async (_prompt: string) => ({
      events: (async function* () {
        // Probe the spawn-time env via a command_execution item — agent_message
        // no longer yields a channel-1 `progress` (R8 dedupe), but commands do.
        yield { type: 'item.completed', item: { id: 'p1', type: 'command_execution', status: 'completed', command: process.env.CODEX_HOME || '' } };
      })(),
    }));

    const events: BackendEvent[] = [];
    for await (const event of new CodexBackend({ codexHome: tmpDir }).runStreamed(BASE_RUN_OPTS)) {
      events.push(event);
    }

    expect(mockCodexConstructor.mock.calls[0]?.[0]?.apiKey).toBeUndefined();
    expect(events.find(e => e.type === 'progress')).toEqual({ type: 'progress', message: `completed: ${tmpDir}` });
  });

  authTest('CODEX_HOME in task env takes priority over process env', async () => {
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

  authTest('falls through to OPENAI_API_KEY when auth.json is malformed JSON', async () => {
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
        // command_execution carries the spawn-time env into a channel-1 progress
        // (agent_message no longer yields progress — R8 dedupe).
        yield { type: 'item.completed', item: { id: 'p1', type: 'command_execution', status: 'completed', command: process.env.CODEX_ENV_TEST || '' } };
      })(),
    }));

    const events = await collectEvents([], {
      env: { OPENAI_API_KEY: 'sk-test', CODEX_ENV_TEST: 'visible-at-spawn' },
    });

    expect(events.find(e => e.type === 'progress')).toEqual({ type: 'progress', message: 'completed: visible-at-spawn' });
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

  test('agent_message item.completed drives complete summary but no channel-1 progress (R8 dedupe)', async () => {
    const progressEvents: any[] = [];
    const events = await collectEvents([
      { type: 'item.completed', item: { id: 'a1', type: 'agent_message', text: 'All done' } },
    ], {
      onProgress: (raw: any) => { progressEvents.push(raw); },
    } as any);

    // R8: agent text is surfaced via the channel-2 adapter (assistant text →
    // worker.output in handleMessage), so codex-backend no longer yields a
    // duplicate channel-1 `progress` for agent_message.
    expect(events.find(e => e.type === 'progress')).toBeUndefined();
    expect(events.at(-1)).toEqual({ type: 'complete', summary: 'All done' });
    // The adapter still feeds an assistant text message through onProgress.
    const assistant = progressEvents.find((m) => m.type === 'assistant');
    expect(assistant?.message?.content?.[0]).toMatchObject({ type: 'text', text: 'All done' });
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

  test('reasoning_output_tokens are folded into output usage + cost (Phase 3)', async () => {
    // Real turn.completed.usage (confirmed live, codex-cli 0.140) includes
    // reasoning_output_tokens that bill as output. The estimator must count them.
    const progressEvents: any[] = [];
    const backend = new CodexBackend({});
    mockCodexStreamEvents = [
      {
        type: 'turn.completed',
        usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 100, reasoning_output_tokens: 900 },
      },
    ];

    const events: BackendEvent[] = [];
    for await (const event of backend.runStreamed({
      ...BASE_RUN_OPTS,
      model: 'gpt-5-codex',
      // Pin output price to a clean number: $10/M output → 1000 output tokens = $0.01.
      env: {
        OPENAI_API_KEY: 'sk-test',
        CODEX_INPUT_USD_PER_M_TOKENS: '0',
        CODEX_CACHED_INPUT_USD_PER_M_TOKENS: '0',
        CODEX_OUTPUT_USD_PER_M_TOKENS: '10',
      },
      onProgress: (raw) => { progressEvents.push(raw); },
    })) {
      events.push(event);
    }

    // turn_complete usage reports output = output_tokens + reasoning_output_tokens.
    const tc = events.find(e => e.type === 'turn_complete') as any;
    expect(tc?.usage).toEqual({ inputTokens: 0, outputTokens: 1000 });

    // Aggregate output usage includes reasoning tokens.
    const result = progressEvents.find(e => e.type === 'result');
    expect(result?.usage?.byModel?.['gpt-5-codex']).toMatchObject({ outputTokens: 1000 });
    // Cost counts all 1000 output tokens at $10/M = $0.01 (not just the 100).
    expect(result?.total_cost_usd).toBeCloseTo(0.01, 6);
  });

  test('reasoning tokens cost is added when reasoning_output_tokens is absent (no NaN/double-count)', async () => {
    const progressEvents: any[] = [];
    const backend = new CodexBackend({});
    mockCodexStreamEvents = [
      { type: 'turn.completed', usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 1000 } },
    ];
    for await (const _ of backend.runStreamed({
      ...BASE_RUN_OPTS,
      model: 'gpt-5-codex',
      env: {
        OPENAI_API_KEY: 'sk-test',
        CODEX_INPUT_USD_PER_M_TOKENS: '0',
        CODEX_CACHED_INPUT_USD_PER_M_TOKENS: '0',
        CODEX_OUTPUT_USD_PER_M_TOKENS: '10',
      },
      onProgress: (raw) => { progressEvents.push(raw); },
    })) {}
    const result = progressEvents.find(e => e.type === 'result');
    expect(result?.total_cost_usd).toBeCloseTo(0.01, 6);
    expect(result?.usage?.byModel?.['gpt-5-codex']).toMatchObject({ outputTokens: 1000 });
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

  authTest('OAuth CODEX_HOME reports usage but does not enforce fabricated budget', async () => {
    const tmpDir = makeTmpCodexHome({ access_token: 'oauth-token', refresh_token: 'refresh', account_id: 'acct' });
    mockCodexStreamEvents = [
      { type: 'turn.completed', usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 10_000 } },
    ];
    const events = await collectEvents(mockCodexStreamEvents, { env: { CODEX_HOME: tmpDir }, maxBudgetUsd: 0.0001 });
    rmSync(tmpDir, { recursive: true, force: true });
    expect(events.at(-1)?.type).toBe('complete');
  });

  test('non-text prompts are rejected explicitly', async () => {
    async function* promptParts() {
      yield { type: 'text', text: 'hi' };
    }

    const gen = new CodexBackend({}).runStreamed({
      ...BASE_RUN_OPTS,
      prompt: promptParts(),
    });

    await expect(gen.next()).rejects.toThrow(/does not support image or other non-text prompts/);
  });
});
