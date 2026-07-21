/**
 * Regression test: Codex backend sandbox mode selection based on bwrap availability.
 *
 * When bwrap user namespaces are unavailable (Docker without seccomp=unconfined),
 * workspace-write mode fails. The backend must fall back to danger-full-access so
 * shell commands can run, and warn the operator to fix the container capability.
 *
 * Run: bun test apps/runner/__tests__/unit/backends/codex-sandbox-bwrap.test.ts
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test';

let mockStartThread: ReturnType<typeof mock>;
let mockResumeThread: ReturnType<typeof mock>;
let mockRunStreamed: ReturnType<typeof mock>;

function makeEventStream(events: any[]): AsyncIterable<any> {
  return (async function* () {
    for (const event of events) yield event;
  })();
}

mockRunStreamed = mock(async (_prompt: string) => ({
  events: makeEventStream([]),
}));

mockStartThread = mock((_opts: any) => ({
  runStreamed: mockRunStreamed,
}));

mockResumeThread = mock((_threadId: string, _opts: any) => ({
  runStreamed: mockRunStreamed,
}));

mock.module('@openai/codex-sdk', () => ({
  Codex: class {
    constructor(_opts: any) {
      return {
        startThread: mockStartThread,
        resumeThread: mockResumeThread,
      } as any;
    }
  },
}));

import { CodexBackend } from '../../../src/backends/codex-backend';

const BASE_OPTS = {
  prompt: 'hello',
  sessionId: 'sess-bwrap-test',
  cwd: '/tmp',
};

async function drain(gen: AsyncIterable<unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _ of gen) {}
}

describe('CodexBackend sandbox mode — bwrap availability', () => {
  beforeEach(() => {
    mockStartThread.mockClear();
    mockResumeThread.mockClear();
    mockRunStreamed.mockClear();
    delete process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-test';
  });

  test('uses workspace-write when bwrapSupported is true (default)', async () => {
    await drain(new CodexBackend().runStreamed({ ...BASE_OPTS, bwrapSupported: true }));
    expect(mockStartThread).toHaveBeenCalledTimes(1);
    const threadOpts = mockStartThread.mock.calls[0][0];
    expect(threadOpts.sandboxMode).toBe('workspace-write');
  });

  test('uses workspace-write when bwrapSupported is omitted (defaults to true)', async () => {
    await drain(new CodexBackend().runStreamed({ ...BASE_OPTS }));
    expect(mockStartThread).toHaveBeenCalledTimes(1);
    const threadOpts = mockStartThread.mock.calls[0][0];
    expect(threadOpts.sandboxMode).toBe('workspace-write');
  });

  test('falls back to danger-full-access when bwrapSupported is false', async () => {
    await drain(new CodexBackend().runStreamed({ ...BASE_OPTS, bwrapSupported: false }));
    expect(mockStartThread).toHaveBeenCalledTimes(1);
    const threadOpts = mockStartThread.mock.calls[0][0];
    expect(threadOpts.sandboxMode).toBe('danger-full-access');
  });

  test('read-only mode is unaffected by bwrapSupported', async () => {
    await drain(
      new CodexBackend().runStreamed({
        ...BASE_OPTS,
        sandboxMode: 'read-only',
        bwrapSupported: false,
      }),
    );
    expect(mockStartThread).toHaveBeenCalledTimes(1);
    const threadOpts = mockStartThread.mock.calls[0][0];
    expect(threadOpts.sandboxMode).toBe('read-only');
  });
});
