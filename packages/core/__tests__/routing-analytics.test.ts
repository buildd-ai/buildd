import { describe, it, expect, mock, beforeEach } from 'bun:test';

const mockTasksFindFirst = mock(() => Promise.resolve(null as any));
const mockOutcomesInsert = mock(() => ({
  values: mock(() => Promise.resolve()),
}));

mock.module('../db', () => ({
  db: {
    query: { tasks: { findFirst: mockTasksFindFirst } },
    insert: () => mockOutcomesInsert(),
  },
}));

mock.module('../db/schema', () => ({
  tasks: { id: 'id' },
  taskOutcomes: {},
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
}));

import { recordTaskOutcome } from '../routing-analytics';

describe('recordTaskOutcome', () => {
  beforeEach(() => {
    mockTasksFindFirst.mockReset();
    mockOutcomesInsert.mockReset();
    mockOutcomesInsert.mockReturnValue({
      values: mock(() => Promise.resolve()),
    });
  });

  it('returns false when the task is missing', async () => {
    mockTasksFindFirst.mockResolvedValue(null);
    const ok = await recordTaskOutcome({ taskId: 't1', outcome: 'completed' });
    expect(ok).toBe(false);
  });

  it('returns false when the task never went through the router (no predictedModel)', async () => {
    mockTasksFindFirst.mockResolvedValue({
      id: 't1', kind: 'engineering', complexity: 'normal', classifiedBy: 'user', predictedModel: null,
    });
    const ok = await recordTaskOutcome({ taskId: 't1', outcome: 'completed' });
    expect(ok).toBe(false);
    expect(mockOutcomesInsert).not.toHaveBeenCalled();
  });

  it('writes an outcome row copying taxonomy from the task', async () => {
    mockTasksFindFirst.mockResolvedValue({
      id: 't1', kind: 'engineering', complexity: 'complex', classifiedBy: 'organizer', predictedModel: 'sonnet',
    });
    const values = mock(() => Promise.resolve());
    mockOutcomesInsert.mockReturnValue({ values });

    const ok = await recordTaskOutcome({
      taskId: 't1',
      accountId: 'acc-1',
      outcome: 'completed',
      totalCostUsd: 0.0123,
      totalTurns: 7,
      durationMs: 12345,
      wasRetried: false,
    });
    expect(ok).toBe(true);
    expect(values).toHaveBeenCalled();
    const payload = (values.mock.calls[0] as any)[0];
    expect(payload.taskId).toBe('t1');
    expect(payload.kind).toBe('engineering');
    expect(payload.complexity).toBe('complex');
    expect(payload.predictedModel).toBe('sonnet');
    // engineering/complex baseline is opus, predicted is sonnet → downshifted.
    expect(payload.downshifted).toBe(true);
    expect(payload.totalCostUsd).toBe('0.0123');
    expect(payload.outcome).toBe('completed');
  });

  it('does not flag a baseline-tier prediction as downshifted', async () => {
    mockTasksFindFirst.mockResolvedValue({
      id: 't2', kind: 'engineering', complexity: 'normal', classifiedBy: 'user', predictedModel: 'sonnet',
    });
    const values = mock(() => Promise.resolve());
    mockOutcomesInsert.mockReturnValue({ values });

    await recordTaskOutcome({ taskId: 't2', outcome: 'completed' });
    const payload = (values.mock.calls[0] as any)[0];
    expect(payload.downshifted).toBe(false);
  });

  it('never flags a full-model-ID prediction as downshifted', async () => {
    mockTasksFindFirst.mockResolvedValue({
      id: 't3', kind: 'engineering', complexity: 'complex', classifiedBy: 'user',
      predictedModel: 'claude-opus-4-7',
    });
    const values = mock(() => Promise.resolve());
    mockOutcomesInsert.mockReturnValue({ values });

    await recordTaskOutcome({ taskId: 't3', outcome: 'completed' });
    const payload = (values.mock.calls[0] as any)[0];
    expect(payload.downshifted).toBe(false);
  });

  it('swallows DB errors (non-fatal telemetry)', async () => {
    mockTasksFindFirst.mockRejectedValue(new Error('db down'));
    const ok = await recordTaskOutcome({ taskId: 't1', outcome: 'completed' });
    expect(ok).toBe(false);
  });
});
