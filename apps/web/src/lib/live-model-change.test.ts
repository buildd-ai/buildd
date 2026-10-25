import { describe, test, expect } from 'bun:test';
import { liveModelChangeNotice, pendingModelChangeRecord, readPendingModelChange, PENDING_MODEL_CHANGE_KEY } from './live-model-change';

describe('liveModelChangeNotice', () => {
  test('names the tier and model the live run was claimed with', () => {
    const n = liveModelChangeNotice(
      { predictedModel: 'claude-sonnet-5-5', context: { resolvedTier: { tier: 'standard' } } },
      { id: 'w-1', status: 'running' },
    );
    expect(n).toMatchObject({ appliesTo: 'next_attempt', workerId: 'w-1', runningTier: 'standard', runningModel: 'claude-sonnet-5-5' });
    expect(n.message).toContain('still running at standard, claude-sonnet-5-5');
    expect(n.message).toContain('status: pending');
  });

  test('falls back to context.model, and to plain words when nothing was recorded', () => {
    expect(liveModelChangeNotice({ context: { model: 'claude-x' } }, { id: 'w', status: 'running' }).runningModel).toBe('claude-x');
    expect(liveModelChangeNotice({ context: null }, { id: 'w', status: 'running' }).message).toContain('the model it was claimed with');
  });
});

describe('pending model change record', () => {
  test('round-trips through the context key', () => {
    const notice = liveModelChangeNotice({ context: { resolvedTier: { tier: 'standard' } } }, { id: 'w-1', status: 'running' });
    const rec = pendingModelChangeRecord(notice, { tier: 'premium' }, new Date('2026-10-24T00:00:00Z'));
    expect(rec).toEqual({ tier: 'premium', runningTier: 'standard', runningModel: null, workerId: 'w-1', at: '2026-10-24T00:00:00.000Z' });
    expect(readPendingModelChange({ [PENDING_MODEL_CHANGE_KEY]: rec })).toEqual(rec);
  });

  test('reads null for absent or malformed values', () => {
    expect(readPendingModelChange({})).toBeNull();
    expect(readPendingModelChange({ [PENDING_MODEL_CHANGE_KEY]: 'x' })).toBeNull();
    expect(readPendingModelChange(null)).toBeNull();
  });
});
