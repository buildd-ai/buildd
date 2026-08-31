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

  // The claim route stores a RESOLVED full model id in tasks.predicted_model
  // (tier registry output), never a bare alias. Comparing full ids is therefore
  // the only comparison that can ever fire in production.
  it('does not flag a full-model-ID prediction that meets the baseline', async () => {
    mockExecuteResult.mockResolvedValue({ rows: [
      { id: 't3', kind: 'engineering', complexity: 'complex', classified_by: 'user', predicted_model: 'claude-opus-4-8' },
    ] });
    const values = mock(() => Promise.resolve());
    mockOutcomesInsert.mockReturnValue({ values });

    await recordTaskOutcome({ taskId: 't3', outcome: 'completed' });
    const payload = (values.mock.calls[0] as any)[0];
    expect(payload.downshifted).toBe(false);
  });

  it('flags a downshift when the predicted model is a full model id below the baseline', async () => {
    mockExecuteResult.mockResolvedValue({ rows: [
      { id: 't4', kind: 'engineering', complexity: 'complex', classified_by: 'organizer', predicted_model: 'claude-sonnet-4-6' },
    ] });
    const values = mock(() => Promise.resolve());
    mockOutcomesInsert.mockReturnValue({ values });

    await recordTaskOutcome({ taskId: 't4', outcome: 'completed' });
    const payload = (values.mock.calls[0] as any)[0];
    // engineering/complex baseline is opus; sonnet-4-6 resolves to the sonnet tier.
    expect(payload.downshifted).toBe(true);
  });

  it('maps tier-vocabulary aliases (premium/standard/budget) onto the baseline order', async () => {
    mockExecuteResult.mockResolvedValue({ rows: [
      { id: 't5', kind: 'engineering', complexity: 'complex', classified_by: 'user', predicted_model: 'budget' },
    ] });
    const values = mock(() => Promise.resolve());
    mockOutcomesInsert.mockReturnValue({ values });

    await recordTaskOutcome({ taskId: 't5', outcome: 'completed' });
    expect((values.mock.calls[0] as any)[0].downshifted).toBe(true);
  });

  it('does not flag a model id that maps to no known tier', async () => {
    mockExecuteResult.mockResolvedValue({ rows: [
      { id: 't6', kind: 'engineering', complexity: 'complex', classified_by: 'user', predicted_model: 'gpt-5.5-codex' },
    ] });
    const values = mock(() => Promise.resolve());
    mockOutcomesInsert.mockReturnValue({ values });

    await recordTaskOutcome({ taskId: 't6', outcome: 'completed' });
    expect((values.mock.calls[0] as any)[0].downshifted).toBe(false);
  });

  it('uses the router BASELINE table, not a local copy (coordination/normal is sonnet)', async () => {
    // model-router.ts says coordination = sonnet/sonnet/opus. A stale duplicate in
    // routing-analytics.ts said opus/opus/opus, which mis-flagged every
    // baseline-tier coordination task as downshifted.
    mockExecuteResult.mockResolvedValue({ rows: [
      { id: 't7', kind: 'coordination', complexity: 'normal', classified_by: 'organizer', predicted_model: 'claude-sonnet-4-6' },
    ] });
    const values = mock(() => Promise.resolve());
    mockOutcomesInsert.mockReturnValue({ values });

    await recordTaskOutcome({ taskId: 't7', outcome: 'completed' });
    expect((values.mock.calls[0] as any)[0].downshifted).toBe(false);
  });

  it('records the actual model the session ran on', async () => {
    mockExecuteResult.mockResolvedValue({ rows: [
      { id: 't8', kind: 'engineering', complexity: 'normal', classified_by: 'user', predicted_model: 'claude-sonnet-4-6' },
    ] });
    const values = mock(() => Promise.resolve());
    mockOutcomesInsert.mockReturnValue({ values });

    await recordTaskOutcome({ taskId: 't8', outcome: 'completed', actualModel: 'claude-sonnet-4-6' });
    expect((values.mock.calls[0] as any)[0].actualModel).toBe('claude-sonnet-4-6');
  });

  it('swallows DB errors (non-fatal telemetry)', async () => {
    mockExecuteResult.mockRejectedValue(new Error('db down'));
    const ok = await recordTaskOutcome({ taskId: 't1', outcome: 'completed' });
    expect(ok).toBe(false);
  });
});
