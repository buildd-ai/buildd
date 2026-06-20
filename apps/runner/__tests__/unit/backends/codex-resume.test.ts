import { describe, test, expect, mock, beforeEach } from 'bun:test';

// ---------------------------------------------------------------------------
// Phase 1C / R5: when RunStreamedOpts.resumeThreadId is set, CodexBackend must
// call codex.resumeThread(id, opts) instead of codex.startThread(opts). When it
// is absent, startThread is used (unchanged). Both return a usable Thread.
// ---------------------------------------------------------------------------

let startThreadCalls: any[] = [];
let resumeThreadCalls: Array<{ id: string; opts: any }> = [];
let perTurnEvents: any[][] = [];

function makeEventStream(events: any[]): AsyncIterable<any> {
  return (async function* () {
    for (const event of events) yield event;
  })();
}

function makeThread(id: string) {
  let turn = 0;
  return {
    id,
    runStreamed: mock(async (_prompt: string) => {
      const events = perTurnEvents[turn] ?? [];
      turn += 1;
      return { events: makeEventStream([...events]) };
    }),
  };
}

const mockStartThread = mock((opts: any) => {
  startThreadCalls.push(opts);
  return makeThread('fresh-thread');
});
const mockResumeThread = mock((id: string, opts: any) => {
  resumeThreadCalls.push({ id, opts });
  return makeThread(id);
});
const mockCodexConstructor = mock((_opts: any) => ({
  startThread: mockStartThread,
  resumeThread: mockResumeThread,
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

const BASE = { prompt: 'do the thing', sessionId: 's', cwd: '/tmp' } as const;

function reset() {
  startThreadCalls = [];
  resumeThreadCalls = [];
  perTurnEvents = [
    [
      { type: 'item.completed', item: { id: 'a1', type: 'agent_message', text: 'done' } },
      { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } },
    ],
  ];
  mockStartThread.mockClear();
  mockResumeThread.mockClear();
  mockCodexConstructor.mockClear();
  process.env.OPENAI_API_KEY = 'sk-test';
}

describe('CodexBackend thread resume (Phase 1C / R5)', () => {
  beforeEach(reset);

  test('resumeThreadId → codex.resumeThread is called with the id (not startThread)', async () => {
    const backend = new CodexBackend({});
    const events: BackendEvent[] = [];
    for await (const e of backend.runStreamed({ ...BASE, resumeThreadId: 'thread-abc' })) {
      events.push(e);
    }

    expect(mockResumeThread).toHaveBeenCalledTimes(1);
    expect(resumeThreadCalls[0].id).toBe('thread-abc');
    expect(mockStartThread).not.toHaveBeenCalled();
    // Still drives a normal turn → complete.
    expect(events.at(-1)?.type).toBe('complete');
  });

  test('resumeThread receives the same thread options as startThread would', async () => {
    const backend = new CodexBackend({});
    for await (const _ of backend.runStreamed({
      ...BASE,
      model: 'gpt-5-codex',
      sandboxMode: 'read-only',
      resumeThreadId: 'thread-abc',
    })) { /* drain */ }

    expect(resumeThreadCalls[0].opts).toMatchObject({
      workingDirectory: '/tmp',
      model: 'gpt-5-codex',
      sandboxMode: 'read-only',
      skipGitRepoCheck: true,
    });
  });

  test('no resumeThreadId → startThread is used (unchanged behaviour)', async () => {
    const backend = new CodexBackend({});
    for await (const _ of backend.runStreamed({ ...BASE })) { /* drain */ }

    expect(mockStartThread).toHaveBeenCalledTimes(1);
    expect(mockResumeThread).not.toHaveBeenCalled();
  });
});
