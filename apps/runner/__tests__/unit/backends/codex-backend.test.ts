/**
 * Unit tests for CodexBackend.
 *
 * Tests cover:
 * - auth.json loading from CODEX_HOME (config option and env var)
 * - fallback to OPENAI_API_KEY when auth.json is absent
 * - error thrown when no auth is found
 * - sandbox mode mapping ('read-only' → 'read-only', default → 'workspace-write')
 * - BackendEvent mapping from codex-sdk stream events
 *
 * @openai/codex-sdk is mocked via mock.module so it does not need to be installed.
 * auth.json tests use real temp directories via Bun.spawnSync (avoids the fs module
 * so they're not affected by other test files' mock.module('fs') calls).
 *
 * When running as part of the full unit suite alongside tests that mock the `fs`
 * module, the auth-resolution describe block is automatically skipped. Run in
 * isolation to exercise those tests:
 *   bun test apps/runner/__tests__/unit/backends/
 *
 * Run: bun test apps/runner/__tests__/unit/backends/
 */

import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ─── Detect fs mock ───────────────────────────────────────────────────────────
// Several other unit test files (e.g. agent-teams.test.ts) call mock.module('fs')
// without including rmSync. When running the full unit suite, that mocked fs
// replaces the real one process-wide. We detect this so we can skip auth.json
// tests (which need real filesystem writes) and avoid import errors from
// fs functions the mock omits.
//
// Real fs: existsSync('/') === true.  Mocked fs (in this codebase): always false.
const FS_IS_MOCKED = !existsSync('/');

// ─── Mock @openai/codex-sdk ──────────────────────────────────────────────────
// Must be before any import that transitively pulls in the module.

let mockCodexStreamEvents: any[] = [];
const mockRunStreamed = mock(async (_prompt: any, _opts: any) => {
  const events = [...mockCodexStreamEvents];
  let idx = 0;
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (idx < events.length) return { value: events[idx++], done: false };
          return { value: undefined, done: true };
        },
      };
    },
  };
});

mock.module('@openai/codex-sdk', () => ({
  runStreamed: mockRunStreamed,
}));

// ─── Imports (after mock setup) ───────────────────────────────────────────────

import { CodexBackend } from '../../../src/backends/codex-backend';
import type { BackendEvent } from '../../../src/backends/types';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const BASE_RUN_OPTS = {
  prompt: 'do something',
  sessionId: 'sess-1',
  cwd: '/tmp',
};

async function collectEvents(
  events: any[],
  opts: Partial<typeof BASE_RUN_OPTS> & { env?: Record<string, string> } = {},
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

/** Create a temp directory with an auth.json file; returns the dir path.
 *  Uses Bun.spawnSync for mkdir so it bypasses the mocked 'fs' module. */
function makeTmpCodexHome(content: object): string {
  const dir = join(tmpdir(), `codex-test-${process.pid}-${Date.now()}`);
  // Use OS commands instead of fs module (which may be mocked in the test suite)
  Bun.spawnSync(['mkdir', '-p', dir]);
  writeFileSync(join(dir, 'auth.json'), JSON.stringify(content));
  return dir;
}

// ─── Auth resolution ─────────────────────────────────────────────────────────
// These tests write real files and rely on the real fs.existsSync / readFileSync.
// When running alongside other unit tests that mock 'fs', they are skipped.

const describeAuth = FS_IS_MOCKED ? describe.skip : describe;

describeAuth('CodexBackend auth resolution', () => {
  let tmpDir: string | null = null;

  beforeEach(() => {
    mockCodexStreamEvents = [];
    mockRunStreamed.mockClear();
    tmpDir = null;
    delete process.env.CODEX_HOME;
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    // Use Bun.spawnSync for cleanup — avoids the 'fs' module (which may be mocked)
    if (tmpDir) {
      Bun.spawnSync(['rm', '-rf', tmpDir]);
      tmpDir = null;
    }
    delete process.env.CODEX_HOME;
    delete process.env.OPENAI_API_KEY;
  });

  test('reads api_key from auth.json in codexHome config option', async () => {
    tmpDir = makeTmpCodexHome({ api_key: 'sk-from-config-codex-home' });
    mockCodexStreamEvents = [{ type: 'session.completed' }];
    const backend = new CodexBackend({ codexHome: tmpDir });

    for await (const _ of backend.runStreamed(BASE_RUN_OPTS)) {}

    const callOpts = mockRunStreamed.mock.calls[0]?.[1] as any;
    expect(callOpts?.api_key).toBe('sk-from-config-codex-home');
  });

  test('reads apiKey (camelCase) from auth.json', async () => {
    tmpDir = makeTmpCodexHome({ apiKey: 'sk-camel-key' });
    mockCodexStreamEvents = [{ type: 'session.completed' }];
    const backend = new CodexBackend({ codexHome: tmpDir });

    for await (const _ of backend.runStreamed(BASE_RUN_OPTS)) {}

    const callOpts = mockRunStreamed.mock.calls[0]?.[1] as any;
    expect(callOpts?.api_key).toBe('sk-camel-key');
  });

  test('reads api_key from auth.json when CODEX_HOME process env var is set', async () => {
    tmpDir = makeTmpCodexHome({ api_key: 'sk-from-env-codex-home' });
    process.env.CODEX_HOME = tmpDir;
    mockCodexStreamEvents = [{ type: 'session.completed' }];
    const backend = new CodexBackend({});

    for await (const _ of backend.runStreamed(BASE_RUN_OPTS)) {}

    const callOpts = mockRunStreamed.mock.calls[0]?.[1] as any;
    expect(callOpts?.api_key).toBe('sk-from-env-codex-home');
  });

  test('CODEX_HOME in task env takes priority over process env', async () => {
    const envDir = makeTmpCodexHome({ api_key: 'sk-from-task-env' });
    const processDir = makeTmpCodexHome({ api_key: 'sk-from-process-env' });
    tmpDir = envDir;
    process.env.CODEX_HOME = processDir;
    mockCodexStreamEvents = [{ type: 'session.completed' }];
    const backend = new CodexBackend({});

    for await (const _ of backend.runStreamed({
      ...BASE_RUN_OPTS,
      env: { CODEX_HOME: envDir },
    })) {}

    Bun.spawnSync(['rm', '-rf', processDir]);
    const callOpts = mockRunStreamed.mock.calls[0]?.[1] as any;
    expect(callOpts?.api_key).toBe('sk-from-task-env');
  });

  test('falls back to OPENAI_API_KEY when no auth.json found', async () => {
    process.env.OPENAI_API_KEY = 'sk-openai-fallback';
    mockCodexStreamEvents = [{ type: 'session.completed' }];
    const backend = new CodexBackend({});

    for await (const _ of backend.runStreamed(BASE_RUN_OPTS)) {}

    const callOpts = mockRunStreamed.mock.calls[0]?.[1] as any;
    expect(callOpts?.api_key).toBe('sk-openai-fallback');
  });

  test('OPENAI_API_KEY in task env is used when no CODEX_HOME', async () => {
    mockCodexStreamEvents = [{ type: 'session.completed' }];
    const backend = new CodexBackend({});

    for await (const _ of backend.runStreamed({
      ...BASE_RUN_OPTS,
      env: { OPENAI_API_KEY: 'sk-from-task-env-openai' },
    })) {}

    const callOpts = mockRunStreamed.mock.calls[0]?.[1] as any;
    expect(callOpts?.api_key).toBe('sk-from-task-env-openai');
  });

  test('throws when no auth source is available', async () => {
    const backend = new CodexBackend({});
    const gen = backend.runStreamed(BASE_RUN_OPTS);
    await expect(gen.next()).rejects.toThrow(/No Codex auth found/);
  });

  test('falls through to OPENAI_API_KEY when auth.json is malformed JSON', async () => {
    tmpDir = join(tmpdir(), `codex-bad-json-${process.pid}-${Date.now()}`);
    Bun.spawnSync(['mkdir', '-p', tmpDir]);
    writeFileSync(join(tmpDir, 'auth.json'), '{ not json }');
    process.env.OPENAI_API_KEY = 'sk-fallback-after-bad-json';
    mockCodexStreamEvents = [{ type: 'session.completed' }];
    const backend = new CodexBackend({ codexHome: tmpDir });

    for await (const _ of backend.runStreamed(BASE_RUN_OPTS)) {}

    const callOpts = mockRunStreamed.mock.calls[0]?.[1] as any;
    expect(callOpts?.api_key).toBe('sk-fallback-after-bad-json');
  });
});

// ─── Sandbox mode mapping ─────────────────────────────────────────────────────

describe('CodexBackend sandbox mode mapping', () => {
  beforeEach(() => {
    mockCodexStreamEvents = [{ type: 'session.completed' }];
    mockRunStreamed.mockClear();
    process.env.OPENAI_API_KEY = 'sk-test';
  });

  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
  });

  test('"read-only" → sends read-only to SDK', async () => {
    const backend = new CodexBackend({});
    for await (const _ of backend.runStreamed({
      ...BASE_RUN_OPTS,
      sandboxMode: 'read-only',
    })) {}
    const callOpts = mockRunStreamed.mock.calls[0]?.[1] as any;
    expect(callOpts?.sandbox).toBe('read-only');
  });

  test('"workspace-write" → sends workspace-write to SDK', async () => {
    const backend = new CodexBackend({});
    for await (const _ of backend.runStreamed({
      ...BASE_RUN_OPTS,
      sandboxMode: 'workspace-write',
    })) {}
    const callOpts = mockRunStreamed.mock.calls[0]?.[1] as any;
    expect(callOpts?.sandbox).toBe('workspace-write');
  });

  test('undefined sandboxMode defaults to workspace-write', async () => {
    const backend = new CodexBackend({});
    for await (const _ of backend.runStreamed(BASE_RUN_OPTS)) {}
    const callOpts = mockRunStreamed.mock.calls[0]?.[1] as any;
    expect(callOpts?.sandbox).toBe('workspace-write');
  });

  test('mapSandboxMode: read-only passthrough', () => {
    const backend = new CodexBackend({});
    expect((backend as any).mapSandboxMode('read-only')).toBe('read-only');
  });

  test('mapSandboxMode: workspace-write passthrough', () => {
    const backend = new CodexBackend({});
    expect((backend as any).mapSandboxMode('workspace-write')).toBe('workspace-write');
  });

  test('mapSandboxMode: undefined → workspace-write', () => {
    const backend = new CodexBackend({});
    expect((backend as any).mapSandboxMode(undefined)).toBe('workspace-write');
  });
});

// ─── BackendEvent mapping ────────────────────────────────────────────────────

describe('CodexBackend BackendEvent mapping', () => {
  beforeEach(() => {
    mockRunStreamed.mockClear();
    process.env.OPENAI_API_KEY = 'sk-test';
  });

  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
  });

  test('item.completed (type field) → progress event', async () => {
    const events = await collectEvents([
      { type: 'item.completed', content: 'tool finished' },
      { type: 'session.completed' },
    ]);

    const progress = events.filter(e => e.type === 'progress');
    expect(progress.length).toBe(1);
    expect((progress[0] as any).message).toBe('tool finished');
  });

  test('item.completed (event field) → progress event', async () => {
    const events = await collectEvents([
      { event: 'item.completed', content: 'via event field' },
      { type: 'session.completed' },
    ]);

    const progress = events.filter(e => e.type === 'progress');
    expect(progress.length).toBe(1);
    expect((progress[0] as any).message).toBe('via event field');
  });

  test('item.completed uses message field as fallback when content absent', async () => {
    const events = await collectEvents([
      { type: 'item.completed', message: 'fallback message' },
      { type: 'session.completed' },
    ]);

    const progress = events.filter(e => e.type === 'progress');
    expect((progress[0] as any).message).toBe('fallback message');
  });

  test('turn.completed (type field) → turn_complete event', async () => {
    const events = await collectEvents([
      {
        type: 'turn.completed',
        usage: { input_tokens: 200, output_tokens: 80 },
      },
      { type: 'session.completed' },
    ]);

    const tc = events.find(e => e.type === 'turn_complete') as any;
    expect(tc).toBeDefined();
    expect(tc.usage?.inputTokens).toBe(200);
    expect(tc.usage?.outputTokens).toBe(80);
  });

  test('turn.completed (event field) → turn_complete event', async () => {
    const events = await collectEvents([
      { event: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } },
      { type: 'session.completed' },
    ]);

    expect(events.some(e => e.type === 'turn_complete')).toBe(true);
  });

  test('turn.completed with camelCase usage fields', async () => {
    const events = await collectEvents([
      {
        type: 'turn.completed',
        usage: { inputTokens: 150, outputTokens: 60 },
      },
      { type: 'session.completed' },
    ]);

    const tc = events.find(e => e.type === 'turn_complete') as any;
    expect(tc?.usage?.inputTokens).toBe(150);
    expect(tc?.usage?.outputTokens).toBe(60);
  });

  test('turn.completed with structured_output propagates to turn_complete', async () => {
    const events = await collectEvents([
      {
        type: 'turn.completed',
        structured_output: { result: 'done' },
      },
      { type: 'session.completed' },
    ]);

    const tc = events.find(e => e.type === 'turn_complete') as any;
    expect(tc?.structuredOutput).toEqual({ result: 'done' });
  });

  test('session.completed breaks the loop and emits complete', async () => {
    const events = await collectEvents([
      { type: 'item.completed', content: 'step 1' },
      { type: 'session.completed', output: 'All done' },
      // These would only appear if the loop did not break:
      { type: 'item.completed', content: 'should not appear' },
    ]);

    expect(events.filter(e => e.type === 'progress').length).toBe(1);
    const complete = events.find(e => e.type === 'complete') as any;
    expect(complete?.summary).toBe('All done');
  });

  test('run.completed also breaks the loop', async () => {
    const events = await collectEvents([
      { type: 'item.completed', content: 'step 1' },
      { type: 'run.completed', output: 'Run summary' },
      { type: 'item.completed', content: 'should not appear' },
    ]);

    expect(events.filter(e => e.type === 'progress').length).toBe(1);
    const complete = events.find(e => e.type === 'complete') as any;
    expect(complete?.summary).toBe('Run summary');
  });

  test('event=done also breaks the loop', async () => {
    const events = await collectEvents([
      { event: 'done', summary: 'Done via event' },
    ]);

    const complete = events.find(e => e.type === 'complete') as any;
    expect(complete).toBeDefined();
  });

  test('complete event is always the last event yielded', async () => {
    const events = await collectEvents([
      { type: 'item.completed', content: 'step' },
      { type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 2 } },
      { type: 'session.completed' },
    ]);

    const last = events[events.length - 1];
    expect(last?.type).toBe('complete');
  });

  test('complete.summary comes from session.completed output field', async () => {
    const events = await collectEvents([
      { type: 'session.completed', output: 'Final output text' },
    ]);

    const complete = events.find(e => e.type === 'complete') as any;
    expect(complete?.summary).toBe('Final output text');
  });

  test('complete.summary comes from session.completed summary field', async () => {
    const events = await collectEvents([
      { type: 'session.completed', summary: 'Summary text' },
    ]);

    const complete = events.find(e => e.type === 'complete') as any;
    expect(complete?.summary).toBe('Summary text');
  });

  test('complete carries structuredOutput from last turn', async () => {
    const events = await collectEvents([
      { type: 'turn.completed', structured_output: { x: 1 } },
      { type: 'session.completed' },
    ]);

    const complete = events.find(e => e.type === 'complete') as any;
    expect(complete?.structuredOutput).toEqual({ x: 1 });
  });

  test('progress message is truncated to 200 chars', async () => {
    const longContent = 'a'.repeat(300);
    const events = await collectEvents([
      { type: 'item.completed', content: longContent },
      { type: 'session.completed' },
    ]);

    const progress = events.find(e => e.type === 'progress') as any;
    expect(progress?.message.length).toBe(200);
  });
});
