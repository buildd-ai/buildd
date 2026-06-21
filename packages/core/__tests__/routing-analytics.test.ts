import { describe, it, expect, mock, beforeEach } from 'bun:test';

// Resolves to the single task row (or null) that the explicit select returns.
const mockTaskRow = mock(() => Promise.resolve(null as any));
const mockOutcomesInsert = mock(() => ({
  values: mock(() => Promise.resolve()),
}));

// Chainable builder mirroring db.select(...).from(...).where(...).limit(...).
const selectBuilder: any = {
  from: () => selectBuilder,
  where: () => selectBuilder,
  limit: async () => {
    const row = await mockTaskRow();
    return row ? [row] : [];
  },
};

mock.module('../db', () => ({
  db: {
    select: () => selectBuilder,
    insert: () => mockOutcomesInsert(),
    // Guard: the relational query builder must NOT be used here — it can emit
    // references to related tables (workers) and caused intermittent
    // "missing FROM-clause entry for table workers" failures in prod.
    get query(): never {
      throw new Error('recordTaskOutcome must not use db.query (relational query builder)');
    },
  },
}));

mock.module('../db/schema', () => ({
  tasks: { id: 'id', kind: 'kind', complexity: 'complexity', classifiedBy: 'classified_by', predictedModel: 'predicted_model' },
  taskOutcomes: {},
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
}));

import { recordTaskOutcome } from '../routing-analytics';

describe('recordTaskOutcome', () => {
  beforeEach(() => {
    mockTaskRow.mockReset();
    mockOutcomesInsert.mockReset();
    mockOutcomesInsert.mockReturnValue({
      values: mock(() => Promise.resolve()),
    });
  });

  it('returns false when the task is missing', async () => {
    mockTaskRow.mockResolvedValue(null);
    const ok = await recordTaskOutcome({ taskId: 't1', outcome: 'completed' });
    expect(ok).toBe(false);
  });

  it('returns false when the task never went through the router (no predictedModel)', async () => {
    mockTaskRow.mockResolvedValue({
      id: 't1', kind: 'engineering', complexity: 'normal', classifiedBy: 'user', predictedModel: null,
    });
    const ok = await recordTaskOutcome({ taskId: 't1', outcome: 'completed' });
    expect(ok).toBe(false);
    expect(mockOutcomesInsert).not.toHaveBeenCalled();
  });

  it('writes an outcome row copying taxonomy from the task', async () => {
    mockTaskRow.mockResolvedValue({
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
    mockTaskRow.mockResolvedValue({
      id: 't2', kind: 'engineering', complexity: 'normal', classifiedBy: 'user', predictedModel: 'sonnet',
    });
    const values = mock(() => Promise.resolve());
    mockOutcomesInsert.mockReturnValue({ values });

    await recordTaskOutcome({ taskId: 't2', outcome: 'completed' });
    const payload = (values.mock.calls[0] as any)[0];
    expect(payload.downshifted).toBe(false);
  });

  it('never flags a full-model-ID prediction as downshifted', async () => {
    mockTaskRow.mockResolvedValue({
      id: 't3', kind: 'engineering', complexity: 'complex', classifiedBy: 'user',
      predictedModel: 'claude-opus-4-8',
    });
    const values = mock(() => Promise.resolve());
    mockOutcomesInsert.mockReturnValue({ values });

    await recordTaskOutcome({ taskId: 't3', outcome: 'completed' });
    const payload = (values.mock.calls[0] as any)[0];
    expect(payload.downshifted).toBe(false);
  });

  it('swallows DB errors (non-fatal telemetry)', async () => {
    mockTaskRow.mockRejectedValue(new Error('db down'));
    const ok = await recordTaskOutcome({ taskId: 't1', outcome: 'completed' });
    expect(ok).toBe(false);
  });
});
