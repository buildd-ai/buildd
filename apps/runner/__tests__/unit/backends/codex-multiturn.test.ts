import { describe, test, expect, mock, beforeEach } from 'bun:test';

// ---------------------------------------------------------------------------
// Mock the Codex SDK so a persistent Thread records every runStreamed() call.
// Each call returns a configurable event stream so we can assert multi-turn
// behaviour: the SAME thread instance is reused across turns, the input stream
// drives subsequent turns, `complete` fires only once after stream end, abort
// breaks the loop, and the synthetic `result` is emitted exactly once.
// ---------------------------------------------------------------------------

interface ThreadRun {
  prompt: string;
}

let perTurnEvents: any[][] = [];
let runCalls: ThreadRun[] = [];
let threadInstances: any[] = [];
let mockStartThread: ReturnType<typeof mock>;
let mockCodexConstructor: ReturnType<typeof mock>;

function makeEventStream(events: any[]): AsyncIterable<any> {
  return (async function* () {
    for (const event of events) yield event;
  })();
}

function makeThread() {
  const thread = {
    id: 'thread-xyz',
    _turn: 0,
    runStreamed: mock(async (prompt: string) => {
      runCalls.push({ prompt });
      const idx = thread._turn;
      thread._turn += 1;
      const events = perTurnEvents[idx] ?? [];
      return { events: makeEventStream([...events]) };
    }),
  };
  threadInstances.push(thread);
  return thread;
}

mockStartThread = mock((_opts: any) => makeThread());
mockCodexConstructor = mock((_opts: any) => ({ startThread: mockStartThread }));

mock.module('@openai/codex-sdk', () => ({
  Codex: class {
    constructor(opts: any) {
      return mockCodexConstructor(opts) as any;
    }
  },
}));

import { CodexBackend } from '../../../src/backends/codex-backend';
import type { BackendEvent } from '../../../src/backends/types';

// A controllable async iterable that mirrors workers.ts's MessageStream:
// enqueue() pushes an SDKUserMessage, end() terminates the stream. it.next()
// blocks (returns a pending promise) until a message arrives or the stream ends.
class TestInputStream implements AsyncIterable<unknown> {
  private queue: unknown[] = [];
  private resolvers: Array<(r: IteratorResult<unknown>) => void> = [];
  private done = false;

  enqueueText(text: string) {
    const msg = { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } };
    if (this.resolvers.length > 0) this.resolvers.shift()!({ value: msg, done: false });
    else this.queue.push(msg);
  }

  end() {
    this.done = true;
    for (const r of this.resolvers) r({ value: undefined, done: true });
    this.resolvers = [];
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return {
      next: () => {
        if (this.queue.length > 0) return Promise.resolve({ value: this.queue.shift()!, done: false });
        if (this.done) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.resolvers.push(resolve));
      },
    };
  }
}

const BASE = { prompt: 'initial prompt', sessionId: 's', cwd: '/tmp' } as const;

function reset() {
  perTurnEvents = [];
  runCalls = [];
  threadInstances = [];
  mockStartThread.mockClear();
  mockCodexConstructor.mockClear();
  process.env.OPENAI_API_KEY = 'sk-test';
}

describe('CodexBackend multi-turn input stream (Phase 1B)', () => {
  beforeEach(reset);

  test('consumes a queued input-stream message and runs a second turn on the SAME thread', async () => {
    perTurnEvents = [
      [
        { type: 'item.completed', item: { id: 'a1', type: 'agent_message', text: 'turn 1 done' } },
        { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
      ],
      [
        { type: 'item.completed', item: { id: 'a2', type: 'agent_message', text: 'turn 2 done' } },
        { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
      ],
    ];

    const inputStream = new TestInputStream();
    const backend = new CodexBackend({ inputStream });
    const events: BackendEvent[] = [];

    // Drive the generator. Enqueue a follow-up after the first turn_complete,
    // then end the stream after the second.
    let turnCount = 0;
    for await (const event of backend.runStreamed({ ...BASE })) {
      events.push(event);
      if (event.type === 'turn_complete') {
        turnCount += 1;
        if (turnCount === 1) inputStream.enqueueText('please continue');
        else inputStream.end();
      }
    }

    // Two runs on ONE thread instance.
    expect(threadInstances.length).toBe(1);
    expect(runCalls.length).toBe(2);
    expect(runCalls[0].prompt).toBe('initial prompt');
    expect(runCalls[1].prompt).toBe('please continue');

    // Exactly one complete, at the very end, after the stream ended.
    const completes = events.filter((e) => e.type === 'complete');
    expect(completes.length).toBe(1);
    expect(events.at(-1)?.type).toBe('complete');
    // Two turn_complete events (one per turn).
    expect(events.filter((e) => e.type === 'turn_complete').length).toBe(2);
  });

  test('complete fires only after stream end, not between turns', async () => {
    perTurnEvents = [
      [{ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }],
    ];
    const inputStream = new TestInputStream();
    const backend = new CodexBackend({ inputStream });

    const events: BackendEvent[] = [];
    for await (const event of backend.runStreamed({ ...BASE })) {
      events.push(event);
      if (event.type === 'turn_complete') {
        // No `complete` should have been yielded yet — we're parked on it.next().
        expect(events.some((e) => e.type === 'complete')).toBe(false);
        inputStream.end();
      }
    }
    expect(events.at(-1)?.type).toBe('complete');
  });

  test('with no inputStream configured, completes after the first turn (single-shot)', async () => {
    perTurnEvents = [
      [
        { type: 'item.completed', item: { id: 'a1', type: 'agent_message', text: 'one shot' } },
        { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } },
      ],
    ];
    const backend = new CodexBackend({});
    const events: BackendEvent[] = [];
    for await (const event of backend.runStreamed({ ...BASE })) events.push(event);

    expect(runCalls.length).toBe(1);
    expect(events.at(-1)).toEqual({ type: 'complete', summary: 'one shot' });
    expect(events.filter((e) => e.type === 'complete').length).toBe(1);
  });

  test('synthetic result is emitted exactly once across multiple turns (R4)', async () => {
    perTurnEvents = [
      [{ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 50 } }],
      [{ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 50 } }],
    ];
    const inputStream = new TestInputStream();
    const backend = new CodexBackend({ inputStream });
    const progressEvents: any[] = [];

    let turnCount = 0;
    for await (const event of backend.runStreamed({
      ...BASE,
      model: 'gpt-5-codex',
      onProgress: (raw: any) => progressEvents.push(raw),
    })) {
      if (event.type === 'turn_complete') {
        turnCount += 1;
        if (turnCount === 1) inputStream.enqueueText('again');
        else inputStream.end();
      }
    }

    const results = progressEvents.filter((e) => e.type === 'result');
    expect(results.length).toBe(1);
    // Usage aggregates across both turns: 2 * 100 input, 2 * 50 output.
    expect(results[0].usage.byModel['gpt-5-codex']).toMatchObject({
      inputTokens: 200,
      outputTokens: 100,
    });
    expect(results[0].num_turns).toBe(2);
  });

  test('abort signal breaks the turn loop and stops consuming events (R3)', async () => {
    const controller = new AbortController();
    // A turn that yields several items; we abort partway through.
    perTurnEvents = [
      [
        { type: 'item.completed', item: { id: 'c1', type: 'command_execution', status: 'completed', command: 'echo 1' } },
        { type: 'item.completed', item: { id: 'c2', type: 'command_execution', status: 'completed', command: 'echo 2' } },
        { type: 'item.completed', item: { id: 'c3', type: 'command_execution', status: 'completed', command: 'echo 3' } },
        { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } },
      ],
    ];
    const inputStream = new TestInputStream();
    const backend = new CodexBackend({ inputStream });

    const events: BackendEvent[] = [];
    let seen = 0;
    for await (const event of backend.runStreamed({ ...BASE, signal: controller.signal })) {
      events.push(event);
      if (event.type === 'progress') {
        seen += 1;
        if (seen === 1) controller.abort();
      }
    }

    // After abort, the loop must stop — no turn_complete, no further turns.
    expect(events.some((e) => e.type === 'turn_complete')).toBe(false);
    expect(runCalls.length).toBe(1);
    // We should not have processed all three commands after aborting on the first.
    expect(seen).toBeLessThan(3);
  });

  test('aborting before the loop starts yields nothing and runs no turn', async () => {
    const controller = new AbortController();
    controller.abort();
    perTurnEvents = [[{ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }]];
    const backend = new CodexBackend({ inputStream: new TestInputStream() });

    const events: BackendEvent[] = [];
    for await (const event of backend.runStreamed({ ...BASE, signal: controller.signal })) events.push(event);

    expect(runCalls.length).toBe(0);
    expect(events.length).toBe(0);
  });

  test('aborting mid-turn closes the SDK event stream (its finally runs → child.kill, R3)', async () => {
    // Model the SDK's own generator: its `finally` is what kills `codex exec`.
    // We assert that breaking the inner `for await` on abort triggers it.
    let finallyRan = false;
    const controller = new AbortController();

    const sdkEvents = (async function* () {
      try {
        yield { type: 'item.completed', item: { id: 'c1', type: 'command_execution', status: 'completed', command: 'echo 1' } };
        yield { type: 'item.completed', item: { id: 'c2', type: 'command_execution', status: 'completed', command: 'echo 2' } };
        yield { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } };
      } finally {
        finallyRan = true; // mirrors child.kill() in the real SDK
      }
    })();

    // Override the thread to return our instrumented stream.
    mockStartThread.mockImplementationOnce(() => {
      const t = { id: 't', _turn: 0, runStreamed: mock(async () => ({ events: sdkEvents })) };
      threadInstances.push(t);
      return t;
    });

    const backend = new CodexBackend({ inputStream: new TestInputStream() });
    for await (const event of backend.runStreamed({ ...BASE, signal: controller.signal })) {
      if (event.type === 'progress') controller.abort();
    }

    expect(finallyRan).toBe(true);
  });

  test('generator unwinds cleanly when consumer breaks early (R6 no-deadlock)', async () => {
    perTurnEvents = [
      [{ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }],
    ];
    const inputStream = new TestInputStream();
    const backend = new CodexBackend({ inputStream });

    // Consumer breaks on the first turn_complete WITHOUT ending the stream —
    // mirrors workers.ts breaking on the DONE gate. The generator is parked on
    // it.next(); break must trigger .return()/finally and not deadlock.
    for await (const event of backend.runStreamed({ ...BASE })) {
      if (event.type === 'turn_complete') break;
    }

    // If we reach here the for-await completed its cleanup without hanging.
    expect(runCalls.length).toBe(1);
  });
});
