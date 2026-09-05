/**
 * Unit tests for packages/core/worker-messages.ts
 *
 * The worker→worker message queue lives in `tasks.context.pendingWorkerMessages`.
 * Two operations, and the invariant that separates them: a message is only ever
 * removed from the queue by an ACK naming its id. Nothing else may clear it —
 * that is what made every auto-generated overlap message in production
 * unreadable (drained by the PATCH route before any consumer saw it).
 */

import { describe, it, expect, mock, beforeEach } from 'bun:test';

// ── DB mock ──────────────────────────────────────────────────────────────────

const mockTasksFindFirst = mock(async (_opts?: any) => null as any);
const setCalls: any[] = [];
const mockUpdate = mock((_table: any) => ({
  set: mock((vals: any) => {
    setCalls.push(vals);
    return { where: mock(() => Promise.resolve()) };
  }),
}));

mock.module('../db', () => ({
  db: {
    query: { tasks: { findFirst: mockTasksFindFirst } },
    update: mockUpdate,
  },
}));
mock.module('../db/schema', () => ({ tasks: { id: 'id', context: 'context' } }));
mock.module('drizzle-orm', () => ({ eq: (a: any, b: any) => ({ a, b, type: 'eq' }) }));

const {
  WORKER_MESSAGE_CAP,
  buildWorkerMessage,
  enqueueWorkerMessage,
  clearWorkerMessages,
} = await import('../worker-messages');

const TASK = 'task-recipient';
const SENDER = 'task-sender';

function msg(id: string) {
  return {
    id,
    type: 'question' as const,
    fromTaskId: SENDER,
    sentAt: '2026-09-04T00:00:00.000Z',
    hopCount: 0,
    body: { text: id },
  };
}

beforeEach(() => {
  setCalls.length = 0;
  mockTasksFindFirst.mockReset();
  mockUpdate.mockClear();
});

// ── buildWorkerMessage ───────────────────────────────────────────────────────

describe('buildWorkerMessage', () => {
  it('stamps id/sentAt and defaults hopCount to 0', () => {
    const m = buildWorkerMessage({
      type: 'path_released',
      fromTaskId: SENDER,
      toTaskId: TASK,
      body: { paths: ['src/a.ts'], releasedAt: '2026-09-04T00:00:00.000Z' },
    });
    expect(m.id).toMatch(/[0-9a-f-]{36}/);
    expect(m.type).toBe('path_released');
    expect(m.hopCount).toBe(0);
    expect(typeof m.sentAt).toBe('string');
    expect(m.body).toEqual({ paths: ['src/a.ts'], releasedAt: '2026-09-04T00:00:00.000Z' });
  });
});

// ── enqueueWorkerMessage ─────────────────────────────────────────────────────

describe('enqueueWorkerMessage', () => {
  it('appends to an existing queue', async () => {
    mockTasksFindFirst.mockResolvedValue({ context: { pendingWorkerMessages: [msg('m1')] } });
    const ok = await enqueueWorkerMessage(TASK, msg('m2'));
    expect(ok).toBe(true);
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0].context.pendingWorkerMessages.map((m: any) => m.id)).toEqual(['m1', 'm2']);
  });

  it('creates the queue when the task context has none, preserving other keys', async () => {
    mockTasksFindFirst.mockResolvedValue({ context: { model: 'claude-sonnet-5' } });
    await enqueueWorkerMessage(TASK, msg('m1'));
    expect(setCalls[0].context.model).toBe('claude-sonnet-5');
    expect(setCalls[0].context.pendingWorkerMessages.map((m: any) => m.id)).toEqual(['m1']);
  });

  it('handles a null context', async () => {
    mockTasksFindFirst.mockResolvedValue({ context: null });
    const ok = await enqueueWorkerMessage(TASK, msg('m1'));
    expect(ok).toBe(true);
    expect(setCalls[0].context.pendingWorkerMessages).toHaveLength(1);
  });

  it('caps the queue at WORKER_MESSAGE_CAP, dropping the oldest', async () => {
    expect(WORKER_MESSAGE_CAP).toBe(3);
    mockTasksFindFirst.mockResolvedValue({
      context: { pendingWorkerMessages: [msg('m1'), msg('m2'), msg('m3')] },
    });
    await enqueueWorkerMessage(TASK, msg('m4'));
    expect(setCalls[0].context.pendingWorkerMessages.map((m: any) => m.id)).toEqual(['m2', 'm3', 'm4']);
  });

  it('returns false and writes nothing when the task does not exist', async () => {
    mockTasksFindFirst.mockResolvedValue(null);
    const ok = await enqueueWorkerMessage(TASK, msg('m1'));
    expect(ok).toBe(false);
    expect(setCalls).toHaveLength(0);
  });
});

// ── clearWorkerMessages ──────────────────────────────────────────────────────

describe('clearWorkerMessages', () => {
  it('removes only the acked ids and keeps the rest queued', async () => {
    mockTasksFindFirst.mockResolvedValue({
      context: { pendingWorkerMessages: [msg('m1'), msg('m2'), msg('m3')] },
    });
    const cleared = await clearWorkerMessages(TASK, ['m2']);
    expect(cleared).toBe(1);
    expect(setCalls[0].context.pendingWorkerMessages.map((m: any) => m.id)).toEqual(['m1', 'm3']);
  });

  it('writes nothing when no id matches — an unknown ack must not empty the queue', async () => {
    mockTasksFindFirst.mockResolvedValue({
      context: { pendingWorkerMessages: [msg('m1')] },
    });
    const cleared = await clearWorkerMessages(TASK, ['nope']);
    expect(cleared).toBe(0);
    expect(setCalls).toHaveLength(0);
  });

  it('writes nothing when the ack list is empty', async () => {
    const cleared = await clearWorkerMessages(TASK, []);
    expect(cleared).toBe(0);
    expect(mockTasksFindFirst).not.toHaveBeenCalled();
    expect(setCalls).toHaveLength(0);
  });
});
