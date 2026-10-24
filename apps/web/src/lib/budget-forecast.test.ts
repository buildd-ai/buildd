import { describe, it, expect } from 'bun:test';
import { computeBurnRateConfidence, computeMissionBudgetForecast } from './budget-forecast';

describe('computeBurnRateConfidence', () => {
  it('returns low for fewer than 5 samples', () => {
    expect(computeBurnRateConfidence([1, 2, 3])).toBe('low');
    expect(computeBurnRateConfidence([])).toBe('low');
  });

  it('returns low when all costs are zero', () => {
    expect(computeBurnRateConfidence([0, 0, 0, 0, 0])).toBe('low');
  });

  it('returns high for >20 low-variance samples', () => {
    const stable = Array.from({ length: 25 }, () => 1.0);
    expect(computeBurnRateConfidence(stable)).toBe('high');
  });

  it('returns medium for 5-20 low-variance samples', () => {
    const stable = Array.from({ length: 10 }, () => 1.0);
    expect(computeBurnRateConfidence(stable)).toBe('medium');
  });

  it('returns low for high-variance samples', () => {
    // Very spread values → high coefficient of variation
    const noisy = [0.01, 100, 0.01, 100, 0.01, 100];
    expect(computeBurnRateConfidence(noisy)).toBe('low');
  });
});

describe('computeMissionBudgetForecast', () => {
  const make = (id: string, spentUsd: number, budgetUsd: number, status = 'active') => ({
    missionId: id,
    missionTitle: `Mission ${id}`,
    spentUsd,
    budgetUsd,
    status,
  });

  it('returns empty array for no missions', () => {
    expect(computeMissionBudgetForecast([])).toEqual([]);
  });

  it('maps inputs to forecast with pctUsed', () => {
    const result = computeMissionBudgetForecast([make('m1', 50, 100)]);
    expect(result).toHaveLength(1);
    expect(result[0].missionId).toBe('m1');
    expect(result[0].spentUsd).toBe(50);
    expect(result[0].budgetUsd).toBe(100);
    expect(result[0].pctUsed).toBe(50);
    expect(result[0].status).toBe('active');
  });

  it('rounds pctUsed', () => {
    const result = computeMissionBudgetForecast([make('m1', 1, 3)]);
    expect(result[0].pctUsed).toBe(33);
  });

  it('sorts by pctUsed descending', () => {
    const result = computeMissionBudgetForecast([
      make('low', 10, 100),   // 10%
      make('high', 80, 100),  // 80%
      make('mid', 50, 100),   // 50%
    ]);
    expect(result.map(r => r.missionId)).toEqual(['high', 'mid', 'low']);
  });

  it('preserves status field', () => {
    const result = computeMissionBudgetForecast([make('m1', 0, 100, 'paused')]);
    expect(result[0].status).toBe('paused');
  });
});
