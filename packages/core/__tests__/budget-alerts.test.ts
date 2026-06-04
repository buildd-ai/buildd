import { describe, it, expect } from 'bun:test';
import {
  applyBudgetUsage,
  budgetMonthKey,
  BUDGET_ALERT_THRESHOLDS,
  type BudgetState,
} from '../budget-alerts';

const JUNE = new Date('2026-06-10T12:00:00Z');
const JULY = new Date('2026-07-01T00:00:00Z');

function fresh(overrides: Partial<BudgetState> = {}): BudgetState {
  return { monthlyCostUsd: 0, monthlyCostMonth: null, alertsSent: [], ...overrides };
}

describe('budgetMonthKey', () => {
  it('formats UTC year-month, zero-padded', () => {
    expect(budgetMonthKey(new Date('2026-06-10T12:00:00Z'))).toBe('2026-06');
    expect(budgetMonthKey(new Date('2026-12-31T23:59:59Z'))).toBe('2026-12');
  });
});

describe('applyBudgetUsage', () => {
  it('accumulates spend within the same month', () => {
    const r1 = applyBudgetUsage(fresh(), 10, 100, JUNE);
    expect(r1.monthlyCostUsd).toBe(10);
    expect(r1.monthlyCostMonth).toBe('2026-06');

    const r2 = applyBudgetUsage(
      { monthlyCostUsd: r1.monthlyCostUsd, monthlyCostMonth: r1.monthlyCostMonth, alertsSent: r1.alertsSent },
      15,
      100,
      JUNE,
    );
    expect(r2.monthlyCostUsd).toBe(25);
  });

  it('resets the running total and alerts on a new month', () => {
    const state = fresh({ monthlyCostUsd: 90, monthlyCostMonth: '2026-06', alertsSent: [50, 80] });
    const r = applyBudgetUsage(state, 5, 100, JULY);
    expect(r.monthlyCostMonth).toBe('2026-07');
    expect(r.monthlyCostUsd).toBe(5);
    expect(r.alertsSent).toEqual([]);
    expect(r.crossed).toEqual([]);
  });

  it('fires a threshold once when crossed', () => {
    const r = applyBudgetUsage(fresh(), 55, 100, JUNE);
    expect(r.crossed).toEqual([50]);
    expect(r.alertsSent).toEqual([50]);
  });

  it('does not re-fire an already-sent threshold', () => {
    const state = fresh({ monthlyCostUsd: 55, monthlyCostMonth: '2026-06', alertsSent: [50] });
    const r = applyBudgetUsage(state, 10, 100, JUNE); // now $65, still in 50% band
    expect(r.crossed).toEqual([]);
    expect(r.alertsSent).toEqual([50]);
  });

  it('fires multiple thresholds when a single charge jumps past several', () => {
    const r = applyBudgetUsage(fresh(), 100, 100, JUNE); // 0 -> 100%
    expect(r.crossed).toEqual([50, 80, 100]);
  });

  it('fires the next threshold on a later charge', () => {
    const state = fresh({ monthlyCostUsd: 55, monthlyCostMonth: '2026-06', alertsSent: [50] });
    const r = applyBudgetUsage(state, 30, 100, JUNE); // $85 -> crosses 80
    expect(r.crossed).toEqual([80]);
    expect(r.alertsSent).toEqual([50, 80]);
  });

  it('does not alert when no budget is configured', () => {
    const r = applyBudgetUsage(fresh(), 500, null, JUNE);
    expect(r.monthlyCostUsd).toBe(500);
    expect(r.crossed).toEqual([]);
  });

  it('ignores non-positive or non-finite charges', () => {
    expect(applyBudgetUsage(fresh(), 0, 100, JUNE).monthlyCostUsd).toBe(0);
    expect(applyBudgetUsage(fresh(), -5, 100, JUNE).monthlyCostUsd).toBe(0);
    expect(applyBudgetUsage(fresh(), NaN, 100, JUNE).monthlyCostUsd).toBe(0);
  });

  it('exposes the expected default thresholds', () => {
    expect(BUDGET_ALERT_THRESHOLDS).toEqual([50, 80, 100]);
  });
});
