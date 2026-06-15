/**
 * Unit tests for the AgentBackend abstraction:
 * - inferSandboxMode: infers sandbox mode from task.kind
 * - createBackend: factory returns correct backend type
 * - ClaudeBackend.runStreamed: yields BackendEvents and calls onProgress
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test';

// ─── Mocks ───────────────────────────────────────────────────────────────────
// Must be before any imports that transitively use these modules.

let mockMessages: any[] = [];
let mockStreamInputFn = mock(() => {});

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (_opts: any) => {
    const msgs = [...mockMessages];
    let idx = 0;
    return {
      streamInput: mockStreamInputFn,
      supportedModels: async () => [],
      [Symbol.asyncIterator]() {
        return {
          async next() {
            if (idx < msgs.length) {
              return { value: msgs[idx++], done: false };
            }
            return { value: undefined, done: true };
          },
        };
      },
    };
  },
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { inferSandboxMode, createBackend, ClaudeBackend, CodexBackend } from '../../src/backends/index';
import type { BackendEvent } from '../../src/backends/types';

// ─── inferSandboxMode ─────────────────────────────────────────────────────────

describe('inferSandboxMode', () => {
  test('research → read-only', () => {
    expect(inferSandboxMode('research')).toBe('read-only');
  });

  test('analysis → read-only', () => {
    expect(inferSandboxMode('analysis')).toBe('read-only');
  });

  test('observation → read-only', () => {
    expect(inferSandboxMode('observation')).toBe('read-only');
  });

  test('engineering → workspace-write', () => {
    expect(inferSandboxMode('engineering')).toBe('workspace-write');
  });

  test('writing → workspace-write', () => {
    expect(inferSandboxMode('writing')).toBe('workspace-write');
  });

  test('design → workspace-write', () => {
    expect(inferSandboxMode('design')).toBe('workspace-write');
  });

  test('coordination → workspace-write', () => {
    expect(inferSandboxMode('coordination')).toBe('workspace-write');
  });

  test('null kind → workspace-write', () => {
    expect(inferSandboxMode(null)).toBe('workspace-write');
  });

  test('undefined kind → workspace-write', () => {
    expect(inferSandboxMode(undefined)).toBe('workspace-write');
  });
});

// ─── createBackend factory ────────────────────────────────────────────────────

describe('createBackend', () => {
  test('returns ClaudeBackend for "claude"', () => {
    const backend = createBackend('claude', {
      options: {},
      inputStream: (async function* () {})(),
    });
    expect(backend).toBeInstanceOf(ClaudeBackend);
  });

  test('returns CodexBackend for "codex"', () => {
    const backend = createBackend('codex', {});
    expect(backend).toBeInstanceOf(CodexBackend);
  });
});

// ─── ClaudeBackend.runStreamed ────────────────────────────────────────────────

describe('ClaudeBackend.runStreamed', () => {
  beforeEach(() => {
    mockMessages = [];
    mockStreamInputFn.mockClear();
  });

  async function* emptyStream() {}

  async function collectEvents(messages: any[]): Promise<BackendEvent[]> {
    mockMessages = messages;
    const backend = new ClaudeBackend({
      options: {},
      inputStream: emptyStream(),
    });
    const events: BackendEvent[] = [];
    for await (const event of backend.runStreamed({
      prompt: 'test prompt',
      sessionId: 'sess-1',
      cwd: '/tmp',
    })) {
      events.push(event);
    }
    return events;
  }

  test('yields progress for assistant text blocks', async () => {
    const events = await collectEvents([
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Hello world' }] },
      },
      { type: 'result', subtype: 'success' },
    ]);

    expect(events.some(e => e.type === 'progress' && (e as any).message === 'Hello world')).toBe(true);
  });

  test('yields turn_complete on SDK result', async () => {
    const events = await collectEvents([
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Done' }] },
      },
      { type: 'result', subtype: 'success' },
    ]);

    expect(events.some(e => e.type === 'turn_complete')).toBe(true);
  });

  test('yields complete at end', async () => {
    const events = await collectEvents([
      { type: 'result', subtype: 'success' },
    ]);

    const last = events[events.length - 1];
    expect(last?.type).toBe('complete');
  });

  test('calls onProgress for each SDK message', async () => {
    mockMessages = [
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Hi' }] } },
      { type: 'result', subtype: 'success' },
    ];

    const backend = new ClaudeBackend({
      options: {},
      inputStream: emptyStream(),
    });

    const progressEvents: unknown[] = [];
    for await (const _ of backend.runStreamed({
      prompt: 'test',
      sessionId: 'sess-1',
      cwd: '/tmp',
      onProgress: (e) => { progressEvents.push(e); },
    })) {
      // consume
    }

    expect(progressEvents.length).toBeGreaterThanOrEqual(2);
    expect((progressEvents[0] as any).type).toBe('assistant');
    expect((progressEvents[1] as any).type).toBe('result');
  });

  test('connects inputStream to queryInstance', async () => {
    mockMessages = [{ type: 'result', subtype: 'success' }];

    const backend = new ClaudeBackend({
      options: {},
      inputStream: emptyStream(),
    });

    for await (const _ of backend.runStreamed({
      prompt: 'test',
      sessionId: 's1',
      cwd: '/tmp',
    })) {}

    expect(mockStreamInputFn).toHaveBeenCalled();
  });

  test('calls onInit with queryInstance before first message', async () => {
    mockMessages = [{ type: 'result', subtype: 'success' }];

    let initCalledWith: any = null;
    const backend = new ClaudeBackend({
      options: {},
      inputStream: emptyStream(),
      onInit: (qi) => { initCalledWith = qi; },
    });

    for await (const _ of backend.runStreamed({
      prompt: 'test',
      sessionId: 's1',
      cwd: '/tmp',
    })) {}

    expect(initCalledWith).not.toBeNull();
    expect(typeof initCalledWith.streamInput).toBe('function');
  });

  test('includes structured output in turn_complete', async () => {
    const events = await collectEvents([
      { type: 'result', subtype: 'success', structured_output: { answer: 42 } },
    ]);

    const turnComplete = events.find(e => e.type === 'turn_complete');
    expect((turnComplete as any)?.structuredOutput).toEqual({ answer: 42 });
  });

  test('includes text summary in complete event', async () => {
    const events = await collectEvents([
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Final answer' }] },
      },
      { type: 'result', subtype: 'success' },
    ]);

    const complete = events.find(e => e.type === 'complete') as any;
    expect(complete?.summary).toBe('Final answer');
  });

  test('skips empty text blocks', async () => {
    const events = await collectEvents([
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: '   ' }] },
      },
      { type: 'result', subtype: 'success' },
    ]);

    // Should not yield a progress event for whitespace-only text
    expect(events.filter(e => e.type === 'progress').length).toBe(0);
  });

  test('exposes queryInstance field after iteration starts', async () => {
    mockMessages = [{ type: 'result', subtype: 'success' }];

    const backend = new ClaudeBackend({
      options: {},
      inputStream: emptyStream(),
    });

    // Not set before iteration
    expect(backend.queryInstance).toBeNull();

    let instanceDuringInit: any = null;
    backend['config'] = {
      ...backend['config'],
      onInit: (qi) => { instanceDuringInit = qi; },
    };

    for await (const _ of backend.runStreamed({ prompt: 'test', sessionId: 's', cwd: '/tmp' })) {}

    expect(instanceDuringInit).not.toBeNull();
    expect(backend.queryInstance).not.toBeNull();
  });
});
