import { describe, it, expect, mock, beforeEach } from 'bun:test';

// Resolves to the single task row (or empty rows) that db.execute returns.
const mockExecuteResult = mock(() => Promise.resolve({ rows: [] as any[] }));
const mockOutcomesInsert = mock(() => ({
  values: mock(() => Promise.resolve()),
}));

mock.module('../db', () => ({
  db: {
    execute: mockExecuteResult,
    insert: () => mockOutcomesInsert(),
    // Guard: neither the RQB nor the explicit select builder may be used here.
    // Both can emit references to related tables (workers) via the tasks
    // schema relations, producing "missing FROM-clause entry for table workers"
    // in prod. Only db.execute() with a raw sql template is safe.
    get query(): never {
      throw new Error('recordTaskOutcome must not use db.query (relational query builder)');
    },
    get select(): never {
      throw new Error('recordTaskOutcome must not use db.select (may reference workers via tasks relations)');
    },
  },
}));

mock.module('../db/schema', () => ({
  taskOutcomes: {},
}));

mock.module('drizzle-orm', () => ({
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: any[]) => ({ strings, values, type: 'sql' }),
    { raw: (s: string) => s },
  ),
}));

import { recordTaskOutcome } from '../routing-analytics';

describe('recordTaskOutcome', () => {
  beforeEach(() => {
    mockExecuteResult.mockReset();
    mockExecuteResult.mockResolvedValue({ rows: [] });
    mockOutcomesInsert.mockReset();
    mockOutcomesInsert.mockReturnValue({
      values: mock(() => Promise.resolve()),
    });
  });

  it('returns false when the task is missing', async () => {
    mockExecuteResult.mockResolvedValue({ rows: [] });
    const ok = await recordTaskOutcome({ taskId: 't1', outcome: 'completed' });
    expect(ok).toBe(false);
  });

  it('returns false when the task never went through the router (no predicted_model)', async () => {
    mockExecuteResult.mockResolvedValue({ rows: [
      { id: 't1', kind: 'engineering', complexity: 'normal', classified_by: 'user', predicted_model: null },
    ] });
    const ok = await recordTaskOutcome({ taskId: 't1', outcome: 'completed' });
    expect(ok).toBe(false);
    expect(mockOutcomesInsert).not.toHaveBeenCalled();
  });

  it('writes an outcome row copying taxonomy from the task', async () => {
    mockExecuteResult.mockResolvedValue({ rows: [
      { id: 't1', kind: 'engineering', complexity: 'complex', classified_by: 'organizer', predicted_model: 'sonnet' },
    ] });
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
    expect(payload.classifiedBy).toBe('organizer');
    // engineering/complex baseline is opus, predicted is sonnet → downshifted.
    expect(payload.downshifted).toBe(true);
    expect(payload.totalCostUsd).toBe('0.0123');
    expect(payload.outcome).toBe('completed');
  });

  it('does not flag a baseline-tier prediction as downshifted', async () => {
    mockExecuteResult.mockResolvedValue({ rows: [
      { id: 't2', kind: 'engineering', complexity: 'normal', classified_by: 'user', predicted_model: 'sonnet' },
    ] });
    const values = mock(() => Promise.resolve());
    mockOutcomesInsert.mockReturnValue({ values });

    await recordTaskOutcome({ taskId: 't2', outcome: 'completed' });
    const payload = (values.mock.calls[0] as any)[0];
    expect(payload.downshifted).toBe(false);
  });

  it('never flags a full-model-ID prediction as downshifted', async () => {
    mockExecuteResult.mockResolvedValue({ rows: [
      { id: 't3', kind: 'engineering', complexity: 'complex', classified_by: 'user', predicted_model: 'claude-opus-4-8' },
    ] });
    const values = mock(() => Promise.resolve());
    mockOutcomesInsert.mockReturnValue({ values });

    await recordTaskOutcome({ taskId: 't3', outcome: 'completed' });
    const payload = (values.mock.calls[0] as any)[0];
    expect(payload.downshifted).toBe(false);
  });

  it('swallows DB errors (non-fatal telemetry)', async () => {
    mockExecuteResult.mockRejectedValue(new Error('db down'));
    const ok = await recordTaskOutcome({ taskId: 't1', outcome: 'completed' });
    expect(ok).toBe(false);
  });
});
