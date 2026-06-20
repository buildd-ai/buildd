import { describe, test, expect, mock, beforeEach } from 'bun:test';

// ---------------------------------------------------------------------------
// Structured-output repair (Phase 3A). The Codex SDK has no schema param, so
// the backend JSON.parses agent_message text. When opts.outputSchema is present
// and the parse fails (or doesn't validate), the backend self-drives ONE repair
// turn on the SAME thread asking the agent to re-emit valid JSON, then re-parses
// next turn. This is independent of the external inputStream (review/nudges).
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

const BASE = { prompt: 'initial prompt', sessionId: 's', cwd: '/tmp' } as const;
const SCHEMA = { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } } as Record<string, unknown>;

function reset() {
  perTurnEvents = [];
  runCalls = [];
  threadInstances = [];
  mockStartThread.mockClear();
  mockCodexConstructor.mockClear();
  process.env.OPENAI_API_KEY = 'sk-test';
}

function turn(text: string) {
  return [
    { type: 'item.completed', item: { id: 'a', type: 'agent_message', text } },
    { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } },
  ];
}

describe('CodexBackend structured-output repair (Phase 3A)', () => {
  beforeEach(reset);

  test('parse failure → ONE repair nudge → success on the re-output', async () => {
    perTurnEvents = [
      turn('here is the result, no json sorry'), // invalid
      turn('{"ok":true}'),                         // repaired
    ];

    const backend = new CodexBackend({}); // no external inputStream
    const events: BackendEvent[] = [];
    for await (const event of backend.runStreamed({ ...BASE, outputSchema: SCHEMA })) {
      events.push(event);
    }

    // Backend self-drove a second turn (the repair) on the SAME thread.
    expect(threadInstances.length).toBe(1);
    expect(runCalls.length).toBe(2);
    // The repair prompt mentions JSON / schema so the agent knows what to do.
    expect(runCalls[1].prompt.toLowerCase()).toContain('json');

    // Final complete carries the repaired, parsed structured output.
    const complete = events.at(-1) as any;
    expect(complete.type).toBe('complete');
    expect(complete.structuredOutput).toEqual({ ok: true });
  });

  test('valid JSON on the first turn → NO repair nudge', async () => {
    perTurnEvents = [turn('{"ok":true}')];

    const backend = new CodexBackend({});
    const events: BackendEvent[] = [];
    for await (const event of backend.runStreamed({ ...BASE, outputSchema: SCHEMA })) {
      events.push(event);
    }

    // Single turn — no repair.
    expect(runCalls.length).toBe(1);
    const complete = events.at(-1) as any;
    expect(complete.structuredOutput).toEqual({ ok: true });
  });

  test('repair attempts are capped — does not loop forever on persistent failure', async () => {
    // Every turn returns invalid JSON; backend must stop after the cap.
    perTurnEvents = [
      turn('nope 1'),
      turn('nope 2'),
      turn('nope 3'),
      turn('nope 4'),
    ];

    const backend = new CodexBackend({});
    const events: BackendEvent[] = [];
    for await (const event of backend.runStreamed({ ...BASE, outputSchema: SCHEMA })) {
      events.push(event);
    }

    // Initial turn + at most 2 repair attempts = 3 runs max; then completes
    // (without structuredOutput) rather than spinning.
    expect(runCalls.length).toBeLessThanOrEqual(3);
    expect(runCalls.length).toBeGreaterThanOrEqual(2);
    const complete = events.at(-1) as any;
    expect(complete.type).toBe('complete');
    expect(complete.structuredOutput).toBeUndefined();
  });

  test('no repair when outputSchema is absent (free-form output)', async () => {
    perTurnEvents = [turn('just some prose, not json')];

    const backend = new CodexBackend({});
    const events: BackendEvent[] = [];
    for await (const event of backend.runStreamed({ ...BASE })) {
      events.push(event);
    }

    expect(runCalls.length).toBe(1);
    expect((events.at(-1) as any).structuredOutput).toBeUndefined();
  });

  test('JSON parses but fails schema validation → repair nudge fires', async () => {
    perTurnEvents = [
      turn('{"wrong":"shape"}'), // parses but missing required `ok`
      turn('{"ok":false}'),       // valid
    ];

    const backend = new CodexBackend({});
    const events: BackendEvent[] = [];
    for await (const event of backend.runStreamed({ ...BASE, outputSchema: SCHEMA })) {
      events.push(event);
    }

    expect(runCalls.length).toBe(2);
    expect((events.at(-1) as any).structuredOutput).toEqual({ ok: false });
  });
});
