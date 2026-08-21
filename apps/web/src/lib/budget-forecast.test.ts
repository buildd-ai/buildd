import { describe, it, expect } from 'bun:test';
import {
  computeMonthlyBudgetForecast,
  computeBurnRateConfidence,
  computeMissionBudgetForecast,
  oauthEpisodeConfidence,
  type MonthlyBudgetInput,
  type MissionBudgetInput,
} from './budget-forecast';

// ── computeMonthlyBudgetForecast ──────────────────────────────────────────────

describe('computeMonthlyBudgetForecast', () => {
  const baseInput: MonthlyBudgetInput = {
    budgetUsd: 100,
    spentUsd: 45,
    resetsAt: new Date('2026-09-01T00:00:00Z'),
    recentWorkerCosts: [2, 3, 2.5, 1.5, 3, 2, 2.5, 3.5, 1, 2], // 10 workers, avg $2.35/worker
    now: new Date('2026-08-08T12:00:00Z'),
  };

  it('computes pctUsed correctly', () => {
    const result = computeMonthlyBudgetForecast(baseInput);
    expect(result.pctUsed).toBe(45);
  });

  it('computes burn rate from recent workers', () => {
    const result = computeMonthlyBudgetForecast(baseInput);
    // 10 workers in 24h = total spend $23, burn rate $23/day
    // sum([2,3,2.5,1.5,3,2,2.5,3.5,1,2]) = 23
    expect(result.burnRateUsdPerDay).toBeCloseTo(23, 1);
  });

  it('computes daysToDepletion correctly', () => {
    const result = computeMonthlyBudgetForecast(baseInput);
    const remaining = 100 - 45;
    const burnRate = 23;
    expect(result.daysToDepletion).toBeCloseTo(remaining / burnRate, 1);
  });

  it('returns null daysToDepletion when burn rate is zero', () => {
    const result = computeMonthlyBudgetForecast({
      ...baseInput,
      recentWorkerCosts: [],
    });
    expect(result.daysToDepletion).toBeNull();
    expect(result.burnRateUsdPerDay).toBeNull();
  });

  it('caps daysToDepletion at budget reset date', () => {
    // Low burn, budget runs out after reset — clamp at daysToReset
    const result = computeMonthlyBudgetForecast({
      ...baseInput,
      spentUsd: 1,
      recentWorkerCosts: [0.01, 0.01], // tiny burn, would take years
    });
    // Should cap at days until resetsAt
    const daysToReset = (new Date('2026-09-01T00:00:00Z').getTime() - new Date('2026-08-08T12:00:00Z').getTime()) / (24 * 60 * 60 * 1000);
    expect(result.daysToDepletion).toBeCloseTo(daysToReset, 0);
  });

  it('includes resetsAt as ISO string', () => {
    const result = computeMonthlyBudgetForecast(baseInput);
    expect(result.resetsAt).toBe('2026-09-01T00:00:00.000Z');
  });
});

// ── computeBurnRateConfidence ─────────────────────────────────────────────────

describe('computeBurnRateConfidence', () => {
  it('returns low when fewer than 5 samples', () => {
    expect(computeBurnRateConfidence([1, 2, 3])).toBe('low');
    expect(computeBurnRateConfidence([])).toBe('low');
  });

  it('returns medium for 5-20 samples with moderate variance', () => {
    const samples = [2, 2.5, 1.8, 2.2, 2.1, 1.9]; // 6 samples, low variance
    expect(computeBurnRateConfidence(samples)).toBe('medium');
  });

  it('returns high for more than 20 steady samples', () => {
    const samples = Array.from({ length: 25 }, () => 2.0);
    expect(computeBurnRateConfidence(samples)).toBe('high');
  });

  it('returns low for high variance even with many samples', () => {
    // Very spiky burn: near-zero and very large values
    const samples = [0.01, 100, 0.01, 100, 0.01, 100, 0.01, 100, 0.01, 100];
    expect(computeBurnRateConfidence(samples)).toBe('low');
  });
});

// ── computeMissionBudgetForecast ──────────────────────────────────────────────

describe('computeMissionBudgetForecast', () => {
  const missions: MissionBudgetInput[] = [
    { missionId: 'm1', missionTitle: 'Alpha', spentUsd: 8, budgetUsd: 10, status: 'active' },
    { missionId: 'm2', missionTitle: 'Beta', spentUsd: 20, budgetUsd: 100, status: 'active' },
    { missionId: 'm3', missionTitle: 'Gamma', spentUsd: 9.5, budgetUsd: 10, status: 'budget_exhausted' },
  ];

  it('computes pctUsed for each mission', () => {
    const result = computeMissionBudgetForecast(missions);
    // Sorted descending: Gamma 95%, Alpha 80%, Beta 20%
    expect(result[0].pctUsed).toBe(95);   // Gamma: 9.5/10
    expect(result[1].pctUsed).toBe(80);   // Alpha: 8/10
    expect(result[2].pctUsed).toBe(20);   // Beta: 20/100
  });

  it('sorts by pctUsed descending', () => {
    const result = computeMissionBudgetForecast(missions);
    expect(result[0].missionId).toBe('m3'); // 95%
    expect(result[1].missionId).toBe('m1'); // 80%
    expect(result[2].missionId).toBe('m2'); // 20%
  });

  it('preserves status', () => {
    const result = computeMissionBudgetForecast(missions);
    const gamma = result.find(m => m.missionId === 'm3');
    expect(gamma?.status).toBe('budget_exhausted');
  });
});

// ── Sparse / missing data ─────────────────────────────────────────────────────

describe('computeMonthlyBudgetForecast — sparse data', () => {
  const base: MonthlyBudgetInput = {
    budgetUsd: 200,
    spentUsd: 0,
    resetsAt: new Date('2026-09-01T00:00:00Z'),
    recentWorkerCosts: [],
    now: new Date('2026-08-21T00:00:00Z'),
  };

  it('returns null burn rate and null depletion when no workers ran in window', () => {
    // Simulates workspace with no usage rows (e.g. brand-new workspace, or
    // workers whose model had no price entry and therefore costUsd=0 → filtered out)
    const result = computeMonthlyBudgetForecast({ ...base, recentWorkerCosts: [] });
    expect(result.burnRateUsdPerDay).toBeNull();
    expect(result.daysToDepletion).toBeNull();
    expect(result.confidence).toBe('low');
    expect(result.pctUsed).toBe(0);
  });

  it('returns finite pctUsed even when spentUsd is 0 and budgetUsd is set', () => {
    const result = computeMonthlyBudgetForecast({ ...base, spentUsd: 0 });
    expect(Number.isFinite(result.pctUsed)).toBe(true);
    expect(result.pctUsed).toBe(0);
  });

  it('does not produce NaN or Infinity values for any field', () => {
    const result = computeMonthlyBudgetForecast({ ...base, spentUsd: 0, recentWorkerCosts: [] });
    expect(Number.isNaN(result.pctUsed)).toBe(false);
    expect(result.burnRateUsdPerDay).toBeNull();
    expect(result.daysToDepletion).toBeNull();
  });
});

describe('computeMissionBudgetForecast — sparse data', () => {
  it('returns empty array for empty input', () => {
    expect(computeMissionBudgetForecast([])).toEqual([]);
  });
});

// ── oauthEpisodeConfidence ────────────────────────────────────────────────────

describe('oauthEpisodeConfidence', () => {
  it('returns low for 3-4 episodes', () => {
    expect(oauthEpisodeConfidence('low')).toBe('low');
  });

  it('returns high for 5+ episodes (good)', () => {
    expect(oauthEpisodeConfidence('good')).toBe('high');
  });

  it('returns null for none (learning state)', () => {
    expect(oauthEpisodeConfidence('none')).toBeNull();
  });
});
