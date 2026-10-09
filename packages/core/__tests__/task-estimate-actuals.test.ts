import { describe, it, expect } from 'bun:test';
import { computeTaskActuals } from '../task-estimate-actuals';
import { actualOf } from '../estimate-backtest-source';

const T0 = Date.UTC(2026, 0, 1, 10, 0, 0);
const at = (min: number) => new Date(T0 + min * 60_000);
const s = (a: number, b: number, extra: Record<string, unknown> = {}) =>
  ({ taskId: 't', startedAt: at(a), completedAt: at(b), inputTokens: 100, outputTokens: 50, ...extra });

describe('computeTaskActuals', () => {
  it('sums agent minutes and tokens over every worker, as the backtest does', () => {
    const sessions = [s(0, 10), s(30, 50)];
    const a = computeTaskActuals({ taskClass: 'work', sessions })!;
    expect(a.agentMinutes).toBe(30);
    expect(a.tokens).toBe(300);
    expect(a.workerCount).toBe(2);
    expect({ minutes: a.agentMinutes, tokens: a.tokens }).toEqual(actualOf(sessions));
  });

  it('wall time runs first start to merge, not to the last session', () => {
    const a = computeTaskActuals({ taskClass: 'work', sessions: [s(0, 10), s(30, 50, { mergedAt: at(90) })] })!;
    expect(a.wallMinutes).toBe(90);
    expect(a.wallBasis).toBe('merge');
    expect(a.firstStartedAt).toEqual(at(0));
  });

  it('falls back to the last session end when nothing merged', () => {
    const a = computeTaskActuals({ taskClass: 'work', sessions: [s(0, 10), s(30, 50)] })!;
    expect(a.wallMinutes).toBe(50);
    expect(a.wallBasis).toBe('last_session');
  });

  it('counts only attempt children as repairs', () => {
    const a = computeTaskActuals({
      taskClass: 'work', sessions: [s(0, 10)],
      children: [{ taskClass: 'attempt' }, { taskClass: 'attempt' }, { taskClass: 'bookkeeping' }, { taskClass: 'work' }],
    })!;
    expect(a.repairs).toBe(2);
  });

  it('has no actuals for attempt or bookkeeping tasks', () => {
    expect(computeTaskActuals({ taskClass: 'attempt', sessions: [s(0, 10)] })).toBeNull();
    expect(computeTaskActuals({ taskClass: 'bookkeeping', sessions: [s(0, 10)] })).toBeNull();
  });

  it('has no actuals without a finished session', () => {
    expect(computeTaskActuals({ taskClass: 'work', sessions: [] })).toBeNull();
    expect(computeTaskActuals({ taskClass: 'work', sessions: [{ taskId: 't', startedAt: at(0), completedAt: null }] })).toBeNull();
    expect(computeTaskActuals({ taskClass: 'work', sessions: [s(5, 5)] })).toBeNull();
  });
});
